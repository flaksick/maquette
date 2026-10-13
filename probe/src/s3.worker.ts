// Spike S3: Rust/WASM (SIMD and scalar) vs the TypeScript twin on the same composite
// workload, plus the SIMD-vs-scalar bit check. Decision rule (DECISIONS.md): the core stays
// Rust only if TS mean / Rust mean >= 1.0.
import { copyLayout, loadCore, sceneLayout, type Variant } from './core';
import { stats, round } from './stats';
import { TsScene, pathPoint } from './tsbench';
import { buildBvh, buildTopo } from './tsbuild';
import { workerScope } from './opfs';

const scope = workerScope();
const N = 408; // 12 * 408^2 = 1,997,568 triangles, 998,786 vertices
const LEAF = 1024;
const STEPS = 200;
const WARMUP = 20;

function post(stage: string, data: Record<string, unknown> = {}) {
  scope.postMessage({ stage, ...data });
}

async function runRust(variant: Variant) {
  const core = await loadCore(variant);
  const t0 = performance.now();
  const h = core.mq_sphere_new(N, LEAF);
  const setupMs = performance.now() - t0;
  const times: number[] = [];
  const tAll = performance.now();
  for (let k = 0; k < STEPS; k++) {
    const t = performance.now();
    core.mq_composite_run(h, k, 1);
    times.push(performance.now() - t);
  }
  const totalMs = performance.now() - tAll;
  const checksum = core.mq_checksum(h);
  const rebuildMs: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    core.mq_rebuild(h, LEAF);
    rebuildMs.push(performance.now() - t);
  }
  const memMB = core.memory.buffer.byteLength / 2 ** 20;
  core.mq_scene_free(h);
  return {
    variant,
    setupMs: round(setupMs, 1),
    totalMs: round(totalMs, 1),
    msPerStep: round(totalMs / STEPS),
    steady: stats(times.slice(WARMUP)),
    checksum,
    rebuildMs: stats(rebuildMs),
    wasmMemoryMB: round(memMB, 1),
  };
}

async function runTs() {
  const core = await loadCore('simd');
  const h = core.mq_sphere_new(N, LEAF);
  const layout = copyLayout(sceneLayout(core, h));
  core.mq_scene_free(h);
  const scene = new TsScene(layout);
  const times: number[] = [];
  const tAll = performance.now();
  for (let k = 0; k < STEPS; k++) {
    const [cx, cy, cz, r] = pathPoint(k);
    const t = performance.now();
    scene.compositeStep(cx, cy, cz, r);
    times.push(performance.now() - t);
  }
  const totalMs = performance.now() - tAll;
  const rebuildMs: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    buildTopo(layout.nverts, layout.tris);
    buildBvh(layout.positions, layout.tris, LEAF);
    rebuildMs.push(performance.now() - t);
  }
  return {
    variant: 'ts',
    rebuildMs: stats(rebuildMs),
    totalMs: round(totalMs, 1),
    msPerStep: round(totalMs / STEPS),
    steady: stats(times.slice(WARMUP)),
    checksum: scene.checksum(),
    verts: layout.nverts,
    tris: layout.ntris,
    leaves: layout.nleaves,
  };
}

scope.onmessage = async () => {
  try {
    post('selftest');
    const simdCore = await loadCore('simd');
    const selftest = {
      compiled: simdCore.mq_simd_compiled(),
      small: simdCore.mq_simd_selftest(4099),
      large: simdCore.mq_simd_selftest(1 << 20 | 3),
    };
    post('rust-simd');
    const simd = await runRust('simd');
    post('rust-scalar');
    const scalar = await runRust('scalar');
    post('ts');
    const ts = await runTs();
    const ratio = round(ts.steady.mean / simd.steady.mean, 2);
    const rebuildRatio = round(ts.rebuildMs.mean / simd.rebuildMs.mean, 2);
    const composite = round(Math.sqrt(ratio * rebuildRatio), 2);
    const checksumRelDiff = Math.abs(ts.checksum - simd.checksum) / Math.max(1, Math.abs(simd.checksum));
    post('done', {
      result: {
        selftest,
        simd,
        scalar,
        ts,
        tsOverRust: ratio,
        tsOverRustRebuild: rebuildRatio,
        compositeScore: composite,
        simdBitIdenticalToScalar: simd.checksum === scalar.checksum,
        tsChecksumRelDiff: checksumRelDiff,
        decision: composite >= 1.0 ? 'rust-confirmed' : 'rust-slower-than-ts',
      },
    });
  } catch (err) {
    post('error', { error: String(err) });
  }
};
