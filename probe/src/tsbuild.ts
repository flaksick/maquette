// TypeScript twin of the structural "rebuild" workload (spike S3, second half): vertex->triangle
// and one-ring CSR adjacency (core/src/topo.rs) plus the median-split BVH with leaf-owned
// vertices (core/src/bvh.rs). This is pointer-chasing, sort-heavy code — the kind dyntopo,
// remesh and import are made of — where the language gap differs from streaming float loops.

const NONE = 0xffffffff;

export function buildTopo(nv: number, tris: Uint32Array) {
  const vtOff = new Uint32Array(nv + 1);
  for (let i = 0; i < tris.length; i++) vtOff[tris[i] + 1]++;
  for (let i = 0; i < nv; i++) vtOff[i + 1] += vtOff[i];
  const fill = vtOff.slice();
  const vt = new Uint32Array(tris.length);
  for (let t = 0; t < tris.length / 3; t++) {
    for (let c = 0; c < 3; c++) vt[fill[tris[3 * t + c]]++] = t;
  }
  const vvOff = new Uint32Array(nv + 1);
  let vv = new Uint32Array(nv * 7);
  let n = 0;
  const ring = new Uint32Array(64);
  for (let v = 0; v < nv; v++) {
    let k = 0;
    for (let i = vtOff[v]; i < vtOff[v + 1]; i++) {
      const t = 3 * vt[i];
      for (let c = 0; c < 3; c++) {
        const w = tris[t + c];
        if (w !== v) ring[k++] = w;
      }
    }
    const r = ring.subarray(0, k).sort();
    if (n + k > vv.length) {
      const grown = new Uint32Array(vv.length * 2);
      grown.set(vv);
      vv = grown;
    }
    let last = -1;
    for (let i = 0; i < k; i++) {
      if (r[i] !== last) vv[n++] = r[i];
      last = r[i];
    }
    vvOff[v + 1] = n;
  }
  return { vtOff, vt, vvOff, vv: vv.subarray(0, n) };
}

export function buildBvh(positions: Float32Array, tris: Uint32Array, leafMax: number) {
  const ntri = tris.length / 3;
  const cen = new Float32Array(ntri * 3);
  for (let t = 0; t < ntri; t++) {
    for (let k = 0; k < 3; k++) {
      cen[3 * t + k] =
        (positions[3 * tris[3 * t] + k] + positions[3 * tris[3 * t + 1] + k] + positions[3 * tris[3 * t + 2] + k]) * (1 / 3);
    }
  }
  const order = new Uint32Array(ntri);
  for (let i = 0; i < ntri; i++) order[i] = i;
  const nodeA: number[] = [];
  const nodeB: number[] = [];
  const leafNode: number[] = [];
  const leafTriOff: number[] = [0];

  // Deterministic quickselect by (centroid[axis], tri id), matching the Rust comparator.
  const less = (x: number, y: number, axis: number) => {
    const cx = cen[3 * x + axis];
    const cy = cen[3 * y + axis];
    return cx < cy || (cx === cy && x < y);
  };
  function select(lo: number, hi: number, k: number, axis: number) {
    while (hi > lo) {
      const pivot = order[(lo + hi) >>> 1];
      let i = lo;
      let j = hi;
      while (i <= j) {
        while (less(order[i], pivot, axis)) i++;
        while (less(pivot, order[j], axis)) j--;
        if (i <= j) {
          const t = order[i];
          order[i] = order[j];
          order[j] = t;
          i++;
          j--;
        }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else return;
    }
  }

  function split(start: number, end: number): number {
    const node = nodeA.length;
    nodeA.push(0);
    nodeB.push(NONE);
    const count = end - start;
    if (count <= leafMax) {
      nodeA[node] = leafNode.length;
      leafNode.push(node);
      leafTriOff.push(end);
      return node;
    }
    let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity;
    for (let i = start; i < end; i++) {
      const t = 3 * order[i];
      if (cen[t] < lx) lx = cen[t];
      if (cen[t] > hx) hx = cen[t];
      if (cen[t + 1] < ly) ly = cen[t + 1];
      if (cen[t + 1] > hy) hy = cen[t + 1];
      if (cen[t + 2] < lz) lz = cen[t + 2];
      if (cen[t + 2] > hz) hz = cen[t + 2];
    }
    const ex = hx - lx, ey = hy - ly, ez = hz - lz;
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const mid = start + (count >> 1);
    select(start, end - 1, mid, axis);
    const left = split(start, mid);
    const right = split(mid, end);
    nodeA[node] = left;
    nodeB[node] = right;
    return node;
  }
  split(0, ntri);

  // Leaf ownership: first leaf (in leaf order) that references a vertex owns it.
  const nleaves = leafNode.length;
  const nv = positions.length / 3;
  const owner = new Uint32Array(nv).fill(NONE);
  const ownOff = new Uint32Array(nleaves + 1);
  for (let leaf = 0; leaf < nleaves; leaf++) {
    for (let i = leafTriOff[leaf]; i < leafTriOff[leaf + 1]; i++) {
      const t = 3 * order[i];
      for (let c = 0; c < 3; c++) {
        const v = tris[t + c];
        if (owner[v] === NONE) {
          owner[v] = leaf;
          ownOff[leaf + 1]++;
        }
      }
    }
  }
  for (let i = 0; i < nleaves; i++) ownOff[i + 1] += ownOff[i];
  const fill = ownOff.slice();
  const own = new Uint32Array(ownOff[nleaves]);
  for (let v = 0; v < nv; v++) if (owner[v] !== NONE) own[fill[owner[v]]++] = v;
  return { nodes: nodeA.length, nleaves, own };
}
