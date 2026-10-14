//! Mesh import and export (IMP-0, IMP-1, IMP-2, PRJ-9, EXP-2). Runs on the device like the rest
//! of the engine. An import goes: parse (`obj.rs`, `stl.rs`) -> raw polygons -> cleanup
//! (`cleanup.rs`: weld, drop, split, orient) -> in-order fan polygon runs (`TriMesh`) ->
//! `EditMesh::from_trimesh`. The result always passes `check`: edge-manifold, consistently
//! oriented, polygon runs are fans; holes are allowed.
//!
//! Axes: the engine is +Y up, like OBJ. STL has no axis convention but is Z-up in practice (3D
//! printing, Blender's STL exporter), so STL is turned Z-up -> Y-up on import and back on export.
//! A 90-degree turn only swaps and negates components, so it round-trips bit for bit.
//!
//! Units (PRJ-9): coordinates are kept exactly as the file has them; the project records what one
//! unit means (mm, cm or m). Import guesses it from the bounding box and the app asks; STL export
//! scales to millimetres with it.

pub mod abi;
pub mod cleanup;
pub mod obj;
pub mod stl;
#[cfg(test)]
mod testjson;

use crate::sphere::TriMesh;
use std::hash::{BuildHasherDefault, Hasher};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Obj = 1,
    StlBinary = 2,
    StlAscii = 3,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Units {
    Mm = 0,
    Cm = 1,
    M = 2,
}

impl Units {
    pub fn to_mm(self) -> f32 {
        match self {
            Units::Mm => 1.0,
            Units::Cm => 10.0,
            Units::M => 1000.0,
        }
    }
}

/// PRJ-9: what one file unit most likely means, from the largest bounding-box side.
/// STL is a 3D-printing format: millimetres, unless the part would be under 5 mm, which is far
/// more likely a model written in metres (Blender's STL exporter writes raw metres). OBJ scenes
/// from Blender, ZBrush and Nomad are ~1-2 units across (metres); Maya and Cinema 4D export
/// centimetres; CAD exports millimetres. It's a guess: the app always asks, guess preselected.
pub fn guess_units(max_side: f32, format: Format) -> Units {
    match format {
        Format::StlBinary | Format::StlAscii => {
            if max_side >= 5.0 {
                Units::Mm
            } else {
                Units::M
            }
        }
        Format::Obj => {
            if max_side < 10.0 {
                Units::M
            } else if max_side < 1000.0 {
                Units::Cm
            } else {
                Units::Mm
            }
        }
    }
}

/// Parsed polygons before cleanup: index lists into `positions`.
#[derive(Default, Debug)]
pub struct RawMesh {
    pub positions: Vec<f32>,
    /// r g b per vertex when the file had vertex colors (OBJ `v x y z r g b`), else empty.
    /// There is no color attribute in the engine yet (PNT-1): they are counted, not kept.
    pub colors: Vec<f32>,
    /// Face k is `face_verts[face_off[k]..face_off[k + 1]]`; `face_off` starts with 0.
    pub face_off: Vec<u32>,
    pub face_verts: Vec<u32>,
}

