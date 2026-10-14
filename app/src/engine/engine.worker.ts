// Engine worker: owns the mesh (invariant 2), the renderer, the camera and the save pipeline.
// Main thread sends input; this worker turns it into strokes, journals every stroke/undo/redo
// before reporting it saved, and checkpoints when idle. It renders only when something changed.
import { Core } from './wasm';
import { Renderer } from './renderer';
import { Camera, type V3 } from './camera';
import {
  TOOL_ID,
  type BrushState,
  type FromEngine,
  type OpenResult,
  type PersistReply,
  type RecoveryInfo,
  type Stats,
  type ToEngine,
  type ToPersist,
  type ImportReport,
  type Units,
  UNITS,
  UNIT_TO_MM,
} from '../shared/protocol';
import { LOW_SPACE_BYTES } from '../shared/library';

const DEFAULT_SPHERE = 96; // 110,592 triangles
const LEAF = 1024;
const CHECKPOINT_IDLE_MS = 2000;
const JOURNAL_FORCE_BYTES = 64 * 2 ** 20;
const BYTES_PER_VERTEX = 170; // ARCHITECTURE "Memory": ~110 CPU + ~60 GPU until measured

interface Scope {
  postMessage(m: unknown, t?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
  requestAnimationFrame?: (cb: (t: number) => void) => number;
}
const scope = self as unknown as Scope;

let core: Core;
let renderer: Renderer;
const cam = new Camera();
let dpr = 1;
let persist: MessagePort;
let budgetMB = 1459;
let storageOk = true;
let projectId = '';
let brush: BrushState = { tool: 'draw', radiusPx: 40, strength: 0.5, pressureRadius: false, pressureStrength: true, gamma: 1, symmetryX: true };
let pivot: V3 = [0, 0, 0];
let strokeActive = false;
let previewRadius = false;
let frameRequested = false;
let lastAcked = 0;
let journalBytes = 0;
let lastChange = 0;
let ckptTimer: ReturnType<typeof setTimeout> | null = null;
let ckptInFlight = false;
let highWaterMB = 0;
let lastStatsPost = 0;
let stateTimer: ReturnType<typeof setTimeout> | null = null;
let units: Units = 'm'; // PRJ-9: what one unit means; saved with the view state, default metres

const post = (m: FromEngine, t: Transferable[] = []) => scope.postMessage(m, t);

// Crash containment (PLT-7): a WASM trap anywhere ends up here; the main thread restarts the
// engine, which reloads the project from storage (every acknowledged stroke is on disk).
self.addEventListener('unhandledrejection', (ev) => post({ type: 'fatal', error: String((ev as PromiseRejectionEvent).reason) }));
self.addEventListener('error', (ev) => post({ type: 'fatal', error: String((ev as ErrorEvent).message) }));

// ---------- persist RPC ----------
let nextId = 1;
const waiting = new Map<number, (r: PersistReply) => void>();
type PersistMsg = ToPersist extends infer T ? (T extends { id: number } ? Omit<T, 'id'> : never) : never;
function call(msg: PersistMsg, transfer: Transferable[] = []): Promise<PersistReply> {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    persist.postMessage({ ...msg, id }, transfer);
  });
}

// ---------- frames ----------
const raf = (cb: (t: number) => void) =>
  scope.requestAnimationFrame ? scope.requestAnimationFrame(cb) : setTimeout(() => cb(performance.now()), 16);

function requestFrame(): void {
  if (frameRequested) return;
  frameRequested = true;
  raf(frame);
}

function ring(): { center: number[]; normal: number[]; radius: number } | null {
  if (strokeActive) {
    const d = core.f32s(core.x.eng_last_dab_ptr(), 7);
    return d[6] > 0 ? { center: [d[0], d[1], d[2]], normal: [d[3], d[4], d[5]], radius: d[6] } : null;
  }
  if (previewRadius) {
    commitCamera();
    if (core.x.eng_raycast(cam.width / 2, cam.height / 2)) {
      const h = core.f32s(core.x.eng_hit_ptr(), 6);
      const p: V3 = [h[0], h[1], h[2]];
      return { center: [...p], normal: [h[3], h[4], h[5]], radius: brush.radiusPx * dpr * cam.depthOf(p) * cam.pxToWorld() };
    }
  }
  return null;
}

