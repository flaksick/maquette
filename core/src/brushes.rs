//! The brush set (BRS-*, STK-4, STK-11, SYM-1). Every named brush is a deform primitive × the
//! shared factor pipeline × a stroke method (ARCHITECTURE: Engine):
//!
//! - **Factor pipeline.** distance → hardness → falloff preset → strength × symmetry feather
//!   (mask, hidden, front-face, automask and alpha join this chain in later phases).
//! - **Deform primitives** (`Prim`): offset along the area normal (Draw, Crease), along each
//!   vertex's own normal (Inflate), toward a plane with one-sided limits (Flatten, Fill, Scrape,
//!   Planar, Clay; Clay Strips adds a square tangent-frame footprint), tangential pull (Pinch,
//!   Crease), toward a per-vertex target fixed at stroke start (Layer), translation (Grab, Snake
//!   Hook) and Laplacian relaxation (Smooth, auto-smooth).
//! - **Stroke methods.** Spaced dabs on the surface (most brushes), an anchored drag (Grab) and a
//!   continuous drag through space (Snake Hook).
//!
//! Symmetry (SYM-1): any combination of X/Y/Z mirrors. All mirrored dabs are evaluated against the
//! same snapshot with mirrored inputs (center, plane, frame, motion), and each vertex's per-mirror
//! terms are added in a fixed pairwise tree whose levels pair mirror indices that differ in one
//! axis. Float addition is commutative but not associative; that tree gives the same result under
//! any relabeling of the mirrors, so a vertex and its partner add the same numbers in the same
//! grouping and the result is mirror-exact, not merely close. Overlapping mirrored dabs share
//! strength through the feather 1 / (1 + Σ overlap), so strength never doubles at a plane.

use crate::bvh::NONE;
use crate::engine::Engine;
use crate::history::Transaction;
use crate::math::{add, cross, dot, falloff_smooth, get3, len_sq, normalize, scale, set3, sub};
use crate::mesh::EditMesh;

// ---------- tuning (fractions of the dab radius unless stated) ----------

/// Draw: offset per dab at strength 1.
pub const DRAW_K: f32 = 0.04;
/// Smooth: Laplacian step, then the Taubin step that undoes the shrinkage (BRS-2).
pub const SMOOTH_LAMBDA: f32 = 0.5;
pub const TAUBIN_MU: f32 = -0.53;
/// Inflate: offset per dab at strength 1, along each vertex's own normal.
pub const INFLATE_K: f32 = 0.04;
/// Clay builds toward the area plane raised by this much (Blender's Clay uses 0.25 r)...
pub const CLAY_OFFSET: f32 = 0.25;
/// ...closing this fraction of the gap per dab at strength 1.
pub const CLAY_K: f32 = 0.2;
/// Clay Strips: target plane height (Blender's 0.18 r) and the depth of its z-window.
pub const STRIPS_OFFSET: f32 = 0.18;
pub const STRIPS_DEPTH: f32 = 1.25;
/// Crease: inward offset per dab, and the pull toward the stroke line (fraction of the gap).
pub const CREASE_K: f32 = 0.04;
pub const CREASE_PINCH: f32 = 0.3;
/// Pinch: fraction of the tangential distance to the center closed per dab at strength 1. A
/// point on a stroke receives ~20 dabs (spacing 0.1 r), so a full-strength stroke contracts the
/// stroke line about e^-2 (0.2 × the ~10 summed falloff), strong without collapsing triangles.
pub const PINCH_K: f32 = 0.2;
/// Pinch and Crease pulls fade to zero over this inner fraction of the radius. Undamped, the
/// spacing near the center (or the crease line) shrinks geometrically with every dab until
/// triangles collapse; faded, it shrinks only algebraically and the mesh stays usable.
pub const PINCH_ZONE: f32 = 0.25;
/// Layer: the height cap, in radii at the stroke's first dab.
pub const LAYER_HEIGHT: f32 = 0.1;
/// Snake Hook: pull toward the motion axis, per radius travelled.
pub const SNAKE_PINCH: f32 = 0.5;

// ---------- tools and settings ----------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tool {
    Draw = 0,
    Smooth = 1,
    Grab = 2,
    Inflate = 3,
    Flatten = 4,
    Clay = 5,
    ClayStrips = 6,
    Crease = 7,
    Pinch = 8,
    SnakeHook = 9,
    Layer = 10,
    Fill = 11,
    Scrape = 12,
    Planar = 13,
}

impl Tool {
    pub const ALL: [Tool; 14] = [
        Tool::Draw,
        Tool::Smooth,
        Tool::Grab,
        Tool::Inflate,
        Tool::Flatten,
        Tool::Clay,
        Tool::ClayStrips,
        Tool::Crease,
        Tool::Pinch,
        Tool::SnakeHook,
        Tool::Layer,
        Tool::Fill,
        Tool::Scrape,
        Tool::Planar,
    ];

    /// Unknown ids fall back to Draw (a project saved by a newer version still opens).
    pub fn from_u32(t: u32) -> Tool {
        Tool::ALL.get(t as usize).copied().unwrap_or(Tool::Draw)
    }
}

/// Falloff presets (STK-4) as functions of p = 1 − d/r.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Falloff {
    Smooth = 0,
    Smoother = 1,
    Sphere = 2,
    Root = 3,
    Sharp = 4,
    Linear = 5,
    Pow4 = 6,
    InvSquare = 7,
    Constant = 8,
}

impl Falloff {
    pub const ALL: [Falloff; 9] = [
        Falloff::Smooth,
        Falloff::Smoother,
        Falloff::Sphere,
        Falloff::Root,
        Falloff::Sharp,
        Falloff::Linear,
        Falloff::Pow4,
        Falloff::InvSquare,
        Falloff::Constant,
    ];

    pub fn from_u32(i: u32) -> Falloff {
        Falloff::ALL.get(i as usize).copied().unwrap_or(Falloff::Smooth)
    }

    #[inline(always)]
    pub fn eval(self, p: f32) -> f32 {
        match self {
            // Same expression as before presets existed, so default Draw/Smooth are unchanged.
            Falloff::Smooth => falloff_smooth(p),
            Falloff::Smoother => p * p * p * (p * (p * 6.0 - 15.0) + 10.0),
            Falloff::Sphere => (p * (2.0 - p)).max(0.0).sqrt(),
            Falloff::Root => p.max(0.0).sqrt(),
            Falloff::Sharp => p * p,
            Falloff::Linear => p,
            Falloff::Pow4 => {
                let q = p * p;
                q * q
            }
            Falloff::InvSquare => p * (2.0 - p),
            Falloff::Constant => 1.0,
        }
    }
}

/// Hardness (STK-4): distances below h·r count as the center and the rest of the radius is
/// stretched over the whole curve, q' = (q − h) / (1 − h). h = 1 makes the brush constant.
#[inline(always)]
pub fn hardness_remap(q: f32, h: f32) -> f32 {
    if q <= h { 0.0 } else { (q - h) / (1.0 - h) }
}

/// The shared factor: normalized distance q = d/r → [0, 1], zero outside the radius (and for NaN).
#[inline(always)]
pub fn factor(curve: Falloff, hardness: f32, q: f32) -> f32 {
    if !(q < 1.0) {
        return 0.0;
    }
    curve.eval(1.0 - hardness_remap(q, hardness))
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
    pub symmetry_y: bool,
    pub symmetry_z: bool,
    pub preserve_volume: bool,
    pub falloff: Falloff,
    pub hardness: f32,
    /// Laplacian relaxation after every dab, 0..1 (STK-11).
    pub autosmooth: f32,
    /// Sample the current surface (true) or the stroke-start surface (false) (STK-11).
    pub accumulate: bool,
    /// The opposite effect (Draw carves, Inflate deflates, Clay digs, Crease raises, Pinch
    /// pushes apart, Layer goes down, Fill and Scrape swap); other tools ignore it.
    pub invert: bool,
    /// Stabilizer (STK-3): lazy radius in screen pixels, and input smoothing 0..0.95.
    pub lazy_px: f32,
    pub stabilize: f32,
}

/// Hold buttons (NAV-5): while held when a stroke starts, the stroke smooths (with the Smooth
/// tool's strength) or inverts. Read once at stroke start, so letting go mid-stroke changes nothing.
#[derive(Clone, Copy, Debug, Default)]
pub struct Modifiers {
    pub smooth: bool,
    pub invert: bool,
    pub smooth_strength: f32,
}

impl Tool {
    /// Whether Invert means something for this tool (the UI hides it otherwise).
    pub fn invertible(self) -> bool {
        matches!(self, Tool::Draw | Tool::Inflate | Tool::Clay | Tool::Crease | Tool::Pinch | Tool::Layer | Tool::Fill | Tool::Scrape)
    }
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
            symmetry_y: false,
            symmetry_z: false,
            preserve_volume: true,
            falloff: Falloff::Smooth,
            hardness: 0.0,
            autosmooth: 0.0,
            accumulate: true,
            invert: false,
            lazy_px: 0.0,
            stabilize: 0.0,
        }
    }
}

impl Brush {
    /// Mirror axes as a bitmask: 1 = X, 2 = Y, 4 = Z.
    pub fn symmetry(&self) -> u8 {
        self.symmetry_x as u8 | (self.symmetry_y as u8) << 1 | (self.symmetry_z as u8) << 2
    }
}

// ---------- symmetry (SYM-1) ----------

/// Mirror image across the X = 0 plane.
#[inline(always)]
pub fn mirror(p: [f32; 3]) -> [f32; 3] {
    [-p[0], p[1], p[2]]
}

/// Flips the components named by `mask` (1 = X, 2 = Y, 4 = Z). Negation is exact, so every
/// formula built from flipped inputs flips exactly.
#[inline(always)]
pub fn flip(v: [f32; 3], mask: u8) -> [f32; 3] {
    [
        if mask & 1 != 0 { -v[0] } else { v[0] },
        if mask & 2 != 0 { -v[1] } else { v[1] },
        if mask & 4 != 0 { -v[2] } else { v[2] },
    ]
}

/// The mirror group of an axis mask in compact order: element j flips the axes whose bits are set
/// in j, where bit k of j stands for the k-th enabled axis. Element 0 is the identity.
pub fn mirror_group(mask: u8) -> ([u8; 8], usize) {
    let mut axes = [0u8; 3];
    let mut na = 0;
    for a in [1u8, 2, 4] {
        if mask & a != 0 {
            axes[na] = a;
            na += 1;
        }
    }
    let n = 1usize << na;
    let mut g = [0u8; 8];
    for (j, gj) in g.iter_mut().enumerate().take(n) {
        for (k, &a) in axes.iter().enumerate().take(na) {
            if (j >> k) & 1 == 1 {
                *gj |= a;
            }
        }
    }
    (g, n)
}

/// Strength shared by every mirrored dab: 1 / (1 + Σ overlap) with overlap = 1 − |c − M c| / 2r
/// (Blender's symmetry feather). A dab on a mirror plane overlaps its image fully and each gets half.
pub fn feather(c: [f32; 3], r: f32, group: &[u8]) -> f32 {
    let mut sum = 1.0f32;
    for &m in group.iter().skip(1) {
        let d = len_sq(sub(c, flip(c, m))).sqrt();
        sum += (1.0 - d / (2.0 * r)).max(0.0);
    }
    1.0 / sum
}

/// Sum of `nm` (1, 2, 4 or 8) vec3 terms in the fixed pairwise order (see the module docs).
#[inline(always)]
pub fn tree_sum(t: &[f32], nm: usize) -> [f32; 3] {
    let g = |i: usize| get3(t, i);
    match nm {
        1 => g(0),
        2 => add(g(0), g(1)),
        4 => add(add(g(0), g(1)), add(g(2), g(3))),
        _ => add(add(add(g(0), g(1)), add(g(2), g(3))), add(add(g(4), g(5)), add(g(6), g(7)))),
    }
}

/// Scalar version of `tree_sum`.
#[inline(always)]
pub fn tree_sum1(t: &[f32], nm: usize) -> f32 {
    match nm {
        1 => t[0],
        2 => t[0] + t[1],
        4 => (t[0] + t[1]) + (t[2] + t[3]),
        _ => ((t[0] + t[1]) + (t[2] + t[3])) + ((t[4] + t[5]) + (t[6] + t[7])),
    }
}

/// Component of x perpendicular to the unit normal n.
#[inline(always)]
fn tangential(x: [f32; 3], n: [f32; 3]) -> [f32; 3] {
    sub(x, scale(n, dot(x, n)))
}

/// Unit vector by dividing, not multiplying by a rounded reciprocal: an axis-aligned sum comes
/// out exactly axis-aligned (a flat plane's area normal is exactly (0, 0, 1)).
#[inline(always)]
fn unit(a: [f32; 3]) -> [f32; 3] {
    let l = len_sq(a).sqrt();
    if l > 1e-20 { [a[0] / l, a[1] / l, a[2] / l] } else { [0.0; 3] }
}

// ---------- polygons (triangulation-independent topology) ----------
// Quads arrive split along one diagonal, and a mirror image is split along the other one, so
// anything computed from triangles (one-rings, area-weighted normals) is not mirror-symmetric
// even on a symmetric mesh. Brushes use the polygons instead: polygon-edge neighbours, and
// polygon vector areas, which do not depend on the diagonal (for a quad abcd it is
// (c - a) x (d - b), the same for either split and exactly mirrored for a mirrored quad).