impl RawMesh {
    pub fn nverts(&self) -> usize {
        self.positions.len() / 3
    }
    pub fn nfaces(&self) -> usize {
        self.face_off.len().saturating_sub(1)
    }
    pub fn face(&self, f: usize) -> &[u32] {
        &self.face_verts[self.face_off[f] as usize..self.face_off[f + 1] as usize]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportError {
    UnknownFormat = 1,
    NoFaces = 2,
    BadNumber = 3,
    BadIndex = 4,
    Truncated = 5,
    TooLarge = 6,
    /// Cleanup produced a mesh that fails `check` (a bug, never expected): refused, not loaded.
    Internal = 7,
}

/// Import counts (IMP-0). Every count is exact, so tests compare them with `==`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ImportReport {
    pub format: u32,
    /// Vertex records in the file: OBJ `v` lines; STL three per facet.
    pub in_verts: u32,
    /// Faces in the file: OBJ `f` lines; STL facets.
    pub in_faces: u32,
    /// Vertex records merged into another by the tolerance weld (STL only).
    pub welded_verts: u32,
    pub dropped_duplicate: u32,
    pub dropped_degenerate: u32,
    /// Faces whose winding was reversed to orient their component consistently.
    pub flipped_faces: u32,
    /// Vertex copies created to make non-manifold edges and vertices manifold.
    pub split_non_manifold: u32,
    pub components: u32,
    pub boundary_edges: u32,
    /// Vertices no kept face uses (dropped).
    pub loose_verts: u32,
    pub verts: u32,
    pub faces: u32,
    pub tris: u32,
    pub colored_verts: u32,
    /// `o`/`g` names seen; P1b merges all groups into one object (groups -> objects in P2).
    pub groups: u32,
    /// Lines, points, curves and surfaces: not meshes, skipped.
    pub ignored_elements: u32,
    pub units_guess: u32,
    pub bbox: [f32; 6],
}

/// Words written by `ImportReport::to_words` (the ABI layout read by the engine worker).
pub const REPORT_WORDS: usize = 26;

impl ImportReport {
    /// [status, format, error line, in_verts, in_faces, welded, duplicate, degenerate, flipped,
    ///  split, components, boundary, loose, verts, faces, tris, colored, groups, ignored,
    ///  units guess, bbox min xyz, bbox max xyz (f32 bits)]. Status 0 = imported.
    pub fn to_words(&self) -> [u32; REPORT_WORDS] {
        let mut w = [0u32; REPORT_WORDS];
        let head = [
            0,
            self.format,
            0,
            self.in_verts,
            self.in_faces,
            self.welded_verts,
            self.dropped_duplicate,
            self.dropped_degenerate,
            self.flipped_faces,
            self.split_non_manifold,
            self.components,
            self.boundary_edges,
            self.loose_verts,
            self.verts,
            self.faces,
            self.tris,
            self.colored_verts,
            self.groups,
            self.ignored_elements,
            self.units_guess,
        ];
        w[..head.len()].copy_from_slice(&head);
        for k in 0..6 {
            w[head.len() + k] = self.bbox[k].to_bits();
        }
        w
    }

    pub fn error_words(err: ImportError, line: u32) -> [u32; REPORT_WORDS] {
        let mut w = [0u32; REPORT_WORDS];
        w[0] = err as u32;
        w[2] = line;
        w
    }
}

/// An import failure with the 1-based line it happened on (0 when not line-based).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Failure {
    pub error: ImportError,
    pub line: u32,
}

impl From<ImportError> for Failure {
    fn from(error: ImportError) -> Failure {
        Failure { error, line: 0 }
    }
}

pub const HINT_DETECT: u32 = 0;
pub const HINT_OBJ: u32 = 1;
pub const HINT_STL: u32 = 2;

/// Which parser a file needs. The extension is checked in JS (IMP-1); this confirms it from the
/// bytes, so a binary STL whose 80-byte header happens to start with "solid" still reads right.
pub fn detect(bytes: &[u8], hint: u32) -> Result<Format, ImportError> {
    let stl = || {
        if stl::binary_count(bytes).is_some() {
            Ok(Format::StlBinary)
        } else if stl::looks_ascii(bytes) {
            Ok(Format::StlAscii)
        } else if bytes.len() >= 84 {
            Err(ImportError::Truncated) // binary, but shorter than its facet count says
        } else {
            Err(ImportError::UnknownFormat)
        }
    };
    match hint {
        HINT_OBJ => Ok(Format::Obj),
        HINT_STL => stl(),
        _ => stl().or(Ok(Format::Obj)),
    }
}

