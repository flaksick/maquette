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
