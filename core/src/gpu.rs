//! GPU mirror (ARCHITECTURE: GPU). The mesh is split into pages of <= 16 MB of vertex data in BVH
//! leaf order. A page owns one contiguous vertex-id range (leaves own contiguous ranges, pages are
//! runs of leaves) and keeps local copies of "foreign" vertices that its triangles reference.
//! Nothing persistent is duplicated in WASM memory: page data is packed into a per-frame upload
//! arena only when it changes, and the renderer copies it straight to WebGL buffers.

use crate::bvh::NONE;
use crate::mesh::EditMesh;

/// f32x3 position + snorm16x4 normal: 4-byte aligned (Metal/ANGLE vertex-fetch rule).
pub const STRIDE: usize = 20;
pub const PAGE_BYTES: usize = 16 * 1024 * 1024;
pub const PAGE_VERTS: usize = PAGE_BYTES / STRIDE;

pub const CMD_VERTEX: u32 = 0;
pub const CMD_INDEX: u32 = 1;
/// Whole-page replacement (TOP-3 dyntopo: a page whose triangles changed): the renderer re-creates
/// the page's vertex (2) / index (3) buffer from the data, whatever its previous size.
pub const CMD_VERTEX_FULL: u32 = 2;
pub const CMD_INDEX_FULL: u32 = 3;
pub const CMD_WORDS: usize = 5;

pub struct Page {
    pub leaf_start: u32,
    pub leaf_end: u32,
    pub vstart: u32,
    pub vend: u32,
    /// Sorted global ids of foreign vertices; local index = (vend - vstart) + position.
    pub foreign: Vec<u32>,
    pub nindices: u32,
}

impl Page {
    pub fn nlocal(&self) -> usize {
        (self.vend - self.vstart) as usize + self.foreign.len()
    }
    pub fn vertex_bytes(&self) -> usize {
        self.nlocal() * STRIDE
    }
    fn local(&self, v: u32) -> u32 {
        if v >= self.vstart && v < self.vend {
            v - self.vstart
        } else {
            let i = self.foreign.binary_search(&v).expect("vertex not in page");
            (self.vend - self.vstart) + i as u32
        }
    }
}

pub struct Gpu {
    pub pages: Vec<Page>,
    page_of_leaf: Vec<u32>,
    /// For each leaf: pages (other than its own) that hold copies of its vertices.
    foreign_pages_of_leaf: Vec<Vec<u32>>,
    /// Upload data for the current batch and its commands:
    /// [kind, page, dst byte offset, src byte offset in arena, byte length] per command.
    pub arena: Vec<u8>,
    pub cmds: Vec<u32>,
    page_stamp: Vec<u32>,
    stamp_id: u32,
    /// Vertex limit per page (PAGE_VERTS, or smaller for dyntopo layouts).
    pub limit: usize,
}

#[inline]
fn pack(arena: &mut Vec<u8>, mesh: &EditMesh, v: usize) {
    for k in 0..3 {
        arena.extend_from_slice(&mesh.positions[3 * v + k].to_le_bytes());
    }
    for k in 0..3 {
        let n = (mesh.normals[3 * v + k].clamp(-1.0, 1.0) * 32767.0).round() as i16;
        arena.extend_from_slice(&n.to_le_bytes());
    }
    arena.extend_from_slice(&0i16.to_le_bytes());
}

impl Gpu {
    pub fn build(mesh: &EditMesh) -> Gpu {
        Gpu::build_limit(mesh, PAGE_VERTS)
    }

    /// Page of a leaf.
    pub fn page_of(&self, leaf: usize) -> usize {
        self.page_of_leaf[leaf] as usize
    }

    /// Full contents of several pages in one batch (CMD_VERTEX_FULL / CMD_INDEX_FULL per page).
    pub fn full_pages(&mut self, mesh: &EditMesh, pages: &[usize]) {
        self.arena.clear();
        self.cmds.clear();
        for &p in pages {
            let page = &self.pages[p];
            let src = self.arena.len();
            for v in page.vstart..page.vend {
                pack(&mut self.arena, mesh, v as usize);
            }
            for &v in &page.foreign {
                pack(&mut self.arena, mesh, v as usize);
            }
            let vbytes = self.arena.len() - src;
            let isrc = self.arena.len();
            for l in page.leaf_start as usize..page.leaf_end as usize {
                for t in mesh.bvh.leaf_tri_off[l] as usize..mesh.bvh.leaf_tri_off[l + 1] as usize {
                    for k in 0..3 {
                        let local = page.local(mesh.tris[3 * t + k]);
                        self.arena.extend_from_slice(&local.to_le_bytes());
                    }
                }
            }
            let ibytes = self.arena.len() - isrc;
            self.cmd(CMD_VERTEX_FULL, p, 0, src, vbytes);
            self.cmd(CMD_INDEX_FULL, p, 0, isrc, ibytes);
        }
    }

