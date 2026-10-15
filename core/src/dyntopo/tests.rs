use super::*;
use crate::history::LeafStates;
use crate::remesh::validate::{validate, Report};
use crate::sphere::cube_sphere;

pub fn live_tris(m: &EditMesh) -> usize {
    (0..m.ntris()).filter(|&t| !is_dead(m, t)).count()
}

pub fn dyn_sphere(n: u32, leaf: usize) -> (EditMesh, DynState) {
    let m = relayout(&EditMesh::from_trimesh(cube_sphere(n), leaf), 2.0, leaf);
    let mut st = DynState { on: true, ..Default::default() };
    scan_free(&m, &mut st);
    (m, st)
}

/// Adjacency must equal a from-scratch rebuild (as sets per vertex).
pub fn adjacency_consistent(m: &EditMesh) -> bool {
    let mut fresh = EditMesh {
        positions: Vec::new(),
        normals: Vec::new(),
        tris: m.tris.clone(),
        poly_next: Vec::new(),
        topo: Default::default(),
        bvh: Bvh { bounds: vec![], node_a: vec![], node_b: vec![], leaf_node: vec![], leaf_tri_off: m.bvh.leaf_tri_off.clone(), tri_order: vec![], own_off: m.bvh.own_off.clone(), own: vec![] },
        leaf_of_vertex: vec![],
        leaf_of_tri: m.leaf_of_tri.clone(),
        nowned: m.nowned,
    };
    fresh.positions = m.positions.clone();
    make_dynamic(&mut fresh);
    (0..m.nverts()).all(|v| {
        let mut a = m.topo.vtris(v).to_vec();
        let mut b = fresh.topo.vtris(v).to_vec();
        a.sort_unstable();
        b.sort_unstable();
        let mut c = m.topo.vverts(v).to_vec();
        let mut d = fresh.topo.vverts(v).to_vec();
        c.sort_unstable();
        d.sort_unstable();
        a == b && c == d
    })
}

pub fn check(m: &EditMesh) -> Report {
    validate(m.nverts(), &m.tris)
}

#[test]
fn top3_relayout_keeps_geometry_and_adds_slack() {
    let src = EditMesh::from_trimesh(cube_sphere(20), 128);
    let (m, st) = dyn_sphere(20, 128);
    let r = check(&m);
    assert!(r.closed_manifold() && r.euler == 2, "{r:?}");
    assert_eq!(live_tris(&m), src.ntris());
    assert!(m.ntris() >= 2 * src.ntris() && m.nverts() >= 2 * src.nverts());
    let free_t: usize = st.tfree.iter().map(|f| f.len()).sum();
    assert_eq!(free_t, m.ntris() - src.ntris());
    assert!(adjacency_consistent(&m));
    // Same surface: every source vertex position exists in the new layout.
    let mut a: Vec<[u32; 3]> = (0..src.nverts()).map(|v| get3(&src.positions, v).map(f32::to_bits)).collect();
    let mut b: Vec<[u32; 3]> = (0..m.nverts()).filter(|&v| !m.topo.vtris(v).is_empty()).map(|v| get3(&m.positions, v).map(f32::to_bits)).collect();
    a.sort_unstable();
    b.sort_unstable();
    assert_eq!(a, b);
}

