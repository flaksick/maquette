//! Import cleanup (IMP-0): turns arbitrary polygons into the engine's mesh invariant
//! (edge-manifold, consistently oriented, holes allowed, polygons as in-order fan runs) and
//! counts every change it makes.
//!
//! 1. Degenerate faces: repeated consecutive vertices collapse; a face left with fewer than three
//!    vertices, one that still repeats a vertex, or one whose area is exactly zero is dropped.
//! 2. Duplicate faces: the same vertex set as an earlier face (either winding) is dropped.
//! 3. Joins: the two faces of an edge are joined. An edge with three or more faces is
//!    non-manifold: its faces are sorted by angle around the edge and paired into neighbouring
//!    wedges, preferring pairs that already wind opposite ways, then wedges that enclose the solid
//!    (two cubes sharing an edge stay two cubes). An odd face out stays unjoined there.
//! 4. Orientation: each joined component is flood-filled from its first face, reversing faces so
//!    joined faces cross their edge in opposite directions. A closed component then faces outward
//!    (positive volume); an open one keeps the winding most of its faces had. A join that
//!    contradicts the fill (a Möbius-like loop) is cut.
//! 5. Splitting: around each vertex, faces linked through joins form fans; every fan after the
//!    first gets its own copy of the vertex, so non-manifold edges and bow-tie vertices come apart.
//!    A face that still shares an edge illegally after that is detached (rare by construction).
//! 6. Fans: each polygon becomes an in-order triangle fan, from its first vertex when that keeps
//!    every fan triangle positively oriented, else from the vertex that does best (concave
//!    n-gons); a fan never uses a diagonal that is already an edge elsewhere.
//!
//! Accounting: vertices out = vertices in - loose + split (`Counts::split_non_manifold`).

use super::{FxSet, RawMesh, UnionFind};
use crate::sphere::TriMesh;

const NONE: u32 = u32::MAX;
/// Polygons with more vertices than this are fanned from their first vertex without a search.
const APEX_SEARCH_MAX: usize = 256;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub dropped_degenerate: u32,
    pub dropped_duplicate: u32,
    pub flipped_faces: u32,
    pub split_non_manifold: u32,
    pub loose_verts: u32,
}

type V3 = [f64; 3];

#[inline]
fn p64(pos: &[f32], v: u32) -> V3 {
    let i = 3 * v as usize;
    [pos[i] as f64, pos[i + 1] as f64, pos[i + 2] as f64]
}
#[inline]
fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline]
fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
#[inline]
fn scale(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
#[inline]
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline]
fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn unit(a: V3) -> V3 {
    let l = dot(a, a).sqrt();
    if l > 0.0 { scale(a, 1.0 / l) } else { [0.0; 3] }
}

/// Twice the vector area of a polygon (its fan from the first vertex; exact for planar polygons).
fn newell(pos: &[f32], f: &[u32]) -> V3 {
    let o = p64(pos, f[0]);
    let mut n = [0.0; 3];
    for i in 1..f.len() - 1 {
        n = add(n, cross(sub(p64(pos, f[i]), o), sub(p64(pos, f[i + 1]), o)));
    }
    n
}

fn centroid(pos: &[f32], f: &[u32]) -> V3 {
    let mut c = [0.0; 3];
    for &v in f {
        c = add(c, p64(pos, v));
    }
    scale(c, 1.0 / f.len() as f64)
}

/// Signed volume contribution of a polygon (its fan) relative to `o`, times 6.
fn volume6(pos: &[f32], f: &[u32], o: V3) -> f64 {
    let a = sub(p64(pos, f[0]), o);
    (1..f.len() - 1).map(|i| dot(a, cross(sub(p64(pos, f[i]), o), sub(p64(pos, f[i + 1]), o)))).sum()
}

fn repeats(f: &[u32]) -> bool {
    if f.len() <= 16 {
        (0..f.len()).any(|i| f[i + 1..].contains(&f[i]))
    } else {
        let mut s = f.to_vec();
        s.sort_unstable();
        s.windows(2).any(|w| w[0] == w[1])
    }
}

#[inline]
fn edge_key(a: u32, b: u32) -> u64 {
    let (lo, hi) = if a < b { (a, b) } else { (b, a) };
    (lo as u64) << 32 | hi as u64
}

/// Polygons as offsets + vertex lists, with half-edge h = corner h -> next corner of its face.
struct Polys {
    off: Vec<u32>,
    fv: Vec<u32>,
    he_face: Vec<u32>,
}

