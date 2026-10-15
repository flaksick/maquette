use super::shapes::{random_shape, Prim, Rng, Shape};
use super::validate::validate;
use super::*;
use crate::math::{len_sq, normalize};
use crate::sphere::{cube_sphere, TriMesh};
use std::collections::HashMap;
use std::time::Instant;

fn edit(m: TriMesh) -> EditMesh {
    EditMesh::from_trimesh(m, 256)
}

fn remesh(m: &EditMesh, p: Params) -> (EditMesh, Stats) {
    Job::new(m, p).unwrap().run(m).unwrap()
}

fn params_voxel(h: f32) -> Params {
    Params { voxel: h, leaf_max: 256, ..Default::default() }
}

/// A BVH over any triangle soup, fully built (for distance queries in tests).
fn full_bvh(src: &Src) -> CpBvh {
    let mut b = CpBvh::default();
    b.centroids(src, 0, src.ntris());
    b.start_split(src.ntris());
    while !b.split_step(&mut (1i64 << 40)) {}
    let mut cur = 0;
    while !b.refit_step(src, &mut cur, &mut (1i64 << 40)) {}
    b
}

/// Two-sided Hausdorff distance between the remesh and the analytic union's boundary, in voxels:
/// (union boundary -> output away from intersection creases, output -> union boundary, union
/// boundary -> output within 2 voxels of a crease). At a crease two primitives meet; where they
/// meet at a shallow angle the groove between them is narrower than a voxel near its bottom, and
/// a voxel remesh fills it, so the crease is reported separately.
fn hausdorff3(shape: &Shape, out: &EditMesh, h: f32) -> (f32, f32, f32) {
    let s = h / 4.0;
    let mut samples = Vec::new();
    let mut crease = Vec::new();
    for (i, p) in shape.prims.iter().enumerate() {
        let mut v = Vec::new();
        p.samples(s, &mut v);
        for q in v {
            if shape.sdf(q) >= -1e-4 {
                samples.push(q);
                crease.push(shape.prims.iter().enumerate().any(|(j, o)| j != i && o.sdf(q).abs() < 2.0 * h));
            }
        }
    }
    // union boundary -> output: exact closest point on the output mesh.
    let src = Src { pos: &out.positions, tris: &out.tris, xpos: &[], xtris: &[] };
    let bvh = full_bvh(&src);
    let (mut a, mut c) = (0.0f32, 0.0f32);
    for (k, &q) in samples.iter().enumerate() {
        let d = bvh.closest(&src, q, (20.0 * h) * (20.0 * h)).map_or(20.0 * h, |r| r.2.sqrt());
        if crease[k] {
            c = c.max(d);
        } else {
            a = a.max(d);
        }
    }
    // output -> union boundary: exact outside; inside, the best of the primitives' exterior
    // closest points and the nearest exterior sample (both upper bounds).
    let key = |p: [f32; 3]| ((p[0] / h).floor() as i32, (p[1] / h).floor() as i32, (p[2] / h).floor() as i32);
    let mut grid: HashMap<(i32, i32, i32), Vec<u32>> = HashMap::new();
    for (i, &q) in samples.iter().enumerate() {
        grid.entry(key(q)).or_default().push(i as u32);
    }
    let nearest = |p: [f32; 3]| -> f32 {
        let (kx, ky, kz) = key(p);
        let mut best = f32::INFINITY;
        for r in 1..=4 {
            for dx in -r..=r {
                for dy in -r..=r {
                    for dz in -r..=r {
                        if let Some(list) = grid.get(&(kx + dx, ky + dy, kz + dz)) {
                            for &i in list {
                                best = best.min(len_sq(sub(samples[i as usize], p)));
                            }
                        }
                    }
                }
            }
            if best.sqrt() <= r as f32 * h {
                break;
            }
        }
        best.sqrt()
    };
    let mut b = 0.0f32;
    let mut pts: Vec<[f32; 3]> = (0..out.nverts()).map(|v| get3(&out.positions, v)).collect();
    for t in out.tris.chunks_exact(3) {
        let (p0, p1, p2) = (get3(&out.positions, t[0] as usize), get3(&out.positions, t[1] as usize), get3(&out.positions, t[2] as usize));
        pts.push(scale(add(add(p0, p1), p2), 1.0 / 3.0));
    }
    for p in pts {
        let f = shape.sdf(p);
        let d = if f >= 0.0 {
            f
        } else {
            let mut d = nearest(p);
            for prim in &shape.prims {
                let c = prim.closest(p);
                if shape.sdf(c) >= -1e-4 {
                    d = d.min(len_sq(sub(c, p)).sqrt());
                }
            }
            d
        };
        b = b.max(d);
    }
    (a / h, b / h, c / h)
}

