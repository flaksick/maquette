// Spike S4 worker: runs the hand-written threads module on a shared WebAssembly.Memory.
import { workerScope } from './opfs';

const scope = workerScope();
let exports: {
  work(ptr: number, n: number, rounds: number): void;
} | null = null;

type Msg =
  | { type: 'init'; module: WebAssembly.Module; memory: WebAssembly.Memory }
  | { type: 'work'; ptr: number; n: number; rounds: number }
  | { type: 'ping'; memory: WebAssembly.Memory; cell: number; rounds: number; side: 0 | 1 };

scope.onmessage = async (e: MessageEvent<Msg>) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      const inst = await WebAssembly.instantiate(m.module, { env: { memory: m.memory } });
      exports = inst.exports as unknown as typeof exports;
      scope.postMessage({ type: 'ready' });
    } else if (m.type === 'work') {
      const t = performance.now();
      exports!.work(m.ptr, m.n, m.rounds);
      scope.postMessage({ type: 'worked', ms: performance.now() - t });
    } else {
      // Ping-pong on one i32 cell: side 0 waits for odd values, side 1 for even values.
      const cell = new Int32Array(m.memory.buffer, m.cell, 1);
      const t = performance.now();
      for (let i = 0; i < m.rounds; i++) {
        if (m.side === 0) {
          Atomics.store(cell, 0, 2 * i + 1);
          Atomics.notify(cell, 0);
          while (Atomics.load(cell, 0) === 2 * i + 1) Atomics.wait(cell, 0, 2 * i + 1, 1000);
        } else {
          while (Atomics.load(cell, 0) !== 2 * i + 1) Atomics.wait(cell, 0, 2 * i, 1000);
          Atomics.store(cell, 0, 2 * i + 2);
          Atomics.notify(cell, 0);
        }
      }
      scope.postMessage({ type: 'pinged', ms: performance.now() - t });
    }
  } catch (err) {
    scope.postMessage({ type: 'error', error: String(err) });
  }
};
