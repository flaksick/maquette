//! Voxel remesh (TOP-1): rebuilds any closed-ish triangle mesh as a closed, oriented, manifold,
//! all-quad mesh whose resolution comes from a target polycount.
//!
//! Pipeline (every stage is resumable; `Job::step` does a bounded amount of work per call):
//! 1. Holes: boundary edges are found and every boundary loop is closed with a centroid fan, so
//!    the surface the voxelizer sees is watertight (TOP-1 "fills holes").
//! 2. Area: the L1-projected area S1 = sum |n_x|+|n_y|+|n_z| over triangles predicts the surface
//!    nets quad count at voxel size h as S1/h^2, so h = sqrt(S1 / target).
//! 3. A closest-point BVH over the source (small leaves) for reprojection.
//! 4. Raster: every triangle is rasterized into the grid edges it crosses, along all three axes
//!    (2D point-in-triangle per grid line, conservative tolerance, so a line through a shared
//!    edge or vertex is always caught). Only the 8^3 bricks touched by crossings (and their -1
//!    neighbours) are allocated: the sparse band around the surface. Each crossed edge keeps the
//!    crossing nearest each end (u8 fractions).
//! 5. Flood: inside/outside by flood fill from outside over the brick grid (whole empty bricks
//!    as single nodes) and through grid edges no triangle crosses. Self-intersections merge (the
//!    union's inside is unreachable), orientation doesn't matter, nothing is ever "guessed".
//! 6. Repair: surface nets is a closed manifold iff every cell's inside corners and outside
//!    corners are each edge-connected (see lut.rs). Bad cells get outside corners turned inside
//!    (monotone, so it terminates) until every cell is good.
//! 7. Surface nets: one vertex per mixed cell at the mass point of its edge crossings, one quad
//!    per sign-changing edge, wound outward.
//! 8. Smooth: reproject to the source (closest point via the BVH), then relax tangentially and
//!    reproject again. Keep-sharp places vertices by a QEF over the crossing planes and pins the
//!    ones on edges and corners.
//! 9. Triangulate each quad along its shorter diagonal as an in-order fan (poly_next = 1, 0),
//!    then build the EditMesh incrementally (build.rs).
//!
//! Mask and color reprojection: N/A until mask (MSK-1) and color (PNT-1) attributes exist.

pub mod abi;
mod build;
mod cpbvh;
mod lut;
pub mod serial;
pub mod validate;
#[cfg(test)]
mod shapes;
#[cfg(test)]
mod tests;

use crate::math::{add, cross, dot, get3, normalize, scale, sub};
use crate::mesh::EditMesh;
use cpbvh::CpBvh;
use lut::lut;

pub use build::{mesh_bytes, Builder};

const BRICK_POINTS: usize = 512;
const F_OUT: u8 = 8;
const NONE: u32 = u32::MAX;
const EMPTY_OUT: u32 = u32::MAX - 1;
const BRICK_NODE: u32 = 1 << 31;
/// Tolerance in grid units for the conservative edge rasterizer.
const TOL: f64 = 1e-6;
/// Brick grids above this many bricks are refused (64 MB of index).
pub const MAX_BRICK_GRID: u64 = 1 << 24;
/// Bytes per allocated brick: flags, 6 crossing bytes per point, cell -> vertex index.
pub const BRICK_BYTES: u64 = (BRICK_POINTS * (1 + 6 + 4)) as u64 + 12;

/// Edges of a cell: (lower corner, upper corner, axis), corner c = x + 2y + 4z.
const CELL_EDGES: [(u8, u8, u8); 12] = [
    (0, 1, 0),
    (2, 3, 0),
    (4, 5, 0),
    (6, 7, 0),
    (0, 2, 1),
    (1, 3, 1),
    (4, 6, 1),
    (5, 7, 1),
    (0, 4, 2),
    (1, 5, 2),
    (2, 6, 2),
    (3, 7, 2),
];

#[inline]
fn corner(c: u8) -> [i32; 3] {
    [(c & 1) as i32, ((c >> 1) & 1) as i32, ((c >> 2) & 1) as i32]
}

#[derive(Clone, Copy, Debug)]
pub struct Params {
    /// Output quads to aim for (the grid resolution is derived from it).
    pub target_quads: u32,
    /// Explicit voxel size in world units; 0 = derive from `target_quads`.
    pub voxel: f32,
    /// Feature-preserving placement (QEF) and pinned feature vertices.
    pub keep_sharp: bool,
    /// Tangential relax + reproject passes after the first reprojection.
    pub relax_iters: u32,
    /// BVH leaf size of the resulting EditMesh (the app uses 1024).
    pub leaf_max: u32,
}

