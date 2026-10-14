// Typed access to the Rust engine (raw C ABI, see core/src/abi.rs). Views into WASM memory are
// re-created after every call that may grow memory: `mem()` always returns the live buffer.
import simdUrl from '../../../wasm/core.simd.wasm?url';
import scalarUrl from '../../../wasm/core.scalar.wasm?url';

export interface Exports {
  memory: WebAssembly.Memory;
  mq_simd_selftest(n: number): number;
  mq_alloc(len: number): number;
  mq_free(ptr: number, len: number): void;
  eng_camera_ptr(): number;
  eng_samples_ptr(nfloats: number): number;
  eng_new_sphere(n: number, leafMax: number): number;
  eng_load(topo: number, topoLen: number, pos: number, posLen: number): number;
  eng_set_brush(tool: number, radiusPx: number, strength: number, flags: number, gamma: number, spacing: number): void;
  eng_camera_commit(): void;
  eng_stroke_begin(x: number, y: number, p: number): number;
  eng_stroke_move(n: number): number;
  eng_stroke_end(): number;
  eng_undo(): number;
  eng_redo(): number;
  eng_out_ptr(): number;
  eng_apply_record(ptr: number, len: number): bigint;
  eng_set_seq(seq: number): void;
  eng_seq(): number;
  eng_frame_update(): number;
  eng_gpu_page_count(): number;
  eng_gpu_page_sizes(p: number, out: number): void;
  eng_gpu_full_page(p: number): number;
  eng_gpu_arena_ptr(): number;
  eng_gpu_cmds_ptr(): number;
  eng_positions_ptr(): number;
  eng_positions_bytes(): number;
  eng_topo_bytes(): number;
  eng_checkpoint_collect(): number;
  eng_ckpt_ptr(): number;
  eng_ckpt_seq(): number;
  eng_checkpoint_failed(): void;
  eng_export_obj(outFaces: number): number;
  eng_stats(out: number): void;
  eng_hash(): bigint;
  eng_raycast(x: number, y: number): number;
  eng_hit_ptr(): number;
  eng_last_dab_ptr(): number;
  eng_bounds_ptr(): number;
  eng_set_history(budgetMB: number, maxSteps: number): void;
  eng_debug_trap(): void;
  // [io] core/src/io/abi.rs (IMP-0/1/2, EXP-2)
  eng_import(ptr: number, len: number, hint: number, leafMax: number): number;
  eng_export_stl(scale: number, info: number): number;
  eng_mesh_check(out: number): number;
}

export class Core {
  readonly x: Exports;
  readonly simd: boolean;
  private scratch = 0;
  private scratchLen = 0;

  private constructor(x: Exports, simd: boolean) {
    this.x = x;
    this.simd = simd;
  }

  /** SIMD build unless the on-device self-test fails (Safari 27.0 fixed a v128 bug). */
  static async load(): Promise<Core> {
    const simd = await instantiate(simdUrl);
    if (simd.mq_simd_selftest(4099) === 1 && simd.mq_simd_selftest((1 << 20) | 3) === 1) return new Core(simd, true);
    return new Core(await instantiate(scalarUrl), false);
  }

  mem(): ArrayBuffer {
    return this.x.memory.buffer;
  }

  /** Copies bytes into WASM memory (reusing one scratch allocation) and returns the pointer. */
  put(bytes: Uint8Array): number {
    if (bytes.length > this.scratchLen) {
      if (this.scratch) this.x.mq_free(this.scratch, this.scratchLen);
      this.scratchLen = Math.max(bytes.length, 1 << 16);
      this.scratch = this.x.mq_alloc(this.scratchLen);
    }
    new Uint8Array(this.mem(), this.scratch, bytes.length).set(bytes);
    return this.scratch;
  }

  /** Copy of `len` bytes from the engine's output buffer. */
  out(len: number): ArrayBuffer {
    return new Uint8Array(this.mem(), this.x.eng_out_ptr(), len).slice().buffer;
  }

  u32s(ptr: number, n: number): Uint32Array {
    return new Uint32Array(this.mem(), ptr, n);
  }

  f32s(ptr: number, n: number): Float32Array {
    return new Float32Array(this.mem(), ptr, n);
  }
}

async function instantiate(url: string): Promise<Exports> {
  const bytes = await (await fetch(url)).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports as unknown as Exports;
}
