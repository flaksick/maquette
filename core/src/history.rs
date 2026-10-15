//! Node transactions, undo/redo and journal records (ARCHITECTURE invariants 3 and 4).
//!
//! A stroke touches BVH leaves. The first touch copies the leaf's vertex range (before-state);
//! that copy is both the undo record and the stroke's original coordinates. At stroke end the
//! same ranges' after-state becomes the journal record. Undo and redo are journaled too, as the
//! state they restore. Records are idempotent (absolute positions), so recovery is
//! "load checkpoint, then apply every valid record in order".

use crate::mesh::EditMesh;

pub const RECORD_MAGIC: u32 = 0x324a_514d; // "MQJ2"
pub const HEADER_BYTES: usize = 24;
pub const KIND_STROKE: u32 = 1;
pub const KIND_UNDO: u32 = 2;
pub const KIND_REDO: u32 = 3;
/// Kind flag (TOP-3 dyntopo): each leaf also carries its whole triangle slab after its positions:
/// [first triangle, triangle count], the triangles (u32 x 3), the polygon-run bits padded to 4.
pub const KIND_TOPO: u32 = 0x100;

const CRC_TABLE: [u32; 256] = {
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
};

pub fn crc32(bytes: &[u8]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for &b in bytes {
        c = CRC_TABLE[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8);
    }
    c ^ 0xffff_ffff
}

/// Leaf ranges and their positions: the payload of undo entries and journal records.
#[derive(Clone, Default)]
pub struct LeafStates {
    pub leaves: Vec<u32>,
    /// Float offset of each leaf's data in `data` (len = leaves + 1).
    pub off: Vec<u32>,
    pub data: Vec<f32>,
    /// Dyntopo (TOP-3): each leaf's whole triangle slab (all slots, dead ones included) and its
    /// polygon-run bits, in leaf order. Empty = a position-only state.
    pub tris: Vec<u32>,
    pub pn: Vec<u8>,
}

impl LeafStates {
    pub fn bytes(&self) -> usize {
        self.data.len() * 4 + self.leaves.len() * 8 + self.tris.len() * 4 + self.pn.len()
    }

    pub fn is_topo(&self) -> bool {
        !self.tris.is_empty()
    }

    /// Positions and (dyntopo) triangle slabs of the given leaves.
    pub fn capture_topo(mesh: &EditMesh, leaves: &[u32]) -> LeafStates {
        let mut s = LeafStates::capture(mesh, leaves);
        for &leaf in leaves {
            let (t0, t1) = (mesh.bvh.leaf_tri_off[leaf as usize] as usize, mesh.bvh.leaf_tri_off[leaf as usize + 1] as usize);
            s.tris.extend_from_slice(&mesh.tris[3 * t0..3 * t1]);
            s.pn.extend_from_slice(&mesh.poly_next[t0..t1]);
        }
        s
    }

    pub fn capture(mesh: &EditMesh, leaves: &[u32]) -> LeafStates {
        let mut s = LeafStates { leaves: leaves.to_vec(), off: vec![0], ..Default::default() };
        for &leaf in leaves {
            let (a, b) = mesh.leaf_range(leaf as usize);
            s.data.extend_from_slice(&mesh.positions[3 * a..3 * b]);
            s.off.push(s.data.len() as u32);
        }
        s
    }

    pub fn restore(&self, mesh: &mut EditMesh) {
        for (i, &leaf) in self.leaves.iter().enumerate() {
            let (a, b) = mesh.leaf_range(leaf as usize);
            mesh.positions[3 * a..3 * b].copy_from_slice(&self.data[self.off[i] as usize..self.off[i + 1] as usize]);
        }
        if self.is_topo() {
            let mut at = 0;
            for &leaf in &self.leaves {
                let (t0, t1) = (mesh.bvh.leaf_tri_off[leaf as usize] as usize, mesh.bvh.leaf_tri_off[leaf as usize + 1] as usize);
                let n = t1 - t0;
                crate::dyntopo::write_leaf_tris(mesh, leaf as usize, &self.tris[3 * at..3 * (at + n)], &self.pn[at..at + n]);
                at += n;
            }
        }
    }
}

/// The per-stroke transaction: which leaves were touched and their before-state.
pub struct Transaction {
    stamp: Vec<u32>,
    /// Index of each touched leaf in `before` (valid where stamp == id).
    slot: Vec<u32>,
    id: u32,
    pub before: LeafStates,
    pub active: bool,
    /// Dyntopo stroke: first touches also copy the leaf's triangle slab.
    pub topo: bool,
}

