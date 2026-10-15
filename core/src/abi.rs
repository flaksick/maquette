//! C ABI exported to JavaScript. The boundary is pointers into linear memory plus counts, so
//! no binding generator is used (DECISIONS.md, 2026-10-13). Handles are 1-based; 0 = failure.

use crate::kernels::{RenderMesh, Scene, run_composite};
use std::cell::RefCell;

thread_local! {
    static SCENES: RefCell<Vec<Option<Box<Scene>>>> = const { RefCell::new(Vec::new()) };
    static RENDER: RefCell<Option<Box<RenderMesh>>> = const { RefCell::new(None) };
}

/// Builds (replacing any previous) the single render-test mesh. Returns 1 on success.
#[unsafe(no_mangle)]
pub extern "C" fn mq_render_mesh_new(n: u32, leaf_max: u32) -> u32 {
    RENDER.with(|r| {
        *r.borrow_mut() = None; // free first so peak memory is one mesh, not two
        *r.borrow_mut() = Some(Box::new(RenderMesh::new(crate::sphere::cube_sphere(n), leaf_max as usize)));
    });
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn mq_render_mesh_free() {
    RENDER.with(|r| *r.borrow_mut() = None);
}

/// Layout: nverts, ntris, nleaves, then (ptr, len) for positions, normals, tris,
/// leaf_tri_off, tri_order.
///
/// # Safety
/// `out` must point to at least 13 writable u32 slots.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mq_render_layout(out: *mut u32) -> u32 {
    RENDER.with(|r| {
        let r = r.borrow();
        let Some(m) = r.as_deref() else { return 0 };
        let vals = [
            m.mesh.nverts() as u32,
            m.mesh.ntris() as u32,
            m.bvh.nleaves() as u32,
            m.mesh.positions.as_ptr() as usize as u32,
            m.mesh.positions.len() as u32,
            m.normals.as_ptr() as usize as u32,
            m.normals.len() as u32,
            m.mesh.tris.as_ptr() as usize as u32,
            m.mesh.tris.len() as u32,
            m.bvh.leaf_tri_off.as_ptr() as usize as u32,
            m.bvh.leaf_tri_off.len() as u32,
            m.bvh.tri_order.as_ptr() as usize as u32,
            m.bvh.tri_order.len() as u32,
        ];
        for (i, &v) in vals.iter().enumerate() {
            unsafe { *out.add(i) = v };
        }
        vals.len() as u32
    })
}

