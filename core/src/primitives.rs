//! Primitives besides the quad sphere (PRM-2): cube, cylinder, cone, torus, plane, capsule,
//! icosphere. Each is built from one resolution parameter `n`, sized like the sphere (it fits
//! [-1, 1]^3, +Y up), stored as in-order fan polygon runs (quads where the shape allows: only
//! poles, the cone's apex and the icosphere are triangles), outward-wound and watertight except
//! the plane, whose border is its boundary.
//!
//! Cylinder, cone and capsule are lathes: a profile from the bottom pole to the top pole, turned
//! around Y in `n` segments. A ring next to a pole closes with triangles; rings meet with quads.
//! Ring spacing follows the arc spacing (2π/n per segment), so quads stay close to square.
//! `counts` gives the exact vertex/face numbers up front (the app's slider and pre-flight use the
//! same formulas, app/src/primitives.ts).

use crate::sphere::TriMesh;
use std::f64::consts::{PI, TAU};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Primitive {
    Cube = 1,
    Cylinder = 2,
    Cone = 3,
    Torus = 4,
    Plane = 5,
    Capsule = 6,
    Icosphere = 7,
}

pub const ALL: [Primitive; 7] = [Primitive::Cube, Primitive::Cylinder, Primitive::Cone, Primitive::Torus, Primitive::Plane, Primitive::Capsule, Primitive::Icosphere];

impl Primitive {
    pub fn from_u32(k: u32) -> Option<Primitive> {
        ALL.iter().copied().find(|p| *p as u32 == k)
    }
}

/// Exact sizes of a primitive: vertices, quads, triangle faces (non-quad polygons), triangles.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Counts {
    pub verts: usize,
    pub quads: usize,
    pub tri_faces: usize,
    pub tris: usize,
}

fn round(x: f64) -> usize {
    x.round().max(0.0) as usize
}

/// Lathe ring counts (rings that aren't poles) for cylinder, cone and capsule.
fn rings(kind: Primitive, n: usize) -> usize {
    let n = n as f64;
    match kind {
        Primitive::Cylinder => 2 * round(n / TAU).max(1) + round(n / PI).max(1) - 1,
        Primitive::Cone => round(n / TAU).max(1) + round(5f64.sqrt() * n / TAU).max(1) - 1,
        Primitive::Capsule => 2 * round(n / 4.0).max(2) + round(n / PI).max(1) - 1,
        _ => unreachable!(),
    }
}

/// Smallest and largest useful resolutions (the budget pre-flight decides what actually fits).
pub fn clamp(kind: Primitive, n: u32) -> usize {
    let (lo, hi) = match kind {
        Primitive::Cube => (1, 1024),
        Primitive::Plane => (1, 2048),
        Primitive::Icosphere => (0, 10),
        Primitive::Torus => (6, 4096),
        _ => (6, 4096),
    };
    (n as usize).clamp(lo, hi)
}

pub fn counts(kind: Primitive, n: u32) -> Counts {
    let n = clamp(kind, n);
    match kind {
        Primitive::Cube => Counts { verts: 6 * n * n + 2, quads: 6 * n * n, tri_faces: 0, tris: 12 * n * n },
        Primitive::Plane => Counts { verts: (n + 1) * (n + 1), quads: n * n, tri_faces: 0, tris: 2 * n * n },
        Primitive::Torus => {
            let m = round(n as f64 / 3.0).max(3);
            Counts { verts: n * m, quads: n * m, tri_faces: 0, tris: 2 * n * m }
        }
        Primitive::Icosphere => {
            let f = 20 * 4usize.pow(n as u32);
            Counts { verts: f / 2 + 2, quads: 0, tri_faces: f, tris: f }
        }
        _ => {
            let k = rings(kind, n);
            Counts { verts: k * n + 2, quads: (k - 1) * n, tri_faces: 2 * n, tris: 2 * k * n }
        }
    }
}

/// Fan polygon runs under construction.
struct Out {
    positions: Vec<f32>,
    tris: Vec<u32>,
    poly_next: Vec<u8>,
}

impl Out {
    fn new(c: Counts) -> Out {
        Out { positions: Vec::with_capacity(3 * c.verts), tris: Vec::with_capacity(3 * c.tris), poly_next: Vec::with_capacity(c.tris) }
    }
    fn v(&mut self, p: [f64; 3]) -> u32 {
        self.positions.extend(p.iter().map(|&x| x as f32));
        (self.positions.len() / 3 - 1) as u32
    }
    /// A quad as the fan (a, b, c), (a, c, d).
    fn quad(&mut self, a: u32, b: u32, c: u32, d: u32) {
        self.tris.extend_from_slice(&[a, b, c, a, c, d]);
        self.poly_next.extend_from_slice(&[1, 0]);
    }
    fn tri(&mut self, a: u32, b: u32, c: u32) {
        self.tris.extend_from_slice(&[a, b, c]);
        self.poly_next.push(0);
    }
    fn done(self) -> TriMesh {
        TriMesh { positions: self.positions, tris: self.tris, poly_next: self.poly_next }
    }
}