impl Polys {
    fn new(off: Vec<u32>, fv: Vec<u32>) -> Polys {
        let mut he_face = vec![0u32; fv.len()];
        for f in 0..off.len() - 1 {
            for h in off[f]..off[f + 1] {
                he_face[h as usize] = f as u32;
            }
        }
        Polys { off, fv, he_face }
    }
    fn nfaces(&self) -> usize {
        self.off.len() - 1
    }
    fn range(&self, f: usize) -> std::ops::Range<usize> {
        self.off[f] as usize..self.off[f + 1] as usize
    }
    fn face(&self, f: usize) -> &[u32] {
        &self.fv[self.range(f)]
    }
    #[inline]
    fn next(&self, h: usize) -> usize {
        let f = self.he_face[h] as usize;
        if h + 1 < self.off[f + 1] as usize { h + 1 } else { self.off[f] as usize }
    }
}

/// Cleans `raw` and returns fan polygon runs plus the counts of what changed.
pub fn clean(raw: RawMesh) -> (TriMesh, Counts) {
    let mut c = Counts::default();
    let pos = raw.positions;
    let nv0 = pos.len() / 3;

    // 1. Degenerate faces.
    let mut off = Vec::with_capacity(raw.face_off.len());
    off.push(0u32);
    let mut fv: Vec<u32> = Vec::with_capacity(raw.face_verts.len());
    let mut tmp: Vec<u32> = Vec::new();
    for f in 0..raw.face_off.len().saturating_sub(1) {
        tmp.clear();
        for &v in &raw.face_verts[raw.face_off[f] as usize..raw.face_off[f + 1] as usize] {
            if tmp.last() != Some(&v) {
                tmp.push(v);
            }
        }
        while tmp.len() > 1 && tmp[0] == tmp[tmp.len() - 1] {
            tmp.pop();
        }
        if tmp.len() < 3 || repeats(&tmp) || {
            let n = newell(&pos, &tmp);
            dot(n, n) == 0.0
        } {
            c.dropped_degenerate += 1;
            continue;
        }
        fv.extend_from_slice(&tmp);
        off.push(fv.len() as u32);
    }
    drop(raw.face_verts);

    // 2. Duplicate faces: sort by the sorted vertex list; ties by index keep the first.
    {
        let nf = off.len() - 1;
        let mut sorted = fv.clone();
        for f in 0..nf {
            sorted[off[f] as usize..off[f + 1] as usize].sort_unstable();
        }
        let key = |f: u32| &sorted[off[f as usize] as usize..off[f as usize + 1] as usize];
        let mut order: Vec<u32> = (0..nf as u32).collect();
        order.sort_unstable_by(|&a, &b| key(a).cmp(key(b)).then(a.cmp(&b)));
        let mut keep = vec![true; nf];
        for w in order.windows(2) {
            if key(w[0]) == key(w[1]) {
                keep[w[1] as usize] = false;
                c.dropped_duplicate += 1;
            }
        }
        if c.dropped_duplicate > 0 {
            let (mut off2, mut fv2) = (vec![0u32], Vec::with_capacity(fv.len()));
            for f in (0..nf).filter(|&f| keep[f]) {
                fv2.extend_from_slice(&fv[off[f] as usize..off[f + 1] as usize]);
                off2.push(fv2.len() as u32);
            }
            off = off2;
            fv = fv2;
        }
    }
    let p = Polys::new(off, fv);
    let nf = p.nfaces();
    let nh = p.fv.len();
    if nf == 0 {
        c.loose_verts = nv0 as u32;
        return (TriMesh { positions: Vec::new(), tris: Vec::new(), poly_next: Vec::new() }, c);
    }

    // 3. Joins (`mate`: the half-edge across the edge, or NONE).
    let mut mate = vec![NONE; nh];
    {
        let keys: Vec<u64> = (0..nh).map(|h| edge_key(p.fv[h], p.fv[p.next(h)])).collect();
        let mut hs: Vec<u32> = (0..nh as u32).collect();
        hs.sort_unstable_by_key(|&h| (keys[h as usize], h));
        let mut i = 0;
        while i < nh {
            let mut j = i + 1;
            while j < nh && keys[hs[j] as usize] == keys[hs[i] as usize] {
                j += 1;
            }
            match j - i {
                1 => {}
                2 => {
                    mate[hs[i] as usize] = hs[i + 1];
                    mate[hs[i + 1] as usize] = hs[i];
                }
                _ => pair_around_edge(&p, &pos, &hs[i..j], &mut mate),
            }
            i = j;
        }
    }

    // 4. Orientation: sign +1 keeps a face's winding, -1 reverses it.
    let mut sign = vec![0i8; nf];
    let mut stack: Vec<u32> = Vec::new();
    let mut members: Vec<u32> = Vec::new();
    for s in 0..nf {
        if sign[s] != 0 {
            continue;
        }
        sign[s] = 1;
        stack.push(s as u32);
        members.clear();
        while let Some(f) = stack.pop() {
            let f = f as usize;
            members.push(f as u32);
            for h in p.range(f) {
                let m = mate[h];
                if m == NONE {
                    continue;
                }
                let g = p.he_face[m as usize] as usize;
                // Joined faces must cross the edge in opposite directions once signs apply.
                let same_dir = p.fv[h] == p.fv[m as usize];
                let want = if same_dir { -sign[f] } else { sign[f] };
                if sign[g] == 0 {
                    sign[g] = want;
                    stack.push(g as u32);
                } else if sign[g] != want {
                    mate[h] = NONE; // non-orientable loop: cut this join
                    mate[m as usize] = NONE;
                }
            }
        }
        let closed = members.iter().all(|&f| p.range(f as usize).all(|h| mate[h] != NONE));
        let o = p64(&pos, p.fv[p.off[members[0] as usize] as usize]);
        let vol: f64 = members.iter().map(|&f| sign[f as usize] as f64 * volume6(&pos, p.face(f as usize), o)).sum();
        let flips = members.iter().filter(|&&f| sign[f as usize] < 0).count();
        let keeps = members.len() - flips;
        let invert = if closed || flips == keeps { vol < 0.0 } else { flips > keeps };
        if invert {
            for &f in &members {
                sign[f as usize] = -sign[f as usize];
            }
        }
    }
    drop(stack);
    drop(members);
    c.flipped_faces = sign.iter().filter(|&&s| s < 0).count() as u32;

    // 5. Split into fans; detach any face still sharing an edge illegally, and redo.
    let mut out_pos: Vec<f32>;
    let mut cv: Vec<u32>;
    let mut used: Vec<bool>;
    loop {
        let mut uf = UnionFind::new(nh);
        for h in 0..nh {
            let m = mate[h] as usize;
            if mate[h] == NONE || m < h {
                continue;
            }
            let (hn, mn) = (p.next(h), p.next(m));
            if p.fv[h] == p.fv[m] {
                uf.union(h, m);
                uf.union(hn, mn);
            } else {
                uf.union(h, mn);
                uf.union(hn, m);
            }
        }
        // A fan's id: the original vertex for the first fan seen (lowest corner), copies after.
        out_pos = pos.clone();
        cv = vec![0u32; nh];
        used = vec![false; nv0];
        let mut fan_id = vec![NONE; nh];
        for h in 0..nh {
            let r = uf.find(h);
            if fan_id[r] == NONE {
                let v = p.fv[h] as usize;
                fan_id[r] = if !used[v] {
                    used[v] = true;
                    v as u32
                } else {
                    out_pos.extend_from_slice(&pos[3 * v..3 * v + 3]);
                    (out_pos.len() / 3 - 1) as u32
                };
            }
            cv[h] = fan_id[r];
        }
        let bad = illegal_faces(&p, &cv, &sign, &mate);
        if bad.is_empty() {
            break;
        }
        for f in bad {
            for h in p.range(f as usize) {
                let m = mate[h];
                if m != NONE {
                    mate[m as usize] = NONE;
                    mate[h] = NONE;
                }
            }
        }
    }
    drop(mate);
    c.loose_verts = used.iter().filter(|&&u| !u).count() as u32;

    // Final polygons (signs applied), compacted vertex ids.
    let mut remap = vec![NONE; out_pos.len() / 3];
    let mut positions = Vec::with_capacity(out_pos.len());
    for v in 0..out_pos.len() / 3 {
        if v >= nv0 || used[v] {
            remap[v] = (positions.len() / 3) as u32;
            positions.extend_from_slice(&out_pos[3 * v..3 * v + 3]);
        }
    }
    drop(out_pos);
    let mut polys: Vec<u32> = Vec::with_capacity(nh);
    for f in 0..nf {
        let r = p.range(f);
        if sign[f] > 0 {
            polys.extend(cv[r].iter().map(|&v| remap[v as usize]));
        } else {
            polys.extend(cv[r].iter().rev().map(|&v| remap[v as usize]));
        }
    }
    let off = p.off;
    drop(cv);

    // 6. Fans.
    let tm = fans(positions, &off, &polys);
    c.split_non_manifold = (tm.nverts() + c.loose_verts as usize - nv0) as u32;
    (tm, c)
}