fn with_scene<R>(h: u32, f: impl FnOnce(&mut Scene) -> R) -> Option<R> {
    SCENES.with(|s| {
        let mut s = s.borrow_mut();
        let slot = s.get_mut((h as usize).checked_sub(1)?)?;
        slot.as_deref_mut().map(f)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn mq_version() -> u32 {
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn mq_simd_compiled() -> u32 {
    crate::simd::compiled_with_simd() as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn mq_simd_selftest(n: u32) -> i32 {
    crate::simd::selftest(n as usize)
}

#[unsafe(no_mangle)]
pub extern "C" fn mq_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `p` must come from `mq_alloc(len)` with the same `len`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mq_free(p: *mut u8, len: usize) {
    unsafe { drop(Vec::from_raw_parts(p, 0, len)) }
}

#[unsafe(no_mangle)]
pub extern "C" fn mq_sphere_new(n: u32, leaf_max: u32) -> u32 {
    let scene = Box::new(Scene::new(crate::sphere::cube_sphere(n), leaf_max as usize));
    SCENES.with(|s| {
        let mut s = s.borrow_mut();
        s.push(Some(scene));
        s.len() as u32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn mq_scene_free(h: u32) {
    SCENES.with(|s| {
        if let Some(slot) = s.borrow_mut().get_mut((h as usize).wrapping_sub(1)) {
            *slot = None;
        }
    });
}

/// Writes u32 counts/pointers describing the scene into `out` (see `probe/src/core.ts`).
/// Layout: nverts, ntris, nleaves, nnodes, then (ptr, len) pairs for positions, normals, tris,
/// bounds, node_a, node_b, leaf_node, leaf_tri_off, tri_order, own_off, own, vt_off, vt,
/// vv_off, vv.
///
/// # Safety
/// `out` must point to at least 34 writable u32 slots.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mq_scene_layout(h: u32, out: *mut u32) -> u32 {
    fn f(v: &[f32]) -> [u32; 2] {
        [v.as_ptr() as usize as u32, v.len() as u32]
    }
    fn u(v: &[u32]) -> [u32; 2] {
        [v.as_ptr() as usize as u32, v.len() as u32]
    }
    with_scene(h, |s| {
        let counts = [
            s.mesh.nverts() as u32,
            s.mesh.ntris() as u32,
            s.bvh.nleaves() as u32,
            s.bvh.node_a.len() as u32,
        ];
        let pairs = [
            f(&s.mesh.positions),
            f(&s.normals),
            u(&s.mesh.tris),
            f(&s.bvh.bounds),
            u(&s.bvh.node_a),
            u(&s.bvh.node_b),
            u(&s.bvh.leaf_node),
            u(&s.bvh.leaf_tri_off),
            u(&s.bvh.tri_order),
            u(&s.bvh.own_off),
            u(&s.bvh.own),
            u(&s.topo.vt_off),
            u(&s.topo.vt),
            u(&s.topo.vv_off),
            u(&s.topo.vv),
        ];
        let vals: Vec<u32> = counts.into_iter().chain(pairs.into_iter().flatten()).collect();
        for (i, &v) in vals.iter().enumerate() {
            unsafe { *out.add(i) = v };
        }
        vals.len() as u32
    })
    .unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn mq_composite_run(h: u32, first: u32, steps: u32) -> u32 {
    with_scene(h, |s| {
        run_composite(s, first, steps);
        s.last_selected
    })
    .unwrap_or(0)
}

/// Rebuilds adjacency and BVH from the scene's current geometry (S3 structural workload).
#[unsafe(no_mangle)]
pub extern "C" fn mq_rebuild(h: u32, leaf_max: u32) -> u32 {
    with_scene(h, |s| {
        s.topo = crate::topo::build(s.mesh.nverts(), &s.mesh.tris);
        s.bvh = crate::bvh::Bvh::build(&s.mesh.positions, &s.mesh.tris, leaf_max as usize);
        s.bvh.nleaves() as u32
    })
    .unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn mq_checksum(h: u32) -> f64 {
    with_scene(h, |s| s.checksum()).unwrap_or(f64::NAN)
}

// ======================= App engine (P1a) =======================
// One engine per instance (invariant 9: one core instance per session). JS writes the camera
// and stroke samples into shared buffers, calls in, and reads results through pointers.

use crate::engine::{Camera, Engine, Falloff, Tool, CAMERA_FLOATS};
use crate::mesh::EditMesh;

struct Shared {
    camera: [f32; CAMERA_FLOATS],
    samples: Vec<f32>,
    hit: [f32; 8],
    bounds: [f32; 6],
}

thread_local! {
    static ENGINE: RefCell<Option<Box<Engine>>> = const { RefCell::new(None) };
    static SHARED: *mut Shared = Box::into_raw(Box::new(Shared {
        camera: [0.0; CAMERA_FLOATS],
        samples: Vec::new(),
        hit: [0.0; 8],
        bounds: [0.0; 6],
    }));
}

fn shared() -> &'static mut Shared {
    // Single-threaded WASM instance; the box is leaked once and never freed.
    SHARED.with(|p| unsafe { &mut **p })
}

/// Runs `f` on the engine, if one is loaded. Exports in other modules (io, remesh) use it too.
pub(crate) fn with_engine<R>(f: impl FnOnce(&mut Engine) -> R) -> Option<R> {
    ENGINE.with(|e| e.borrow_mut().as_deref_mut().map(f))
}

/// Replaces the engine's mesh: sphere, project load, import, remesh. The old engine is freed
/// first, so peak memory holds one engine, not two. Brush and camera live in the engine, so the
/// worker re-sends both after any install.
pub(crate) fn install_mesh(mesh: EditMesh) {
    ENGINE.with(|e| {
        *e.borrow_mut() = None;
        *e.borrow_mut() = Some(Box::new(Engine::new(mesh)));
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_camera_ptr() -> *mut f32 {
    shared().camera.as_mut_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_samples_ptr(nfloats: u32) -> *mut f32 {
    let s = shared();
    if s.samples.len() < nfloats as usize {
        s.samples.resize(nfloats as usize, 0.0);
    }
    s.samples.as_mut_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_new_sphere(n: u32, leaf_max: u32) -> u32 {
    install_mesh(EditMesh::from_trimesh(crate::sphere::cube_sphere(n.max(1)), leaf_max.max(16) as usize));
    1
}

/// Loads a project from its topology and positions files. Returns 1, or a negative error code.
#[unsafe(no_mangle)]
pub extern "C" fn eng_load(topo: *const u8, topo_len: u32, pos: *const u8, pos_len: u32) -> i32 {
    let t = unsafe { std::slice::from_raw_parts(topo, topo_len as usize) };
    let p = unsafe { std::slice::from_raw_parts(pos, pos_len as usize) };
    match crate::store::load(t, p) {
        Ok(mesh) => {
            install_mesh(mesh);
            1
        }
        Err(err) => -(err as i32) - 1,
    }
}

/// Tool ids: 0 draw, 1 smooth, 2 grab, 3 inflate, 4 flatten, 5 clay, 6 clay strips, 7 crease,
/// 8 pinch, 9 snake hook, 10 layer, 11 fill, 12 scrape, 13 planar (unknown ids draw).
/// Flags: 1 pressure -> radius, 2 pressure -> strength, 4 mirror X, 8 preserve volume,
/// 16 mirror Y, 32 mirror Z.
#[unsafe(no_mangle)]
pub extern "C" fn eng_set_brush(tool: u32, radius_px: f32, strength: f32, flags: u32, gamma: f32, spacing: f32) {
    with_engine(|e| {
        e.brush.tool = Tool::from_u32(tool);
        e.brush.radius_px = radius_px.max(1.0);
        e.brush.strength = strength.clamp(0.0, 1.0);
        e.brush.pressure_radius = flags & 1 != 0;
        e.brush.pressure_strength = flags & 2 != 0;
        e.brush.symmetry_x = flags & 4 != 0;
        e.brush.preserve_volume = flags & 8 != 0;
        e.brush.symmetry_y = flags & 16 != 0;
        e.brush.symmetry_z = flags & 32 != 0;
        e.brush.gamma = gamma.clamp(0.1, 5.0);
        e.brush.spacing = spacing.clamp(0.02, 2.0);
    });
}

/// The rest of the brush (STK-4, STK-11), kept until changed. falloff: 0 smooth, 1 smoother,
/// 2 sphere, 3 root, 4 sharp, 5 linear, 6 pow4, 7 inverse square, 8 constant. hardness and
/// autosmooth 0..1. Flags: 1 accumulate (sample the current surface, not the stroke-start one).
#[unsafe(no_mangle)]
pub extern "C" fn eng_set_brush_ext(falloff: u32, hardness: f32, autosmooth: f32, flags: u32) {
    with_engine(|e| {
        e.brush.falloff = Falloff::from_u32(falloff);
        e.brush.hardness = if hardness.is_finite() { hardness.clamp(0.0, 1.0) } else { 0.0 };
        e.brush.autosmooth = if autosmooth.is_finite() { autosmooth.clamp(0.0, 1.0) } else { 0.0 };
        e.brush.accumulate = flags & 1 != 0;
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_camera_commit() {
    let cam = Camera::from_slice(&shared().camera);
    with_engine(|e| e.cam = cam);
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_stroke_begin(x: f32, y: f32, p: f32) -> u32 {
    with_engine(|e| e.stroke_begin(x, y, p) as u32).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_stroke_move(nsamples: u32) -> u32 {
    let s = &shared().samples;
    let n = (nsamples as usize * 3).min(s.len());
    with_engine(|e| e.stroke_move(&s[..n])).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_stroke_end() -> u32 {
    with_engine(|e| e.stroke_end() as u32).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_undo() -> u32 {
    with_engine(|e| e.undo() as u32).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_redo() -> u32 {
    with_engine(|e| e.redo() as u32).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_out_ptr() -> *const u8 {
    with_engine(|e| e.out.as_ptr()).unwrap_or(std::ptr::null())
}

/// Applies one journal record. Returns its sequence number, or a negative error code.
#[unsafe(no_mangle)]
pub extern "C" fn eng_apply_record(ptr: *const u8, len: u32) -> i64 {
    let b = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
    with_engine(|e| match e.apply_journal_record(b) {
        Ok((seq, _)) => seq as i64,
        Err(err) => -(err as i64) - 1,
    })
    .unwrap_or(-100)
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_set_seq(seq: u32) {
    with_engine(|e| e.seq = seq);
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_seq() -> u32 {
    with_engine(|e| e.seq).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_frame_update() -> u32 {
    with_engine(|e| e.frame_update() as u32).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_gpu_page_count() -> u32 {
    with_engine(|e| e.gpu.pages.len() as u32).unwrap_or(0)
}

/// [vertex bytes, index count] of a page.
#[unsafe(no_mangle)]
pub extern "C" fn eng_gpu_page_sizes(p: u32, out: *mut u32) {
    with_engine(|e| {
        if let Some(pg) = e.gpu.pages.get(p as usize) {
            unsafe {
                *out = pg.vertex_bytes() as u32;
                *out.add(1) = pg.nindices;
            }
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_gpu_full_page(p: u32) -> u32 {
    with_engine(|e| {
        let mesh = &e.mesh;
        e.gpu.full_page(mesh, p as usize);
        e.gpu.ncmds() as u32
    })
    .unwrap_or(0)
}

/// Polygon edges of page p for the wireframe overlay (PNT-6) into the arena; returns the index count.
#[unsafe(no_mangle)]
pub extern "C" fn eng_gpu_edge_page(p: u32) -> u32 {
    with_engine(|e| {
        let mesh = &e.mesh;
        if (p as usize) < e.gpu.pages.len() { e.gpu.edge_page(mesh, p as usize) as u32 } else { 0 }
    })
    .unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_gpu_arena_ptr() -> *const u8 {
    with_engine(|e| e.gpu.arena.as_ptr()).unwrap_or(std::ptr::null())
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_gpu_cmds_ptr() -> *const u32 {
    with_engine(|e| e.gpu.cmds.as_ptr()).unwrap_or(std::ptr::null())
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_positions_ptr() -> *const f32 {
    with_engine(|e| e.mesh.positions.as_ptr()).unwrap_or(std::ptr::null())
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_positions_bytes() -> u32 {
    with_engine(|e| (e.mesh.positions.len() * 4) as u32).unwrap_or(0)
}

/// Serializes the topology file into the output buffer; returns its length.
#[unsafe(no_mangle)]
pub extern "C" fn eng_topo_bytes() -> u32 {
    with_engine(|e| {
        e.out = crate::store::topo_bytes(&e.mesh);
        e.out.len() as u32
    })
    .unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_checkpoint_collect() -> u32 {
    with_engine(|e| e.checkpoint_collect() as u32).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_ckpt_ptr() -> *const u32 {
    with_engine(|e| e.ckpt_ranges.as_ptr()).unwrap_or(std::ptr::null())
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_ckpt_seq() -> u32 {
    with_engine(|e| e.ckpt_seq).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_checkpoint_failed() {
    with_engine(|e| e.checkpoint_failed());
}

/// Writes the OBJ into the output buffer; returns its length.
#[unsafe(no_mangle)]
pub extern "C" fn eng_export_obj(out_faces: *mut u32) -> u32 {
    with_engine(|e| {
        let mut buf = std::mem::take(&mut e.out);
        let compact = crate::dyntopo::compact(&e.mesh); // dyntopo slack: live triangles only
        let st = crate::objio::write_obj(compact.as_ref().unwrap_or(&e.mesh), &mut buf);
        e.out = buf;
        unsafe { *out_faces = st.faces as u32 };
        e.out.len() as u32
    })
    .unwrap_or(0)
}

/// [nverts, ntris, nleaves, npages, undo depth, redo depth, undo KiB, seq, GPU vertex KiB,
///  GPU index KiB, dropped undo steps, checkpoint-dirty leaves]
#[unsafe(no_mangle)]
pub extern "C" fn eng_stats(out: *mut u32) {
    with_engine(|e| {
        let vb: usize = e.gpu.pages.iter().map(|p| p.vertex_bytes()).sum();
        let ib: usize = e.gpu.pages.iter().map(|p| p.nindices as usize * 4).sum();
        let (live_t, live_v) = crate::dyntopo::abi::live_counts(e); // dead dyntopo slots don't count
        let v = [
            live_v,
            live_t,
            e.mesh.nleaves() as u32,
            e.gpu.pages.len() as u32,
            e.hist.undo.len() as u32,
            e.hist.redo.len() as u32,
            (e.hist.bytes() / 1024) as u32,
            e.seq,
            (vb / 1024) as u32,
            (ib / 1024) as u32,
            e.hist.dropped,
            e.dirty_leaf_count() as u32,
        ];
        for (i, x) in v.iter().enumerate() {
            unsafe { *out.add(i) = *x };
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_hash() -> u64 {
    with_engine(|e| e.mesh.position_hash()).unwrap_or(0)
}

/// Surface under a screen point: writes [x, y, z, nx, ny, nz] to the hit buffer.
#[unsafe(no_mangle)]
pub extern "C" fn eng_raycast(x: f32, y: f32) -> u32 {
    with_engine(|e| match e.raycast_screen(x, y) {
        Some(h) => {
            let s = shared();
            s.hit[..3].copy_from_slice(&h.point);
            s.hit[3..6].copy_from_slice(&h.normal);
            1
        }
        None => 0,
    })
    .unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_hit_ptr() -> *const f32 {
    shared().hit.as_ptr()
}

/// [x, y, z, nx, ny, nz, world radius] of the last dab (brush cursor).
#[unsafe(no_mangle)]
pub extern "C" fn eng_last_dab_ptr() -> *const f32 {
    with_engine(|e| e.last_dab.as_ptr()).unwrap_or(std::ptr::null())
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_bounds_ptr() -> *const f32 {
    with_engine(|e| {
        let (lo, hi) = e.mesh.bounds();
        let s = shared();
        s.bounds[..3].copy_from_slice(&lo);
        s.bounds[3..].copy_from_slice(&hi);
    });
    shared().bounds.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn eng_set_history(budget_mb: u32, max_steps: u32) {
    with_engine(|e| {
        e.hist.budget_bytes = budget_mb as usize * 1024 * 1024;
        e.hist.max_steps = max_steps.max(1) as usize;
    });
}

/// Deliberate trap for the crash-containment test (PLT-7): panic = abort = WASM trap.
#[unsafe(no_mangle)]
pub extern "C" fn eng_debug_trap() {
    panic!("debug trap requested");
}