pub fn build(kind: Primitive, n: u32) -> TriMesh {
    let c = counts(kind, n);
    let n = clamp(kind, n);
    let mut o = Out::new(c);
    match kind {
        Primitive::Cube => cube(&mut o, n),
        Primitive::Plane => plane(&mut o, n),
        Primitive::Torus => torus(&mut o, n),
        Primitive::Icosphere => icosphere(&mut o, n),
        Primitive::Cylinder => {
            let (r, h) = (round(n as f64 / TAU).max(1), round(n as f64 / PI).max(1));
            let mut prof: Vec<(f64, f64)> = (1..=r).map(|k| (k as f64 / r as f64, -1.0)).collect();
            prof.extend((1..=h).map(|k| (1.0, -1.0 + 2.0 * k as f64 / h as f64)));
            prof.extend((1..r).rev().map(|k| (k as f64 / r as f64, 1.0)));
            lathe(&mut o, n, (-1.0, 1.0), &prof);
        }
        Primitive::Cone => {
            let (r, h) = (round(n as f64 / TAU).max(1), round(5f64.sqrt() * n as f64 / TAU).max(1));
            let mut prof: Vec<(f64, f64)> = (1..=r).map(|k| (k as f64 / r as f64, -1.0)).collect();
            prof.extend((1..h).map(|k| (1.0 - k as f64 / h as f64, -1.0 + 2.0 * k as f64 / h as f64)));
            lathe(&mut o, n, (-1.0, 1.0), &prof);
        }
        Primitive::Capsule => {
            let (q, h) = (round(n as f64 / 4.0).max(2), round(n as f64 / PI).max(1));
            let arc = |phi: f64, y0: f64| (0.5 * phi.cos(), y0 + 0.5 * phi.sin());
            let mut prof: Vec<(f64, f64)> = (1..=q).map(|k| arc(-PI / 2.0 + PI / 2.0 * k as f64 / q as f64, -0.5)).collect();
            prof.extend((1..=h).map(|k| (0.5, -0.5 + k as f64 / h as f64)));
            prof.extend((1..q).map(|k| arc(PI / 2.0 * k as f64 / q as f64, 0.5)));
            lathe(&mut o, n, (-1.0, 1.0), &prof);
        }
    }
    let m = o.done();
    debug_assert_eq!((m.nverts(), m.ntris()), (c.verts, c.tris));
    m
}

