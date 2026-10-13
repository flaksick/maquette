// Loads the Rust core (WebAssembly, raw C ABI) and exposes typed views of a scene.
import simdUrl from '../../wasm/core.simd.wasm?url';
import scalarUrl from '../../wasm/core.scalar.wasm?url';

export type Variant = 'simd' | 'scalar';

export interface CoreExports {
  memory: WebAssembly.Memory;
  mq_version(): number;
  mq_simd_compiled(): number;
  mq_simd_selftest(n: number): number;
  mq_alloc(len: number): number;
  mq_free(ptr: number, len: number): void;
  mq_sphere_new(n: number, leafMax: number): number;
  mq_scene_free(h: number): void;
  mq_scene_layout(h: number, out: number): number;
  mq_composite_run(h: number, first: number, steps: number): number;
  mq_checksum(h: number): number;
  mq_rebuild(h: number, leafMax: number): number;
  mq_render_mesh_new(n: number, leafMax: number): number;
  mq_render_mesh_free(): void;
  mq_render_layout(out: number): number;
}

export interface RenderLayout {
  nverts: number;
  ntris: number;
  nleaves: number;
  positions: Float32Array;
  normals: Float32Array;
  tris: Uint32Array;
  leafTriOff: Uint32Array;
  triOrder: Uint32Array;
}

/** Views into WASM memory for the render-test mesh (valid until the next allocation). */
export function renderLayout(core: CoreExports): RenderLayout {
  const out = core.mq_alloc(13 * 4);
  const n = core.mq_render_layout(out);
  if (n !== 13) throw new Error(`mq_render_layout returned ${n}`);
  const m = new Uint32Array(core.memory.buffer, out, 13).slice();
  core.mq_free(out, 13 * 4);
  const buf = core.memory.buffer;
  return {
    nverts: m[0],
    ntris: m[1],
    nleaves: m[2],
    positions: new Float32Array(buf, m[3], m[4]),
    normals: new Float32Array(buf, m[5], m[6]),
    tris: new Uint32Array(buf, m[7], m[8]),
    leafTriOff: new Uint32Array(buf, m[9], m[10]),
    triOrder: new Uint32Array(buf, m[11], m[12]),
  };
}

export async function loadCore(variant: Variant): Promise<CoreExports> {
  const url = variant === 'simd' ? simdUrl : scalarUrl;
  const bytes = await (await fetch(url)).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports as unknown as CoreExports;
}

export interface SceneLayout {
  nverts: number;
  ntris: number;
  nleaves: number;
  nnodes: number;
  positions: Float32Array;
  normals: Float32Array;
  tris: Uint32Array;
  bounds: Float32Array;
  nodeA: Uint32Array;
  nodeB: Uint32Array;
  leafNode: Uint32Array;
  leafTriOff: Uint32Array;
  triOrder: Uint32Array;
  ownOff: Uint32Array;
  own: Uint32Array;
  vtOff: Uint32Array;
  vt: Uint32Array;
  vvOff: Uint32Array;
  vv: Uint32Array;
}

/** Views into WASM memory. They are invalidated if the memory grows: re-read after any call
 *  that may allocate. Use `copyLayout` to get JS-owned arrays. */
export function sceneLayout(core: CoreExports, h: number): SceneLayout {
  const out = core.mq_alloc(34 * 4);
  const n = core.mq_scene_layout(h, out);
  if (n !== 34) throw new Error(`mq_scene_layout returned ${n}`);
  const m = new Uint32Array(core.memory.buffer, out, 34).slice();
  core.mq_free(out, 34 * 4);
  const buf = core.memory.buffer;
  let k = 4;
  const f = () => {
    const a = new Float32Array(buf, m[k], m[k + 1]);
    k += 2;
    return a;
  };
  const u = () => {
    const a = new Uint32Array(buf, m[k], m[k + 1]);
    k += 2;
    return a;
  };
  return {
    nverts: m[0],
    ntris: m[1],
    nleaves: m[2],
    nnodes: m[3],
    positions: f(),
    normals: f(),
    tris: u(),
    bounds: f(),
    nodeA: u(),
    nodeB: u(),
    leafNode: u(),
    leafTriOff: u(),
    triOrder: u(),
    ownOff: u(),
    own: u(),
    vtOff: u(),
    vt: u(),
    vvOff: u(),
    vv: u(),
  };
}

export function copyLayout(l: SceneLayout): SceneLayout {
  const c = { ...l };
  for (const key of Object.keys(c) as (keyof SceneLayout)[]) {
    const v = c[key];
    if (ArrayBuffer.isView(v)) (c as Record<string, unknown>)[key] = (v as Float32Array).slice();
  }
  return c;
}