impl Default for Params {
    fn default() -> Params {
        Params { target_quads: 50_000, voxel: 0.0, keep_sharp: false, relax_iters: 2, leaf_max: 1024 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    EmptyMesh,
    GridTooLarge,
}

/// The surface being remeshed: the engine mesh plus fan patches over its holes.
pub struct Src<'a> {
    pos: &'a [f32],
    tris: &'a [u32],
    xpos: &'a [f32],
    xtris: &'a [u32],
}

impl Src<'_> {
    pub fn ntris(&self) -> usize {
        (self.tris.len() + self.xtris.len()) / 3
    }
    #[inline]
    fn vert(&self, v: u32) -> [f32; 3] {
        let n = self.pos.len() / 3;
        if (v as usize) < n { get3(self.pos, v as usize) } else { get3(self.xpos, v as usize - n) }
    }
    #[inline]
    pub fn tri(&self, t: usize) -> [[f32; 3]; 3] {
        let (s, i) = if 3 * t < self.tris.len() { (self.tris, 3 * t) } else { (self.xtris, 3 * t - self.tris.len()) };
        [self.vert(s[i]), self.vert(s[i + 1]), self.vert(s[i + 2])]
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Grid {
    pub origin: [f64; 3],
    pub h: f64,
    pub dims: [i32; 3],
    pub bdims: [i32; 3],
}

impl Grid {
    #[inline]
    fn bidx(&self, b: [i32; 3]) -> usize {
        (b[0] + self.bdims[0] * (b[1] + self.bdims[1] * b[2])) as usize
    }
    #[inline]
    fn bcoord(&self, i: usize) -> [i32; 3] {
        let i = i as i32;
        [i % self.bdims[0], (i / self.bdims[0]) % self.bdims[1], i / (self.bdims[0] * self.bdims[1])]
    }
    #[inline]
    fn to_grid(&self, p: [f32; 3]) -> [f64; 3] {
        [(p[0] as f64 - self.origin[0]) / self.h, (p[1] as f64 - self.origin[1]) / self.h, (p[2] as f64 - self.origin[2]) / self.h]
    }
    #[inline]
    fn to_world(&self, g: [f64; 3]) -> [f32; 3] {
        [(self.origin[0] + g[0] * self.h) as f32, (self.origin[1] + g[1] * self.h) as f32, (self.origin[2] + g[2] * self.h) as f32]
    }
    pub fn bricks(&self) -> u64 {
        self.bdims[0] as u64 * self.bdims[1] as u64 * self.bdims[2] as u64
    }

    /// Grid around [lo, hi] with voxel h: 10 points of margin, so the outer brick layer is empty.
    fn around(lo: [f32; 3], hi: [f32; 3], h: f64) -> Grid {
        let mut g = Grid { h, ..Default::default() };
        for k in 0..3 {
            g.origin[k] = lo[k] as f64 - 10.0 * h;
            let n = ((hi[k] as f64 - lo[k] as f64) / h).ceil() as i64 + 21;
            let n = (n + 7) / 8 * 8;
            g.dims[k] = n.min(i32::MAX as i64 / 2) as i32;
            g.bdims[k] = g.dims[k] / 8;
        }
        g
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Stage {
    Holes,
    Area,
    BvhInit,
    BvhSplit,
    BvhRefit,
    Raster,
    Flood,
    RepairInit,
    Repair,
    Place,
    Quads,
    Adjacency,
    Smooth,
    Triangulate,
    Build,
    Done,
}

impl Stage {
    pub fn name(self) -> &'static str {
        match self {
            Stage::Holes => "holes",
            Stage::Area => "area",
            Stage::BvhInit | Stage::BvhSplit | Stage::BvhRefit => "bvh",
            Stage::Raster => "voxelize",
            Stage::Flood => "flood",
            Stage::RepairInit | Stage::Repair => "repair",
            Stage::Place | Stage::Quads => "surface",
            Stage::Adjacency | Stage::Smooth => "smooth",
            Stage::Triangulate | Stage::Build => "build",
            Stage::Done => "done",
        }
    }
    /// Share of a typical job's time spent before this stage (progress bar).
    fn start_share(self) -> f32 {
        const W: [f32; 16] = [1.0, 1.0, 1.0, 4.0, 1.0, 8.0, 9.0, 6.0, 1.0, 8.0, 6.0, 3.0, 24.0, 2.0, 25.0, 0.0];
        let i = self as usize;
        W[..i].iter().sum::<f32>() / W.iter().sum::<f32>()
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    pub h: f32,
    pub holes: u32,
    pub fan_tris: u32,
    pub bricks: u32,
    pub flips: u32,
    pub quads: u32,
    pub verts: u32,
    pub missing: u32,
    pub features: u32,
    pub peak_bytes: u64,
    pub steps: u32,
}

pub struct Job {
    pub params: Params,
    pub stage: Stage,
    cur: usize,
    sub: usize,
    // hole fans
    xpos: Vec<f32>,
    xtris: Vec<u32>,
    bnd: Vec<[u32; 2]>,
    s1: f64,
    lo: [f32; 3],
    hi: [f32; 3],
    pub grid: Grid,
    bvh: CpBvh,
    // sparse bricks
    index: Vec<u32>,
    coord: Vec<[i32; 3]>,
    flags: Vec<u8>,
    cross: Vec<u8>,
    cellv: Vec<u32>,
    work: Vec<u32>,
    // surface
    vpos: Vec<f32>,
    vnrm: Vec<f32>,
    vfix: Vec<u8>,
    quads: Vec<u32>,
    adj_off: Vec<u32>,
    adj: Vec<u32>,
    tmp: Vec<f32>,
    builder: Option<Builder>,
    pub result: Option<EditMesh>,
    pub stats: Stats,
}

impl Job {
    pub fn new(mesh: &EditMesh, params: Params) -> Result<Job, Error> {
        if mesh.ntris() == 0 {
            return Err(Error::EmptyMesh);
        }
        Ok(Job {
            params,
            stage: Stage::Holes,
            cur: 0,
            sub: 0,
            xpos: Vec::new(),
            xtris: Vec::new(),
            bnd: Vec::new(),
            s1: 0.0,
            lo: [f32::INFINITY; 3],
            hi: [f32::NEG_INFINITY; 3],
            grid: Grid::default(),
            bvh: CpBvh::default(),
            index: Vec::new(),
            coord: Vec::new(),
            flags: Vec::new(),
            cross: Vec::new(),
            cellv: Vec::new(),
            work: Vec::new(),
            vpos: Vec::new(),
            vnrm: Vec::new(),
            vfix: Vec::new(),
            quads: Vec::new(),
            adj_off: Vec::new(),
            adj: Vec::new(),
            tmp: Vec::new(),
            builder: None,
            result: None,
            stats: Stats::default(),
        })
    }

    fn src<'a>(&'a self, m: &'a EditMesh) -> Src<'a> {
        Src { pos: &m.positions, tris: &m.tris, xpos: &self.xpos, xtris: &self.xtris }
    }

    /// Heap bytes held by the job right now (the memory ledger's view of the transient).
    pub fn heap_bytes(&self) -> u64 {
        let v = |n: usize, s: usize| (n * s) as u64;
        v(self.xpos.capacity() + self.xtris.capacity(), 4)
            + v(self.bnd.capacity(), 8)
            + self.bvh.bytes() as u64
            + v(self.index.capacity(), 4)
            + v(self.coord.capacity(), 12)
            + v(self.flags.capacity() + self.cross.capacity(), 1)
            + v(self.cellv.capacity() + self.work.capacity(), 4)
            + v(self.vpos.capacity() + self.vnrm.capacity() + self.quads.capacity() + self.adj_off.capacity() + self.adj.capacity() + self.tmp.capacity(), 4)
            + v(self.vfix.capacity(), 1)
            + self.builder.as_ref().map_or(0, |b| b.bytes() as u64)
            + self.result.as_ref().map_or(0, |m| mesh_bytes(m) as u64)
    }

    /// 0..1 for progress bars.
    pub fn progress(&self) -> f32 {
        let s = self.stage;
        if s == Stage::Done {
            return 1.0;
        }
        let next = match s {
            Stage::Done => Stage::Done,
            _ => [Stage::Area, Stage::BvhInit, Stage::BvhSplit, Stage::BvhRefit, Stage::Raster, Stage::Flood, Stage::RepairInit, Stage::Repair, Stage::Place, Stage::Quads, Stage::Adjacency, Stage::Smooth, Stage::Triangulate, Stage::Build, Stage::Done][s as usize],
        };
        let within = match s {
            Stage::Build => self.builder.as_ref().map_or(0.0, |b| b.progress()),
            Stage::Smooth => (self.sub as f32 + self.cur as f32 / (self.vpos.len() / 3).max(1) as f32) / (2 * self.params.relax_iters + 1) as f32,
            Stage::Place | Stage::Quads | Stage::RepairInit => self.cur as f32 / self.coord.len().max(1) as f32,
            _ => 0.0,
        };
        let (a, b) = (s.start_share(), next.start_share());
        a + (b - a) * within.clamp(0.0, 1.0)
    }

    /// Runs the job for about `budget` work units (calibrated so that 1 unit is roughly 10 ns
    /// natively). Returns true when the result is ready in `self.result`.
    pub fn step(&mut self, mesh: &EditMesh, budget: u64) -> bool {
        let mut left = budget.max(1) as i64;
        self.stats.steps += 1;
        while left > 0 && self.stage != Stage::Done {
            let finished = match self.stage {
                Stage::Holes => self.holes(mesh, &mut left),
                Stage::Area => self.area(mesh, &mut left),
                Stage::BvhInit => {
                    let n = self.src(mesh).ntris();
                    let end = (self.cur + (left as usize / 2).max(1)).min(n);
                    let (xp, xt) = (std::mem::take(&mut self.xpos), std::mem::take(&mut self.xtris));
                    let src = Src { pos: &mesh.positions, tris: &mesh.tris, xpos: &xp, xtris: &xt };
                    self.bvh.centroids(&src, self.cur, end);
                    self.xpos = xp;
                    self.xtris = xt;
                    left -= 2 * (end - self.cur) as i64;
                    self.cur = end;
                    if end >= n {
                        self.bvh.start_split(n);
                        true
                    } else {
                        false
                    }
                }
                Stage::BvhSplit => self.bvh.split_step(&mut left),
                Stage::BvhRefit => {
                    let (xp, xt) = (std::mem::take(&mut self.xpos), std::mem::take(&mut self.xtris));
                    let src = Src { pos: &mesh.positions, tris: &mesh.tris, xpos: &xp, xtris: &xt };
                    let done = self.bvh.refit_step(&src, &mut self.cur, &mut left);
                    self.xpos = xp;
                    self.xtris = xt;
                    done
                }
                Stage::Raster => self.raster(mesh, &mut left),
                Stage::Flood => self.flood(&mut left),
                Stage::RepairInit => self.repair_init(&mut left),
                Stage::Repair => self.repair(&mut left),
                Stage::Place => self.place(mesh, &mut left),
                Stage::Quads => self.make_quads(&mut left),
                Stage::Adjacency => self.adjacency(&mut left),
                Stage::Smooth => self.smooth(mesh, &mut left),
                Stage::Triangulate => self.triangulate(&mut left),
                Stage::Build => {
                    let b = self.builder.as_mut().unwrap();
                    if b.step(&mut left) {
                        self.result = b.take();
                        self.builder = None;
                        true
                    } else {
                        false
                    }
                }
                Stage::Done => true,
            };
            self.stats.peak_bytes = self.stats.peak_bytes.max(self.heap_bytes());
            if finished {
                self.cur = 0;
                self.sub = 0;
                self.stage = match self.stage {
                    Stage::Holes => Stage::Area,
                    Stage::Area => Stage::BvhInit,
                    Stage::BvhInit => Stage::BvhSplit,
                    Stage::BvhSplit => Stage::BvhRefit,
                    Stage::BvhRefit => Stage::Raster,
                    Stage::Raster => Stage::Flood,
                    Stage::Flood => Stage::RepairInit,
                    Stage::RepairInit => Stage::Repair,
                    Stage::Repair => Stage::Place,
                    Stage::Place => Stage::Quads,
                    Stage::Quads => Stage::Adjacency,
                    Stage::Adjacency => Stage::Smooth,
                    Stage::Smooth => Stage::Triangulate,
                    Stage::Triangulate => Stage::Build,
                    Stage::Build | Stage::Done => Stage::Done,
                };
            }
        }
        self.stage == Stage::Done
    }

    /// Runs to completion (tests, native tools).
    pub fn run(mut self, mesh: &EditMesh) -> Result<(EditMesh, Stats), Error> {
        while !self.step(mesh, 1 << 40) {}
        if self.grid.h == 0.0 {
            return Err(Error::GridTooLarge);
        }
        let stats = self.stats;
        self.result.ok_or(Error::EmptyMesh).map(|m| (m, stats))
    }

    // ---------------------------------------------------------------- 1. holes

    fn holes(&mut self, m: &EditMesh, left: &mut i64) -> bool {
        let ntri = m.ntris();
        let end = (self.cur + (*left as usize / 24).max(1)).min(ntri);
        for t in self.cur..end {
            for k in 0..3 {
                let a = m.tris[3 * t + k];
                let b = m.tris[3 * t + (k + 1) % 3];
                let mut shared = false;
                for &t2 in &m.topo.vt[m.topo.vt_off[a as usize] as usize..m.topo.vt_off[a as usize + 1] as usize] {
                    if t2 as usize != t && m.tris[3 * t2 as usize..3 * t2 as usize + 3].contains(&b) {
                        shared = true;
                        break;
                    }
                }
                if !shared {
                    self.bnd.push([a, b]);
                }
            }
        }
        *left -= 24 * (end - self.cur) as i64;
        self.cur = end;
        if end < ntri {
            return false;
        }
        self.fill_holes(m);
        true
    }

    /// Closes every boundary loop with a fan around its centroid (one new vertex per loop).
    fn fill_holes(&mut self, m: &EditMesh) {
        if self.bnd.is_empty() {
            return;
        }
        let mut bnd = std::mem::take(&mut self.bnd);
        bnd.sort_unstable();
        let mut used = vec![false; bnd.len()];
        let nv = m.nverts() as u32;
        let next_from = |v: u32, used: &[bool]| -> Option<usize> {
            let start = bnd.partition_point(|e| e[0] < v);
            (start..bnd.len()).take_while(|&i| bnd[i][0] == v).find(|&i| !used[i])
        };
        let mut lp: Vec<u32> = Vec::new();
        for e0 in 0..bnd.len() {
            if used[e0] {
                continue;
            }
            used[e0] = true;
            lp.clear();
            lp.push(bnd[e0][0]);
            let mut v = bnd[e0][1];
            let mut closed = false;
            while lp.len() <= bnd.len() {
                if v == bnd[e0][0] {
                    closed = true;
                    break;
                }
                let Some(i) = next_from(v, &used) else { break };
                used[i] = true;
                lp.push(v);
                v = bnd[i][1];
            }
            if !closed || lp.len() < 3 {
                continue;
            }
            let mut c = [0.0f64; 3];
            for &w in &lp {
                let p = get3(&m.positions, w as usize);
                for k in 0..3 {
                    c[k] += p[k] as f64;
                }
            }
            let inv = 1.0 / lp.len() as f64;
            let cid = nv + (self.xpos.len() / 3) as u32;
            self.xpos.extend_from_slice(&[(c[0] * inv) as f32, (c[1] * inv) as f32, (c[2] * inv) as f32]);
            for i in 0..lp.len() {
                let (a, b) = (lp[i], lp[(i + 1) % lp.len()]);
                // Boundary half-edge a->b belongs to the mesh; the fan walks it b->a.
                self.xtris.extend_from_slice(&[b, a, cid]);
            }
            self.stats.holes += 1;
        }
        self.stats.fan_tris = (self.xtris.len() / 3) as u32;
        self.bnd = Vec::new();
    }

    // ---------------------------------------------------------------- 2. area -> grid

    fn area(&mut self, m: &EditMesh, left: &mut i64) -> bool {
        let n = self.src(m).ntris();
        let end = (self.cur + (*left as usize / 4).max(1)).min(n);
        let mut s1 = 0.0f64;
        let (mut lo, mut hi) = (self.lo, self.hi);
        {
            let src = self.src(m);
            for t in self.cur..end {
                let [a, b, c] = src.tri(t);
                let nrm = cross(sub(b, a), sub(c, a));
                s1 += 0.5 * (nrm[0].abs() + nrm[1].abs() + nrm[2].abs()) as f64;
                for p in [a, b, c] {
                    for k in 0..3 {
                        lo[k] = lo[k].min(p[k]);
                        hi[k] = hi[k].max(p[k]);
                    }
                }
            }
        }
        self.s1 += s1;
        self.lo = lo;
        self.hi = hi;
        *left -= 4 * (end - self.cur) as i64;
        self.cur = end;
        if end < n {
            return false;
        }
        let h = voxel_size(self.s1, self.params);
        let grid = Grid::around(self.lo, self.hi, h);
        if !(h > 0.0) || grid.bricks() > MAX_BRICK_GRID || grid.dims.iter().any(|&d| d >= (1 << 20)) {
            // Refused: the estimate says so up front; reaching here means a caller skipped it.
            self.grid = Grid::default();
            self.stage = Stage::Done;
            return false;
        }
        self.grid = grid;
        self.stats.h = h as f32;
        self.index = vec![NONE; grid.bricks() as usize];
        true
    }

    // ---------------------------------------------------------------- 4. raster

    fn ensure_box(&mut self, lo: [i32; 3], hi: [i32; 3]) {
        let (blo, bhi) = ([lo[0] >> 3, lo[1] >> 3, lo[2] >> 3], [hi[0] >> 3, hi[1] >> 3, hi[2] >> 3]);
        for bz in blo[2]..=bhi[2] {
            for by in blo[1]..=bhi[1] {
                for bx in blo[0]..=bhi[0] {
                    let b = [bx, by, bz];
                    if (0..3).any(|k| b[k] < 0 || b[k] >= self.grid.bdims[k]) {
                        continue;
                    }
                    let i = self.grid.bidx(b);
                    let state = self.index[i];
                    if state == NONE || state == EMPTY_OUT {
                        self.alloc(i, b, state == EMPTY_OUT);
                    }
                }
            }
        }
    }

    fn alloc(&mut self, bidx: usize, b: [i32; 3], out: bool) {
        let slot = self.coord.len();
        self.index[bidx] = slot as u32;
        self.coord.push(b);
        self.flags.resize(self.flags.len() + BRICK_POINTS, if out { F_OUT } else { 0 });
        self.cross.reserve(6 * BRICK_POINTS);
        for _ in 0..BRICK_POINTS * 3 {
            self.cross.extend_from_slice(&[255, 0]);
        }
        if !self.cellv.is_empty() {
            self.cellv.resize(self.cellv.len() + BRICK_POINTS, NONE);
        }
        self.stats.bricks = self.coord.len() as u32;
    }

    /// Flat index of a point in an allocated brick.
    #[inline]
    fn pidx(&self, p: [i32; 3]) -> Option<usize> {
        if (0..3).any(|k| p[k] < 0 || p[k] >= self.grid.dims[k]) {
            return None;
        }
        let s = self.index[self.grid.bidx([p[0] >> 3, p[1] >> 3, p[2] >> 3])];
        if s >= EMPTY_OUT {
            return None;
        }
        Some(s as usize * BRICK_POINTS + local(p))
    }

    #[inline]
    fn is_out(&self, p: [i32; 3]) -> bool {
        if (0..3).any(|k| p[k] < 0 || p[k] >= self.grid.dims[k]) {
            return true;
        }
        let s = self.index[self.grid.bidx([p[0] >> 3, p[1] >> 3, p[2] >> 3])];
        if s == NONE {
            false
        } else if s == EMPTY_OUT {
            true
        } else {
            self.flags[s as usize * BRICK_POINTS + local(p)] & F_OUT != 0
        }
    }

    fn mark(&mut self, a: usize, p: [i32; 3], t: f64) {
        let mut hi = p;
        hi[a] += 1;
        self.ensure_box([p[0] - 1, p[1] - 1, p[2] - 1], hi);
        let Some(i) = self.pidx(p) else { return };
        self.flags[i] |= 1 << a;
        let q = (t.clamp(0.0, 1.0) * 255.0).round() as u8;
        let c = &mut self.cross[6 * i + 2 * a..6 * i + 2 * a + 2];
        c[0] = c[0].min(q);
        c[1] = c[1].max(q);
    }

    fn raster(&mut self, m: &EditMesh, left: &mut i64) -> bool {
        let n = self.src(m).ntris();
        while self.cur < n {
            let tri = self.src(m).tri(self.cur);
            let g = [self.grid.to_grid(tri[0]), self.grid.to_grid(tri[1]), self.grid.to_grid(tri[2])];
            *left -= self.raster_tri(g) as i64 + 4;
            self.cur += 1;
            if *left <= 0 {
                break;
            }
        }
        if self.cur < n {
            return false;
        }
        true
    }

    /// Marks every grid edge the triangle crosses, along all three axes. Returns lines tested.
    fn raster_tri(&mut self, p: [[f64; 3]; 3]) -> u64 {
        let e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
        let e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
        let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        let nn = n[0].abs() + n[1].abs() + n[2].abs();
        if !(nn > 1e-300) {
            return 0;
        }
        let mut tested = 0u64;
        for a in 0..3 {
            let (b, c) = ((a + 1) % 3, (a + 2) % 3);
            let na = n[a];
            if na.abs() <= 1e-12 * nn {
                continue; // parallel to the axis: its lines run along the plane, never through it
            }
            let s = na.signum();
            let (mut umin, mut umax, mut vmin, mut vmax) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
            let (mut amin, mut amax) = (f64::INFINITY, f64::NEG_INFINITY);
            for q in &p {
                umin = umin.min(q[b]);
                umax = umax.max(q[b]);
                vmin = vmin.min(q[c]);
                vmax = vmax.max(q[c]);
                amin = amin.min(q[a]);
                amax = amax.max(q[a]);
            }
            let (u0, u1) = ((umin - TOL).ceil() as i32, (umax + TOL).floor() as i32);
            let (v0, v1) = ((vmin - TOL).ceil() as i32, (vmax + TOL).floor() as i32);
            if u0 > u1 || v0 > v1 {
                continue;
            }
            // Edge functions in the (b, c) plane, scaled by the triangle's orientation there.
            let mut ed = [[0.0f64; 4]; 3]; // du, dv, u_i, v_i
            let mut tol = [0.0f64; 3];
            for i in 0..3 {
                let (pi, pj) = (p[i], p[(i + 1) % 3]);
                ed[i] = [pj[b] - pi[b], pj[c] - pi[c], pi[b], pi[c]];
                tol[i] = TOL * (ed[i][0] * ed[i][0] + ed[i][1] * ed[i][1]).sqrt();
            }
            for jv in v0..=v1 {
                for ju in u0..=u1 {
                    tested += 1;
                    let (u, v) = (ju as f64, jv as f64);
                    let mut inside = true;
                    for i in 0..3 {
                        let e = s * (ed[i][0] * (v - ed[i][3]) - ed[i][1] * (u - ed[i][2]));
                        if e < -tol[i] {
                            inside = false;
                            break;
                        }
                    }
                    if !inside {
                        continue;
                    }
                    let x = p[0][a] - (n[b] * (u - p[0][b]) + n[c] * (v - p[0][c])) / na;
                    let x = x.clamp(amin, amax);
                    let (i0, i1) = ((x - TOL).floor() as i32, (x + TOL).floor() as i32);
                    for i in i0..=i1 {
                        let mut pt = [0i32; 3];
                        pt[a] = i;
                        pt[b] = ju;
                        pt[c] = jv;
                        self.mark(a, pt, x - i as f64);
                    }
                }
            }
        }
        tested
    }

    // ---------------------------------------------------------------- 5. flood

    fn flood(&mut self, left: &mut i64) -> bool {
        if self.cur == 0 {
            self.cur = 1;
            self.work.clear();
            // The outer brick layer is empty by construction (10-point margin).
            if self.index[0] == NONE {
                self.index[0] = EMPTY_OUT;
                self.work.push(BRICK_NODE);
            }
        }
        while let Some(node) = self.work.pop() {
            if node & BRICK_NODE != 0 {
                self.flood_brick((node & !BRICK_NODE) as usize);
                *left -= 64;
            } else {
                self.flood_point(node as usize);
                *left -= 1;
            }
            if *left <= 0 {
                break;
            }
        }
        self.work.is_empty()
    }

    fn flood_brick(&mut self, bi: usize) {
        let b = self.grid.bcoord(bi);
        for a in 0..3 {
            for dir in [-1i32, 1] {
                let mut nb = b;
                nb[a] += dir;
                if nb[a] < 0 || nb[a] >= self.grid.bdims[a] {
                    continue;
                }
                let ni = self.grid.bidx(nb);
                let s = self.index[ni];
                if s == NONE {
                    self.index[ni] = EMPTY_OUT;
                    self.work.push(BRICK_NODE | ni as u32);
                } else if s != EMPTY_OUT {
                    // The face of the allocated neighbour that touches this empty brick: no
                    // crossing can touch an empty brick, so those edges are all open.
                    let fixed = if dir > 0 { 0 } else { 7 };
                    let (b2, c2) = ((a + 1) % 3, (a + 2) % 3);
                    for j in 0..8 {
                        for k in 0..8 {
                            let mut l = [0i32; 3];
                            l[a] = fixed;
                            l[b2] = j;
                            l[c2] = k;
                            let i = s as usize * BRICK_POINTS + (l[0] + 8 * (l[1] + 8 * l[2])) as usize;
                            if self.flags[i] & F_OUT == 0 {
                                self.flags[i] |= F_OUT;
                                self.work.push(i as u32);
                            }
                        }
                    }
                }
            }
        }
    }

    fn flood_point(&mut self, i: usize) {
        let slot = i / BRICK_POINTS;
        let l = (i % BRICK_POINTS) as i32;
        let lc = [l & 7, (l >> 3) & 7, l >> 6];
        let base = self.coord[slot];
        let p = [base[0] * 8 + lc[0], base[1] * 8 + lc[1], base[2] * 8 + lc[2]];
        let f = self.flags[i];
        for a in 0..3 {
            let stride = [1usize, 8, 64][a];
            for dir in [-1i32, 1] {
                let mut q = p;
                q[a] += dir;
                let same = if dir > 0 { lc[a] < 7 } else { lc[a] > 0 };
                if same {
                    let j = if dir > 0 { i + stride } else { i - stride };
                    let blocked = if dir > 0 { f & (1 << a) != 0 } else { self.flags[j] & (1 << a) != 0 };
                    if !blocked && self.flags[j] & F_OUT == 0 {
                        self.flags[j] |= F_OUT;
                        self.work.push(j as u32);
                    }
                    continue;
                }
                if (0..3).any(|k| q[k] < 0 || q[k] >= self.grid.dims[k]) {
                    continue;
                }
                let bi = self.grid.bidx([q[0] >> 3, q[1] >> 3, q[2] >> 3]);
                let s = self.index[bi];
                if s == NONE {
                    // An empty brick: nothing crosses into it.
                    if dir > 0 && f & (1 << a) != 0 {
                        continue;
                    }
                    self.index[bi] = EMPTY_OUT;
                    self.work.push(BRICK_NODE | bi as u32);
                } else if s != EMPTY_OUT {
                    let j = s as usize * BRICK_POINTS + local(q);
                    let blocked = if dir > 0 { f & (1 << a) != 0 } else { self.flags[j] & (1 << a) != 0 };
                    if !blocked && self.flags[j] & F_OUT == 0 {
                        self.flags[j] |= F_OUT;
                        self.work.push(j as u32);
                    }
                }
            }
        }
    }

    // ---------------------------------------------------------------- 6. repair

    #[inline]
    fn cell_mask(&self, p: [i32; 3]) -> u8 {
        let mut m = 0u8;
        if let Some(i) = self.pidx(p) {
            let l = i % BRICK_POINTS;
            let (lx, ly, lz) = (l & 7, (l >> 3) & 7, l >> 6);
            if lx < 7 && ly < 7 && lz < 7 {
                for (c, off) in [0usize, 1, 8, 9, 64, 65, 72, 73].iter().enumerate() {
                    if self.flags[i + off] & F_OUT == 0 {
                        m |= 1 << c;
                    }
                }
                return m;
            }
        }
        for c in 0..8u8 {
            let o = corner(c);
            if !self.is_out([p[0] + o[0], p[1] + o[1], p[2] + o[2]]) {
                m |= 1 << c;
            }
        }
        m
    }

    fn point_of(&self, i: usize) -> [i32; 3] {
        let slot = i / BRICK_POINTS;
        let l = (i % BRICK_POINTS) as i32;
        let b = self.coord[slot];
        [b[0] * 8 + (l & 7), b[1] * 8 + ((l >> 3) & 7), b[2] * 8 + (l >> 6)]
    }

    fn repair_init(&mut self, left: &mut i64) -> bool {
        if self.cur == 0 {
            self.work.clear();
            self.work.shrink_to(1 << 16);
        }
        let good = &lut().good;
        while self.cur < self.coord.len() {
            let slot = self.cur;
            for l in 0..BRICK_POINTS {
                let p = self.point_of(slot * BRICK_POINTS + l);
                let m = self.cell_mask(p);
                if !good[m as usize] {
                    self.work.push((slot * BRICK_POINTS + l) as u32);
                }
            }
            *left -= 600;
            self.cur += 1;
            if *left <= 0 {
                break;
            }
        }
        self.cur >= self.coord.len()
    }

    fn repair(&mut self, left: &mut i64) -> bool {
        let t = lut();
        while let Some(cell) = self.work.pop() {
            let p = self.point_of(cell as usize);
            let m = self.cell_mask(p);
            *left -= 4;
            if !t.good[m as usize] {
                let o = corner(t.fix[m as usize]);
                self.flip_in([p[0] + o[0], p[1] + o[1], p[2] + o[2]]);
            }
            if *left <= 0 {
                break;
            }
        }
        self.work.is_empty()
    }

    /// Turns an outside point inside and queues the 8 cells around it for re-checking.
    fn flip_in(&mut self, q: [i32; 3]) {
        if (0..3).any(|k| q[k] < 1 || q[k] >= self.grid.dims[k] - 1) {
            return; // the grid's outer layer stays outside (never happens: 10-point margin)
        }
        self.ensure_box([q[0] - 1, q[1] - 1, q[2] - 1], q);
        let i = self.pidx(q).unwrap();
        self.flags[i] &= !F_OUT;
        self.stats.flips += 1;
        for c in 0..8u8 {
            let o = corner(c);
            if let Some(j) = self.pidx([q[0] - o[0], q[1] - o[1], q[2] - o[2]]) {
                self.work.push(j as u32);
            }
        }
    }

    // ---------------------------------------------------------------- 7. surface nets

    /// Crossing parameter on the edge from `lower` along `a`: the crossing nearest the outside
    /// end (the boundary of the union), or the midpoint if the edge only changed by repair.
    fn crossing(&self, lower: [i32; 3], a: usize, lower_out: bool) -> f64 {
        if let Some(i) = self.pidx(lower) {
            let (tmin, tmax) = (self.cross[6 * i + 2 * a], self.cross[6 * i + 2 * a + 1]);
            if tmin <= tmax {
                return if lower_out { tmin } else { tmax } as f64 / 255.0;
            }
        }
        0.5
    }

    fn place(&mut self, m: &EditMesh, left: &mut i64) -> bool {
        if self.cur == 0 {
            self.work = Vec::new();
            self.cellv = vec![NONE; self.coord.len() * BRICK_POINTS];
        }
        let keep_sharp = self.params.keep_sharp;
        while self.cur < self.coord.len() {
            let slot = self.cur;
            for l in 0..BRICK_POINTS {
                let p = self.point_of(slot * BRICK_POINTS + l);
                let mask = self.cell_mask(p);
                if mask == 0 || mask == 255 {
                    continue;
                }
                let mut pts = [[0.0f64; 3]; 12];
                let mut n = 0;
                for &(c0, c1, a) in &CELL_EDGES {
                    let (in0, in1) = (mask >> c0 & 1, mask >> c1 & 1);
                    if in0 == in1 {
                        continue;
                    }
                    let o = corner(c0);
                    let lower = [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
                    let t = self.crossing(lower, a as usize, in0 == 0);
                    let mut g = [lower[0] as f64, lower[1] as f64, lower[2] as f64];
                    g[a as usize] += t;
                    pts[n] = g;
                    n += 1;
                }
                let mut mass = [0.0f64; 3];
                for q in &pts[..n] {
                    for k in 0..3 {
                        mass[k] += q[k];
                    }
                }
                for v in mass.iter_mut() {
                    *v /= n as f64;
                }
                let (pos, fixed) = if keep_sharp { self.qef(m, p, &pts[..n], mass) } else { (mass, false) };
                let vi = (self.vpos.len() / 3) as u32;
                let w = self.grid.to_world(pos);
                self.vpos.extend_from_slice(&w);
                self.vfix.push(fixed as u8);
                self.stats.features += fixed as u32;
                self.cellv[slot * BRICK_POINTS + l] = vi;
                *left -= 16;
            }
            *left -= 300;
            self.cur += 1;
            if *left <= 0 {
                break;
            }
        }
        if self.cur < self.coord.len() {
            return false;
        }
        self.stats.verts = (self.vpos.len() / 3) as u32;
        true
    }

    /// Keep-sharp vertex placement: least-squares point of the tangent planes at the cell's
    /// crossings (normals from the source), solved around the mass point with small singular
    /// values dropped (dual contouring's QEF). Returns (grid position, pinned-feature?).
    fn qef(&self, m: &EditMesh, cell: [i32; 3], pts: &[[f64; 3]], mass: [f64; 3]) -> ([f64; 3], bool) {
        let src = self.src(m);
        let h = self.grid.h;
        let mut ata = [[0.0f64; 3]; 3];
        let mut atb = [0.0f64; 3];
        let mut normals: Vec<[f64; 3]> = Vec::with_capacity(pts.len());
        for q in pts {
            let w = self.grid.to_world(*q);
            let Some((t, _, _)) = self.bvh.closest(&src, w, (h * h) as f32) else { continue };
            let [a, b, c] = src.tri(t as usize);
            let nf = normalize(cross(sub(b, a), sub(c, a)));
            let nd = [nf[0] as f64, nf[1] as f64, nf[2] as f64];
            normals.push(nd);
            let d = nd[0] * (q[0] - mass[0]) + nd[1] * (q[1] - mass[1]) + nd[2] * (q[2] - mass[2]);
            for r in 0..3 {
                for s in 0..3 {
                    ata[r][s] += nd[r] * nd[s];
                }
                atb[r] += nd[r] * d;
            }
        }
        if normals.len() < 2 {
            return (mass, false);
        }
        let (vals, vecs) = jacobi_eigen(ata);
        let vmax = vals.iter().cloned().fold(0.0f64, f64::max);
        let mut x = [0.0f64; 3];
        let mut rank = 0;
        for k in 0..3 {
            if vals[k] > 0.1 * vmax && vals[k] > 1e-12 {
                rank += 1;
                let v = [vecs[0][k], vecs[1][k], vecs[2][k]];
                let proj = v[0] * atb[0] + v[1] * atb[1] + v[2] * atb[2];
                for r in 0..3 {
                    x[r] += v[r] * proj / vals[k];
                }
            }
        }
        let pos = [mass[0] + x[0], mass[1] + x[1], mass[2] + x[2]];
        // Keep the vertex inside its cell (slightly grown); otherwise the mass point.
        let inside = (0..3).all(|k| pos[k] >= cell[k] as f64 - 0.25 && pos[k] <= cell[k] as f64 + 1.25);
        if !inside {
            return (mass, false);
        }
        (pos, rank >= 2)
    }

    fn cell_vertex(&self, c: [i32; 3]) -> u32 {
        self.pidx(c).map_or(NONE, |i| self.cellv[i])
    }

    fn make_quads(&mut self, left: &mut i64) -> bool {
        while self.cur < self.coord.len() {
            let slot = self.cur;
            for l in 0..BRICK_POINTS {
                let i = slot * BRICK_POINTS + l;
                let p = self.point_of(i);
                let out0 = self.flags[i] & F_OUT != 0;
                for a in 0..3usize {
                    let mut q = p;
                    q[a] += 1;
                    if self.is_out(q) == out0 {
                        continue;
                    }
                    let (b, c) = ((a + 1) % 3, (a + 2) % 3);
                    let mut pb = p;
                    pb[b] -= 1;
                    let mut pbc = pb;
                    pbc[c] -= 1;
                    let mut pc = p;
                    pc[c] -= 1;
                    let v = [self.cell_vertex(p), self.cell_vertex(pb), self.cell_vertex(pbc), self.cell_vertex(pc)];
                    if v.contains(&NONE) {
                        self.stats.missing += 1;
                        continue;
                    }
                    if !out0 {
                        self.quads.extend_from_slice(&[v[0], v[1], v[2], v[3]]);
                    } else {
                        self.quads.extend_from_slice(&[v[0], v[3], v[2], v[1]]);
                    }
                }
            }
            *left -= 900;
            self.cur += 1;
            if *left <= 0 {
                break;
            }
        }
        if self.cur < self.coord.len() {
            return false;
        }
        self.stats.quads = (self.quads.len() / 4) as u32;
        // Bricks are no longer needed: free them before the mesh grows.
        self.flags = Vec::new();
        self.cross = Vec::new();
        self.cellv = Vec::new();
        self.index = Vec::new();
        self.coord = Vec::new();
        true
    }

    // ---------------------------------------------------------------- 8. smooth

    fn adjacency(&mut self, left: &mut i64) -> bool {
        let nv = self.vpos.len() / 3;
        let nq = self.quads.len() / 4;
        // Each closed-manifold edge appears once per direction, so "next corner" = one neighbour.
        self.adj_off = vec![0u32; nv + 1];
        for q in self.quads.chunks_exact(4) {
            for &v in q {
                self.adj_off[v as usize + 1] += 1;
            }
        }
        for v in 0..nv {
            self.adj_off[v + 1] += self.adj_off[v];
        }
        let mut fill = self.adj_off.clone();
        self.adj = vec![0u32; 4 * nq];
        for q in self.quads.chunks_exact(4) {
            for k in 0..4 {
                let v = q[k] as usize;
                self.adj[fill[v] as usize] = q[(k + 1) % 4];
                fill[v] += 1;
            }
        }
        self.vnrm = vec![0.0; 3 * nv];
        self.tmp = vec![0.0; 3 * nv];
        *left -= (4 * nq + nv) as i64;
        true
    }

    /// Passes: 0 = reproject; then (relax, reproject) x relax_iters.
    fn smooth(&mut self, m: &EditMesh, left: &mut i64) -> bool {
        let nv = self.vpos.len() / 3;
        let passes = 1 + 2 * self.params.relax_iters as usize;
        let h = self.grid.h as f32;
        let (xp, xt) = (std::mem::take(&mut self.xpos), std::mem::take(&mut self.xtris));
        let src = Src { pos: &m.positions, tris: &m.tris, xpos: &xp, xtris: &xt };
        while self.sub < passes {
            let relax = self.sub % 2 == 1;
            while self.cur < nv {
                let v = self.cur;
                self.cur += 1;
                if self.vfix[v] != 0 {
                    continue;
                }
                let p = get3(&self.vpos, v);
                if relax {
                    let (s, e) = (self.adj_off[v] as usize, self.adj_off[v + 1] as usize);
                    let n = get3(&self.vnrm, v);
                    let mut avg = [0.0f32; 3];
                    // Relax smooth regions only: where the source normals around the vertex
                    // disagree (an edge or corner), relaxing would widen the voxel chamfer.
                    let mut smooth = true;
                    for &w in &self.adj[s..e] {
                        avg = add(avg, get3(&self.vpos, w as usize));
                        smooth &= dot(n, get3(&self.vnrm, w as usize)) > 0.7;
                    }
                    let q = if smooth {
                        let mut d = sub(scale(avg, 1.0 / (e - s).max(1) as f32), p);
                        d = sub(d, scale(n, dot(d, n)));
                        add(p, scale(d, 0.5))
                    } else {
                        p
                    };
                    self.tmp[3 * v..3 * v + 3].copy_from_slice(&q);
                    *left -= 2;
                } else {
                    if let Some((t, q, _)) = self.bvh.closest(&src, p, 4.0 * h * h) {
                        let [a, b, c] = src.tri(t as usize);
                        let n = normalize(cross(sub(b, a), sub(c, a)));
                        self.vpos[3 * v..3 * v + 3].copy_from_slice(&q);
                        self.vnrm[3 * v..3 * v + 3].copy_from_slice(&n);
                    }
                    *left -= 40;
                }
                if *left <= 0 {
                    break;
                }
            }
            if self.cur < nv {
                break;
            }
            if relax {
                // Pinned vertices keep their place; everyone else takes the relaxed position.
                for v in 0..nv {
                    if self.vfix[v] == 0 {
                        let q = get3(&self.tmp, v);
                        self.vpos[3 * v..3 * v + 3].copy_from_slice(&q);
                    }
                }
            }
            self.cur = 0;
            self.sub += 1;
            if *left <= 0 {
                break;
            }
        }
        self.xpos = xp;
        self.xtris = xt;
        if self.sub < passes {
            return false;
        }
        self.adj = Vec::new();
        self.adj_off = Vec::new();
        self.tmp = Vec::new();
        self.vnrm = Vec::new();
        true
    }

    // ---------------------------------------------------------------- 9. triangulate + build

    fn triangulate(&mut self, left: &mut i64) -> bool {
        let nq = self.quads.len() / 4;
        let mut tris = Vec::with_capacity(6 * nq);
        let mut pn = Vec::with_capacity(2 * nq);
        for q in self.quads.chunks_exact(4) {
            let p: [[f32; 3]; 4] = [get3(&self.vpos, q[0] as usize), get3(&self.vpos, q[1] as usize), get3(&self.vpos, q[2] as usize), get3(&self.vpos, q[3] as usize)];
            let d02 = sub(p[2], p[0]);
            let d13 = sub(p[3], p[1]);
            let r = if dot(d13, d13) < dot(d02, d02) { 1 } else { 0 };
            let (v0, v1, v2, v3) = (q[r], q[(r + 1) % 4], q[(r + 2) % 4], q[(r + 3) % 4]);
            tris.extend_from_slice(&[v0, v1, v2, v0, v2, v3]);
            pn.extend_from_slice(&[1, 0]);
        }
        *left -= 2 * nq as i64;
        let pos = std::mem::take(&mut self.vpos);
        self.quads = Vec::new();
        self.vfix = Vec::new();
        self.builder = Some(Builder::new(pos, tris, pn, self.params.leaf_max as usize));
        true
    }
}

#[inline]
fn local(p: [i32; 3]) -> usize {
    ((p[0] & 7) + 8 * ((p[1] & 7) + 8 * (p[2] & 7))) as usize
}

/// Voxel size for a source with L1-projected area `s1`.
fn voxel_size(s1: f64, params: Params) -> f64 {
    if params.voxel > 0.0 {
        return params.voxel as f64;
    }
    (s1 / params.target_quads.max(1) as f64).sqrt()
}

/// Symmetric 3x3 eigen-decomposition by cyclic Jacobi rotations: (values, column vectors).
fn jacobi_eigen(mut a: [[f64; 3]; 3]) -> ([f64; 3], [[f64; 3]; 3]) {
    let mut v = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for _ in 0..12 {
        let off = a[0][1].abs() + a[0][2].abs() + a[1][2].abs();
        if off < 1e-14 {
            break;
        }
        for (p, q) in [(0usize, 1usize), (0, 2), (1, 2)] {
            if a[p][q].abs() < 1e-18 {
                continue;
            }
            let theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
            let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
            let t = if theta == 0.0 { 1.0 } else { t };
            let c = 1.0 / (t * t + 1.0).sqrt();
            let s = t * c;
            for k in 0..3 {
                let (akp, akq) = (a[k][p], a[k][q]);
                a[k][p] = c * akp - s * akq;
                a[k][q] = s * akp + c * akq;
            }
            for k in 0..3 {
                let (apk, aqk) = (a[p][k], a[q][k]);
                a[p][k] = c * apk - s * aqk;
                a[q][k] = s * apk + c * aqk;
            }
            for k in 0..3 {
                let (vkp, vkq) = (v[k][p], v[k][q]);
                v[k][p] = c * vkp - s * vkq;
                v[k][q] = s * vkp + c * vkq;
            }
        }
    }
    ([a[0][0], a[1][1], a[2][2]], v)
}

// ------------------------------------------------------------------ pre-flight estimate

/// What a remesh will cost, before it runs (invariant 6: refuse up front with the numbers).
#[derive(Clone, Copy, Debug, Default)]
pub struct Estimate {
    pub h: f32,
    pub quads: u64,
    pub verts: u64,
    /// Bytes of the resulting engine mesh (EditMesh + engine side tables + GPU mirror).
    pub steady_bytes: u64,
    /// Peak bytes the job adds while it runs (sparse bricks, BVH, smoothing, builder).
    pub transient_bytes: u64,
    /// Bytes of the undo snapshot of the current mesh (topology + positions).
    pub undo_bytes: u64,
    pub bricks: u64,
    pub grid_ok: bool,
}

/// Source measurements the estimate needs (cached by the caller between slider moves).
#[derive(Clone, Copy, Debug, Default)]
pub struct SourceInfo {
    pub s1: f64,
    pub lo: [f32; 3],
    pub hi: [f32; 3],
    pub ntris: u64,
    pub nverts: u64,
    pub snapshot_bytes: u64,
}

pub fn source_info(m: &EditMesh) -> SourceInfo {
    let mut s = SourceInfo { lo: [f32::INFINITY; 3], hi: [f32::NEG_INFINITY; 3], ntris: m.ntris() as u64, nverts: m.nverts() as u64, ..Default::default() };
    for t in m.tris.chunks_exact(3) {
        let (a, b, c) = (get3(&m.positions, t[0] as usize), get3(&m.positions, t[1] as usize), get3(&m.positions, t[2] as usize));
        let n = cross(sub(b, a), sub(c, a));
        s.s1 += 0.5 * (n[0].abs() + n[1].abs() + n[2].abs()) as f64;
    }
    for v in 0..m.nverts() {
        let p = get3(&m.positions, v);
        for k in 0..3 {
            s.lo[k] = s.lo[k].min(p[k]);
            s.hi[k] = s.hi[k].max(p[k]);
        }
    }
    s.snapshot_bytes = serial::topo_len(m) as u64 + 12 * m.nverts() as u64;
    s
}

/// Engine-side bytes per vertex and per triangle of an installed mesh, from the structures
/// (EditMesh arrays, engine stamp sets, GPU mirror upload sizes): see `top1_estimate_bounds_actual`.
pub const ENGINE_BYTES_PER_VERT: u64 = 12 + 12 + 4 + 4 + 4 + 4 + 28 + 4 + 4 + 8 + 8 + 4 + 20;
pub const ENGINE_BYTES_PER_TRI: u64 = 12 + 1 + 4 + 12 + 4 + 12;

pub fn estimate(info: &SourceInfo, params: Params) -> Estimate {
    let h = voxel_size(info.s1, params);
    let grid = Grid::around(info.lo, info.hi, h);
    let quads = (info.s1 / (h * h)).ceil() as u64;
    let verts = quads + 2;
    let tris = 2 * quads;
    // Allocated bricks: surface bricks plus their -1 neighbours (measured <= 1.19 x S1/(8h)^2 on
    // the estimate suite, 1.12 on the 500k sphere; 1.6x + 64 keeps the estimate an upper bound).
    let bricks = ((1.6 * info.s1 / (64.0 * h * h)).ceil() as u64 + 64).min(grid.bricks());
    let src_tris = info.ntris + 64;
    let bvh = src_tris * (4 + 12) + (2 * src_tris / 4 + 1) * 32;
    let surface = verts * (12 + 12 + 12 + 1 + 4) + quads * (16 + 16);
    let builder = verts * (12 + 12 + 4 + 4 + 28 + 4) + tris * (12 + 12 + 1 + 4 + 4 + 4);
    let bricks_bytes = bricks * BRICK_BYTES + grid.bricks() * 4 + bricks * 512 * 4 / 2;
    let steady = verts * ENGINE_BYTES_PER_VERT + tris * ENGINE_BYTES_PER_TRI;
    // Bricks are freed before smoothing; the builder runs after: peak is the larger phase.
    let transient = bvh + (bricks_bytes + surface).max(surface + builder + steady);
    Estimate {
        h: h as f32,
        quads,
        verts,
        steady_bytes: steady,
        transient_bytes: transient,
        undo_bytes: info.snapshot_bytes,
        bricks,
        grid_ok: h > 0.0 && grid.bricks() <= MAX_BRICK_GRID,
    }
}
