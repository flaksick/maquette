// WebGL2 renderer in the engine worker (OffscreenCanvas). Draws the paged GPU mirror built by the
// Rust engine (core/src/gpu.rs): per page, one VBO (f32x3 position + snorm16x4 normal, stride 20)
// and one IBO. Uploads come straight out of WASM memory. Draws only when asked (invariant 10).
import type { Core } from './wasm';
import type { Camera, M4 } from './camera';
import type { ViewState as View } from '../shared/protocol';

const STRIDE = 20;
const CMD_WORDS = 5;
const CLEAR: [number, number, number] = [0.105, 0.105, 0.118];

interface PageGL {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  ibo: WebGLBuffer;
  indexCount: number;
  vbytes: number;
  /** Wireframe overlay (PNT-6): polygon edges over the same VBO; only while the overlay is on. */
  edges: { vao: WebGLVertexArrayObject; ibo: WebGLBuffer; count: number } | null;
}


const MESH_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aNrm;
uniform mat4 uVP;
uniform mat4 uView;
out vec3 vN;
out vec3 vViewPos;
void main() {
  vN = mat3(uView) * aNrm.xyz;
  vViewPos = (uView * vec4(aPos, 1.0)).xyz;
  gl_Position = uVP * vec4(aPos, 1.0);
}`;

// Clay matcap (PNT-3, P1a): a soft key light from the upper left, warm diffuse, gentle rim and a
// faint specular — computed in view space, so the light rides with the camera like a matcap.
const MESH_FS = `#version 300 es
precision highp float;
in vec3 vN;
in vec3 vViewPos;
uniform int uFlat;
uniform float uOrtho;
out vec4 o;
void main() {
  // Flat (PNT-6): the face normal from screen-space derivatives of the view-space position,
  // so it needs no per-face data. It always faces the eye, as the flipped smooth normal does.
  vec3 faceN = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  if (uFlat == 1) n = faceN;
  vec3 v = uOrtho > 0.5 ? vec3(0.0, 0.0, 1.0) : normalize(-vViewPos); // NAV-4: parallel view rays in ortho
  vec3 l = normalize(vec3(-0.45, 0.55, 0.7));
  float diff = max(dot(n, l), 0.0);
  float wrap = max(dot(n, l) * 0.5 + 0.5, 0.0);
  vec3 base = vec3(0.78, 0.67, 0.58);
  vec3 col = base * (0.18 + 0.55 * diff + 0.27 * wrap * wrap);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  col += vec3(0.20, 0.21, 0.24) * rim;
  vec3 h = normalize(l + v);
  col += vec3(0.10) * pow(max(dot(n, h), 0.0), 40.0);
  o = vec4(pow(col, vec3(1.0 / 1.1)), 1.0);
}`;

const LINE_VS = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uVP;
void main() { gl_Position = uVP * vec4(aPos, 1.0); }`;

const LINE_FS = `#version 300 es
precision mediump float;
uniform vec4 uColor;
out vec4 o;
void main() { o = uColor; }`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader compile failed');
  return s;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link failed');
  return p;
}

export class Renderer {
  readonly canvas: OffscreenCanvas;
  gl!: WebGL2RenderingContext;
  private meshProg!: WebGLProgram;
  private lineProg!: WebGLProgram;
  private uVP!: WebGLUniformLocation;
  private uView!: WebGLUniformLocation;
  private uFlat!: WebGLUniformLocation;
  view: View = { shading: 'smooth', wireframe: false };
  private uOrtho!: WebGLUniformLocation;
  private lineVP!: WebGLUniformLocation;
  private lineColor!: WebGLUniformLocation;
  private ringVao!: WebGLVertexArrayObject;
  private ringVbo!: WebGLBuffer;
  private pages: PageGL[] = [];
  gpuBytes = 0;
  lost = false;
  frames = 0;

  constructor(canvas: OffscreenCanvas) {
    this.canvas = canvas;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    this.init();
  }