function frame(): void {
  frameRequested = false;
  if (renderer.lost) {
    renderer.init();
    renderer.uploadAll(core);
  }
  const n = core.x.eng_frame_update();
  renderer.applyUpdates(core, n);
  renderer.draw(cam, ring());
  const mb = (core.mem().byteLength + renderer.gpuBytes) / 2 ** 20;
  highWaterMB = Math.max(highWaterMB, mb);
  postStats(false);
}

let statsTimer: ReturnType<typeof setTimeout> | null = null;
/** Stats drive the undo/redo buttons and the HUD. Throttled during strokes, but a trailing post
 *  always follows: rendering stops when idle (invariant 10), so a frame-only post left the UI
 *  stale (Undo greyed out right after a stroke — found by the 2026-10-14 glitch pass). */
function postStats(force: boolean): void {
  const now = performance.now();
  if (force || now - lastStatsPost > 250) {
    lastStatsPost = now;
    if (statsTimer) {
      clearTimeout(statsTimer);
      statsTimer = null;
    }
    post({ type: 'stats', stats: stats() });
  } else if (!statsTimer) {
    statsTimer = setTimeout(() => {
      statsTimer = null;
      lastStatsPost = performance.now();
      post({ type: 'stats', stats: stats() });
    }, 260 - (now - lastStatsPost));
  }
}

function stats(): Stats {
  const p = core.x.mq_alloc(48);
  core.x.eng_stats(p);
  const s = core.u32s(p, 12).slice();
  core.x.mq_free(p, 48);
  return {
    verts: s[0],
    tris: s[1],
    leaves: s[2],
    pages: s[3],
    undoDepth: s[4],
    redoDepth: s[5],
    undoKiB: s[6],
    seq: s[7],
    gpuMiB: Math.round(renderer.gpuBytes / 2 ** 20),
    wasmMiB: Math.round(core.mem().byteLength / 2 ** 20),
    dirtyLeaves: s[11],
    frames: renderer.frames,
    lastAcked,
    journalBytes,
  };
}

function commitCamera(): void {
  cam.pack(core.f32s(core.x.eng_camera_ptr(), 26));
  core.x.eng_camera_commit();
}

function setBrush(b: BrushState): void {
  brush = b;
  const flags = (b.pressureRadius ? 1 : 0) | (b.pressureStrength ? 2 : 0) | (b.symmetryX ? 4 : 0) | 8;
  core.x.eng_set_brush(TOOL_ID[b.tool], b.radiusPx * dpr, b.strength, flags, b.gamma, 0.1);
}

function frameView(reset: boolean): void {
  const b = core.f32s(core.x.eng_bounds_ptr(), 6);
  const center: V3 = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
  const radius = Math.max(Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2, 1e-3);
  if (reset) cam.reset(center, radius);
  else cam.frame(center, radius);
  pivot = center;
}

function stateJson(): string {
  return JSON.stringify({ camera: { eye: cam.eye, yaw: cam.yaw, pitch: cam.pitch }, brush, units });
}

function saveStateSoon(): void {
  if (stateTimer) clearTimeout(stateTimer);
  stateTimer = setTimeout(saveStateNow, 1000);
}

/** View and tool state (PRJ-10) plus the project's units (PRJ-9), written now. */
function saveStateNow(): void {
  if (stateTimer) clearTimeout(stateTimer);
  stateTimer = null;
  if (!storageOk || !projectId) return;
  void call({ type: 'state', json: stateJson(), projectId });
}

// ---------- saving ----------
function journal(len: number): void {
  if (len === 0) return;
  const bytes = core.out(len);
  const seq = core.x.eng_seq();
  lastChange = performance.now();
  if (!storageOk) return;
  const t0 = performance.now();
  journalBytes += len;
  postStats(true);
  // Not transferred: if the disk refuses it (PLT-11) the record is kept and resent in order.
  void call({ type: 'journal', seq, bytes, projectId }).then((r) => {
    if (!r.ok) return r.code === 'quota' ? diskRefused(seq, bytes) : storageFailed(r.error);
    acked(seq, t0);
  });
  if (journalBytes > JOURNAL_FORCE_BYTES) void checkpoint();
  else scheduleCheckpoint();
}

