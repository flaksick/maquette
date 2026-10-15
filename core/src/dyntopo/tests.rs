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
