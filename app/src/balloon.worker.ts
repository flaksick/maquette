// Diagnostics kill test (PRJ-4 on device): grows and dirties memory until iOS kills the app,
// which is the real way Maquette dies on an iPad. The next launch checks that nothing
// acknowledged was lost.
const STEP = 32 * 2 ** 20;

self.onmessage = async () => {
  const keep: ArrayBuffer[] = [];
  let mem: WebAssembly.Memory | null = new WebAssembly.Memory({ initial: 1, maximum: 65536 });
  let s = 0x2545f491;
  for (;;) {
    try {
      let words: Uint32Array;
      if (mem) {
        const before = mem.buffer.byteLength;
        mem.grow(STEP / 65536);
        words = new Uint32Array(mem.buffer, before, STEP / 4);
      } else {
        const b = new ArrayBuffer(STEP);
        keep.push(b);
        words = new Uint32Array(b);
      }
      for (let i = 0; i < words.length; i++) {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        words[i] = s >>> 0;
      }
    } catch {
      mem = null;
    }
    await new Promise((r) => setTimeout(r, 0));
  }
};