/// One use of a non-manifold edge, for sorting the faces around it.
struct Use {
    h: u32,
    ang: f64,
    /// Unit direction from the edge into the face, perpendicular to the edge.
    w: V3,
    /// Unit face normal (as wound in the file).
    n: V3,
    /// Traverses the edge from its lower to its higher vertex id.
    up: bool,
}

/// Pairs the faces around a non-manifold edge (step 3).
fn pair_around_edge(p: &Polys, pos: &[f32], group: &[u32], mate: &mut [u32]) {
    let h0 = group[0] as usize;
    let (a, b) = {
        let (x, y) = (p.fv[h0], p.fv[p.next(h0)]);
        (x.min(y), x.max(y))
    };
    let pa = p64(pos, a);
    let axis = unit(sub(p64(pos, b), pa));
    let mut uses: Vec<Use> = Vec::with_capacity(group.len());
    let mut e1 = [0.0; 3];
    for &h in group {
        let f = p.face(p.he_face[h as usize] as usize);
        let n = unit(newell(pos, f));
        let mut w = sub(centroid(pos, f), pa);
        w = sub(w, scale(axis, dot(w, axis)));
        if dot(w, w) < 1e-24 {
            w = cross(n, axis);
        }
        let w = unit(w);
        if uses.is_empty() {
            e1 = w;
        }
        let e2 = cross(axis, e1);
        let mut ang = dot(w, e2).atan2(dot(w, e1));
        if ang < 0.0 {
            ang += std::f64::consts::TAU;
        }
        uses.push(Use { h, ang, w, n, up: p.fv[h as usize] == a });
    }
    uses.sort_by(|x, y| x.ang.total_cmp(&y.ang).then(x.h.cmp(&y.h)));
    let k = uses.len();
    // Pair p of a rotation s: even k pairs (s, s+1), (s+2, s+3)...; odd k leaves s out.
    let pair = |s: usize, i: usize| -> (usize, usize) {
        let first = if k % 2 == 0 { s + 2 * i } else { s + 1 + 2 * i };
        (first % k, (first + 1) % k)
    };
    // The CCW wedge from x to y encloses the solid when both normals point away from it.
    let material = |x: &Use, y: &Use| -> bool {
        let mut d = y.ang - x.ang;
        if d <= 0.0 {
            d += std::f64::consts::TAU;
        }
        let m = add(scale(x.w, (d / 2.0).cos()), scale(cross(axis, x.w), (d / 2.0).sin()));
        dot(x.n, m) < 0.0 && dot(y.n, m) < 0.0
    };
    let rotations = if k % 2 == 0 { 2 } else { k };
    let mut best = (-1i64, 0usize);
    for s in 0..rotations {
        let mut score = 0i64;
        for i in 0..k / 2 {
            let (x, y) = pair(s, i);
            score += 2 * (uses[x].up != uses[y].up) as i64 + material(&uses[x], &uses[y]) as i64;
        }
        if score > best.0 {
            best = (score, s);
        }
    }
    for i in 0..k / 2 {
        let (x, y) = pair(best.1, i);
        mate[uses[x].h as usize] = uses[y].h;
        mate[uses[y].h as usize] = uses[x].h;
    }
}

