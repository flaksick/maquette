//! The editable mesh (P1a: static topology). Built so that every BVH leaf owns one contiguous
//! range of vertex ids, which makes a leaf the natural unit of undo, journaling and GPU upload
//! (ARCHITECTURE: node transactions).
//!
//! Construction:
//! 1. polygons = runs of triangles (`poly_next`), so a quad's two triangles never split;
//! 2. BVH over polygons (median split on centroids), triangles reordered into leaf order;
//! 3. each vertex is owned by the first leaf that references it;
//! 4. vertices are renumbered so leaf L owns ids `own_off[L] .. own_off[L+1]`.

use crate::bvh::{Bvh, NONE};
use crate::math::{add, cross, dot, get3, normalize, set3, sub};
use crate::sphere::TriMesh;
use crate::topo::{self, Topo};

pub struct EditMesh {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub tris: Vec<u32>,
    /// 1 = triangle t and t+1 belong to the same polygon.
    pub poly_next: Vec<u8>,
    pub topo: Topo,
    pub bvh: Bvh,
    /// Owning leaf per vertex (NONE for vertices no triangle references).
    pub leaf_of_vertex: Vec<u32>,
    /// Leaf containing each triangle (triangles are stored in leaf order).
    pub leaf_of_tri: Vec<u32>,
    /// Vertices with id < nowned are owned by a leaf.
    pub nowned: usize,
}

#[derive(Clone, Copy, Debug)]
pub struct Hit {
    pub tri: u32,
    pub t: f32,
    pub point: [f32; 3],
    pub normal: [f32; 3],
}

impl EditMesh {
    pub fn nverts(&self) -> usize {
        self.positions.len() / 3
    }
    pub fn ntris(&self) -> usize {
        self.tris.len() / 3
    }
    pub fn nleaves(&self) -> usize {
        self.bvh.nleaves()
    }
    pub fn leaf_range(&self, leaf: usize) -> (usize, usize) {
        (self.bvh.own_off[leaf] as usize, self.bvh.own_off[leaf + 1] as usize)
    }

    pub fn from_trimesh(m: TriMesh, leaf_max_tris: usize) -> EditMesh {
        let nv = m.nverts();
        let ntri = m.ntris();
        // 1. polygon runs
        let mut poly_off: Vec<u32> = vec![0];
        for t in 0..ntri {
            if m.poly_next.get(t).copied().unwrap_or(0) == 0 {
                poly_off.push(t as u32 + 1);
            }
        }
        if *poly_off.last().unwrap() as usize != ntri {
            poly_off.push(ntri as u32); // a dangling run is closed at the end
        }
        let npoly = poly_off.len() - 1;
        let mut cen = vec![0.0f32; npoly * 3];
        for p in 0..npoly {
            let (s, e) = (poly_off[p] as usize, poly_off[p + 1] as usize);
            let mut c = [0.0f32; 3];
            for t in s..e {
                for k in 0..3 {
                    c = add(c, get3(&m.positions, m.tris[3 * t + k] as usize));
                }
            }
            let inv = 1.0 / (3 * (e - s)) as f32;
            set3(&mut cen, p, [c[0] * inv, c[1] * inv, c[2] * inv]);
        }

        // 2. BVH over polygons
        let mut b = PolyBuilder {
            cen: &cen,
            poly_off: &poly_off,
            order: (0..npoly as u32).collect(),
            node_a: Vec::new(),
            node_b: Vec::new(),
            leaf_node: Vec::new(),
            leaf_poly_off: vec![0],
            leaf_max: leaf_max_tris.max(2),
        };
        b.split(0, npoly);

        // Reorder triangles into leaf order, keeping polygon runs together.
        let mut tris = Vec::with_capacity(m.tris.len());
        let mut poly_next = Vec::with_capacity(ntri);
        let mut leaf_tri_off = vec![0u32];
        for leaf in 0..b.leaf_node.len() {
            for &p in &b.order[b.leaf_poly_off[leaf] as usize..b.leaf_poly_off[leaf + 1] as usize] {
                let (s, e) = (poly_off[p as usize] as usize, poly_off[p as usize + 1] as usize);
                for t in s..e {
                    tris.extend_from_slice(&m.tris[3 * t..3 * t + 3]);
                    poly_next.push(if t + 1 < e { 1 } else { 0 });
                }
            }
            leaf_tri_off.push((tris.len() / 3) as u32);
        }

        // 3. ownership in first-seen order -> 4. renumbering
        let nleaves = b.leaf_node.len();
        let mut new_of_old = vec![NONE; nv];
        let mut own_off = vec![0u32; nleaves + 1];
        let mut next = 0u32;
        for leaf in 0..nleaves {
            for t in leaf_tri_off[leaf] as usize..leaf_tri_off[leaf + 1] as usize {
                for k in 0..3 {
                    let v = tris[3 * t + k] as usize;
                    if new_of_old[v] == NONE {
                        new_of_old[v] = next;
                        next += 1;
                    }
                }
            }
            own_off[leaf + 1] = next;
        }
        let nowned = next as usize;
        for v in new_of_old.iter_mut() {
            if *v == NONE {
                *v = next;
                next += 1;
            }
        }
        let mut positions = vec![0.0f32; nv * 3];
        for old in 0..nv {
            set3(&mut positions, new_of_old[old] as usize, get3(&m.positions, old));
        }
        for v in tris.iter_mut() {
            *v = new_of_old[*v as usize];
        }

        let bvh = Bvh {
            bounds: vec![0.0; b.node_a.len() * 6],
            node_a: b.node_a,
            node_b: b.node_b,
            leaf_node: b.leaf_node,
            leaf_tri_off,
            tri_order: (0..ntri as u32).collect(),
            own_off,
            own: (0..nowned as u32).collect(),
        };
        Self::assemble(positions, tris, poly_next, bvh, nowned)
    }

