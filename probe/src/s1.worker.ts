// Spike S1: memory ceiling. Grows one kind of memory in 64 MiB steps, dirtying every page with
// incompressible bytes, and durably writes "attempting N MB" BEFORE each step. If iOS kills the
// page, the marker survives and the next launch records the ceiling (lab protocol, Device budgets).
import { fillRandom, openSync, writeJsonSync, workerScope, type SyncHandle } from './opfs';

export type S1Mode = 'wasm-grow' | 'wasm-reserve' | 'typed' | 'gpu';
export interface S1Job {
  mode: S1Mode;
  run: number;
  condition: string;
  capMB: number;
  markerName: string;
}

const scope = workerScope();
const STEP_MB = 64;
const STEP_BYTES = STEP_MB * 2 ** 20;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let marker: SyncHandle;
let job: S1Job;
let seed = 0x1234567;

function mark(phase: string, extra: Record<string, unknown>) {
  writeJsonSync(marker, { ...job, phase, t: Date.now(), ...extra });
}

async function stepLoop(alloc: (stepIndex: number) => string | null) {
  let lastOkMB = 0;
  for (let s = 1; s * STEP_MB <= job.capMB; s++) {
    const attemptMB = s * STEP_MB;
    mark('growing', { attemptMB, lastOkMB });
    let error: string | null;
    try {
      error = alloc(s);
    } catch (e) {
      error = String(e);
    }
    if (error) {
      mark('failed', { failedAtMB: attemptMB, lastOkMB, error });
      scope.postMessage({ type: 'end', phase: 'failed', failedAtMB: attemptMB, lastOkMB, error });
      return;
    }
    lastOkMB = attemptMB;
    scope.postMessage({ type: 'progress', lastOkMB });
    await sleep(120); // let the OS account for the new pages before the next step
  }
  mark('done', { lastOkMB });
  scope.postMessage({ type: 'end', phase: 'done', lastOkMB });
}

function wasmGrow() {
  const mem = new WebAssembly.Memory({ initial: 1, maximum: 65536 });
  return stepLoop(() => {
    const before = mem.buffer.byteLength;
    mem.grow(STEP_BYTES / 65536);
    seed = fillRandom(new Uint32Array(mem.buffer, before, STEP_BYTES / 4), seed);
    return null;
  });
}

function wasmReserve() {
  // Largest memory that can be reserved up front (WebKit 222097: ~1.9 GB when reserved).
  let mem: WebAssembly.Memory | null = null;
  let pages = 65536;
  for (; pages >= 1024 && !mem; pages -= 1024) {
    try {
      mem = new WebAssembly.Memory({ initial: pages, maximum: pages });
    } catch {
      mem = null;
    }
  }
  const reservedMB = mem ? mem.buffer.byteLength / 2 ** 20 : 0;
  mark('reserved', { reservedMB });
  scope.postMessage({ type: 'reserved', reservedMB });
  if (!mem) return stepLoop(() => 'could not reserve even 64 MB');
  const reserved = mem;
  return stepLoop((s) => {
    const off = (s - 1) * STEP_BYTES;
    if (off + STEP_BYTES > reserved.buffer.byteLength) return `reservation exhausted at ${reservedMB} MB`;
    seed = fillRandom(new Uint32Array(reserved.buffer, off, STEP_BYTES / 4), seed);
    return null;
  });
}

function typed() {
  const keep: ArrayBuffer[] = [];
  return stepLoop(() => {
    const b = new ArrayBuffer(STEP_BYTES);
    seed = fillRandom(new Uint32Array(b), seed);
    keep.push(b);
    return null;
  });
}

function gpu() {
  const canvas = new OffscreenCanvas(4, 4);
  const gl = canvas.getContext('webgl2', { antialias: false }) as WebGL2RenderingContext | null;
  if (!gl) return stepLoop(() => 'no webgl2 in worker');
  const vs = gl.createShader(gl.VERTEX_SHADER)!;
  gl.shaderSource(vs, `#version 300 es
in vec4 a; void main(){ gl_Position = vec4(a.xyz * 1e-9, 1.0); gl_PointSize = 1.0; }`);
  gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(fs, `#version 300 es
precision mediump float; out vec4 o; void main(){ o = vec4(1); }`);
  gl.compileShader(fs);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.useProgram(prog);
  // One CPU-side source reused every step, so only GPU memory grows.
  const src = new Uint8Array(STEP_BYTES);
  for (let off = 0; off < src.length; off += 65536) crypto.getRandomValues(src.subarray(off, off + 65536));
  const keep: WebGLBuffer[] = [];
  return stepLoop((s) => {
    if (gl.isContextLost()) return 'context lost';
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, src, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, (s % 1000) * 16);
    gl.drawArrays(gl.POINTS, 0, 1);
    gl.finish();
    keep.push(buf);
    const err = gl.getError();
    if (err === gl.OUT_OF_MEMORY) return 'GL_OUT_OF_MEMORY';
    if (gl.isContextLost()) return 'context lost';
    return null;
  });
}

scope.onmessage = async (e: MessageEvent<S1Job>) => {
  job = e.data;
  marker = await openSync(job.markerName);
  mark('start', { lastOkMB: 0 });
  if (job.mode === 'wasm-grow') await wasmGrow();
  else if (job.mode === 'wasm-reserve') await wasmReserve();
  else if (job.mode === 'typed') await typed();
  else await gpu();
  marker.close();
};
