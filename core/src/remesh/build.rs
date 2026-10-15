//! Incremental `EditMesh` construction. Produces exactly what `EditMesh::from_trimesh` produces
//! (same polygon BVH, leaf order, vertex numbering, adjacency, bounds and normals; pinned by
//! `top1_builder_matches_from_trimesh`), but in bounded steps: at 1M triangles the one-shot
//! build takes ~71 ms natively, several frames on the iPad.

use crate::bvh::{Bvh, NONE};
use crate::math::{add, get3, set3};
use crate::mesh::EditMesh;
use crate::topo::Topo;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    PolyOff,
    Centroids,
    Split,
    Reorder,
    Own,
    Remap,
    VtCount,
    VtFill,
    Vv,
    LeafMaps,
    Refit,
    Normals,
    Done,
}

pub struct Builder {
    leaf_max: usize,
    phase: Phase,
    cur: usize,
    // input (taken over from the remesh output)
    in_pos: Vec<f32>,
    in_tris: Vec<u32>,
    in_pn: Vec<u8>,
    // polygon BVH
    poly_off: Vec<u32>,
    cen: Vec<f32>,
    order: Vec<u32>,
    node_a: Vec<u32>,
    node_b: Vec<u32>,
    leaf_node: Vec<u32>,
    leaf_poly_off: Vec<u32>,
    stack: Vec<[u32; 4]>,
    // leaf-ordered output
    tris: Vec<u32>,
    poly_next: Vec<u8>,
    leaf_tri_off: Vec<u32>,
    new_of_old: Vec<u32>,
    own_off: Vec<u32>,
    next: u32,
    nowned: usize,
    positions: Vec<f32>,
    // adjacency
    vt_off: Vec<u32>,
    vt: Vec<u32>,
    fill: Vec<u32>,
    vv_off: Vec<u32>,
    vv: Vec<u32>,
    ring: Vec<u32>,
    leaf_of_vertex: Vec<u32>,
    leaf_of_tri: Vec<u32>,
    mesh: Option<EditMesh>,
}

impl Builder {
    pub fn new(positions: Vec<f32>, tris: Vec<u32>, poly_next: Vec<u8>, leaf_max_tris: usize) -> Builder {
        Builder {
            leaf_max: leaf_max_tris.max(2),
            phase: Phase::PolyOff,
            cur: 0,
            in_pos: positions,
            in_tris: tris,
            in_pn: poly_next,
            poly_off: Vec::new(),
            cen: Vec::new(),
            order: Vec::new(),
            node_a: Vec::new(),
            node_b: Vec::new(),
            leaf_node: Vec::new(),
            leaf_poly_off: Vec::new(),
            stack: Vec::new(),
            tris: Vec::new(),
            poly_next: Vec::new(),
            leaf_tri_off: Vec::new(),
            new_of_old: Vec::new(),
            own_off: Vec::new(),
            next: 0,
            nowned: 0,
            positions: Vec::new(),
            vt_off: Vec::new(),
            vt: Vec::new(),
            fill: Vec::new(),
            vv_off: Vec::new(),
            vv: Vec::new(),
            ring: Vec::new(),
            leaf_of_vertex: Vec::new(),
            leaf_of_tri: Vec::new(),
            mesh: None,
        }
    }

    pub fn bytes(&self) -> usize {
        let v4 = |n: usize| n * 4;
        v4(self.in_pos.capacity() + self.in_tris.capacity())
            + self.in_pn.capacity()
            + v4(self.poly_off.capacity() + self.cen.capacity() + self.order.capacity() + self.node_a.capacity() + self.node_b.capacity())
            + v4(self.leaf_node.capacity() + self.leaf_poly_off.capacity() + 4 * self.stack.capacity())
            + v4(self.tris.capacity() + self.leaf_tri_off.capacity() + self.new_of_old.capacity() + self.own_off.capacity())
            + self.poly_next.capacity()
            + v4(self.positions.capacity() + self.vt_off.capacity() + self.vt.capacity() + self.fill.capacity())
            + v4(self.vv_off.capacity() + self.vv.capacity() + self.leaf_of_vertex.capacity() + self.leaf_of_tri.capacity())
            + self.mesh.as_ref().map_or(0, mesh_bytes)
    }