impl Transaction {
    pub fn new(nleaves: usize) -> Transaction {
        Transaction { stamp: vec![0; nleaves], slot: vec![0; nleaves], id: 1, before: LeafStates::default(), active: false, topo: false }
    }

    pub fn begin(&mut self) {
        self.id = self.id.wrapping_add(1).max(1);
        self.before = LeafStates { leaves: Vec::new(), off: vec![0], ..Default::default() };
        self.active = true;
    }

    /// First touch of a leaf in this transaction copies its before-state.
    #[inline]
    pub fn touch(&mut self, mesh: &EditMesh, leaf: u32) {
        if self.stamp[leaf as usize] == self.id {
            return;
        }
        self.stamp[leaf as usize] = self.id;
        self.slot[leaf as usize] = self.before.leaves.len() as u32;
        let (a, b) = mesh.leaf_range(leaf as usize);
        self.before.leaves.push(leaf);
        self.before.data.extend_from_slice(&mesh.positions[3 * a..3 * b]);
        self.before.off.push(self.before.data.len() as u32);
        if self.topo {
            let (t0, t1) = (mesh.bvh.leaf_tri_off[leaf as usize] as usize, mesh.bvh.leaf_tri_off[leaf as usize + 1] as usize);
            self.before.tris.extend_from_slice(&mesh.tris[3 * t0..3 * t1]);
            self.before.pn.extend_from_slice(&mesh.poly_next[t0..t1]);
        }
    }

    /// Whether this transaction already holds the leaf's before-state.
    #[inline]
    pub fn has(&self, leaf: u32) -> bool {
        self.stamp[leaf as usize] == self.id
    }

    pub fn touched(&self) -> &[u32] {
        &self.before.leaves
    }

    /// Stroke-start positions of a leaf's vertices if this transaction touched it: brushes that
    /// sample the stroke-start surface (Layer, accumulate off) read them here.
    #[inline]
    pub fn original_leaf(&self, leaf: u32) -> Option<&[f32]> {
        if !self.active || self.stamp[leaf as usize] != self.id {
            return None;
        }
        let i = self.slot[leaf as usize] as usize;
        Some(&self.before.data[self.before.off[i] as usize..self.before.off[i + 1] as usize])
    }
}

pub struct UndoEntry {
    pub before: LeafStates,
    pub after: LeafStates,
}

impl UndoEntry {
    fn bytes(&self) -> usize {
        self.before.bytes() + self.after.bytes()
    }
}

/// RAM-budgeted undo/redo stacks (UND-1 P1a). Oldest entries drop when over budget.
pub struct History {
    pub undo: Vec<UndoEntry>,
    pub redo: Vec<UndoEntry>,
    pub budget_bytes: usize,
    pub max_steps: usize,
    bytes: usize,
    pub dropped: u32,
}

impl History {
    pub fn new(budget_bytes: usize, max_steps: usize) -> History {
        History { undo: Vec::new(), redo: Vec::new(), budget_bytes, max_steps, bytes: 0, dropped: 0 }
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn push(&mut self, e: UndoEntry) {
        for r in self.redo.drain(..) {
            self.bytes -= r.bytes();
        }
        self.bytes += e.bytes();
        self.undo.push(e);
        while (self.bytes > self.budget_bytes || self.undo.len() > self.max_steps) && self.undo.len() > 1 {
            let old = self.undo.remove(0);
            self.bytes -= old.bytes();
            self.dropped += 1;
        }
    }

    /// Restores the before-state; returns the restored states for journaling.
    pub fn undo(&mut self, mesh: &mut EditMesh) -> Option<&LeafStates> {
        let e = self.undo.pop()?;
        e.before.restore(mesh);
        self.redo.push(e);
        self.redo.last().map(|e| &e.before)
    }

    pub fn redo(&mut self, mesh: &mut EditMesh) -> Option<&LeafStates> {
        let e = self.redo.pop()?;
        e.after.restore(mesh);
        self.undo.push(e);
        self.undo.last().map(|e| &e.after)
    }

    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
        self.bytes = 0;
    }
}

