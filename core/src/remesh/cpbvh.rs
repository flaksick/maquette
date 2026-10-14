//! Closest-point BVH over the remesh source (engine mesh + hole fans). Small leaves (the engine's
//! own BVH has 1024-triangle leaves, made for brushes), median split on the longest centroid
//! axis, nodes in preorder so the refit is one reverse sweep. Built incrementally: every call
//! does a bounded amount of work, so the remesh job never blocks a frame.

use super::Src;
use crate::math::{add, dot, scale, sub};

pub const LEAF: usize = 4;
const LEAF_BIT: u32 = 1 << 31;
const NIL: u32 = u32::MAX;

#[derive(Default)]
pub struct CpBvh {
    pub lo: Vec<[f32; 3]>,
    pub hi: Vec<[f32; 3]>,
    /// Internal: left child. Leaf: first slot in `order`.
    pub a: Vec<u32>,
    /// Internal: right child. Leaf: LEAF_BIT | triangle count.
    pub b: Vec<u32>,
    pub order: Vec<u32>,
    cen: Vec<[f32; 3]>,
    stack: Vec<[u32; 4]>,
}

impl CpBvh {
    pub fn bytes(&self) -> usize {
        self.lo.capacity() * 24 + self.a.capacity() * 8 + self.order.capacity() * 4 + self.cen.capacity() * 12 + self.stack.capacity() * 16
    }

    /// Centroids of triangles [from, to). Call with increasing ranges until `to == ntris`.
    pub fn centroids(&mut self, src: &Src, from: usize, to: usize) {
        if from == 0 {
            self.cen = Vec::with_capacity(src.ntris());
        }
        for t in from..to {
            let [a, b, c] = src.tri(t);
            self.cen.push(scale(add(add(a, b), c), 1.0 / 3.0));
        }
    }

    pub fn start_split(&mut self, n: usize) {
        self.order = (0..n as u32).collect();
        let nodes = 2 * n.div_ceil(LEAF) + 1;
        self.a = Vec::with_capacity(nodes);
        self.b = Vec::with_capacity(nodes);
        self.stack.clear();
        if n > 0 {
            self.stack.push([0, n as u32, NIL, 0]);
        }
    }

    /// Splits pending ranges until `left` work units are spent. Returns true when done.
    pub fn split_step(&mut self, left: &mut i64) -> bool {
        while let Some([s, e, parent, side]) = self.stack.pop() {
            let node = self.a.len() as u32;
            self.a.push(0);
            self.b.push(0);
            if parent != NIL {
                if side == 0 {
                    self.a[parent as usize] = node;
                } else {
                    self.b[parent as usize] = node;
                }
            }
            let (s, e) = (s as usize, e as usize);
            *left -= 4 + (e - s) as i64 / 2;
            if e - s <= LEAF {
                self.a[node as usize] = s as u32;
                self.b[node as usize] = LEAF_BIT | (e - s) as u32;
            } else {
                let mut lo = [f32::INFINITY; 3];
                let mut hi = [f32::NEG_INFINITY; 3];
                for &t in &self.order[s..e] {
                    let c = self.cen[t as usize];
                    for k in 0..3 {
                        lo[k] = lo[k].min(c[k]);
                        hi[k] = hi[k].max(c[k]);
                    }
                }
                let ext = sub(hi, lo);
                let axis = if ext[0] >= ext[1] && ext[0] >= ext[2] { 0 } else if ext[1] >= ext[2] { 1 } else { 2 };
                let mid = s + (e - s) / 2;
                let cen = &self.cen;
                self.order[s..e].select_nth_unstable_by(mid - s, |&x, &y| {
                    cen[x as usize][axis].total_cmp(&cen[y as usize][axis]).then(x.cmp(&y))
                });
                self.stack.push([mid as u32, e as u32, node, 1]);
                self.stack.push([s as u32, mid as u32, node, 0]);
            }
            if *left <= 0 {
                return self.stack.is_empty();
            }
        }
        true
    }

