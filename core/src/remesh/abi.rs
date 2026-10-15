//! Remesh exports (TOP-1) and heavy-op undo (UND-1: "heavy-op undo points at the pre-op
//! checkpoint").
//!
//! The job is sliced: `eng_remesh_begin` sets it up, `eng_remesh_step(units)` does a bounded
//! amount of work (the worker sizes `units` to ~6 ms and renders between steps, so the view stays
//! live), `eng_remesh_cancel` drops it (the mesh was never touched), `eng_remesh_finish` installs
//! the result. While the job runs, the worker accepts no strokes, so the source mesh is frozen.
//!
//! Undo: a remesh replaces the topology, so the stroke history (leaf position records) of the old
//! mesh cannot apply to the new one. Each topology is an *epoch*: the remesh snapshots the old
//! mesh exactly as the project files store it (topo.bin + positions.bin bytes, the same bytes the
//! last checkpoint would hold) together with its stroke history. Undo past the first stroke of
//! the current epoch swaps the snapshot back in (bit-identical mesh: same partition, same hash),
//! and the epoch's own strokes become undoable again; redo swaps forward. Snapshots count against
//! the same history budget as strokes; a snapshot that doesn't fit makes the remesh irreversible,
//! and `eng_remesh_estimate` says so before it starts.

use super::serial::TopoWriter;
use super::validate::validate;
use super::{estimate, mesh_bytes, source_info, Job, Params, SourceInfo};
use crate::abi::{install_mesh, with_engine};
use crate::history::History;
use crate::store;
use std::cell::RefCell;

struct Epoch {
    topo: Vec<u8>,
    pos: Vec<u8>,
    hist: History,
}

impl Epoch {
    fn bytes(&self) -> usize {
        self.topo.len() + self.pos.len() + self.hist.bytes()
    }
}

struct Running {
    job: Job,
    undoable: bool,
    old_topo: Option<TopoWriter>,
    old_pos: Vec<u8>,
    new_topo: Option<TopoWriter>,
}

#[derive(Default)]
struct Heavy {
    back: Vec<Epoch>,
    fwd: Vec<Epoch>,
    running: Option<Running>,
    /// Topology bytes of the mesh installed by the last finish/undo/redo (for the save).
    out_topo: Vec<u8>,
    info: Option<(u64, SourceInfo)>,
}

thread_local! {
    static HEAVY: RefCell<Heavy> = RefCell::new(Heavy::default());
    static NUMS: *mut [f64; 32] = Box::into_raw(Box::new([0.0; 32]));
}

fn nums() -> &'static mut [f64; 32] {
    // Single-threaded WASM instance; leaked once, never freed (like abi.rs's shared block).
    NUMS.with(|p| unsafe { &mut **p })
}

/// Total bytes held by epochs other than the live one.
fn epoch_bytes(h: &Heavy) -> usize {
    h.back.iter().chain(h.fwd.iter()).map(|e| e.bytes()).sum()
}

/// Shared f64 block: estimate at [0..12], last result at [16..32] (see the exports below).
#[unsafe(no_mangle)]
pub extern "C" fn eng_remesh_nums_ptr() -> *const f64 {
    nums().as_ptr()
}

/// Pre-flight estimate for `target` quads. Writes [h, quads, verts, steady bytes, transient bytes,
/// undo snapshot bytes, bricks, grid ok, history budget bytes, current mesh bytes, undo fits,
/// epoch bytes] to nums[0..12]. Returns 1 (0 if no engine).
#[unsafe(no_mangle)]
pub extern "C" fn eng_remesh_estimate(target: u32, keep_sharp: u32) -> u32 {
    HEAVY.with(|h| {
        let mut h = h.borrow_mut();
        let held = epoch_bytes(&h);
        with_engine(|e| {
            let key = (e.seq as u64) << 32 ^ (e.mesh.ntris() as u64) << 1 ^ e.mesh.nverts() as u64;
            let info = match h.info {
                Some((k, i)) if k == key => i,
                _ => {
                    let i = source_info(&e.mesh);
                    h.info = Some((key, i));
                    i
                }
            };
            let p = Params { target_quads: target.max(1), keep_sharp: keep_sharp != 0, ..Default::default() };
            let est = estimate(&info, p);
            let budget = e.hist.budget_bytes + held;
            let n = nums();
            n[..12].copy_from_slice(&[
                est.h as f64,
                est.quads as f64,
                est.verts as f64,
                est.steady_bytes as f64,
                est.transient_bytes as f64,
                est.undo_bytes as f64,
                est.bricks as f64,
                est.grid_ok as u32 as f64,
                budget as f64,
                mesh_bytes(&e.mesh) as f64,
                (est.undo_bytes as usize <= budget) as u32 as f64,
                held as f64,
            ]);
            1
        })
        .unwrap_or(0)
    })
}