fn hausdorff(shape: &Shape, out: &EditMesh, h: f32) -> (f32, f32) {
    let (a, b, c) = hausdorff3(shape, out, h);
    (a.max(c), b)
}

#[test]
fn top1_builder_matches_from_trimesh() {
    for (mesh, leaf) in [(cube_sphere(20), 64usize), (super::shapes::concat(&[cube_sphere(7), cube_sphere(5)]), 32)] {
        let reference = EditMesh::from_trimesh(TriMesh { positions: mesh.positions.clone(), tris: mesh.tris.clone(), poly_next: mesh.poly_next.clone() }, leaf);
        let mut b = Builder::new(mesh.positions, mesh.tris, mesh.poly_next, leaf);
        let mut steps = 0;
        while !b.step(&mut 97) {
            steps += 1;
        }
        let m = b.take().unwrap();
        assert!(steps > 50, "the build must actually be sliced ({steps} steps)");
        assert_eq!(m.positions, reference.positions);
        assert_eq!(m.normals, reference.normals);
        assert_eq!(m.tris, reference.tris);
        assert_eq!(m.poly_next, reference.poly_next);
        assert_eq!((m.topo.vt_off.clone(), m.topo.vt.clone()), (reference.topo.vt_off.clone(), reference.topo.vt.clone()));
        assert_eq!((m.topo.vv_off.clone(), m.topo.vv.clone()), (reference.topo.vv_off.clone(), reference.topo.vv.clone()));
        assert_eq!(m.bvh.bounds, reference.bvh.bounds);
        assert_eq!((m.bvh.node_a.clone(), m.bvh.node_b.clone(), m.bvh.leaf_node.clone()), (reference.bvh.node_a.clone(), reference.bvh.node_b.clone(), reference.bvh.leaf_node.clone()));
        assert_eq!((m.bvh.leaf_tri_off.clone(), m.bvh.own_off.clone()), (reference.bvh.leaf_tri_off.clone(), reference.bvh.own_off.clone()));
        assert_eq!((m.leaf_of_vertex.clone(), m.leaf_of_tri.clone(), m.nowned), (reference.leaf_of_vertex.clone(), reference.leaf_of_tri.clone(), reference.nowned));
    }
}

#[test]
fn top1_topo_writer_matches_store() {
    let m = edit(cube_sphere(21));
    let mut w = serial::TopoWriter::new(&m);
    let mut steps = 0;
    while !w.step(&m, &mut 50) {
        steps += 1;
    }
    assert!(steps > 20);
    assert_eq!(w.out, crate::store::topo_bytes(&m));
    assert_eq!(w.out.len(), serial::topo_len(&m));
}

