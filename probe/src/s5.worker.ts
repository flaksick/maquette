// Spike S5: WebGL2 on an OffscreenCanvas in a worker (the planned renderer architecture).
//  render-test: 1/2/4/8M-triangle spheres split into <= 16 MB GPU pages (local vertex copies),
//               drawn per page with drawElements vs WEBGL_multi_draw over per-leaf ranges.
//  upload-test: 1 MB bufferSubData into 16/64/256 MB buffers each frame (ANGLE/Metal update
//               cost), plus a 1 MB index-buffer update.
//  resumed:     after the app comes back from the background, detect context loss or a blank
//               canvas with no event (WebKit 286707) via a 1-pixel readback.
import { loadCore, renderLayout, type CoreExports } from './core';
import { lookAt, mul, perspective, rot3 } from './mat4';
import { stats, round } from './stats';
import { workerScope } from './opfs';

const scope = workerScope();
const PAGE_BYTES = 16 * 2 ** 20;
const STRIDE = 20; // f32x3 position + snorm16x4 normal: 4-byte aligned for Metal/ANGLE
const PAGE_VERTS = Math.floor(PAGE_BYTES / STRIDE);
const CLEAR = [0.07, 0.07, 0.08];

interface Page {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  ibo: WebGLBuffer;
  indexCount: number;
  leafCounts: Int32Array;
  leafOffsets: Int32Array;
  bytes: number;
}

let canvas: OffscreenCanvas;
let gl: WebGL2RenderingContext;
let md: { multiDrawElementsWEBGL: (...a: unknown[]) => void } | null = null;
let prog: WebGLProgram;
let uMvp: WebGLUniformLocation;
let uRot: WebGLUniformLocation;
let pages: Page[] = [];
let core: CoreExports | null = null;
let contextLostEvents = 0;
const resumeLog = { resumes: 0, blank: 0, lost: 0 };

const raf = (cb: (t: number) => void) =>
  scope.requestAnimationFrame ? scope.requestAnimationFrame(cb) : (setTimeout(() => cb(performance.now()), 16) as unknown as number);

function compile(type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
  return s;
}

function init(c: OffscreenCanvas) {
  canvas = c;
  canvas.addEventListener('contextlost', () => contextLostEvents++);
  gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' }) as WebGL2RenderingContext;
  if (!gl) throw new Error('webgl2 unavailable in worker');
  md = gl.getExtension('WEBGL_multi_draw') as typeof md;
  prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aNrm;
uniform mat4 uMvp; uniform mat3 uRot;
out vec3 vN;
void main(){ vN = uRot * aNrm.xyz; gl_Position = uMvp * vec4(aPos, 1.0); }`));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
in vec3 vN; out vec4 o;
void main(){
  vec3 n = normalize(vN);
  float l = 0.5 + 0.5 * n.z;
  vec3 base = mix(vec3(0.18, 0.17, 0.20), vec3(0.86, 0.80, 0.74), l);
  o = vec4(base + pow(1.0 - max(n.z, 0.0), 3.0) * 0.25, 1.0);
}`));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  uMvp = gl.getUniformLocation(prog, 'uMvp')!;
  uRot = gl.getUniformLocation(prog, 'uRot')!;
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    multiDraw: !!md,
    extensions: gl.getSupportedExtensions(),
    workerRaf: typeof scope.requestAnimationFrame === 'function',
  };
}

function freePages() {
  for (const p of pages) {
    gl.deleteVertexArray(p.vao);
    gl.deleteBuffer(p.vbo);
    gl.deleteBuffer(p.ibo);
  }
  pages = [];
}