    pub fn done(&self) -> bool {
        self.phase == Phase::Done
    }

    /// Fraction of the work done, for progress bars.
    pub fn progress(&self) -> f32 {
        (self.phase as u32 as f32) / (Phase::Done as u32 as f32)
    }

    pub fn take(&mut self) -> Option<EditMesh> {
        self.mesh.take()
    }

    fn ntri(&self) -> usize {
        self.in_tris.len() / 3
    }

    /// Runs until `left` work units are spent. Returns true when the mesh is complete.
    pub fn step(&mut self, left: &mut i64) -> bool {
        while *left > 0 && self.phase != Phase::Done {
            let finished = match self.phase {
                Phase::PolyOff => self.poly_off_step(left),
                Phase::Centroids => self.centroid_step(left),
                Phase::Split => self.split_step(left),
                Phase::Reorder => self.reorder_step(left),
                Phase::Own => self.own_step(left),
                Phase::Remap => self.remap_step(left),
                Phase::VtCount => self.vt_count_step(left),
                Phase::VtFill => self.vt_fill_step(left),
                Phase::Vv => self.vv_step(left),
                Phase::LeafMaps => self.leaf_maps_step(left),
                Phase::Refit => self.refit_step(left),
                Phase::Normals => self.normals_step(left),
                Phase::Done => true,
            };
            if finished {
                self.cur = 0;
                self.phase = match self.phase {
                    Phase::PolyOff => Phase::Centroids,
                    Phase::Centroids => Phase::Split,
                    Phase::Split => Phase::Reorder,
                    Phase::Reorder => Phase::Own,
                    Phase::Own => Phase::Remap,
                    Phase::Remap => Phase::VtCount,
                    Phase::VtCount => Phase::VtFill,
                    Phase::VtFill => Phase::Vv,
                    Phase::Vv => Phase::LeafMaps,
                    Phase::LeafMaps => Phase::Refit,
                    Phase::Refit => Phase::Normals,
                    Phase::Normals | Phase::Done => Phase::Done,
                };
            }
        }
        self.phase == Phase::Done
    }

    // 1. polygon runs
    fn poly_off_step(&mut self, left: &mut i64) -> bool {
        let ntri = self.ntri();
        if self.cur == 0 {
            self.poly_off = Vec::with_capacity(ntri / 2 + 2);
            self.poly_off.push(0);
        }
        let end = (self.cur + (*left as usize).max(1)).min(ntri);
        for t in self.cur..end {
            if self.in_pn.get(t).copied().unwrap_or(0) == 0 {
                self.poly_off.push(t as u32 + 1);
            }
        }
        *left -= (end - self.cur) as i64;
        self.cur = end;
        if end < ntri {
            return false;
        }
        if *self.poly_off.last().unwrap() as usize != ntri {
            self.poly_off.push(ntri as u32);
        }
        true
    }

    fn npoly(&self) -> usize {
        self.poly_off.len() - 1
    }

    // 2. polygon centroids (same float operation order as from_trimesh)
    fn centroid_step(&mut self, left: &mut i64) -> bool {
        let np = self.npoly();
        if self.cur == 0 {
            self.cen = vec![0.0; np * 3];
        }
        let end = (self.cur + (*left as usize / 4).max(1)).min(np);
        for p in self.cur..end {
            let (s, e) = (self.poly_off[p] as usize, self.poly_off[p + 1] as usize);
            let mut c = [0.0f32; 3];
            for t in s..e {
                for k in 0..3 {
                    c = add(c, get3(&self.in_pos, self.in_tris[3 * t + k] as usize));
                }
            }
            let inv = 1.0 / (3 * (e - s)) as f32;
            set3(&mut self.cen, p, [c[0] * inv, c[1] * inv, c[2] * inv]);
        }
        *left -= 4 * (end - self.cur) as i64;
        self.cur = end;
        end >= np
    }

    fn tris_in(&self, s: usize, e: usize) -> usize {
        self.order[s..e].iter().map(|&p| (self.poly_off[p as usize + 1] - self.poly_off[p as usize]) as usize).sum()
    }

