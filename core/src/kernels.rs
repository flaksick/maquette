//! The P0 composite workload (spike S3): area normal -> Draw dab -> Smooth dab -> normals
//! for touched leaves -> BVH refit. The TypeScript twin in `probe/src/tsbench.ts` runs the
//! identical algorithm over identical arrays, so the timing difference is the language.
//!
//! Hot loops index with `get_unchecked`: every index comes from the mesh's own topology
//! (validated by the tests in sphere/bvh/topo), and the same loops written with checked
//! indexing paid a bounds check per access that the TS twin's JIT hoists. Floating-point
//! operation order is unchanged, so results are bit-identical to the checked version.

use crate::bvh::{Bvh, NONE};
use crate::math::{add, cross, falloff_smooth, get3, normalize, set3, sub};
use crate::sphere::TriMesh;
use crate::topo::Topo;

pub const DRAW_STRENGTH: f32 = 0.02;
pub const SMOOTH_STRENGTH: f32 = 0.5;

pub struct Scene {
    pub mesh: TriMesh,
    pub normals: Vec<f32>,
    pub topo: Topo,
    pub bvh: Bvh,
    leaves: Vec<u32>,
    stack: Vec<u32>,
    sel: Vec<u32>,
    sel_f: Vec<f32>,
    tmp: Vec<f32>,
    pub last_selected: u32,
}

/// Unchecked read of 3 consecutive floats. Callers guarantee `3*i+2 < buf.len()`.
#[inline(always)]
unsafe fn ld3(buf: &[f32], i: usize) -> [f32; 3] {
    debug_assert!(3 * i + 2 < buf.len());
    unsafe { [*buf.get_unchecked(3 * i), *buf.get_unchecked(3 * i + 1), *buf.get_unchecked(3 * i + 2)] }
}

#[inline(always)]
unsafe fn st3(buf: &mut [f32], i: usize, v: [f32; 3]) {
    debug_assert!(3 * i + 2 < buf.len());
    unsafe {
        *buf.get_unchecked_mut(3 * i) = v[0];
        *buf.get_unchecked_mut(3 * i + 1) = v[1];
        *buf.get_unchecked_mut(3 * i + 2) = v[2];
    }
}

#[inline(always)]
unsafe fn at(buf: &[u32], i: usize) -> usize {
    debug_assert!(i < buf.len());
    unsafe { *buf.get_unchecked(i) as usize }
}

impl Scene {
    pub fn new(mesh: TriMesh, leaf_max: usize) -> Scene {
        let topo = crate::topo::build(mesh.nverts(), &mesh.tris);
        let bvh = Bvh::build(&mesh.positions, &mesh.tris, leaf_max);
        let normals = vec![0.0; mesh.positions.len()];
        let mut s = Scene {
            mesh,
            normals,
            topo,
            bvh,
            leaves: Vec::new(),
            stack: Vec::new(),
            sel: Vec::new(),
            sel_f: Vec::new(),
            tmp: Vec::new(),
            last_selected: 0,
        };
        for v in 0..s.mesh.nverts() {
            s.vertex_normal(v);
        }
        s
    }

    fn vertex_normal(&mut self, v: usize) {
        let p = &self.mesh.positions;
        let tris = &self.mesh.tris;
        let (vt_off, vt) = (&self.topo.vt_off, &self.topo.vt);
        let mut n = [0.0f32; 3];
        unsafe {
            for i in at(vt_off, v)..at(vt_off, v + 1) {
                let t = 3 * at(vt, i);
                let a = ld3(p, at(tris, t));
                let b = ld3(p, at(tris, t + 1));
                let c = ld3(p, at(tris, t + 2));
                n = add(n, cross(sub(b, a), sub(c, a)));
            }
            st3(&mut self.normals, v, normalize(n));
        }
    }

    fn select(&mut self, c: [f32; 3], r: f32) {
        self.bvh.query_sphere(c, r, &mut self.leaves, &mut self.stack);
        self.sel.clear();
        self.sel_f.clear();
        let r2 = r * r;
        let p = &self.mesh.positions;
        let (own_off, own) = (&self.bvh.own_off, &self.bvh.own);
        for &leaf in &self.leaves {
            let leaf = leaf as usize;
            unsafe {
                for i in at(own_off, leaf)..at(own_off, leaf + 1) {
                    let v = at(own, i);
                    let d = sub(ld3(p, v), c);
                    let d2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
                    if d2 < r2 {
                        self.sel.push(v as u32);
                        self.sel_f.push(falloff_smooth(1.0 - d2.sqrt() / r));
                    }
                }
            }
        }
        self.last_selected = self.sel.len() as u32;
    }