#[test]
fn top1_sphere_is_closed_outward_and_on_the_surface() {
    let src = edit(cube_sphere(48));
    let target = 20_000;
    let (m, st) = remesh(&src, Params { target_quads: target, leaf_max: 256, ..Default::default() });
    let r = validate(m.nverts(), &m.tris);
    println!("top1 sphere: {} quads (target {target}), h {:.4}, {:?}, bricks {}, flips {}", st.quads, st.h, r, st.bricks, st.flips);
    assert!(r.closed_manifold(), "{r:?}");
    assert_eq!((r.components, r.euler), (1, 2));
    assert_eq!(st.missing, 0);
    let ratio = st.quads as f32 / target as f32;
    assert!((0.9..1.1).contains(&ratio), "quad count {} vs target {target}", st.quads);
    // Every vertex on the input surface (chordal error of the 48-sphere is ~1e-4).
    let worst = (0..m.nverts()).map(|v| (len_sq(get3(&m.positions, v)).sqrt() - 1.0).abs()).fold(0.0f32, f32::max);
    assert!(worst < 2e-3, "vertex off the sphere by {worst}");
    // Outward winding: every triangle's normal points away from the centre.
    let inward = m.tris.chunks_exact(3).filter(|t| {
        let (a, b, c) = (get3(&m.positions, t[0] as usize), get3(&m.positions, t[1] as usize), get3(&m.positions, t[2] as usize));
        dot(cross(sub(b, a), sub(c, a)), add(add(a, b), c)) <= 0.0
    });
    assert_eq!(inward.count(), 0);
    // All quads: triangle pairs as in-order fans.
    for q in 0..m.ntris() / 2 {
        assert_eq!((m.poly_next[2 * q], m.poly_next[2 * q + 1]), (1, 0));
        assert_eq!(m.tris[6 * q], m.tris[6 * q + 3]);
        assert_eq!(m.tris[6 * q + 2], m.tris[6 * q + 4]);
    }
}

fn fuzz_part(part: u64, count: usize) -> (usize, f32, f32, f32, usize, usize) {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15 ^ (part + 1).wrapping_mul(0x2545_f491_4f6c_dd1d));
    let (mut worst_a, mut worst_b, mut worst_c, mut holed, mut flips) = (0.0f32, 0.0f32, 0.0f32, 0usize, 0usize);
    for i in 0..count {
        let shape = random_shape(&mut rng, false);
        let h = shape.min_feature / rng.range(3.0, 6.0);
        let src = edit(TriMesh { positions: shape.mesh.positions.clone(), tris: shape.mesh.tris.clone(), poly_next: shape.mesh.poly_next.clone() });
        let (m, st) = remesh(&src, params_voxel(h));
        let r = validate(m.nverts(), &m.tris);
        assert!(r.closed_manifold() && st.missing == 0, "part {part} shape {i}: {r:?} missing {} ({} prims, {} holes)", st.missing, shape.prims.len(), shape.holes);
        let (a, b, c) = hausdorff3(&shape, &m, h);
        assert!(a <= 1.0 && b <= 1.0, "part {part} shape {i}: Hausdorff {a:.3} / {b:.3} voxels ({:?})", shape.prims);
        assert!(c <= 4.0, "part {part} shape {i}: {c:.3} voxels at a crease ({:?})", shape.prims);
        worst_a = worst_a.max(a);
        worst_b = worst_b.max(b);
        worst_c = worst_c.max(c);
        holed += (shape.holes > 0) as usize;
        flips += st.flips as usize;
    }
    (count, worst_a, worst_b, worst_c, holed, flips)
}

macro_rules! fuzz_test {
    ($name:ident, $part:expr) => {
        #[test]
        fn $name() {
            let (n, a, b, c, holed, flips) = fuzz_part($part, 250);
            println!("top1 fuzz part {}: {n} shapes ({holed} holed), 0 boundary / 0 non-manifold; Hausdorff max {a:.3} (union->remesh) / {b:.3} (remesh->union) voxels, {c:.3} within 2 voxels of a crease; {flips} repair flips", $part);
        }
    };
}
fuzz_test!(top1_fuzz_watertight_manifold_hausdorff_1, 0);
fuzz_test!(top1_fuzz_watertight_manifold_hausdorff_2, 1);
fuzz_test!(top1_fuzz_watertight_manifold_hausdorff_3, 2);
fuzz_test!(top1_fuzz_watertight_manifold_hausdorff_4, 3);

