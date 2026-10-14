//! TOP-1 fuzz shapes: unions of spheres, capsules and boxes (closed lattice meshes with exact
//! signed distance functions), deliberately overlapping (self-intersecting input) and with
//! holes punched out of some primitives. The analytic union is the reference surface for the
//! Hausdorff measurements: the remesher must reproduce the union's boundary, not the input's
//! buried internal walls.

use crate::math::{add, cross, dot, len_sq, normalize, scale, sub};
use crate::sphere::TriMesh;

pub struct Rng(pub u64);
impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    pub fn f(&mut self) -> f32 {
        (self.next() >> 40) as f32 / (1u64 << 24) as f32
    }
    pub fn range(&mut self, a: f32, b: f32) -> f32 {
        a + (b - a) * self.f()
    }
}

#[derive(Clone, Copy, Debug)]
pub enum Prim {
    Sphere { c: [f32; 3], r: f32 },
    Capsule { c: [f32; 3], half_len: f32, r: f32, rot: [[f32; 3]; 3] },
    Box { c: [f32; 3], half: [f32; 3], rot: [[f32; 3]; 3] },
}

fn mul(r: &[[f32; 3]; 3], v: [f32; 3]) -> [f32; 3] {
    [dot(r[0], v), dot(r[1], v), dot(r[2], v)]
}
fn mul_t(r: &[[f32; 3]; 3], v: [f32; 3]) -> [f32; 3] {
    [r[0][0] * v[0] + r[1][0] * v[1] + r[2][0] * v[2], r[0][1] * v[0] + r[1][1] * v[1] + r[2][1] * v[2], r[0][2] * v[0] + r[1][2] * v[1] + r[2][2] * v[2]]
}

pub fn random_rotation(rng: &mut Rng) -> [[f32; 3]; 3] {
    // Random unit quaternion -> matrix.
    let (u1, u2, u3) = (rng.f(), rng.f() * std::f32::consts::TAU, rng.f() * std::f32::consts::TAU);
    let (a, b) = ((1.0 - u1).sqrt(), u1.sqrt());
    let (x, y, z, w) = (a * u2.sin(), a * u2.cos(), b * u3.sin(), b * u3.cos());
    [
        [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - z * w), 2.0 * (x * z + y * w)],
        [2.0 * (x * y + z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - x * w)],
        [2.0 * (x * z - y * w), 2.0 * (y * z + x * w), 1.0 - 2.0 * (x * x + y * y)],
    ]
}

fn spherify(p: [f32; 3]) -> [f32; 3] {
    let (x2, y2, z2) = (p[0] * p[0], p[1] * p[1], p[2] * p[2]);
    normalize([
        p[0] * (1.0 - y2 / 2.0 - z2 / 2.0 + y2 * z2 / 3.0).max(0.0).sqrt(),
        p[1] * (1.0 - z2 / 2.0 - x2 / 2.0 + z2 * x2 / 3.0).max(0.0).sqrt(),
        p[2] * (1.0 - x2 / 2.0 - y2 / 2.0 + x2 * y2 / 3.0).max(0.0).sqrt(),
    ])
}

impl Prim {
    pub fn sdf(&self, p: [f32; 3]) -> f32 {
        match *self {
            Prim::Sphere { c, r } => len_sq(sub(p, c)).sqrt() - r,
            Prim::Capsule { c, half_len, r, rot } => {
                let q = mul_t(&rot, sub(p, c));
                let y = q[1].clamp(-half_len, half_len);
                len_sq(sub(q, [0.0, y, 0.0])).sqrt() - r
            }
            Prim::Box { c, half, rot } => {
                let q = mul_t(&rot, sub(p, c));
                let d = [q[0].abs() - half[0], q[1].abs() - half[1], q[2].abs() - half[2]];
                let out = len_sq([d[0].max(0.0), d[1].max(0.0), d[2].max(0.0)]).sqrt();
                out + d[0].max(d[1]).max(d[2]).min(0.0)
            }
        }
    }