function acked(seq: number, t0: number): void {
  lastAcked = Math.max(lastAcked, seq);
  post({ type: 'saved', seq, latencyMs: Math.round(performance.now() - t0) });
  postStats(true);
}

function scheduleCheckpoint(): void {
  if (ckptTimer) clearTimeout(ckptTimer);
  ckptTimer = setTimeout(() => {
    if (strokeActive || performance.now() - lastChange < CHECKPOINT_IDLE_MS) scheduleCheckpoint();
    else void checkpoint();
  }, CHECKPOINT_IDLE_MS);
}

/** Incremental checkpoint of changed position ranges. Never mid-stroke: a snapshot must equal
 *  the state after a journaled record. */
async function checkpoint(): Promise<void> {
  if (!storageOk || ckptInFlight || strokeActive || loading) return;
  core.x.eng_frame_update(); // flush dirty flags from the last stroke into the checkpoint set
  const n = core.x.eng_checkpoint_collect();
  if (n === 0) return;
  const r = core.u32s(core.x.eng_ckpt_ptr(), n * 3).slice();
  let total = 0;
  for (let i = 0; i < n; i++) total += r[3 * i + 2];
  const data = new Uint8Array(total);
  const ranges = new Uint32Array(2 * n);
  let at = 0;
  for (let i = 0; i < n; i++) {
    const [fileOffset, ptr, len] = [r[3 * i], r[3 * i + 1], r[3 * i + 2]];
    data.set(new Uint8Array(core.mem(), ptr, len), at);
    ranges[2 * i] = fileOffset;
    ranges[2 * i + 1] = len;
    at += len;
  }
  const seq = core.x.eng_ckpt_seq();
  ckptInFlight = true;
  const res = await call({ type: 'checkpoint', seq, ranges, data: data.buffer, projectId }, [data.buffer]);
  ckptInFlight = false;
  if (!res.ok) {
    core.x.eng_checkpoint_failed();
    // PLT-11: a full disk loses nothing here (the journal holds every record); retried later.
    if (res.code === 'quota') return;
    return storageFailed(res.error);
  }
  journalBytes = 0;
  // PLT-11: positions.bin now holds every change up to `seq`, including records the disk refused.
  if (unsaved.length && seq >= unsaved[unsaved.length - 1].seq) {
    unsaved.length = 0;
    lastAcked = Math.max(lastAcked, seq);
    post({ type: 'saved', seq, latencyMs: 0 });
    post({ type: 'disk', full: diskFull, unsaved: 0 });
  }
  postStats(true);
}

function storageFailed(error?: string): void {
  if (!storageOk) return;
  storageOk = false;
  post({ type: 'storage', ok: false, error });
}

// ---------- project lifecycle ----------
function copyIn(bytes: Uint8Array): [number, number] {
  const ptr = core.x.mq_alloc(bytes.length);
  new Uint8Array(core.mem(), ptr, bytes.length).set(bytes);
  return [ptr, bytes.length];
}

async function createSphere(n: number): Promise<boolean> {
  const verts = 6 * n * n + 2;
  const needMB = (verts * BYTES_PER_VERTEX) / 2 ** 20;
  if (needMB > budgetMB) {
    post({ type: 'refused', text: `A ${(12 * n * n).toLocaleString()}-triangle sphere needs about ${Math.round(needMB)} MB; this iPad's budget is ${budgetMB} MB.` });
    return false;
  }
  core.x.eng_new_sphere(n, LEAF);
  await createProjectFromEngine(`Sphere ${12 * n * n}`, 'm');
  return true;
}

/** A new project from the mesh the engine holds now (sphere, import): history reset, files written
 *  through persist 'create', view framed. Brush and camera live in the engine, so the brush is
 *  re-sent after every install (the camera is committed before each stroke). */