/** Split the mesh into <= 16 MB pages in BVH leaf order; cross-page triangles get local copies. */
function buildPages(n: number): { pages: number; gpuMB: number; buildMs: number; verts: number; tris: number } {
  freePages();
  const t0 = performance.now();
  core!.mq_render_mesh_new(n, 1024);
  const L = renderLayout(core!);
  const local = new Int32Array(L.nverts).fill(-1);
  // Typed scratch (JS arrays of numbers would cost ~8 B/entry: 190 MB at 8M triangles).
  const pageVerts = new Uint32Array(PAGE_VERTS);
  const pageIdx = new Uint32Array(PAGE_VERTS * 8);
  let nPageVerts = 0;
  let nPageIdx = 0;
  let leafCounts: number[] = [];
  let leafOffsets: number[] = [];
  let gpuBytes = 0;

  const flush = () => {
    if (nPageIdx === 0) return;
    const nv = nPageVerts;
    const data = new ArrayBuffer(nv * STRIDE);
    const f = new Float32Array(data);
    const s = new Int16Array(data);
    for (let i = 0; i < nv; i++) {
      const v = pageVerts[i];
      f[i * 5] = L.positions[3 * v];
      f[i * 5 + 1] = L.positions[3 * v + 1];
      f[i * 5 + 2] = L.positions[3 * v + 2];
      s[i * 10 + 6] = Math.round(L.normals[3 * v] * 32767);
      s[i * 10 + 7] = Math.round(L.normals[3 * v + 1] * 32767);
      s[i * 10 + 8] = Math.round(L.normals[3 * v + 2] * 32767);
      s[i * 10 + 9] = 0;
      local[v] = -1;
    }
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.SHORT, true, STRIDE, 12);
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, pageIdx.subarray(0, nPageIdx), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    const bytes = data.byteLength + nPageIdx * 4;
    gpuBytes += bytes;
    pages.push({
      vao, vbo, ibo, indexCount: nPageIdx,
      leafCounts: new Int32Array(leafCounts), leafOffsets: new Int32Array(leafOffsets), bytes,
    });
    nPageVerts = 0;
    nPageIdx = 0;
    leafCounts = [];
    leafOffsets = [];
  };

  for (let leaf = 0; leaf < L.nleaves; leaf++) {
    const s = L.leafTriOff[leaf];
    const e = L.leafTriOff[leaf + 1];
    if (nPageVerts + 3 * (e - s) > PAGE_VERTS || nPageIdx + 3 * (e - s) > pageIdx.length) flush();
    leafOffsets.push(nPageIdx * 4);
    for (let i = s; i < e; i++) {
      const t = 3 * L.triOrder[i];
      for (let c = 0; c < 3; c++) {
        const v = L.tris[t + c];
        if (local[v] < 0) {
          local[v] = nPageVerts;
          pageVerts[nPageVerts++] = v;
        }
        pageIdx[nPageIdx++] = local[v];
      }
    }
    leafCounts.push(3 * (e - s));
  }
  flush();
  const info = { pages: pages.length, gpuMB: round(gpuBytes / 2 ** 20, 1), buildMs: round(performance.now() - t0, 1), verts: L.nverts, tris: L.ntris };
  core!.mq_render_mesh_free();
  return info;
}

let angle = 0;
function draw(mode: 'perPage' | 'multiDraw') {
  const w = canvas.width;
  const h = canvas.height;
  gl.viewport(0, 0, w, h);
  gl.clearColor(CLEAR[0], CLEAR[1], CLEAR[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  angle += 0.01;
  const view = lookAt([Math.sin(angle) * 3, 0.8, Math.cos(angle) * 3], [0, 0, 0], [0, 1, 0]);
  gl.uniformMatrix4fv(uMvp, false, mul(perspective(0.8, w / h, 0.1, 20), view));
  gl.uniformMatrix3fv(uRot, false, rot3(view));
  for (const p of pages) {
    gl.bindVertexArray(p.vao);
    if (mode === 'multiDraw' && md) {
      md.multiDrawElementsWEBGL(gl.TRIANGLES, p.leafCounts, 0, gl.UNSIGNED_INT, p.leafOffsets, 0, p.leafCounts.length);
    } else {
      gl.drawElements(gl.TRIANGLES, p.indexCount, gl.UNSIGNED_INT, 0);
    }
  }
  gl.bindVertexArray(null);
}

function measure(seconds: number, perFrame: () => void): Promise<{ fps: number; frameMs: ReturnType<typeof stats> }> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let last = -1;
    const start = performance.now();
    const tick = (now: number) => {
      perFrame();
      if (last >= 0) deltas.push(now - last);
      last = now;
      if (performance.now() - start < seconds * 1000) raf(tick);
      else resolve({ fps: round(deltas.length / ((performance.now() - start) / 1000), 1), frameMs: stats(deltas) });
    };
    raf(tick);
  });
}

