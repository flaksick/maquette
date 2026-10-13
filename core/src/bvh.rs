//! Triangle BVH with leaf-owned vertices. Nodes are stored structure-of-arrays in preorder
//! (a parent always precedes its children), so internal refit is one reverse sweep.
//! Every vertex is owned by exactly one leaf, so a sphere query visits each vertex once.

use crate::math::get3;

pub const NONE: u32 = u32::MAX;

pub struct Bvh {
    /// 6 floats per node: min xyz, max xyz.
    pub bounds: Vec<f32>,
    /// Internal: left child. Leaf: leaf index.
    pub node_a: Vec<u32>,
    /// Internal: right child. Leaf: NONE.
    pub node_b: Vec<u32>,
    /// Leaf index -> node index.
    pub leaf_node: Vec<u32>,
    /// Leaf index -> range in `tri_order` (len = leaves + 1).
    pub leaf_tri_off: Vec<u32>,
    pub tri_order: Vec<u32>,
    /// Leaf index -> range in `own` (len = leaves + 1).
    pub own_off: Vec<u32>,
    pub own: Vec<u32>,
}

impl Bvh {
    pub fn nleaves(&self) -> usize {
        self.leaf_node.len()
    }

    pub fn is_leaf(&self, node: usize) -> bool {
        self.node_b[node] == NONE
    }

    pub fn build(positions: &[f32], tris: &[u32], leaf_max: usize) -> Bvh {
        let ntri = tris.len() / 3;
        let mut centroids = vec![0.0f32; ntri * 3];
        for t in 0..ntri {
            let a = get3(positions, tris[3 * t] as usize);
            let b = get3(positions, tris[3 * t + 1] as usize);
            let c = get3(positions, tris[3 * t + 2] as usize);
            for k in 0..3 {
                centroids[3 * t + k] = (a[k] + b[k] + c[k]) * (1.0 / 3.0);
            }
        }
        let mut bvh = Bvh {
            bounds: Vec::new(),
            node_a: Vec::new(),
            node_b: Vec::new(),
            leaf_node: Vec::new(),
            leaf_tri_off: vec![0],
            tri_order: (0..ntri as u32).collect(),
            own_off: Vec::new(),
            own: Vec::new(),
        };
        bvh.split(&centroids, 0, ntri, leaf_max.max(1));
        bvh.compute_ownership(positions.len() / 3, tris);
        let leaves: Vec<u32> = (0..bvh.nleaves() as u32).collect();
        bvh.refit_leaves(positions, tris, &leaves);
        bvh.refit_internal();
        bvh
    }

    fn push_node(&mut self) -> usize {
        self.bounds.extend_from_slice(&[0.0; 6]);
        self.node_a.push(0);
        self.node_b.push(NONE);
        self.node_a.len() - 1
    }