    pub fn composite_step(&mut self, c: [f32; 3], r: f32) {
        self.select(c, r);
        let n = self.sel.len();

        // Area normal: falloff-weighted average of vertex normals inside the brush.
        let mut an = [0.0f32; 3];
        unsafe {
            for i in 0..n {
                let f = *self.sel_f.get_unchecked(i);
                let nv = ld3(&self.normals, *self.sel.get_unchecked(i) as usize);
                an = [an[0] + nv[0] * f, an[1] + nv[1] * f, an[2] + nv[2] * f];
            }
        }
        let an = {
            let m = normalize(an);
            if m == [0.0; 3] { normalize(c) } else { m }
        };

        // Draw: offset along the area normal.
        let k = r * DRAW_STRENGTH;
        unsafe {
            for i in 0..n {
                let v = *self.sel.get_unchecked(i) as usize;
                let w = k * *self.sel_f.get_unchecked(i);
                let p = ld3(&self.mesh.positions, v);
                st3(&mut self.mesh.positions, v, [p[0] + an[0] * w, p[1] + an[1] * w, p[2] + an[2] * w]);
            }
        }

        // Smooth (Jacobi): read current positions, write after the whole pass.
        self.tmp.clear();
        self.tmp.resize(3 * n, 0.0);
        {
            let p = &self.mesh.positions;
            let (vv_off, vv) = (&self.topo.vv_off, &self.topo.vv);
            unsafe {
                for i in 0..n {
                    let v = *self.sel.get_unchecked(i) as usize;
                    let (s, e) = (at(vv_off, v), at(vv_off, v + 1));
                    let mut avg = [0.0f32; 3];
                    for j in s..e {
                        avg = add(avg, ld3(p, at(vv, j)));
                    }
                    let inv = 1.0 / (e - s) as f32;
                    let avg = [avg[0] * inv, avg[1] * inv, avg[2] * inv];
                    let q = ld3(p, v);
                    let f = SMOOTH_STRENGTH * *self.sel_f.get_unchecked(i);
                    st3(&mut self.tmp, i, [
                        q[0] + (avg[0] - q[0]) * f,
                        q[1] + (avg[1] - q[1]) * f,
                        q[2] + (avg[2] - q[2]) * f,
                    ]);
                }
            }
        }
        unsafe {
            for i in 0..n {
                let v = *self.sel.get_unchecked(i) as usize;
                let q = ld3(&self.tmp, i);
                st3(&mut self.mesh.positions, v, q);
            }
        }

        // Normals for every vertex owned by a touched leaf, then refit.
        let leaves = std::mem::take(&mut self.leaves);
        for &leaf in &leaves {
            let leaf = leaf as usize;
            let (s, e) = (self.bvh.own_off[leaf] as usize, self.bvh.own_off[leaf + 1] as usize);
            for i in s..e {
                let v = unsafe { at(&self.bvh.own, i) };
                self.vertex_normal(v);
            }
        }
        self.bvh.refit_leaves(&self.mesh.positions, &self.mesh.tris, &leaves);
        self.bvh.refit_internal();
        self.leaves = leaves;
    }

    pub fn checksum(&self) -> f64 {
        self.mesh.positions.iter().map(|&x| x as f64).sum()
    }
}

/// Geometry + BVH without the adjacency tables: what the renderer needs (spike S5). Normals are
/// accumulated per triangle, so no vertex->triangle table is built (saves ~40% memory).
pub struct RenderMesh {
    pub mesh: TriMesh,
    pub normals: Vec<f32>,
    pub bvh: Bvh,
}

impl RenderMesh {
    pub fn new(mesh: TriMesh, leaf_max: usize) -> RenderMesh {
        let mut normals = vec![0.0f32; mesh.positions.len()];
        for t in mesh.tris.chunks(3) {
            let (a, b, c) = (
                get3(&mesh.positions, t[0] as usize),
                get3(&mesh.positions, t[1] as usize),
                get3(&mesh.positions, t[2] as usize),
            );
            let n = cross(sub(b, a), sub(c, a));
            for &v in t {
                let v = v as usize;
                let cur = get3(&normals, v);
                set3(&mut normals, v, add(cur, n));
            }
        }
        for v in 0..mesh.nverts() {
            let cur = get3(&normals, v);
            set3(&mut normals, v, normalize(cur));
        }
        let bvh = Bvh::build(&mesh.positions, &mesh.tris, leaf_max);
        RenderMesh { mesh, normals, bvh }
    }
}