async function renderTest(sizes: number[], seconds: number) {
  core = core ?? (await loadCore('simd'));
  for (const n of sizes) {
    scope.postMessage({ type: 'progress', text: `building ${12 * n * n} triangles…` });
    const info = buildPages(n);
    const perPage = await measure(seconds, () => draw('perPage'));
    const multi = md ? await measure(seconds, () => draw('multiDraw')) : null;
    const leaves = pages.reduce((a, p) => a + p.leafCounts.length, 0);
    // Durable per size: if 8M triangles kills the page, the smaller results already landed.
    scope.postMessage({ type: 'size', n, result: { ...info, leaves, perPage, multiDraw: multi } });
  }
  buildPages(408); // keep the 2M mesh for the upload and resume tests
  scope.postMessage({ type: 'render-done' });
}

async function uploadTest(seconds: number) {
  if (pages.length === 0) {
    core = core ?? (await loadCore('simd'));
    buildPages(408);
  }
  const src = new Uint8Array(2 ** 20);
  crypto.getRandomValues(src.subarray(0, 65536));
  const out: Record<string, unknown> = {};
  for (const mb of [16, 64, 256]) {
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, buf);
    gl.bufferData(gl.COPY_WRITE_BUFFER, mb * 2 ** 20, gl.DYNAMIC_DRAW);
    const callMs: number[] = [];
    const r = await measure(seconds, () => {
      const off = Math.floor(Math.random() * (mb - 1)) * 2 ** 20;
      gl.bindBuffer(gl.COPY_WRITE_BUFFER, buf);
      const t = performance.now();
      gl.bufferSubData(gl.COPY_WRITE_BUFFER, off, src);
      callMs.push(performance.now() - t);
      draw('perPage');
    });
    gl.deleteBuffer(buf);
    out[`buffer${mb}MB`] = { fps: r.fps, frameMs: r.frameMs, subDataCallMs: stats(callMs) };
  }
  // Index update: rewrite 1 MB of the first page's index buffer with its own contents.
  const p = pages[0];
  const words = Math.min(p.indexCount, 2 ** 18);
  const idx = new Uint32Array(words);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.COPY_READ_BUFFER, p.ibo);
  gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, idx);
  const callMs: number[] = [];
  const r = await measure(seconds, () => {
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, p.ibo);
    const t = performance.now();
    gl.bufferSubData(gl.COPY_WRITE_BUFFER, 0, idx);
    callMs.push(performance.now() - t);
    draw('perPage');
  });
  out.indexUpdate1MB = { fps: r.fps, frameMs: r.frameMs, subDataCallMs: stats(callMs) };
  scope.postMessage({ type: 'upload-done', result: out });
}

function resumed() {
  resumeLog.resumes++;
  if (gl.isContextLost()) resumeLog.lost++;
  else if (pages.length > 0) {
    draw('perPage');
    const px = new Uint8Array(4);
    gl.readPixels(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const isClear = Math.abs(px[0] - CLEAR[0] * 255) < 3 && Math.abs(px[1] - CLEAR[1] * 255) < 3;
    if (isClear) resumeLog.blank++;
  }
  scope.postMessage({ type: 'resume-log', log: { ...resumeLog, contextLostEvents } });
}

scope.onmessage = async (e: MessageEvent) => {
  const m = e.data as { type: string; canvas?: OffscreenCanvas; sizes?: number[]; seconds?: number; width?: number; height?: number };
  try {
    if (m.type === 'init') scope.postMessage({ type: 'caps', caps: init(m.canvas!) });
    else if (m.type === 'resize') {
      canvas.width = m.width!;
      canvas.height = m.height!;
    } else if (m.type === 'render-test') await renderTest(m.sizes!, m.seconds ?? 3);
    else if (m.type === 'upload-test') await uploadTest(m.seconds ?? 3);
    else if (m.type === 'resumed') resumed();
  } catch (err) {
    scope.postMessage({ type: 'error', error: String(err) });
  }
};