/// Starts a remesh of the current mesh. Returns 1, or a negative code: -1 no engine,
/// -2 empty mesh, -3 already running.
#[unsafe(no_mangle)]
pub extern "C" fn eng_remesh_begin(target: u32, keep_sharp: u32, leaf_max: u32) -> i32 {
    HEAVY.with(|h| {
        let mut h = h.borrow_mut();
        if h.running.is_some() {
            return -3;
        }
        let held = epoch_bytes(&h);
        with_engine(|e| {
            let p = Params { target_quads: target.max(1), keep_sharp: keep_sharp != 0, leaf_max: leaf_max.max(16), ..Default::default() };
            let Ok(job) = Job::new(&e.mesh, p) else { return -2 };
            let snapshot = super::serial::topo_len(&e.mesh) + e.mesh.positions.len() * 4;
            let undoable = snapshot <= e.hist.budget_bytes + held;
            h.running = Some(Running { job, undoable, old_topo: undoable.then(|| TopoWriter::new(&e.mesh)), old_pos: Vec::new(), new_topo: None });
            1
        })
        .unwrap_or(-1)
    })
}

/// Advances the job by about `units` work units (~10 ns each natively). Returns 0 while running,
/// 1 when ready to finish, -1 if nothing runs, -2 if the job refused (grid too large).
#[unsafe(no_mangle)]
pub extern "C" fn eng_remesh_step(units: u32) -> i32 {
    HEAVY.with(|h| {
        let mut h = h.borrow_mut();
        let Some(r) = h.running.as_mut() else { return -1 };
        with_engine(|e| {
            let mut left = units.max(1) as i64;
            if r.job.stage != super::Stage::Done {
                r.job.step(&e.mesh, left as u64);
                if r.job.stage != super::Stage::Done {
                    return 0;
                }
                if r.job.result.is_none() {
                    return -2;
                }
                left = 0;
            }
            // Undo snapshot of the mesh being replaced, then the new mesh's topology file.
            if let Some(w) = r.old_topo.as_mut() {
                if !w.done() {
                    left = left.max(units as i64 / 2);
                    if !w.step(&e.mesh, &mut left) {
                        return 0;
                    }
                    r.old_pos = store::positions_bytes(&e.mesh);
                }
            }
            let m = r.job.result.as_ref().unwrap();
            let w = r.new_topo.get_or_insert_with(|| TopoWriter::new(m));
            left = left.max(units as i64 / 2);
            if w.step(m, &mut left) { 1 } else { 0 }
        })
        .unwrap_or(-1)
    })
}