/// First triangle and triangle count of the polygon run containing triangle t.
#[inline]
fn poly_run(mesh: &EditMesh, t: usize) -> (usize, usize) {
    let mut s = t;
    while s > 0 && mesh.poly_next[s - 1] != 0 {
        s -= 1;
    }
    let mut e = t;
    while e + 1 < mesh.ntris() && mesh.poly_next[e] != 0 {
        e += 1;
    }
    (s, e - s + 1)
}

/// Corner j of the fan polygon starting at triangle s (corners: v0, then each triangle's v1/v2).
#[inline(always)]
pub(crate) fn poly_corner(mesh: &EditMesh, s: usize, j: usize) -> u32 {
    if j < 3 { mesh.tris[3 * s + j] } else { mesh.tris[3 * (s + j - 2) + 2] }
}

/// Twice the vector area of the polygon run (s, k), from positions `pos`.
#[inline]
fn poly_area2<F: Fn(usize) -> [f32; 3]>(mesh: &EditMesh, pos: &F, s: usize, k: usize) -> [f32; 3] {
    let t = &mesh.tris;
    let a = pos(t[3 * s] as usize);
    if k == 2 {
        let (b, c, d) = (pos(t[3 * s + 1] as usize), pos(t[3 * s + 2] as usize), pos(t[3 * s + 5] as usize));
        return cross(sub(c, a), sub(d, b));
    }
    let mut n = [0.0f32; 3];
    for i in s..s + k {
        n = add(n, cross(sub(pos(t[3 * i + 1] as usize), a), sub(pos(t[3 * i + 2] as usize), a)));
    }
    n
}

/// Vertex normal from the vector areas of the polygons around v, summed in f64 (a vertex and its
/// mirror partner meet their polygons in different orders; the f64 sum doesn't care).
fn poly_normal<F: Fn(usize) -> [f32; 3]>(mesh: &EditMesh, pos: &F, v: usize) -> [f32; 3] {
    let mut acc = [0.0f64; 3];
    let mut last = usize::MAX;
    for &tv in mesh.topo.vtris(v) {
        let (s, k) = poly_run(mesh, tv as usize);
        if s == last {
            continue; // the same polygon's next triangle (vt is sorted, runs are contiguous)
        }
        last = s;
        let a = poly_area2(mesh, pos, s, k);
        for c in 0..3 {
            acc[c] += a[c] as f64;
        }
    }
    normalize([acc[0] as f32, acc[1] as f32, acc[2] as f32])
}

/// Polygon-edge neighbours of v (no triangulation diagonals), sorted, appended to `out`.
fn poly_ring(mesh: &EditMesh, v: usize, out: &mut Vec<u32>) {
    let start = out.len();
    let mut last = usize::MAX;
    for &tv in mesh.topo.vtris(v) {
        let (s, k) = poly_run(mesh, tv as usize);
        if s == last {
            continue;
        }
        last = s;
        let n = k + 2;
        if let Some(j) = (0..n).find(|&j| poly_corner(mesh, s, j) == v as u32) {
            out.push(poly_corner(mesh, s, (j + n - 1) % n));
            out.push(poly_corner(mesh, s, (j + 1) % n));
        }
    }
    out[start..].sort_unstable();
    let mut w = start;
    for r in start..out.len() {
        if r == start || out[r] != out[w - 1] {
            out[w] = out[r];
            w += 1;
        }
    }
    out.truncate(w);
}

// ---------- planes and stroke-start ("original") data (STK-11) ----------

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Plane {
    pub point: [f32; 3],
    pub normal: [f32; 3],
}

/// Position of v at stroke start: the transaction's before-state if its leaf was touched,
/// otherwise the current position (an untouched leaf has not moved this stroke).
#[inline]
pub(crate) fn orig_pos(mesh: &EditMesh, tx: &Transaction, v: usize) -> [f32; 3] {
    let leaf = mesh.leaf_of_vertex[v];
    if leaf != NONE {
        if let Some(s) = tx.original_leaf(leaf) {
            return get3(s, v - mesh.leaf_range(leaf as usize).0);
        }
    }
    get3(&mesh.positions, v)
}

/// Stroke-start vertex normals, computed per leaf on first use from stroke-start positions.
/// Current normals can't stand in: a frame recomputes the normals of every vertex next to one
/// that moved, including vertices in leaves the stroke has not touched yet.
pub(crate) struct OrigNormals {
    stamp: Vec<u32>,
    off: Vec<u32>,
    data: Vec<f32>,
    id: u32,
}

impl OrigNormals {
    pub fn new(nleaves: usize) -> OrigNormals {
        OrigNormals { stamp: vec![0; nleaves], off: vec![0; nleaves], data: Vec::new(), id: 1 }
    }

    /// Forgets everything (called at stroke start).
    pub fn begin(&mut self, nleaves: usize) {
        if self.stamp.len() != nleaves {
            self.stamp = vec![0; nleaves];
            self.off = vec![0; nleaves];
        }
        self.id = self.id.wrapping_add(1);
        if self.id == 0 {
            self.stamp.iter_mut().for_each(|s| *s = 0);
            self.id = 1;
        }
        self.data.clear();
    }

    pub fn get(&mut self, mesh: &EditMesh, tx: &Transaction, v: usize) -> [f32; 3] {
        let leaf = mesh.leaf_of_vertex[v];
        if leaf == NONE {
            return get3(&mesh.normals, v);
        }
        let (a, b) = mesh.leaf_range(leaf as usize);
        if self.stamp[leaf as usize] != self.id {
            self.stamp[leaf as usize] = self.id;
            self.off[leaf as usize] = (self.data.len() / 3) as u32;
            let pos = |u: usize| orig_pos(mesh, tx, u);
            for u in a..b {
                self.data.extend_from_slice(&poly_normal(mesh, &pos, u));
            }
        }
        get3(&self.data, self.off[leaf as usize] as usize + (v - a))
    }
}

// ---------- per-stroke brush state ----------

/// Vertex -> slot map for combining the terms of symmetric dabs.
pub(crate) struct SlotMap {
    stamp: Vec<u32>,
    slot: Vec<u32>,
    id: u32,
    pub verts: Vec<u32>,
}

impl SlotMap {
    pub fn new(n: usize) -> SlotMap {
        SlotMap { stamp: vec![0; n], slot: vec![0; n], id: 1, verts: Vec::new() }
    }
    pub fn clear(&mut self) {
        self.id = self.id.wrapping_add(1);
        if self.id == 0 {
            self.stamp.iter_mut().for_each(|s| *s = 0);
            self.id = 1;
        }
        self.verts.clear();
    }
    #[inline]
    pub fn get(&mut self, v: u32) -> (usize, bool) {
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

/// Grab: weights per vertex and mirror, captured at stroke start (BRS-3).
pub(crate) struct Grab {
    anchor: [f32; 3],
    n: [f32; 3],
    verts: Vec<u32>,
    w: Vec<f32>,
    orig: Vec<f32>,
    group: [u8; 8],
    nm: usize,
}

/// Snake Hook: where the hook is now, on the view plane through the first hit (BRS-9).
#[derive(Clone, Copy)]
pub(crate) struct Snake {
    center: [f32; 3],
}

#[derive(Default)]
pub(crate) struct BrushStroke {
    pub grab: Option<Grab>,
    pub snake: Option<Snake>,
    /// Previous dab center: the stroke direction for Clay Strips and Crease.
    pub prev: Option<[f32; 3]>,
    /// Planar: the plane sampled at the first dab, held for the whole stroke.
    pub plane: Option<Plane>,
    /// Layer: the height cap of this stroke.
    pub layer_h: f32,
    /// Largest distance any vertex has moved from its stroke-start position.
    pub drift: f32,
}

// ---------- deform primitives ----------

/// One dab's deformation, in the frame of one mirrored copy of the dab. `mirrored` flips every
/// vector input; scalars stay.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Prim {
    /// Offset along a fixed direction (Draw).
    Offset { n: [f32; 3], amp: f32 },
    /// Offset along each vertex's own normal (Inflate).
    Inflate { amp: f32 },
    /// Toward the plane (q, n), for vertices at most `above` over it and `below` under it
    /// (Flatten, Fill, Scrape, Planar, Clay): the one-sided limits of BRS-11.
    Plane { q: [f32; 3], n: [f32; 3], above: f32, below: f32, gain: f32 },
    /// Clay Strips: up to the plane (q, n) from below, over a square footprint in the tangent
    /// frame (t, b) centered at c, faded out with depth below the plane.
    Strips { q: [f32; 3], n: [f32; 3], t: [f32; 3], b: [f32; 3], c: [f32; 3], depth: f32 },
    /// Tangential pull toward c (Pinch).
    Pinch { c: [f32; 3], n: [f32; 3], k: f32 },
    /// Offset along n_in plus a pull toward the stroke line through c across b (or toward c on
    /// the first dab, when there is no direction yet) (Crease).
    Crease { c: [f32; 3], n_in: [f32; 3], amp: f32, b: [f32; 3], line: bool, k: f32 },
    /// Toward each vertex's stroke-start position raised by h along its stroke-start normal (Layer).
    Layer { h: f32 },
    /// Translation by delta with a pull toward the motion axis through c (Snake Hook).
    Snake { c: [f32; 3], delta: [f32; 3], dhat: [f32; 3], k: f32 },
}

impl Prim {
    fn mirrored(&self, m: u8) -> Prim {
        let f = |v: [f32; 3]| flip(v, m);
        match *self {
            Prim::Offset { n, amp } => Prim::Offset { n: f(n), amp },
            Prim::Inflate { amp } => Prim::Inflate { amp },
            Prim::Plane { q, n, above, below, gain } => Prim::Plane { q: f(q), n: f(n), above, below, gain },
            Prim::Strips { q, n, t, b, c, depth } => Prim::Strips { q: f(q), n: f(n), t: f(t), b: f(b), c: f(c), depth },
            Prim::Pinch { c, n, k } => Prim::Pinch { c: f(c), n: f(n), k },
            Prim::Crease { c, n_in, amp, b, line, k } => Prim::Crease { c: f(c), n_in: f(n_in), amp, b: f(b), line, k },
            Prim::Layer { h } => Prim::Layer { h },
            Prim::Snake { c, delta, dhat, k } => Prim::Snake { c: f(c), delta: f(delta), dhat: f(dhat), k },
        }
    }

    /// Needs each vertex's normal (current, or stroke-start when sampling the stroke start).
    fn needs_normals(&self) -> bool {
        matches!(self, Prim::Inflate { .. } | Prim::Layer { .. })
    }

    /// How far from the dab center a vertex can be affected, in radii.
    fn reach(&self) -> f32 {
        match self {
            Prim::Strips { .. } => std::f32::consts::SQRT_2, // the square's corners
            _ => 1.0,
        }
    }

    /// Footprint factor of a vertex sampled at `sp`, `d2` = squared distance to the dab center.
    #[inline(always)]
    fn footprint(&self, curve: Falloff, hardness: f32, sp: [f32; 3], d2: f32, r: f32) -> f32 {
        match *self {
            Prim::Strips { q, n, t, b, c, depth } => {
                let rel = sub(sp, c);
                // Square in the tangent frame: Chebyshev distance replaces the radial one.
                let dq = (dot(rel, t).abs()).max(dot(rel, b).abs()) / r;
                let fxy = factor(curve, hardness, dq);
                if !(fxy > 0.0) {
                    return 0.0;
                }
                // z-window 4z(1 − z) across a slab centered on the target plane (z = 1/2 at the
                // plane): full strength at the plane, none `depth` below it, so geometry deep
                // under the strip (the far side of a thin part) stays put.
                let u = dot(sub(sp, q), n) / depth;
                fxy * (1.0 - u * u).max(0.0)
            }
            _ => factor(curve, hardness, d2.sqrt() / r),
        }
    }

