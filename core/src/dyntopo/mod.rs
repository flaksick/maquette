//! Dynamic topology (TOP-3): the mesh refines and coarsens under the brush.
//!
//! Layout. Turning dyntopo on re-lays the mesh out with slack (`relayout`): every BVH leaf owns a
//! vertex slab and a triangle slab with room to spare. A dead triangle is `(d, d, d)` with `d` the
//! first vertex slot of its leaf (zero area: never drawn, never hit, never linked in adjacency);
//! a dead vertex is a slot no live triangle references. So the project files keep their format
//! (topo.bin stores every slot), and slots never move during a stroke (invariant 3): splits take
//! free slots from the leaves they happen in, collapses give slots back.
//!
//! Adjacency becomes dynamic (`make_dynamic`): pooled per-vertex lists with room to grow.
//!
//! Ops, Blender's order inside the dab sphere (`update_region`): collapse edges shorter than
//! 0.4 x max, then split edges longer than max, longest first (SculptGL-style: the midpoint is
//! pushed along the normals to stay on the smooth surface), then a tangential relax of the
//! vertices that changed. A split that finds no free slot in its leaves is skipped and the state
//! is marked `starved`; the worker re-lays the mesh out after the stroke if the budget allows,
//! otherwise detail is capped. Quads survive where nothing touched them.
//!
//! Undo and the journal store whole leaf slabs (positions + triangles), so a dyntopo stroke is
//! undone, redone and recovered exactly like a sculpt stroke (history.rs, KIND_TOPO records).

#[cfg(test)]
mod tests;

pub mod abi;

use crate::bvh::{Bvh, NONE};
use crate::engine::StampSet;
use crate::history::Transaction;
use crate::math::{add, cross, dot, get3, len_sq, normalize, scale, set3, sub};
use crate::mesh::EditMesh;
use crate::sphere::TriMesh;
use crate::topo::Topo;

/// Blender: min edge length = 0.4 x max edge length.
pub const MIN_RATIO: f32 = 0.4;
/// Bounded work per dab (keeps a dab within the frame budget).
pub const MAX_SPLITS_PER_DAB: u32 = 3000;
pub const MAX_COLLAPSES_PER_DAB: u32 = 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DetailMode {
    Constant = 0,
    Screen = 1,
    Brush = 2,
}

