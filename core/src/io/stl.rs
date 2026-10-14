//! STL import (IMP-2) and export (EXP-2).
//!
//! Import: binary or ASCII. An STL is a triangle soup (every facet carries its own corners), so
//! the corners are welded into shared vertices: first exact duplicates (bit-equal positions, the
//! common case), then a tolerance pass that merges positions within `WELD_REL_EPS` of the
//! bounding-box diagonal of each other (writers that recompute corners per facet). The weld is
//! deterministic: each position joins the first earlier vertex within tolerance.
//!
//! Export: binary, millimetres (the engine's units times the project's mm factor), Z-up.

use super::obj::parse_f32;
use super::{bbox, check, Failure, FxMap, ImportError, RawMesh};
use crate::math::{cross, get3, normalize, sub};
use crate::mesh::EditMesh;

/// Weld tolerance as a fraction of the bounding-box diagonal: 1.7 µm on a 100 mm part, far below
/// any modelled feature and above the rounding of 6-digit ASCII writers.
pub const WELD_REL_EPS: f32 = 1e-5;

/// Facets with their own corners: what an STL file holds.
#[derive(Default, Debug)]
pub struct Soup {
    /// xyz per corner.
    pub corners: Vec<f32>,
    /// Facet k uses corners `face_off[k]..face_off[k + 1]` (three, except odd ASCII writers).
    pub face_off: Vec<u32>,
}

impl Soup {
    pub fn ncorners(&self) -> usize {
        self.corners.len() / 3
    }
    pub fn nfaces(&self) -> usize {
        self.face_off.len().saturating_sub(1)
    }
}

/// Facet count of a binary STL: the size must be 84 + 50 n (a few writers append bytes, accepted
/// unless the file reads as ASCII). A binary header may start with "solid": size decides.
pub fn binary_count(bytes: &[u8]) -> Option<usize> {
    if bytes.len() < 84 {
        return None;
    }
    let n = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as u64;
    let need = 84 + 50 * n;
    let len = bytes.len() as u64;
    if need == len || (n > 0 && need < len && !looks_ascii(bytes)) { Some(n as usize) } else { None }
}

/// "solid" first, and a facet keyword near the start.
pub fn looks_ascii(bytes: &[u8]) -> bool {
    let start = bytes.iter().position(|&b| !b.is_ascii_whitespace()).unwrap_or(bytes.len());
    let head = &bytes[start..bytes.len().min(start + 4096)];
    head.len() >= 5
        && head[..5].eq_ignore_ascii_case(b"solid")
        && (head.windows(5).any(|w| w.eq_ignore_ascii_case(b"facet")) || head.windows(8).any(|w| w.eq_ignore_ascii_case(b"endsolid")))
}

pub fn parse_binary(bytes: &[u8]) -> Result<Soup, Failure> {
    let n = binary_count(bytes).ok_or(ImportError::Truncated)?;
    if n > (u32::MAX / 4) as usize {
        return Err(ImportError::TooLarge.into());
    }
    let mut s = Soup { corners: Vec::with_capacity(9 * n), face_off: Vec::with_capacity(n + 1) };
    s.face_off.push(0);
    let f = |at: usize| f32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
    for t in 0..n {
        let base = 84 + 50 * t + 12; // skip the stored normal: it's recomputed from the corners
        for k in 0..9 {
            let x = f(base + 4 * k);
            if !x.is_finite() {
                return Err(Failure { error: ImportError::BadNumber, line: t as u32 + 1 });
            }
            s.corners.push(x);
        }
        s.face_off.push(3 * (t as u32 + 1));
    }
    Ok(s)
}

/// Streaming ASCII STL reader, line by line (`facet` / `vertex x y z` / `endfacet`).
pub struct AsciiParser {
    soup: Soup,
    carry: Vec<u8>,
    line: u32,
    open: bool,
}

impl Default for AsciiParser {
    fn default() -> Self {
        Self::new()
    }
}