    /// Final assembly shared by construction and loading: adjacency, normals, bounds.
    pub fn assemble(positions: Vec<f32>, tris: Vec<u32>, poly_next: Vec<u8>, mut bvh: Bvh, nowned: usize) -> EditMesh {
        let nv = positions.len() / 3;
        let topo = topo::build(nv, &tris);
        let mut leaf_of_vertex = vec![NONE; nv];
        for leaf in 0..bvh.nleaves() {
            for v in bvh.own_off[leaf]..bvh.own_off[leaf + 1] {
                leaf_of_vertex[v as usize] = leaf as u32;
            }
        }
        let mut leaf_of_tri = vec![0u32; tris.len() / 3];
        for leaf in 0..bvh.nleaves() {
            for t in bvh.leaf_tri_off[leaf]..bvh.leaf_tri_off[leaf + 1] {
                leaf_of_tri[t as usize] = leaf as u32;
            }
        }
        let all: Vec<u32> = (0..bvh.nleaves() as u32).collect();
        bvh.refit_leaves(&positions, &tris, &all);
        bvh.refit_internal();
        let mut m = EditMesh {
            normals: vec![0.0; positions.len()],
            positions,
            tris,
            poly_next,
            topo,
            bvh,
            leaf_of_vertex,
            leaf_of_tri,
            nowned,
        };
        for v in 0..nv {
            m.vertex_normal(v);
        }
        m
    }

    /// Area-weighted vertex normal from the incident triangles.
    pub fn vertex_normal(&mut self, v: usize) {
        let mut n = [0.0f32; 3];
        for &tt in self.topo.vtris(v) {
            let t = 3 * tt as usize;
            let a = get3(&self.positions, self.tris[t] as usize);
            let b = get3(&self.positions, self.tris[t + 1] as usize);
            let c = get3(&self.positions, self.tris[t + 2] as usize);
            n = add(n, cross(sub(b, a), sub(c, a)));
        }
        set3(&mut self.normals, v, normalize(n));
    }

    pub fn neighbors(&self, v: usize) -> &[u32] {
        self.topo.vverts(v)
    }

