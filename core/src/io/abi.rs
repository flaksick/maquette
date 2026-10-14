//! C ABI for import and export (IMP-0/1/2, EXP-2), beside the engine's exports in `crate::abi`.

use super::{check, import, ImportReport, REPORT_WORDS};
use crate::abi::{install_mesh, with_engine};
use crate::mesh::EditMesh;
use std::cell::RefCell;

thread_local! {
    static REPORT: RefCell<[u32; REPORT_WORDS]> = const { RefCell::new([0; REPORT_WORDS]) };
}

/// Parses, cleans and installs a mesh file (`hint`: 0 detect, 1 OBJ, 2 STL). On success the
/// engine's mesh is replaced through `install_mesh`; on failure the engine is untouched.
/// Returns a pointer to `REPORT_WORDS` u32 words laid out as `ImportReport::to_words`: word 0 is
/// 0 when imported, else the `ImportError` code (word 2 = line).
///
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn eng_import(ptr: *const u8, len: u32, hint: u32, leaf_max: u32) -> *const u32 {
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
    let words = match import(bytes, hint) {
        Ok((tm, report)) => {
            install_mesh(EditMesh::from_trimesh(tm, leaf_max.max(16) as usize));
            report.to_words()
        }
        Err(f) => ImportReport::error_words(f.error, f.line),
    };
    REPORT.with(|r| {
        *r.borrow_mut() = words;
        r.as_ptr() as *const u32
    })
}

/// Writes a binary STL of the engine's mesh into its output buffer (millimetres: positions
/// times `scale`, Z up). Returns the byte length; `info` gets [triangles, boundary edges,
/// non-manifold edges] (boundary edges > 0: not watertight).
///
/// # Safety
/// `info` must point to 3 writable u32 slots.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn eng_export_stl(scale: f32, info: *mut u32) -> u32 {
    with_engine(|e| {
        let mut buf = std::mem::take(&mut e.out);
        let st = super::stl::write_binary(&e.mesh, scale, &mut buf);
        e.out = buf;
        unsafe {
            *info = st.triangles;
            *info.add(1) = st.boundary_edges;
            *info.add(2) = st.nonmanifold_edges;
        }
        e.out.len() as u32
    })
    .unwrap_or(0)
}

/// The mesh validator on the engine's mesh: [edges, boundary, non-manifold, inconsistent,
/// degenerate triangles, bad polygon runs, components]. Returns 1 when valid.
///
/// # Safety
/// `out` must point to 7 writable u32 slots.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn eng_mesh_check(out: *mut u32) -> u32 {
    with_engine(|e| {
        let c = check(e.mesh.nverts(), &e.mesh.tris, &e.mesh.poly_next);
        let v = [c.edges, c.boundary_edges, c.nonmanifold_edges, c.inconsistent_edges, c.degenerate_tris, c.bad_runs, c.components];
        for (i, x) in v.iter().enumerate() {
            unsafe { *out.add(i) = *x };
        }
        c.valid() as u32
    })
    .unwrap_or(0)
}