    /// Displacement of a vertex at current position `cur` for combined factor f (footprint ×
    /// strength × feather). `sp` = sampling position, `nv` = its normal when `needs_normals`.
    #[inline(always)]
    fn disp(&self, f: f32, sp: [f32; 3], cur: [f32; 3], nv: [f32; 3], r: f32) -> Option<[f32; 3]> {
        match *self {
            Prim::Offset { n, amp } => Some(scale(n, amp * f)),
            Prim::Inflate { amp } => Some(scale(nv, amp * f)),
            Prim::Plane { q, n, above, below, gain } => {
                let h = dot(sub(cur, q), n);
                if h > above || h < -below {
                    return None;
                }
                Some(scale(n, -h * f * gain))
            }
            Prim::Strips { q, n, .. } => {
                let h = dot(sub(cur, q), n);
                if h >= 0.0 {
                    return None; // builds up to the plane, never shaves above it
                }
                Some(scale(n, -h * f))
            }
            Prim::Pinch { c, n, k } => {
                let to_c = tangential(sub(c, cur), n);
                Some(scale(to_c, k * f * fade_in(len_sq(to_c).sqrt(), r)))
            }
            Prim::Crease { c, n_in, amp, b, line, k } => {
                let to_c = sub(c, cur);
                let to_line = if line { scale(b, dot(to_c, b)) } else { tangential(to_c, n_in) };
                let pull = scale(to_line, k * f * fade_in(len_sq(to_line).sqrt(), r));
                Some(add(scale(n_in, amp * f), pull))
            }
            Prim::Layer { h } => Some(scale(sub(add(sp, scale(nv, h)), cur), f)),
            Prim::Snake { c, delta, dhat, k } => {
                let rel = sub(cur, c);
                let off_axis = tangential(rel, dhat);
                // Pull toward the axis, scaled by the distance travelled and by (offset / r)^2 so
                // vertices near the axis are left alone: the hook stays round, never collapses.
                let o2 = len_sq(off_axis) / (r * r);
                let pull = (k * f * o2 * len_sq(delta).sqrt() / r).min(1.0);
                Some(sub(scale(delta, f), scale(off_axis, pull)))
            }
        }
    }
}

/// Pull damping near the target (see PINCH_ZONE): 0 at distance 0, 1 from PINCH_ZONE·r out.
#[inline(always)]
fn fade_in(d: f32, r: f32) -> f32 {
    (d / (PINCH_ZONE * r)).min(1.0)
}

// ---------- the engine side: selection, sampling, dabs ----------

impl Engine {
    /// Collects vertices whose sampling position (stroke start when `original`, else current) is
    /// within `r` of `c` into sel_v / sel_p / sel_d2. Leaf bounds can lag positions by `stale`
    /// (dabs since the last refit) and stroke-start positions can sit `drift` away from the
    /// current ones, so the BVH query is widened by both and the exact test uses the sample.
    pub(crate) fn select(&mut self, c: [f32; 3], r: f32, original: bool) {
        let widen = self.stale + if original { self.stroke.brush.drift } else { 0.0 };
        self.mesh.bvh.query_sphere(c, r + widen, &mut self.leaves, &mut self.stack);
        self.sel_v.clear();
        self.sel_p.clear();
        self.sel_d2.clear();
        let r2 = r * r;
        for &leaf in &self.leaves {
            let (a, b) = self.mesh.leaf_range(leaf as usize);
            let src: &[f32] = match self.tx.original_leaf(leaf) {
                Some(s) if original => s,
                _ => &self.mesh.positions[3 * a..3 * b],
            };
            for v in a..b {
                let p = get3(src, v - a);
                let d = sub(p, c);
                let d2 = dot(d, d);
                if d2 < r2 {
                    self.sel_v.push(v as u32);
                    self.sel_p.extend_from_slice(&p);
                    self.sel_d2.push(d2);
                }
            }
        }
    }

    /// Area plane of the selection around c (STK-11): smooth-weighted mean position and normal of
    /// the vertices within r that face the eye; back-facing ones count only when none does
    /// ("front-facing wins"). The weights ignore the brush's falloff so every preset samples the
    /// same plane.
    fn area_plane(&mut self, c: [f32; 3], r: f32, original: bool, fallback: Plane) -> Plane {
        let to_eye = self.cam.to_eye(c);
        let r2 = r * r;
        let mut nacc = [[0.0f32; 3]; 2];
        let mut pacc = [[0.0f32; 3]; 2];
        let mut wacc = [0.0f32; 2];
        for i in 0..self.sel_v.len() {
            let d2 = self.sel_d2[i];
            if !(d2 < r2) {
                continue;
            }
            let v = self.sel_v[i] as usize;
            let w = falloff_smooth(1.0 - d2.sqrt() / r);
            let n = if original { self.orig_n.get(&self.mesh, &self.tx, v) } else { get3(&self.mesh.normals, v) };
            let side = (dot(n, to_eye) <= 0.0) as usize;
            nacc[side] = add(nacc[side], scale(n, w));
            pacc[side] = add(pacc[side], scale(get3(&self.sel_p, i), w));
            wacc[side] += w;
        }
        let side = if wacc[0] > 0.0 {
            0
        } else if wacc[1] > 0.0 {
            1
        } else {
            return fallback;
        };
        let n = unit(nacc[side]);
        if n == [0.0; 3] {
            return fallback;
        }
        let w = wacc[side];
        Plane { point: [pacc[side][0] / w, pacc[side][1] / w, pacc[side][2] / w], normal: n }
    }

    /// Selects around c and returns its area plane.
    pub(crate) fn sample_plane(&mut self, c: [f32; 3], r: f32, original: bool, fallback: Plane) -> Plane {
        self.select(c, r, original);
        self.area_plane(c, r, original, fallback)
    }

    /// Each selected vertex's own normal, from polygons (see poly_normal): current positions, or
    /// stroke-start ones when sampling the stroke start.
    fn gather_normals(&mut self, original: bool) {
        self.sel_n.clear();
        for i in 0..self.sel_v.len() {
            let v = self.sel_v[i] as usize;
            let n = if original {
                self.orig_n.get(&self.mesh, &self.tx, v)
            } else {
                let positions = &self.mesh.positions;
                poly_normal(&self.mesh, &|u: usize| get3(positions, u), v)
            };
            self.sel_n.extend_from_slice(&n);
        }
    }

    /// Whether this tool samples the stroke-start surface: Layer always (its cap is relative to
    /// it), plane-sampling brushes when accumulate is off, drags never.
    pub(crate) fn samples_original(&self, tool: Tool) -> bool {
        match tool {
            Tool::Layer => true,
            Tool::Smooth | Tool::Grab | Tool::SnakeHook => false,
            _ => !self.brush.accumulate,
        }
    }

    pub(crate) fn touch_and_mark(&mut self, v: u32) {
        let leaf = self.mesh.leaf_of_vertex[v as usize];
        if leaf != NONE {
            self.tx.touch(&self.mesh, leaf);
        }
        self.modified.insert(v);
    }

    /// One symmetric dab of a deform primitive: per mirror, select around the mirrored center,
    /// evaluate the mirrored primitive and store the term; then sum each vertex's terms in the
    /// fixed pairwise order and apply everything inside the stroke's transaction.
    pub(crate) fn deform(&mut self, c: [f32; 3], r: f32, s: f32, original: bool, prim: Prim) {
        let (group, nm) = mirror_group(self.brush.symmetry());
        let sw = s * feather(c, r, &group[..nm]);
        let (curve, hardness) = (self.brush.falloff, self.brush.hardness.clamp(0.0, 1.0));
        let need_n = prim.needs_normals();
        self.slots.clear();
        self.terms.clear();
        for (j, &m) in group.iter().enumerate().take(nm) {
            let pm = prim.mirrored(m);
            self.select(flip(c, m), r * pm.reach(), original);
            if need_n {
                self.gather_normals(original);
            }
            for i in 0..self.sel_v.len() {
                let sp = get3(&self.sel_p, i);
                let f = pm.footprint(curve, hardness, sp, self.sel_d2[i], r);
                if !(f > 0.0) {
                    continue;
                }
                let v = self.sel_v[i] as usize;
                let nv = if need_n { get3(&self.sel_n, i) } else { [0.0; 3] };
                let Some(d) = pm.disp(f * sw, sp, get3(&self.mesh.positions, v), nv, r) else { continue };
                let (slot, new) = self.slots.get(v as u32);
                if new {
                    self.terms.resize(self.terms.len() + 3 * nm, 0.0);
                }
                set3(&mut self.terms, slot * nm + j, d);
            }
        }
        let cap = if let Prim::Layer { h } = prim { Some(h) } else { None };
        self.apply_terms(nm, cap);
    }

    /// Applies the summed terms. `layer_cap`: no vertex may end higher than this above its
    /// stroke-start position along its stroke-start normal (overlapping mirrored dabs may add up
    /// to slightly more than one full step; the cap keeps BRS-10 exact).
    fn apply_terms(&mut self, nm: usize, layer_cap: Option<f32>) {
        let mut moved2 = 0.0f32;
        let mut drift2 = 0.0f32;
        for i in 0..self.slots.verts.len() {
            let v = self.slots.verts[i];
            let d = tree_sum(&self.terms[3 * nm * i..3 * nm * (i + 1)], nm);
            self.touch_and_mark(v);
            let v = v as usize;
            let old = get3(&self.mesh.positions, v);
            let mut p = add(old, d);
            let o = orig_pos(&self.mesh, &self.tx, v);
            if let Some(h) = layer_cap {
                let n = self.orig_n.get(&self.mesh, &self.tx, v);
                let above = dot(sub(p, o), n);
                if (h > 0.0 && above > h) || (h < 0.0 && above < h) {
                    p = sub(p, scale(n, above - h));
                }
            }
            moved2 = moved2.max(len_sq(sub(p, old)));
            drift2 = drift2.max(len_sq(sub(p, o)));
            set3(&mut self.mesh.positions, v, p);
        }
        self.stale += moved2.sqrt();
        self.stroke.brush.drift = self.stroke.brush.drift.max(drift2.sqrt());
    }

    /// One dab of `tool` at surface point c with world radius r and strength s (pressure applied).
    pub(crate) fn dab(&mut self, tool: Tool, c: [f32; 3], r: f32, s: f32, hit_n: [f32; 3]) {
        let original = self.samples_original(tool);
        let fallback = Plane { point: c, normal: hit_n };
        // Invert is fixed per stroke (brush setting XOR the held Invert button).
        let sign = if self.stroke.invert && tool.invertible() { -1.0 } else { 1.0 };
        let tool = match (tool, sign < 0.0) {
            (Tool::Fill, true) => Tool::Scrape,
            (Tool::Scrape, true) => Tool::Fill,
            _ => tool,
        };
        match tool {
            Tool::Draw => {
                let pl = self.sample_plane(c, r, original, fallback);
                self.deform(c, r, s, original, Prim::Offset { n: pl.normal, amp: sign * r * DRAW_K });
            }
            Tool::Smooth => self.smooth_dab(c, r, s, self.brush.preserve_volume),
            Tool::Grab | Tool::SnakeHook => {} // stroke methods of their own
            Tool::Inflate => self.deform(c, r, s, original, Prim::Inflate { amp: sign * r * INFLATE_K }),
            Tool::Flatten | Tool::Fill | Tool::Scrape | Tool::Planar => {
                let pl = match self.stroke.brush.plane {
                    Some(pl) if tool == Tool::Planar => pl,
                    _ => self.sample_plane(c, r, original, fallback),
                };
                if tool == Tool::Planar {
                    self.stroke.brush.plane = Some(pl);
                }
                let inf = f32::INFINITY;
                let (above, below) = match tool {
                    Tool::Fill => (0.0, inf),
                    Tool::Scrape => (inf, 0.0),
                    _ => (inf, inf),
                };
                self.deform(c, r, s, original, Prim::Plane { q: pl.point, n: pl.normal, above, below, gain: 1.0 });
            }
            Tool::Clay => {
                let pl = self.sample_plane(c, r, original, fallback);
                let q = add(pl.point, scale(pl.normal, sign * CLAY_OFFSET * r)); // inverted: digs
                let inf = f32::INFINITY;
                self.deform(c, r, s, original, Prim::Plane { q, n: pl.normal, above: inf, below: inf, gain: CLAY_K });
            }
            Tool::ClayStrips => {
                // The square is oriented along the stroke, so the first dab only sets the start.
                if let Some(prev) = self.stroke.brush.prev {
                    let pl = self.sample_plane(c, r, original, fallback);
                    let t = normalize(tangential(sub(c, prev), pl.normal));
                    if t != [0.0; 3] {
                        let b = normalize(cross(pl.normal, t));
                        let q = add(pl.point, scale(pl.normal, STRIPS_OFFSET * r));
                        self.deform(c, r, s, original, Prim::Strips { q, n: pl.normal, t, b, c, depth: STRIPS_DEPTH * r });
                    }
                }
            }
            Tool::Crease => {
                let pl = self.sample_plane(c, r, original, fallback);
                let t = self.stroke.brush.prev.map(|p| normalize(tangential(sub(c, p), pl.normal))).unwrap_or([0.0; 3]);
                let line = t != [0.0; 3];
                let b = if line { normalize(cross(pl.normal, t)) } else { [0.0; 3] };
                // Inverted the crease raises a ridge; it still pinches toward the line.
                let n_in = scale(pl.normal, -sign);
                self.deform(c, r, s, original, Prim::Crease { c, n_in, amp: r * CREASE_K, b, line, k: CREASE_PINCH });
            }
            Tool::Pinch => {
                let pl = self.sample_plane(c, r, original, fallback);
                self.deform(c, r, s, original, Prim::Pinch { c, n: pl.normal, k: sign * PINCH_K });
            }
            Tool::Layer => {
                if self.stroke.brush.layer_h <= 0.0 {
                    self.stroke.brush.layer_h = LAYER_HEIGHT * r;
                }
                self.deform(c, r, s, original, Prim::Layer { h: sign * self.stroke.brush.layer_h });
            }
        }
        self.stroke.brush.prev = Some(c);
        if !matches!(tool, Tool::Smooth | Tool::Grab | Tool::SnakeHook) {
            self.autosmooth_at(c, r);
        }
    }

    /// Draw (BRS-1): offset along the area normal × falloff × strength.
    pub fn dab_draw(&mut self, c: [f32; 3], r: f32, s: f32, hit_normal: [f32; 3]) {
        self.dab(Tool::Draw, c, r, s, hit_normal);
    }

