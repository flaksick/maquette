//! Project files (PRJ-2). A project is: `topo.bin` (triangles, polygon runs and the BVH
//! partition: everything that doesn't change while sculpting), `positions.bin` (raw f32 xyz in
//! leaf order, rewritten in place by incremental checkpoints) and the journal. Storing the BVH
//! partition means loading never re-partitions, so positions.bin offsets stay valid forever.

use crate::bvh::Bvh;
use crate::history::crc32;
use crate::mesh::EditMesh;

pub const TOPO_MAGIC: u32 = 0x3154_514d; // "MQT1"
pub const TOPO_VERSION: u32 = 1;

fn push_u32s(out: &mut Vec<u8>, xs: &[u32]) {
    for &x in xs {
        out.extend_from_slice(&x.to_le_bytes());
    }
}

pub fn topo_bytes(m: &EditMesh) -> Vec<u8> {
    let mut out = Vec::new();
    push_u32s(
        &mut out,
        &[
            TOPO_MAGIC,
            TOPO_VERSION,
            m.nverts() as u32,
            m.nowned as u32,
            m.ntris() as u32,
            m.bvh.node_a.len() as u32,
            m.bvh.nleaves() as u32,
        ],
    );
    push_u32s(&mut out, &m.tris);
    out.extend_from_slice(&m.poly_next);
    while out.len() % 4 != 0 {
        out.push(0);
    }
    push_u32s(&mut out, &m.bvh.node_a);
    push_u32s(&mut out, &m.bvh.node_b);
    push_u32s(&mut out, &m.bvh.leaf_node);
    push_u32s(&mut out, &m.bvh.leaf_tri_off);
    push_u32s(&mut out, &m.bvh.own_off);
    let crc = crc32(&out);
    out.extend_from_slice(&crc.to_le_bytes());
    out
}

#[derive(Debug, PartialEq, Eq)]
pub enum LoadError {
    Truncated,
    BadMagic,
    BadVersion,
    BadCrc,
    BadPositions,
    Inconsistent,
}

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn u32(&mut self) -> Result<u32, LoadError> {
        let s = self.b.get(self.at..self.at + 4).ok_or(LoadError::Truncated)?;
        self.at += 4;
        Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn u32s(&mut self, n: usize) -> Result<Vec<u32>, LoadError> {
        (0..n).map(|_| self.u32()).collect()
    }
}

pub fn load(topo: &[u8], positions: &[u8]) -> Result<EditMesh, LoadError> {
    if topo.len() < 32 {
        return Err(LoadError::Truncated);
    }
    let body = &topo[..topo.len() - 4];
    let crc = u32::from_le_bytes(topo[topo.len() - 4..].try_into().unwrap());
    let mut r = Reader { b: body, at: 0 };
    if r.u32()? != TOPO_MAGIC {
        return Err(LoadError::BadMagic);
    }
    if r.u32()? != TOPO_VERSION {
        return Err(LoadError::BadVersion);
    }
    if crc32(body) != crc {
        return Err(LoadError::BadCrc);
    }
    let nverts = r.u32()? as usize;
    let nowned = r.u32()? as usize;
    let ntris = r.u32()? as usize;
    let nnodes = r.u32()? as usize;
    let nleaves = r.u32()? as usize;
    let tris = r.u32s(3 * ntris)?;
    let pn = body.get(r.at..r.at + ntris).ok_or(LoadError::Truncated)?.to_vec();
    r.at += ntris;
    r.at = (r.at + 3) / 4 * 4;
    let node_a = r.u32s(nnodes)?;
    let node_b = r.u32s(nnodes)?;
    let leaf_node = r.u32s(nleaves)?;
    let leaf_tri_off = r.u32s(nleaves + 1)?;
    let own_off = r.u32s(nleaves + 1)?;
    if positions.len() != nverts * 12 {
        return Err(LoadError::BadPositions);
    }
    if tris.iter().any(|&v| v as usize >= nverts)
        || leaf_tri_off.last().copied() != Some(ntris as u32)
        || own_off.last().copied() != Some(nowned as u32)
    {
        return Err(LoadError::Inconsistent);
    }
    let pos: Vec<f32> = positions.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    if pos.iter().any(|x| !x.is_finite()) {
        return Err(LoadError::BadPositions);
    }
    let bvh = Bvh {
        bounds: vec![0.0; nnodes * 6],
        node_a,
        node_b,
        leaf_node,
        leaf_tri_off,
        tri_order: (0..ntris as u32).collect(),
        own_off,
        own: (0..nowned as u32).collect(),
    };
    Ok(EditMesh::assemble(pos, tris, pn, bvh, nowned))
}