    /// Nearest intersection of the ray o + t·d (t > 0) with the mesh, both faces counted.
    pub fn raycast(&self, o: [f32; 3], d: [f32; 3]) -> Option<Hit> {
        let inv = [1.0 / d[0], 1.0 / d[1], 1.0 / d[2]];
        let mut best: Option<Hit> = None;
        let mut best_t = f32::INFINITY;
        let mut stack: Vec<u32> = Vec::with_capacity(64);
        stack.push(0);
        while let Some(node) = stack.pop() {
            let node = node as usize;
            let b = &self.bvh.bounds[6 * node..6 * node + 6];
            let (mut tmin, mut tmax) = (0.0f32, best_t);
            let mut miss = false;
            for a in 0..3 {
                // Axis-parallel ray: 0 * inf would give NaN exactly when the origin lies on a
                // node's boundary plane (the sphere's BVH splits at x = 0), so test directly.
                if d[a] == 0.0 {
                    if o[a] < b[a] || o[a] > b[3 + a] {
                        miss = true;
                        break;
                    }
                    continue;
                }
                let t1 = (b[a] - o[a]) * inv[a];
                let t2 = (b[3 + a] - o[a]) * inv[a];
                let (lo, hi) = if t1 < t2 { (t1, t2) } else { (t2, t1) };
                if lo > tmin {
                    tmin = lo;
                }
                if hi < tmax {
                    tmax = hi;
                }
                if tmin > tmax {
                    miss = true;
                    break;
                }
            }
            if miss {
                continue;
            }
            if self.bvh.is_leaf(node) {
                let leaf = self.bvh.node_a[node] as usize;
                for t in self.bvh.leaf_tri_off[leaf] as usize..self.bvh.leaf_tri_off[leaf + 1] as usize {
                    if let Some(h) = self.ray_tri(o, d, t) {
                        if h.t < best_t {
                            best_t = h.t;
                            best = Some(h);
                        }
                    }
                }
            } else {
                stack.push(self.bvh.node_b[node]);
                stack.push(self.bvh.node_a[node]);
            }
        }
        best
    }

    /// Möller–Trumbore, two-sided, with a small tolerance on the barycentric bounds: a ray
    /// through a shared vertex or edge would otherwise miss every adjacent triangle by
    /// rounding (a dropped stroke). Overlapping acceptance is harmless: the nearest t wins.
    fn ray_tri(&self, o: [f32; 3], d: [f32; 3], t: usize) -> Option<Hit> {
        const EPS: f32 = 1e-5;
        let a = get3(&self.positions, self.tris[3 * t] as usize);
        let b = get3(&self.positions, self.tris[3 * t + 1] as usize);
        let c = get3(&self.positions, self.tris[3 * t + 2] as usize);
        let e1 = sub(b, a);
        let e2 = sub(c, a);
        let p = cross(d, e2);
        let det = dot(e1, p);
        if det.abs() < 1e-12 {
            return None;
        }
        let inv_det = 1.0 / det;
        let s = sub(o, a);
        let u = dot(s, p) * inv_det;
        if !(-EPS..=1.0 + EPS).contains(&u) {
            return None;
        }
        let q = cross(s, e1);
        let v = dot(d, q) * inv_det;
        if v < -EPS || u + v > 1.0 + EPS {
            return None;
        }
        let tt = dot(e2, q) * inv_det;
        if tt <= 1e-7 {
            return None;
        }
        Some(Hit {
            tri: t as u32,
            t: tt,
            point: [o[0] + d[0] * tt, o[1] + d[1] * tt, o[2] + d[2] * tt],
            normal: normalize(cross(e1, e2)),
        })
    }

    /// FNV-1a over the position bits: the identity used by undo/recovery tests.
    pub fn position_hash(&self) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for &x in &self.positions {
            for byte in x.to_bits().to_le_bytes() {
                h ^= byte as u64;
                h = h.wrapping_mul(0x0100_0000_01b3);
            }
        }
        h
    }

    pub fn bounds(&self) -> ([f32; 3], [f32; 3]) {
        let b = &self.bvh.bounds;
        ([b[0], b[1], b[2]], [b[3], b[4], b[5]])
    }
}

struct PolyBuilder<'a> {
    cen: &'a [f32],
    poly_off: &'a [u32],
    order: Vec<u32>,
    node_a: Vec<u32>,
    node_b: Vec<u32>,
    leaf_node: Vec<u32>,
    leaf_poly_off: Vec<u32>,
    leaf_max: usize,
}