    /// Bounds, children before parents (reverse preorder). `cur` counts nodes done.
    pub fn refit_step(&mut self, src: &Src, cur: &mut usize, left: &mut i64) -> bool {
        let n = self.a.len();
        if *cur == 0 {
            self.lo = vec![[0.0; 3]; n];
            self.hi = vec![[0.0; 3]; n];
            self.cen = Vec::new(); // centroids are only needed for splitting
        }
        while *cur < n {
            let node = n - 1 - *cur;
            *cur += 1;
            let (mut lo, mut hi) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
            if self.b[node] & LEAF_BIT != 0 {
                let s = self.a[node] as usize;
                for &t in &self.order[s..s + (self.b[node] & !LEAF_BIT) as usize] {
                    for p in src.tri(t as usize) {
                        for k in 0..3 {
                            lo[k] = lo[k].min(p[k]);
                            hi[k] = hi[k].max(p[k]);
                        }
                    }
                }
                *left -= 8;
            } else {
                let (l, r) = (self.a[node] as usize, self.b[node] as usize);
                for k in 0..3 {
                    lo[k] = self.lo[l][k].min(self.lo[r][k]);
                    hi[k] = self.hi[l][k].max(self.hi[r][k]);
                }
                *left -= 1;
            }
            self.lo[node] = lo;
            self.hi[node] = hi;
            if *left <= 0 {
                break;
            }
        }
        *cur >= n
    }

    fn box_d2(&self, node: usize, p: [f32; 3]) -> f32 {
        let mut d2 = 0.0;
        for k in 0..3 {
            let d = (self.lo[node][k] - p[k]).max(0.0).max(p[k] - self.hi[node][k]);
            d2 += d * d;
        }
        d2
    }

    /// Closest point on the source within sqrt(max_d2) of `p`: (triangle, point, squared distance).
    pub fn closest(&self, src: &Src, p: [f32; 3], max_d2: f32) -> Option<(u32, [f32; 3], f32)> {
        if self.a.is_empty() {
            return None;
        }
        let mut best: Option<(u32, [f32; 3], f32)> = None;
        let mut best_d2 = max_d2;
        let mut stack = [0u32; 96];
        let mut sp = 1;
        while sp > 0 {
            sp -= 1;
            let node = stack[sp] as usize;
            if self.box_d2(node, p) >= best_d2 {
                continue;
            }
            if self.b[node] & LEAF_BIT != 0 {
                let s = self.a[node] as usize;
                for &t in &self.order[s..s + (self.b[node] & !LEAF_BIT) as usize] {
                    let [a, b, c] = src.tri(t as usize);
                    let q = closest_on_triangle(p, a, b, c);
                    let d = sub(p, q);
                    let d2 = dot(d, d);
                    if d2 < best_d2 {
                        best_d2 = d2;
                        best = Some((t, q, d2));
                    }
                }
            } else if sp + 2 <= stack.len() {
                let (l, r) = (self.a[node], self.b[node]);
                // Nearer child on top of the stack.
                if self.box_d2(l as usize, p) <= self.box_d2(r as usize, p) {
                    stack[sp] = r;
                    stack[sp + 1] = l;
                } else {
                    stack[sp] = l;
                    stack[sp + 1] = r;
                }
                sp += 2;
            }
        }
        best
    }
}

/// Closest point to `p` on triangle abc (Voronoi-region walk; Ericson, Real-Time Collision
/// Detection 5.1.5). Degenerate triangles fall back to the nearest vertex.
pub fn closest_on_triangle(p: [f32; 3], a: [f32; 3], b: [f32; 3], c: [f32; 3]) -> [f32; 3] {
    let ab = sub(b, a);
    let ac = sub(c, a);
    let ap = sub(p, a);
    let d1 = dot(ab, ap);
    let d2 = dot(ac, ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return a;
    }
    let bp = sub(p, b);
    let d3 = dot(ab, bp);
    let d4 = dot(ac, bp);
    if d3 >= 0.0 && d4 <= d3 {
        return b;
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        return finite_or(add(a, scale(ab, v)), a);
    }
    let cp = sub(p, c);
    let d5 = dot(ab, cp);
    let d6 = dot(ac, cp);
    if d6 >= 0.0 && d5 <= d6 {
        return c;
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        return finite_or(add(a, scale(ac, w)), a);
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return finite_or(add(b, scale(sub(c, b), w)), b);
    }
    let denom = 1.0 / (va + vb + vc);
    finite_or(add(a, add(scale(ab, vb * denom), scale(ac, vc * denom))), a)
}

#[inline]
fn finite_or(q: [f32; 3], f: [f32; 3]) -> [f32; 3] {
    if q[0].is_finite() && q[1].is_finite() && q[2].is_finite() { q } else { f }
}