    pub fn build_limit(mesh: &EditMesh, limit: usize) -> Gpu {
        let nleaves = mesh.nleaves();
        let mut pages = Vec::new();
        let mut page_of_leaf = vec![0u32; nleaves];
        let mut leaf = 0;
        while leaf < nleaves {
            let start = leaf;
            let vstart = mesh.leaf_range(leaf).0;
            let mut vend = vstart;
            // Leave room for foreign copies (boundary vertices) within the 16 MB budget.
            while leaf < nleaves {
                let (a, b) = mesh.leaf_range(leaf);
                debug_assert_eq!(a, vend);
                if leaf > start && (b - vstart) as f32 > limit as f32 * 0.9 {
                    break;
                }
                vend = b;
                page_of_leaf[leaf] = pages.len() as u32;
                leaf += 1;
            }
            let mut foreign = Vec::new();
            let mut nindices = 0u32;
            for l in start..leaf {
                for t in mesh.bvh.leaf_tri_off[l] as usize..mesh.bvh.leaf_tri_off[l + 1] as usize {
                    for k in 0..3 {
                        let v = mesh.tris[3 * t + k] as usize;
                        if v < vstart || v >= vend {
                            foreign.push(v as u32);
                        }
                    }
                    nindices += 3;
                }
            }
            foreign.sort_unstable();
            foreign.dedup();
            pages.push(Page {
                leaf_start: start as u32,
                leaf_end: leaf as u32,
                vstart: vstart as u32,
                vend: vend as u32,
                foreign,
                nindices,
            });
        }
        let mut foreign_pages_of_leaf = vec![Vec::new(); nleaves];
        for (p, page) in pages.iter().enumerate() {
            for &v in &page.foreign {
                let owner = mesh.leaf_of_vertex[v as usize];
                if owner != NONE {
                    let list: &mut Vec<u32> = &mut foreign_pages_of_leaf[owner as usize];
                    if list.last() != Some(&(p as u32)) && !list.contains(&(p as u32)) {
                        list.push(p as u32);
                    }
                }
            }
        }
        let np = pages.len();
        Gpu {
            pages,
            page_of_leaf,
            foreign_pages_of_leaf,
            arena: Vec::new(),
            cmds: Vec::new(),
            page_stamp: vec![0; np],
            stamp_id: 0,
            limit,
        }
    }

    pub fn ncmds(&self) -> usize {
        self.cmds.len() / CMD_WORDS
    }

    fn cmd(&mut self, kind: u32, page: usize, dst: usize, src: usize, len: usize) {
        self.cmds.extend_from_slice(&[kind, page as u32, dst as u32, src as u32, len as u32]);
    }

    /// Full contents of one page (initial upload, context loss). Replaces the batch.
    pub fn full_page(&mut self, mesh: &EditMesh, p: usize) {
        self.arena.clear();
        self.cmds.clear();
        let page = &self.pages[p];
        for v in page.vstart..page.vend {
            pack(&mut self.arena, mesh, v as usize);
        }
        for &v in &page.foreign {
            pack(&mut self.arena, mesh, v as usize);
        }
        let vbytes = self.arena.len();
        for l in page.leaf_start as usize..page.leaf_end as usize {
            for t in mesh.bvh.leaf_tri_off[l] as usize..mesh.bvh.leaf_tri_off[l + 1] as usize {
                for k in 0..3 {
                    let local = page.local(mesh.tris[3 * t + k]);
                    self.arena.extend_from_slice(&local.to_le_bytes());
                }
            }
        }
        let ibytes = self.arena.len() - vbytes;
        self.cmd(CMD_VERTEX, p, 0, 0, vbytes);
        self.cmd(CMD_INDEX, p, 0, vbytes, ibytes);
    }