impl AsciiParser {
    pub fn new() -> AsciiParser {
        AsciiParser { soup: Soup { corners: Vec::new(), face_off: vec![0] }, carry: Vec::new(), line: 0, open: false }
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Result<(), Failure> {
        let mut rest = chunk;
        while let Some(nl) = rest.iter().position(|&b| b == b'\n') {
            let seg = &rest[..nl];
            rest = &rest[nl + 1..];
            self.line += 1;
            if self.carry.is_empty() {
                self.line_done(seg)?;
            } else {
                self.carry.extend_from_slice(seg);
                let mut l = std::mem::take(&mut self.carry);
                let r = self.line_done(&l);
                l.clear();
                self.carry = l;
                r?;
            }
        }
        self.carry.extend_from_slice(rest);
        Ok(())
    }

    pub fn finish(mut self) -> Result<Soup, Failure> {
        if !self.carry.is_empty() {
            self.line += 1;
            let l = std::mem::take(&mut self.carry);
            self.line_done(&l)?;
        }
        self.close_facet();
        Ok(self.soup)
    }

    fn close_facet(&mut self) {
        let end = self.soup.ncorners() as u32;
        if self.open && *self.soup.face_off.last().unwrap() != end {
            self.soup.face_off.push(end);
        }
        self.open = false;
    }

    fn line_done(&mut self, l: &[u8]) -> Result<(), Failure> {
        let mut tok = l.split(|b| b.is_ascii_whitespace()).filter(|t| !t.is_empty());
        let Some(kw) = tok.next() else { return Ok(()) };
        if kw.eq_ignore_ascii_case(b"vertex") {
            if !self.open {
                self.open = true; // tolerate a missing "facet" line
            }
            for _ in 0..3 {
                match tok.next().and_then(parse_f32) {
                    Some(x) => self.soup.corners.push(x),
                    None => return Err(Failure { error: ImportError::BadNumber, line: self.line }),
                }
            }
            if self.soup.corners.len() / 3 >= (u32::MAX / 4) as usize {
                return Err(Failure { error: ImportError::TooLarge, line: self.line });
            }
        } else if kw.eq_ignore_ascii_case(b"facet") {
            self.close_facet();
            self.open = true;
        } else if kw.eq_ignore_ascii_case(b"endfacet") || kw.eq_ignore_ascii_case(b"endsolid") {
            self.close_facet();
        }
        Ok(())
    }
}

pub fn parse_ascii(bytes: &[u8]) -> Result<Soup, Failure> {
    let mut p = AsciiParser::new();
    p.feed(bytes)?;
    p.finish()
}

/// Merges facet corners into shared vertices (see the module comment). Returns the welded mesh;
/// welded count = corners - vertices.
pub fn weld(soup: &Soup, rel_eps: f32) -> RawMesh {
    let n = soup.ncorners();
    let b = bbox(&soup.corners);
    let diag = (0..3).map(|k| ((b[3 + k] - b[k]) as f64).powi(2)).sum::<f64>().sqrt();
    let eps = rel_eps as f64 * diag;

    // 1. Exact duplicates (-0.0 counts as 0.0).
    let mut exact: FxMap<[u32; 3], u32> = FxMap::default();
    exact.reserve(n / 4);
    let mut uniq: Vec<f32> = Vec::with_capacity(n);
    let mut corner_u: Vec<u32> = Vec::with_capacity(n);
    for c in soup.corners.chunks_exact(3) {
        let p = [c[0] + 0.0, c[1] + 0.0, c[2] + 0.0];
        let key = [p[0].to_bits(), p[1].to_bits(), p[2].to_bits()];
        let next = (uniq.len() / 3) as u32;
        let id = *exact.entry(key).or_insert(next);
        if id == next {
            uniq.extend_from_slice(&p);
        }
        corner_u.push(id);
    }
    drop(exact);

    // 2. Tolerance: cells of size eps, a position joins the first vertex within eps in the 27
    // surrounding cells.
    let nu = uniq.len() / 3;
    let (positions, rep) = if eps > 0.0 {
        let mut cells: FxMap<[i64; 3], u32> = FxMap::default();
        cells.reserve(nu);
        let mut chain: Vec<u32> = Vec::with_capacity(nu);
        let mut out: Vec<f32> = Vec::with_capacity(uniq.len());
        let mut rep = vec![0u32; nu];
        for u in 0..nu {
            let p = [uniq[3 * u] as f64, uniq[3 * u + 1] as f64, uniq[3 * u + 2] as f64];
            let cell = [0, 1, 2].map(|k| ((p[k] - b[k] as f64) / eps).floor() as i64);
            let mut found = u32::MAX;
            'search: for dx in -1..=1 {
                for dy in -1..=1 {
                    for dz in -1..=1 {
                        let mut q = cells.get(&[cell[0] + dx, cell[1] + dy, cell[2] + dz]).copied().unwrap_or(u32::MAX);
                        while q != u32::MAX {
                            let i = 3 * q as usize;
                            let d2 = (0..3).map(|k| (out[i + k] as f64 - p[k]).powi(2)).sum::<f64>();
                            if d2 <= eps * eps && q < found {
                                found = q;
                            }
                            q = chain[q as usize];
                        }
                        if found == 0 {
                            break 'search;
                        }
                    }
                }
            }
            if found != u32::MAX {
                rep[u] = found;
            } else {
                let id = (out.len() / 3) as u32;
                out.extend_from_slice(&uniq[3 * u..3 * u + 3]);
                let head = cells.entry(cell).or_insert(u32::MAX);
                chain.push(*head);
                *head = id;
                rep[u] = id;
            }
        }
        (out, rep)
    } else {
        (uniq, (0..nu as u32).collect())
    };
    RawMesh {
        positions,
        colors: Vec::new(),
        face_off: soup.face_off.clone(),
        face_verts: corner_u.iter().map(|&u| rep[u as usize]).collect(),
    }
}