#[test]
fn top3_refine_and_coarsen_stay_closed_manifold() {
    let (mut m, mut st) = dyn_sphere(12, 128);
    let n0 = live_tris(&m);
    let mut tx = Transaction::new(m.nleaves());
    let mut modified = StampSet::new(m.nverts());
    let mut seed = 0x1234_5678u64;
    let mut rnd = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed >> 40) as f32 / (1u64 << 24) as f32
    };
    let (mut splits, mut collapses, mut relayouts) = (0, 0, 0);
    for i in 0..60 {
        if st.starved {
            // What the worker does after a starved stroke: more slack.
            m = relayout(&m, 2.0, 128);
            st = DynState { on: true, ..Default::default() };
            scan_free(&m, &mut st);
            tx = Transaction::new(m.nleaves());
            modified = StampSet::new(m.nverts());
            relayouts += 1;
        }
        tx.topo = true;
        tx.begin();
        let c = normalize([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]);
        // First refine (small max edge), then coarsen (large max edge).
        let lmax = if i < 40 { 0.04 + 0.05 * rnd() } else { 0.4 + 0.3 * rnd() };
        let (s, k) = update_region(&mut m, &mut st, &mut tx, &mut modified, c, 0.3 + 0.2 * rnd(), lmax);
        splits += s;
        collapses += k;
        let r = check(&m);
        assert!(r.closed_manifold() && r.components == 1 && r.euler == 2, "after dab {i}: {r:?}");
        if i % 10 == 0 {
            assert!(adjacency_consistent(&m), "adjacency drift after dab {i}");
        }
        if i == 39 {
            assert!(live_tris(&m) > 2 * n0, "refinement must add triangles: {} vs {n0}", live_tris(&m));
        }
    }
    assert!(adjacency_consistent(&m));
    println!("top3 ops: {splits} splits, {collapses} collapses, {relayouts} relayouts; {} -> {} live triangles", n0, live_tris(&m));
    assert!(splits > 1000 && collapses > 100);
}

#[test]
fn top3_slab_states_restore_exactly() {
    let (mut m, mut st) = dyn_sphere(12, 128);
    let mut tx = Transaction::new(m.nleaves());
    let mut modified = StampSet::new(m.nverts());
    let h0 = m.position_hash();
    let t0 = m.tris.clone();
    tx.topo = true;
    tx.begin();
    for k in 0..5 {
        let c = normalize([0.3 * k as f32, 1.0, 0.2]);
        update_region(&mut m, &mut st, &mut tx, &mut modified, c, 0.4, 0.05);
    }
    let before = std::mem::take(&mut tx.before);
    let after = LeafStates::capture_topo(&m, &before.leaves);
    let (h1, t1) = (m.position_hash(), m.tris.clone());
    assert_ne!(t1, t0);
    before.restore(&mut m);
    assert_eq!((m.position_hash(), &m.tris), (h0, &t0));
    assert!(adjacency_consistent(&m) && check(&m).closed_manifold());
    after.restore(&mut m);
    assert_eq!((m.position_hash(), &m.tris), (h1, &t1));
    assert!(adjacency_consistent(&m) && check(&m).closed_manifold());
}

// ------------------------------------------------------------------ engine level

use crate::engine::{tests_support, Engine, Tool};
use crate::gpu::Gpu;
use crate::history::apply_record;
use crate::store;

