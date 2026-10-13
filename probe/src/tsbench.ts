// TypeScript twin of core/src/kernels.rs (spike S3). Same algorithm, same arrays, written the
// way a careful data-oriented TS engine would be: typed arrays, no allocation in the hot path.
import type { SceneLayout } from './core';

const NONE = 0xffffffff;
const DRAW_STRENGTH = 0.02;
const SMOOTH_STRENGTH = 0.5;

export function pathPoint(k: number): [number, number, number, number] {
  const theta = k * 0.05;
  const phi = 0.3 * Math.sin(k * 0.02);
  return [
    Math.fround(Math.cos(theta) * Math.cos(phi)),
    Math.fround(Math.sin(theta) * Math.cos(phi)),
    Math.fround(Math.sin(phi)),
    Math.floor(k / 50) % 2 === 0 ? Math.fround(0.08) : Math.fround(0.25),
  ];
}

export class TsScene {
  readonly l: SceneLayout;
  private leaves: Uint32Array;
  private nLeavesHit = 0;
  private stack: Uint32Array;
  private sel: Uint32Array;
  private selF: Float32Array;
  private nSel = 0;
  private tmp: Float32Array;

  constructor(l: SceneLayout) {
    this.l = l;
    this.leaves = new Uint32Array(l.nleaves);
    this.stack = new Uint32Array(l.nnodes + 64);
    this.sel = new Uint32Array(l.nverts);
    this.selF = new Float32Array(l.nverts);
    this.tmp = new Float32Array(l.nverts * 3);
  }

  private query(cx: number, cy: number, cz: number, r: number): void {
    const { bounds, nodeA, nodeB } = this.l;
    const stack = this.stack;
    let sp = 0;
    stack[sp++] = 0;
    this.nLeavesHit = 0;
    const r2 = r * r;
    while (sp > 0) {
      const node = stack[--sp];
      const b = 6 * node;
      const dx = Math.max(Math.max(bounds[b] - cx, 0), cx - bounds[b + 3]);
      const dy = Math.max(Math.max(bounds[b + 1] - cy, 0), cy - bounds[b + 4]);
      const dz = Math.max(Math.max(bounds[b + 2] - cz, 0), cz - bounds[b + 5]);
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      if (nodeB[node] === NONE) {
        this.leaves[this.nLeavesHit++] = nodeA[node];
      } else {
        stack[sp++] = nodeB[node];
        stack[sp++] = nodeA[node];
      }
    }
  }