async function createProjectFromEngine(name: string, u: Units): Promise<void> {
  core.x.eng_set_history(Math.round(budgetMB * 0.25), 200);
  setBrush(brush);
  lastAcked = 0;
  journalBytes = 0;
  units = u;
  const tlen = core.x.eng_topo_bytes();
  const topo = core.out(tlen);
  const positions = new Uint8Array(core.mem(), core.x.eng_positions_ptr(), core.x.eng_positions_bytes()).slice().buffer;
  projectId = crypto.randomUUID();
  if (storageOk) {
    projectName = name;
    const r = await call({ type: 'create', projectId, name, topo, positions }, [topo, positions]);
    if (!r.ok) storageFailed(r.error);
  }
  frameView(true);
  saveStateNow();
  renderer.uploadAll(core);
  requestFrame();
  post({ type: 'units', units });
}

// ---------- [io] import (IMP-0/1/2) ----------
const IMPORT_HINT: Record<string, number> = { obj: 1, stl: 2 };
const REPORT_WORDS = 26; // core/src/io ImportReport::to_words
const IMPORT_ERRORS = ['', 'not a mesh file it can read', 'there are no faces in it', 'a number it can\u2019t read', 'a face points at a vertex that isn\u2019t there', 'the file is cut short', 'it is too large', 'cleanup failed (a bug)'];
const FORMATS: ImportReport['format'][] = ['obj', 'obj', 'stl-binary', 'stl-ascii'];

/** Parses + cleans in WASM, installs the mesh, then makes it a NEW project (the previous one
 *  stays saved). On any failure the current sculpt is untouched. */
async function importMesh(name: string, ext: string, bytes: ArrayBuffer): Promise<void> {
  const hint = IMPORT_HINT[ext.toLowerCase()];
  if (!hint) {
    post({ type: 'import-failed', text: `Maquette imports .obj and .stl files; \u201c${name}\u201d isn\u2019t one.` });
    return;
  }
  // Pre-flight (PLT-8): parse + cleanup + the new mesh, from the file size. OBJ ~50 bytes per
  // vertex; STL 50 bytes per facet, ~2 facets per vertex. Refused before any memory is touched.
  const perByte = hint === 1 ? 2 + 290 / 50 : 2 + 160 / 50 + BYTES_PER_VERTEX / 100;
  const needMB = (bytes.byteLength * perByte) / 2 ** 20;
  if (needMB > budgetMB) {
    post({ type: 'import-failed', text: `${name} needs about ${Math.round(needMB)} MB to import; this iPad's budget is ${budgetMB} MB.` });
    return;
  }
  // Same sequence as a new sphere (PRJ-1): the open project's records are flushed before the
  // engine's mesh is replaced, and no other switch can interleave.
  if (switching || editBlocked()) {
    post({ type: 'import-failed', text: 'Another project change is in progress or storage is full; try again in a moment.' });
    return;
  }
  switching = true;
  try {
    await flushProject();
    loading = true;
    await importInstalled(name, hint, bytes);
  } finally {
    loading = false;
    switching = false;
  }
}

async function importInstalled(name: string, hint: number, bytes: ArrayBuffer): Promise<void> {
  const t0 = performance.now();
  const src = new Uint8Array(bytes);
  const ptr = core.x.mq_alloc(src.length);
  new Uint8Array(core.mem(), ptr, src.length).set(src);
  const rp = core.x.eng_import(ptr, src.length, hint, LEAF);
  core.x.mq_free(ptr, src.length);
  const w = core.u32s(rp, REPORT_WORDS).slice();
  if (w[0] !== 0) {
    const why = IMPORT_ERRORS[w[0]] ?? `error ${w[0]}`;
    post({ type: 'import-failed', text: `Couldn\u2019t import ${name}: ${why}${w[2] ? ` (line ${w[2]})` : ''}. Your sculpt is unchanged.` });
    return;
  }
  const report: ImportReport = {
    name,
    format: FORMATS[w[1]] ?? 'obj',
    inVerts: w[3],
    inFaces: w[4],
    weldedVerts: w[5],
    droppedDuplicate: w[6],
    droppedDegenerate: w[7],
    flippedFaces: w[8],
    splitNonManifold: w[9],
    components: w[10],
    boundaryEdges: w[11],
    looseVerts: w[12],
    verts: w[13],
    faces: w[14],
    tris: w[15],
    coloredVerts: w[16],
    groups: w[17],
    ignoredElements: w[18],
    unitsGuess: UNITS[w[19]] ?? 'm',
    bbox: Array.from(new Float32Array(w.buffer, 20 * 4, 6)),
    ms: 0,
  };
  await createProjectFromEngine(name.replace(/\.[^.]*$/, '') || 'Import', report.unitsGuess);
  brushRestored = false;
  report.ms = Math.round(performance.now() - t0);
  post({ type: 'import-done', report });
  postStats(true);
  postProject();
}