fn tri_hash(m: &EditMesh) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &x in &m.tris {
        h ^= x as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

fn state(e: &Engine) -> (u64, u64) {
    (e.mesh.position_hash(), tri_hash(&e.mesh))
}

/// What the worker does when dyntopo is turned on: relayout, then ready the engine.
fn dyn_engine(mesh: EditMesh, leaf: usize, slack: f32) -> Engine {
    let mut e = Engine::new(relayout(&mesh, slack, leaf));
    enable(&mut e);
    e
}

fn enable(e: &mut Engine) {
    e.cam = tests_support::camera([0.0, 0.2, 3.0], 600.0, 600.0);
    e.dyn_topo.on = true;
    e.dyn_topo.detail = Detail { mode: DetailMode::Brush, value: 30.0 };
    if !e.mesh.topo.is_dynamic() {
        make_dynamic(&mut e.mesh);
    }
    scan_free(&e.mesh, &mut e.dyn_topo);
    e.gpu = Gpu::build_limit(&e.mesh, super::abi::DYN_PAGE_VERTS);
}

fn stroke(e: &mut Engine, x: f32, y: f32, dx: f32, dy: f32, n: usize) -> usize {
    e.stroke_begin(x, y, 1.0);
    let samples: Vec<f32> = (1..=n).flat_map(|i| [x + dx * i as f32, y + dy * i as f32, 0.9]).collect();
    e.stroke_move(&samples);
    let len = e.stroke_end();
    e.frame_update();
    len
}

#[test]
fn top3_und1_stroke_refines_and_undo_redo_are_exact() {
    let mut e = dyn_engine(EditMesh::from_trimesh(cube_sphere(16), 256), 256, 2.0);
    e.brush.tool = Tool::Draw;
    e.brush.radius_px = 80.0;
    let t0 = live_tris(&e.mesh);
    let s0 = state(&e);
    assert!(stroke(&mut e, 260.0, 280.0, 6.0, 2.0, 12) > 0);
    let t1 = live_tris(&e.mesh);
    let s1 = state(&e);
    let r = check(&e.mesh);
    println!("top3 stroke: {t0} -> {t1} live triangles ({} splits, {} collapses), {r:?}", e.dyn_topo.splits, e.dyn_topo.collapses);
    assert!(t1 > t0 + 100, "dyntopo stroke must add triangles: {t0} -> {t1}");
    assert!(r.closed_manifold() && r.euler == 2);
    assert!(e.undo() > 0);
    assert_eq!(state(&e), s0, "undo restores the exact pre-stroke positions and triangles");
    assert!(check(&e.mesh).closed_manifold() && adjacency_consistent(&e.mesh));
    assert!(e.redo() > 0);
    assert_eq!(state(&e), s1);
    assert!(check(&e.mesh).closed_manifold() && adjacency_consistent(&e.mesh));
    // GPU pages reproduce the live triangles after the topology frames.
    let n = e.frame_update();
    let _ = n;
    let drawn: usize = e.gpu.pages.iter().map(|p| p.nindices as usize / 3).sum();
    assert_eq!(drawn, e.mesh.ntris(), "every slot (dead ones degenerate) is in a page's index buffer");
}

/// TOP-3 acceptance fuzz: dyntopo strokes (any brush, any detail), undo, redo, full saves and
/// simulated kills (the journal torn at a random byte, then recovery = load the last save +
/// replay every intact record). After every op the validator must pass, and every recovery must
/// equal the state after the last complete record.
fn fuzz(seed: u64, ops: usize) -> (usize, usize, usize, usize) {
    let mut seed = seed;
    let mut rnd = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let mut e = dyn_engine(EditMesh::from_trimesh(cube_sphere(10), 128), 128, 2.0);
    let mut save = (store::topo_bytes(&e.mesh), store::positions_bytes(&e.mesh));
    let mut journal: Vec<u8> = Vec::new();
    let mut ends: Vec<(usize, (u64, u64))> = vec![(0, state(&e))];
    let (mut kills, mut failures, mut relayouts, mut strokes) = (0, 0, 0, 0);
    let tools = [Tool::Draw, Tool::Smooth, Tool::Draw, Tool::Inflate, Tool::Flatten];
    for op in 0..ops {
        let r = rnd() % 100;
        let len = if r < 55 {
            e.brush.tool = tools[(rnd() % tools.len() as u64) as usize];
            e.brush.radius_px = 40.0 + (rnd() % 80) as f32;
            e.brush.symmetry_x = rnd() % 2 == 0;
            e.dyn_topo.detail = match rnd() % 3 {
                0 => Detail { mode: DetailMode::Brush, value: 15.0 + (rnd() % 40) as f32 },
                1 => Detail { mode: DetailMode::Screen, value: 4.0 + (rnd() % 16) as f32 },
                _ => Detail { mode: DetailMode::Constant, value: 6.0 + (rnd() % 20) as f32 },
            };
            strokes += 1;
            let (x, y) = (200.0 + (rnd() % 200) as f32, 200.0 + (rnd() % 200) as f32);
            stroke(&mut e, x, y, (rnd() % 11) as f32 - 5.0, (rnd() % 11) as f32 - 5.0, 3 + (rnd() % 5) as usize)
        } else if r < 75 {
            e.undo()
        } else if r < 90 {
            e.redo()
        } else if r < 95 {
            // Full save (the worker's checkpoint while topology is dirty): journal starts over.
            e.frame_update();
            save = (store::topo_bytes(&e.mesh), store::positions_bytes(&e.mesh));
            journal.clear();
            ends = vec![(0, state(&e))];
            0
        } else {
            // Kill: tear the journal anywhere, recover, continue from the recovered project.
            kills += 1;
            let cut = (rnd() as usize) % (journal.len() + 1);
            let mut m = store::load(&save.0, &save.1).unwrap();
            let mut at = 0;
            while at < cut {
                match apply_record(&mut m, &journal[at..cut]) {
                    Ok((_, used)) => at += used,
                    Err(_) => break,
                }
            }
            let expected = ends.iter().rev().find(|(end, _)| *end <= cut).unwrap().1;
            let mut r = Engine::new(m);
            enable(&mut r);
            if state(&r) != expected {
                failures += 1;
            }
            e = r;
            save = (store::topo_bytes(&e.mesh), store::positions_bytes(&e.mesh));
            journal.clear();
            ends = vec![(0, state(&e))];
            0
        };
        if len > 0 {
            journal.extend_from_slice(&e.out[..len]);
            ends.push((journal.len(), state(&e)));
        }
        if !check(&e.mesh).closed_manifold() {
            failures += 1;
        }
        if e.dyn_topo.starved {
            // The worker re-lays out after a starved stroke (a heavy op: full save after it).
            relayouts += 1;
            let mesh = relayout(&e.mesh, 2.0, 128);
            e = Engine::new(mesh);
            enable(&mut e);
            save = (store::topo_bytes(&e.mesh), store::positions_bytes(&e.mesh));
            journal.clear();
            ends = vec![(0, state(&e))];
        }
        let _ = op;
    }
    (strokes, kills, relayouts, failures)
}

macro_rules! fuzz_test {
    ($name:ident, $seed:expr) => {
        #[test]
        fn $name() {
            let seed: u64 = $seed;
            let (strokes, kills, relayouts, failures) = fuzz(seed, 2500);
            println!("top3 fuzz {seed:x}: 2500 ops ({strokes} dyntopo strokes, {kills} kills, {relayouts} relayouts): {failures} validator/recovery failures");
            assert_eq!(failures, 0);
        }
    };
}
fuzz_test!(top3_prj4_fuzz_10k_ops_1, 0x51ed_270b_27f0_c3a1);
fuzz_test!(top3_prj4_fuzz_10k_ops_2, 0x2545_f491_4f6c_dd1d);
fuzz_test!(top3_prj4_fuzz_10k_ops_3, 0x9e37_79b9_7f4a_7c15);
fuzz_test!(top3_prj4_fuzz_10k_ops_4, 0x1234_5678_9abc_def1);

/// Native ms per dyntopo dab at 1M triangles (the reference device must stay <= 8 ms).
#[test]
fn top3_ms_per_dab_at_1m() {
    let t = std::time::Instant::now();
    let mut e = dyn_engine(EditMesh::from_trimesh(cube_sphere(290), 1024), 1024, 1.5);
    let setup = t.elapsed().as_secs_f64() * 1e3;
    e.brush.tool = Tool::Draw;
    e.brush.radius_px = 60.0;
    e.dyn_topo.detail = Detail { mode: DetailMode::Brush, value: 25.0 };
    let t0 = live_tris(&e.mesh);
    let t = std::time::Instant::now();
    e.stroke_begin(250.0, 300.0, 1.0);
    let samples: Vec<f32> = (1..=60).flat_map(|i| [250.0 + 2.0 * i as f32, 300.0 + i as f32 * 0.5, 1.0]).collect();
    e.stroke_move(&samples);
    let dabs = e.stroke.dabs;
    let ms = t.elapsed().as_secs_f64() * 1e3;
    let t = std::time::Instant::now();
    e.stroke_end();
    let end_ms = t.elapsed().as_secs_f64() * 1e3;
    let t = std::time::Instant::now();
    e.frame_update();
    let frame_ms = t.elapsed().as_secs_f64() * 1e3;
    println!(
        "top3 1M: {:.3} ms/dab native over {dabs} dabs ({t0} -> {} live triangles, {} splits, {} collapses); stroke end {end_ms:.1} ms, frame {frame_ms:.1} ms; relayout of 1M {setup:.0} ms",
        ms / dabs.max(1) as f64,
        live_tris(&e.mesh),
        e.dyn_topo.splits,
        e.dyn_topo.collapses
    );
    assert!(dabs > 10);
    assert!(ms / dabs as f64 <= 8.0, "{:.2} ms/dab natively", ms / dabs as f64);
    // Refining: max edge 0.7 x the 1M sphere's edges, so every edge under the brush splits.
    e.dyn_topo.detail = Detail { mode: DetailMode::Constant, value: 260.0 };
    let t1 = live_tris(&e.mesh);
    let (s0, t) = (e.dyn_topo.splits, std::time::Instant::now());
    e.stroke_begin(330.0, 260.0, 1.0);
    let samples: Vec<f32> = (1..=60).flat_map(|i| [330.0 - 2.0 * i as f32, 260.0 + i as f32 * 0.5, 1.0]).collect();
    e.stroke_move(&samples);
    let dabs = e.stroke.dabs;
    let ms = t.elapsed().as_secs_f64() * 1e3;
    e.stroke_end();
    println!("top3 1M refine: {:.3} ms/dab native over {dabs} dabs ({t1} -> {} live triangles, {} splits)", ms / dabs.max(1) as f64, live_tris(&e.mesh), e.dyn_topo.splits - s0);
    assert!(ms / dabs as f64 <= 8.0, "{:.2} ms/dab natively", ms / dabs as f64);
}

#[test]
#[ignore]
fn top3_profile_split_cost() {
    let mut e = dyn_engine(EditMesh::from_trimesh(cube_sphere(290), 1024), 1024, 1.5);
    let mut tx = Transaction::new(e.mesh.nleaves());
    tx.topo = true;
    tx.begin();
    let mut modified = StampSet::new(e.mesh.nverts());
    for (i, budget) in [(0, 200u32), (1, 800), (2, 3000)] {
        let c = normalize([0.3 + 0.2 * i as f32, 0.5, 0.8]);
        let t = std::time::Instant::now();
        let (s, k) = update_region(&mut e.mesh, &mut e.dyn_topo, &mut tx, &mut modified, c, 0.25, 0.0038);
        println!("region {i}: {:.2} ms, {s} splits, {k} collapses (budget {budget})", t.elapsed().as_secs_f64() * 1e3);
    }
    let c = normalize([0.9, 0.5, 0.1]);
    let t = std::time::Instant::now();
    let (s, k) = update_region(&mut e.mesh, &mut e.dyn_topo, &mut tx, &mut modified, c, 0.25, 0.5);
    println!("no-op scan: {:.2} ms, {s} splits, {k} collapses", t.elapsed().as_secs_f64() * 1e3);
    // Full dabs through the engine: topology part vs brush part.
    e.brush.tool = Tool::Draw;
    e.brush.radius_px = 60.0;
    e.dyn_topo.detail = Detail { mode: DetailMode::Constant, value: 260.0 };
    e.stroke_begin(330.0, 260.0, 1.0);
    let (mut topo_ms, mut all_ms) = (0.0, 0.0);
    for i in 1..=60 {
        let t = std::time::Instant::now();
        e.stroke_move(&[330.0 - 2.0 * i as f32, 260.0 + i as f32 * 0.5, 1.0]);
        all_ms += t.elapsed().as_secs_f64() * 1e3;
    }
    let dabs = e.stroke.dabs;
    e.stroke_end();
    // Topology alone at the same places.
    for i in 0..dabs {
        let c = normalize([0.2 - 0.01 * i as f32, 0.1, 0.97]);
        let t = std::time::Instant::now();
        tx.begin();
        update_region(&mut e.mesh, &mut e.dyn_topo, &mut tx, &mut modified, c, 0.25, 0.0038);
        topo_ms += t.elapsed().as_secs_f64() * 1e3;
    }
    println!("engine dabs: {dabs} dabs, {:.2} ms/dab all; update_region alone {:.2} ms/dab", all_ms / dabs as f64, topo_ms / dabs as f64);
}