  private vertexNormal(v: number): void {
    const { positions: p, tris, vtOff, vt, normals } = this.l;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = vtOff[v]; i < vtOff[v + 1]; i++) {
      const t = 3 * vt[i];
      const a = 3 * tris[t];
      const b = 3 * tris[t + 1];
      const c = 3 * tris[t + 2];
      const ux = p[b] - p[a];
      const uy = p[b + 1] - p[a + 1];
      const uz = p[b + 2] - p[a + 2];
      const wx = p[c] - p[a];
      const wy = p[c + 1] - p[a + 1];
      const wz = p[c + 2] - p[a + 2];
      nx += uy * wz - uz * wy;
      ny += uz * wx - ux * wz;
      nz += ux * wy - uy * wx;
    }
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const s = len > 1e-20 ? 1 / len : 0;
    normals[3 * v] = nx * s;
    normals[3 * v + 1] = ny * s;
    normals[3 * v + 2] = nz * s;
  }

  compositeStep(cx: number, cy: number, cz: number, r: number): void {
    const { positions: p, normals, ownOff, own, vvOff, vv } = this.l;
    this.query(cx, cy, cz, r);

    // Select vertices inside the brush with Blender's Smooth falloff.
    let n = 0;
    const r2 = r * r;
    for (let li = 0; li < this.nLeavesHit; li++) {
      const leaf = this.leaves[li];
      for (let i = ownOff[leaf]; i < ownOff[leaf + 1]; i++) {
        const v = own[i];
        const dx = p[3 * v] - cx;
        const dy = p[3 * v + 1] - cy;
        const dz = p[3 * v + 2] - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < r2) {
          const q = 1 - Math.sqrt(d2) / r;
          this.sel[n] = v;
          this.selF[n] = q * q * (3 - 2 * q);
          n++;
        }
      }
    }
    this.nSel = n;

    // Area normal.
    let ax = 0;
    let ay = 0;
    let az = 0;
    for (let i = 0; i < n; i++) {
      const v = this.sel[i];
      const f = this.selF[i];
      ax += normals[3 * v] * f;
      ay += normals[3 * v + 1] * f;
      az += normals[3 * v + 2] * f;
    }
    let al = Math.sqrt(ax * ax + ay * ay + az * az);
    if (al > 1e-20) {
      ax /= al;
      ay /= al;
      az /= al;
    } else {
      al = Math.sqrt(cx * cx + cy * cy + cz * cz);
      ax = cx / al;
      ay = cy / al;
      az = cz / al;
    }

    // Draw.
    const k = r * DRAW_STRENGTH;
    for (let i = 0; i < n; i++) {
      const v = 3 * this.sel[i];
      const w = k * this.selF[i];
      p[v] += ax * w;
      p[v + 1] += ay * w;
      p[v + 2] += az * w;
    }

    // Smooth (Jacobi).
    const tmp = this.tmp;
    for (let i = 0; i < n; i++) {
      const v = this.sel[i];
      const s = vvOff[v];
      const e = vvOff[v + 1];
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (let j = s; j < e; j++) {
        const w = 3 * vv[j];
        sx += p[w];
        sy += p[w + 1];
        sz += p[w + 2];
      }
      const inv = 1 / (e - s);
      const f = SMOOTH_STRENGTH * this.selF[i];
      const px = p[3 * v];
      const py = p[3 * v + 1];
      const pz = p[3 * v + 2];
      tmp[3 * i] = px + (sx * inv - px) * f;
      tmp[3 * i + 1] = py + (sy * inv - py) * f;
      tmp[3 * i + 2] = pz + (sz * inv - pz) * f;
    }
    for (let i = 0; i < n; i++) {
      const v = 3 * this.sel[i];
      p[v] = tmp[3 * i];
      p[v + 1] = tmp[3 * i + 1];
      p[v + 2] = tmp[3 * i + 2];
    }

    // Normals for vertices owned by touched leaves, then refit.
    for (let li = 0; li < this.nLeavesHit; li++) {
      const leaf = this.leaves[li];
      for (let i = ownOff[leaf]; i < ownOff[leaf + 1]; i++) this.vertexNormal(own[i]);
    }
    this.refitLeaves();
    this.refitInternal();
  }

  private refitLeaves(): void {
    const { positions: p, tris, bounds, leafTriOff, triOrder, leafNode } = this.l;
    for (let li = 0; li < this.nLeavesHit; li++) {
      const leaf = this.leaves[li];
      let lx = Infinity;
      let ly = Infinity;
      let lz = Infinity;
      let hx = -Infinity;
      let hy = -Infinity;
      let hz = -Infinity;
      for (let i = leafTriOff[leaf]; i < leafTriOff[leaf + 1]; i++) {
        const t = 3 * triOrder[i];
        for (let c = 0; c < 3; c++) {
          const v = 3 * tris[t + c];
          const x = p[v];
          const y = p[v + 1];
          const z = p[v + 2];
          if (x < lx) lx = x;
          if (y < ly) ly = y;
          if (z < lz) lz = z;
          if (x > hx) hx = x;
          if (y > hy) hy = y;
          if (z > hz) hz = z;
        }
      }
      const b = 6 * leafNode[leaf];
      bounds[b] = lx;
      bounds[b + 1] = ly;
      bounds[b + 2] = lz;
      bounds[b + 3] = hx;
      bounds[b + 4] = hy;
      bounds[b + 5] = hz;
    }
  }

  private refitInternal(): void {
    const { bounds, nodeA, nodeB, nnodes } = this.l;
    for (let node = nnodes - 1; node >= 0; node--) {
      if (nodeB[node] === NONE) continue;
      const b = 6 * node;
      const l = 6 * nodeA[node];
      const r = 6 * nodeB[node];
      for (let a = 0; a < 3; a++) {
        bounds[b + a] = Math.min(bounds[l + a], bounds[r + a]);
        bounds[b + 3 + a] = Math.max(bounds[l + 3 + a], bounds[r + 3 + a]);
      }
    }
  }

  get selected(): number {
    return this.nSel;
  }

  checksum(): number {
    let s = 0;
    const p = this.l.positions;
    for (let i = 0; i < p.length; i++) s += p[i];
    return s;
  }
}
