// Persist worker: the only code that touches storage (OPFS, sync access handles only).
//
// Project directory: manifest-a.json / manifest-b.json (A/B slots, highest valid gen wins),
// topo.bin (static), positions.bin (rewritten in place by checkpoints), journal-<gen>.bin
// (append-only records), state.json (camera + tool state, PRJ-10).
//
// Crash safety (invariant 4): a journal record is acknowledged only after its flush returns.
// A checkpoint first rotates to a new journal segment, then writes the dirty position ranges
// in 4 MB chunks (journal appends are served between chunks: they go to the new segment), then
// flips the manifest slot, then deletes the old segment. Recovery replays every segment at or
// after the manifest's journalGen; records are absolute leaf states, so replay is idempotent.
import { STORAGE_ROOT, type OpenResult, type PersistReply, type ToPersist } from '../shared/protocol';
import { positionsFileOf, replaceMesh, topoFileOf } from './replace';

interface SyncHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}
type FileHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> };

interface Manifest {
  schema: 1;
  id: string;
  name: string;
  createdAt: string;
  gen: number;
  checkpointSeq: number;
  journalGen: number;
  /** Data file names (TOP-1 replace-mesh); absent = topo.bin / positions.bin. */
  topoFile?: string;
  positionsFile?: string;
  crc?: number;
}

const CHUNK = 4 * 1024 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();
let channel = 'dev';
let port: MessagePort | null = null;

// ---------- small helpers ----------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function root(): Promise<FileSystemDirectoryHandle> {
  const r = await navigator.storage.getDirectory();
  return r.getDirectoryHandle(STORAGE_ROOT(channel), { create: true });
}

async function projectDir(id: string, create = false): Promise<FileSystemDirectoryHandle> {
  const projects = await (await root()).getDirectoryHandle('projects', { create: true });
  return projects.getDirectoryHandle(id, { create });
}

async function openHandle(dir: FileSystemDirectoryHandle, name: string, create = true): Promise<SyncHandle> {
  const fh = (await dir.getFileHandle(name, { create })) as FileHandle;
  return fh.createSyncAccessHandle();
}

async function readFile(dir: FileSystemDirectoryHandle, name: string): Promise<ArrayBuffer | null> {
  try {
    return await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer();
  } catch {
    return null;
  }
}