/// Parses, cleans and triangulates a file. Returns fan polygon runs ready for
/// `EditMesh::from_trimesh` and the exact counts of everything that happened on the way.
pub fn import(bytes: &[u8], hint: u32) -> Result<(TriMesh, ImportReport), Failure> {
    let format = detect(bytes, hint)?;
    let mut report = ImportReport { format: format as u32, ..Default::default() };
    let raw = match format {
        Format::Obj => {
            let (raw, st) = obj::parse(bytes)?;
            report.in_verts = raw.nverts() as u32;
            report.in_faces = raw.nfaces() as u32;
            report.colored_verts = st.colored_verts;
            report.groups = st.groups;
            report.ignored_elements = st.ignored_elements;
            raw
        }
        Format::StlBinary | Format::StlAscii => {
            let soup = if format == Format::StlBinary { stl::parse_binary(bytes)? } else { stl::parse_ascii(bytes)? };
            report.in_verts = soup.ncorners() as u32;
            report.in_faces = soup.nfaces() as u32;
            let mut raw = stl::weld(&soup, stl::WELD_REL_EPS);
            report.welded_verts = (soup.ncorners() - raw.nverts()) as u32;
            stl::z_up_to_y_up(&mut raw.positions);
            raw
        }
    };
    if raw.nfaces() == 0 {
        return Err(ImportError::NoFaces.into());
    }
    let (tm, c) = cleanup::clean(raw);
    report.dropped_duplicate = c.dropped_duplicate;
    report.dropped_degenerate = c.dropped_degenerate;
    report.flipped_faces = c.flipped_faces;
    report.split_non_manifold = c.split_non_manifold;
    report.loose_verts = c.loose_verts;
    if tm.ntris() == 0 {
        return Err(ImportError::NoFaces.into());
    }
    let chk = check(tm.nverts(), &tm.tris, &tm.poly_next);
    if !chk.valid() {
        return Err(ImportError::Internal.into());
    }
    report.components = chk.components;
    report.boundary_edges = chk.boundary_edges;
    report.verts = tm.nverts() as u32;
    report.tris = tm.ntris() as u32;
    report.faces = tm.poly_next.iter().filter(|&&p| p == 0).count() as u32;
    report.bbox = bbox(&tm.positions);
    let side = (0..3).map(|k| report.bbox[3 + k] - report.bbox[k]).fold(0.0f32, f32::max);
    report.units_guess = guess_units(side, format) as u32;
    Ok((tm, report))
}

pub fn bbox(positions: &[f32]) -> [f32; 6] {
    let mut b = [f32::INFINITY, f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY];
    for p in positions.chunks_exact(3) {
        for k in 0..3 {
            b[k] = b[k].min(p[k]);
            b[3 + k] = b[3 + k].max(p[k]);
        }
    }
    if positions.is_empty() { [0.0; 6] } else { b }
}

/// The mesh validator: what every import (and every later topology operation) must satisfy.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MeshCheck {
    pub edges: u32,
    pub boundary_edges: u32,
    /// Edges used by more than two triangles.
    pub nonmanifold_edges: u32,
    /// Edges whose two triangles traverse them in the same direction (inconsistent winding).
    pub inconsistent_edges: u32,
    /// Triangles that repeat a vertex.
    pub degenerate_tris: u32,
    /// Polygon runs that aren't in-order fans (triangle k+1 = (v0, v_k's v2, ...)).
    pub bad_runs: u32,
    pub out_of_range: u32,
    /// Triangle-connected components through two-triangle edges.
    pub components: u32,
}

impl MeshCheck {
    /// Edge-manifold, consistently oriented, fans; holes allowed.
    pub fn valid(&self) -> bool {
        self.nonmanifold_edges == 0 && self.inconsistent_edges == 0 && self.degenerate_tris == 0 && self.bad_runs == 0 && self.out_of_range == 0
    }
}

