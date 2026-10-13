// Spike S4: threads. Cross-origin isolation via our own service worker (GitHub Pages can't set
// headers), shared-memory limits across reloads, Atomics wait/notify, and the speedup curve of
// a WASM kernel over 1–8 workers. Decision: threads stay off unless stable and >= 1.5x faster.
import threadsUrl from '../../wasm/threads.wasm?url';
import S4Worker from './s4.worker?worker';
import { round } from './stats';
import { store, results } from './store';

const RELOADS = 20;
const MAXES = [16384, 32768, 65536];

export function sharedMemoryCheck(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const max of MAXES) {
    try {
      const m = new WebAssembly.Memory({ initial: 256, maximum: max, shared: true });
      out[`max${max}`] = m.buffer instanceof SharedArrayBuffer ? 'ok' : 'not-shared';
    } catch (e) {
      out[`max${max}`] = String(e);
    }
  }
  return out;
}

/** Called on every page load: continues the reload loop if one is active. */
export async function continueReloadLoop(onDone: () => void): Promise<boolean> {
  const st = await store.get<{ active: boolean; count: number; runs: unknown[] }>('s4-reload.json');
  if (!st?.active) return false;
  const runs = [...st.runs, { coi: crossOriginIsolated, shared: sharedMemoryCheck() }];
  const count = st.count + 1;
  if (count < RELOADS) {
    await store.set('s4-reload.json', { active: true, count, runs });
    setTimeout(() => location.reload(), 400);
    return true;
  }
  await store.set('s4-reload.json', { active: false, count, runs });
  const summary: Record<string, number> = {};
  for (const max of MAXES) {
    summary[`max${max}_ok`] = runs.filter(
      (r) => (r as { shared: Record<string, string> }).shared[`max${max}`] === 'ok',
    ).length;
  }
  await results.merge('s4', { reloadLoop: { reloads: runs.length, ...summary, coiTrue: runs.filter((r) => (r as { coi: boolean }).coi).length } });
  onDone();
  return true;
}

export async function startReloadLoop(): Promise<void> {
  await store.set('s4-reload.json', { active: true, count: 0, runs: [] });
  location.reload();
}

function waitFor(w: Worker, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    w.onmessage = (e: MessageEvent<Record<string, unknown>>) => {
      if (e.data.type === type) resolve(e.data);
      else if (e.data.type === 'error') reject(new Error(String(e.data.error)));
    };
  });
}

export async function runThreads(log: (s: string) => void): Promise<Record<string, unknown>> {
  const base = {
    crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    hardwareConcurrency: navigator.hardwareConcurrency,
    sharedMemory: sharedMemoryCheck(),
  };
  if (!crossOriginIsolated) return { ...base, speedup: 'unavailable: not cross-origin isolated' };

  const module = await WebAssembly.compile(await (await fetch(threadsUrl)).arrayBuffer());
  const memory = new WebAssembly.Memory({ initial: 1024, maximum: 16384, shared: true });
  const pool: Worker[] = [];
  for (let i = 0; i < 8; i++) {
    const w = new S4Worker();
    const ready = waitFor(w, 'ready');
    w.postMessage({ type: 'init', module, memory });
    await ready;
    pool.push(w);
  }

  // Speedup: 8M floats (32 MB), 20 rounds, split across W workers.
  const total = 8 * 2 ** 20;
  const rounds = 20;
  const curve: Record<string, number> = {};
  let t1 = 0;
  for (const W of [1, 2, 4, 6, 8]) {
    log(`threads: ${W} worker(s)…`);
    const per = Math.floor(total / W);
    const t = performance.now();
    await Promise.all(
      pool.slice(0, W).map((w, i) => {
        const done = waitFor(w, 'worked');
        w.postMessage({ type: 'work', ptr: 65536 + i * per * 4, n: per, rounds });
        return done;
      }),
    );
    const ms = performance.now() - t;
    if (W === 1) t1 = ms;
    curve[`w${W}_ms`] = round(ms, 1);
    curve[`w${W}_speedup`] = round(t1 / ms, 2);
  }

  // Atomics ping-pong between two workers.
  const cellMem = memory;
  new Int32Array(cellMem.buffer, 0, 1)[0] = 0;
  const rounds2 = 2000;
  const a = waitFor(pool[0], 'pinged');
  const b = waitFor(pool[1], 'pinged');
  pool[1].postMessage({ type: 'ping', memory: cellMem, cell: 0, rounds: rounds2, side: 1 });
  pool[0].postMessage({ type: 'ping', memory: cellMem, cell: 0, rounds: rounds2, side: 0 });
  const [ra] = await Promise.all([a, b]);
  const pingRoundTripUs = round(((ra.ms as number) * 1000) / rounds2, 1);
  for (const w of pool) w.terminate();

  const best = Math.max(...[2, 4, 6, 8].map((W) => curve[`w${W}_speedup`]));
  return {
    ...base,
    curve,
    bestSpeedup: best,
    pingRoundTripUs,
    decision: best >= 1.5 ? 'threads-faster (still needs reload stability)' : 'threads-not-worth-it',
  };
}