  init(): void {
    const gl = this.canvas.getContext('webgl2', { antialias: true, alpha: false, depth: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl as WebGL2RenderingContext;
    this.meshProg = program(this.gl, MESH_VS, MESH_FS);
    this.lineProg = program(this.gl, LINE_VS, LINE_FS);
    this.uVP = this.gl.getUniformLocation(this.meshProg, 'uVP')!;
    this.uView = this.gl.getUniformLocation(this.meshProg, 'uView')!;
    this.uFlat = this.gl.getUniformLocation(this.meshProg, 'uFlat')!;
    this.uOrtho = this.gl.getUniformLocation(this.meshProg, 'uOrtho')!;
    this.lineVP = this.gl.getUniformLocation(this.lineProg, 'uVP')!;
    this.lineColor = this.gl.getUniformLocation(this.lineProg, 'uColor')!;
    this.ringVao = this.gl.createVertexArray()!;
    this.ringVbo = this.gl.createBuffer()!;
    this.gl.bindVertexArray(this.ringVao);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.ringVbo);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, 65 * 12, this.gl.DYNAMIC_DRAW);
    this.gl.enableVertexAttribArray(0);
    this.gl.vertexAttribPointer(0, 3, this.gl.FLOAT, false, 12, 0);
    this.gl.bindVertexArray(null);
    this.pages = [];
    this.gpuBytes = 0;
    this.lost = false;
  }

