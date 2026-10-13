//! All-quad cube-sphere (feature PRM-1). Quads are stored as triangle pairs, and
//! `poly_next[t] == 1` marks "triangle t and t+1 belong to the same polygon".
//!
//! Vertices live on the boundary of the integer lattice [0,n]^3. Each boundary point gets
//! exactly one id: 8 corners, then 12 edges x (n-1) interior points, then 6 faces x (n-1)^2
//! interior points. Total 6n^2 + 2, shared edges welded by construction.

use crate::math::{normalize, set3};

pub struct TriMesh {
    pub positions: Vec<f32>,
    pub tris: Vec<u32>,
    pub poly_next: Vec<u8>,
}

impl TriMesh {
    pub fn nverts(&self) -> usize {
        self.positions.len() / 3
    }
    pub fn ntris(&self) -> usize {
        self.tris.len() / 3
    }
}

fn vertex_id(c: [u32; 3], n: u32) -> u32 {
    let on = |x: u32| x == 0 || x == n;
    let nb = on(c[0]) as u32 + on(c[1]) as u32 + on(c[2]) as u32;
    let m = n - 1;
    match nb {
        3 => (c[0] == n) as u32 | ((c[1] == n) as u32) << 1 | ((c[2] == n) as u32) << 2,
        2 => {
            // The varying axis is the one not on the boundary.
            let a = (0..3).find(|&a| !on(c[a])).unwrap();
            let b1 = (c[(a + 1) % 3] == n) as u32;
            let b2 = (c[(a + 2) % 3] == n) as u32;
            let edge = a as u32 * 4 + b1 * 2 + b2;
            8 + edge * m + (c[a] - 1)
        }
        1 => {
            let a = (0..3).find(|&a| on(c[a])).unwrap();
            let face = a as u32 * 2 + (c[a] == n) as u32;
            let u = c[(a + 1) % 3];
            let v = c[(a + 2) % 3];
            8 + 12 * m + face * m * m + (u - 1) * m + (v - 1)
        }
        _ => unreachable!("lattice point is not on the cube boundary"),
    }
}

/// Spherified-cube mapping: more uniform quads than plain normalization.
fn spherify(x: f32, y: f32, z: f32) -> [f32; 3] {
    let (x2, y2, z2) = (x * x, y * y, z * z);
    let sx = x * (1.0 - y2 / 2.0 - z2 / 2.0 + y2 * z2 / 3.0).max(0.0).sqrt();
    let sy = y * (1.0 - z2 / 2.0 - x2 / 2.0 + z2 * x2 / 3.0).max(0.0).sqrt();
    let sz = z * (1.0 - x2 / 2.0 - y2 / 2.0 + x2 * y2 / 3.0).max(0.0).sqrt();
    normalize([sx, sy, sz])
}

/// Unit-radius cube-sphere with `n` quads along each cube edge: 6n^2 quads, 12n^2 triangles.
pub fn cube_sphere(n: u32) -> TriMesh {
    assert!(n >= 1);
    let nv = (6 * n * n + 2) as usize;
    let mut positions = vec![0.0f32; nv * 3];
    let mut tris = Vec::with_capacity((12 * n * n * 3) as usize);
    let mut poly_next = Vec::with_capacity((12 * n * n) as usize);
    let inv = 2.0 / n as f32;

    for a in 0..3usize {
        for side in [0u32, n] {
            let lattice = |u: u32, v: u32| {
                let mut c = [0u32; 3];
                c[a] = side;
                c[(a + 1) % 3] = u;
                c[(a + 2) % 3] = v;
                c
            };
            for u in 0..=n {
                for v in 0..=n {
                    let c = lattice(u, v);
                    let id = vertex_id(c, n) as usize;
                    let p = spherify(
                        c[0] as f32 * inv - 1.0,
                        c[1] as f32 * inv - 1.0,
                        c[2] as f32 * inv - 1.0,
                    );
                    set3(&mut positions, id, p);
                }
            }
            // (u,v) -> (u+1,v) -> (u+1,v+1) winds around +e_a, so the positive face keeps it.
            let positive = side == n;
            for u in 0..n {
                for v in 0..n {
                    let qa = vertex_id(lattice(u, v), n);
                    let qb = vertex_id(lattice(u + 1, v), n);
                    let qc = vertex_id(lattice(u + 1, v + 1), n);
                    let qd = vertex_id(lattice(u, v + 1), n);
                    if positive {
                        tris.extend_from_slice(&[qa, qb, qc, qa, qc, qd]);
                    } else {
                        tris.extend_from_slice(&[qa, qc, qb, qa, qd, qc]);
                    }
                    poly_next.extend_from_slice(&[1, 0]);
                }
            }
        }
    }
    TriMesh { positions, tris, poly_next }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::{cross, dot, get3, sub};
    use std::collections::HashMap;

    #[test]
    fn counts_match_formula() {
        for n in [1u32, 2, 3, 7, 16] {
            let m = cube_sphere(n);
            assert_eq!(m.nverts(), (6 * n * n + 2) as usize);
            assert_eq!(m.ntris(), (12 * n * n) as usize);
        }
    }

    #[test]
    fn closed_oriented_manifold_genus0() {
        let m = cube_sphere(9);
        // Every directed edge appears exactly once and its reverse exactly once.
        let mut directed: HashMap<(u32, u32), u32> = HashMap::new();
        for t in m.tris.chunks(3) {
            for k in 0..3 {
                *directed.entry((t[k], t[(k + 1) % 3])).or_default() += 1;
            }
        }
        for (&(a, b), &count) in &directed {
            assert_eq!(count, 1, "directed edge {a}->{b} repeated");
            assert_eq!(directed.get(&(b, a)), Some(&1), "edge {a}-{b} is a boundary or flipped");
        }
        let e = directed.len() / 2;
        let euler = m.nverts() as i64 - e as i64 + m.ntris() as i64;
        assert_eq!(euler, 2);
    }

    #[test]
    fn on_unit_sphere_and_outward() {
        let m = cube_sphere(12);
        for i in 0..m.nverts() {
            let r = crate::math::len_sq(get3(&m.positions, i)).sqrt();
            assert!((r - 1.0).abs() < 1e-5, "vertex {i} radius {r}");
        }
        for t in m.tris.chunks(3) {
            let (a, b, c) = (
                get3(&m.positions, t[0] as usize),
                get3(&m.positions, t[1] as usize),
                get3(&m.positions, t[2] as usize),
            );
            let nrm = cross(sub(b, a), sub(c, a));
            assert!(dot(nrm, a) > 0.0, "inward-facing triangle");
        }
    }
}