    // 3. median-split polygon BVH, iterative and in the same preorder as the recursive builder
    fn split_step(&mut self, left: &mut i64) -> bool {
        if self.cur == 0 {
            self.cur = 1;
            let np = self.npoly();
            self.order = (0..np as u32).collect();
            self.leaf_poly_off = vec![0];
            self.stack = vec![[0, np as u32, NONE, 0]];
        }
        while let Some([s, e, parent, side]) = self.stack.pop() {
            let (s, e) = (s as usize, e as usize);
            let node = self.node_a.len();
            self.node_a.push(0);
            self.node_b.push(NONE);
            if parent != NONE {
                if side == 0 {
                    self.node_a[parent as usize] = node as u32;
                } else {
                    self.node_b[parent as usize] = node as u32;
                }
            }
            *left -= 4 + (e - s) as i64;
            if e - s <= 1 || self.tris_in(s, e) <= self.leaf_max {
                self.node_a[node] = self.leaf_node.len() as u32;
                self.leaf_node.push(node as u32);
                self.leaf_poly_off.push(e as u32);
            } else {
                let mut lo = [f32::INFINITY; 3];
                let mut hi = [f32::NEG_INFINITY; 3];
                for &p in &self.order[s..e] {
                    let c = get3(&self.cen, p as usize);
                    for k in 0..3 {
                        lo[k] = lo[k].min(c[k]);
                        hi[k] = hi[k].max(c[k]);
                    }
                }
                let ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
                let axis = if ext[0] >= ext[1] && ext[0] >= ext[2] {
                    0
                } else if ext[1] >= ext[2] {
                    1
                } else {
                    2
                };
                let mid = s + (e - s) / 2;
                let cen = &self.cen;
                self.order[s..e].select_nth_unstable_by(mid - s, |&x, &y| {
                    cen[3 * x as usize + axis].total_cmp(&cen[3 * y as usize + axis]).then(x.cmp(&y))
                });
                self.stack.push([mid as u32, e as u32, node as u32, 1]);
                self.stack.push([s as u32, mid as u32, node as u32, 0]);
            }
            if *left <= 0 {
                return self.stack.is_empty();
            }
        }
        true
    }

    fn nleaves(&self) -> usize {
        self.leaf_node.len()
    }

    // 4. triangles into leaf order, polygon runs kept together
    fn reorder_step(&mut self, left: &mut i64) -> bool {
        if self.cur == 0 {
            self.tris = Vec::with_capacity(self.in_tris.len());
            self.poly_next = Vec::with_capacity(self.ntri());
            self.leaf_tri_off = vec![0];
            self.cen = Vec::new();
        }
        while self.cur < self.nleaves() {
            let leaf = self.cur;
            for i in self.leaf_poly_off[leaf] as usize..self.leaf_poly_off[leaf + 1] as usize {
                let p = self.order[i] as usize;
                let (s, e) = (self.poly_off[p] as usize, self.poly_off[p + 1] as usize);
                for t in s..e {
                    self.tris.extend_from_slice(&self.in_tris[3 * t..3 * t + 3]);
                    self.poly_next.push(if t + 1 < e { 1 } else { 0 });
                }
            }
            self.leaf_tri_off.push((self.tris.len() / 3) as u32);
            *left -= (self.leaf_tri_off[leaf + 1] - self.leaf_tri_off[leaf]) as i64 + 1;
            self.cur += 1;
            if *left <= 0 {
                break;
            }
        }
        if self.cur < self.nleaves() {
            return false;
        }
        self.in_tris = Vec::new();
        self.in_pn = Vec::new();
        self.order = Vec::new();
        self.poly_off = Vec::new();
        self.leaf_poly_off = Vec::new();
        true
    }