    /// Closest point on this primitive's surface.
    pub fn closest(&self, p: [f32; 3]) -> [f32; 3] {
        match *self {
            Prim::Sphere { c, r } => add(c, scale(normalize(sub(p, c)), r)),
            Prim::Capsule { c, half_len, r, rot } => {
                let q = mul_t(&rot, sub(p, c));
                let s = [0.0, q[1].clamp(-half_len, half_len), 0.0];
                add(c, mul(&rot, add(s, scale(normalize(sub(q, s)), r))))
            }
            Prim::Box { c, half, rot } => {
                let mut q = mul_t(&rot, sub(p, c));
                let inside = (0..3).all(|k| q[k].abs() <= half[k]);
                if inside {
                    let k = (0..3).min_by(|&a, &b| (half[a] - q[a].abs()).total_cmp(&(half[b] - q[b].abs()))).unwrap();
                    q[k] = half[k] * if q[k] < 0.0 { -1.0 } else { 1.0 };
                } else {
                    for k in 0..3 {
                        q[k] = q[k].clamp(-half[k], half[k]);
                    }
                }
                add(c, mul(&rot, q))
            }
        }
    }

    /// The smallest feature size (thickness) of the primitive.
    pub fn min_feature(&self) -> f32 {
        match *self {
            Prim::Sphere { r, .. } | Prim::Capsule { r, .. } => 2.0 * r,
            Prim::Box { half, .. } => 2.0 * half[0].min(half[1]).min(half[2]),
        }
    }

    /// Closed lattice mesh with `n` quads per cube edge (6n^2 quads).
    pub fn mesh(&self, n: u32) -> TriMesh {
        let map = |x: [f32; 3]| -> [f32; 3] {
            match *self {
                Prim::Sphere { c, r } => add(c, scale(spherify(x), r)),
                Prim::Capsule { c, half_len, r, rot } => {
                    let mut s = scale(spherify(x), r);
                    s[1] += if x[1] >= 0.0 { half_len } else { -half_len };
                    add(c, mul(&rot, s))
                }
                Prim::Box { c, half, rot } => add(c, mul(&rot, [x[0] * half[0], x[1] * half[1], x[2] * half[2]])),
            }
        };
        lattice(n, map)
    }