    fn split(&mut self, centroids: &[f32], start: usize, end: usize, leaf_max: usize) -> usize {
        let node = self.push_node();
        let count = end - start;
        if count <= leaf_max {
            let leaf = self.leaf_node.len();
            self.leaf_node.push(node as u32);
            self.leaf_tri_off.push(end as u32);
            self.node_a[node] = leaf as u32;
            self.node_b[node] = NONE;
            return node;
        }
        let mut lo = [f32::INFINITY; 3];
        let mut hi = [f32::NEG_INFINITY; 3];
        for &t in &self.tri_order[start..end] {
            for k in 0..3 {
                let c = centroids[3 * t as usize + k];
                lo[k] = lo[k].min(c);
                hi[k] = hi[k].max(c);
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
        let mid = start + count / 2;
        // Deterministic median split: ties broken by triangle id.
        self.tri_order[start..end].select_nth_unstable_by(mid - start, |&x, &y| {
            let cx = centroids[3 * x as usize + axis];
            let cy = centroids[3 * y as usize + axis];
            cx.total_cmp(&cy).then(x.cmp(&y))
        });
        let left = self.split(centroids, start, mid, leaf_max);
        let right = self.split(centroids, mid, end, leaf_max);
        self.node_a[node] = left as u32;
        self.node_b[node] = right as u32;
        node
    }

    fn compute_ownership(&mut self, nverts: usize, tris: &[u32]) {
        let nleaves = self.nleaves();
        let mut owner = vec![NONE; nverts];
        let mut counts = vec![0u32; nleaves + 1];
        for leaf in 0..nleaves {
            let (s, e) = (self.leaf_tri_off[leaf] as usize, self.leaf_tri_off[leaf + 1] as usize);
            for &t in &self.tri_order[s..e] {
                for k in 0..3 {
                    let v = tris[3 * t as usize + k] as usize;
                    if owner[v] == NONE {
                        owner[v] = leaf as u32;
                        counts[leaf + 1] += 1;
                    }
                }
            }
        }
        for i in 0..nleaves {
            counts[i + 1] += counts[i];
        }
        let mut fill = counts.clone();
        let mut own = vec![0u32; nverts];
        for (v, &leaf) in owner.iter().enumerate() {
            if leaf != NONE {
                let slot = &mut fill[leaf as usize];
                own[*slot as usize] = v as u32;
                *slot += 1;
            }
        }
        own.truncate(counts[nleaves] as usize);
        self.own_off = counts;
        self.own = own;
    }

    pub fn refit_leaves(&mut self, positions: &[f32], tris: &[u32], leaves: &[u32]) {
        for &leaf in leaves {
            let leaf = leaf as usize;
            let mut lo = [f32::INFINITY; 3];
            let mut hi = [f32::NEG_INFINITY; 3];
            let (s, e) = (self.leaf_tri_off[leaf] as usize, self.leaf_tri_off[leaf + 1] as usize);
            for &t in &self.tri_order[s..e] {
                for k in 0..3 {
                    let p = get3(positions, tris[3 * t as usize + k] as usize);
                    for a in 0..3 {
                        lo[a] = lo[a].min(p[a]);
                        hi[a] = hi[a].max(p[a]);
                    }
                }
            }
            let node = self.leaf_node[leaf] as usize;
            self.bounds[6 * node..6 * node + 3].copy_from_slice(&lo);
            self.bounds[6 * node + 3..6 * node + 6].copy_from_slice(&hi);
        }
    }

    pub fn refit_internal(&mut self) {
        for node in (0..self.node_a.len()).rev() {
            if self.is_leaf(node) {
                continue;
            }
            let (l, r) = (self.node_a[node] as usize, self.node_b[node] as usize);
            for a in 0..3 {
                self.bounds[6 * node + a] = self.bounds[6 * l + a].min(self.bounds[6 * r + a]);
                self.bounds[6 * node + 3 + a] =
                    self.bounds[6 * l + 3 + a].max(self.bounds[6 * r + 3 + a]);
            }
        }
    }

    /// Leaf indices whose bounds intersect the sphere, in traversal order.
    pub fn query_sphere(&self, c: [f32; 3], r: f32, out: &mut Vec<u32>, stack: &mut Vec<u32>) {
        out.clear();
        stack.clear();
        stack.push(0);
        let r2 = r * r;
        while let Some(node) = stack.pop() {
            let node = node as usize;
            let b = &self.bounds[6 * node..6 * node + 6];
            let mut d2 = 0.0f32;
            for a in 0..3 {
                let d = (b[a] - c[a]).max(0.0).max(c[a] - b[3 + a]);
                d2 += d * d;
            }
            if d2 > r2 {
                continue;
            }
            if self.is_leaf(node) {
                out.push(self.node_a[node]);
            } else {
                stack.push(self.node_b[node]);
                stack.push(self.node_a[node]);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partitions_triangles_and_vertices_exactly_once() {
        let m = crate::sphere::cube_sphere(20);
        let bvh = Bvh::build(&m.positions, &m.tris, 64);
        let mut seen_t = vec![0u8; m.ntris()];
        for &t in &bvh.tri_order {
            seen_t[t as usize] += 1;
        }
        assert!(seen_t.iter().all(|&c| c == 1));
        let mut seen_v = vec![0u8; m.nverts()];
        for &v in &bvh.own {
            seen_v[v as usize] += 1;
        }
        assert!(seen_v.iter().all(|&c| c == 1));
        for leaf in 0..bvh.nleaves() {
            assert!(bvh.leaf_tri_off[leaf + 1] - bvh.leaf_tri_off[leaf] <= 64);
        }
    }

    #[test]
    fn bounds_contain_children_and_queries_are_complete() {
        let m = crate::sphere::cube_sphere(16);
        let bvh = Bvh::build(&m.positions, &m.tris, 32);
        for node in 0..bvh.node_a.len() {
            if bvh.is_leaf(node) {
                continue;
            }
            for child in [bvh.node_a[node] as usize, bvh.node_b[node] as usize] {
                for a in 0..3 {
                    assert!(bvh.bounds[6 * node + a] <= bvh.bounds[6 * child + a]);
                    assert!(bvh.bounds[6 * node + 3 + a] >= bvh.bounds[6 * child + 3 + a]);
                }
            }
        }
        // Brute force: every vertex within the sphere must be owned by a returned leaf.
        let (c, r) = ([0.6f32, 0.6, 0.53], 0.3f32);
        let (mut leaves, mut stack) = (Vec::new(), Vec::new());
        bvh.query_sphere(c, r, &mut leaves, &mut stack);
        let mut hit = vec![false; m.nverts()];
        for &leaf in &leaves {
            let (s, e) = (bvh.own_off[leaf as usize] as usize, bvh.own_off[leaf as usize + 1] as usize);
            for &v in &bvh.own[s..e] {
                hit[v as usize] = true;
            }
        }
        for v in 0..m.nverts() {
            let p = get3(&m.positions, v);
            let d2 = (0..3).map(|a| (p[a] - c[a]) * (p[a] - c[a])).sum::<f32>();
            if d2 < r * r {
                assert!(hit[v], "vertex {v} inside sphere but its leaf was culled");
            }
        }
    }
}