  /** Rebuilds every page from the engine (load, new mesh, context loss, blank canvas). */
  uploadAll(core: Core): void {
    const gl = this.gl;
    this.freeEdges();
    for (const p of this.pages) {
      gl.deleteVertexArray(p.vao);
      gl.deleteBuffer(p.vbo);
      gl.deleteBuffer(p.ibo);
    }
    this.pages = [];
    this.gpuBytes = 0;
    const n = core.x.eng_gpu_page_count();
    for (let p = 0; p < n; p++) {
      const ncmds = core.x.eng_gpu_full_page(p);
      const cmds = core.u32s(core.x.eng_gpu_cmds_ptr(), ncmds * CMD_WORDS).slice();
      const arena = core.x.eng_gpu_arena_ptr();
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      const vbo = gl.createBuffer()!;
      const ibo = gl.createBuffer()!;
      let indexCount = 0;
      let vbytes = 0;
      for (let c = 0; c < ncmds; c++) {
        const [kind, , , src, len] = cmds.subarray(c * CMD_WORDS, c * CMD_WORDS + CMD_WORDS);
        const data = new Uint8Array(core.mem(), arena + src, len);
        if (kind === 0) {
          gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
          gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
          vbytes = len;
        } else {
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
          gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW);
          indexCount = len / 4;
        }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.SHORT, true, STRIDE, 12);
      gl.bindVertexArray(null);
      this.pages.push({ vao, vbo, ibo, indexCount, vbytes, edges: null });
      this.gpuBytes += vbytes + indexCount * 4;
    }
    if (this.view.wireframe) this.buildEdges(core);
  }

  /** Applies a view; the wireframe's edge buffers exist only while it is on. */
  setView(core: Core, view: View): void {
    this.view = { ...view };
    if (view.wireframe) this.buildEdges(core);
    else this.freeEdges();
  }

  private buildEdges(core: Core): void {
    const gl = this.gl;
    for (let p = 0; p < this.pages.length; p++) {
      const page = this.pages[p];
      if (page.edges) continue;
      const count = core.x.eng_gpu_edge_page(p);
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, page.vbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
      const ibo = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint8Array(core.mem(), core.x.eng_gpu_arena_ptr(), count * 4), gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      page.edges = { vao, ibo, count };
      this.gpuBytes += count * 4;
    }
  }

  private freeEdges(): void {
    for (const page of this.pages) {
      if (!page.edges) continue;
      this.gl.deleteVertexArray(page.edges.vao);
      this.gl.deleteBuffer(page.edges.ibo);
      this.gpuBytes -= page.edges.count * 4;
      page.edges = null;
    }
  }

  /** Applies the upload commands from `eng_frame_update`. */
  applyUpdates(core: Core, ncmds: number): void {
    if (ncmds === 0) return;
    const gl = this.gl;
    const cmds = core.u32s(core.x.eng_gpu_cmds_ptr(), ncmds * CMD_WORDS);
    const arena = core.x.eng_gpu_arena_ptr();
    const mem = core.mem();
    let staleEdges = false;
    for (let c = 0; c < ncmds; c++) {
      const o = c * CMD_WORDS;
      const page = this.pages[cmds[o + 1]];
      if (!page) continue;
      const data = new Uint8Array(mem, arena + cmds[o + 3], cmds[o + 4]);
      if (cmds[o] === 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, page.vbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, cmds[o + 2], data);
      } else if (cmds[o] === 2) {
        // TOP-3 dyntopo: the page's vertices replaced whole (its foreign section may have grown).
        gl.bindBuffer(gl.ARRAY_BUFFER, page.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
        this.gpuBytes += data.byteLength - page.vbytes;
        page.vbytes = data.byteLength;
      } else if (cmds[o] === 3) {
        // TOP-3 dyntopo: the page's triangles replaced whole (dead slots are degenerate).
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, page.ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
        this.gpuBytes += data.byteLength - page.indexCount * 4;
        page.indexCount = data.byteLength / 4;
        if (page.edges) {
          // Its polygon edges changed too: rebuilt below if the overlay is on.
          gl.deleteVertexArray(page.edges.vao);
          gl.deleteBuffer(page.edges.ibo);
          this.gpuBytes -= page.edges.count * 4;
          page.edges = null;
          staleEdges = true;
        }
      }
    }
    if (staleEdges && this.view.wireframe) this.buildEdges(core);
  }

  /** Pages on the GPU now (the worker re-uploads everything when the engine's count differs). */
  get pageCount(): number {
    return this.pages.length;
  }

  draw(cam: Camera, ring: { center: number[]; normal: number[]; radius: number } | null): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(CLEAR[0], CLEAR[1], CLEAR[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    const vp = cam.viewProj();
    const view = cam.view();
    gl.useProgram(this.meshProg);
    gl.uniformMatrix4fv(this.uVP, false, vp);
    gl.uniformMatrix4fv(this.uView, false, view);
    gl.uniform1f(this.uOrtho, cam.ortho ? 1 : 0);
    gl.uniform1i(this.uFlat, this.view.shading === 'flat' ? 1 : 0);
    const wire = this.view.wireframe;
    if (wire) {
      // Push the surface back a little so the edges on it win the depth test.
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 1);
    }
    for (const p of this.pages) {
      gl.bindVertexArray(p.vao);
      gl.drawElements(gl.TRIANGLES, p.indexCount, gl.UNSIGNED_INT, 0);
    }
    if (wire) {
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.useProgram(this.lineProg);
      gl.uniformMatrix4fv(this.lineVP, false, vp);
      gl.uniform4f(this.lineColor, 0.12, 0.1, 0.09, 0.45);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      for (const p of this.pages) {
        if (!p.edges) continue;
        gl.bindVertexArray(p.edges.vao);
        gl.drawElements(gl.LINES, p.edges.count, gl.UNSIGNED_INT, 0);
      }
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
    if (ring) this.drawRing(vp, ring);
    this.frames++;
  }

  private drawRing(vp: M4, ring: { center: number[]; normal: number[]; radius: number }): void {
    const gl = this.gl;
    const n = ring.normal;
    // Orthonormal basis around the normal.
    const a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let u = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]];
    const ul = Math.hypot(u[0], u[1], u[2]) || 1;
    u = u.map((x) => x / ul);
    const w = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    const pts = new Float32Array(65 * 3);
    const lift = ring.radius * 0.01;
    for (let i = 0; i <= 64; i++) {
      const t = (i / 64) * Math.PI * 2;
      for (let k = 0; k < 3; k++) {
        pts[i * 3 + k] = ring.center[k] + n[k] * lift + (u[k] * Math.cos(t) + w[k] * Math.sin(t)) * ring.radius;
      }
    }
    gl.useProgram(this.lineProg);
    gl.uniformMatrix4fv(this.lineVP, false, vp);
    gl.bindVertexArray(this.ringVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ringVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pts);
    gl.disable(gl.DEPTH_TEST);
    gl.uniform4f(this.lineColor, 1, 1, 1, 0.85);
    gl.drawArrays(gl.LINE_STRIP, 0, 65);
    gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  }

  /** True if the centre pixel is still the clear colour after a draw (WebKit 286707 check). */
  centerIsBlank(): boolean {
    const gl = this.gl;
    const px = new Uint8Array(4);
    gl.readPixels(this.canvas.width >> 1, this.canvas.height >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return Math.abs(px[0] - CLEAR[0] * 255) < 3 && Math.abs(px[1] - CLEAR[1] * 255) < 3 && Math.abs(px[2] - CLEAR[2] * 255) < 3;
  }
}