/// Faces that still share an edge illegally after splitting (more than two faces, or two faces
/// crossing it the same way). A joined pair on such an edge is kept; the others are returned.
fn illegal_faces(p: &Polys, cv: &[u32], sign: &[i8], mate: &[u32]) -> Vec<u32> {
    let nh = cv.len();
    // Directed (after signs) edge of each half-edge.
    let dir = |h: usize| -> (u32, u32) {
        let (a, b) = (cv[h], cv[p.next(h)]);
        if sign[p.he_face[h] as usize] > 0 { (a, b) } else { (b, a) }
    };
    let mut hs: Vec<u32> = (0..nh as u32).collect();
    let key = |h: u32| {
        let (a, b) = dir(h as usize);
        edge_key(a, b)
    };
    hs.sort_unstable_by_key(|&h| (key(h), h));
    let mut bad: Vec<u32> = Vec::new();
    let mut i = 0;
    while i < nh {
        let mut j = i + 1;
        while j < nh && key(hs[j]) == key(hs[i]) {
            j += 1;
        }
        let g = &hs[i..j];
        if g.len() == 2 && dir(g[0] as usize).0 == dir(g[1] as usize).0 {
            bad.push(p.he_face[g[0] as usize].max(p.he_face[g[1] as usize]));
        } else if g.len() > 2 {
            let keep = g.iter().position(|&h| g.contains(&mate[h as usize]));
            for (k, &h) in g.iter().enumerate() {
                let kept = match keep {
                    Some(x) => k == x || mate[g[x] as usize] == h,
                    None => k == 0,
                };
                if !kept {
                    bad.push(p.he_face[h as usize]);
                }
            }
        }
        i = j;
    }
    bad.sort_unstable();
    bad.dedup();
    bad
}

