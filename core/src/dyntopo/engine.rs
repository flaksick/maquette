//! Dyntopo inside the engine's stroke, undo and frame paths (engine.rs calls these).

use super::{is_dead, scan_free_leaf, update_region};
use crate::engine::Engine;
use crate::gpu::Gpu;

impl Engine {
    /// Topology update for one dab (and its mirror), before the brush moves anything.
    pub(crate) fn dyntopo_dab(&mut self, c: [f32; 3], r: f32, r_px: f32) {
        let lmax = self.dyn_topo.detail.max_edge(r, r_px);
        let mirror = [-c[0], c[1], c[2]];
        let centers: &[[f32; 3]] = if self.brush.symmetry_x && c[0].abs() > 1e-6 { &[c, mirror] } else { &[c] };
        for &cc in centers {
            update_region(&mut self.mesh, &mut self.dyn_topo, &mut self.tx, &mut self.modified, cc, r, lmax);
        }
        // The brush selects right after: bounds of the leaves whose triangles changed, now.
        if !self.dyn_topo.topo_leaves.is_empty() {
            let leaves = self.dyn_topo.topo_leaves.clone();
            self.mesh.bvh.refit_leaves(&self.mesh.positions, &self.mesh.tris, &leaves);
            self.mesh.bvh.refit_internal();
        }
    }

    /// Undo / redo / a journal record rewrote these leaves' triangle slabs.
    pub(crate) fn dyntopo_restored(&mut self, leaves: &[u32]) {
        let nl = self.mesh.nleaves();
        let ready = self.dyn_topo.vfree.len() == nl;
        for &leaf in leaves {
            if ready {
                scan_free_leaf(&self.mesh, &mut self.dyn_topo, leaf as usize);
            }
            self.dyn_topo.note_leaf(leaf, nl);
            for t in self.mesh.bvh.leaf_tri_off[leaf as usize] as usize..self.mesh.bvh.leaf_tri_off[leaf as usize + 1] as usize {
                if !is_dead(&self.mesh, t) {
                    for k in 0..3 {
                        self.modified.insert(self.mesh.tris[3 * t + k]);
                    }
                }
            }
        }
        let leaves: Vec<u32> = leaves.to_vec();
        self.mesh.bvh.refit_leaves(&self.mesh.positions, &self.mesh.tris, &leaves);
        self.mesh.bvh.refit_internal();
    }

    /// GPU after triangles changed: the page layout follows the leaves (fixed), but foreign-vertex
    /// lists and index buffers changed, so every page with a changed leaf (or a changed foreign
    /// list, or moved vertices) is replaced whole. Dyntopo layouts use small pages.
    pub(crate) fn dyntopo_gpu(&mut self, dirty: &[u32]) {
        let topo = self.dyn_topo.take_topo_leaves();
        let old: Vec<Vec<u32>> = self.gpu.pages.iter().map(|p| p.foreign.clone()).collect();
        let limit = self.gpu.limit;
        self.gpu = Gpu::build_limit(&self.mesh, limit);
        let mut pages: Vec<usize> = topo.iter().chain(dirty.iter()).map(|&l| self.gpu.page_of(l as usize)).collect();
        for (p, page) in self.gpu.pages.iter().enumerate() {
            if old.get(p) != Some(&page.foreign) {
                pages.push(p);
            }
        }
        pages.sort_unstable();
        pages.dedup();
        self.gpu.full_pages(&self.mesh, &pages);
    }
}