/// [progress 0..1, stage index] of the running job (stage names: Stage::name order in JS).
#[unsafe(no_mangle)]
pub extern "C" fn eng_remesh_progress() -> f32 {
    HEAVY.with(|h| h.borrow().running.as_ref().map_or(0.0, |r| if r.job.stage == super::Stage::Done { 0.99 } else { r.job.progress() * 0.98 }))
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_remesh_stage() -> u32 {
    HEAVY.with(|h| h.borrow().running.as_ref().map_or(0, |r| r.job.stage as u32))
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_remesh_cancel() {
    HEAVY.with(|h| h.borrow_mut().running = None);
}

/// Installs the result. Writes [quads, verts, tris, undoable, h, bricks, flips, holes, job peak
/// bytes, topo bytes] to nums[16..26]. Returns the new topology file length (> 0), or 0.
/// The caller then saves (eng_heavy_topo_ptr + positions) and re-sends brush and camera.
#[unsafe(no_mangle)]
pub extern "C" fn eng_remesh_finish() -> u32 {
    HEAVY.with(|h| {
        let mut h = h.borrow_mut();
        let Some(mut r) = h.running.take() else { return 0 };
        let Some(mesh) = r.job.result.take() else { return 0 };
        if r.new_topo.as_ref().is_none_or(|w| !w.done()) {
            return 0;
        }
        let Some((hist, seq)) = with_engine(|e| (std::mem::replace(&mut e.hist, History::new(0, 1)), e.seq)) else { return 0 };
        // Total history budget = the live history's share + what older meshes hold.
        let (budget, max_steps) = (hist.budget_bytes + epoch_bytes(&h), hist.max_steps);
        let undoable = r.undoable && r.old_topo.as_ref().is_some_and(|w| w.done());
        if undoable {
            let topo = std::mem::take(&mut r.old_topo.as_mut().unwrap().out);
            let mut ep = Epoch { topo, pos: std::mem::take(&mut r.old_pos), hist };
            h.fwd.clear();
            // Oldest first: older meshes, then the replaced mesh's own strokes.
            while !h.back.is_empty() && ep.bytes() + epoch_bytes(&h) > budget {
                h.back.remove(0);
            }
            if ep.bytes() > budget {
                ep.hist.clear();
            }
            h.back.push(ep);
        } else {
            h.back.clear();
            h.fwd.clear();
        }
        let st = r.job.stats;
        let (nv, nt) = (mesh.nverts(), mesh.ntris());
        h.out_topo = std::mem::take(&mut r.new_topo.as_mut().unwrap().out);
        let held = epoch_bytes(&h);
        drop(r);
        install_mesh(mesh);
        with_engine(|e| {
            e.seq = seq + 1;
            e.hist = History::new(budget.saturating_sub(held).max(1), max_steps);
        });
        h.info = None;
        nums()[16..26].copy_from_slice(&[
            st.quads as f64,
            nv as f64,
            nt as f64,
            undoable as u32 as f64,
            st.h as f64,
            st.bricks as f64,
            st.flips as f64,
            st.holes as f64,
            st.peak_bytes as f64,
            h.out_topo.len() as f64,
        ]);
        h.out_topo.len() as u32
    })
}

/// Installs a mesh made by a one-shot heavy op (dyntopo relayout): the current mesh becomes an
/// undo epoch when it fits the history budget. Returns (new topology length, undoable); the
/// topology bytes wait at eng_heavy_topo_ptr for the save.
pub(crate) fn install_heavy(mesh: crate::mesh::EditMesh) -> (u32, bool) {
    HEAVY.with(|h| {
        let mut h = h.borrow_mut();
        h.running = None;
        let Some((hist, seq, topo, pos)) = with_engine(|e| {
            let hist = std::mem::replace(&mut e.hist, History::new(0, 1));
            (hist, e.seq, store::topo_bytes(&e.mesh), store::positions_bytes(&e.mesh))
        }) else {
            return (0, false);
        };
        let (budget, max_steps) = (hist.budget_bytes + epoch_bytes(&h), hist.max_steps);
        let undoable = topo.len() + pos.len() <= budget;
        if undoable {
            let mut ep = Epoch { topo, pos, hist };
            h.fwd.clear();
            while !h.back.is_empty() && ep.bytes() + epoch_bytes(&h) > budget {
                h.back.remove(0);
            }
            if ep.bytes() > budget {
                ep.hist.clear();
            }
            h.back.push(ep);
        } else {
            h.back.clear();
            h.fwd.clear();
        }
        h.out_topo = store::topo_bytes(&mesh);
        let held = epoch_bytes(&h);
        install_mesh(mesh);
        with_engine(|e| {
            e.seq = seq + 1;
            e.hist = History::new(budget.saturating_sub(held).max(1), max_steps);
        });
        h.info = None;
        (h.out_topo.len() as u32, undoable)
    })
}

/// Topology file of the mesh installed by the last finish / heavy undo / heavy redo.
#[unsafe(no_mangle)]
pub extern "C" fn eng_heavy_topo_ptr() -> *const u8 {
    HEAVY.with(|h| h.borrow().out_topo.as_ptr())
}

/// Frees the saved topology bytes once the worker has copied them.
#[unsafe(no_mangle)]
pub extern "C" fn eng_heavy_topo_release() {
    HEAVY.with(|h| h.borrow_mut().out_topo = Vec::new());
}

fn swap(back: bool) -> u32 {
    HEAVY.with(|h| {
        let mut h = h.borrow_mut();
        if h.running.is_some() {
            return 0;
        }
        let ready = with_engine(|e| if back { e.hist.undo.is_empty() } else { e.hist.redo.is_empty() }).unwrap_or(false);
        if !ready {
            return 0;
        }
        let Some(ep) = (if back { h.back.pop() } else { h.fwd.pop() }) else { return 0 };
        let Ok(mesh) = store::load(&ep.topo, &ep.pos) else {
            // A snapshot is written from a valid mesh, so this can't fail; keep it if it does.
            if back { h.back.push(ep) } else { h.fwd.push(ep) }
            return 0;
        };
        let held_before = epoch_bytes(&h) + ep.bytes();
        let Some((cur, seq)) = with_engine(|e| {
            let hist = std::mem::replace(&mut e.hist, History::new(0, 1));
            (Epoch { topo: store::topo_bytes(&e.mesh), pos: store::positions_bytes(&e.mesh), hist }, e.seq)
        }) else {
            return 0;
        };
        let (budget, max_steps) = (cur.hist.budget_bytes + held_before, cur.hist.max_steps);
        let Epoch { topo, hist, .. } = ep;
        h.out_topo = topo;
        if back {
            h.fwd.push(cur);
        } else {
            h.back.push(cur);
        }
        let held = epoch_bytes(&h);
        install_mesh(mesh);
        with_engine(|e| {
            e.seq = seq + 1;
            let mut hist = hist;
            hist.budget_bytes = budget.saturating_sub(held).max(1);
            hist.max_steps = max_steps;
            e.hist = hist;
        });
        h.info = None;
        h.out_topo.len() as u32
    })
}

/// Undo across a remesh: if the live epoch has no stroke left to undo and an older mesh exists,
/// swaps it in. Returns its topology length (the caller saves it and re-uploads), or 0 = not a
/// heavy step (call eng_undo).
#[unsafe(no_mangle)]
pub extern "C" fn eng_heavy_undo() -> u32 {
    swap(true)
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_heavy_redo() -> u32 {
    swap(false)
}

/// A new edit was journaled: the redo branch of remeshes is gone (linear history).
#[unsafe(no_mangle)]
pub extern "C" fn eng_heavy_edit() {
    HEAVY.with(|h| h.borrow_mut().fwd.clear());
}

/// New sphere or project load: older meshes belong to another project.
#[unsafe(no_mangle)]
pub extern "C" fn eng_heavy_reset() {
    HEAVY.with(|h| {
        let mut h = h.borrow_mut();
        h.back.clear();
        h.fwd.clear();
        h.running = None;
        h.info = None;
    });
}

/// [heavy undo steps, heavy redo steps, KiB held by older meshes].
///
/// # Safety
/// `out` must point to 3 writable u32 slots.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn eng_heavy_depths(out: *mut u32) {
    HEAVY.with(|h| {
        let h = h.borrow();
        let v = [h.back.len() as u32, h.fwd.len() as u32, (epoch_bytes(&h) / 1024) as u32];
        for (i, x) in v.iter().enumerate() {
            unsafe { *out.add(i) = *x };
        }
    });
}

/// Mesh validator on the live mesh: [boundary edges, non-manifold edges, inconsistent edges,
/// non-manifold vertices, degenerate triangles, components, Euler characteristic] (i32).
///
/// # Safety
/// `out` must point to 7 writable i32 slots.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn eng_validate(out: *mut i32) -> u32 {
    with_engine(|e| {
        let r = validate(e.mesh.nverts(), &e.mesh.tris);
        let v = [r.boundary_edges as i32, r.nonmanifold_edges as i32, r.inconsistent_edges as i32, r.nonmanifold_verts as i32, r.degenerate_tris as i32, r.components as i32, r.euler as i32];
        for (i, x) in v.iter().enumerate() {
            unsafe { *out.add(i) = *x };
        }
        1
    })
    .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abi::{eng_hash, eng_new_sphere, eng_redo, eng_set_history, eng_stroke_begin, eng_stroke_end, eng_stroke_move, eng_undo};

    fn run_remesh(target: u32) -> u32 {
        assert_eq!(eng_remesh_begin(target, 0, 256), 1);
        let mut steps = 0;
        loop {
            steps += 1;
            match eng_remesh_step(200_000) {
                0 => continue,
                1 => break,
                c => panic!("step failed {c}"),
            }
        }
        assert!(eng_remesh_finish() > 0);
        steps
    }

    fn stroke(x: f32) {
        let cam = crate::engine::tests_support::camera([0.0, 0.2, 3.0], 600.0, 600.0);
        with_engine(|e| e.cam = cam);
        eng_stroke_begin(x, 300.0, 1.0);
        let s = crate::abi::eng_samples_ptr(6);
        unsafe {
            std::slice::from_raw_parts_mut(s, 6).copy_from_slice(&[x + 20.0, 310.0, 1.0, x + 40.0, 320.0, 1.0]);
        }
        eng_stroke_move(2);
        assert!(eng_stroke_end() > 0);
        eng_heavy_edit();
    }

    /// The engine path: sliced job, install, undo back across the remesh to the exact pre-remesh
    /// mesh (and its strokes), redo forward to the exact remeshed one.
    #[test]
    fn top1_und1_engine_remesh_undo_redo_exact() {
        eng_new_sphere(40, 256);
        eng_heavy_reset();
        eng_set_history(256, 200);
        stroke(280.0);
        let h_stroked = eng_hash();
        let mut ok = [0i32; 7];
        let steps = run_remesh(12_000);
        let h_remeshed = eng_hash();
        unsafe { eng_validate(ok.as_mut_ptr()) };
        assert_eq!(&ok[..5], &[0, 0, 0, 0, 0], "remeshed mesh not closed manifold: {ok:?}");
        assert_ne!(h_remeshed, h_stroked);
        assert_eq!(nums()[19], 1.0, "undoable");
        stroke(300.0);
        let h_after = eng_hash();
        // Undo: the stroke on the new mesh, then the remesh itself, then the stroke before it.
        assert!(eng_undo() > 0);
        assert_eq!(eng_hash(), h_remeshed);
        assert_eq!(eng_undo(), 0);
        assert!(eng_heavy_undo() > 0);
        assert_eq!(eng_hash(), h_stroked);
        assert!(eng_undo() > 0, "the pre-remesh stroke is undoable again");
        // Redo all the way.
        assert!(eng_redo() > 0);
        assert_eq!(eng_hash(), h_stroked);
        assert_eq!(eng_redo(), 0);
        assert!(eng_heavy_redo() > 0);
        assert_eq!(eng_hash(), h_remeshed);
        assert!(eng_redo() > 0);
        assert_eq!(eng_hash(), h_after);
        println!("top1 engine: remesh in {steps} steps; undo/redo across it exact");
    }

    #[test]
    fn top1_cancel_leaves_the_mesh_and_history_untouched() {
        eng_new_sphere(32, 256);
        eng_heavy_reset();
        stroke(290.0);
        let h0 = eng_hash();
        assert_eq!(eng_remesh_begin(20_000, 0, 256), 1);
        for _ in 0..5 {
            assert_eq!(eng_remesh_step(20_000), 0);
        }
        eng_remesh_cancel();
        assert_eq!(eng_hash(), h0);
        assert!(eng_undo() > 0, "history intact");
    }

    #[test]
    fn top1_snapshot_over_budget_makes_the_remesh_irreversible() {
        eng_new_sphere(40, 256);
        eng_heavy_reset();
        eng_set_history(0, 200); // 0 MB budget: no snapshot fits
        assert_eq!(eng_remesh_estimate(5000, 0), 1);
        assert_eq!(nums()[10], 0.0, "estimate must say undo won't fit");
        run_remesh(5000);
        assert_eq!(nums()[19], 0.0);
        assert_eq!(eng_heavy_undo(), 0);
    }
}