impl DetailMode {
    pub fn from_u32(v: u32) -> DetailMode {
        match v {
            0 => DetailMode::Constant,
            2 => DetailMode::Brush,
            _ => DetailMode::Screen,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Detail {
    pub mode: DetailMode,
    /// Constant: resolution (edges per unit length). Screen: detail size in pixels. Brush: % of radius.
    pub value: f32,
}

impl Default for Detail {
    fn default() -> Detail {
        Detail { mode: DetailMode::Screen, value: 12.0 }
    }
}

impl Detail {
    /// Maximum edge length (Blender's formulas): constant = 1 / resolution; brush = radius x
    /// percent / 100; screen (relative) = world size of `value` pixels at the dab, / 0.4, so the
    /// shortest kept edge (0.4 x max) is `value` pixels on screen.
    pub fn max_edge(&self, radius_world: f32, radius_px: f32) -> f32 {
        match self.mode {
            DetailMode::Constant => 1.0 / self.value.max(1e-3),
            DetailMode::Brush => radius_world * self.value.clamp(1.0, 100.0) / 100.0,
            DetailMode::Screen => radius_world / radius_px.max(1e-3) * self.value.max(0.5) / MIN_RATIO,
        }
    }
}

#[derive(Default)]
pub struct DynState {
    pub on: bool,
    pub detail: Detail,
    /// Free vertex / triangle slots per leaf (popped from the back).
    pub vfree: Vec<Vec<u32>>,
    pub tfree: Vec<Vec<u32>>,
    /// A split found no free slot this stroke: the layout needs more slack.
    pub starved: bool,
    /// More slack would not fit the memory budget: detail is capped.
    pub capped: bool,
    /// Leaves whose triangles changed since the last frame (GPU pages to rebuild).
    pub topo_leaves: Vec<u32>,
    topo_stamp: Vec<u8>,
    /// Topology changed since the project files were last written whole.
    pub topo_dirty: bool,
    pub splits: u64,
    pub collapses: u64,
    edges: Vec<(u32, u32, u32)>,
    affected: Vec<u32>,
    ring: Vec<u32>,
    tris_scratch: Vec<u32>,
    leaves: Vec<u32>,
    stack: Vec<u32>,
    fresh: Vec<u32>,
}

impl DynState {
    pub fn note_leaf(&mut self, leaf: u32, nleaves: usize) {
        if self.topo_stamp.len() != nleaves {
            self.topo_stamp = vec![0; nleaves];
        }
        if self.topo_stamp[leaf as usize] == 0 {
            self.topo_stamp[leaf as usize] = 1;
            self.topo_leaves.push(leaf);
        }
        self.topo_dirty = true;
    }

    pub fn take_topo_leaves(&mut self) -> Vec<u32> {
        for &l in &self.topo_leaves {
            if let Some(s) = self.topo_stamp.get_mut(l as usize) {
                *s = 0;
            }
        }
        std::mem::take(&mut self.topo_leaves)
    }

    pub fn free_bytes(&self) -> usize {
        self.vfree.iter().map(|v| v.capacity() * 4).sum::<usize>() + self.tfree.iter().map(|v| v.capacity() * 4).sum::<usize>()
    }
}

#[inline]
pub fn is_dead(m: &EditMesh, t: usize) -> bool {
    let c = &m.tris[3 * t..3 * t + 3];
    c[0] == c[1] && c[1] == c[2]
}

/// The dead triangle of slot t: (d, d, d), d = its leaf's first vertex slot.
#[inline]
fn dead_of(m: &EditMesh, t: usize) -> [u32; 3] {
    let d = m.bvh.own_off[m.leaf_of_tri[t] as usize];
    [d, d, d]
}

// ------------------------------------------------------------------ dynamic adjacency

fn grow(pool: &mut Vec<u32>, off: &mut u32, cap: &mut u32, len: u32) {
    let new_cap = (*cap * 2).max(8);
    let start = pool.len();
    pool.extend_from_within(*off as usize..*off as usize + len as usize);
    pool.resize(start + new_cap as usize, 0);
    *off = start as u32;
    *cap = new_cap;
}

#[inline]
fn vt_add(t: &mut Topo, v: usize, tri: u32) {
    if t.vt_len[v] == t.vt_cap[v] {
        grow(&mut t.vt, &mut t.vt_off[v], &mut t.vt_cap[v], t.vt_len[v]);
    }
    let at = (t.vt_off[v] + t.vt_len[v]) as usize;
    t.vt[at] = tri;
    t.vt_len[v] += 1;
}

#[inline]
fn vt_del(t: &mut Topo, v: usize, tri: u32) {
    let s = t.vt_off[v] as usize;
    let n = t.vt_len[v] as usize;
    if let Some(i) = t.vt[s..s + n].iter().position(|&x| x == tri) {
        t.vt[s + i] = t.vt[s + n - 1];
        t.vt_len[v] -= 1;
    }
}

/// Recomputes the one-ring of v from its triangles.
fn vv_refresh(m: &mut EditMesh, v: usize, ring: &mut Vec<u32>) {
    ring.clear();
    for &t in m.topo.vtris(v) {
        for k in 0..3 {
            let w = m.tris[3 * t as usize + k];
            if w as usize != v {
                ring.push(w);
            }
        }
    }
    ring.sort_unstable();
    ring.dedup();
    let topo = &mut m.topo;
    if ring.len() as u32 > topo.vv_cap[v] {
        topo.vv_len[v] = 0;
        let mut cap = topo.vv_cap[v];
        while (cap as usize) < ring.len() {
            grow(&mut topo.vv, &mut topo.vv_off[v], &mut cap, 0);
        }
        topo.vv_cap[v] = cap;
    }
    let s = topo.vv_off[v] as usize;
    topo.vv[s..s + ring.len()].copy_from_slice(ring);
    topo.vv_len[v] = ring.len() as u32;
}

/// Dynamic adjacency built from the live triangles (dead ones excluded).
pub fn make_dynamic(m: &mut EditMesh) {
    let nv = m.nverts();
    let mut cnt = vec![0u32; nv];
    for t in 0..m.ntris() {
        if !is_dead(m, t) {
            for k in 0..3 {
                cnt[m.tris[3 * t + k] as usize] += 1;
            }
        }
    }
    let mut topo = Topo { vt_len: vec![0; nv], vt_cap: vec![0; nv], vv_len: vec![0; nv], vv_cap: vec![0; nv], ..Default::default() };
    topo.vt_off = Vec::with_capacity(nv + 1);
    topo.vv_off = Vec::with_capacity(nv + 1);
    let (mut a, mut b) = (0u32, 0u32);
    for v in 0..nv {
        topo.vt_off.push(a);
        topo.vv_off.push(b);
        let cap = cnt[v] + 4;
        topo.vt_cap[v] = cap;
        topo.vv_cap[v] = cap;
        a += cap;
        b += cap;
    }
    topo.vt_off.push(a);
    topo.vv_off.push(b);
    topo.vt = vec![0; a as usize];
    topo.vv = vec![0; b as usize];
    for t in 0..m.ntris() {
        if !is_dead(m, t) {
            for k in 0..3 {
                vt_add(&mut topo, m.tris[3 * t + k] as usize, t as u32);
            }
        }
    }
    m.topo = topo;
    let mut ring = Vec::new();
    for v in 0..nv {
        vv_refresh(m, v, &mut ring);
    }
}

/// Writes triangle slot t, keeping dynamic adjacency in step. Records corners whose rings changed.
pub fn set_tri(m: &mut EditMesh, t: usize, c: [u32; 3], affected: &mut Vec<u32>) {
    let old = [m.tris[3 * t], m.tris[3 * t + 1], m.tris[3 * t + 2]];
    if old == c {
        return;
    }
    let dynamic = m.topo.is_dynamic();
    if dynamic && !(old[0] == old[1] && old[1] == old[2]) {
        for (k, &v) in old.iter().enumerate() {
            if !old[..k].contains(&v) {
                vt_del(&mut m.topo, v as usize, t as u32);
                affected.push(v);
            }
        }
    }
    m.tris[3 * t..3 * t + 3].copy_from_slice(&c);
    if dynamic && !(c[0] == c[1] && c[1] == c[2]) {
        for (k, &v) in c.iter().enumerate() {
            if !c[..k].contains(&v) {
                vt_add(&mut m.topo, v as usize, t as u32);
                affected.push(v);
            }
        }
    }
}

fn refresh_rings(m: &mut EditMesh, affected: &mut Vec<u32>, ring: &mut Vec<u32>) {
    affected.sort_unstable();
    affected.dedup();
    for i in 0..affected.len() {
        vv_refresh(m, affected[i] as usize, ring);
    }
}

/// Undo / journal restore of a leaf's triangle slab (history.rs).
pub fn write_leaf_tris(m: &mut EditMesh, leaf: usize, tris: &[u32], pn: &[u8]) {
    if !m.topo.is_dynamic() {
        make_dynamic(m);
    }
    let (t0, t1) = (m.bvh.leaf_tri_off[leaf] as usize, m.bvh.leaf_tri_off[leaf + 1] as usize);
    let mut affected = Vec::new();
    for i in 0..t1 - t0 {
        set_tri(m, t0 + i, [tris[3 * i], tris[3 * i + 1], tris[3 * i + 2]], &mut affected);
    }
    m.poly_next[t0..t1].copy_from_slice(pn);
    let mut ring = Vec::new();
    refresh_rings(m, &mut affected, &mut ring);
}

// ------------------------------------------------------------------ free slots

pub fn scan_free(m: &EditMesh, st: &mut DynState) {
    let nl = m.nleaves();
    st.vfree = vec![Vec::new(); nl];
    st.tfree = vec![Vec::new(); nl];
    for leaf in 0..nl {
        scan_free_leaf(m, st, leaf);
    }
}

/// Free lists of one leaf, recomputed (after undo / redo / journal records). Lowest slot first.
pub fn scan_free_leaf(m: &EditMesh, st: &mut DynState, leaf: usize) {
    let (a, b) = m.leaf_range(leaf);
    st.vfree[leaf] = (a..b).rev().filter(|&v| m.topo.vtris(v).is_empty()).map(|v| v as u32).collect();
    let (t0, t1) = (m.bvh.leaf_tri_off[leaf] as usize, m.bvh.leaf_tri_off[leaf + 1] as usize);
    st.tfree[leaf] = (t0..t1).rev().filter(|&t| is_dead(m, t)).map(|t| t as u32).collect();
}

// ------------------------------------------------------------------ layout with slack

/// Re-lays the live mesh out with `slack` x room in every leaf (+ a fixed minimum): the dyntopo
/// layout. Geometry is unchanged; slot ids change (a heavy op, undone through a snapshot).
pub fn relayout(m: &EditMesh, slack: f32, leaf_max: usize) -> EditMesh {
    let nv = m.nverts();
    let mut new_of_old = vec![NONE; nv];
    let mut pos = Vec::new();
    let mut tris = Vec::new();
    let mut pn = Vec::new();
    for t in 0..m.ntris() {
        if is_dead(m, t) {
            continue;
        }
        for k in 0..3 {
            let v = m.tris[3 * t + k] as usize;
            if new_of_old[v] == NONE {
                new_of_old[v] = (pos.len() / 3) as u32;
                pos.extend_from_slice(&get3(&m.positions, v));
            }
            tris.push(new_of_old[v]);
        }
        pn.push(m.poly_next[t]);
    }
    // A polygon run must end inside the live list.
    if let Some(last) = pn.last_mut() {
        *last = 0;
    }
    let compact = EditMesh::from_trimesh(TriMesh { positions: pos, tris, poly_next: pn }, leaf_max);
    with_slack(&compact, slack)
}

/// The same leaves with room: slab capacities = ceil(live x slack) + minimum.
pub fn with_slack(c: &EditMesh, slack: f32) -> EditMesh {
    let nl = c.nleaves();
    let mut own_off = vec![0u32; nl + 1];
    let mut tri_off = vec![0u32; nl + 1];
    for leaf in 0..nl {
        let (a, b) = c.leaf_range(leaf);
        let lt = (c.bvh.leaf_tri_off[leaf + 1] - c.bvh.leaf_tri_off[leaf]) as usize;
        own_off[leaf + 1] = own_off[leaf] + ((b - a) as f32 * slack).ceil() as u32 + 32;
        tri_off[leaf + 1] = tri_off[leaf] + (lt as f32 * slack).ceil() as u32 + 64;
    }
    let nv = own_off[nl] as usize;
    let nt = tri_off[nl] as usize;
    // Compact vertex v (owned by leaf L at offset i) -> own_off[L] + i.
    let mut map = vec![NONE; c.nverts()];
    let mut positions = vec![0.0f32; 3 * nv];
    for leaf in 0..nl {
        let (a, b) = c.leaf_range(leaf);
        for (i, v) in (a..b).enumerate() {
            map[v] = own_off[leaf] + i as u32;
            set3(&mut positions, map[v] as usize, get3(&c.positions, v));
        }
    }
    let mut tris = vec![0u32; 3 * nt];
    let mut poly_next = vec![0u8; nt];
    for leaf in 0..nl {
        let (s, e) = (c.bvh.leaf_tri_off[leaf] as usize, c.bvh.leaf_tri_off[leaf + 1] as usize);
        let base = tri_off[leaf] as usize;
        for (i, t) in (s..e).enumerate() {
            for k in 0..3 {
                tris[3 * (base + i) + k] = map[c.tris[3 * t + k] as usize];
            }
            poly_next[base + i] = c.poly_next[t];
        }
        // Dead slots: (d, d, d), d = the leaf's first vertex slot; dead vertices sit on a live one.
        let d = own_off[leaf];
        for t in base + (e - s)..tri_off[leaf + 1] as usize {
            tris[3 * t..3 * t + 3].copy_from_slice(&[d, d, d]);
        }
        let (a, b) = c.leaf_range(leaf);
        let anchor = if b > a { get3(&c.positions, a) } else if e > s { get3(&c.positions, c.tris[3 * s] as usize) } else { [0.0; 3] };
        for v in own_off[leaf] as usize + (b - a)..own_off[leaf + 1] as usize {
            set3(&mut positions, v, anchor);
        }
    }
    let bvh = Bvh {
        bounds: vec![0.0; c.bvh.node_a.len() * 6],
        node_a: c.bvh.node_a.clone(),
        node_b: c.bvh.node_b.clone(),
        leaf_node: c.bvh.leaf_node.clone(),
        leaf_tri_off: tri_off,
        tri_order: (0..nt as u32).collect(),
        own_off,
        own: (0..nv as u32).collect(),
    };
    let mut m = EditMesh::assemble(positions, tris, poly_next, bvh, nv);
    make_dynamic(&mut m);
    for v in 0..m.nverts() {
        m.vertex_normal(v);
    }
    m
}

// ------------------------------------------------------------------ ops

/// The triangles on edge a-b: (the one walking a->b, the one walking b->a).
fn edge_tris(m: &EditMesh, a: u32, b: u32) -> Option<(usize, usize)> {
    let (mut ab, mut ba) = (None, None);
    for &t in m.topo.vtris(a as usize) {
        let c = &m.tris[3 * t as usize..3 * t as usize + 3];
        let k = c.iter().position(|&x| x == a)?;
        if c[(k + 1) % 3] == b {
            if ab.is_some() {
                return None; // non-manifold: leave it alone
            }
            ab = Some(t as usize);
        } else if c[(k + 2) % 3] == b {
            if ba.is_some() {
                return None;
            }
            ba = Some(t as usize);
        }
    }
    Some((ab?, ba?))
}

/// The corner of t that is neither a nor b.
fn third(m: &EditMesh, t: usize, a: u32, b: u32) -> u32 {
    let c = &m.tris[3 * t..3 * t + 3];
    *c.iter().find(|&&x| x != a && x != b).unwrap()
}

/// A changed triangle leaves its polygon (quads survive only where nothing touched them).
fn break_run(m: &mut EditMesh, t: usize) {
    let leaf_start = m.bvh.leaf_tri_off[m.leaf_of_tri[t] as usize] as usize;
    if t > leaf_start && m.poly_next[t - 1] != 0 {
        m.poly_next[t - 1] = 0;
    }
    m.poly_next[t] = 0;
}

fn touch_tri(m: &EditMesh, tx: &mut Transaction, t: usize) {
    tx.touch(m, m.leaf_of_tri[t]);
}

fn touch_vert(m: &EditMesh, tx: &mut Transaction, v: usize) {
    let leaf = m.leaf_of_vertex[v];
    if leaf != NONE {
        tx.touch(m, leaf);
    }
}

/// Splits edge a-b at a new vertex pushed toward the smooth surface. Returns the new vertex.
pub fn split(m: &mut EditMesh, st: &mut DynState, tx: &mut Transaction, a: u32, b: u32) -> Option<u32> {
    let (t1, t2) = edge_tris(m, a, b)?;
    let c = third(m, t1, a, b);
    let d = third(m, t2, a, b);
    let (l1, l2) = (m.leaf_of_tri[t1] as usize, m.leaf_of_tri[t2] as usize);
    let mv = match st.vfree[l1].pop() {
        Some(v) => v,
        None => match st.vfree[l2].pop() {
            Some(v) => v,
            None => {
                st.starved = true;
                return None;
            }
        },
    };
    let Some(t3) = st.tfree[l1].pop() else {
        st.vfree[m.leaf_of_vertex[mv as usize] as usize].push(mv);
        st.starved = true;
        return None;
    };
    let Some(t4) = st.tfree[l2].pop() else {
        st.tfree[l1].push(t3);
        st.vfree[m.leaf_of_vertex[mv as usize] as usize].push(mv);
        st.starved = true;
        return None;
    };
    for t in [t1, t2, t3 as usize, t4 as usize] {
        touch_tri(m, tx, t);
    }
    touch_vert(m, tx, mv as usize);
    let (pa, pb) = (get3(&m.positions, a as usize), get3(&m.positions, b as usize));
    let (na, nb) = (get3(&m.normals, a as usize), get3(&m.normals, b as usize));
    let n = normalize(add(na, nb));
    // Sagitta of the arc through a and b with those normals: (nb - na).(pb - pa) / 8.
    let push = dot(sub(nb, na), sub(pb, pa)) / 8.0;
    let q = add(scale(add(pa, pb), 0.5), scale(n, push));
    set3(&mut m.positions, mv as usize, q);
    set3(&mut m.normals, mv as usize, n);
    let mut aff = std::mem::take(&mut st.affected);
    set_tri(m, t1, [a, mv, c], &mut aff);
    set_tri(m, t3 as usize, [mv, b, c], &mut aff);
    set_tri(m, t2, [b, mv, d], &mut aff);
    set_tri(m, t4 as usize, [mv, a, d], &mut aff);
    for t in [t1, t2, t3 as usize, t4 as usize] {
        break_run(m, t);
        st.note_leaf(m.leaf_of_tri[t], m.nleaves());
    }
    let mut ring = std::mem::take(&mut st.ring);
    refresh_rings(m, &mut aff, &mut ring);
    st.ring = ring;
    aff.clear();
    st.affected = aff;
    st.splits += 1;
    Some(mv)
}

/// Collapses edge a-b into its midpoint (b's slot is freed). Refuses anything that would make the
/// mesh non-manifold (link condition), pinch a valence-3 vertex, or flip a triangle.
pub fn collapse(m: &mut EditMesh, st: &mut DynState, tx: &mut Transaction, a: u32, b: u32) -> bool {
    let Some((t1, t2)) = edge_tris(m, a, b) else { return false };
    let c = third(m, t1, a, b);
    let d = third(m, t2, a, b);
    if c == d || m.topo.vtris(c as usize).len() <= 3 || m.topo.vtris(d as usize).len() <= 3 {
        return false;
    }
    // Link condition: the one-rings of a and b share exactly c and d.
    let rb = m.topo.vverts(b as usize);
    let common = m.topo.vverts(a as usize).iter().filter(|w| rb.contains(w)).count();
    if common != 2 {
        return false;
    }
    let p = scale(add(get3(&m.positions, a as usize), get3(&m.positions, b as usize)), 0.5);
    // No flips: every surviving triangle around a or b keeps its orientation.
    let mut ts = std::mem::take(&mut st.tris_scratch);
    ts.clear();
    ts.extend_from_slice(m.topo.vtris(a as usize));
    ts.extend_from_slice(m.topo.vtris(b as usize));
    ts.sort_unstable();
    ts.dedup();
    for &t in &ts {
        let t = t as usize;
        if t == t1 || t == t2 {
            continue;
        }
        let cs = [m.tris[3 * t], m.tris[3 * t + 1], m.tris[3 * t + 2]];
        let old = [get3(&m.positions, cs[0] as usize), get3(&m.positions, cs[1] as usize), get3(&m.positions, cs[2] as usize)];
        let mut new = old;
        for k in 0..3 {
            if cs[k] == a || cs[k] == b {
                new[k] = p;
            }
        }
        let no = cross(sub(old[1], old[0]), sub(old[2], old[0]));
        let nn = cross(sub(new[1], new[0]), sub(new[2], new[0]));
        if dot(no, nn) <= 0.2 * len_sq(no).sqrt() * len_sq(nn).sqrt() || len_sq(nn) == 0.0 {
            st.tris_scratch = ts;
            return false;
        }
    }
    for &t in &ts {
        touch_tri(m, tx, t as usize);
    }
    touch_vert(m, tx, a as usize);
    touch_vert(m, tx, b as usize);
    let mut aff = std::mem::take(&mut st.affected);
    for &t in &ts {
        let t = t as usize;
        if t == t1 || t == t2 {
            continue;
        }
        let mut cs = [m.tris[3 * t], m.tris[3 * t + 1], m.tris[3 * t + 2]];
        if cs.contains(&b) {
            for v in cs.iter_mut() {
                if *v == b {
                    *v = a;
                }
            }
            set_tri(m, t, cs, &mut aff);
            break_run(m, t);
            st.note_leaf(m.leaf_of_tri[t], m.nleaves());
        }
    }
    for t in [t1, t2] {
        let dead = dead_of(m, t);
        set_tri(m, t, dead, &mut aff);
        break_run(m, t);
        st.note_leaf(m.leaf_of_tri[t], m.nleaves());
        st.tfree[m.leaf_of_tri[t] as usize].push(t as u32);
    }
    set3(&mut m.positions, a as usize, p);
    st.vfree[m.leaf_of_vertex[b as usize] as usize].push(b);
    // b's old neighbours now see a instead.
    aff.extend_from_slice(&ts.iter().flat_map(|&t| [m.tris[3 * t as usize], m.tris[3 * t as usize + 1], m.tris[3 * t as usize + 2]]).collect::<Vec<u32>>());
    aff.push(b);
    let mut ring = std::mem::take(&mut st.ring);
    refresh_rings(m, &mut aff, &mut ring);
    st.ring = ring;
    aff.clear();
    st.affected = aff;
    st.tris_scratch = ts;
    st.collapses += 1;
    true
}

#[inline]
fn key(len2: f32) -> u32 {
    len2.to_bits() // positive floats order like their bits
}

/// One dab of dyntopo: collapse, split, relax inside the sphere (c, r). Marks what changed in
/// `modified` (normals, bounds, GPU). Returns (splits, collapses).
pub fn update_region(m: &mut EditMesh, st: &mut DynState, tx: &mut Transaction, modified: &mut StampSet, c: [f32; 3], r: f32, lmax: f32) -> (u32, u32) {
    if !m.topo.is_dynamic() || st.vfree.len() != m.nleaves() {
        return (0, 0);
    }
    let r2 = r * r;
    let (mut leaves, mut stack) = (std::mem::take(&mut st.leaves), std::mem::take(&mut st.stack));
    m.bvh.query_sphere(c, r * 1.25, &mut leaves, &mut stack);
    let mut edges = std::mem::take(&mut st.edges);
    edges.clear();
    let inside = |m: &EditMesh, v: u32| len_sq(sub(get3(&m.positions, v as usize), c)) < r2;
    for &leaf in &leaves {
        for t in m.bvh.leaf_tri_off[leaf as usize] as usize..m.bvh.leaf_tri_off[leaf as usize + 1] as usize {
            if is_dead(m, t) {
                continue;
            }
            let cs = [m.tris[3 * t], m.tris[3 * t + 1], m.tris[3 * t + 2]];
            if !cs.iter().any(|&v| inside(m, v)) {
                continue;
            }
            for k in 0..3 {
                let (a, b) = (cs[k], cs[(k + 1) % 3]);
                if a < b {
                    edges.push((0, a, b));
                }
            }
        }
    }
    st.leaves = leaves;
    st.stack = stack;
    let lmin2 = (MIN_RATIO * lmax) * (MIN_RATIO * lmax);
    let lmax2 = lmax * lmax;
    let elen = |m: &EditMesh, a: u32, b: u32| len_sq(sub(get3(&m.positions, a as usize), get3(&m.positions, b as usize)));
    for e in edges.iter_mut() {
        e.0 = key(elen(m, e.1, e.2));
    }
    edges.sort_unstable();
    edges.dedup();
    let mut fresh = std::mem::take(&mut st.fresh);
    fresh.clear();
    // 1. collapse short edges, shortest first
    let mut collapses = 0;
    for i in 0..edges.len() {
        let (k, a, b) = edges[i];
        if f32::from_bits(k) >= lmin2 || collapses >= MAX_COLLAPSES_PER_DAB {
            break;
        }
        if m.topo.vtris(a as usize).is_empty() || m.topo.vtris(b as usize).is_empty() || elen(m, a, b) >= lmin2 {
            continue;
        }
        if collapse(m, st, tx, a, b) {
            collapses += 1;
            fresh.push(a);
        }
    }
    // 2. split long edges, longest first; new edges re-enter the queue
    let mut heap: std::collections::BinaryHeap<(u32, u32, u32)> = edges.iter().filter(|e| f32::from_bits(e.0) > lmax2).copied().collect();
    let mut splits = 0;
    while let Some((_, a, b)) = heap.pop() {
        if splits >= MAX_SPLITS_PER_DAB {
            break;
        }
        let len2 = elen(m, a, b);
        if len2 <= lmax2 || m.topo.vtris(a as usize).is_empty() {
            continue;
        }
        let Some((t1, t2)) = edge_tris(m, a, b) else { continue };
        let (cc, dd) = (third(m, t1, a, b), third(m, t2, a, b));
        let Some(mv) = split(m, st, tx, a, b) else { continue };
        splits += 1;
        fresh.push(mv);
        let mid_in = |m: &EditMesh, x: u32, y: u32| len_sq(sub(scale(add(get3(&m.positions, x as usize), get3(&m.positions, y as usize)), 0.5), c)) < r2;
        for (x, y) in [(a, mv), (mv, b), (cc, mv), (dd, mv)] {
            let l = elen(m, x, y);
            if l > lmax2 && mid_in(m, x, y) {
                heap.push((key(l), x.min(y), x.max(y)));
            }
        }
    }
    st.edges = edges;
    // 3. tangential relax of what changed
    for &v in &fresh {
        let v = v as usize;
        let nb = m.topo.vverts(v);
        if nb.is_empty() {
            continue;
        }
        let mut avg = [0.0f32; 3];
        for &w in nb {
            avg = add(avg, get3(&m.positions, w as usize));
        }
        let p = get3(&m.positions, v);
        let n = get3(&m.normals, v);
        let mut dlt = sub(scale(avg, 1.0 / nb.len() as f32), p);
        dlt = sub(dlt, scale(n, dot(dlt, n)));
        touch_vert(m, tx, v);
        set3(&mut m.positions, v, add(p, scale(dlt, 0.5)));
    }
    for &v in &fresh {
        modified.insert(v);
        for &w in m.topo.vverts(v as usize) {
            modified.insert(w);
        }
    }
    st.fresh = fresh;
    (splits, collapses)
}