#[test]
fn top1_fuzz_subvoxel_features_stay_closed_manifold() {
    let mut rng = Rng(0x51ed_270b_27f0_c3a1);
    let mut flips = 0;
    let n = 300;
    for i in 0..n {
        let shape = random_shape(&mut rng, true);
        // Voxel between 0.3x and 2x the thinnest feature: features vanish, merge, pinch.
        let h = shape.min_feature * rng.range(0.5, 3.0);
        let src = edit(TriMesh { positions: shape.mesh.positions.clone(), tris: shape.mesh.tris.clone(), poly_next: shape.mesh.poly_next.clone() });
        let (m, st) = remesh(&src, params_voxel(h));
        let r = validate(m.nverts(), &m.tris);
        assert!(r.closed_manifold() && st.missing == 0, "thin shape {i}: {r:?} missing {}", st.missing);
        flips += st.flips;
    }
    println!("top1 sub-voxel fuzz: {n} shapes, 0 boundary / 0 non-manifold edges / 0 non-manifold verts; {flips} repair flips");
}

#[test]
fn top1_fills_holes_and_merges_self_intersections() {
    // A sphere with a 3x3-quad patch removed: 1 hole, closed after remesh.
    let mut holed = cube_sphere(16);
    let quads: Vec<usize> = (0..3).flat_map(|u| (0..3).map(move |v| (4 + u) * 16 + 5 + v)).collect();
    super::shapes::punch(&mut holed, &quads);
    let before = validate(holed.nverts(), &holed.tris);
    assert!(before.boundary_edges > 0);
    let src = edit(holed);
    let (m, st) = remesh(&src, Params { target_quads: 6000, leaf_max: 256, ..Default::default() });
    let r = validate(m.nverts(), &m.tris);
    println!("top1 holes: input {} boundary edges -> output {r:?} ({} fans)", before.boundary_edges, st.holes);
    assert_eq!(st.holes, 1);
    assert!(r.closed_manifold() && r.components == 1 && r.euler == 2, "{r:?}");
    // Two overlapping spheres, each closed: one genus-0 surface, nothing left inside.
    let a = Prim::Sphere { c: [-0.3, 0.0, 0.0], r: 0.6 };
    let b = Prim::Sphere { c: [0.3, 0.1, 0.0], r: 0.5 };
    let shape = Shape { mesh: super::shapes::concat(&[a.mesh(16), b.mesh(16)]), prims: vec![a, b], holes: 0, min_feature: 1.0 };
    let src = edit(TriMesh { positions: shape.mesh.positions.clone(), tris: shape.mesh.tris.clone(), poly_next: shape.mesh.poly_next.clone() });
    let (m, st) = remesh(&src, Params { target_quads: 8000, leaf_max: 256, ..Default::default() });
    let r = validate(m.nverts(), &m.tris);
    let (ha, hb) = hausdorff(&shape, &m, st.h);
    println!("top1 self-intersection: {r:?}, Hausdorff {ha:.3}/{hb:.3} voxels");
    assert!(r.closed_manifold() && r.components == 1 && r.euler == 2, "{r:?}");
    let deepest = (0..m.nverts()).map(|v| shape.sdf(get3(&m.positions, v))).fold(0.0f32, f32::min);
    assert!(deepest > -st.h, "a vertex sits {deepest} inside the union: internal walls survived");
}

