//! Dyntopo exports (TOP-3). The worker turns it on with a detail setting, re-lays the mesh out
//! (with a memory pre-flight) when the layout has no slack or a stroke ran out of it, saves the
//! whole mesh when topology changed since the last full save, and reads the status for the UI.

use super::{is_dead, make_dynamic, relayout, scan_free, Detail, DetailMode};
use crate::abi::with_engine;
use crate::engine::Engine;
use crate::gpu::Gpu;
use crate::remesh::{ENGINE_BYTES_PER_TRI, ENGINE_BYTES_PER_VERT};

/// Small GPU pages for dyntopo layouts: a page whose triangles changed is replaced whole.
pub const DYN_PAGE_VERTS: usize = 65_536;

fn has_slack(e: &Engine) -> bool {
    (0..e.mesh.ntris()).any(|t| is_dead(&e.mesh, t))
}

/// Live triangles / vertices (dead slots don't count).
pub fn live_counts(e: &Engine) -> (u32, u32) {
    if e.dyn_topo.ready(&e.mesh) {
        let ft: usize = e.dyn_topo.tfree.iter().map(|f| f.len()).sum();
        let fv: usize = e.dyn_topo.vfree.iter().map(|f| f.len()).sum();
        return ((e.mesh.ntris() - ft) as u32, (e.mesh.nverts() - fv) as u32);
    }
    let dead = (0..e.mesh.ntris()).filter(|&t| is_dead(&e.mesh, t)).count();
    ((e.mesh.ntris() - dead) as u32, e.mesh.nverts() as u32)
}

/// On/off and detail (mode 0 constant / 1 screen / 2 brush %). Returns 0 = off, 1 = ready,
/// 2 = the layout has no slack (call eng_dyn_relayout), 3 = ready and the GPU pages changed
/// (re-upload everything).
#[unsafe(no_mangle)]
pub extern "C" fn eng_dyn_set(on: u32, mode: u32, value: f32) -> u32 {
    with_engine(|e| {
        e.dyn_topo.on = on != 0;
        e.dyn_topo.detail = Detail { mode: DetailMode::from_u32(mode), value };
        if !e.dyn_topo.on {
            return 0;
        }
        if !e.dyn_topo.ready(&e.mesh) {
            if !has_slack(e) {
                return 2;
            }
            if !e.mesh.topo.is_dynamic() {
                make_dynamic(&mut e.mesh);
            }
            scan_free(&e.mesh, &mut e.dyn_topo);
        }
        if e.gpu.limit != DYN_PAGE_VERTS {
            e.gpu = Gpu::build_limit(&e.mesh, DYN_PAGE_VERTS);
            return 3;
        }
        1
    })
    .unwrap_or(0)
}

/// Bytes a dyntopo layout of the current mesh with `slack` adds at peak: the new engine mesh
/// (slots, dynamic adjacency, GPU) + the compact intermediate + the undo snapshot.
#[unsafe(no_mangle)]
pub extern "C" fn eng_dyn_layout_bytes(slack: f32) -> f64 {
    with_engine(|e| {
        let (lt, lv) = live_counts(e);
        let leaves = (lt as f64 / 1024.0).ceil() + 1.0;
        let sv = lv as f64 * slack as f64 + 32.0 * leaves;
        let st = lt as f64 * slack as f64 + 64.0 * leaves;
        let new_mesh = sv * (ENGINE_BYTES_PER_VERT as f64 + 80.0) + st * ENGINE_BYTES_PER_TRI as f64;
        let compact = lv as f64 * ENGINE_BYTES_PER_VERT as f64 + lt as f64 * ENGINE_BYTES_PER_TRI as f64;
        let snapshot = 16.0 * e.mesh.ntris() as f64 + 12.0 * e.mesh.nverts() as f64;
        new_mesh + compact + snapshot
    })
    .unwrap_or(0.0)
}

/// Re-lays the mesh out with `slack` x room per leaf (an undoable heavy op). Returns the new
/// topology length for the save (bytes at eng_heavy_topo_ptr), 0 if nothing is loaded. The
/// caller then calls eng_dyn_set again (the install starts a fresh engine).
#[unsafe(no_mangle)]
pub extern "C" fn eng_dyn_relayout(slack: f32, leaf_max: u32) -> u32 {
    let Some(mesh) = with_engine(|e| relayout(&e.mesh, slack.max(1.0), leaf_max.max(64) as usize)) else { return 0 };
    crate::remesh::abi::install_heavy(mesh).0
}

/// [on, ready, starved, capped, splits, collapses, live tris, tri slots, free tri slots, live verts]
///
/// # Safety
/// `out` must point to 10 writable u32 slots.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn eng_dyn_status(out: *mut u32) {
    with_engine(|e| {
        let (lt, lv) = live_counts(e);
        let d = &e.dyn_topo;
        let v = [d.on as u32, d.ready(&e.mesh) as u32, d.starved as u32, d.capped as u32, d.splits as u32, d.collapses as u32, lt, e.mesh.ntris() as u32, e.mesh.ntris() as u32 - lt, lv];
        for (i, x) in v.iter().enumerate() {
            unsafe { *out.add(i) = *x };
        }
    });
}

/// Clears `starved` (after a re-layout) and sets `capped` (the budget refused one).
#[unsafe(no_mangle)]
pub extern "C" fn eng_dyn_flags(clear_starved: u32, capped: u32) {
    with_engine(|e| {
        if clear_starved != 0 {
            e.dyn_topo.starved = false;
        }
        e.dyn_topo.capped = capped != 0;
    });
}

/// Topology changed since the project files were written whole: the next save must be whole.
#[unsafe(no_mangle)]
pub extern "C" fn eng_topo_dirty() -> u32 {
    with_engine(|e| e.dyn_topo.topo_dirty as u32).unwrap_or(0)
}

/// Called when the whole mesh was serialized for a save.
#[unsafe(no_mangle)]
pub extern "C" fn eng_topo_saved() {
    with_engine(|e| e.dyn_topo.topo_dirty = false);
}