/// Checks a triangle list without extra per-edge memory: every edge is examined from the
/// triangles around its first vertex (vertex -> triangle lists in CSR form).
pub fn check(nverts: usize, tris: &[u32], poly_next: &[u8]) -> MeshCheck {
    let mut c = MeshCheck::default();
    let ntri = tris.len() / 3;
    if tris.iter().any(|&v| v as usize >= nverts) {
        c.out_of_range = tris.iter().filter(|&&v| v as usize >= nverts).count() as u32;
        return c;
    }
    let mut off = vec![0u32; nverts + 1];
    for &v in tris {
        off[v as usize + 1] += 1;
    }
    for i in 0..nverts {
        off[i + 1] += off[i];
    }
    let mut fill = off.clone();
    let mut vt = vec![0u32; tris.len()];
    for (t, tri) in tris.chunks_exact(3).enumerate() {
        for &v in tri {
            vt[fill[v as usize] as usize] = t as u32;
            fill[v as usize] += 1;
        }
    }
    drop(fill);
    let mut uf = UnionFind::new(ntri);
    let has = |t: usize, a: u32, b: u32| (0..3).any(|k| tris[3 * t + k] == a && tris[3 * t + (k + 1) % 3] == b);
    for t in 0..ntri {
        let tri = &tris[3 * t..3 * t + 3];
        if tri[0] == tri[1] || tri[1] == tri[2] || tri[0] == tri[2] {
            c.degenerate_tris += 1;
            continue;
        }
        for k in 0..3 {
            let (a, b) = (tri[k], tri[(k + 1) % 3]);
            // Every use of edge {a, b} is a triangle around a. `same` includes t itself.
            let (mut same, mut opp, mut first, mut other) = (0u32, 0u32, u32::MAX, u32::MAX);
            for &t2 in &vt[off[a as usize] as usize..off[a as usize + 1] as usize] {
                let (s, o) = (has(t2 as usize, a, b), has(t2 as usize, b, a));
                if s || o {
                    same += s as u32;
                    opp += o as u32;
                    first = first.min(t2);
                    if t2 as usize != t {
                        other = t2;
                    }
                }
            }
            if first as usize != t {
                continue; // each undirected edge is counted once, from its lowest triangle
            }
            c.edges += 1;
            match same + opp {
                1 => c.boundary_edges += 1,
                2 => {
                    if opp == 0 {
                        c.inconsistent_edges += 1;
                    }
                    uf.union(t, other as usize);
                }
                _ => c.nonmanifold_edges += 1,
            }
        }
    }
    c.components = (0..ntri).filter(|&t| uf.find(t) == t && !is_degenerate(&tris[3 * t..3 * t + 3])).count() as u32;
    // Polygon runs must be in-order fans.
    let mut t = 0;
    while t < ntri {
        let s = t;
        while t + 1 < ntri && poly_next.get(t).copied().unwrap_or(0) == 1 {
            let (v0, prev_c) = (tris[3 * s], tris[3 * t + 2]);
            if tris[3 * (t + 1)] != v0 || tris[3 * (t + 1) + 1] != prev_c {
                c.bad_runs += 1;
            }
            t += 1;
        }
        t += 1;
    }
    c
}

fn is_degenerate(t: &[u32]) -> bool {
    t[0] == t[1] || t[1] == t[2] || t[0] == t[2]
}

/// Disjoint sets with path halving.
pub struct UnionFind {
    parent: Vec<u32>,
}

impl UnionFind {
    pub fn new(n: usize) -> UnionFind {
        UnionFind { parent: (0..n as u32).collect() }
    }
    pub fn find(&mut self, mut x: usize) -> usize {
        while self.parent[x] as usize != x {
            let p = self.parent[x] as usize;
            self.parent[x] = self.parent[p];
            x = p;
        }
        x
    }
    pub fn union(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            // Lower index wins: roots (and so first-seen order) stay deterministic.
            let (lo, hi) = if ra < rb { (ra, rb) } else { (rb, ra) };
            self.parent[hi] = lo as u32;
        }
    }
}

/// FxHash (rustc's hasher): much faster than SipHash for the integer keys of welds and edges.
#[derive(Default)]
pub struct FxHasher(u64);

impl Hasher for FxHasher {
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.write_u64(b as u64);
        }
    }
    #[inline]
    fn write_u32(&mut self, x: u32) {
        self.write_u64(x as u64);
    }
    #[inline]
    fn write_i64(&mut self, x: i64) {
        self.write_u64(x as u64);
    }
    #[inline]
    fn write_u64(&mut self, x: u64) {
        self.0 = (self.0.rotate_left(5) ^ x).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
    fn finish(&self) -> u64 {
        self.0
    }
}

pub type FxBuild = BuildHasherDefault<FxHasher>;
pub type FxMap<K, V> = std::collections::HashMap<K, V, FxBuild>;
pub type FxSet<K> = std::collections::HashSet<K, FxBuild>;

#[cfg(test)]
mod tests;