    // 5. vertex ownership in first-seen leaf order
    fn own_step(&mut self, left: &mut i64) -> bool {
        let nv = self.in_pos.len() / 3;
        if self.cur == 0 {
            self.new_of_old = vec![NONE; nv];
            self.own_off = vec![0u32; self.nleaves() + 1];
            self.next = 0;
        }
        while self.cur < self.nleaves() {
            let leaf = self.cur;
            for t in self.leaf_tri_off[leaf] as usize..self.leaf_tri_off[leaf + 1] as usize {
                for k in 0..3 {
                    let v = self.tris[3 * t + k] as usize;
                    if self.new_of_old[v] == NONE {
                        self.new_of_old[v] = self.next;
                        self.next += 1;
                    }
                }
            }
            self.own_off[leaf + 1] = self.next;
            *left -= (self.leaf_tri_off[leaf + 1] - self.leaf_tri_off[leaf]) as i64 + 1;
            self.cur += 1;
            if *left <= 0 {
                break;
            }
        }
        if self.cur < self.nleaves() {
            return false;
        }
        self.nowned = self.next as usize;
        for v in self.new_of_old.iter_mut() {
            if *v == NONE {
                *v = self.next;
                self.next += 1;
            }
        }
        true
    }

    // 6. renumber positions and triangle corners
    fn remap_step(&mut self, left: &mut i64) -> bool {
        let nv = self.in_pos.len() / 3;
        if self.cur == 0 {
            self.positions = vec![0.0f32; nv * 3];
        }
        let total = nv + self.tris.len();
        let end = (self.cur + (*left as usize).max(1)).min(total);
        for i in self.cur..end {
            if i < nv {
                set3(&mut self.positions, self.new_of_old[i] as usize, get3(&self.in_pos, i));
            } else {
                let j = i - nv;
                self.tris[j] = self.new_of_old[self.tris[j] as usize];
            }
        }
        *left -= (end - self.cur) as i64;
        self.cur = end;
        if end < total {
            return false;
        }
        self.in_pos = Vec::new();
        self.new_of_old = Vec::new();
        true
    }

    fn nverts(&self) -> usize {
        self.positions.len() / 3
    }

    // 7. topo::build, split into count / fill / rings
    fn vt_count_step(&mut self, left: &mut i64) -> bool {
        let nv = self.nverts();
        if self.cur == 0 {
            self.vt_off = vec![0u32; nv + 1];
        }
        let n = self.tris.len();
        let end = (self.cur + (*left as usize).max(1)).min(n + nv);
        for i in self.cur..end {
            if i < n {
                self.vt_off[self.tris[i] as usize + 1] += 1;
            } else {
                let v = i - n;
                self.vt_off[v + 1] += self.vt_off[v];
            }
        }
        *left -= (end - self.cur) as i64;
        self.cur = end;
        end >= n + nv
    }

    fn vt_fill_step(&mut self, left: &mut i64) -> bool {
        if self.cur == 0 {
            self.fill = self.vt_off.clone();
            self.vt = vec![0u32; self.tris.len()];
        }
        let ntri = self.tris.len() / 3;
        let end = (self.cur + (*left as usize / 3).max(1)).min(ntri);
        for t in self.cur..end {
            for k in 0..3 {
                let v = self.tris[3 * t + k] as usize;
                let slot = &mut self.fill[v];
                self.vt[*slot as usize] = t as u32;
                *slot += 1;
            }
        }
        *left -= 3 * (end - self.cur) as i64;
        self.cur = end;
        if end < ntri {
            return false;
        }
        self.fill = Vec::new();
        true
    }

    fn vv_step(&mut self, left: &mut i64) -> bool {
        let nv = self.nverts();
        if self.cur == 0 {
            self.vv_off = Vec::with_capacity(nv + 1);
            self.vv = Vec::with_capacity(nv * 7);
            self.vv_off.push(0);
        }
        while self.cur < nv {
            let v = self.cur;
            self.ring.clear();
            for &t in &self.vt[self.vt_off[v] as usize..self.vt_off[v + 1] as usize] {
                for &w in &self.tris[3 * t as usize..3 * t as usize + 3] {
                    if w as usize != v {
                        self.ring.push(w);
                    }
                }
            }
            self.ring.sort_unstable();
            self.ring.dedup();
            self.vv.extend_from_slice(&self.ring);
            self.vv_off.push(self.vv.len() as u32);
            *left -= 8;
            self.cur += 1;
            if *left <= 0 {
                break;
            }
        }
        self.cur >= nv
    }