pub fn positions_bytes(m: &EditMesh) -> Vec<u8> {
    let mut out = Vec::with_capacity(m.positions.len() * 4);
    for &x in &m.positions {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::Engine;
    use crate::history::apply_record;
    use crate::sphere::cube_sphere;

    #[test]
    fn save_load_roundtrip_is_exact() {
        let m = EditMesh::from_trimesh(cube_sphere(24), 64);
        let t = topo_bytes(&m);
        let p = positions_bytes(&m);
        let back = load(&t, &p).unwrap();
        assert_eq!(back.position_hash(), m.position_hash());
        assert_eq!(back.tris, m.tris);
        assert_eq!(back.poly_next, m.poly_next);
        assert_eq!(back.bvh.own_off, m.bvh.own_off);
        assert_eq!(back.normals, m.normals);
    }

    #[test]
    fn damaged_topology_is_rejected() {
        let m = EditMesh::from_trimesh(cube_sphere(8), 32);
        let mut t = topo_bytes(&m);
        let p = positions_bytes(&m);
        t[100] ^= 1;
        assert_eq!(load(&t, &p).err(), Some(LoadError::BadCrc));
        assert_eq!(load(&topo_bytes(&m), &p[..p.len() - 4]).err(), Some(LoadError::BadPositions));
    }

    /// PRJ-4 native fuzz: sculpt, journal every record, "crash" at a random byte of the journal
    /// (torn write), recover = checkpoint + every valid record. The recovered mesh must equal the
    /// state after the last fully written record — 200 runs.
    #[test]
    fn random_kill_recovery_200_runs() {
        let mut seed = 0x1234_5678u32;
        let mut rnd = move || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        for run in 0..200 {
            let mut e = Engine::new(EditMesh::from_trimesh(cube_sphere(16), 32));
            e.cam = crate::engine::tests_support::camera([0.0, 0.3, 3.0], 600.0, 600.0);
            let checkpoint = positions_bytes(&e.mesh);
            let topo = topo_bytes(&e.mesh);
            let mut journal: Vec<u8> = Vec::new();
            let mut hashes = vec![e.mesh.position_hash()];
            let mut ends = vec![0usize];
            let strokes = 3 + (rnd() % 5) as usize;
            for _ in 0..strokes {
                e.brush.tool = crate::engine::Tool::from_u32(rnd() % 3);
                let (x, y) = (250.0 + (rnd() % 100) as f32, 250.0 + (rnd() % 100) as f32);
                e.stroke_begin(x, y, 1.0);
                e.stroke_move(&[x + 15.0, y + 5.0, 0.9, x + 30.0, y + 12.0, 0.7]);
                let mut n = e.stroke_end();
                if rnd() % 4 == 0 && n > 0 {
                    journal.extend_from_slice(&e.out);
                    hashes.push(e.mesh.position_hash());
                    ends.push(journal.len());
                    n = e.undo();
                }
                if n > 0 {
                    journal.extend_from_slice(&e.out);
                    hashes.push(e.mesh.position_hash());
                    ends.push(journal.len());
                }
            }
            let cut = (rnd() as usize) % (journal.len() + 1);
            let torn = &journal[..cut];
            // Recover.
            let mut m = load(&topo, &checkpoint).unwrap();
            let mut at = 0;
            while at < torn.len() {
                match apply_record(&mut m, &torn[at..]) {
                    Ok((_, used)) => at += used,
                    Err(_) => break,
                }
            }
            let complete = ends.iter().rposition(|&end| end <= cut).unwrap();
            assert_eq!(m.position_hash(), hashes[complete], "run {run}: cut {cut} of {}", journal.len());
        }
    }
}