/// STL (Z up) -> engine (Y up): (x, y, z) -> (x, z, -y). Exact.
pub fn z_up_to_y_up(positions: &mut [f32]) {
    for p in positions.chunks_exact_mut(3) {
        let (y, z) = (p[1], p[2]);
        p[1] = z;
        p[2] = -y;
    }
}

/// Engine (Y up) -> STL (Z up): (x, y, z) -> (x, -z, y). Exact inverse of `z_up_to_y_up`.
pub fn y_up_to_z_up(p: [f32; 3]) -> [f32; 3] {
    [p[0], -p[2], p[1]]
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StlStats {
    pub triangles: u32,
    /// > 0: not watertight (EXP-2 warns before sharing).
    pub boundary_edges: u32,
    pub nonmanifold_edges: u32,
}

/// Binary STL in millimetres: positions times `scale` (the project's unit -> mm factor), Z up,
/// facet normals from the written corners.
pub fn write_binary(m: &EditMesh, scale: f32, out: &mut Vec<u8>) -> StlStats {
    let ntri = m.ntris();
    out.clear();
    out.reserve(84 + 50 * ntri);
    let mut header = [b' '; 80];
    let text = b"Maquette binary STL, millimetres, Z up";
    header[..text.len()].copy_from_slice(text);
    out.extend_from_slice(&header);
    out.extend_from_slice(&(ntri as u32).to_le_bytes());
    for t in 0..ntri {
        let c = [0, 1, 2].map(|k| {
            let p = y_up_to_z_up(get3(&m.positions, m.tris[3 * t + k] as usize));
            [p[0] * scale, p[1] * scale, p[2] * scale]
        });
        let n = normalize(cross(sub(c[1], c[0]), sub(c[2], c[0])));
        for x in n.iter().chain(c.iter().flatten()) {
            out.extend_from_slice(&x.to_le_bytes());
        }
        out.extend_from_slice(&[0, 0]);
    }
    let chk = check(m.nverts(), &m.tris, &m.poly_next);
    StlStats { triangles: ntri as u32, boundary_edges: chk.boundary_edges, nonmanifold_edges: chk.nonmanifold_edges }
}