    /// Packs the vertex data of changed leaves (and every foreign copy of their vertices).
    /// Adjacent leaves in one page coalesce into one command.
    pub fn update(&mut self, mesh: &EditMesh, dirty_leaves: &mut Vec<u32>) {
        self.arena.clear();
        self.cmds.clear();
        dirty_leaves.sort_unstable();
        dirty_leaves.dedup();
        self.stamp_id = self.stamp_id.wrapping_add(1).max(1);
        let mut i = 0;
        while i < dirty_leaves.len() {
            // Coalesce a run of consecutive leaves within one page.
            let first = dirty_leaves[i] as usize;
            let p = self.page_of_leaf[first] as usize;
            let mut last = first;
            while i + 1 < dirty_leaves.len()
                && dirty_leaves[i + 1] as usize == last + 1
                && self.page_of_leaf[last + 1] as usize == p
            {
                i += 1;
                last += 1;
            }
            let a = mesh.leaf_range(first).0;
            let b = mesh.leaf_range(last).1;
            let src = self.arena.len();
            for v in a..b {
                pack(&mut self.arena, mesh, v);
            }
            let vstart = self.pages[p].vstart as usize;
            self.cmd(CMD_VERTEX, p, (a - vstart) * STRIDE, src, (b - a) * STRIDE);
            for l in first..=last {
                for k in 0..self.foreign_pages_of_leaf[l].len() {
                    let q = self.foreign_pages_of_leaf[l][k] as usize;
                    self.page_stamp[q] = self.stamp_id;
                }
            }
            i += 1;
        }
        // Foreign sections are small: refresh each affected one whole.
        for q in 0..self.pages.len() {
            if self.page_stamp[q] != self.stamp_id || self.pages[q].foreign.is_empty() {
                continue;
            }
            let src = self.arena.len();
            for k in 0..self.pages[q].foreign.len() {
                let v = self.pages[q].foreign[k] as usize;
                pack(&mut self.arena, mesh, v);
            }
            let owned = (self.pages[q].vend - self.pages[q].vstart) as usize;
            let len = self.pages[q].foreign.len() * STRIDE;
            self.cmd(CMD_VERTEX, q, owned * STRIDE, src, len);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sphere::cube_sphere;

    /// Decodes a page the way the GPU sees it and checks every triangle against the mesh.
    fn check_page(mesh: &EditMesh, gpu: &mut Gpu, p: usize) {
        gpu.full_page(mesh, p);
        let vb = gpu.cmds[4] as usize;
        let ib_at = gpu.cmds[CMD_WORDS + 3] as usize;
        let page = &gpu.pages[p];
        let rd_f = |at: usize| f32::from_le_bytes(gpu.arena[at..at + 4].try_into().unwrap());
        let rd_u = |at: usize| u32::from_le_bytes(gpu.arena[at..at + 4].try_into().unwrap());
        assert_eq!(vb, page.vertex_bytes());
        let mut k = 0;
        for l in page.leaf_start as usize..page.leaf_end as usize {
            for t in mesh.bvh.leaf_tri_off[l] as usize..mesh.bvh.leaf_tri_off[l + 1] as usize {
                for c in 0..3 {
                    let local = rd_u(ib_at + 4 * k) as usize;
                    k += 1;
                    let v = mesh.tris[3 * t + c] as usize;
                    for a in 0..3 {
                        assert_eq!(rd_f(local * STRIDE + 4 * a), mesh.positions[3 * v + a]);
                    }
                }
            }
        }
        assert_eq!(k as u32, page.nindices);
    }

    #[test]
    fn pages_reproduce_every_triangle() {
        let mesh = EditMesh::from_trimesh(cube_sphere(48), 64);
        let mut gpu = Gpu::build(&mesh);
        for p in 0..gpu.pages.len() {
            check_page(&mesh, &mut gpu, p);
        }
    }

    #[test]
    fn large_mesh_splits_into_pages_with_foreign_copies() {
        let mesh = EditMesh::from_trimesh(cube_sphere(420), 1024); // ~1.06M verts
        let mut gpu = Gpu::build(&mesh);
        assert!(gpu.pages.len() >= 2);
        assert!(gpu.pages.iter().all(|p| p.vertex_bytes() <= PAGE_BYTES));
        assert!(gpu.pages.iter().any(|p| !p.foreign.is_empty()));
        check_page(&mesh, &mut gpu, 1);
    }

    #[test]
    fn update_targets_owned_ranges_and_foreign_copies() {
        let mut mesh = EditMesh::from_trimesh(cube_sphere(420), 1024);
        let mut gpu = Gpu::build(&mesh);
        // Move a vertex that some other page holds a copy of.
        let (q, fv) = gpu
            .pages
            .iter()
            .enumerate()
            .find_map(|(q, p)| p.foreign.first().map(|&v| (q, v)))
            .unwrap();
        let leaf = mesh.leaf_of_vertex[fv as usize];
        mesh.positions[3 * fv as usize] += 0.25;
        let mut dirty = vec![leaf];
        gpu.update(&mesh, &mut dirty);
        let covered = |page: usize, v: u32| {
            gpu.cmds.chunks(CMD_WORDS).any(|c| {
                let pg = &gpu.pages[c[1] as usize];
                if c[1] as usize != page {
                    return false;
                }
                let local = pg.local(v) as usize * STRIDE;
                local >= c[2] as usize && local < (c[2] + c[4]) as usize
            })
        };
        assert!(covered(gpu.page_of_leaf[leaf as usize] as usize, fv), "owner page not updated");
        assert!(covered(q, fv), "foreign copy not updated");
    }
}