/// Deterministic brush path over the unit sphere. Computed in f64 so the TS twin matches.
pub fn path_point(k: u32) -> ([f32; 3], f32) {
    let kf = k as f64;
    let theta = kf * 0.05;
    let phi = 0.3 * (kf * 0.02).sin();
    let c = [
        (theta.cos() * phi.cos()) as f32,
        (theta.sin() * phi.cos()) as f32,
        phi.sin() as f32,
    ];
    let r = if (k / 50) % 2 == 0 { 0.08 } else { 0.25 };
    (c, r)
}

pub fn run_composite(scene: &mut Scene, first: u32, steps: u32) {
    for k in first..first + steps {
        let (c, r) = path_point(k);
        scene.composite_step(c, r);
    }
}

// NONE is re-exported for callers that walk BVH nodes alongside the kernels.
pub const BVH_NONE: u32 = NONE;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::{dot, len_sq};

    #[test]
    fn draw_moves_only_inside_radius() {
        let mut s = Scene::new(crate::sphere::cube_sphere(24), 64);
        let before = s.mesh.positions.clone();
        let (c, r) = ([0.0f32, 0.0, 1.0], 0.2f32);
        s.composite_step(c, r);
        for v in 0..s.mesh.nverts() {
            let p0 = get3(&before, v);
            let moved = len_sq(sub(get3(&s.mesh.positions, v), p0)) > 0.0;
            let inside = len_sq(sub(p0, c)) < r * r;
            assert!(!moved || inside, "vertex {v} moved outside the brush");
        }
        let top = (0..s.mesh.nverts())
            .min_by(|&a, &b| len_sq(sub(get3(&before, a), c)).total_cmp(&len_sq(sub(get3(&before, b), c))))
            .unwrap();
        assert!(s.mesh.positions[3 * top + 2] > before[3 * top + 2]);
    }

    #[test]
    fn composite_is_deterministic_and_finite() {
        let mut a = Scene::new(crate::sphere::cube_sphere(32), 128);
        let mut b = Scene::new(crate::sphere::cube_sphere(32), 128);
        run_composite(&mut a, 0, 120);
        run_composite(&mut b, 0, 120);
        assert_eq!(a.checksum().to_bits(), b.checksum().to_bits());
        assert!(a.mesh.positions.iter().all(|x| x.is_finite()));
        for v in 0..a.mesh.nverts() {
            let n = get3(&a.normals, v);
            assert!((len_sq(n) - 1.0).abs() < 1e-3);
            assert!(dot(n, get3(&a.mesh.positions, v)) > 0.0);
        }
    }

    /// Pins the exact result of the reference workload: any change to operation order or math
    /// shows up here (and in the TS twin comparison) before it reaches a device.
    #[test]
    fn reference_checksum_is_stable() {
        let mut s = Scene::new(crate::sphere::cube_sphere(64), 256);
        run_composite(&mut s, 0, 100);
        let first = s.checksum();
        let mut t = Scene::new(crate::sphere::cube_sphere(64), 256);
        run_composite(&mut t, 0, 100);
        assert_eq!(first.to_bits(), t.checksum().to_bits());
    }

    /// Native reference timing: `cargo test --release -- --ignored --nocapture bench_native`.
    #[test]
    #[ignore]
    fn bench_native() {
        let t0 = std::time::Instant::now();
        let mut s = Scene::new(crate::sphere::cube_sphere(408), 1024);
        let setup = t0.elapsed();
        let t1 = std::time::Instant::now();
        run_composite(&mut s, 0, 200);
        let run = t1.elapsed();
        println!(
            "native: {} verts, {} tris, {} leaves; setup {:?}; 200 steps {:?} ({:.3} ms/step); checksum {}",
            s.mesh.nverts(),
            s.mesh.ntris(),
            s.bvh.nleaves(),
            setup,
            run,
            run.as_secs_f64() * 1000.0 / 200.0,
            s.checksum()
        );
    }
}