impl PolyBuilder<'_> {
    fn tris_in(&self, s: usize, e: usize) -> usize {
        self.order[s..e]
            .iter()
            .map(|&p| (self.poly_off[p as usize + 1] - self.poly_off[p as usize]) as usize)
            .sum()
    }

    fn split(&mut self, s: usize, e: usize) -> usize {
        let node = self.node_a.len();
        self.node_a.push(0);
        self.node_b.push(NONE);
        if e - s <= 1 || self.tris_in(s, e) <= self.leaf_max {
            self.node_a[node] = self.leaf_node.len() as u32;
            self.leaf_node.push(node as u32);
            self.leaf_poly_off.push(e as u32);
            return node;
        }
        let mut lo = [f32::INFINITY; 3];
        let mut hi = [f32::NEG_INFINITY; 3];
        for &p in &self.order[s..e] {
            let c = get3(self.cen, p as usize);
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
        let cen = self.cen;
        self.order[s..e].select_nth_unstable_by(mid - s, |&x, &y| {
            cen[3 * x as usize + axis].total_cmp(&cen[3 * y as usize + axis]).then(x.cmp(&y))
        });
        let l = self.split(s, mid);
        let r = self.split(mid, e);
        self.node_a[node] = l as u32;
        self.node_b[node] = r as u32;
        node
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sphere::cube_sphere;

    fn mesh(n: u32, leaf: usize) -> EditMesh {
        EditMesh::from_trimesh(cube_sphere(n), leaf)
    }

    #[test]
    fn leaves_own_contiguous_ranges_and_polygons_stay_whole() {
        let m = mesh(24, 64);
        assert_eq!(m.nowned, m.nverts());
        for leaf in 0..m.nleaves() {
            let (s, e) = m.leaf_range(leaf);
            for v in s..e {
                assert_eq!(m.leaf_of_vertex[v], leaf as u32);
            }
            // A leaf's triangle range starts at a polygon boundary.
            let t0 = m.bvh.leaf_tri_off[leaf] as usize;
            assert!(t0 == 0 || m.poly_next[t0 - 1] == 0, "leaf {leaf} splits a polygon");
        }
        // Still a closed manifold: every directed edge has its reverse.
        let mut edges = std::collections::HashSet::new();
        for t in m.tris.chunks(3) {
            for k in 0..3 {
                assert!(edges.insert((t[k], t[(k + 1) % 3])));
            }
        }
        for &(a, b) in &edges {
            assert!(edges.contains(&(b, a)));
        }
    }

    #[test]
    fn renumbering_preserves_geometry() {
        let src = cube_sphere(16);
        let m = EditMesh::from_trimesh(cube_sphere(16), 32);
        let area = |pos: &[f32], tris: &[u32]| -> f64 {
            tris.chunks(3)
                .map(|t| {
                    let (a, b, c) = (get3(pos, t[0] as usize), get3(pos, t[1] as usize), get3(pos, t[2] as usize));
                    let n = cross(sub(b, a), sub(c, a));
                    (dot(n, n) as f64).sqrt() * 0.5
                })
                .sum()
        };
        let a0 = area(&src.positions, &src.tris);
        let a1 = area(&m.positions, &m.tris);
        assert!((a0 - a1).abs() < 1e-6 * a0, "area changed: {a0} vs {a1}");
    }

    #[test]
    fn ray_through_a_vertex_still_hits() {
        // The +Z face center of an even cube-sphere is a vertex at (0, 0, 1).
        let m = mesh(32, 64);
        let h = m.raycast([0.0, 0.0, 3.0], [0.0, 0.0, -1.0]).expect("ray through a vertex missed");
        assert!((h.point[2] - 1.0).abs() < 1e-5);
        // And through an edge midpoint direction, from many angles.
        for k in 0..64 {
            let a = k as f32 * 0.098;
            let o = [3.0 * a.cos(), 0.0, 3.0 * a.sin()];
            assert!(m.raycast(o, normalize(sub([0.0, 0.0, 0.0], o))).is_some(), "miss at angle {a}");
        }
    }

    #[test]
    fn raycast_matches_brute_force() {
        let m = mesh(20, 48);
        let mut seed = 12345u32;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed as f32 / u32::MAX as f32 * 2.0 - 1.0
        };
        for _ in 0..200 {
            let o = [rnd() * 3.0, rnd() * 3.0, 3.0 + rnd()];
            let target = [rnd() * 0.8, rnd() * 0.8, rnd() * 0.8];
            let d = normalize(sub(target, o));
            let fast = m.raycast(o, d).map(|h| h.t);
            let mut brute: Option<f32> = None;
            for t in 0..m.ntris() {
                if let Some(h) = m.ray_tri(o, d, t) {
                    brute = Some(brute.map_or(h.t, |b: f32| b.min(h.t)));
                }
            }
            match (fast, brute) {
                (Some(a), Some(b)) => assert!((a - b).abs() < 1e-5, "{a} vs {b}"),
                (None, None) => {}
                other => panic!("mismatch {other:?}"),
            }
        }
    }
}