/** Whole-file replace through a sync handle, flushed before returning. */
async function writeWhole(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<void> {
  const h = await openHandle(dir, name);
  try {
    h.truncate(0);
    h.write(bytes, { at: 0 });
    h.flush();
  } finally {
    h.close();
  }
}

async function readJson<T>(dir: FileSystemDirectoryHandle, name: string): Promise<T | null> {
  const b = await readFile(dir, name);
  if (!b || b.byteLength === 0) return null;
  try {
    return JSON.parse(dec.decode(b)) as T;
  } catch {
    return null;
  }
}

const RECORD_MAGIC = 0x324a514d; // "MQJ2", core/src/history.rs
const RECORD_HEADER = 24;

/** Length of the leading run of intact records (magic, length and CRC all check out). */
function validPrefix(b: Uint8Array): number {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 0;
  while (at + RECORD_HEADER <= b.length) {
    if (dv.getUint32(at, true) !== RECORD_MAGIC) break;
    const len = dv.getUint32(at + 16, true);
    const end = at + RECORD_HEADER + len;
    if (end > b.length) break;
    if (crc32(b.subarray(at + RECORD_HEADER, end)) !== dv.getUint32(at + 20, true)) break;
    at = end;
  }
  return at;
}

function sealManifest(m: Manifest): Uint8Array {
  const { crc: _drop, ...rest } = m;
  void _drop;
  const body = JSON.stringify(rest);
  return enc.encode(JSON.stringify({ ...rest, crc: crc32(enc.encode(body)) }));
}

function validManifest(m: Manifest | null): m is Manifest {
  if (!m || typeof m.gen !== 'number' || typeof m.crc !== 'number') return false;
  const { crc, ...rest } = m;
  return crc32(enc.encode(JSON.stringify(rest))) === crc;
}

async function loadManifest(dir: FileSystemDirectoryHandle): Promise<Manifest | null> {
  const a = await readJson<Manifest>(dir, 'manifest-a.json');
  const b = await readJson<Manifest>(dir, 'manifest-b.json');
  const ok = [a, b].filter(validManifest) as Manifest[];
  ok.sort((x, y) => y.gen - x.gen);
  return ok[0] ?? null;
}

async function writeManifest(dir: FileSystemDirectoryHandle, m: Manifest): Promise<void> {
  // Alternate slots, so a torn write can only ever damage the copy being replaced.
  await writeWhole(dir, m.gen % 2 === 0 ? 'manifest-a.json' : 'manifest-b.json', sealManifest(m));
}

// ---------- open project state ----------

interface Open {
  id: string;
  dir: FileSystemDirectoryHandle;
  manifest: Manifest;
  /** Segment new records are appended to (>= manifest.journalGen after a crash mid-checkpoint). */
  appendGen: number;
  journal: SyncHandle;
  journalOffset: number;
  positions: SyncHandle;
}
let cur: Open | null = null;

async function closeCurrent(): Promise<void> {
  if (!cur) return;
  try {
    cur.journal.close();
  } catch {}
  try {
    cur.positions.close();
  } catch {}
  cur = null;
}

async function attach(id: string, dir: FileSystemDirectoryHandle, manifest: Manifest, appendGen: number): Promise<void> {
  await closeCurrent();
  const journal = await openHandle(dir, `journal-${appendGen}.bin`);
  const positions = await openHandle(dir, positionsFileOf(manifest));
  cur = { id, dir, manifest, appendGen, journal, journalOffset: journal.getSize(), positions };
  await writeWhole(await root(), 'index.json', enc.encode(JSON.stringify({ lastProject: id })));
}

async function openLast(): Promise<OpenResult> {
  const idx = await readJson<{ lastProject?: string }>(await root(), 'index.json');
  if (!idx?.lastProject) return { status: 'none' };
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await projectDir(idx.lastProject);
  } catch {
    return { status: 'none' };
  }
  const manifest = await loadManifest(dir);
  if (!manifest) return { status: 'none' };
  const topo = await readFile(dir, topoFileOf(manifest));
  const positions = await readFile(dir, positionsFileOf(manifest));
  if (!topo || !positions) return { status: 'none' };
  // Every journal segment at or after the manifest's generation, in order.
  const segs: number[] = [];
  for await (const [name] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    const m = /^journal-(\d+)\.bin$/.exec(name);
    if (m && Number(m[1]) >= manifest.journalGen) segs.push(Number(m[1]));
  }
  segs.sort((a, b) => a - b);
  const parts: Uint8Array[] = [];
  const newest = segs.length ? segs[segs.length - 1] : manifest.journalGen;
  for (const g of segs) {
    const b = await readFile(dir, `journal-${g}.bin`);
    if (!b || !b.byteLength) continue;
    const bytes = new Uint8Array(b);
    const ok = validPrefix(bytes);
    if (ok < bytes.length && g === newest) {
      // Torn tail from a crash mid-append: cut it, so new records never sit behind garbage.
      const h = await openHandle(dir, `journal-${g}.bin`);
      h.truncate(ok);
      h.flush();
      h.close();
    }
    parts.push(bytes.subarray(0, ok));
    if (ok < bytes.length) break; // replay stops at the first damaged record, like the engine
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const journal = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    journal.set(p, at);
    at += p.length;
  }
  // Append after the newest segment. The manifest is NOT changed here: segments from a
  // checkpoint that never finished still hold records the positions file may not contain;
  // they stay until the next checkpoint completes.
  await attach(idx.lastProject, dir, manifest, newest);
  const stateBytes = await readFile(dir, 'state.json');
  return {
    status: 'ok',
    projectId: idx.lastProject,
    name: manifest.name,
    topo,
    positions,
    journal: journal.buffer,
    checkpointSeq: manifest.checkpointSeq,
    state: stateBytes ? dec.decode(stateBytes) : null,
  };
}