function loadProject(r: OpenResult, unclean: boolean): RecoveryInfo {
  const [tp, tl] = copyIn(new Uint8Array(r.topo!));
  const [pp, pl] = copyIn(new Uint8Array(r.positions!));
  const ok = core.x.eng_load(tp, tl, pp, pl);
  core.x.mq_free(tp, tl);
  core.x.mq_free(pp, pl);
  if (ok !== 1) throw new Error(`project files damaged (code ${ok})`);
  core.x.eng_set_history(Math.round(budgetMB * 0.25), 200);
  // Replay every intact journal record in order; stop at the first damaged one.
  const j = new Uint8Array(r.journal ?? new ArrayBuffer(0));
  let records = 0;
  let stoppedAt: string | null = null;
  let lastSeq = r.checkpointSeq ?? 0;
  if (j.length) {
    const [jp, jl] = copyIn(j);
    const dv = new DataView(j.buffer);
    let at = 0;
    while (at < jl) {
      if (at + 24 > jl) {
        stoppedAt = `torn header at byte ${at}`;
        break;
      }
      const res = core.x.eng_apply_record(jp + at, jl - at);
      if (res < 0n) {
        stoppedAt = `record ${records + 1} rejected (code ${res})`;
        break;
      }
      lastSeq = Math.max(lastSeq, Number(res));
      records++;
      at += 24 + dv.getUint32(at + 16, true);
    }
    core.x.mq_free(jp, jl);
  }
  core.x.eng_set_seq(lastSeq);
  lastAcked = lastSeq;
  projectId = r.projectId!;
  // Restore view and tool state (PRJ-10) and the project's units (PRJ-9).
  units = 'm';
  let restoredCamera = false;
  if (r.state) {
    try {
      const st = JSON.parse(r.state) as { camera?: { eye: V3; yaw: number; pitch: number }; brush?: BrushState; units?: Units };
      if (st.brush) brush = { ...brush, ...st.brush };
      if (st.units && UNITS.includes(st.units)) units = st.units;
      frameView(false);
      if (st.camera) {
        cam.eye = st.camera.eye;
        cam.yaw = st.camera.yaw;
        cam.pitch = st.camera.pitch;
        restoredCamera = true;
      }
    } catch {}
  }
  if (!restoredCamera) frameView(true);
  return { project: r.name ?? 'Sculpt', records, stoppedAt, lastSeq, uncleanExit: unclean };
}

async function init(m: Extract<ToEngine, { type: 'init' }>): Promise<void> {
  dpr = m.dpr;
  budgetMB = m.budgetMB;
  persist = m.persist;
  persist.onmessage = (e: MessageEvent<PersistReply>) => {
    const w = waiting.get(e.data.id);
    if (w) {
      waiting.delete(e.data.id);
      w(e.data);
    }
  };
  core = await Core.load();
  renderer = new Renderer(m.canvas);
  resize(m.width, m.height, m.dpr);
  let unclean = false;
  const s = await call({ type: 'session-start' });
  if (s.ok) unclean = !!(s.value as { uncleanExit: boolean }).uncleanExit;
  else storageFailed(s.error);
  let recovered: RecoveryInfo = { project: '', records: 0, stoppedAt: null, lastSeq: 0, uncleanExit: unclean };
  const r = storageOk ? await call({ type: 'open-last' }) : null;
  if (r && !r.ok) storageFailed(r.error);
  const opened = r?.ok ? (r.value as OpenResult) : null;
  if (opened?.status === 'ok') {
    try {
      recovered = loadTracked(opened, unclean);
    } catch (e) {
      post({ type: 'status', text: `Couldn't open the last project (${e}); started a new sphere.`, level: 'error' });
      await createSphere(DEFAULT_SPHERE);
    }
  } else {
    await createSphere(DEFAULT_SPHERE);
    recovered.project = 'New sphere';
  }
  if (pendingSize) {
    resize(pendingSize.width, pendingSize.height, pendingSize.dpr);
    pendingSize = null;
  }
  setBrush(brush);
  renderer.uploadAll(core);
  requestFrame();
  if (recovered.records > 0 || recovered.stoppedAt) void checkpoint();
  post({ type: 'ready', stats: stats(), recovered, brush, simd: core.simd });
  postProject();
  post({ type: 'units', units });
  if (!storageOk) post({ type: 'storage', ok: false, error: 'storage unavailable' });
  setInterval(() => {
    if (storageOk) void call({ type: 'session-beat', highWaterMB: Math.round(highWaterMB), seq: core.x.eng_seq() });
  }, 2000);
}