/// Step 6: polygons -> in-order fan runs.
fn fans(mut positions: Vec<f32>, off: &[u32], polys: &[u32]) -> TriMesh {
    let nf = off.len() - 1;
    let ntri: usize = (0..nf).map(|f| (off[f + 1] - off[f]) as usize - 2).sum();
    let mut tris = Vec::with_capacity(3 * ntri);
    let mut poly_next = Vec::with_capacity(ntri);
    let any_ngon = (0..nf).any(|f| off[f + 1] - off[f] > 3);
    // Every polygon edge, so no fan diagonal duplicates an edge (that would make it non-manifold).
    let mut edges: Vec<u64> = Vec::new();
    if any_ngon {
        edges.reserve(polys.len());
        for f in 0..nf {
            let q = &polys[off[f] as usize..off[f + 1] as usize];
            for i in 0..q.len() {
                edges.push(edge_key(q[i], q[(i + 1) % q.len()]));
            }
        }
        edges.sort_unstable();
        edges.dedup();
    }
    let mut diagonals: FxSet<u64> = FxSet::default();
    let mut fresh: Vec<u32> = Vec::new();
    for f in 0..nf {
        let mut q = &polys[off[f] as usize..off[f + 1] as usize];
        let k = q.len();
        let mut r = 0;
        if k > 3 {
            r = match apex(&positions, q, &edges, &diagonals, true) {
                Some(r) => r,
                None => {
                    // Every apex would reuse an existing edge: give this polygon its own vertices.
                    fresh.clear();
                    for &v in q {
                        fresh.push((positions.len() / 3) as u32);
                        positions.extend_from_within(3 * v as usize..3 * v as usize + 3);
                    }
                    q = &fresh;
                    apex(&positions, q, &edges, &diagonals, false).unwrap_or(0)
                }
            };
            for i in 2..k - 1 {
                diagonals.insert(edge_key(q[r], q[(r + i) % k]));
            }
        }
        for i in 1..k - 1 {
            tris.extend_from_slice(&[q[r], q[(r + i) % k], q[(r + i + 1) % k]]);
            poly_next.push((i + 1 < k - 1) as u8);
        }
    }
    // Vertices only a detached polygon used are now unreferenced: compact once more if so.
    let mut used = vec![false; positions.len() / 3];
    for &v in &tris {
        used[v as usize] = true;
    }
    if used.iter().any(|&u| !u) {
        let mut remap = vec![NONE; used.len()];
        let mut kept = Vec::with_capacity(positions.len());
        for v in 0..used.len() {
            if used[v] {
                remap[v] = (kept.len() / 3) as u32;
                kept.extend_from_slice(&positions[3 * v..3 * v + 3]);
            }
        }
        for v in tris.iter_mut() {
            *v = remap[*v as usize];
        }
        positions = kept;
    }
    TriMesh { positions, tris, poly_next }
}

/// Fan apex for a polygon: its first vertex when every fan triangle is positively oriented (along
/// the polygon normal) and no diagonal is taken; else the rotation with the largest smallest
/// triangle. None when every rotation reuses an existing edge (only checked with `topo`).
fn apex(pos: &[f32], q: &[u32], edges: &[u64], diagonals: &FxSet<u64>, topo: bool) -> Option<usize> {
    let k = q.len();
    let n = newell(pos, q);
    let free = |r: usize| {
        !topo
            || (2..k - 1).all(|i| {
                let d = edge_key(q[r], q[(r + i) % k]);
                edges.binary_search(&d).is_err() && !diagonals.contains(&d)
            })
    };
    let worst = |r: usize| {
        let a = p64(pos, q[r]);
        (1..k - 1)
            .map(|i| dot(cross(sub(p64(pos, q[(r + i) % k]), a), sub(p64(pos, q[(r + i + 1) % k]), a)), n))
            .fold(f64::INFINITY, f64::min)
    };
    if free(0) && (k > APEX_SEARCH_MAX || worst(0) > 0.0) {
        return Some(0);
    }
    let mut best: Option<(f64, usize)> = None;
    for r in 0..k.min(APEX_SEARCH_MAX) {
        if !free(r) {
            continue;
        }
        let w = worst(r);
        if best.is_none_or(|(bw, _)| w > bw) {
            best = Some((w, r));
        }
    }
    best.map(|(_, r)| r)
}