#[test]
fn top1_keep_sharp_preserves_box_corners() {
    let rot = super::shapes::random_rotation(&mut Rng(77));
    let bx = Prim::Box { c: [0.05, -0.02, 0.03], half: [0.5, 0.35, 0.42], rot };
    let shape = Shape { mesh: bx.mesh(12), prims: vec![bx], holes: 0, min_feature: 0.7 };
    let src = edit(TriMesh { positions: shape.mesh.positions.clone(), tris: shape.mesh.tris.clone(), poly_next: shape.mesh.poly_next.clone() });
    let corners: Vec<[f32; 3]> = (0..8u8)
        .map(|c| {
            let o = corner(c);
            let half = [0.5f32, 0.35, 0.42];
            let q = [half[0] * (2 * o[0] - 1) as f32, half[1] * (2 * o[1] - 1) as f32, half[2] * (2 * o[2] - 1) as f32];
            add([0.05, -0.02, 0.03], [dot(rot[0], q), dot(rot[1], q), dot(rot[2], q)])
        })
        .collect();
    let mut res = Vec::new();
    for sharp in [false, true] {
        let p = Params { target_quads: 3000, keep_sharp: sharp, leaf_max: 256, ..Default::default() };
        let (m, st) = remesh(&src, p);
        let r = validate(m.nverts(), &m.tris);
        assert!(r.closed_manifold(), "{r:?}");
        let s = Src { pos: &m.positions, tris: &m.tris, xpos: &[], xtris: &[] };
        let bvh = full_bvh(&s);
        let worst = corners.iter().map(|&c| bvh.closest(&s, c, 1.0).unwrap().2.sqrt()).fold(0.0f32, f32::max) / st.h;
        let (ha, hb) = hausdorff(&shape, &m, st.h);
        println!("top1 box corners (keep_sharp {sharp}): worst corner {worst:.3} voxels, {} pinned feature vertices, Hausdorff {ha:.3}/{hb:.3}", st.features);
        res.push(worst);
    }
    assert!(res[1] < 0.15, "keep-sharp corner error {} voxels", res[1]);
    assert!(res[1] < res[0] * 0.5, "keep-sharp must beat the plain remesh at corners: {res:?}");
}

#[test]
fn top1_sliced_job_matches_one_shot() {
    let src = edit(cube_sphere(30));
    let p = Params { target_quads: 9000, leaf_max: 256, ..Default::default() };
    let (one, _) = remesh(&src, p);
    let mut job = Job::new(&src, p).unwrap();
    let mut steps = 0;
    while !job.step(&src, 3000) {
        steps += 1;
        assert!(job.progress() >= 0.0 && job.progress() <= 1.0);
    }
    let sliced = job.result.unwrap();
    println!("top1 sliced: {steps} steps of 3000 units");
    assert!(steps > 100);
    assert_eq!(sliced.positions, one.positions);
    assert_eq!(sliced.tris, one.tris);
}

#[test]
fn top1_cancel_is_dropping_the_job() {
    let src = edit(cube_sphere(24));
    let h0 = src.position_hash();
    let mut job = Job::new(&src, Params::default()).unwrap();
    for _ in 0..10 {
        job.step(&src, 5000);
    }
    assert!(job.stage != Stage::Done);
    drop(job);
    assert_eq!(src.position_hash(), h0);
}

