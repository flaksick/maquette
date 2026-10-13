// Memory balloon: grows and dirties memory as fast as it can until iOS kills the page.
// Used to produce real jetsam kills at a random moment (verification harness "Real kills").
import { fillRandom, workerScope } from './opfs';

const scope = workerScope();
const STEP = 32 * 2 ** 20;

scope.onmessage = async (e: MessageEvent<{ delayMs: number }>) => {
  await new Promise((r) => setTimeout(r, e.data.delayMs));
  const keep: ArrayBuffer[] = [];
  let mem: WebAssembly.Memory | null = new WebAssembly.Memory({ initial: 1, maximum: 65536 });
  let seed = 99;
  let mb = 0;
  for (;;) {
    try {
      if (mem) {
        const before = mem.buffer.byteLength;
        mem.grow(STEP / 65536);
        seed = fillRandom(new Uint32Array(mem.buffer, before, STEP / 4), seed);
      } else {
        const b = new ArrayBuffer(STEP);
        seed = fillRandom(new Uint32Array(b), seed);
        keep.push(b);
      }
    } catch {
      mem = null; // WASM memory refused to grow: continue with plain ArrayBuffers
    }
    mb += STEP / 2 ** 20;
    scope.postMessage({ type: 'inflated', mb });
    await new Promise((r) => setTimeout(r, 0));
  }
};