function resize(width: number, height: number, ratio: number): void {
  dpr = ratio;
  renderer.canvas.width = Math.max(1, Math.round(width * ratio));
  renderer.canvas.height = Math.max(1, Math.round(height * ratio));
  cam.width = renderer.canvas.width;
  cam.height = renderer.canvas.height;
}

function hitOrPlane(xCss: number, yCss: number): V3 {
  commitCamera();
  if (core.x.eng_raycast(xCss * dpr, yCss * dpr)) {
    const h = core.f32s(core.x.eng_hit_ptr(), 3);
    return [h[0], h[1], h[2]];
  }
  return cam.planePoint(xCss * dpr, yCss * dpr);
}

// ---------- projects (PRJ-1) and the disk-full policy (PLT-11), P1b ----------
// Switching: edits are blocked from the request until the new mesh is in memory. The old
// project is flushed first (camera/tool state and a final checkpoint: not needed for safety,
// since every acknowledged record is already in the journal, but it keeps journals short and
// project files journal-free). While the new project is read and loaded no checkpoint may run
// (`loading`), and every write names its project (persist refuses a mismatch), so nothing of one
// project can land in another.
let switching = false;
let loading = false;
let projectName = '';
let brushRestored = false;
let diskFull = false;
let retrying = false;
/** Records the disk refused (PLT-11), in seq order: resent in order, never skipped. */
const unsaved: { seq: number; bytes: ArrayBuffer }[] = [];
const mbs = (n: number) => `${Math.max(0, Math.round(n / 2 ** 20)).toLocaleString('en-US')} MB`;

/** Tells the UI which project is open; call after anything that changes `projectId`. */
function postProject(error?: string): void {
  post({ type: 'project', id: projectId, name: projectName, brush, brushRestored, error });
}

function loadTracked(r: OpenResult, unclean: boolean): RecoveryInfo {
  const before = brush;
  const info = loadProject(r, unclean);
  brushRestored = brush !== before; // loadProject replaces `brush` only when the project saved one
  projectName = info.project;
  return info;
}

/** True (and says why) while edits must wait: a project is being swapped in, or the disk
 *  refused a record that is not saved yet. */
function editBlocked(): boolean {
  if (switching) return true;
  if (!diskFull) return false;
  post({ type: 'refused', text: 'Storage is full and your last change isn’t saved yet. Free space (back up, then purge Recently Deleted), then tap Try again.' });
  return true;
}

async function flushProject(): Promise<void> {
  if (!storageOk || !projectId) return;
  if (stateTimer) clearTimeout(stateTimer);
  if (ckptTimer) clearTimeout(ckptTimer);
  stateTimer = ckptTimer = null;
  await call({ type: 'state', json: stateJson(), projectId });
  while (ckptInFlight) await new Promise((r) => setTimeout(r, 5));
  await checkpoint();
}

