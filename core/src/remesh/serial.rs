//! Chunked writer for the project topology file: byte-for-byte what `store::topo_bytes`
//! writes (pinned by `top1_topo_writer_matches_store`), in bounded steps, because a 1M-triangle
//! topology is ~14 MB and ~37 ms natively in one piece. Used for the undo snapshot of the mesh a
//! remesh replaces and for the new mesh's `replace-mesh` save.

use crate::mesh::EditMesh;
use crate::store::{TOPO_MAGIC, TOPO_VERSION};

const fn crc_table() -> [u32; 256] {
    let mut t = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        t[n] = c;
        n += 1;
    }
    t
}
const CRC: [u32; 256] = crc_table();

/// CRC-32 continued over `bytes` from running state `c` (start 0xffffffff, finish with !c).
fn crc_update(mut c: u32, bytes: &[u8]) -> u32 {
    for &b in bytes {
        c = CRC[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8);
    }
    c
}

pub fn topo_len(m: &EditMesh) -> usize {
    let ntri = m.ntris();
    let nl = m.bvh.nleaves();
    28 + 12 * ntri + ntri.div_ceil(4) * 4 + 4 * (2 * m.bvh.node_a.len() + nl + 2 * (nl + 1)) + 4
}

pub struct TopoWriter {
    pub out: Vec<u8>,
    part: u8,
    cur: usize,
    crc: u32,
    crc_at: usize,
}

impl TopoWriter {
    pub fn new(m: &EditMesh) -> TopoWriter {
        TopoWriter { out: Vec::with_capacity(topo_len(m)), part: 0, cur: 0, crc: 0xffff_ffff, crc_at: 0 }
    }

    pub fn done(&self) -> bool {
        self.part == 9
    }

    fn u32s(&mut self, xs: &[u32], left: &mut i64) -> bool {
        let end = (self.cur + (*left as usize).max(1)).min(xs.len());
        for &x in &xs[self.cur..end] {
            self.out.extend_from_slice(&x.to_le_bytes());
        }
        *left -= (end - self.cur) as i64;
        self.cur = end;
        end >= xs.len()
    }

    /// Writes until `left` work units are spent; true when the file is complete.
    pub fn step(&mut self, m: &EditMesh, left: &mut i64) -> bool {
        while *left > 0 && self.part < 9 {
            let finished = match self.part {
                0 => {
                    let head = [TOPO_MAGIC, TOPO_VERSION, m.nverts() as u32, m.nowned as u32, m.ntris() as u32, m.bvh.node_a.len() as u32, m.bvh.nleaves() as u32];
                    for x in head {
                        self.out.extend_from_slice(&x.to_le_bytes());
                    }
                    true
                }
                1 => self.u32s(&m.tris, left),
                2 => {
                    self.out.extend_from_slice(&m.poly_next);
                    while self.out.len() % 4 != 0 {
                        self.out.push(0);
                    }
                    *left -= (m.poly_next.len() / 4) as i64;
                    true
                }
                3 => self.u32s(&m.bvh.node_a, left),
                4 => self.u32s(&m.bvh.node_b, left),
                5 => self.u32s(&m.bvh.leaf_node, left),
                6 => self.u32s(&m.bvh.leaf_tri_off, left),
                7 => self.u32s(&m.bvh.own_off, left),
                _ => {
                    let crc = crc_update(self.crc, &self.out[self.crc_at..]) ^ 0xffff_ffff;
                    self.crc_at = self.out.len();
                    self.out.extend_from_slice(&crc.to_le_bytes());
                    true
                }
            };
            if self.part < 8 {
                self.crc = crc_update(self.crc, &self.out[self.crc_at..]);
                self.crc_at = self.out.len();
            }
            if finished {
                self.part += 1;
                self.cur = 0;
            }
        }
        self.part == 9
    }
}

/// Whole file in one go (tests and small meshes).
pub fn topo_bytes(m: &EditMesh) -> Vec<u8> {
    let mut w = TopoWriter::new(m);
    while !w.step(m, &mut (1i64 << 40)) {}
    w.out
}
