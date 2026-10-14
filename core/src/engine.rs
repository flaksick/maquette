//! The sculpting engine. It owns the mesh and is the only thing that mutates it (invariant 2).
//! Pencil samples come in as screen points with pressure; strokes become dabs; every dab runs
//! inside the stroke's node transaction (invariant 3); `frame_update` turns what moved into
//! normals, BVH bounds and GPU upload commands.
//!
//! Symmetric dabs are computed from one snapshot and applied together, so a mirrored stroke is
//! mirror-exact (SYM-1), and strength is feathered where the two dabs overlap (no double
//! strength at the plane).

use crate::bvh::NONE;
use crate::gpu::Gpu;
use crate::history::{encode_record, History, LeafStates, Transaction, UndoEntry, KIND_REDO, KIND_STROKE, KIND_UNDO};
use crate::math::{add, dot, falloff_smooth, get3, normalize, scale, set3, sub};
use crate::mesh::{EditMesh, Hit};

pub const DRAW_K: f32 = 0.04;
pub const SMOOTH_LAMBDA: f32 = 0.5;
pub const TAUBIN_MU: f32 = -0.53;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tool {
    Draw = 0,
    Smooth = 1,
    Grab = 2,
}

impl Tool {
    pub fn from_u32(t: u32) -> Tool {
        match t {
            1 => Tool::Smooth,
            2 => Tool::Grab,
            _ => Tool::Draw,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Brush {
    pub tool: Tool,
    pub radius_px: f32,
    pub strength: f32,
    pub pressure_radius: bool,
    pub pressure_strength: bool,
    pub gamma: f32,
    /// Dab spacing as a fraction of the dab radius (STK-1).
    pub spacing: f32,
    pub symmetry_x: bool,
    pub preserve_volume: bool,
}

impl Default for Brush {
    fn default() -> Brush {
        Brush {
            tool: Tool::Draw,
            radius_px: 50.0,
            strength: 0.5,
            pressure_radius: false,
            pressure_strength: true,
            gamma: 1.0,
            spacing: 0.1,
            symmetry_x: true,
            preserve_volume: true,
        }
    }
}

/// Camera as the renderer sees it (26 floats from JS): inverse view-projection (column-major),
/// eye, forward, viewport width/height in pixels, world units per pixel at unit depth.
#[derive(Clone, Copy, Debug)]
pub struct Camera {
    pub inv_view_proj: [f32; 16],
    pub eye: [f32; 3],
    pub forward: [f32; 3],
    pub width: f32,
    pub height: f32,
    pub px_to_world: f32,
}

pub const CAMERA_FLOATS: usize = 26;

impl Camera {
    pub fn from_slice(c: &[f32]) -> Camera {
        let mut m = [0.0f32; 16];
        m.copy_from_slice(&c[0..16]);
        Camera {
            inv_view_proj: m,
            eye: [c[16], c[17], c[18]],
            forward: [c[19], c[20], c[21]],
            width: c[22].max(1.0),
            height: c[23].max(1.0),
            px_to_world: c[24],
        }
    }

    fn unproject(&self, x: f32, y: f32, z: f32) -> [f32; 3] {
        let m = &self.inv_view_proj;
        let v = [
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
            m[3] * x + m[7] * y + m[11] * z + m[15],
        ];
        [v[0] / v[3], v[1] / v[3], v[2] / v[3]]
    }

    /// Ray through a screen point (pixels, origin top-left).
    pub fn ray(&self, x: f32, y: f32) -> ([f32; 3], [f32; 3]) {
        let nx = 2.0 * x / self.width - 1.0;
        let ny = 1.0 - 2.0 * y / self.height;
        let near = self.unproject(nx, ny, -1.0);
        let far = self.unproject(nx, ny, 1.0);
        (near, normalize(sub(far, near)))
    }

    pub fn world_radius(&self, radius_px: f32, at: [f32; 3]) -> f32 {
        let depth = dot(sub(at, self.eye), self.forward).max(1e-4);
        radius_px * depth * self.px_to_world
    }
}

/// A set of indices with O(1) clear (generation stamps).
pub struct StampSet {
    stamp: Vec<u32>,
    id: u32,
    pub list: Vec<u32>,
}

impl StampSet {
    pub fn new(n: usize) -> StampSet {
        StampSet { stamp: vec![0; n], id: 1, list: Vec::new() }
    }
    pub fn clear(&mut self) {
        self.id = self.id.wrapping_add(1);
        if self.id == 0 {
            self.stamp.iter_mut().for_each(|s| *s = 0);
            self.id = 1;
        }
        self.list.clear();
    }
    #[inline]
    pub fn insert(&mut self, i: u32) -> bool {
        if self.stamp[i as usize] == self.id {
            return false;
        }
        self.stamp[i as usize] = self.id;
        self.list.push(i);
        true
    }
}

/// Vertex -> slot map for combining symmetric dabs.
struct SlotMap {
    stamp: Vec<u32>,
    slot: Vec<u32>,
    id: u32,
    verts: Vec<u32>,
}

impl SlotMap {
    fn new(n: usize) -> SlotMap {
        SlotMap { stamp: vec![0; n], slot: vec![0; n], id: 1, verts: Vec::new() }
    }
    fn clear(&mut self) {
        self.id = self.id.wrapping_add(1).max(1);
        self.verts.clear();
    }
    #[inline]
    fn get(&mut self, v: u32) -> (usize, bool) {
        if self.stamp[v as usize] == self.id {
            (self.slot[v as usize] as usize, false)
        } else {
            self.stamp[v as usize] = self.id;
            self.slot[v as usize] = self.verts.len() as u32;
            self.verts.push(v);
            (self.verts.len() - 1, true)
        }
    }
}

struct Grab {
    anchor: [f32; 3],
    n: [f32; 3],
    verts: Vec<u32>,
    wp: Vec<f32>,
    wm: Vec<f32>,
    orig: Vec<f32>,
}

#[derive(Default)]
struct StrokeState {
    active: bool,
    last: [f32; 3],
    travel: f32,
    p_smooth: f32,
    grab: Option<Grab>,
    dabs: u32,
}

#[inline]
fn mirror(p: [f32; 3]) -> [f32; 3] {
    [-p[0], p[1], p[2]]
}

pub struct Engine {
    pub mesh: EditMesh,
    pub gpu: Gpu,
    pub tx: Transaction,
    pub hist: History,
    pub brush: Brush,
    pub cam: Camera,
    pub seq: u32,
    pub out: Vec<u8>,
    pub ckpt_ranges: Vec<u32>,
    pub ckpt_seq: u32,
    pub last_dab: [f32; 7],
    modified: StampSet,
    normal_set: StampSet,
    gpu_leaves: StampSet,
    refit_leaves: StampSet,
    ckpt_dirty: Vec<u8>,
    leaves: Vec<u32>,
    stack: Vec<u32>,
    sel_v: Vec<u32>,
    sel_f: Vec<f32>,
    slots: SlotMap,
    u_w: Vec<f32>,
    u_d: Vec<f32>,
    tmp: Vec<f32>,
    stroke: StrokeState,
}

impl Engine {
    pub fn new(mesh: EditMesh) -> Engine {
        let nv = mesh.nverts();
        let nl = mesh.nleaves();
        let gpu = Gpu::build(&mesh);
        Engine {
            gpu,
            tx: Transaction::new(nl),
            hist: History::new(256 << 20, 200),
            brush: Brush::default(),
            cam: Camera::from_slice(&[
                1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 3., 0., 0., -1., 1., 1., 1., 0.,
            ]),
            seq: 0,
            out: Vec::new(),
            ckpt_ranges: Vec::new(),
            ckpt_seq: 0,
            last_dab: [0.0; 7],
            modified: StampSet::new(nv),
            normal_set: StampSet::new(nv),
            gpu_leaves: StampSet::new(nl),
            refit_leaves: StampSet::new(nl),
            ckpt_dirty: vec![0; nl],
            leaves: Vec::new(),
            stack: Vec::new(),
            sel_v: Vec::new(),
            sel_f: Vec::new(),
            slots: SlotMap::new(nv),
            u_w: Vec::new(),
            u_d: Vec::new(),
            tmp: Vec::new(),
            stroke: StrokeState::default(),
            mesh,
        }
    }

    // ---------- selection ----------

    fn select(&mut self, c: [f32; 3], r: f32) {
        self.mesh.bvh.query_sphere(c, r, &mut self.leaves, &mut self.stack);
        self.sel_v.clear();
        self.sel_f.clear();
        let r2 = r * r;
        for &leaf in &self.leaves {
            let (a, b) = self.mesh.leaf_range(leaf as usize);
            for v in a..b {
                let d = sub(get3(&self.mesh.positions, v), c);
                let d2 = dot(d, d);
                if d2 < r2 {
                    self.sel_v.push(v as u32);
                    self.sel_f.push(falloff_smooth(1.0 - d2.sqrt() / r));
                }
            }
        }
    }

    /// Dab centers with their feather weights: overlapping mirrored dabs share strength.
    fn centers(&self, c: [f32; 3], r: f32) -> ([[f32; 3]; 2], [f32; 2], usize) {
        if !self.brush.symmetry_x {
            return ([c, c], [1.0, 0.0], 1);
        }
        let overlap = (1.0 - c[0].abs() / r).max(0.0);
        let w = 1.0 / (1.0 + overlap);
        ([c, mirror(c)], [w, w], 2)
    }

    /// Falloff-weighted average of front-facing vertex normals in the current selection.
    fn area_normal(&self, c: [f32; 3], fallback: [f32; 3]) -> [f32; 3] {
        let to_eye = sub(self.cam.eye, c);
        let mut n = [0.0f32; 3];
        for (i, &v) in self.sel_v.iter().enumerate() {
            let nv = get3(&self.mesh.normals, v as usize);
            if dot(nv, to_eye) > 0.0 {
                n = add(n, scale(nv, self.sel_f[i]));
            }
        }
        let n = normalize(n);
        if n == [0.0; 3] { fallback } else { n }
    }

    fn touch_and_mark(&mut self, v: u32) {
        let leaf = self.mesh.leaf_of_vertex[v as usize];
        if leaf != NONE {
            self.tx.touch(&self.mesh, leaf);
        }
        self.modified.insert(v);
    }

    // ---------- dabs ----------

    pub fn dab_draw(&mut self, c: [f32; 3], r: f32, s: f32, hit_normal: [f32; 3]) {
        let (cs, ws, n) = self.centers(c, r);
        self.slots.clear();
        self.u_d.clear();
        let mut normal = [0.0; 3];
        for k in 0..n {
            self.select(cs[k], r);
            if k == 0 {
                normal = self.area_normal(c, hit_normal);
            }
            let nk = if k == 0 { normal } else { mirror(normal) };
            let amp = r * s * DRAW_K * ws[k];
            for i in 0..self.sel_v.len() {
                let (slot, new) = self.slots.get(self.sel_v[i]);
                if new {
                    self.u_d.extend_from_slice(&[0.0; 3]);
                }
                let f = amp * self.sel_f[i];
                for a in 0..3 {
                    self.u_d[3 * slot + a] += nk[a] * f;
                }
            }
        }
        for i in 0..self.slots.verts.len() {
            let v = self.slots.verts[i];
            self.touch_and_mark(v);
            let p = add(get3(&self.mesh.positions, v as usize), get3(&self.u_d, i));
            set3(&mut self.mesh.positions, v as usize, p);
        }
    }

    pub fn dab_smooth(&mut self, c: [f32; 3], r: f32, s: f32) {
        let (cs, ws, n) = self.centers(c, r);
        self.slots.clear();
        self.u_w.clear();
        for k in 0..n {
            self.select(cs[k], r);
            for i in 0..self.sel_v.len() {
                let (slot, new) = self.slots.get(self.sel_v[i]);
                if new {
                    self.u_w.push(0.0);
                }
                self.u_w[slot] += self.sel_f[i] * ws[k];
            }
        }
        for i in 0..self.slots.verts.len() {
            let v = self.slots.verts[i];
            self.touch_and_mark(v);
        }
        self.smooth_pass(SMOOTH_LAMBDA * s);
        if self.brush.preserve_volume {
            self.smooth_pass(TAUBIN_MU * s);
        }
    }

    /// One Jacobi Laplacian pass over the slot vertices: p += k·w·(avg(neighbors) - p).
    fn smooth_pass(&mut self, k: f32) {
        self.tmp.clear();
        for i in 0..self.slots.verts.len() {
            let v = self.slots.verts[i] as usize;
            let nb = self.mesh.neighbors(v);
            let p = get3(&self.mesh.positions, v);
            if nb.is_empty() {
                self.tmp.extend_from_slice(&p);
                continue;
            }
            let mut avg = [0.0f32; 3];
            for &w in nb {
                avg = add(avg, get3(&self.mesh.positions, w as usize));
            }
            let avg = scale(avg, 1.0 / nb.len() as f32);
            let f = (k * self.u_w[i].min(1.0)).clamp(-1.0, 1.0);
            self.tmp.extend_from_slice(&add(p, scale(sub(avg, p), f)));
        }
        for i in 0..self.slots.verts.len() {
            let v = self.slots.verts[i] as usize;
            set3(&mut self.mesh.positions, v, get3(&self.tmp, i));
        }
    }

    fn grab_begin(&mut self, anchor: [f32; 3], r: f32) {
        let (cs, ws, n) = self.centers(anchor, r);
        self.slots.clear();
        let mut wp = Vec::new();
        let mut wm = Vec::new();
        for k in 0..n {
            self.select(cs[k], r);
            for i in 0..self.sel_v.len() {
                let (slot, new) = self.slots.get(self.sel_v[i]);
                if new {
                    wp.push(0.0);
                    wm.push(0.0);
                }
                let w = self.sel_f[i] * ws[k];
                if k == 0 { wp[slot] += w } else { wm[slot] += w }
            }
        }
        let verts = self.slots.verts.clone();
        let mut orig = Vec::with_capacity(verts.len() * 3);
        for &v in &verts {
            orig.extend_from_slice(&get3(&self.mesh.positions, v as usize));
            let leaf = self.mesh.leaf_of_vertex[v as usize];
            if leaf != NONE {
                self.tx.touch(&self.mesh, leaf);
            }
        }
        self.stroke.grab = Some(Grab { anchor, n: scale(self.cam.forward, -1.0), verts, wp, wm, orig });
    }

    fn grab_move(&mut self, x: f32, y: f32) {
        let Some(g) = self.stroke.grab.take() else { return };
        let (o, d) = self.cam.ray(x, y);
        let denom = dot(d, g.n);
        if denom.abs() > 1e-6 {
            let t = dot(sub(g.anchor, o), g.n) / denom;
            let p = add(o, scale(d, t));
            let delta = scale(sub(p, g.anchor), self.brush.strength);
            let md = mirror(delta);
            for (i, &v) in g.verts.iter().enumerate() {
                let q = add(add(get3(&g.orig, i), scale(delta, g.wp[i])), scale(md, g.wm[i]));
                set3(&mut self.mesh.positions, v as usize, q);
                self.modified.insert(v);
            }
            self.last_dab = [g.anchor[0] + delta[0], g.anchor[1] + delta[1], g.anchor[2] + delta[2], g.n[0], g.n[1], g.n[2], self.last_dab[6]];
        }
        self.stroke.grab = Some(g);
    }

    // ---------- strokes (STK-1, STK-2) ----------

    fn pressure(&self, p: f32) -> f32 {
        p.clamp(0.0, 1.0).powf(self.brush.gamma.max(0.05))
    }

    fn radius_px_at(&self, p: f32) -> f32 {
        if self.brush.pressure_radius {
            self.brush.radius_px * (0.25 + 0.75 * self.pressure(p))
        } else {
            self.brush.radius_px
        }
    }

    pub fn raycast_screen(&self, x: f32, y: f32) -> Option<Hit> {
        let (o, d) = self.cam.ray(x, y);
        self.mesh.raycast(o, d)
    }

    /// One dab at a screen point. Returns whether it hit the surface.
    fn dab_at(&mut self, x: f32, y: f32, p: f32) -> bool {
        let Some(hit) = self.raycast_screen(x, y) else { return false };
        let r = self.cam.world_radius(self.radius_px_at(p), hit.point);
        let s = self.brush.strength * if self.brush.pressure_strength { self.pressure(p) } else { 1.0 };
        match self.brush.tool {
            Tool::Draw => self.dab_draw(hit.point, r, s, hit.normal),
            Tool::Smooth => self.dab_smooth(hit.point, r, s),
            Tool::Grab => {}
        }
        self.last_dab = [hit.point[0], hit.point[1], hit.point[2], hit.normal[0], hit.normal[1], hit.normal[2], r];
        self.stroke.dabs += 1;
        true
    }

    pub fn stroke_begin(&mut self, x: f32, y: f32, p: f32) -> bool {
        self.tx.begin();
        self.stroke = StrokeState { active: true, last: [x, y, p], travel: 0.0, p_smooth: p, grab: None, dabs: 0 };
        if self.brush.tool == Tool::Grab {
            let Some(hit) = self.raycast_screen(x, y) else { return false };
            let r = self.cam.world_radius(self.brush.radius_px, hit.point);
            self.last_dab = [hit.point[0], hit.point[1], hit.point[2], hit.normal[0], hit.normal[1], hit.normal[2], r];
            self.grab_begin(hit.point, r);
            return true;
        }
        self.dab_at(x, y, p)
    }

    /// Samples: [x, y, pressure] triples (coalesced Pencil samples). Returns dabs applied.
    pub fn stroke_move(&mut self, samples: &[f32]) -> u32 {
        if !self.stroke.active {
            return 0;
        }
        let before = self.stroke.dabs;
        for s in samples.chunks_exact(3) {
            let (x, y) = (s[0], s[1]);
            let p = self.stroke.p_smooth * 0.6 + s[2] * 0.4; // pressure smoothing (STK-2)
            self.stroke.p_smooth = p;
            if self.brush.tool == Tool::Grab {
                self.grab_move(x, y);
                self.stroke.last = [x, y, p];
                continue;
            }
            let [lx, ly, lp] = self.stroke.last;
            let seg = ((x - lx).powi(2) + (y - ly).powi(2)).sqrt();
            if seg <= 0.0 {
                continue;
            }
            let mut t = 0.0f32;
            loop {
                let pp = lp + (p - lp) * (t / seg).min(1.0);
                let spacing = (self.brush.spacing * self.radius_px_at(pp)).max(1.0);
                let need = spacing - self.stroke.travel;
                if t + need > seg {
                    self.stroke.travel += seg - t;
                    break;
                }
                t += need;
                self.stroke.travel = 0.0;
                let f = t / seg;
                self.dab_at(lx + (x - lx) * f, ly + (y - ly) * f, lp + (p - lp) * f);
            }
            self.stroke.last = [x, y, p];
        }
        self.stroke.dabs - before
    }

    /// Ends the stroke: pushes the undo entry and writes the journal record into `out`.
    /// Returns the record length (0 if the stroke changed nothing).
    pub fn stroke_end(&mut self) -> usize {
        if !self.stroke.active {
            return 0;
        }
        self.stroke.active = false;
        self.stroke.grab = None;
        self.tx.active = false;
        if self.tx.touched().is_empty() {
            self.out.clear();
            return 0;
        }
        let before = std::mem::take(&mut self.tx.before);
        let after = LeafStates::capture(&self.mesh, &before.leaves);
        self.seq += 1;
        encode_record(&mut self.out, self.seq, KIND_STROKE, &after, &self.mesh);
        self.hist.push(UndoEntry { before, after });
        self.out.len()
    }

    fn mark_states(&mut self, leaves: &[u32]) {
        for &leaf in leaves {
            let (a, b) = self.mesh.leaf_range(leaf as usize);
            for v in a..b {
                self.modified.insert(v as u32);
            }
        }
    }

    pub fn undo(&mut self) -> usize {
        if self.stroke.active {
            return 0;
        }
        let Some(states) = self.hist.undo(&mut self.mesh) else { return 0 };
        let states = states.clone();
        self.mark_states(&states.leaves);
        self.seq += 1;
        encode_record(&mut self.out, self.seq, KIND_UNDO, &states, &self.mesh);
        self.out.len()
    }

    pub fn redo(&mut self) -> usize {
        if self.stroke.active {
            return 0;
        }
        let Some(states) = self.hist.redo(&mut self.mesh) else { return 0 };
        let states = states.clone();
        self.mark_states(&states.leaves);
        self.seq += 1;
        encode_record(&mut self.out, self.seq, KIND_REDO, &states, &self.mesh);
        self.out.len()
    }

    /// Recovery: applies one journal record (whole or not at all) and marks what it moved.
    pub fn apply_journal_record(&mut self, bytes: &[u8]) -> Result<(u32, usize), crate::history::RecordError> {
        let (seq, used) = crate::history::apply_record(&mut self.mesh, bytes)?;
        let leaves = crate::history::record_leaves(&bytes[..used]);
        self.mark_states(&leaves);
        self.seq = self.seq.max(seq);
        Ok((seq, used))
    }

    // ---------- frame ----------

    /// Normals for moved vertices and their neighbours, BVH refit, checkpoint flags, GPU upload
    /// commands. Returns the number of upload commands.
    pub fn frame_update(&mut self) -> usize {
        self.gpu.cmds.clear();
        if self.modified.list.is_empty() {
            return 0;
        }
        self.normal_set.clear();
        self.refit_leaves.clear();
        for i in 0..self.modified.list.len() {
            let v = self.modified.list[i] as usize;
            self.normal_set.insert(v as u32);
            let (a, b) = (self.mesh.topo.vv_off[v] as usize, self.mesh.topo.vv_off[v + 1] as usize);
            for j in a..b {
                let w = self.mesh.topo.vv[j];
                self.normal_set.insert(w);
            }
            for j in self.mesh.topo.vt_off[v] as usize..self.mesh.topo.vt_off[v + 1] as usize {
                let t = self.mesh.topo.vt[j] as usize;
                self.refit_leaves.insert(self.mesh.leaf_of_tri[t]);
            }
            let leaf = self.mesh.leaf_of_vertex[v];
            if leaf != NONE {
                self.ckpt_dirty[leaf as usize] = 1;
            }
        }
        self.gpu_leaves.clear();
        for i in 0..self.normal_set.list.len() {
            let v = self.normal_set.list[i] as usize;
            self.mesh.vertex_normal(v);
            let leaf = self.mesh.leaf_of_vertex[v];
            if leaf != NONE {
                self.gpu_leaves.insert(leaf);
            }
        }
        let refit = std::mem::take(&mut self.refit_leaves.list);
        self.mesh.bvh.refit_leaves(&self.mesh.positions, &self.mesh.tris, &refit);
        self.refit_leaves.list = refit;
        self.mesh.bvh.refit_internal();
        let mut dirty = std::mem::take(&mut self.gpu_leaves.list);
        self.gpu.update(&self.mesh, &mut dirty);
        self.gpu_leaves.list = dirty;
        self.modified.clear();
        self.gpu.ncmds()
    }

    // ---------- checkpoints (PRJ-3) ----------

    /// Snapshot of positions changed since the last checkpoint, as merged byte ranges of the
    /// positions file: [file offset, wasm pointer, length] triples in `ckpt_ranges`. Flags are
    /// cleared now (snapshot semantics); `checkpoint_failed` re-marks everything.
    pub fn checkpoint_collect(&mut self) -> usize {
        self.ckpt_ranges.clear();
        self.ckpt_seq = self.seq;
        let nl = self.mesh.nleaves();
        let base = self.mesh.positions.as_ptr() as usize;
        let mut leaf = 0;
        while leaf < nl {
            if self.ckpt_dirty[leaf] == 0 {
                leaf += 1;
                continue;
            }
            let first = leaf;
            while leaf < nl && self.ckpt_dirty[leaf] != 0 {
                self.ckpt_dirty[leaf] = 0;
                leaf += 1;
            }
            let a = self.mesh.leaf_range(first).0;
            let b = self.mesh.leaf_range(leaf - 1).1;
            self.ckpt_ranges.extend_from_slice(&[(12 * a) as u32, (base + 12 * a) as u32, (12 * (b - a)) as u32]);
        }
        self.ckpt_ranges.len() / 3
    }

    pub fn checkpoint_failed(&mut self) {
        self.ckpt_dirty.iter_mut().for_each(|d| *d = 1);
    }

    pub fn dirty_leaf_count(&self) -> usize {
        self.ckpt_dirty.iter().filter(|&&d| d != 0).count()
    }
}

#[cfg(test)]
pub mod tests_support {
    use super::Camera;
    use crate::math::{normalize, sub};
    pub fn camera(eye: [f32; 3], w: f32, h: f32) -> Camera {
        use crate::mat4::{invert, look_at, mul, perspective};
        let fov = 0.785_398_2f32;
        let vp = mul(&perspective(fov, w / h, 0.1, 20.0), &look_at(eye, [0.0, 0.0, 0.0], [0.0, 1.0, 0.0]));
        Camera { inv_view_proj: invert(&vp).unwrap(), eye, forward: normalize(sub([0.0, 0.0, 0.0], eye)), width: w, height: h, px_to_world: 2.0 * (fov / 2.0).tan() / h }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::apply_record;
    use crate::math::len_sq;
    use crate::sphere::cube_sphere;

    fn engine(n: u32) -> Engine {
        let mut e = Engine::new(EditMesh::from_trimesh(cube_sphere(n), 256));
        e.cam = test_camera([0.0, 0.0, 3.0], 800.0, 800.0);
        e
    }

    /// A real perspective camera looking at the origin, built the way the renderer builds it.
    pub fn test_camera(eye: [f32; 3], w: f32, h: f32) -> Camera {
        use crate::mat4::{invert, look_at, mul, perspective};
        let fov = 0.785_398_2f32;
        let vp = mul(&perspective(fov, w / h, 0.1, 20.0), &look_at(eye, [0.0, 0.0, 0.0], [0.0, 1.0, 0.0]));
        let forward = normalize(sub([0.0, 0.0, 0.0], eye));
        Camera { inv_view_proj: invert(&vp).unwrap(), eye, forward, width: w, height: h, px_to_world: 2.0 * (fov / 2.0).tan() / h }
    }

    /// Mirror partner of every vertex (nearest vertex to (-x, y, z), within 1e-5).
    fn mirror_partner(m: &EditMesh) -> Vec<usize> {
        let key = |p: [f32; 3]| ((p[0] * 1e4).round() as i64, (p[1] * 1e4).round() as i64, (p[2] * 1e4).round() as i64);
        let mut grid: std::collections::HashMap<(i64, i64, i64), Vec<usize>> = std::collections::HashMap::new();
        for v in 0..m.nverts() {
            grid.entry(key(get3(&m.positions, v))).or_default().push(v);
        }
        (0..m.nverts())
            .map(|v| {
                let q = mirror(get3(&m.positions, v));
                let (kx, ky, kz) = key(q);
                let mut best = (f32::INFINITY, usize::MAX);
                for dx in -1..=1 {
                    for dy in -1..=1 {
                        for dz in -1..=1 {
                            for &w in grid.get(&(kx + dx, ky + dy, kz + dz)).map(|v| v.as_slice()).unwrap_or(&[]) {
                                let d = len_sq(sub(get3(&m.positions, w), q));
                                if d < best.0 {
                                    best = (d, w);
                                }
                            }
                        }
                    }
                }
                assert!(best.0 < 1e-10, "no mirror partner for vertex {v}");
                best.1
            })
            .collect()
    }

    #[test]
    fn camera_ray_hits_front_of_sphere() {
        let e = engine(32);
        let hit = e.raycast_screen(400.0, 400.0).expect("center ray must hit");
        assert!((hit.point[2] - 1.0).abs() < 0.01, "hit z {}", hit.point[2]);
        assert!(e.cam.world_radius(50.0, hit.point) > 0.0);
    }

    #[test]
    fn brs1_sym1_und1_draw_stroke_is_local_mirror_exact_and_undoable() {
        let mut e = engine(48);
        let partner = mirror_partner(&e.mesh);
        let h0 = e.mesh.position_hash();
        let before = e.mesh.positions.clone();
        e.brush.tool = Tool::Draw;
        e.brush.symmetry_x = true;
        e.stroke_begin(330.0, 380.0, 1.0);
        let samples: Vec<f32> = (0..40).flat_map(|i| [330.0 + i as f32 * 2.0, 380.0 + i as f32, 1.0]).collect();
        assert!(e.stroke_move(&samples) > 5);
        let len = e.stroke_end();
        assert!(len > 0);
        e.frame_update();
        // Mirror exactness: every vertex's partner sits at its mirror image (SYM-1, 1e-6).
        let mut worst = 0.0f32;
        for v in 0..e.mesh.nverts() {
            let p = get3(&e.mesh.positions, v);
            let q = get3(&e.mesh.positions, partner[v]);
            worst = worst.max((p[0] + q[0]).abs()).max((p[1] - q[1]).abs()).max((p[2] - q[2]).abs());
        }
        assert!(worst < 1e-6, "mirror error {worst}");
        // Something moved outward, nothing far away moved.
        let moved = (0..e.mesh.nverts()).filter(|&v| len_sq(sub(get3(&e.mesh.positions, v), get3(&before, v))) > 0.0).count();
        assert!(moved > 0 && moved < e.mesh.nverts() / 2);
        // Undo restores the exact pre-stroke state; redo the exact post-stroke state.
        let h1 = e.mesh.position_hash();
        assert!(e.undo() > 0);
        assert_eq!(e.mesh.position_hash(), h0);
        assert!(e.redo() > 0);
        assert_eq!(e.mesh.position_hash(), h1);
    }

    #[test]
    fn brs1_draw_moves_center_outward_by_expected_amount() {
        let mut e = engine(64);
        e.brush.symmetry_x = false;
        e.brush.tool = Tool::Draw;
        let hit = e.raycast_screen(400.0, 400.0).unwrap();
        let r = e.cam.world_radius(e.brush.radius_px, hit.point);
        // Vertex nearest the hit point.
        let v = (0..e.mesh.nverts())
            .min_by(|&a, &b| len_sq(sub(get3(&e.mesh.positions, a), hit.point)).total_cmp(&len_sq(sub(get3(&e.mesh.positions, b), hit.point))))
            .unwrap();
        let p0 = get3(&e.mesh.positions, v);
        let d0 = len_sq(sub(p0, hit.point)).sqrt();
        e.tx.begin();
        e.dab_draw(hit.point, r, 1.0, hit.normal);
        let p1 = get3(&e.mesh.positions, v);
        let expected = r * DRAW_K * falloff_smooth(1.0 - d0 / r);
        let got = len_sq(sub(p1, p0)).sqrt();
        assert!((got - expected).abs() < 1e-3 * expected.max(1e-6) + 1e-7, "got {got}, expected {expected}");
    }

    #[test]
    fn brs2_smooth_preserves_volume_within_one_percent() {
        let mut e = engine(48);
        e.brush.symmetry_x = false;
        let vol = |m: &EditMesh| -> f64 {
            m.tris
                .chunks(3)
                .map(|t| {
                    let (a, b, c) = (get3(&m.positions, t[0] as usize), get3(&m.positions, t[1] as usize), get3(&m.positions, t[2] as usize));
                    dot(a, crate::math::cross(b, c)) as f64 / 6.0
                })
                .sum()
        };
        let v0 = vol(&e.mesh);
        e.tx.begin();
        let mut seed = 7u32;
        for _ in 0..50 {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let th = seed as f32 / u32::MAX as f32 * 6.283;
            let c = normalize([th.cos(), th.sin(), 0.3]);
            e.dab_smooth(c, 0.35, 1.0);
        }
        let v1 = vol(&e.mesh);
        assert!(((v1 - v0) / v0).abs() < 0.01, "volume change {:.3}%", 100.0 * (v1 - v0) / v0);
    }

    #[test]
    fn brs3_grab_moves_anchor_with_the_pencil() {
        let mut e = engine(48);
        e.brush.tool = Tool::Grab;
        e.brush.symmetry_x = false;
        e.brush.strength = 1.0;
        e.brush.radius_px = 120.0;
        assert!(e.stroke_begin(400.0, 400.0, 1.0));
        let anchor = [e.last_dab[0], e.last_dab[1], e.last_dab[2]];
        let v = (0..e.mesh.nverts())
            .min_by(|&a, &b| len_sq(sub(get3(&e.mesh.positions, a), anchor)).total_cmp(&len_sq(sub(get3(&e.mesh.positions, b), anchor))))
            .unwrap();
        let p0 = get3(&e.mesh.positions, v);
        e.stroke_move(&[440.0, 400.0, 1.0]);
        let p1 = get3(&e.mesh.positions, v);
        assert!(p1[0] - p0[0] > 0.05, "grab did not follow: dx {}", p1[0] - p0[0]);
        assert!(e.stroke_end() > 0);
    }

    #[test]
    fn prj3_journal_replays_to_the_same_state() {
        let mut e = engine(40);
        let start = e.mesh.positions.clone();
        let mut records = Vec::new();
        for k in 0..6 {
            e.brush.tool = if k % 2 == 0 { Tool::Draw } else { Tool::Smooth };
            e.stroke_begin(300.0 + 20.0 * k as f32, 380.0, 0.8);
            e.stroke_move(&[340.0 + 20.0 * k as f32, 420.0, 0.9, 380.0 + 20.0 * k as f32, 440.0, 1.0]);
            let n = e.stroke_end();
            if n > 0 {
                records.push(e.out.clone());
            }
            if k == 3 {
                assert!(e.undo() > 0);
                records.push(e.out.clone());
            }
        }
        let target = e.mesh.position_hash();
        e.mesh.positions.copy_from_slice(&start);
        for r in &records {
            apply_record(&mut e.mesh, r).unwrap();
        }
        assert_eq!(e.mesh.position_hash(), target);
    }

    #[test]
    fn prj3_frame_update_and_checkpoint_ranges_cover_moved_vertices() {
        let mut e = engine(48);
        e.stroke_begin(400.0, 400.0, 1.0);
        e.stroke_move(&[420.0, 410.0, 1.0]);
        e.stroke_end();
        assert!(e.frame_update() > 0);
        let n = e.checkpoint_collect();
        assert!(n > 0);
        let base = e.mesh.positions.as_ptr() as usize as u32;
        for r in e.ckpt_ranges.chunks(3) {
            assert_eq!(r[1] - base, r[0]);
            assert!(r[2] > 0 && r[2] % 12 == 0);
        }
        assert_eq!(e.checkpoint_collect(), 0, "flags must clear on collect");
    }
}