async function openById(id: string): Promise<void> {
  if (id === projectId) return postProject();
  if (switching || strokeActive) return postProject('Finish the current stroke first.');
  if (diskFull) return postProject('Storage is full: free space so your last change can be saved before switching.');
  if (!storageOk) return postProject('Storage is unavailable here, so projects can’t be opened.');
  const prev = projectId;
  switching = true;
  try {
    await flushProject();
    loading = true;
    const r = await call({ type: 'open', projectId: id });
    const opened = r.ok ? (r.value as OpenResult) : null;
    // persist attaches the new project only after reading all of it: on 'none' the old one is
    // still attached on both sides.
    if (opened?.status !== 'ok') return postProject(`That project could not be opened (${r.ok ? 'missing or damaged files' : r.error}).`);
    let info: RecoveryInfo;
    try {
      info = loadTracked(opened, false);
    } catch (e) {
      // eng_load refuses before replacing the mesh, so the old project is still in memory:
      // reattach it in persist before anything else can be written.
      await call({ type: 'open', projectId: prev });
      return postProject(`That project is damaged (${e}); the current one stays open.`);
    }
    journalBytes = 0;
    setBrush(brush);
    renderer.uploadAll(core);
    requestFrame();
    postStats(true);
    if (info.records > 0 || info.stoppedAt) scheduleCheckpoint();
    if (info.stoppedAt) post({ type: 'status', level: 'warn', text: `${projectName}: recovered to stroke ${info.lastSeq} (${info.stoppedAt}).` });
    postProject();
  } finally {
    loading = false;
    switching = false;
  }
}

/** A new project is a growth-causing edit (PLT-11): refused up front when space is low. */
async function newSphere(n: number): Promise<void> {
  if (switching || strokeActive || editBlocked()) return;
  if (storageOk) {
    const est = await call({ type: 'estimate' });
    const v = est.ok ? (est.value as { usage?: number; quota?: number }) : null;
    if (v?.quota) {
      const free = v.quota - (v.usage ?? 0);
      const need = 12 * (6 * n * n + 2) + 13 * 12 * n * n; // positions + triangles + polygon runs
      if (free - need < LOW_SPACE_BYTES) {
        post({ type: 'refused', text: `Not enough storage for a new project: ${mbs(free)} free and Maquette keeps ${mbs(LOW_SPACE_BYTES)} in reserve. Back up, then purge Recently Deleted or delete projects.` });
        return;
      }
    }
  }
  switching = true;
  try {
    await flushProject();
    loading = true;
    if (await createSphere(n)) {
      brushRestored = false;
      post({ type: 'stats', stats: stats() });
    }
    postProject();
  } finally {
    loading = false;
    switching = false;
  }
}

function diskRefused(seq: number, bytes: ArrayBuffer): void {
  if (!unsaved.some((u) => u.seq === seq)) unsaved.push({ seq, bytes });
  unsaved.sort((a, b) => a.seq - b.seq);
  diskFull = true;
  post({ type: 'disk', full: true, unsaved: unsaved.length });
}

/** 'Try again' after space was freed: resends the refused records in order. */
async function retryUnsaved(): Promise<void> {
  if (retrying) return;
  retrying = true;
  try {
    while (unsaved.length) {
      const r = unsaved[0];
      const t0 = performance.now();
      const res = await call({ type: 'journal', seq: r.seq, bytes: r.bytes, projectId, resume: true });
      if (!res.ok) {
        if (res.code !== 'quota') storageFailed(res.error);
        post({ type: 'disk', full: true, unsaved: unsaved.length });
        return;
      }
      if (unsaved[0] === r) unsaved.shift(); // a checkpoint may have covered it meanwhile
      acked(r.seq, t0);
    }
    diskFull = false;
    post({ type: 'disk', full: false, unsaved: 0 });
  } finally {
    retrying = false;
  }
}

// ---------- messages ----------
let pendingSize: { width: number; height: number; dpr: number } | null = null;