    /// Smooth (BRS-2): Laplacian step, then a Taubin step when preserving volume.
    pub fn dab_smooth(&mut self, c: [f32; 3], r: f32, s: f32) {
        self.smooth_dab(c, r, s, self.brush.preserve_volume);
    }

    /// Auto-smooth (STK-11): a plain Laplacian pass over the dab after every dab.
    fn autosmooth_at(&mut self, c: [f32; 3], r: f32) {
        let k = self.brush.autosmooth.clamp(0.0, 1.0);
        if k > 0.0 {
            self.smooth_dab(c, r, k, false);
        }
    }

    pub(crate) fn smooth_dab(&mut self, c: [f32; 3], r: f32, s: f32, taubin: bool) {
        let (group, nm) = mirror_group(self.brush.symmetry());
        let w = feather(c, r, &group[..nm]);
        let (curve, hardness) = (self.brush.falloff, self.brush.hardness.clamp(0.0, 1.0));
        self.slots.clear();
        self.terms.clear();
        for (j, &m) in group.iter().enumerate().take(nm) {
            self.select(flip(c, m), r, false);
            for i in 0..self.sel_v.len() {
                let f = factor(curve, hardness, self.sel_d2[i].sqrt() / r);
                if !(f > 0.0) {
                    continue;
                }
                let (slot, new) = self.slots.get(self.sel_v[i]);
                if new {
                    self.terms.resize(self.terms.len() + nm, 0.0);
                }
                self.terms[slot * nm + j] = f * w;
            }
        }
        self.u_w.clear();
        self.nb.clear();
        self.nb_off.clear();
        self.nb_off.push(0);
        for i in 0..self.slots.verts.len() {
            self.u_w.push(tree_sum1(&self.terms[nm * i..nm * (i + 1)], nm));
            let v = self.slots.verts[i];
            self.touch_and_mark(v);
            poly_ring(&self.mesh, v as usize, &mut self.nb);
            self.nb_off.push(self.nb.len() as u32);
        }
        self.smooth_pass(SMOOTH_LAMBDA * s);
        if taubin {
            self.smooth_pass(TAUBIN_MU * s);
        }
    }

    /// One Jacobi Laplacian pass over the slot vertices: p += k·w·(avg(neighbors) − p), with
    /// polygon-edge neighbours (`poly_ring`, gathered by smooth_dab).
    fn smooth_pass(&mut self, k: f32) {
        self.tmp.clear();
        for i in 0..self.slots.verts.len() {
            let v = self.slots.verts[i] as usize;
            let nb = &self.nb[self.nb_off[i] as usize..self.nb_off[i + 1] as usize];
            let p = get3(&self.mesh.positions, v);
            if nb.is_empty() {
                self.tmp.extend_from_slice(&p);
                continue;
            }
            // The neighbour sum runs in f64: a vertex and its mirror partner list the same
            // neighbours in different orders, and a sum of a few f32 values is exact in f64
            // (unless magnitudes differ by more than 2^29), so the order can't change the f32
            // average and smoothing stays mirror-exact (SYM-1).
            let mut acc = [0.0f64; 3];
            for &w in nb {
                let q = get3(&self.mesh.positions, w as usize);
                acc[0] += q[0] as f64;
                acc[1] += q[1] as f64;
                acc[2] += q[2] as f64;
            }
            let inv = 1.0 / nb.len() as f64;
            let avg = [(acc[0] * inv) as f32, (acc[1] * inv) as f32, (acc[2] * inv) as f32];
            let f = (k * self.u_w[i].min(1.0)).clamp(-1.0, 1.0);
            self.tmp.extend_from_slice(&add(p, scale(sub(avg, p), f)));
        }
        let mut moved2 = 0.0f32;
        for i in 0..self.slots.verts.len() {
            let v = self.slots.verts[i] as usize;
            let q = get3(&self.tmp, i);
            moved2 = moved2.max(len_sq(sub(q, get3(&self.mesh.positions, v))));
            set3(&mut self.mesh.positions, v, q);
        }
        self.stale += moved2.sqrt();
    }