    /// Points on the surface, about `s` apart.
    pub fn samples(&self, s: f32, out: &mut Vec<[f32; 3]>) {
        match *self {
            Prim::Sphere { c, r } => fib(c, r, s, |_| true, 0.0, &[[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]], out),
            Prim::Capsule { c, half_len, r, rot } => {
                fib(c, r, s, |p| p[1] >= 0.0, half_len, &rot, &mut *out);
                fib(c, r, s, |p| p[1] < 0.0, -half_len, &rot, &mut *out);
                let rings = ((2.0 * half_len) / s).ceil().max(1.0) as usize;
                let around = ((std::f32::consts::TAU * r) / s).ceil().max(3.0) as usize;
                for i in 0..=rings {
                    let y = -half_len + 2.0 * half_len * i as f32 / rings as f32;
                    for j in 0..around {
                        let a = std::f32::consts::TAU * j as f32 / around as f32;
                        out.push(add(c, mul(&rot, [r * a.cos(), y, r * a.sin()])));
                    }
                }
            }
            Prim::Box { c, half, rot } => {
                for a in 0..3 {
                    let (b, d) = ((a + 1) % 3, (a + 2) % 3);
                    let (nb, nd) = (((2.0 * half[b]) / s).ceil().max(1.0) as usize, ((2.0 * half[d]) / s).ceil().max(1.0) as usize);
                    for side in [-1.0f32, 1.0] {
                        for i in 0..=nb {
                            for j in 0..=nd {
                                let mut q = [0.0f32; 3];
                                q[a] = side * half[a];
                                q[b] = -half[b] + 2.0 * half[b] * i as f32 / nb as f32;
                                q[d] = -half[d] + 2.0 * half[d] * j as f32 / nd as f32;
                                out.push(add(c, mul(&rot, q)));
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Fibonacci-sphere samples of radius r around the local origin, filtered, shifted along local y
/// and rotated/translated (for capsule caps), else plain.
fn fib(c: [f32; 3], r: f32, s: f32, keep: impl Fn([f32; 3]) -> bool, shift_y: f32, rot: &[[f32; 3]; 3], out: &mut Vec<[f32; 3]>) {
    let n = ((4.0 * std::f32::consts::PI * r * r) / (s * s)).ceil().max(8.0) as usize;
    let golden = std::f32::consts::PI * (3.0 - 5f32.sqrt());
    for i in 0..n {
        let y = 1.0 - 2.0 * (i as f32 + 0.5) / n as f32;
        let rad = (1.0 - y * y).max(0.0).sqrt();
        let th = golden * i as f32;
        let p = [r * rad * th.cos(), r * y, r * rad * th.sin()];
        if !keep(p) {
            continue;
        }
        let q = [p[0], p[1] + shift_y, p[2]];
        out.push(add(c, mul(rot, q)));
    }
}

fn lattice_id(c: [u32; 3], n: u32) -> u32 {
    let on = |x: u32| x == 0 || x == n;
    let nb = on(c[0]) as u32 + on(c[1]) as u32 + on(c[2]) as u32;
    let m = n - 1;
    match nb {
        3 => (c[0] == n) as u32 | ((c[1] == n) as u32) << 1 | ((c[2] == n) as u32) << 2,
        2 => {
            let a = (0..3).find(|&a| !on(c[a])).unwrap();
            let edge = a as u32 * 4 + ((c[(a + 1) % 3] == n) as u32) * 2 + (c[(a + 2) % 3] == n) as u32;
            8 + edge * m + (c[a] - 1)
        }
        _ => {
            let a = (0..3).find(|&a| on(c[a])).unwrap();
            let face = a as u32 * 2 + (c[a] == n) as u32;
            8 + 12 * m + face * m * m + (c[(a + 1) % 3] - 1) * m + (c[(a + 2) % 3] - 1)
        }
    }
}

/// Closed quad lattice on the cube [-1,1]^3 mapped through `map` (the cube-sphere construction).
pub fn lattice(n: u32, map: impl Fn([f32; 3]) -> [f32; 3]) -> TriMesh {
    let nv = (6 * n * n + 2) as usize;
    let mut positions = vec![0.0f32; nv * 3];
    let mut tris = Vec::new();
    let mut poly_next = Vec::new();
    let inv = 2.0 / n as f32;
    for a in 0..3usize {
        for side in [0u32, n] {
            let lat = |u: u32, v: u32| {
                let mut c = [0u32; 3];
                c[a] = side;
                c[(a + 1) % 3] = u;
                c[(a + 2) % 3] = v;
                c
            };
            for u in 0..=n {
                for v in 0..=n {
                    let c = lat(u, v);
                    let id = lattice_id(c, n) as usize;
                    let p = map([c[0] as f32 * inv - 1.0, c[1] as f32 * inv - 1.0, c[2] as f32 * inv - 1.0]);
                    positions[3 * id..3 * id + 3].copy_from_slice(&p);
                }
            }
            for u in 0..n {
                for v in 0..n {
                    let qa = lattice_id(lat(u, v), n);
                    let qb = lattice_id(lat(u + 1, v), n);
                    let qc = lattice_id(lat(u + 1, v + 1), n);
                    let qd = lattice_id(lat(u, v + 1), n);
                    if side == n {
                        tris.extend_from_slice(&[qa, qb, qc, qa, qc, qd]);
                    } else {
                        tris.extend_from_slice(&[qa, qd, qc, qa, qc, qb]);
                    }
                    poly_next.extend_from_slice(&[1, 0]);
                }
            }
        }
    }
    TriMesh { positions, tris, poly_next }
}

/// Concatenates meshes (no welding: the parts overlap and intersect each other).
pub fn concat(parts: &[TriMesh]) -> TriMesh {
    let mut out = TriMesh { positions: Vec::new(), tris: Vec::new(), poly_next: Vec::new() };
    for p in parts {
        let base = (out.positions.len() / 3) as u32;
        out.positions.extend_from_slice(&p.positions);
        out.tris.extend(p.tris.iter().map(|&v| v + base));
        out.poly_next.extend_from_slice(&p.poly_next);
    }
    out
}

/// Removes quads (both triangles of each run) by index: punches holes.
pub fn punch(m: &mut TriMesh, quads: &[usize]) {
    let mut drop = vec![false; m.tris.len() / 6];
    for &q in quads {
        if q < drop.len() {
            drop[q] = true;
        }
    }
    let mut tris = Vec::new();
    let mut pn = Vec::new();
    for (q, d) in drop.iter().enumerate() {
        if !d {
            tris.extend_from_slice(&m.tris[6 * q..6 * q + 6]);
            pn.extend_from_slice(&[1, 0]);
        }
    }
    m.tris = tris;
    m.poly_next = pn;
}

pub struct Shape {
    pub prims: Vec<Prim>,
    pub mesh: TriMesh,
    pub holes: usize,
    pub min_feature: f32,
}

impl Shape {
    pub fn sdf(&self, p: [f32; 3]) -> f32 {
        self.prims.iter().map(|q| q.sdf(p)).fold(f32::INFINITY, f32::min)
    }
}

/// A random union. `thin` makes some primitives sub-voxel-thin for robustness runs.
pub fn random_shape(rng: &mut Rng, thin: bool) -> Shape {
    let k = 1 + (rng.next() % 4) as usize;
    let mut prims = Vec::new();
    for _ in 0..k {
        let c = [rng.range(-0.5, 0.5), rng.range(-0.5, 0.5), rng.range(-0.5, 0.5)];
        let small = if thin && rng.f() < 0.5 { 0.12 } else { 1.0 };
        let p = match rng.next() % 3 {
            0 => Prim::Sphere { c, r: rng.range(0.25, 0.6) * small },
            1 => Prim::Capsule { c, half_len: rng.range(0.1, 0.5), r: rng.range(0.15, 0.4) * small, rot: random_rotation(rng) },
            _ => Prim::Box { c, half: [rng.range(0.15, 0.5) * small, rng.range(0.15, 0.5), rng.range(0.15, 0.5)], rot: random_rotation(rng) },
        };
        prims.push(p);
    }
    let mut holes = 0;
    let parts: Vec<TriMesh> = prims
        .iter()
        .map(|p| {
            let n = 10 + (rng.next() % 8) as u32;
            let mut m = p.mesh(n);
            if rng.f() < 0.3 {
                // One quad, or a 2x2 patch, on a random face.
                let face = (rng.next() % 6) as usize;
                let (u, v) = ((rng.next() % (n as u64 - 1)) as usize, (rng.next() % (n as u64 - 1)) as usize);
                let q = |du: usize, dv: usize| (face * n as usize + u + du) * n as usize + v + dv;
                if rng.f() < 0.5 {
                    punch(&mut m, &[q(0, 0)]);
                } else {
                    punch(&mut m, &[q(0, 0), q(1, 0), q(0, 1), q(1, 1)]);
                }
                holes += 1;
            }
            m
        })
        .collect();
    let min_feature = prims.iter().map(|p| p.min_feature()).fold(f32::INFINITY, f32::min);
    Shape { prims, mesh: concat(&parts), holes, min_feature }
}

#[allow(dead_code)]
pub fn normal_of(a: [f32; 3], b: [f32; 3], c: [f32; 3]) -> [f32; 3] {
    normalize(cross(sub(b, a), sub(c, a)))
}
