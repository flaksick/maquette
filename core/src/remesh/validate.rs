//! Mesh validator (SPEC universal gate: "mesh validator passes after every operation in tests").
//! Counts, never a yes/no: boundary edges (1 triangle), non-manifold edges (3+ triangles),
//! inconsistently oriented edges (2 triangles walking it the same way), non-manifold vertices
//! (the triangles around a vertex form more than one fan), degenerate triangles (a repeated
//! corner), connected components and the Euler characteristic.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub boundary_edges: usize,
    pub nonmanifold_edges: usize,
    pub inconsistent_edges: usize,
    pub nonmanifold_verts: usize,
    pub degenerate_tris: usize,
    pub components: usize,
    pub euler: i64,
}

impl Report {
    /// Closed, oriented 2-manifold (what the remesher must produce).
    pub fn closed_manifold(&self) -> bool {
        self.boundary_edges == 0 && self.nonmanifold_edges == 0 && self.inconsistent_edges == 0 && self.nonmanifold_verts == 0 && self.degenerate_tris == 0
    }
}

fn find(p: &mut [u32], mut x: u32) -> u32 {
    while p[x as usize] != x {
        let up = p[p[x as usize] as usize];
        p[x as usize] = up;
        x = up;
    }
    x
}

fn union(p: &mut [u32], a: u32, b: u32) {
    let (ra, rb) = (find(p, a), find(p, b));
    if ra != rb {
        p[ra.max(rb) as usize] = ra.min(rb);
    }
}

pub fn validate(nverts: usize, tris: &[u32]) -> Report {
    let ntri = tris.len() / 3;
    let mut r = Report::default();
    // (undirected key, forward?, corner of the edge's first vertex)
    let mut edges: Vec<(u64, u32)> = Vec::with_capacity(tris.len());
    // A slot whose three corners are equal is a dead dyntopo slot (TOP-3), not a triangle.
    let live = |t: usize| !(tris[3 * t] == tris[3 * t + 1] && tris[3 * t + 1] == tris[3 * t + 2]);
    for t in 0..ntri {
        let c = &tris[3 * t..3 * t + 3];
        if !live(t) {
            continue;
        }
        if c[0] == c[1] || c[1] == c[2] || c[0] == c[2] {
            r.degenerate_tris += 1;
        }
        for k in 0..3 {
            let (a, b) = (c[k], c[(k + 1) % 3]);
            let (lo, hi, fwd) = if a < b { (a, b, 1u32) } else { (b, a, 0u32) };
            // payload: corner index (3t+k) << 1 | direction
            edges.push(((lo as u64) << 32 | hi as u64, ((3 * t + k) as u32) << 1 | fwd));
        }
    }
    edges.sort_unstable();
    // Corner union-find: corners of one vertex joined across manifold edges = fans.
    let mut corner: Vec<u32> = (0..tris.len() as u32).collect();
    let mut tri_parent: Vec<u32> = (0..ntri as u32).collect();
    let mut nedges = 0i64;
    let mut i = 0;
    while i < edges.len() {
        let mut j = i + 1;
        while j < edges.len() && edges[j].0 == edges[i].0 {
            j += 1;
        }
        nedges += 1;
        let count = j - i;
        for k in i + 1..j {
            union(&mut tri_parent, (edges[i].1 >> 1) / 3, (edges[k].1 >> 1) / 3);
        }
        match count {
            1 => r.boundary_edges += 1,
            2 => {
                let (e0, e1) = (edges[i].1, edges[i + 1].1);
                if e0 & 1 == e1 & 1 {
                    r.inconsistent_edges += 1;
                }
                // Corner k of triangle t starts edge (tris[3t+k], tris[3t+k+1]).
                let (c0, c1) = (e0 >> 1, e1 >> 1);
                let next = |c: u32| (c / 3) * 3 + (c % 3 + 1) % 3;
                // Match corners at the same vertex.
                let (a0, b0) = (c0, next(c0));
                let (a1, b1) = (c1, next(c1));
                if tris[a0 as usize] == tris[a1 as usize] {
                    union(&mut corner, a0, a1);
                    union(&mut corner, b0, b1);
                } else {
                    union(&mut corner, a0, b1);
                    union(&mut corner, b0, a1);
                }
            }
            _ => r.nonmanifold_edges += 1,
        }
        i = j;
    }
    // Fans per vertex.
    let mut root_of_vertex = vec![u32::MAX; nverts];
    let mut bad = vec![false; nverts];
    let mut used = vec![false; nverts];
    for c in 0..tris.len() as u32 {
        if !live(c as usize / 3) {
            continue;
        }
        let v = tris[c as usize] as usize;
        used[v] = true;
        let root = find(&mut corner, c);
        if root_of_vertex[v] == u32::MAX {
            root_of_vertex[v] = root;
        } else if root_of_vertex[v] != root {
            bad[v] = true;
        }
    }
    r.nonmanifold_verts = bad.iter().filter(|&&b| b).count();
    let mut roots = 0;
    for t in 0..ntri as u32 {
        if live(t as usize) && find(&mut tri_parent, t) == t {
            roots += 1;
        }
    }
    r.components = roots;
    let ntri = (0..ntri).filter(|&t| live(t)).count();
    let v = used.iter().filter(|&&u| u).count() as i64;
    r.euler = v - nedges + ntri as i64;
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sphere::cube_sphere;

    #[test]
    fn top1_validator_counts_known_defects() {
        let s = cube_sphere(6);
        let ok = validate(s.nverts(), &s.tris);
        assert!(ok.closed_manifold(), "{ok:?}");
        assert_eq!((ok.components, ok.euler), (1, 2));
        // Drop one triangle: 3 boundary edges.
        let holed = &s.tris[3..];
        let r = validate(s.nverts(), holed);
        assert_eq!(r.boundary_edges, 3);
        // Duplicate a triangle reversed: 3 non-manifold edges... (each edge now has 3 users).
        let mut dup = s.tris.clone();
        dup.extend_from_slice(&[s.tris[0], s.tris[2], s.tris[1]]);
        assert_eq!(validate(s.nverts(), &dup).nonmanifold_edges, 3);
        // Flip one triangle: its 3 edges become inconsistent.
        let mut flip = s.tris.clone();
        flip.swap(1, 2);
        assert_eq!(validate(s.nverts(), &flip).inconsistent_edges, 3);
        // Two spheres glued at one shared vertex: one non-manifold vertex.
        let n = s.nverts() as u32;
        let mut two = s.tris.clone();
        let v0 = s.tris[0];
        two.extend(s.tris.iter().map(|&v| if v == v0 { v0 } else { v + n }));
        let r = validate(2 * s.nverts(), &two);
        assert_eq!((r.nonmanifold_verts, r.boundary_edges, r.nonmanifold_edges), (1, 0, 0), "{r:?}");
    }
}