async function create(id: string, name: string, topo: ArrayBuffer, positions: ArrayBuffer): Promise<void> {
  await closeCurrent();
  const dir = await projectDir(id, true);
  await writeWhole(dir, 'topo.bin', new Uint8Array(topo));
  await writeWhole(dir, 'positions.bin', new Uint8Array(positions));
  await writeWhole(dir, 'journal-1.bin', new Uint8Array(0));
  const manifest: Manifest = { schema: 1, id, name, createdAt: new Date().toISOString(), gen: 1, checkpointSeq: 0, journalGen: 1 };
  await writeManifest(dir, manifest);
  await attach(id, dir, manifest, 1);
  try {
    await navigator.storage.persist();
  } catch {}
}

function appendJournal(bytes: ArrayBuffer): void {
  if (!cur) throw new Error('no open project');
  const b = new Uint8Array(bytes);
  cur.journal.write(b, { at: cur.journalOffset });
  cur.journal.flush();
  cur.journalOffset += b.length;
}

async function checkpoint(seq: number, ranges: Uint32Array, data: ArrayBuffer): Promise<void> {
  if (!cur) throw new Error('no open project');
  const c = cur;
  // 1. Rotate: records after this point belong to the next segment.
  const newGen = c.appendGen + 1;
  const oldJournal = c.journal;
  c.journal = await openHandle(c.dir, `journal-${newGen}.bin`);
  c.journal.truncate(0);
  c.journalOffset = 0;
  c.appendGen = newGen;
  // 2. Dirty ranges in <= 4 MB chunks, serving journal appends in between.
  const bytes = new Uint8Array(data);
  let src = 0;
  for (let i = 0; i < ranges.length; i += 2) {
    const fileOffset = ranges[i];
    const len = ranges[i + 1];
    for (let done = 0; done < len; done += CHUNK) {
      const n = Math.min(CHUNK, len - done);
      c.positions.write(bytes.subarray(src + done, src + done + n), { at: fileOffset + done });
      await serveJournal();
    }
    src += len;
  }
  c.positions.flush();
  // 3. Flip the manifest. 4. Drop every older segment (all their records are <= seq).
  const next: Manifest = { ...c.manifest, gen: c.manifest.gen + 1, checkpointSeq: seq, journalGen: newGen };
  await writeManifest(c.dir, next);
  c.manifest = next;
  oldJournal.close();
  const stale: string[] = [];
  for await (const [name] of (c.dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    const m = /^journal-(\d+)\.bin$/.exec(name);
    if (m && Number(m[1]) < newGen) stale.push(name);
  }
  for (const name of stale) {
    try {
      await c.dir.removeEntry(name);
    } catch {}
  }
}

// ---------- session + crash log (PLT-12) ----------

interface Session {
  open: boolean;
  start: string;
  beat: string;
  highWaterMB: number;
  seq: number;
}

async function sessionStart(): Promise<{ uncleanExit: boolean; previous: Session | null }> {
  const r = await root();
  const prev = await readJson<Session>(r, 'session.json');
  const unclean = !!prev?.open;
  if (unclean) {
    const log = (await readJson<{ entries: unknown[] }>(r, 'crashlog.json')) ?? { entries: [] };
    log.entries.push({ t: prev!.beat, kind: 'unclean-exit', highWaterMB: prev!.highWaterMB, lastSeq: prev!.seq, sessionStart: prev!.start });
    log.entries = log.entries.slice(-50);
    await writeWhole(r, 'crashlog.json', enc.encode(JSON.stringify(log)));
  }
  const now = new Date().toISOString();
  await writeWhole(r, 'session.json', enc.encode(JSON.stringify({ open: true, start: now, beat: now, highWaterMB: 0, seq: 0 })));
  return { uncleanExit: unclean, previous: prev };
}

async function sessionBeat(highWaterMB: number, seq: number): Promise<void> {
  const r = await root();
  const s = (await readJson<Session>(r, 'session.json')) ?? { open: true, start: new Date().toISOString(), beat: '', highWaterMB: 0, seq: 0 };
  await writeWhole(r, 'session.json', enc.encode(JSON.stringify({ ...s, open: true, beat: new Date().toISOString(), highWaterMB: Math.max(s.highWaterMB, highWaterMB), seq })));
}

async function sessionEnd(): Promise<void> {
  const r = await root();
  const s = await readJson<Session>(r, 'session.json');
  if (s) await writeWhole(r, 'session.json', enc.encode(JSON.stringify({ ...s, open: false })));
}

// ---------- message pump: journal first ----------

const journalQ: ToPersist[] = [];
const otherQ: ToPersist[] = [];
let running = false;

function reply(r: PersistReply, transfer: Transferable[] = []): void {
  port?.postMessage(r, transfer);
}

async function handle(m: ToPersist): Promise<void> {
  try {
    switch (m.type) {
      case 'journal': {
        const t = performance.now();
        appendJournal(m.bytes);
        reply({ id: m.id, ok: true, value: { seq: m.seq, ms: performance.now() - t } });
        break;
      }
      case 'open-last': {
        const r = await openLast();
        const transfer = [r.topo, r.positions, r.journal].filter((x): x is ArrayBuffer => !!x);
        reply({ id: m.id, ok: true, value: r }, transfer);
        break;
      }
      case 'create':
        await create(m.projectId, m.name, m.topo, m.positions);
        reply({ id: m.id, ok: true });
        break;
      case 'checkpoint':
        await checkpoint(m.seq, m.ranges, m.data);
        reply({ id: m.id, ok: true, value: { seq: m.seq } });
        break;
      case 'state':
        if (cur) await writeWhole(cur.dir, 'state.json', enc.encode(m.json));
        reply({ id: m.id, ok: true });
        break;
      case 'session-start':
        reply({ id: m.id, ok: true, value: await sessionStart() });
        break;
      case 'session-beat':
        await sessionBeat(m.highWaterMB, m.seq);
        reply({ id: m.id, ok: true });
        break;
      case 'session-end':
        await sessionEnd();
        reply({ id: m.id, ok: true });
        break;
      case 'replace-mesh':
        if (!cur) throw new Error('no open project');
        await replaceMesh(cur, { writeWhole, openHandle, writeManifest }, m.topo, m.positions, m.seq);
        reply({ id: m.id, ok: true, value: { seq: m.seq } });
        break;
      case 'estimate': {
        const est = await navigator.storage.estimate();
        const persisted = await navigator.storage.persisted();
        reply({ id: m.id, ok: true, value: { usage: est.usage, quota: est.quota, persisted } });
        break;
      }
    }
  } catch (e) {
    reply({ id: m.id, ok: false, error: String(e) });
  }
}

async function serveJournal(): Promise<void> {
  while (journalQ.length) await handle(journalQ.shift()!);
  await new Promise((r) => setTimeout(r, 0)); // let queued journal messages arrive
  while (journalQ.length) await handle(journalQ.shift()!);
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (journalQ.length || otherQ.length) {
      const m = journalQ.length ? journalQ.shift()! : otherQ.shift()!;
      await handle(m);
    }
  } finally {
    running = false;
  }
}

self.onmessage = (e: MessageEvent<{ type: 'connect'; port: MessagePort; channel: string }>) => {
  if (e.data.type !== 'connect') return;
  channel = e.data.channel;
  port = e.data.port;
  port.onmessage = (ev: MessageEvent<ToPersist>) => {
    // replace-mesh rides the journal queue: records after it belong to the new topology.
    (ev.data.type === 'journal' || ev.data.type === 'replace-mesh' ? journalQ : otherQ).push(ev.data);
    void pump();
  };
};
