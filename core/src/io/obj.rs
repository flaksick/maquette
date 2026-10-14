//! OBJ import (IMP-1). Streaming: `ObjParser::feed` takes the file in chunks of any size (a line
//! may straddle two chunks) and never copies the text; only a line split across chunks (or
//! continued with a trailing `\`) is buffered. That keeps peak memory at the mesh arrays, and lets
//! a later sliced import (IMP-5) feed it slice by slice.
//!
//! Read: `v` (with optional `r g b` vertex colors), `f` in every form (`v`, `v/vt`, `v/vt/vn`,
//! `v//vn`) with negative (relative) indices and forward references. Triangles, quads and n-gons
//! stay polygons. Objects and groups (`o`, `g`) are counted and merged into one mesh (P1b; groups
//! become objects in P2). Texture coordinates, normals, materials and smoothing groups are skipped;
//! lines, points, curves and surfaces are counted as ignored elements. Vertex colors are parsed
//! and counted, but the engine has no color attribute yet (PNT-1), so they are not kept.

use super::{Failure, ImportError, RawMesh};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ObjStats {
    pub colored_verts: u32,
    pub groups: u32,
    pub ignored_elements: u32,
}

pub struct ObjParser {
    raw: RawMesh,
    stats: ObjStats,
    /// A line straddling two chunks, or one continued with a trailing backslash.
    carry: Vec<u8>,
    line: u32,
    /// Largest 1-based index referenced and its line: forward references are checked at the end.
    max_ref: u64,
    max_ref_line: u32,
    nums: Vec<f32>,
}

impl Default for ObjParser {
    fn default() -> Self {
        Self::new()
    }
}

fn is_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\r' | 0x0b | 0x0c)
}

fn trim_end(s: &[u8]) -> &[u8] {
    let n = s.iter().rposition(|&b| !is_space(b)).map_or(0, |i| i + 1);
    &s[..n]
}

fn continues(s: &[u8]) -> bool {
    trim_end(s).last() == Some(&b'\\')
}

/// Whitespace-separated tokens of one line.
struct Tokens<'a> {
    s: &'a [u8],
    at: usize,
}

impl<'a> Iterator for Tokens<'a> {
    type Item = &'a [u8];
    fn next(&mut self) -> Option<&'a [u8]> {
        while self.at < self.s.len() && is_space(self.s[self.at]) {
            self.at += 1;
        }
        if self.at >= self.s.len() {
            return None;
        }
        let start = self.at;
        while self.at < self.s.len() && !is_space(self.s[self.at]) {
            self.at += 1;
        }
        Some(&self.s[start..self.at])
    }
}

/// Correctly rounded decimal -> f32 (same result as Blender's fast_float); finite only.
pub(crate) fn parse_f32(tok: &[u8]) -> Option<f32> {
    std::str::from_utf8(tok).ok()?.parse::<f32>().ok().filter(|x| x.is_finite())
}

fn parse_i64(tok: &[u8]) -> Option<i64> {
    let (neg, digits) = match tok.first()? {
        b'-' => (true, &tok[1..]),
        b'+' => (false, &tok[1..]),
        _ => (false, tok),
    };
    if digits.is_empty() || digits.len() > 18 {
        return None;
    }
    let mut v: i64 = 0;
    for &d in digits {
        if !d.is_ascii_digit() {
            return None;
        }
        v = v * 10 + (d - b'0') as i64;
    }
    Some(if neg { -v } else { v })
}

impl ObjParser {
    pub fn new() -> ObjParser {
        ObjParser {
            raw: RawMesh { face_off: vec![0], ..Default::default() },
            stats: ObjStats::default(),
            carry: Vec::new(),
            line: 0,
            max_ref: 0,
            max_ref_line: 0,
            nums: Vec::with_capacity(8),
        }
    }

    fn fail(&self, error: ImportError) -> Failure {
        Failure { error, line: self.line }
    }

    /// Feeds the next chunk of the file. Chunks may split lines anywhere.
    pub fn feed(&mut self, chunk: &[u8]) -> Result<(), Failure> {
        let mut rest = chunk;
        while let Some(nl) = rest.iter().position(|&b| b == b'\n') {
            let seg = &rest[..nl];
            rest = &rest[nl + 1..];
            self.line += 1;
            if self.carry.is_empty() && !continues(seg) {
                self.line_done(seg)?; // the common case: no copy
                continue;
            }
            self.carry.extend_from_slice(seg);
            if continues(&self.carry) {
                let n = trim_end(&self.carry).len();
                self.carry.truncate(n - 1); // drop the backslash, join with the next line
                self.carry.push(b' ');
                continue;
            }
            let mut line = std::mem::take(&mut self.carry);
            let r = self.line_done(&line);
            line.clear();
            self.carry = line; // keep the allocation
            r?;
        }
        self.carry.extend_from_slice(rest);
        Ok(())
    }