/// Profile (radius, y) from just above the bottom pole to just below the top pole, turned around
/// Y in `n` segments. Winding: bottom -> out -> up -> in -> top is counter-clockwise in the
/// (r, y) half-plane, which makes every face point outward.
fn lathe(o: &mut Out, n: usize, poles: (f64, f64), prof: &[(f64, f64)]) {
    let bottom = o.v([0.0, poles.0, 0.0]);
    let first = o.positions.len() as u32 / 3;
    for &(r, y) in prof {
        for j in 0..n {
            let t = TAU * j as f64 / n as f64;
            o.v([r * t.cos(), y, r * t.sin()]);
        }
    }
    let top = o.v([0.0, poles.1, 0.0]);
    let at = |i: usize, j: usize| first + (i * n + j % n) as u32;
    for j in 0..n {
        o.tri(bottom, at(0, j), at(0, j + 1));
    }
    for i in 0..prof.len() - 1 {
        for j in 0..n {
            o.quad(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
        }
    }
    let last = prof.len() - 1;
    for j in 0..n {
        o.tri(at(last, j), top, at(last, j + 1));
    }
}

/// [-1, 1]^3 with `n` quads along each edge: the cube-sphere's lattice, unprojected.
fn cube(o: &mut Out, n: usize) {
    let mut id = std::collections::HashMap::new();
    let s = 2.0 / n as f64;
    for a in 0..3 {
        for side in [0, n] {
            let lattice = |u: usize, v: usize| {
                let mut c = [0usize; 3];
                c[a] = side;
                c[(a + 1) % 3] = u;
                c[(a + 2) % 3] = v;
                c
            };
            let mut vid = |c: [usize; 3], o: &mut Out| *id.entry(c).or_insert_with(|| o.v([c[0] as f64 * s - 1.0, c[1] as f64 * s - 1.0, c[2] as f64 * s - 1.0]));
            for u in 0..n {
                for v in 0..n {
                    let qa = vid(lattice(u, v), o);
                    let qb = vid(lattice(u + 1, v), o);
                    let qc = vid(lattice(u + 1, v + 1), o);
                    let qd = vid(lattice(u, v + 1), o);
                    // (u,v) -> (u+1,v) -> (u+1,v+1) winds around +e_a: the positive side keeps it.
                    if side == n { o.quad(qa, qb, qc, qd) } else { o.quad(qa, qd, qc, qb) }
                }
            }
        }
    }
}

/// 2 x 2 in the XZ plane at y = 0, facing +Y: the one open primitive.
fn plane(o: &mut Out, n: usize) {
    let s = 2.0 / n as f64;
    for i in 0..=n {
        for k in 0..=n {
            o.v([i as f64 * s - 1.0, 0.0, k as f64 * s - 1.0]);
        }
    }
    let at = |i: usize, k: usize| (i * (n + 1) + k) as u32;
    for i in 0..n {
        for k in 0..n {
            o.quad(at(i, k), at(i, k + 1), at(i + 1, k + 1), at(i + 1, k));
        }
    }
}

/// Ring radius 0.75, tube radius 0.25 (fits the unit view), `n` around and n/3 across.
fn torus(o: &mut Out, n: usize) {
    let m = round(n as f64 / 3.0).max(3);
    for i in 0..n {
        let u = TAU * i as f64 / n as f64;
        for j in 0..m {
            let v = TAU * j as f64 / m as f64;
            let r = 0.75 + 0.25 * v.cos();
            o.v([r * u.cos(), 0.25 * v.sin(), r * u.sin()]);
        }
    }
    let at = |i: usize, j: usize| ((i % n) * m + j % m) as u32;
    for i in 0..n {
        for j in 0..m {
            o.quad(at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i + 1, j));
        }
    }
}