    // 8. leaf maps, then the EditMesh itself
    fn leaf_maps_step(&mut self, left: &mut i64) -> bool {
        if self.cur == 0 {
            self.leaf_of_vertex = vec![NONE; self.nverts()];
            self.leaf_of_tri = vec![0u32; self.tris.len() / 3];
        }
        while self.cur < self.nleaves() {
            let leaf = self.cur;
            for v in self.own_off[leaf]..self.own_off[leaf + 1] {
                self.leaf_of_vertex[v as usize] = leaf as u32;
            }
            for t in self.leaf_tri_off[leaf]..self.leaf_tri_off[leaf + 1] {
                self.leaf_of_tri[t as usize] = leaf as u32;
            }
            *left -= (self.own_off[leaf + 1] - self.own_off[leaf] + self.leaf_tri_off[leaf + 1] - self.leaf_tri_off[leaf]) as i64 + 1;
            self.cur += 1;
            if *left <= 0 {
                break;
            }
        }
        if self.cur < self.nleaves() {
            return false;
        }
        let ntri = self.tris.len() / 3;
        let nnodes = self.node_a.len();
        let bvh = Bvh {
            bounds: vec![0.0; nnodes * 6],
            node_a: std::mem::take(&mut self.node_a),
            node_b: std::mem::take(&mut self.node_b),
            leaf_node: std::mem::take(&mut self.leaf_node),
            leaf_tri_off: std::mem::take(&mut self.leaf_tri_off),
            tri_order: (0..ntri as u32).collect(),
            own_off: std::mem::take(&mut self.own_off),
            own: (0..self.nowned as u32).collect(),
        };
        let positions = std::mem::take(&mut self.positions);
        self.mesh = Some(EditMesh {
            normals: vec![0.0; positions.len()],
            positions,
            tris: std::mem::take(&mut self.tris),
            poly_next: std::mem::take(&mut self.poly_next),
            topo: Topo {
                vt_off: std::mem::take(&mut self.vt_off),
                vt: std::mem::take(&mut self.vt),
                vv_off: std::mem::take(&mut self.vv_off),
                vv: std::mem::take(&mut self.vv),
                ..Default::default()
            },
            bvh,
            leaf_of_vertex: std::mem::take(&mut self.leaf_of_vertex),
            leaf_of_tri: std::mem::take(&mut self.leaf_of_tri),
            nowned: self.nowned,
        });
        true
    }

    // 9. bounds (all leaves, then internal nodes) and vertex normals
    fn refit_step(&mut self, left: &mut i64) -> bool {
        let m = self.mesh.as_mut().unwrap();
        let nl = m.nleaves();
        let chunk = ((*left as usize) / 64).max(1);
        let end = (self.cur + chunk).min(nl);
        let leaves: Vec<u32> = (self.cur as u32..end as u32).collect();
        m.bvh.refit_leaves(&m.positions, &m.tris, &leaves);
        let tris: u32 = (self.cur..end).map(|l| m.bvh.leaf_tri_off[l + 1] - m.bvh.leaf_tri_off[l]).sum();
        *left -= 3 * tris as i64 + 1;
        self.cur = end;
        if end < nl {
            return false;
        }
        m.bvh.refit_internal();
        true
    }

    fn normals_step(&mut self, left: &mut i64) -> bool {
        let m = self.mesh.as_mut().unwrap();
        let nv = m.nverts();
        let end = (self.cur + (*left as usize / 8).max(1)).min(nv);
        for v in self.cur..end {
            m.vertex_normal(v);
        }
        *left -= 8 * (end - self.cur) as i64;
        self.cur = end;
        end >= nv
    }
}

/// Heap bytes of an EditMesh (its arrays' capacities).
pub fn mesh_bytes(m: &EditMesh) -> usize {
    4 * (m.positions.capacity() + m.normals.capacity() + m.tris.capacity())
        + m.poly_next.capacity()
        + 4 * (m.topo.vt_off.capacity() + m.topo.vt.capacity() + m.topo.vv_off.capacity() + m.topo.vv.capacity())
        + 4 * (m.bvh.bounds.capacity() + m.bvh.node_a.capacity() + m.bvh.node_b.capacity() + m.bvh.leaf_node.capacity())
        + 4 * (m.bvh.leaf_tri_off.capacity() + m.bvh.tri_order.capacity() + m.bvh.own_off.capacity() + m.bvh.own.capacity())
        + 4 * (m.leaf_of_vertex.capacity() + m.leaf_of_tri.capacity())
}
