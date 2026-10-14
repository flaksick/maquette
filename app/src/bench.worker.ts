// Speed benchmark (PLT-8): the real engine's brush pipeline in its own WASM instance (the worker is
// terminated afterwards, so its memory goes back), on spheres of growing size until the time is
// used up or a size is clearly over the frame target. One "frame" = one stroke-move of 4 coalesced
// samples (a 240 Hz Pencil read at 60 Hz) + the frame update (normals, bounds, GPU staging): the
// engine's work per displayed frame. Strokes cycle Draw, Smooth, Grab (the composite workload).
// GPU drawing isn't timed: S5 measured 57 fps at 8M triangles on the Air 4, so it isn't the limit.
import { Core } from './engine/wasm';
import { Camera } from './engine/camera';
import { BENCH_VERSION, comfortableTris, memoryTris, type BenchResult, type BenchSize } from './budget';

export interface BenchJob {
  /** Largest mesh this run may build: the declared transient, checked against the budget. */
  maxTris: number;
  budgetMB: number;
  timeMs: number;
  targetMs: number;
}

const SIZES = [64, 128, 192, 256, 320, 408]; // 12 n^2 triangles: 49k, 197k, 442k, 786k, 1.2M, 2.0M
const LEAF = 1024;
const W = 1024;
const H = 768;
const FRAMES_PER_STROKE = 24;

function stat(xs: number[]): { p50: number; p95: number; mean: number } {
  const s = [...xs].sort((a, b) => a - b);
  const q = (f: number) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { p50: r(q(0.5)), p95: r(q(0.95)), mean: r(s.reduce((a, b) => a + b, 0) / s.length) };
}

function runSize(core: Core, n: number, ms: number): BenchSize {
  const t0 = performance.now();
  core.x.eng_new_sphere(n, LEAF);
  core.x.eng_set_history(8, 4); // brushes are measured, not undo memory
  const setupMs = performance.now() - t0;
  const cam = new Camera();
  cam.width = W;
  cam.height = H;
  cam.reset([0, 0, 0], 1);
  cam.pack(core.f32s(core.x.eng_camera_ptr(), 26));
  core.x.eng_camera_commit();
  const frames: number[] = [];
  const ends: number[] = [];
  const stop = performance.now() + ms;
  for (let k = 0; performance.now() < stop || frames.length < 3 * FRAMES_PER_STROKE; k++) {
    // 100 device px (50 CSS px at 2x), half strength, pressure -> strength, mirror X, preserve volume.
    core.x.eng_set_brush(k % 3, 100, 0.5, 2 | 4 | 8, 1, 0.1);
    const r0 = 120 + (k % 5) * 25;
    const a0 = k * 0.7;
    const at = (a: number): [number, number] => [W / 2 + r0 * Math.cos(a), H / 2 + r0 * Math.sin(a)];
    core.x.eng_stroke_begin(...at(a0), 0.8);
    for (let f = 0; f < FRAMES_PER_STROKE; f++) {
      const buf = core.f32s(core.x.eng_samples_ptr(12), 12);
      for (let i = 0; i < 4; i++) {
        const [x, y] = at(a0 + (f * 4 + i + 1) * 0.04); // ~6 px per sample, ~24 px per frame: a brisk stroke
        buf[3 * i] = x;
        buf[3 * i + 1] = y;
        buf[3 * i + 2] = 0.8;
      }
      const t = performance.now();
      core.x.eng_stroke_move(4);
      core.x.eng_frame_update();
      frames.push(performance.now() - t);
    }
    const t = performance.now();
    core.x.eng_stroke_end();
    ends.push(performance.now() - t);
  }
  return {
    tris: 12 * n * n,
    verts: 6 * n * n + 2,
    setupMs: Math.round(setupMs * 10) / 10,
    frames: frames.length,
    frameMs: stat(frames),
    strokeEndMs: stat(ends).mean,
  };
}

self.onmessage = async (e: MessageEvent<BenchJob>) => {
  const job = e.data;
  const t0 = performance.now();
  try {
    const core = await Core.load();
    const sizes: BenchSize[] = [];
    const todo = SIZES.filter((n) => 12 * n * n <= job.maxTris);
    for (let i = 0; i < todo.length; i++) {
      const left = job.timeMs - (performance.now() - t0);
      if (left < 600 && sizes.length >= 2) break;
      const z = runSize(core, todo[i], Math.max(250, Math.min(1500, left / (todo.length - i) - 200)));
      sizes.push(z);
      (self as unknown as Worker).postMessage({ type: 'progress', size: z });
      if (z.frameMs.p95 > job.targetMs * 3) break; // bigger meshes would only be slower
    }
    const c = comfortableTris(sizes, job.targetMs, memoryTris(job.budgetMB));
    const result: BenchResult = {
      version: BENCH_VERSION,
      t: new Date().toISOString(),
      simd: core.simd,
      totalMs: Math.round(performance.now() - t0),
      targetMs: job.targetMs,
      sizes,
      comfortableTris: c.tris,
      limitedBy: c.limitedBy,
      maxTris: job.maxTris,
    };
    (self as unknown as Worker).postMessage({ type: 'done', result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', error: String(err) });
  }
};