/// Unit icosahedron subdivided `level` times (each triangle -> 4, midpoints on the sphere).
fn icosphere(o: &mut Out, level: usize) {
    let t = (1.0 + 5f64.sqrt()) / 2.0;
    let base = [[-1.0, t, 0.0], [1.0, t, 0.0], [-1.0, -t, 0.0], [1.0, -t, 0.0], [0.0, -1.0, t], [0.0, 1.0, t], [0.0, -1.0, -t], [0.0, 1.0, -t], [t, 0.0, -1.0], [t, 0.0, 1.0], [-t, 0.0, -1.0], [-t, 0.0, 1.0]];
    let unit = |p: [f64; 3]| {
        let l = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
        [p[0] / l, p[1] / l, p[2] / l]
    };
    let mut pos: Vec<[f64; 3]> = base.iter().map(|&p| unit(p)).collect();
    let mut faces: Vec<[u32; 3]> = vec![
        [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
        [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];
    for _ in 0..level {
        let mut mid = std::collections::HashMap::new();
        let mut next = Vec::with_capacity(faces.len() * 4);
        for f in &faces {
            let mut m = [0u32; 3];
            for k in 0..3 {
                let (a, b) = (f[k], f[(k + 1) % 3]);
                m[k] = *mid.entry((a.min(b), a.max(b))).or_insert_with(|| {
                    let (p, q) = (pos[a as usize], pos[b as usize]);
                    pos.push(unit([p[0] + q[0], p[1] + q[1], p[2] + q[2]]));
                    (pos.len() - 1) as u32
                });
            }
            next.extend_from_slice(&[[f[0], m[0], m[2]], [f[1], m[1], m[0]], [f[2], m[2], m[1]], [m[0], m[1], m[2]]]);
        }
        faces = next;
    }
    for p in pos {
        o.v(p);
    }
    for f in faces {
        o.tri(f[0], f[1], f[2]);
    }
}

/// Builds a primitive and makes it the engine's mesh (`kind` = `Primitive` code). Returns 1, or
/// 0 for an unknown kind.
#[unsafe(no_mangle)]
pub extern "C" fn eng_new_primitive(kind: u32, n: u32, leaf_max: u32) -> u32 {
    let Some(k) = Primitive::from_u32(kind) else { return 0 };
    crate::abi::install_mesh(crate::mesh::EditMesh::from_trimesh(build(k, n), leaf_max.max(16) as usize));
    1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::check;
    use crate::mesh::EditMesh;

    /// Volume x 6 (positive = outward).
    fn volume6(m: &TriMesh) -> f64 {
        let p = |v: u32| [0, 1, 2].map(|k| m.positions[3 * v as usize + k] as f64);
        m.tris
            .chunks(3)
            .map(|t| {
                let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
                a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])
            })
            .sum()
    }

    /// Validator, counts, quads, boundary, orientation and size, at a few resolutions.
    fn gate(kind: Primitive, ns: &[u32], boundary: impl Fn(usize) -> u32) {
        for &n in ns {
            let m = build(kind, n);
            let c = counts(kind, n);
            let chk = check(m.nverts(), &m.tris, &m.poly_next);
            assert!(chk.valid(), "{kind:?} n={n}: {chk:?}");
            assert_eq!((m.nverts(), m.ntris()), (c.verts, c.tris), "{kind:?} n={n}");
            // Quads are runs of two triangles; the rest are single triangles.
            let runs = m.poly_next.iter().filter(|&&p| p == 0).count();
            let quads = m.poly_next.iter().filter(|&&p| p == 1).count();
            assert_eq!((quads, runs - quads), (c.quads, c.tri_faces), "{kind:?} n={n}");
            assert_eq!(chk.boundary_edges, boundary(clamp(kind, n)), "{kind:?} n={n}");
            assert_eq!(chk.components, 1, "{kind:?} n={n}");
            if kind != Primitive::Plane {
                assert!(volume6(&m) > 0.0, "{kind:?} n={n} faces inward");
            }
            let b = crate::io::bbox(&m.positions);
            assert!(b.iter().all(|x| x.abs() <= 1.0 + 1e-6), "{kind:?} n={n} outside [-1, 1]^3: {b:?}");
            // And as the engine's mesh: polygon runs survive, OBJ export keeps the quads.
            let e = EditMesh::from_trimesh(m, 64);
            let mut out = Vec::new();
            let st = crate::objio::write_obj(&e, &mut out);
            assert_eq!(st.faces, c.quads + c.tri_faces, "{kind:?} n={n} OBJ faces");
        }
    }

    #[test]
    fn prm2_cube_all_quads_watertight() {
        gate(Primitive::Cube, &[1, 2, 7, 64], |_| 0);
        assert_eq!(counts(Primitive::Cube, 64), Counts { verts: 24_578, quads: 24_576, tri_faces: 0, tris: 49_152 });
    }

    #[test]
    fn prm2_cylinder_quads_with_triangle_poles_watertight() {
        gate(Primitive::Cylinder, &[6, 8, 33, 256], |_| 0);
        // 256 segments: 41 cap rings, 81 side rings -> 162 rings.
        assert_eq!(counts(Primitive::Cylinder, 256), Counts { verts: 41_474, quads: 41_216, tri_faces: 512, tris: 82_944 });
    }

    #[test]
    fn prm2_cone_quads_with_triangle_apex_watertight() {
        gate(Primitive::Cone, &[6, 8, 33, 256], |_| 0);
    }

    #[test]
    fn prm2_torus_all_quads_watertight() {
        gate(Primitive::Torus, &[6, 9, 64, 256], |_| 0);
        assert_eq!(counts(Primitive::Torus, 256).quads, 256 * 85);
    }

    #[test]
    fn prm2_plane_all_quads_with_boundary() {
        gate(Primitive::Plane, &[1, 2, 16, 128], |n| 4 * n as u32);
    }

    #[test]
    fn prm2_capsule_quads_with_triangle_poles_watertight() {
        gate(Primitive::Capsule, &[6, 8, 33, 256], |_| 0);
    }

    #[test]
    fn prm2_icosphere_triangles_on_the_unit_sphere() {
        gate(Primitive::Icosphere, &[0, 1, 3, 5], |_| 0);
        let m = build(Primitive::Icosphere, 4);
        for p in m.positions.chunks(3) {
            let r = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
            assert!((r - 1.0).abs() < 1e-6, "radius {r}");
        }
        assert_eq!(counts(Primitive::Icosphere, 5), Counts { verts: 10_242, quads: 0, tri_faces: 20_480, tris: 20_480 });
    }

    #[test]
    fn prm2_abi_installs_each_primitive() {
        for k in ALL {
            assert_eq!(eng_new_primitive(k as u32, 8, 64), 1);
            let c = counts(k, 8);
            assert_eq!(crate::abi::with_engine(|e| (e.mesh.nverts(), e.mesh.ntris())), Some((c.verts, c.tris)), "{k:?}");
        }
        assert_eq!(eng_new_primitive(99, 8, 64), 0);
    }
}