scope.onmessage = async (e: MessageEvent<ToEngine>) => {
  const m = e.data;
  if (m.type === 'init') return init(m);
  if (!core || !renderer) {
    // Still starting: keep the latest size instead of dropping it (a dropped resize = a
    // stretched scene until the next one).
    if (m.type === 'resize') pendingSize = { width: m.width, height: m.height, dpr: m.dpr };
    return;
  }
  switch (m.type) {
    case 'resize':
      resize(m.width, m.height, m.dpr);
      setBrush(brush);
      requestFrame();
      break;
    case 'brush':
      setBrush(m.brush);
      saveStateSoon();
      requestFrame();
      break;
    case 'stroke-begin':
      if (editBlocked()) break;
      commitCamera();
      strokeActive = true;
      core.x.eng_stroke_begin(m.x * dpr, m.y * dpr, m.p);
      requestFrame();
      break;
    case 'stroke-move': {
      if (!strokeActive) break;
      const n = m.samples.length / 3;
      const buf = core.f32s(core.x.eng_samples_ptr(n * 3), n * 3);
      for (let i = 0; i < n; i++) {
        buf[3 * i] = m.samples[3 * i] * dpr;
        buf[3 * i + 1] = m.samples[3 * i + 1] * dpr;
        buf[3 * i + 2] = m.samples[3 * i + 2];
      }
      core.x.eng_stroke_move(n);
      requestFrame();
      break;
    }
    case 'stroke-end': {
      if (!strokeActive) break;
      const len = core.x.eng_stroke_end();
      strokeActive = false;
      journal(len);
      requestFrame();
      break;
    }
    case 'undo':
    case 'redo': {
      if (strokeActive || editBlocked()) break;
      journal(m.type === 'undo' ? core.x.eng_undo() : core.x.eng_redo());
      requestFrame();
      break;
    }
    case 'gesture-begin':
      pivot = hitOrPlane(m.x, m.y);
      break;
    case 'orbit':
      cam.orbit(-m.dx * 0.006, -m.dy * 0.006, pivot);
      saveStateSoon();
      requestFrame();
      break;
    case 'pan':
      cam.pan(m.dx * dpr, m.dy * dpr, cam.depthOf(pivot));
      saveStateSoon();
      requestFrame();
      break;
    case 'zoom':
      cam.zoom(m.factor, hitOrPlane(m.x, m.y));
      saveStateSoon();
      requestFrame();
      break;
    case 'preview-radius':
      previewRadius = m.on;
      requestFrame();
      break;
    case 'frame-view':
    case 'reset-view':
      frameView(m.type === 'reset-view');
      saveStateSoon();
      requestFrame();
      break;
    case 'new-sphere':
      await newSphere(m.n);
      break;
    case 'open-project':
      await openById(m.id);
      break;
    case 'disk-retry':
      await retryUnsaved();
      break;
    // [io] import, units, STL export (IMP-0/1/2, PRJ-9, EXP-2)
    case 'import-mesh':
      if (strokeActive) {
        post({ type: 'import-failed', text: 'Finish the stroke, then import.' });
        break;
      }
      await importMesh(m.name, m.ext, m.bytes);
      break;
    case 'set-units':
      if (!UNITS.includes(m.units)) break;
      units = m.units;
      saveStateNow();
      post({ type: 'units', units });
      break;
    case 'export-stl': {
      const scale = UNIT_TO_MM[units];
      const ip = core.x.mq_alloc(12);
      const len = core.x.eng_export_stl(scale, ip);
      const [tris, boundaryEdges] = core.u32s(ip, 3);
      core.x.mq_free(ip, 12);
      const bytes = core.out(len);
      const date = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      post({ type: 'export-ready', name: `maquette-${date}.stl`, bytes, faces: tris, verts: stats().verts, format: 'stl', mime: 'model/stl', boundaryEdges, units, scale }, [bytes]);
      break;
    }
    case 'export-obj': {
      const fp = core.x.mq_alloc(4);
      const len = core.x.eng_export_obj(fp);
      const faces = core.u32s(fp, 1)[0];
      core.x.mq_free(fp, 4);
      const bytes = core.out(len);
      const verts = stats().verts;
      const date = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      post({ type: 'export-ready', name: `maquette-${date}.obj`, bytes, faces, verts }, [bytes]);
      break;
    }
    case 'hidden':
      void checkpoint();
      if (storageOk) void call({ type: 'session-end' });
      break;
    case 'visible': {
      // WebKit 286707: an OffscreenCanvas can come back blank with no context-loss event.
      renderer.draw(cam, null);
      commitCamera();
      const covered = core.x.eng_raycast(cam.width / 2, cam.height / 2) === 1;
      if (renderer.lost || (covered && renderer.centerIsBlank())) {
        renderer.init();
        renderer.uploadAll(core);
        post({ type: 'status', text: 'Display restored after backgrounding.', level: 'info' });
      }
      // The next heartbeat marks the session open again (session-start would misread this
      // still-running session as a crash).
      requestFrame();
      break;
    }
    case 'debug-trap':
      core.x.eng_debug_trap();
      break;
    case 'query':
      scope.postMessage({ type: 'query-result', hash: core.x.eng_hash().toString(16), stats: stats(), storageOk });
      break;
  }
};