    /// Grab (BRS-3): weights and stroke-start positions are captured once; every move places
    /// each vertex at its start position plus the (mirrored) pencil delta × weight.
    pub(crate) fn grab_begin(&mut self, anchor: [f32; 3], r: f32) {
        let (group, nm) = mirror_group(self.brush.symmetry());
        let fw = feather(anchor, r, &group[..nm]);
        let (curve, hardness) = (self.brush.falloff, self.brush.hardness.clamp(0.0, 1.0));
        self.slots.clear();
        let mut w: Vec<f32> = Vec::new();
        for (j, &m) in group.iter().enumerate().take(nm) {
            self.select(flip(anchor, m), r, false);
            for i in 0..self.sel_v.len() {
                let f = factor(curve, hardness, self.sel_d2[i].sqrt() / r);
                if !(f > 0.0) {
                    continue;
                }
                let (slot, new) = self.slots.get(self.sel_v[i]);
                if new {
                    w.resize(w.len() + nm, 0.0);
                }
                w[slot * nm + j] = f * fw;
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
        self.stroke.brush.grab = Some(Grab { anchor, n: scale(self.cam.forward, -1.0), verts, w, orig, group, nm });
    }

    pub(crate) fn grab_move(&mut self, x: f32, y: f32) {
        let Some(g) = self.stroke.brush.grab.take() else { return };
        let (o, d) = self.cam.ray(x, y);
        let denom = dot(d, g.n);
        if denom.abs() > 1e-6 {
            let t = dot(sub(g.anchor, o), g.n) / denom;
            let p = add(o, scale(d, t));
            let delta = scale(sub(p, g.anchor), self.brush.strength);
            let mut deltas = [[0.0f32; 3]; 8];
            for (j, dj) in deltas.iter_mut().enumerate().take(g.nm) {
                *dj = flip(delta, g.group[j]);
            }
            let mut t8 = [0.0f32; 24];
            for (i, &v) in g.verts.iter().enumerate() {
                for (j, dj) in deltas.iter().enumerate().take(g.nm) {
                    set3(&mut t8, j, scale(*dj, g.w[i * g.nm + j]));
                }
                let q = add(get3(&g.orig, i), tree_sum(&t8, g.nm));
                set3(&mut self.mesh.positions, v as usize, q);
                self.modified.insert(v);
            }
            self.last_dab = [g.anchor[0] + delta[0], g.anchor[1] + delta[1], g.anchor[2] + delta[2], g.n[0], g.n[1], g.n[2], self.last_dab[6]];
        }
        self.stroke.brush.grab = Some(g);
    }

    /// Snake Hook (BRS-9): the hook starts on the surface and then follows the pencil through
    /// space on the view plane at that depth. Each dab carries the geometry around the hook by
    /// the motion since the last dab, on current positions, so it trails the whole path.
    pub(crate) fn snake_begin(&mut self, x: f32, y: f32, p: f32) -> bool {
        let Some(hit) = self.raycast_screen(x, y) else { return false };
        let r = self.cam.world_radius(self.radius_px_at(p), hit.point);
        let n = scale(self.cam.forward, -1.0);
        self.last_dab = [hit.point[0], hit.point[1], hit.point[2], n[0], n[1], n[2], r];
        self.stroke.brush.snake = Some(Snake { center: hit.point });
        true
    }

    pub(crate) fn snake_dab(&mut self, x: f32, y: f32, p: f32) -> bool {
        let Some(sn) = self.stroke.brush.snake else { return false };
        let (o, d) = self.cam.ray(x, y);
        let fwd = self.cam.forward;
        let denom = dot(d, fwd);
        if denom.abs() < 1e-6 {
            return false;
        }
        let target = add(o, scale(d, dot(sub(sn.center, o), fwd) / denom));
        let delta = sub(target, sn.center);
        let r = self.cam.world_radius(self.radius_px_at(p), sn.center);
        if len_sq(delta) > 0.0 {
            let s = self.dab_strength(p);
            self.deform(sn.center, r, s, false, Prim::Snake { c: sn.center, delta, dhat: normalize(delta), k: SNAKE_PINCH });
            self.autosmooth_at(target, r);
        }
        self.stroke.brush.snake = Some(Snake { center: target });
        let n = scale(fwd, -1.0);
        self.last_dab = [target[0], target[1], target[2], n[0], n[1], n[2], r];
        self.stroke.dabs += 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::tests_support::camera;
    use crate::engine::StrokeState;
    use crate::sphere::{cube_sphere, TriMesh};

    const EYE: [f32; 3] = [0.0, 0.0, 3.0];

    fn with_mesh(m: TriMesh) -> Engine {
        let mut e = Engine::new(EditMesh::from_trimesh(m, 256));
        e.cam = camera(EYE, 800.0, 800.0);
        e.brush.symmetry_x = false;
        e
    }

    fn sphere(n: u32) -> Engine {
        with_mesh(cube_sphere(n))
    }

    /// Reference plane: an n x n quad grid over [-1, 1]^2 at z = 0 facing +z (toward the eye).
    /// With n a power of two every coordinate is exact, so the grid is exactly X/Y-symmetric.
    fn grid(n: u32, z: f32, facing_up: bool) -> TriMesh {
        let h = 2.0 / n as f32;
        let mut positions = Vec::new();
        for j in 0..=n {
            for i in 0..=n {
                positions.extend_from_slice(&[i as f32 * h - 1.0, j as f32 * h - 1.0, z]);
            }
        }
        let id = |i: u32, j: u32| j * (n + 1) + i;
        let (mut tris, mut poly_next) = (Vec::new(), Vec::new());
        for j in 0..n {
            for i in 0..n {
                let (a, b, c, d) = (id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1));
                if facing_up {
                    tris.extend_from_slice(&[a, b, c, a, c, d]);
                } else {
                    tris.extend_from_slice(&[a, d, c, a, c, b]);
                }
                poly_next.extend_from_slice(&[1, 0]);
            }
        }
        TriMesh { positions, tris, poly_next }
    }

    fn plane(n: u32) -> Engine {
        with_mesh(grid(n, 0.0, true))
    }

    /// Starts a stroke without a raycast, for dabs placed directly in world space.
    fn begin(e: &mut Engine, tool: Tool) {
        e.brush.tool = tool;
        e.tx.begin();
        e.orig_n.begin(e.mesh.nleaves());
        let mut st = StrokeState::default();
        st.active = true;
        st.tool = Some(tool);
        e.stroke = st;
    }

    /// A screen-space stroke at full pressure, then a frame (normals, bounds).
    fn stroke(e: &mut Engine, pts: &[[f32; 2]]) -> usize {
        assert!(e.stroke_begin(pts[0][0], pts[0][1], 1.0), "stroke start missed the mesh");
        let rest: Vec<f32> = pts[1..].iter().flat_map(|p| [p[0], p[1], 1.0]).collect();
        e.stroke_move(&rest);
        let n = e.stroke_end();
        e.frame_update();
        n
    }

    fn line(a: [f32; 2], b: [f32; 2], n: usize) -> Vec<[f32; 2]> {
        (0..=n).map(|i| {
            let t = i as f32 / n as f32;
            [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
        })
        .collect()
    }

    fn nearest(m: &EditMesh, p: [f32; 3]) -> usize {
        (0..m.nverts()).min_by(|&a, &b| len_sq(sub(get3(&m.positions, a), p)).total_cmp(&len_sq(sub(get3(&m.positions, b), p)))).unwrap()
    }

    /// Partner of every vertex under one mirror (the vertex at the flipped position, within 1e-5).
    fn partners(m: &EditMesh, mask: u8) -> Vec<usize> {
        let key = |p: [f32; 3]| ((p[0] * 1e4).round() as i64, (p[1] * 1e4).round() as i64, (p[2] * 1e4).round() as i64);
        let mut grid: std::collections::HashMap<(i64, i64, i64), Vec<usize>> = std::collections::HashMap::new();
        for v in 0..m.nverts() {
            grid.entry(key(get3(&m.positions, v))).or_default().push(v);
        }
        (0..m.nverts())
            .map(|v| {
                let q = flip(get3(&m.positions, v), mask);
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

    /// Largest coordinate error between each vertex's mirror image and its partner's position.
    fn mirror_error(m: &EditMesh, maps: &[(u8, Vec<usize>)]) -> f32 {
        let mut worst = 0.0f32;
        for (mask, map) in maps {
            for v in 0..m.nverts() {
                let p = flip(get3(&m.positions, v), *mask);
                let q = get3(&m.positions, map[v]);
                for a in 0..3 {
                    worst = worst.max((p[a] - q[a]).abs());
                }
            }
        }
        worst
    }

    fn tri_areas(m: &EditMesh) -> Vec<f32> {
        m.tris.chunks(3).map(|t| {
            let (a, b, c) = (get3(&m.positions, t[0] as usize), get3(&m.positions, t[1] as usize), get3(&m.positions, t[2] as usize));
            0.5 * len_sq(cross(sub(b, a), sub(c, a))).sqrt()
        })
        .collect()
    }

    /// A stroke across the front of the sphere suited to each tool (drags drag, dabs travel).
    fn sphere_stroke(tool: Tool) -> Vec<[f32; 2]> {
        match tool {
            // Off the mirror planes: a drag starting where X and Y planes cross is held still by
            // its own mirror images (their tangential deltas cancel exactly).
            Tool::Grab | Tool::SnakeHook => line([440.0, 370.0], [500.0, 340.0], 20),
            _ => line([330.0, 380.0], [470.0, 430.0], 40),
        }
    }

    // ---------- STK-4 ----------

    #[test]
    fn stk4_falloff_presets_match_formulas() {
        let formulas: [(Falloff, fn(f64) -> f64); 9] = [
            (Falloff::Smooth, |p| 3.0 * p * p - 2.0 * p * p * p),
            (Falloff::Smoother, |p| p * p * p * (6.0 * p * p - 15.0 * p + 10.0)),
            (Falloff::Sphere, |p| (2.0 * p - p * p).sqrt()),
            (Falloff::Root, |p| p.sqrt()),
            (Falloff::Sharp, |p| p * p),
            (Falloff::Linear, |p| p),
            (Falloff::Pow4, |p| p.powi(4)),
            (Falloff::InvSquare, |p| p * (2.0 - p)),
            (Falloff::Constant, |_| 1.0),
        ];
        let mut report = Vec::new();
        for (curve, f) in formulas {
            let mut worst = 0.0f64;
            for i in 0..=1000 {
                let q = i as f32 / 1000.0;
                let want = if q < 1.0 { f(1.0 - q as f64) } else { 0.0 };
                worst = worst.max((factor(curve, 0.0, q) as f64 - want).abs());
            }
            assert!(worst < 1e-6, "{curve:?} off its formula by {worst}");
            assert_eq!(factor(curve, 0.0, 0.0), 1.0, "{curve:?} at the center");
            assert_eq!(factor(curve, 0.0, 1.5), 0.0, "{curve:?} outside");
            assert_eq!(factor(curve, 0.0, f32::NAN), 0.0, "{curve:?} on NaN");
            report.push(format!("{curve:?} {worst:.1e}"));
        }
        println!("stk4 presets, max |factor - formula| over 1001 distances: {}", report.join(", "));
    }

    #[test]
    fn stk4_hardness_remaps_distance() {
        let mut worst = 0.0f32;
        for curve in Falloff::ALL {
            for h in [0.0f32, 0.25, 0.5, 0.9] {
                let mut last = f32::INFINITY;
                for i in 0..=1000 {
                    let q = i as f32 / 1000.0;
                    let f = factor(curve, h, q);
                    let want = if q >= 1.0 { 0.0 } else if q <= h { 1.0 } else { curve.eval(1.0 - (q - h) / (1.0 - h)) };
                    worst = worst.max((f - want).abs());
                    assert!(f <= last + 1e-6, "{curve:?} h {h}: not monotone at q {q}");
                    last = f;
                }
            }
            // Hardness 1 turns every curve into a constant inside the radius.
            for i in 0..1000 {
                assert_eq!(factor(curve, 1.0, i as f32 / 1000.0), 1.0);
            }
        }
        // The curve is stretched over the outer part of the radius: h = 0.5 at q = 0.75 is the
        // plain curve at q = 0.5.
        let stretched = factor(Falloff::Smooth, 0.5, 0.75);
        assert_eq!(stretched, factor(Falloff::Smooth, 0.0, 0.5));
        println!("stk4 hardness: max |factor - (q-h)/(1-h) remap| {worst:.1e}; smooth h=0.5 at q=0.75 -> {stretched}");
        assert!(worst < 1e-6);
    }

    /// Golden profiles: one Draw dab on the reference plane moves every vertex straight up by
    /// r · DRAW_K · factor(preset, hardness, d / r), for every preset and two hardnesses.
    #[test]
    fn stk4_brs1_golden_profiles_on_the_reference_plane() {
        let (c, r) = ([0.1f32, 0.05, 0.0], 0.3f32);
        let mut report = Vec::new();
        for curve in Falloff::ALL {
            for h in [0.0f32, 0.5] {
                let mut e = plane(128);
                let before = e.mesh.positions.clone();
                begin(&mut e, Tool::Draw);
                e.brush.falloff = curve;
                e.brush.hardness = h;
                e.dab_draw(c, r, 1.0, [0.0, 0.0, 1.0]);
                let (mut worst, mut moved) = (0.0f32, 0);
                for v in 0..e.mesh.nverts() {
                    let p0 = get3(&before, v);
                    let p1 = get3(&e.mesh.positions, v);
                    let want = r * DRAW_K * factor(curve, h, len_sq(sub(p0, c)).sqrt() / r);
                    assert!(p1[0] == p0[0] && p1[1] == p0[1], "{curve:?}: tangential motion");
                    worst = worst.max((p1[2] - p0[2] - want).abs());
                    moved += (p1[2] != p0[2]) as usize;
                }
                let rel = worst / (r * DRAW_K);
                assert!(rel < 1e-5, "{curve:?} h {h}: profile off by {rel} of the peak");
                assert!(moved > 500);
                report.push(format!("{curve:?}/h{h} {rel:.1e}"));
            }
        }
        println!("stk4 golden plane profiles, max error / peak: {}", report.join(", "));
    }

    // ---------- STK-11 ----------

    #[test]
    fn stk11_area_plane_front_facing_wins() {
        // A thin plate: the front sheet (z = 0) faces the eye, the back sheet 0.02 below faces away.
        let front = grid(64, 0.0, true);
        let back = grid(64, -0.02, false);
        let off = front.nverts() as u32;
        let mut m = front;
        m.positions.extend_from_slice(&back.positions);
        m.tris.extend(back.tris.iter().map(|&v| v + off));
        m.poly_next.extend_from_slice(&back.poly_next);
        let mut e = with_mesh(m);
        let fallback = Plane { point: [9.0; 3], normal: [1.0, 0.0, 0.0] };
        begin(&mut e, Tool::Flatten);
        let p = e.sample_plane([0.0, 0.0, 0.0], 0.3, false, fallback);
        println!("stk11 plate seen from +z: normal {:?}, point z {:.2e}", p.normal, p.point[2]);
        assert!(p.normal[2] > 0.999_999 && p.point[2].abs() < 1e-6, "front sheet must win: {p:?}");
        // Seen from below, the other sheet faces the eye and wins.
        e.cam = camera([0.0, 0.0, -3.0], 800.0, 800.0);
        let p = e.sample_plane([0.0, 0.0, -0.02], 0.3, false, fallback);
        println!("stk11 plate seen from -z: normal {:?}, point z {:.4}", p.normal, p.point[2]);
        assert!(p.normal[2] < -0.999_999 && (p.point[2] + 0.02).abs() < 1e-6, "back sheet must win from below: {p:?}");
        // With nothing facing the eye, the back-facing vertices still define the plane.
        let mut e = plane(64);
        e.cam = camera([0.0, 0.0, -3.0], 800.0, 800.0);
        begin(&mut e, Tool::Flatten);
        let p = e.sample_plane([0.0, 0.0, 0.0], 0.3, false, fallback);
        assert!(p.normal[2] > 0.999_999 && p.point[2].abs() < 1e-6, "no front-facing vertex: {p:?}");
    }

    /// Accumulate off samples the stroke-start surface: 60 Clay dabs in one place converge to the
    /// offset plane over the original surface. Accumulate on samples the current surface, so
    /// the same dabs keep building.
    #[test]
    fn stk11_brs6_accumulate_flag_switches_original_and_current_sampling() {
        let (c, r) = ([0.0f32, 0.0, 0.0], 0.3f32);
        let mut heights = [0.0f32; 2];
        for (k, accumulate) in [false, true].into_iter().enumerate() {
            let mut e = plane(128);
            begin(&mut e, Tool::Clay);
            e.brush.accumulate = accumulate;
            let v = nearest(&e.mesh, c);
            for _ in 0..60 {
                e.dab(Tool::Clay, c, r, 1.0, [0.0, 0.0, 1.0]);
                e.frame_update();
            }
            heights[k] = e.mesh.positions[3 * v + 2] / (CLAY_OFFSET * r);
        }
        println!("stk11 clay 60 dabs, center height / offset: accumulate off {:.6}, on {:.3}", heights[0], heights[1]);
        assert!(heights[0] > 0.999 && heights[0] <= 1.0 + 1e-5, "off: capped at the stroke-start offset plane");
        assert!(heights[1] > 1.5, "on: keeps building");
    }

    #[test]
    fn stk11_autosmooth_relaxes_every_dab() {
        let mut rms = [0.0f64; 2];
        for (k, auto) in [0.0f32, 0.5].into_iter().enumerate() {
            let mut e = plane(128);
            // Deterministic noise of +-0.002 on the plane.
            let mut seed = 99u32;
            for v in 0..e.mesh.nverts() {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                e.mesh.positions[3 * v + 2] = (seed as f32 / u32::MAX as f32 - 0.5) * 0.004;
            }
            for v in 0..e.mesh.nverts() {
                e.mesh.vertex_normal(v);
            }
            e.brush.tool = Tool::Draw;
            e.brush.strength = 0.2;
            e.brush.autosmooth = auto;
            stroke(&mut e, &line([300.0, 400.0], [500.0, 400.0], 40));
            // Umbrella (Laplacian) magnitude over the middle of the stroke.
            let (mut sum, mut n) = (0.0f64, 0);
            for v in 0..e.mesh.nverts() {
                let p = get3(&e.mesh.positions, v);
                if p[0].abs() > 0.2 || p[1].abs() > 0.05 {
                    continue;
                }
                let nb = e.mesh.neighbors(v);
                let avg = nb.iter().map(|&w| e.mesh.positions[3 * w as usize + 2] as f64).sum::<f64>() / nb.len() as f64;
                sum += (avg - p[2] as f64).powi(2);
                n += 1;
            }
            rms[k] = (sum / n as f64).sqrt();
        }
        println!("stk11 autosmooth: umbrella RMS along the stroke {:.2e} (off) -> {:.2e} (0.5), ratio {:.3}", rms[0], rms[1], rms[1] / rms[0]);
        assert!(rms[1] < 0.5 * rms[0]);
    }

    // ---------- SYM-1 ----------

    #[test]
    fn sym1_every_axis_combination_is_mirror_exact() {
        let base = sphere(48);
        let maps: Vec<(u8, Vec<usize>)> = [1u8, 2, 4].iter().map(|&a| (a, partners(&base.mesh, a))).collect();
        let base_err = mirror_error(&base.mesh, &maps);
        let mut report = Vec::new();
        for mask in 1u8..=7 {
            let mut e = sphere(48);
            e.brush.tool = Tool::Draw;
            (e.brush.symmetry_x, e.brush.symmetry_y, e.brush.symmetry_z) = (mask & 1 != 0, mask & 2 != 0, mask & 4 != 0);
            stroke(&mut e, &line([330.0, 380.0], [470.0, 430.0], 40));
            let axes: Vec<(u8, Vec<usize>)> = maps.iter().filter(|(a, _)| mask & a != 0).cloned().collect();
            let err = mirror_error(&e.mesh, &axes);
            assert!(err < 1e-6, "mask {mask}: mirror error {err}");
            report.push(format!("{mask:03b} {err:.1e}"));
        }
        println!("sym1 draw, mirror error per axis mask (base mesh {base_err:.1e}): {}", report.join(", "));
    }

    #[test]
    fn sym1_brs1_brs2_brs3_brs4_brs5_brs6_brs7_brs8_brs9_brs10_brs11_xyz_mirror_exact_for_every_brush() {
        let base = sphere(48);
        let maps: Vec<(u8, Vec<usize>)> = [1u8, 2, 4].iter().map(|&a| (a, partners(&base.mesh, a))).collect();
        let base_err = mirror_error(&base.mesh, &maps);
        let mut report = Vec::new();
        for tool in Tool::ALL {
            let mut e = sphere(48);
            e.brush.tool = tool;
            e.brush.strength = 1.0;
            (e.brush.symmetry_x, e.brush.symmetry_y, e.brush.symmetry_z) = (true, true, true);
            if tool == Tool::Crease {
                e.brush.falloff = Falloff::Sharp;
            }
            let before = e.mesh.position_hash();
            stroke(&mut e, &sphere_stroke(tool));
            assert_ne!(e.mesh.position_hash(), before, "{tool:?} changed nothing");
            let err = mirror_error(&e.mesh, &maps);
            assert!(err < 1e-6, "{tool:?}: XYZ mirror error {err}");
            report.push(format!("{tool:?} {err:.1e}"));
        }
        println!("sym1 XYZ mirror error per brush (base mesh {base_err:.1e}): {}", report.join(", "));
    }

    /// A dab on a mirror plane overlaps its image completely: the two share the strength, so the
    /// result equals one dab without symmetry (Blender's feather), instead of doubling.
    #[test]
    fn sym1_feather_never_doubles_strength() {
        let r = 0.3f32;
        let mut report = Vec::new();
        for (c, mask) in [([0.0f32, 0.2, 0.0], 1u8), ([0.0, 0.0, 0.0], 3), ([0.15, 0.2, 0.0], 1), ([0.7, 0.2, 0.0], 1)] {
            let mut lift = [0.0f32; 2];
            for (k, m) in [0u8, mask].into_iter().enumerate() {
                let mut e = plane(128);
                begin(&mut e, Tool::Draw);
                (e.brush.symmetry_x, e.brush.symmetry_y) = (m & 1 != 0, m & 2 != 0);
                let v = nearest(&e.mesh, c);
                e.dab_draw(c, r, 1.0, [0.0, 0.0, 1.0]);
                lift[k] = e.mesh.positions[3 * v + 2];
            }
            let ratio = lift[1] / lift[0];
            report.push(format!("c {c:?} mask {mask}: {ratio:.6}"));
            assert!(ratio <= 1.0 + 1e-6, "strength grew at {c:?}: {ratio}");
            if c[0] == 0.0 || c[0] >= 2.0 * r {
                assert!((ratio - 1.0).abs() < 1e-6, "on the plane or clear of it: {ratio}");
            }
        }
        println!("sym1 feather, center lift with symmetry / without: {}", report.join("; "));
    }

    // ---------- brushes ----------

    #[test]
    fn brs4_inflate_moves_along_vertex_normals_and_a_sphere_stays_round() {
        // One constant dab (hardness 1) covering the whole sphere: every vertex moves along its
        // own normal by the same amount, so the sphere grows and stays round.
        let mut e = sphere(48);
        begin(&mut e, Tool::Inflate);
        e.brush.hardness = 1.0;
        let (c, r) = ([0.0f32; 3], 3.0f32);
        let p0 = e.mesh.positions.clone();
        let n0: Vec<f32> = (0..e.mesh.nverts()).flat_map(|v| poly_normal(&e.mesh, &|u: usize| get3(&p0, u), v)).collect();
        e.dab(Tool::Inflate, c, r, 1.0, [0.0, 0.0, 1.0]);
        let mut worst_dir = 0.0f32;
        for v in 0..e.mesh.nverts() {
            let d = sub(get3(&e.mesh.positions, v), get3(&p0, v));
            worst_dir = worst_dir.max(1.0 - dot(normalize(d), get3(&n0, v)));
        }
        for _ in 0..9 {
            e.frame_update();
            e.dab(Tool::Inflate, c, r, 1.0, [0.0, 0.0, 1.0]);
        }
        let radii: Vec<f64> = (0..e.mesh.nverts()).map(|v| len_sq(get3(&e.mesh.positions, v)).sqrt() as f64).collect();
        let mean = radii.iter().sum::<f64>() / radii.len() as f64;
        let sigma = (radii.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / radii.len() as f64).sqrt();
        println!("brs4 inflate: 1 - cos(motion, vertex normal) max {worst_dir:.1e}; after 10 dabs radius {mean:.4} (expected {:.4}), sigma/mean {:.2e}", 1.0 + 10.0 * r * INFLATE_K, sigma / mean);
        assert!(worst_dir < 1e-6);
        assert!(sigma / mean < 0.01, "radial sigma {:.3}%", 100.0 * sigma / mean);
        assert!((mean - (1.0 + 10.0 * r as f64 * INFLATE_K as f64)).abs() < 0.01);
    }

    #[test]
    fn brs4_inflate_golden_profile_on_the_reference_plane() {
        let mut e = plane(128);
        let before = e.mesh.positions.clone();
        begin(&mut e, Tool::Inflate);
        let (c, r) = ([-0.2f32, 0.1, 0.0], 0.3f32);
        e.dab(Tool::Inflate, c, r, 1.0, [0.0, 0.0, 1.0]);
        let mut worst = 0.0f32;
        for v in 0..e.mesh.nverts() {
            let p0 = get3(&before, v);
            let want = r * INFLATE_K * factor(Falloff::Smooth, 0.0, len_sq(sub(p0, c)).sqrt() / r);
            worst = worst.max((e.mesh.positions[3 * v + 2] - p0[2] - want).abs());
        }
        println!("brs4 inflate plane profile: max error / peak {:.1e}", worst / (r * INFLATE_K));
        assert!(worst / (r * INFLATE_K) < 1e-5);
    }

    #[test]
    fn brs5_flatten_converges_to_the_area_plane() {
        // The cap of a sphere under the brush flattens onto its area plane.
        let mut e = sphere(64);
        begin(&mut e, Tool::Flatten);
        let (c, r) = ([0.0f32, 0.0, 1.0], 0.4f32);
        let fallback = Plane { point: c, normal: [0.0, 0.0, 1.0] };
        let spread = |e: &mut Engine| -> f32 {
            let pl = e.sample_plane(c, r, false, fallback);
            let mut worst = 0.0f32;
            for i in 0..e.sel_v.len() {
                if e.sel_d2[i] < (0.5 * r) * (0.5 * r) {
                    worst = worst.max(dot(sub(get3(&e.sel_p, i), pl.point), pl.normal).abs());
                }
            }
            worst
        };
        let h0 = spread(&mut e);
        let mut trace = Vec::new();
        for k in 1..=40 {
            e.dab(Tool::Flatten, c, r, 1.0, [0.0, 0.0, 1.0]);
            e.frame_update();
            if k % 10 == 0 {
                trace.push(spread(&mut e));
            }
        }
        let t: Vec<String> = trace.iter().map(|x| format!("{x:.2e}")).collect();
        println!("brs5 flatten: max |distance to area plane| within r/2: {h0:.2e} -> {} after 10/20/30/40 dabs", t.join(" "));
        assert!(trace[3] < 0.01 * h0);
        // A flat surface is already on its plane: nothing moves.
        let mut e = plane(128);
        let h = e.mesh.position_hash();
        begin(&mut e, Tool::Flatten);
        e.dab(Tool::Flatten, [0.1, 0.0, 0.0], 0.3, 1.0, [0.0, 0.0, 1.0]);
        assert_eq!(e.mesh.position_hash(), h);
    }

    #[test]
    fn brs6_clay_builds_toward_the_offset_plane() {
        let mut e = plane(128);
        let before = e.mesh.positions.clone();
        begin(&mut e, Tool::Clay);
        let (c, r) = ([0.05f32, -0.1, 0.0], 0.3f32);
        e.dab(Tool::Clay, c, r, 1.0, [0.0, 0.0, 1.0]);
        // One dab on a plane: each vertex closes CLAY_K of its gap to the plane CLAY_OFFSET·r up.
        let mut worst = 0.0f32;
        for v in 0..e.mesh.nverts() {
            let p0 = get3(&before, v);
            let want = CLAY_OFFSET * r * CLAY_K * factor(Falloff::Smooth, 0.0, len_sq(sub(p0, c)).sqrt() / r);
            worst = worst.max((e.mesh.positions[3 * v + 2] - p0[2] - want).abs());
        }
        let peak = CLAY_OFFSET * r * CLAY_K;
        // Accumulating dabs build up past the first offset plane.
        let v = nearest(&e.mesh, c);
        let mut h = vec![e.mesh.positions[3 * v + 2] / (CLAY_OFFSET * r)];
        for _ in 0..30 {
            e.frame_update();
            e.dab(Tool::Clay, c, r, 1.0, [0.0, 0.0, 1.0]);
            h.push(e.mesh.positions[3 * v + 2] / (CLAY_OFFSET * r));
        }
        println!("brs6 clay: one-dab profile error / peak {:.1e}; center height / offset after 1, 10, 20, 31 dabs: {:.3} {:.3} {:.3} {:.3}", worst / peak, h[0], h[9], h[19], h[30]);
        assert!(worst / peak < 1e-5);
        assert!(h.windows(2).all(|w| w[1] > w[0]), "clay must keep building");
        assert!(h[30] > 1.0);
    }

    #[test]
    fn brs6_clay_strips_square_tangent_falloff() {
        let mut e = plane(128);
        let before = e.mesh.positions.clone();
        begin(&mut e, Tool::ClayStrips);
        let g = 1.0 / 64.0; // grid spacing
        let (c, r) = ([0.0f32, 0.0, 0.0], 20.0 * g);
        // The first dab only records where the strip starts; the second runs along +x.
        e.dab(Tool::ClayStrips, [-0.5 * g, 0.0, 0.0], r, 1.0, [0.0, 0.0, 1.0]);
        assert_eq!(e.mesh.positions, before, "first dab has no direction yet");
        e.dab(Tool::ClayStrips, c, r, 1.0, [0.0, 0.0, 1.0]);
        let lift = |e: &Engine, x: f32, y: f32| {
            let v = nearest(&e.mesh, [x * g, y * g, 0.0]);
            e.mesh.positions[3 * v + 2]
        };
        let (edge, diag, corner, outside) = (lift(&e, 12.0, 0.0), lift(&e, 12.0, 12.0), lift(&e, 17.0, 17.0), lift(&e, 21.0, 0.0));
        // Golden: every vertex rises STRIPS_OFFSET·r × factor(Chebyshev distance) × z-window.
        let u = -STRIPS_OFFSET / STRIPS_DEPTH;
        let wz = 1.0 - u * u;
        let mut worst = 0.0f32;
        for v in 0..e.mesh.nverts() {
            let p0 = get3(&before, v);
            let dq = p0[0].abs().max(p0[1].abs()) / r;
            let want = STRIPS_OFFSET * r * factor(Falloff::Smooth, 0.0, dq) * wz;
            worst = worst.max((e.mesh.positions[3 * v + 2] - want).abs());
        }
        println!(
            "brs6 clay strips: lift at (0.6r,0) {edge:.5}, (0.6r,0.6r) {diag:.5} (ratio {:.6}), corner (0.85r,0.85r) {corner:.5}, (1.05r,0) {outside}; profile error / peak {:.1e}",
            diag / edge,
            worst / (STRIPS_OFFSET * r)
        );
        assert_eq!(edge, diag, "equal Chebyshev distance, equal lift: the footprint is square");
        assert!(corner > 0.0, "the square's corner lies outside the round radius and still moves");
        assert_eq!(outside, 0.0);
        assert!(worst / (STRIPS_OFFSET * r) < 1e-5);
        // One-sided: a vertex already above the target plane is never shaved down.
        let mut e = plane(128);
        let v = nearest(&e.mesh, [0.0, 0.0, 0.0]);
        e.mesh.positions[3 * v + 2] = 0.5 * r;
        begin(&mut e, Tool::ClayStrips);
        e.dab(Tool::ClayStrips, [-0.5 * g, 0.0, 0.0], r, 1.0, [0.0, 0.0, 1.0]);
        e.dab(Tool::ClayStrips, c, r, 1.0, [0.0, 0.0, 1.0]);
        assert_eq!(e.mesh.positions[3 * v + 2], 0.5 * r);
    }

    #[test]
    fn brs7_crease_v_profile_and_pinch_to_the_line() {
        let mut out = Vec::new();
        for tool in [Tool::Crease, Tool::Draw] {
            let mut e = plane(256);
            let before = e.mesh.positions.clone();
            e.brush.tool = tool;
            e.brush.strength = 1.0;
            e.brush.radius_px = 40.0;
            e.brush.falloff = if tool == Tool::Crease { Falloff::Sharp } else { Falloff::Smooth };
            stroke(&mut e, &line([250.0, 400.0], [550.0, 400.0], 60));
            let r = e.last_dab[6];
            // Cross-section across the stroke at x = 0: the vertices of that grid column, which
            // the line pull moves sideways (rows: original y, dz, dy, dx).
            let mut rows: Vec<(f32, f32, f32, f32)> = Vec::new();
            for v in 0..e.mesh.nverts() {
                let p0 = get3(&before, v);
                if p0[0] == 0.0 && p0[1].abs() < 1.2 * r {
                    let p = get3(&e.mesh.positions, v);
                    rows.push((p0[1], p[2] - p0[2], p[1] - p0[1], p[0] - p0[0]));
                }
            }
            // The profile is the surface where it ended up: depth against final y.
            let mut prof: Vec<(f32, f32)> = rows.iter().map(|w| (w.0 + w.2, w.1)).collect();
            prof.sort_by(|a, b| a.0.total_cmp(&b.0));
            let at = |y: f32| {
                let i = prof.windows(2).position(|w| w[0].0 <= y && y <= w[1].0).unwrap();
                let (a, b) = (prof[i], prof[i + 1]);
                a.1 + (b.1 - a.1) * (y - a.0) / (b.0 - a.0)
            };
            let depth = at(0.0);
            let v_ratio = 0.5 * (at(0.15 * r) + at(-0.15 * r)) / depth;
            let inward = rows.iter().filter(|w| w.0.abs() > 0.05 * r && w.0.abs() < 0.8 * r).all(|w| w.2 * w.0 < 0.0);
            let max_dx = rows.iter().map(|w| w.3.abs()).fold(0.0f32, f32::max);
            out.push((tool, depth / r, v_ratio, inward, max_dx / r));
        }
        let (crease, draw) = (out[0], out[1]);
        println!(
            "brs7 crease: center depth {:.4} r; depth at 0.15 r / center {:.3} (draw's U-profile {:.3}); rows pulled toward the line: {}; max motion along the stroke {:.1e} r",
            -crease.1, crease.2, draw.2, crease.3, crease.4
        );
        assert!(crease.1 < 0.0, "crease cuts in");
        assert!(crease.2 < 0.8 && draw.2 > 0.9, "V vs U profile");
        assert!(crease.3, "both sides pinch toward the line");
        assert!(crease.4 < 1e-4);
    }

    #[test]
    fn brs8_pinch_moves_nothing_along_the_normal_of_a_plane() {
        let mut e = plane(128);
        let before = e.mesh.positions.clone();
        e.brush.tool = Tool::Pinch;
        e.brush.strength = 1.0;
        stroke(&mut e, &line([320.0, 380.0], [480.0, 420.0], 40));
        let (mut max_dz, mut moved, mut max_dxy) = (0.0f32, 0, 0.0f32);
        for v in 0..e.mesh.nverts() {
            let d = sub(get3(&e.mesh.positions, v), get3(&before, v));
            max_dz = max_dz.max(d[2].abs());
            max_dxy = max_dxy.max((d[0] * d[0] + d[1] * d[1]).sqrt());
            moved += (d != [0.0; 3]) as usize;
        }
        // Stationary dabs pull inward without overshooting the center.
        let mut e = plane(128);
        begin(&mut e, Tool::Pinch);
        let c = [0.1f32, 0.1, 0.0];
        let p0 = e.mesh.positions.clone();
        for _ in 0..5 {
            e.dab(Tool::Pinch, c, 0.3, 1.0, [0.0, 0.0, 1.0]);
        }
        let mut ok = true;
        for v in 0..e.mesh.nverts() {
            let (a, b) = (get3(&p0, v), get3(&e.mesh.positions, v));
            if a != b {
                ok &= len_sq(sub(c, b)) < len_sq(sub(c, a)) && dot(sub(c, b), sub(c, a)) > 0.0;
            }
        }
        println!("brs8 pinch stroke: {moved} vertices moved up to {max_dxy:.4} in-plane, max |normal motion| {max_dz:e}; stationary dabs inward without overshoot: {ok}");
        assert!(moved > 100 && max_dxy > 1e-3);
        assert_eq!(max_dz, 0.0);
        assert!(ok);
    }

    #[test]
    fn brs9_snake_hook_follows_the_path() {
        let mut e = sphere(64);
        e.brush.tool = Tool::SnakeHook;
        e.brush.strength = 1.0;
        e.brush.radius_px = 60.0;
        e.brush.pressure_strength = false;
        let hit = e.raycast_screen(400.0, 400.0).unwrap();
        let tip = nearest(&e.mesh, hit.point);
        let start = get3(&e.mesh.positions, tip);
        let mut path = line([400.0, 400.0], [550.0, 400.0], 30);
        path.extend(line([550.0, 400.0], [550.0, 250.0], 30).into_iter().skip(1));
        assert!(stroke(&mut e, &path) > 0);
        let end = [e.last_dab[0], e.last_dab[1], e.last_dab[2]];
        let r = e.last_dab[6];
        let p = get3(&e.mesh.positions, tip);
        let lag = len_sq(sub(p, end)).sqrt();
        let travel = len_sq(sub(p, start)).sqrt();
        let finite = e.mesh.positions.iter().all(|x| x.is_finite());
        let min_area = tri_areas(&e.mesh).into_iter().fold(f32::INFINITY, f32::min);
        println!("brs9 snake hook: tip travelled {travel:.3} along an L-shaped path, ends {lag:.2e} ({:.2}% of r) from the pencil; min triangle area {min_area:.2e}", 100.0 * lag / r);
        assert!(travel > 0.4);
        assert!(lag < 0.05 * r);
        assert!(finite && min_area > 0.0);
    }

    #[test]
    fn brs10_layer_height_capped_regardless_of_dab_count() {
        let mut report = Vec::new();
        for (passes, sym) in [(1usize, false), (10, false), (40, false), (40, true)] {
            let mut e = plane(128);
            e.brush.tool = Tool::Layer;
            e.brush.strength = 1.0;
            e.brush.symmetry_x = sym;
            let mut path = Vec::new();
            for k in 0..passes {
                let (a, b) = if k % 2 == 0 { ([300.0, 400.0], [500.0, 400.0]) } else { ([500.0, 400.0], [300.0, 400.0]) };
                path.extend(line(a, b, 40));
            }
            // The cap is set by the first dab's radius (later dabs hit the raised layer, nearer
            // the eye, so their world radius is smaller).
            let first = e.raycast_screen(path[0][0], path[0][1]).unwrap();
            let h = LAYER_HEIGHT * e.cam.world_radius(e.radius_px_at(1.0), first.point);
            stroke(&mut e, &path);
            let top = e.mesh.positions.chunks(3).map(|p| p[2]).fold(f32::MIN, f32::max);
            let center = e.mesh.positions[3 * nearest(&e.mesh, [0.0, 0.0, 0.0]) + 2];
            report.push(format!("{passes} passes{}: max {:.6} H, center {:.4} H", if sym { " +X" } else { "" }, top / h, center / h));
            assert!(top <= h * (1.0 + 1e-5), "layer exceeded its height: {}", top / h);
            assert!(center > 0.99 * h || passes == 1);
        }
        println!("brs10 layer: {}", report.join("; "));
    }

    #[test]
    fn brs11_brs5_fill_scrape_planar_one_plane_primitive_with_one_sided_limits() {
        // A plane with bumps and dents: z = A sin(6x) sin(6y).
        let bumpy = || {
            let mut e = plane(128);
            for v in 0..e.mesh.nverts() {
                let p = get3(&e.mesh.positions, v);
                e.mesh.positions[3 * v + 2] = 0.02 * (6.0 * p[0]).sin() * (6.0 * p[1]).sin();
            }
            for v in 0..e.mesh.nverts() {
                e.mesh.vertex_normal(v);
            }
            e
        };
        let (c, r) = ([0.05f32, 0.02, 0.0], 0.4f32);
        let fallback = Plane { point: c, normal: [0.0, 0.0, 1.0] };
        let mut report = Vec::new();
        for tool in [Tool::Fill, Tool::Scrape, Tool::Flatten] {
            let mut e = bumpy();
            begin(&mut e, tool);
            let pl = e.sample_plane(c, r, false, fallback);
            let before = e.mesh.positions.clone();
            e.dab(tool, c, r, 1.0, [0.0, 0.0, 1.0]);
            let (mut up, mut down, mut wrong) = (0, 0, 0);
            for v in 0..e.mesh.nverts() {
                let (a, b) = (get3(&before, v), get3(&e.mesh.positions, v));
                let h0 = dot(sub(a, pl.point), pl.normal);
                let h1 = dot(sub(b, pl.point), pl.normal);
                if a == b {
                    continue;
                }
                if h1 > h0 { up += 1 } else { down += 1 }
                // Never past the plane, never on the excluded side.
                let excluded = match tool {
                    Tool::Fill => h0 > 0.0,
                    Tool::Scrape => h0 < 0.0,
                    _ => false,
                };
                if excluded || h1.abs() > h0.abs() + 1e-7 || h1 * h0 < 0.0 {
                    wrong += 1;
                }
            }
            report.push(format!("{tool:?}: {up} up, {down} down, {wrong} wrong"));
            assert_eq!(wrong, 0, "{tool:?}");
            match tool {
                Tool::Fill => assert!(up > 100 && down == 0),
                Tool::Scrape => assert!(down > 100 && up == 0),
                _ => assert!(up > 100 && down > 100),
            }
        }
        // Planar holds the first dab's plane for the whole stroke; Flatten re-samples per dab.
        let mut e = bumpy();
        begin(&mut e, Tool::Planar);
        let first = e.sample_plane(c, r, false, fallback);
        let path: Vec<[f32; 3]> = (0..40).map(|k| [c[0] + 0.004 * k as f32, c[1], 0.0]).collect();
        for p in &path {
            e.dab(Tool::Planar, *p, r, 1.0, [0.0, 0.0, 1.0]);
            e.frame_update();
        }
        let held = e.stroke.brush.plane.unwrap();
        let mut off = 0.0f32;
        for v in 0..e.mesh.nverts() {
            let p = get3(&e.mesh.positions, v);
            if len_sq(sub(p, path[39])) < (0.3 * r) * (0.3 * r) {
                off = off.max(dot(sub(p, first.point), first.normal).abs());
            }
        }
        report.push(format!("Planar: held plane == first-dab plane {}, max distance to it near the end {off:.1e}", held == first));
        println!("brs11 plane primitive: {}", report.join("; "));
        assert_eq!(held, first);
        assert!(off < 1e-3 * 0.02);
    }

    // ---------- gates shared by every brush ----------

    #[test]
    fn brs1_brs2_brs3_brs4_brs5_brs6_brs7_brs8_brs9_brs10_brs11_no_nan_or_degenerate_triangles() {
        let mut report = Vec::new();
        for tool in Tool::ALL {
            let mut e = sphere(48);
            let a0 = tri_areas(&e.mesh);
            e.brush.tool = tool;
            e.brush.strength = 1.0;
            e.brush.symmetry_x = true;
            if tool == Tool::Crease {
                e.brush.falloff = Falloff::Sharp;
            }
            // Three overlapping strokes, the last one zig-zagging.
            for k in 0..2 {
                stroke(&mut e, &sphere_stroke(tool).iter().map(|p| [p[0], p[1] + 10.0 * k as f32]).collect::<Vec<_>>());
            }
            let zig: Vec<[f32; 2]> = (0..60).map(|i| [340.0 + 2.0 * i as f32, 400.0 + if i % 2 == 0 { 15.0 } else { -15.0 }]).collect();
            // Pinch contracts its neighbourhood by (1 - k·f) per dab, so 360 dabs into one patch
            // shrink it geometrically by design (Blender's pinch does the same); dynamic
            // topology (TOP-3) is what keeps such a patch tessellated.
            if !matches!(tool, Tool::Grab | Tool::SnakeHook | Tool::Pinch) {
                e.brush.strength = 0.5; // the app's default strength
                stroke(&mut e, &zig);
            }
            assert!(e.mesh.positions.iter().all(|x| x.is_finite()) && e.mesh.normals.iter().all(|x| x.is_finite()), "{tool:?}: NaN");
            let min_ratio = tri_areas(&e.mesh).iter().zip(&a0).map(|(a, b)| a / b).fold(f32::INFINITY, f32::min);
            report.push(format!("{tool:?} {min_ratio:.1e}"));
            // Degenerate = collapsed to rounding level. Heavy pinching legitimately thins
            // triangles on a fixed topology (dynamic topology, TOP-3, re-tessellates them).
            assert!(min_ratio > 1e-6, "{tool:?}: a triangle collapsed to {min_ratio} of its area");
        }
        println!("brush gate, smallest triangle area / original after two full-strength strokes (+ a 360-dab zig-zag at strength 0.5 except drags and Pinch): {}", report.join(", "));
    }

    #[test]
    fn und1_prj3_brs4_brs5_brs6_brs7_brs8_brs9_brs10_brs11_every_brush_undoes_and_replays_exactly() {
        use crate::history::apply_record;
        for tool in Tool::ALL {
            let mut e = sphere(40);
            e.brush.tool = tool;
            e.brush.strength = 1.0;
            let start = e.mesh.positions.clone();
            let h0 = e.mesh.position_hash();
            assert!(stroke(&mut e, &sphere_stroke(tool)) > 0, "{tool:?}: no journal record");
            let record = e.out.clone();
            let h1 = e.mesh.position_hash();
            assert_ne!(h0, h1);
            assert!(e.undo() > 0);
            assert_eq!(e.mesh.position_hash(), h0, "{tool:?}: undo");
            assert!(e.redo() > 0);
            assert_eq!(e.mesh.position_hash(), h1, "{tool:?}: redo");
            e.mesh.positions.copy_from_slice(&start);
            apply_record(&mut e.mesh, &record).unwrap();
            assert_eq!(e.mesh.position_hash(), h1, "{tool:?}: journal replay");
        }
    }

    // ---------- Invert, hold buttons (NAV-5), stabilizer (STK-3) ----------

    /// Inverted brushes on the reference plane: exact mirror images of their golden profiles.
    #[test]
    fn brs1_brs4_brs6_brs8_brs10_inverted_brushes_golden_on_the_plane() {
        let (c, r) = ([0.05f32, -0.05, 0.0], 0.3f32);
        let mut report = Vec::new();
        for (tool, peak) in [(Tool::Draw, r * DRAW_K), (Tool::Inflate, r * INFLATE_K), (Tool::Clay, CLAY_OFFSET * r * CLAY_K)] {
            let mut e = plane(128);
            let before = e.mesh.positions.clone();
            begin(&mut e, tool);
            e.stroke.invert = true;
            e.dab(tool, c, r, 1.0, [0.0, 0.0, 1.0]);
            let mut worst = 0.0f32;
            for v in 0..e.mesh.nverts() {
                let p0 = get3(&before, v);
                let want = -peak * factor(Falloff::Smooth, 0.0, len_sq(sub(p0, c)).sqrt() / r);
                worst = worst.max((e.mesh.positions[3 * v + 2] - p0[2] - want).abs());
            }
            report.push(format!("{tool:?} {:.1e}", worst / peak));
            assert!(worst / peak < 1e-5, "{tool:?} inverted profile off by {}", worst / peak);
        }
        // Pinch inverted pushes apart, still without any normal motion on a plane.
        let mut e = plane(128);
        let before = e.mesh.positions.clone();
        begin(&mut e, Tool::Pinch);
        e.stroke.invert = true;
        e.dab(Tool::Pinch, c, r, 1.0, [0.0, 0.0, 1.0]);
        let (mut outward, mut moved, mut dz) = (true, 0, 0.0f32);
        for v in 0..e.mesh.nverts() {
            let (a, b) = (get3(&before, v), get3(&e.mesh.positions, v));
            if a != b {
                moved += 1;
                outward &= dot(sub(b, a), sub(a, c)) > 0.0;
                dz = dz.max((b[2] - a[2]).abs());
            }
        }
        assert!(moved > 100 && outward && dz == 0.0);
        // Layer inverted goes down by exactly its height, never further.
        let mut e = plane(128);
        e.brush.tool = Tool::Layer;
        e.brush.strength = 1.0;
        e.brush.invert = true;
        let first = e.raycast_screen(300.0, 400.0).unwrap();
        let h = LAYER_HEIGHT * e.cam.world_radius(e.radius_px_at(1.0), first.point);
        let mut path = Vec::new();
        for k in 0..20 {
            path.extend(if k % 2 == 0 { line([300.0, 400.0], [500.0, 400.0], 40) } else { line([500.0, 400.0], [300.0, 400.0], 40) });
        }
        stroke(&mut e, &path);
        let low = e.mesh.positions.chunks(3).map(|p| p[2]).fold(f32::MAX, f32::min);
        report.push(format!("Pinch outward {moved} verts, |dz| {dz}; Layer down min {:.6} H", low / h));
        assert!(low >= -h * (1.0 + 1e-5) && low < -0.99 * h);
        println!("inverted golden (error / peak): {}", report.join("; "));
    }

    /// Fill and Scrape are one primitive: inverting one gives exactly the other; an inverted
    /// Crease raises a ridge and still pulls toward the line.
    #[test]
    fn brs11_brs7_invert_swaps_fill_and_scrape_and_raises_a_crease() {
        let bumpy = || {
            let mut e = plane(128);
            for v in 0..e.mesh.nverts() {
                let p = get3(&e.mesh.positions, v);
                e.mesh.positions[3 * v + 2] = 0.02 * (6.0 * p[0]).sin() * (6.0 * p[1]).sin();
            }
            for v in 0..e.mesh.nverts() {
                e.mesh.vertex_normal(v);
            }
            e
        };
        let run = |tool: Tool, invert: bool| {
            let mut e = bumpy();
            begin(&mut e, tool);
            e.stroke.invert = invert;
            e.dab(tool, [0.05, 0.02, 0.0], 0.4, 1.0, [0.0, 0.0, 1.0]);
            e.mesh.position_hash()
        };
        assert_eq!(run(Tool::Fill, true), run(Tool::Scrape, false));
        assert_eq!(run(Tool::Scrape, true), run(Tool::Fill, false));
        assert_ne!(run(Tool::Fill, false), run(Tool::Scrape, false));
        let mut e = plane(256);
        let before = e.mesh.positions.clone();
        e.brush.tool = Tool::Crease;
        e.brush.strength = 1.0;
        e.brush.falloff = Falloff::Sharp;
        e.brush.invert = true;
        stroke(&mut e, &line([250.0, 400.0], [550.0, 400.0], 60));
        let v = nearest(&e.mesh, [0.0, 0.0, 0.0]);
        let ridge = e.mesh.positions[3 * v + 2] / e.last_dab[6];
        let side = nearest(&e.mesh, [0.0, 0.05, 0.0]);
        let pulled = e.mesh.positions[3 * side + 1] - before[3 * side + 1];
        println!("brs7 inverted crease: ridge height {ridge:.4} r; a row 0.05 off the line moved {pulled:.2e} toward it");
        assert!(ridge > 0.1 && pulled < 0.0);
    }

    #[test]
    fn sym1_und1_brs1_brs4_brs6_brs7_brs8_brs10_brs11_inverted_strokes_mirror_exact_and_undo_exact() {
        let base = sphere(48);
        let maps: Vec<(u8, Vec<usize>)> = [1u8, 2, 4].iter().map(|&a| (a, partners(&base.mesh, a))).collect();
        let mut report = Vec::new();
        for tool in Tool::ALL.into_iter().filter(|t| t.invertible()) {
            let mut e = sphere(48);
            e.brush.tool = tool;
            e.brush.strength = 1.0;
            e.brush.invert = true;
            (e.brush.symmetry_x, e.brush.symmetry_y, e.brush.symmetry_z) = (true, true, true);
            let h0 = e.mesh.position_hash();
            stroke(&mut e, &sphere_stroke(tool));
            let h1 = e.mesh.position_hash();
            let err = mirror_error(&e.mesh, &maps);
            assert!(h1 != h0 && err < 1e-6, "{tool:?}: mirror error {err}");
            assert!(e.undo() > 0);
            assert_eq!(e.mesh.position_hash(), h0, "{tool:?}: undo");
            assert!(e.redo() > 0);
            assert_eq!(e.mesh.position_hash(), h1, "{tool:?}: redo");
            report.push(format!("{tool:?} {err:.1e}"));
        }
        println!("inverted, XYZ mirror error (undo/redo exact): {}", report.join(", "));
    }

    /// Hold buttons (NAV-5): held when the stroke starts, Smooth turns it into a Smooth stroke at
    /// the Smooth tool's strength and Invert flips it; letting go mid-stroke changes nothing.
    #[test]
    fn nav5_held_smooth_and_invert_apply_to_the_whole_stroke() {
        let path = line([330.0, 380.0], [470.0, 430.0], 40);
        let run = |tool: Tool, strength: f32, invert: bool, m: Modifiers, release_midway: bool| {
            let mut e = sphere(48);
            e.brush.tool = tool;
            e.brush.strength = strength;
            e.brush.invert = invert;
            e.modifiers = m;
            assert!(e.stroke_begin(path[0][0], path[0][1], 1.0));
            let rest: Vec<f32> = path[1..].iter().flat_map(|p| [p[0], p[1], 1.0]).collect();
            let half = 3 * (rest.len() / 6);
            e.stroke_move(&rest[..half]);
            if release_midway {
                e.modifiers = Modifiers::default();
            }
            e.stroke_move(&rest[half..]);
            e.stroke_end();
            e.mesh.position_hash()
        };
        let none = Modifiers::default();
        let smooth = Modifiers { smooth: true, invert: false, smooth_strength: 0.7 };
        let invert = Modifiers { smooth: false, invert: true, smooth_strength: 0.7 };
        assert_eq!(run(Tool::Draw, 0.5, false, smooth, false), run(Tool::Smooth, 0.7, false, none, false));
        assert_eq!(run(Tool::Draw, 0.5, false, smooth, true), run(Tool::Smooth, 0.7, false, none, false));
        assert_eq!(run(Tool::Draw, 0.5, false, invert, true), run(Tool::Draw, 0.5, true, none, false));
        assert_eq!(run(Tool::Draw, 0.5, true, invert, false), run(Tool::Draw, 0.5, false, none, false));
        assert_ne!(run(Tool::Draw, 0.5, false, none, false), run(Tool::Draw, 0.5, true, none, false));
    }

    /// A noisy line like a recorded Pencil trace: 2 px steps, +-2.5 px of seeded jitter across the
    /// line, coordinates rounded to whole pixels (Safari before 26.2).
    fn noisy_line() -> (Vec<[f32; 2]>, [f32; 2], [f32; 2]) {
        let (a, b) = ([100.0f32, 400.0], [700.0f32, 460.0]);
        let l = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
        let nrm = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
        let mut seed = 2024u32;
        let pts = (0..=300)
            .map(|i| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                let j = (seed as f32 / u32::MAX as f32 - 0.5) * 5.0;
                let t = i as f32 / 300.0;
                [(a[0] + (b[0] - a[0]) * t + nrm[0] * j).round(), (a[1] + (b[1] - a[1]) * t + nrm[1] * j).round()]
            })
            .collect();
        (pts, a, nrm)
    }

    #[test]
    fn stk3_stabilizer_cuts_jitter_by_70_percent_and_catches_up_on_lift() {
        use crate::engine::Stabilizer;
        let (raw, a, nrm) = noisy_line();
        // Jitter RMS = distance across the true line, over the path resampled every 4 px (what
        // the dabs follow), on the middle 80% of the line: the stroke starts exactly at the
        // (jittered) touch-down point, and the filter takes about one lazy radius to forget it;
        // that start transient is not jitter.
        let dir = [nrm[1], -nrm[0]];
        let rms = |path: &[[f32; 2]]| -> f64 {
            let (mut sum, mut n, mut carry) = (0.0f64, 0, 0.0f32);
            for w in path.windows(2) {
                let d = [w[1][0] - w[0][0], w[1][1] - w[0][1]];
                let seg = (d[0] * d[0] + d[1] * d[1]).sqrt();
                let mut t = 4.0 - carry;
                while t <= seg {
                    let q = [w[0][0] + d[0] * t / seg, w[0][1] + d[1] * t / seg];
                    let along = ((q[0] - a[0]) * dir[0] + (q[1] - a[1]) * dir[1]) / 603.0;
                    if (0.1..=0.9).contains(&along) {
                        let off = (q[0] - a[0]) * nrm[0] + (q[1] - a[1]) * nrm[1];
                        sum += (off as f64).powi(2);
                        n += 1;
                    }
                    t += 4.0;
                }
                carry = (carry + seg) % 4.0;
            }
            (sum / n as f64).sqrt()
        };
        let mut report = Vec::new();
        let r0 = rms(&raw);
        for (lazy, smooth) in [(0.0f32, 0.5f32), (12.0, 0.0), (12.0, 0.5), (24.0, 0.5), (30.0, 0.5)] {
            let mut st = Stabilizer::new(lazy, smooth, raw[0][0], raw[0][1]);
            let out: Vec<[f32; 2]> = raw.iter().map(|p| st.feed(p[0], p[1])).collect();
            let r1 = rms(&out);
            report.push(format!("lazy {lazy} px + smoothing {smooth}: {r1:.3} px (-{:.0}%)", 100.0 * (1.0 - r1 / r0)));
            if (lazy, smooth) == (30.0, 0.5) {
                assert!(1.0 - r1 / r0 >= 0.70, "jitter only -{:.0}%", 100.0 * (1.0 - r1 / r0));
            }
        }
        // Off: an exact pass-through.
        let mut st = Stabilizer::new(0.0, 0.0, raw[0][0], raw[0][1]);
        assert!(raw.iter().all(|p| st.feed(p[0], p[1]) == *p));
        // On the surface: the trailing stroke catches up to the lift point.
        let mut e = plane(128);
        e.brush.tool = Tool::Draw;
        e.brush.lazy_px = 12.0;
        e.brush.stabilize = 0.5;
        stroke(&mut e, &raw);
        let end = e.raycast_screen(raw[300][0], raw[300][1]).unwrap().point;
        let px = e.cam.world_radius(1.0, end);
        let gap = len_sq(sub([e.last_dab[0], e.last_dab[1], e.last_dab[2]], end)).sqrt() / px;
        println!("stk3 jitter RMS across the line: raw {r0:.3} px; {}; last dab {gap:.1} px from the lift point (lazy radius 12 px)", report.join("; "));
        assert!(gap <= e.brush.spacing * e.brush.radius_px + 0.5, "the stroke did not catch up: {gap} px short");
    }

    /// Native ms per dab on the reference mesh size (1M vertices), 200 dabs per brush:
    /// `cargo test --release -- --ignored --nocapture bench_brushes`.
    #[test]
    #[ignore]
    fn bench_brushes() {
        let t0 = std::time::Instant::now();
        let mesh = EditMesh::from_trimesh(cube_sphere(408), 1024);
        let mut e = Engine::new(mesh);
        e.cam = camera(EYE, 1600.0, 1600.0);
        println!("bench: {} verts, {} tris, {} leaves, setup {:?}", e.mesh.nverts(), e.mesh.ntris(), e.mesh.nleaves(), t0.elapsed());
        let r = 0.1f32;
        let mut rows = Vec::new();
        for sym in [false, true] {
            for tool in Tool::ALL {
                e.brush.symmetry_x = sym;
                e.brush.radius_px = 50.0;
                e.brush.strength = 0.5;
                let (ms, dabs, sel) = match tool {
                    Tool::Grab | Tool::SnakeHook => {
                        e.brush.tool = tool;
                        let t = std::time::Instant::now();
                        e.stroke_begin(800.0, 800.0, 1.0);
                        let mut n = 0;
                        for k in 0..200 {
                            let a = k as f32 * 0.05;
                            n += e.stroke_move(&[800.0 + 120.0 * a.cos(), 800.0 + 120.0 * a.sin(), 1.0]).max(1);
                        }
                        e.stroke_end();
                        (t.elapsed().as_secs_f64() * 1000.0, n, e.slots.verts.len())
                    }
                    _ => {
                        begin(&mut e, tool);
                        let t = std::time::Instant::now();
                        for k in 0..200 {
                            let a = k as f32 * 0.03;
                            let c = normalize([0.3 * a.cos(), 0.3 * a.sin(), 1.0]);
                            e.dab(tool, c, r, 0.5, c);
                        }
                        let ms = t.elapsed().as_secs_f64() * 1000.0;
                        e.stroke_end();
                        (ms, 200, e.slots.verts.len())
                    }
                };
                e.frame_update();
                rows.push(format!("{tool:?}{} {:.3} ms/dab ({sel} verts)", if sym { "+X" } else { "" }, ms / dabs as f64));
            }
        }
        println!("bench_brushes native (r = 0.1 on the unit sphere):\n  {}", rows.join("\n  "));
    }
}