/// Encodes a journal record: 24-byte header (magic, seq, kind, nleaves, payload bytes, crc32 of
/// payload) then per leaf: leaf, first vertex, vertex count, positions (f32 xyz). Little-endian.
pub fn encode_record(out: &mut Vec<u8>, seq: u32, kind: u32, states: &LeafStates, mesh: &EditMesh) {
    out.clear();
    out.resize(HEADER_BYTES, 0);
    let topo = states.is_topo();
    let kind = if topo { kind | KIND_TOPO } else { kind };
    let mut tat = 0usize;
    for (i, &leaf) in states.leaves.iter().enumerate() {
        let (a, b) = mesh.leaf_range(leaf as usize);
        out.extend_from_slice(&leaf.to_le_bytes());
        out.extend_from_slice(&(a as u32).to_le_bytes());
        out.extend_from_slice(&((b - a) as u32).to_le_bytes());
        for &x in &states.data[states.off[i] as usize..states.off[i + 1] as usize] {
            out.extend_from_slice(&x.to_le_bytes());
        }
        if topo {
            let (t0, t1) = (mesh.bvh.leaf_tri_off[leaf as usize], mesh.bvh.leaf_tri_off[leaf as usize + 1]);
            let n = (t1 - t0) as usize;
            out.extend_from_slice(&t0.to_le_bytes());
            out.extend_from_slice(&(n as u32).to_le_bytes());
            for &v in &states.tris[3 * tat..3 * (tat + n)] {
                out.extend_from_slice(&v.to_le_bytes());
            }
            out.extend_from_slice(&states.pn[tat..tat + n]);
            while out.len() % 4 != 0 {
                out.push(0);
            }
            tat += n;
        }
    }
    let payload_len = (out.len() - HEADER_BYTES) as u32;
    let crc = crc32(&out[HEADER_BYTES..]);
    for (k, v) in [RECORD_MAGIC, seq, kind, states.leaves.len() as u32, payload_len, crc].iter().enumerate() {
        out[4 * k..4 * k + 4].copy_from_slice(&v.to_le_bytes());
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum RecordError {
    Truncated,
    BadMagic,
    BadCrc,
    BadLeaf,
}

fn rd(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

/// Validates and applies one record. Returns (seq, bytes consumed).
pub fn apply_record(mesh: &mut EditMesh, bytes: &[u8]) -> Result<(u32, usize), RecordError> {
    if bytes.len() < HEADER_BYTES {
        return Err(RecordError::Truncated);
    }
    if rd(bytes, 0) != RECORD_MAGIC {
        return Err(RecordError::BadMagic);
    }
    let seq = rd(bytes, 4);
    let topo = rd(bytes, 8) & KIND_TOPO != 0;
    let nleaves = rd(bytes, 12) as usize;
    let len = rd(bytes, 16) as usize;
    let crc = rd(bytes, 20);
    let end = HEADER_BYTES + len;
    if bytes.len() < end {
        return Err(RecordError::Truncated);
    }
    let payload = &bytes[HEADER_BYTES..end];
    if crc32(payload) != crc {
        return Err(RecordError::BadCrc);
    }
    // Validate every leaf before writing anything: a record applies whole or not at all.
    let mut at = 0;
    let mut spans = Vec::with_capacity(nleaves);
    for _ in 0..nleaves {
        if at + 12 > payload.len() {
            return Err(RecordError::Truncated);
        }
        let leaf = rd(payload, at) as usize;
        let start = rd(payload, at + 4) as usize;
        let count = rd(payload, at + 8) as usize;
        if leaf >= mesh.nleaves() || mesh.leaf_range(leaf) != (start, start + count) || at + 12 + count * 12 > payload.len() {
            return Err(RecordError::BadLeaf);
        }
        let data_at = at + 12;
        at += 12 + count * 12;
        let mut tri_at = usize::MAX;
        if topo {
            if at + 8 > payload.len() {
                return Err(RecordError::Truncated);
            }
            let (t0, n) = (rd(payload, at) as usize, rd(payload, at + 4) as usize);
            let span = (mesh.bvh.leaf_tri_off[leaf] as usize, mesh.bvh.leaf_tri_off[leaf + 1] as usize);
            let bytes = 8 + 12 * n + n.div_ceil(4) * 4;
            if span != (t0, t0 + n) || at + bytes > payload.len() {
                return Err(RecordError::BadLeaf);
            }
            // Every corner must name a vertex of this mesh.
            for i in 0..3 * n {
                if rd(payload, at + 8 + 4 * i) as usize >= mesh.nverts() {
                    return Err(RecordError::BadLeaf);
                }
            }
            tri_at = at + 8;
            at += bytes;
        }
        spans.push((leaf, start, count, data_at, tri_at));
    }
    for &(_, start, count, data_at, _) in &spans {
        for i in 0..count * 3 {
            let o = data_at + 4 * i;
            mesh.positions[3 * start + i] = f32::from_le_bytes([payload[o], payload[o + 1], payload[o + 2], payload[o + 3]]);
        }
    }
    if topo {
        for &(leaf, _, _, _, tri_at) in &spans {
            let n = (mesh.bvh.leaf_tri_off[leaf + 1] - mesh.bvh.leaf_tri_off[leaf]) as usize;
            let tris: Vec<u32> = (0..3 * n).map(|i| rd(payload, tri_at + 4 * i)).collect();
            let pn = &payload[tri_at + 12 * n..tri_at + 13 * n];
            crate::dyntopo::write_leaf_tris(mesh, leaf, &tris, pn);
        }
    }
    Ok((seq, end))
}

/// Leaf ids listed in a (validated) record, for refreshing what depends on positions.
pub fn record_leaves(bytes: &[u8]) -> Vec<u32> {
    let mut out = Vec::new();
    if bytes.len() < HEADER_BYTES {
        return out;
    }
    let topo = rd(bytes, 8) & KIND_TOPO != 0;
    let nleaves = rd(bytes, 12) as usize;
    let mut at = HEADER_BYTES;
    for _ in 0..nleaves {
        if at + 12 > bytes.len() {
            break;
        }
        out.push(rd(bytes, at));
        let count = rd(bytes, at + 8) as usize;
        at += 12 + count * 12;
        if topo {
            if at + 8 > bytes.len() {
                break;
            }
            let n = rd(bytes, at + 4) as usize;
            at += 8 + 12 * n + n.div_ceil(4) * 4;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sphere::cube_sphere;

    fn mesh() -> EditMesh {
        EditMesh::from_trimesh(cube_sphere(12), 32)
    }

    fn nudge(m: &mut EditMesh, tx: &mut Transaction, leaf: u32, dz: f32) {
        tx.touch(m, leaf);
        let (a, b) = m.leaf_range(leaf as usize);
        for v in a..b {
            m.positions[3 * v + 2] += dz;
        }
    }

    #[test]
    fn crc_known_value() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
    }

    #[test]
    fn und1_undo_redo_restore_exact_hashes() {
        let mut m = mesh();
        let h0 = m.position_hash();
        let mut tx = Transaction::new(m.nleaves());
        let mut hist = History::new(1 << 30, 100);
        tx.begin();
        nudge(&mut m, &mut tx, 1, 0.1);
        nudge(&mut m, &mut tx, 3, -0.2);
        nudge(&mut m, &mut tx, 1, 0.05); // second touch: before-state stays the original
        let after = LeafStates::capture(&m, tx.touched());
        let h1 = m.position_hash();
        hist.push(UndoEntry { before: std::mem::take(&mut tx.before), after });
        hist.undo(&mut m).unwrap();
        assert_eq!(m.position_hash(), h0);
        hist.redo(&mut m).unwrap();
        assert_eq!(m.position_hash(), h1);
    }

    #[test]
    fn und1_history_respects_budget() {
        let m = mesh();
        let mut hist = History::new(10_000, 1000);
        for _ in 0..50 {
            let s = LeafStates::capture(&m, &[0, 1]);
            hist.push(UndoEntry { before: s.clone(), after: s });
        }
        assert!(hist.bytes() <= 10_000 || hist.undo.len() == 1);
        assert!(hist.dropped > 0);
    }

    #[test]
    fn prj4_records_roundtrip_and_reject_damage() {
        let mut m = mesh();
        let mut tx = Transaction::new(m.nleaves());
        tx.begin();
        nudge(&mut m, &mut tx, 2, 0.3);
        nudge(&mut m, &mut tx, 5, 0.1);
        let after = LeafStates::capture(&m, tx.touched());
        let target = m.position_hash();
        let mut rec = Vec::new();
        encode_record(&mut rec, 7, KIND_STROKE, &after, &m);
        tx.before.restore(&mut m);
        let (seq, used) = apply_record(&mut m, &rec).unwrap();
        assert_eq!((seq, used), (7, rec.len()));
        assert_eq!(m.position_hash(), target);
        // Any torn or flipped byte is rejected and leaves the mesh untouched.
        let before = m.position_hash();
        assert_eq!(apply_record(&mut m, &rec[..rec.len() - 1]), Err(RecordError::Truncated));
        let mut bad = rec.clone();
        bad[HEADER_BYTES + 40] ^= 0x10;
        assert_eq!(apply_record(&mut m, &bad), Err(RecordError::BadCrc));
        assert_eq!(m.position_hash(), before);
    }
}