    /// Ends the file: the last line (no trailing newline), then forward references.
    pub fn finish(mut self) -> Result<(RawMesh, ObjStats), Failure> {
        if !self.carry.is_empty() {
            self.line += 1;
            let mut line = std::mem::take(&mut self.carry);
            if continues(&line) {
                let n = trim_end(&line).len();
                line.truncate(n - 1);
            }
            self.line_done(&line)?;
        }
        if self.max_ref > self.raw.nverts() as u64 {
            return Err(Failure { error: ImportError::BadIndex, line: self.max_ref_line });
        }
        Ok((self.raw, self.stats))
    }

    fn line_done(&mut self, l: &[u8]) -> Result<(), Failure> {
        let mut tok = Tokens { s: l, at: 0 };
        let Some(kw) = tok.next() else { return Ok(()) };
        match kw {
            b"v" => self.vertex(tok),
            b"f" | b"fo" => self.face(tok),
            b"o" | b"g" => {
                self.stats.groups += 1;
                Ok(())
            }
            b"l" | b"p" | b"curv" | b"curv2" | b"surf" => {
                self.stats.ignored_elements += 1;
                Ok(())
            }
            // Comments, vt, vn, vp, s, usemtl, mtllib and the rest of the format: not geometry.
            _ => Ok(()),
        }
    }

    fn vertex(&mut self, tok: Tokens) -> Result<(), Failure> {
        self.nums.clear();
        for t in tok {
            if t[0] == b'#' || self.nums.len() == 7 {
                break;
            }
            match parse_f32(t) {
                Some(x) => self.nums.push(x),
                None => return Err(self.fail(ImportError::BadNumber)),
            }
        }
        if self.nums.len() < 3 {
            return Err(self.fail(ImportError::BadNumber));
        }
        let before = self.raw.nverts();
        if before as u64 >= u32::MAX as u64 / 4 {
            return Err(self.fail(ImportError::TooLarge));
        }
        self.raw.positions.extend_from_slice(&self.nums[..3]);
        if self.nums.len() >= 6 {
            // `v x y z r g b`: the first colored vertex makes every earlier one white.
            if self.raw.colors.is_empty() {
                self.raw.colors.resize(3 * before, 1.0);
            }
            self.raw.colors.extend_from_slice(&self.nums[3..6]);
            self.stats.colored_verts += 1;
        } else if !self.raw.colors.is_empty() {
            self.raw.colors.extend_from_slice(&[1.0, 1.0, 1.0]);
        }
        Ok(())
    }

    fn face(&mut self, tok: Tokens) -> Result<(), Failure> {
        let nv = self.raw.nverts() as i64;
        for t in tok {
            if t[0] == b'#' {
                break;
            }
            let end = t.iter().position(|&b| b == b'/').unwrap_or(t.len());
            let Some(i) = parse_i64(&t[..end]) else { return Err(self.fail(ImportError::BadIndex)) };
            // 1-based; negative counts back from the last vertex read so far.
            let v = match i {
                i if i > 0 => i - 1,
                i if i < 0 => nv + i,
                _ => return Err(self.fail(ImportError::BadIndex)),
            };
            if v < 0 || v >= u32::MAX as i64 {
                return Err(self.fail(ImportError::BadIndex));
            }
            if (v + 1) as u64 > self.max_ref {
                self.max_ref = (v + 1) as u64;
                self.max_ref_line = self.line;
            }
            self.raw.face_verts.push(v as u32);
        }
        if self.raw.face_verts.len() >= u32::MAX as usize / 2 {
            return Err(self.fail(ImportError::TooLarge));
        }
        self.raw.face_off.push(self.raw.face_verts.len() as u32);
        Ok(())
    }
}

/// Parses a whole file held in memory.
pub fn parse(bytes: &[u8]) -> Result<(RawMesh, ObjStats), Failure> {
    let mut p = ObjParser::new();
    p.feed(bytes)?;
    p.finish()
}