/// TOP-1 performance: the default sphere remeshed to 500k quads, natively, with the time and
/// memory of every stage. (Device timing comes from the app's diagnostics.)
#[test]
fn top1_500k_quads_timed() {
    let src = edit(cube_sphere(96));
    let target = 500_000;
    let p = Params { target_quads: target, leaf_max: 1024, ..Default::default() };
    let info = source_info(&src);
    let est = estimate(&info, p);
    let mut job = Job::new(&src, p).unwrap();
    let t0 = Instant::now();
    let mut times: Vec<(&str, f64)> = Vec::new();
    let mut stage = job.stage;
    let mut t = Instant::now();
    let mut max_step_ms = 0.0f64;
    let mut steps = 0;
    loop {
        let ts = Instant::now();
        let done = job.step(&src, 400_000);
        max_step_ms = max_step_ms.max(ts.elapsed().as_secs_f64() * 1e3);
        steps += 1;
        if job.stage != stage || done {
            times.push((stage.name(), t.elapsed().as_secs_f64() * 1e3));
            stage = job.stage;
            t = Instant::now();
        }
        if done {
            break;
        }
    }
    let total = t0.elapsed().as_secs_f64() * 1e3;
    let st = job.stats;
    let m = job.result.unwrap();
    let r = validate(m.nverts(), &m.tris);
    let mut by: Vec<(&str, f64)> = Vec::new();
    for (n, ms) in times {
        match by.iter_mut().find(|x| x.0 == n) {
            Some(x) => x.1 += ms,
            None => by.push((n, ms)),
        }
    }
    let mb = |b: u64| b as f64 / (1u64 << 20) as f64;
    println!(
        "top1 500k: {} quads in {total:.0} ms native ({steps} steps of 400k units, longest {max_step_ms:.1} ms); stages {}",
        st.quads,
        by.iter().map(|(n, ms)| format!("{n} {ms:.0}")).collect::<Vec<_>>().join(", ")
    );
    println!(
        "top1 500k memory: job peak {:.0} MB (estimate {:.0} MB transient), result mesh {:.0} MB (estimate {:.0} MB steady incl. engine+GPU), undo snapshot {:.0} MB; bricks {} (estimate {})",
        mb(st.peak_bytes),
        mb(est.transient_bytes),
        mb(mesh_bytes(&m) as u64),
        mb(est.steady_bytes),
        mb(est.undo_bytes),
        st.bricks,
        est.bricks
    );
    assert!(r.closed_manifold(), "{r:?}");
    let ratio = st.quads as f64 / target as f64;
    assert!((0.9..1.1).contains(&ratio), "{} quads", st.quads);
    assert!(total < 4000.0, "500k-quad remesh took {total:.0} ms natively");
    assert!(est.transient_bytes >= st.peak_bytes, "estimate below the measured peak");
}

#[test]
fn top1_estimate_bounds_actual() {
    let mut rng = Rng(4242);
    let mut cases: Vec<(EditMesh, Params)> = Vec::new();
    for target in [2_000u32, 30_000, 120_000] {
        cases.push((edit(cube_sphere(40)), Params { target_quads: target, leaf_max: 256, ..Default::default() }));
    }
    for _ in 0..20 {
        let s = random_shape(&mut rng, false);
        cases.push((edit(s.mesh), Params { target_quads: 1000 + (rng.next() % 20_000) as u32, leaf_max: 256, ..Default::default() }));
    }
    let mut worst_ratio = 0.0f64;
    let (mut brick_ratio, mut brick_add) = (0.0f64, f64::NEG_INFINITY);
    for (src, p) in &cases {
        let est = estimate(&source_info(src), *p);
        let (m, st) = remesh(src, *p);
        assert!(est.transient_bytes >= st.peak_bytes, "transient estimate {} < measured {}", est.transient_bytes, st.peak_bytes);
        assert!(est.bricks >= st.bricks as u64, "brick estimate {} < {}", est.bricks, st.bricks);
        assert!(est.steady_bytes >= mesh_bytes(&m) as u64);
        assert!(est.quads as f64 >= 0.9 * st.quads as f64, "quad estimate {} vs {}", est.quads, st.quads);
        worst_ratio = worst_ratio.max(est.transient_bytes as f64 / st.peak_bytes as f64);
        let surf = source_info(src).s1 / (64.0 * (st.h as f64).powi(2));
        brick_ratio = brick_ratio.max(st.bricks as f64 / surf.max(1.0));
        brick_add = brick_add.max(st.bricks as f64 - 1.2 * surf);
    }
    println!("top1 estimate: {} cases, transient estimate / measured peak <= {worst_ratio:.2}; bricks / (S1/(8h)^2) <= {brick_ratio:.2}, bricks - 1.2 S1/(8h)^2 <= {brick_add:.0}", cases.len());
}

#[allow(dead_code)]
fn unit(v: [f32; 3]) -> [f32; 3] {
    normalize(v)
}
