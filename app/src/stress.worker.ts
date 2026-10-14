// "Stress-test this iPad" (PLT-8): grows memory in steps, dirtying every page with incompressible
// bytes (iOS compresses memory), until iPadOS closes the app, allocation fails, or the cap is
// reached. Before each step it durably records "attempting N MB" through the persist worker and
// waits for the flush, so the next launch knows how far it got (the S1 lab protocol,
// probe/src/s1.worker.ts). WASM memory first (what the engine uses), then plain buffers past the
// 4 GB WASM limit; nothing it allocates is released until the worker ends.
import type { PersistReply } from './shared/protocol';

export interface StressJob {
  persist: MessagePort;
  capMB: number;
  stepMB: number;
  pauseMs: number;
}

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<StressJob>) => {
  const { persist, capMB, stepMB, pauseMs } = e.data;
  let next = 1;
  const waiting = new Map<number, (r: PersistReply) => void>();
  persist.onmessage = (ev: MessageEvent<PersistReply>) => {
    waiting.get(ev.data.id)?.(ev.data);
    waiting.delete(ev.data.id);
  };
  const mark = (phase: 'growing' | 'ok', attemptMB: number, lastOkMB: number) =>
    new Promise<PersistReply>((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      persist.postMessage({ id, type: 'stress-mark', phase, attemptMB, lastOkMB });
    });

  const wasm = new WebAssembly.Memory({ initial: 1, maximum: 65536 });
  let growWasm = true;
  const held: ArrayBuffer[] = [];
  let seed = 0x2545f491;
  let lastOk = 0;
  for (let mb = stepMB; mb <= capMB; mb += stepMB) {
    const m = await mark('growing', mb, lastOk);
    if (!m.ok) {
      post({ type: 'end', outcome: 'error', lastOkMB: lastOk, failedAtMB: mb, error: m.error });
      return;
    }
    try {
      let words: Uint32Array | null = null;
      if (growWasm) {
        try {
          const before = wasm.buffer.byteLength;
          wasm.grow((stepMB * 2 ** 20) / 65536);
          words = new Uint32Array(wasm.buffer, before, (stepMB * 2 ** 20) / 4);
        } catch {
          growWasm = false; // the WASM limit, not the iPad's: keep what's held, continue in buffers
        }
      }
      if (!words) {
        const b = new ArrayBuffer(stepMB * 2 ** 20);
        held.push(b);
        words = new Uint32Array(b);
      }
      for (let i = 0; i < words.length; i++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        words[i] = seed >>> 0;
      }
    } catch (err) {
      post({ type: 'end', outcome: 'refused', lastOkMB: lastOk, failedAtMB: mb, error: String(err) });
      return;
    }
    lastOk = mb;
    await mark('ok', mb, lastOk);
    post({ type: 'progress', lastOkMB: lastOk });
    await new Promise((r) => setTimeout(r, pauseMs)); // let the OS account for the new pages
  }
  post({ type: 'end', outcome: 'capped', lastOkMB: lastOk, failedAtMB: null, held: held.length + (wasm.buffer.byteLength > 0 ? 1 : 0) });
};
