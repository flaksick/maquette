// The project library, run inside the persist worker (the only code that touches storage):
// gallery operations (PRJ-1), project files in/out (PRJ-5), back up all (PRJ-6), preferences
// (PRJ-11), storage numbers (PLT-4) and the disk-full policy's checks (PLT-11).
//
// Crash-safety argument, per operation (the app can be killed at any instruction):
// - A project exists only if its folder holds a valid manifest (A/B slots, CRC-sealed). Every
//   operation that creates a project (duplicate, import) writes and flushes all of its files
//   first and the manifest LAST: killed before that, the folder is invisible garbage that
//   `maintenance` removes; killed after, the project is complete.
// - Rename, delete (to Recently Deleted) and restore are one manifest write into the other A/B
//   slot: a torn write leaves the previous slot valid, so the project is either in its old state
//   or its new one, never broken.
// - Purge deletes the older manifest slot, then the newer one (from then on the folder is
//   garbage), then the files. Killed after the first step, the project is still in Recently
//   Deleted, never resurrected with stale data.
// - Exports and backups never write to storage: the archive is a Blob assembled from the
//   project files (unchanging until that project is edited again) and small in-memory parts.
// - Preferences are a sealed JSON document in two alternating slots, like the manifest.
import {
  BACKUP_FORMAT,
  BACKUP_JSON,
  CENTRAL_HEADER,
  CRC_START,
  EOCD,
  FORMAT_VERSION,
  LOCAL_HEADER,
  MAX_ZIP,
  PROJECT_FORMAT,
  PROJECT_JSON,
  TOPO_HEADER,
  ZipError,
  centralHeader,
  crc32,
  crcFinish,
  crcUpdate,
  dataOffset,
  displayFileName,
  dosTime,
  endOfCentral,
  findEnd,
  localHeader,
  parseCentral,
  slug,
  topoCounts,
  type BackupJson,
  type ProjectJson,
  type ZipEntry,
} from './container';
import {
  LOW_SPACE_BYTES,
  TRASH_DAYS,
  type ExportedFile,
  type ImportResult,
  type LibraryReply,
  type Prefs,
  type ProjectInfo,
  type StorageNumbers,
  type ToLibrary,
} from '../shared/library';

export interface SyncHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

export interface Manifest {
  schema: 1;
  id: string;
  name: string;
  createdAt: string;
  gen: number;
  checkpointSeq: number;
  journalGen: number;
  /** Set while the project is in Recently Deleted (PRJ-1). */
  deletedAt?: string;
  crc?: number;
}

/** What the library needs from the persist worker (its storage primitives and open project). */
export interface LibraryCtx {
  root(): Promise<FileSystemDirectoryHandle>;
  projectDir(id: string, create?: boolean): Promise<FileSystemDirectoryHandle>;
  openHandle(dir: FileSystemDirectoryHandle, name: string, create?: boolean): Promise<SyncHandle>;
  writeWhole(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<void>;
  loadManifest(dir: FileSystemDirectoryHandle): Promise<Manifest | null>;
  writeManifest(dir: FileSystemDirectoryHandle, m: Manifest): Promise<void>;
  validPrefix(b: Uint8Array): number;
  /** Appends queued journal records (they never wait behind a long library operation). */
  serveJournal(): Promise<void>;
  /** The project the engine has open, if any; its manifest object is the one checkpoints build on. */
  current(): { id: string; manifest: Manifest } | null;
  channel(): string;
}

const CHUNK = 4 * 2 ** 20;
const enc = new TextEncoder();
const dec = new TextDecoder();
const DAY = 864e5;
/** A manifest-less folder this young may be another window's project being written. */
const GARBAGE_MIN_AGE_MS = 10 * 60_000;

class Coded extends Error {
  constructor(
    readonly code: NonNullable<LibraryReply['code']>,
    message: string,
  ) {
    super(message);
  }
}
const invalid = (msg: string) => new Coded('invalid', msg);

export function isQuotaError(e: unknown): boolean {
  return (e as { name?: string })?.name === 'QuotaExceededError' || (e as Coded)?.code === 'quota';
}

// ---------- PLT-11: simulated disk (dev channel only) ----------

/** A test can give the dev build a disk with `allowance` bytes left: growth-causing writes
 *  (journal appends, project copies) spend it and fail with the same QuotaExceededError a full
 *  disk throws, and storage numbers report it. Null = the real disk. */
export const disk = {
  allowance: null as number | null,
  spend(n: number): void {
    if (this.allowance === null) return;
    if (n > this.allowance) throw new DOMException(`The disk is full (simulated: ${this.allowance} bytes left).`, 'QuotaExceededError');
    this.allowance -= n;
  },
};

export async function storageNumbers(): Promise<StorageNumbers> {
  const est = await navigator.storage.estimate();
  let persisted = false;
  try {
    persisted = await navigator.storage.persisted();
  } catch {}
  const usage = est.usage ?? 0;
  if (disk.allowance !== null) return { usage, quota: usage + disk.allowance, persisted, simulated: true };
  return { usage, quota: est.quota ?? 0, persisted, simulated: false };
}

const mb = (n: number) => `${Math.max(0, Math.round(n / 2 ** 20)).toLocaleString('en-US')} MB`;

/** PLT-11: refuses an operation that would leave less than LOW_SPACE_BYTES free. */
async function requireSpace(need: number, what: string): Promise<void> {
  const s = await storageNumbers();
  const free = s.quota - s.usage;
  if (free - need < LOW_SPACE_BYTES) {
    throw new Coded(
      'quota',
      `Not enough storage to ${what}: ${mb(free)} free, it needs ${mb(need)} and Maquette keeps ${mb(LOW_SPACE_BYTES)} in reserve. Back up, then purge Recently Deleted or delete projects.`,
    );
  }
}

// ---------- folder helpers ----------

async function projectsDir(ctx: LibraryCtx): Promise<FileSystemDirectoryHandle> {
  return (await ctx.root()).getDirectoryHandle('projects', { create: true });
}

type Entries = AsyncIterable<[string, FileSystemHandle]>;
const entriesOf = (d: FileSystemDirectoryHandle) => (d as unknown as { entries(): Entries }).entries();

async function filesOf(dir: FileSystemDirectoryHandle): Promise<Map<string, File>> {
  const out = new Map<string, File>();
  for await (const [name, h] of entriesOf(dir)) if (h.kind === 'file') out.set(name, await (h as FileSystemFileHandle).getFile());
  return out;
}

const SEGMENT = /^journal-(\d+)\.bin$/;

/** Live journal segments (at or after the manifest's generation), oldest first. */
function segments(files: Map<string, File>, m: Manifest): { gen: number; file: File }[] {
  const out: { gen: number; file: File }[] = [];
  for (const [name, file] of files) {
    const s = SEGMENT.exec(name);
    if (s && Number(s[1]) >= m.journalGen) out.push({ gen: Number(s[1]), file });
  }
  return out.sort((a, b) => a.gen - b.gen);
}

async function mustManifest(ctx: LibraryCtx, id: string): Promise<{ dir: FileSystemDirectoryHandle; m: Manifest }> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await ctx.projectDir(id);
  } catch {
    throw invalid('That project no longer exists.');
  }
  const m = await ctx.loadManifest(dir);
  if (!m) throw invalid('That project is damaged (no valid manifest).');
  return { dir, m };
}

async function removeDir(ctx: LibraryCtx, id: string): Promise<void> {
  try {
    await (await projectsDir(ctx)).removeEntry(id, { recursive: true });
  } catch {}
}

function cleanName(name: unknown): string {
  return typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}

// ---------- PRJ-1: gallery ----------

async function describe(ctx: LibraryCtx, id: string, dir: FileSystemDirectoryHandle): Promise<ProjectInfo | null> {
  const m = await ctx.loadManifest(dir);
  if (!m) return null;
  const files = await filesOf(dir);
  let bytes = 0;
  let modifiedAt = 0;
  for (const [name, f] of files) {
    bytes += f.size;
    if (name === 'topo.bin' || name === 'positions.bin' || SEGMENT.test(name)) modifiedAt = Math.max(modifiedAt, f.lastModified);
  }
  const topo = files.get('topo.bin');
  const counts = topo ? topoCounts(new Uint8Array(await topo.slice(0, TOPO_HEADER).arrayBuffer())) : null;
  return {
    id,
    name: m.name,
    createdAt: m.createdAt,
    modifiedAt: modifiedAt || Date.parse(m.createdAt) || 0,
    bytes,
    tris: counts?.tris ?? 0,
    verts: counts?.verts ?? 0,
    journalBytes: segments(files, m).reduce((n, s) => n + s.file.size, 0),
    deletedAt: m.deletedAt ?? null,
    current: ctx.current()?.id === id,
  };
}

export async function listProjects(ctx: LibraryCtx): Promise<ProjectInfo[]> {
  const out: ProjectInfo[] = [];
  for await (const [id, h] of entriesOf(await projectsDir(ctx))) {
    if (h.kind !== 'directory') continue;
    const info = await describe(ctx, id, h as FileSystemDirectoryHandle);
    if (info) out.push(info);
  }
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name));
}

/** The project to reopen when the last one is gone or in Recently Deleted. */
export async function newestLive(ctx: LibraryCtx): Promise<string | null> {
  return (await listProjects(ctx)).find((p) => !p.deletedAt)?.id ?? null;
}

async function rename(ctx: LibraryCtx, id: string, name: string): Promise<void> {
  const clean = cleanName(name);
  if (!clean) throw invalid('A project needs a name.');
  const { dir, m } = await mustManifest(ctx, id);
  const next: Manifest = { ...m, name: clean, gen: m.gen + 1 };
  await ctx.writeManifest(dir, next); // the commit: one sealed write into the other slot
  // Checkpoints derive the next manifest from the open project's copy: keep it current, or the
  // next checkpoint would write the old name back.
  const c = ctx.current();
  if (c?.id === id) c.manifest = next;
}

async function setDeleted(ctx: LibraryCtx, id: string, deleted: boolean): Promise<void> {
  if (deleted && ctx.current()?.id === id) throw new Coded('current', 'Open another project before deleting this one.');
  const { dir, m } = await mustManifest(ctx, id);
  const next: Manifest = { ...m, gen: m.gen + 1 };
  if (deleted) next.deletedAt = new Date().toISOString();
  else delete next.deletedAt;
  await ctx.writeManifest(dir, next);
}

async function purge(ctx: LibraryCtx, id: string): Promise<void> {
  const { dir, m } = await mustManifest(ctx, id);
  if (!m.deletedAt) throw invalid('Only projects in Recently Deleted can be deleted for good.');
  if (ctx.current()?.id === id) throw new Coded('current', 'That project is open.');
  // Older slot first (whatever it holds), then the newest valid one: no instant at which an
  // older, not-deleted manifest is the only valid one left.
  const slot = (gen: number) => (gen % 2 === 0 ? 'manifest-a.json' : 'manifest-b.json');
  for (const name of [slot(m.gen + 1), slot(m.gen)]) {
    try {
      await dir.removeEntry(name);
    } catch {}
  }
  await removeDir(ctx, id);
}

/** Copies one file in 4 MB chunks (journal appends are served between chunks). */
async function copyFile(ctx: LibraryCtx, from: File, dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  const size = from.size; // appends after this point are not part of the copy
  const h = await ctx.openHandle(dir, name, true);
  try {
    h.truncate(0);
    for (let at = 0; at < size; at += CHUNK) {
      const part = new Uint8Array(await from.slice(at, Math.min(size, at + CHUNK)).arrayBuffer());
      disk.spend(part.length);
      h.write(part, { at });
      await ctx.serveJournal();
    }
    h.flush();
  } finally {
    h.close();
  }
}

async function duplicate(ctx: LibraryCtx, id: string): Promise<ProjectInfo> {
  const { dir, m } = await mustManifest(ctx, id);
  if (m.deletedAt) throw invalid('Restore the project before duplicating it.');
  const files = await filesOf(dir);
  const topo = files.get('topo.bin');
  const positions = files.get('positions.bin');
  if (!topo || !positions) throw invalid('That project is damaged (mesh files missing).');
  const segs = segments(files, m);
  const state = files.get('state.json');
  await requireSpace([topo, positions, state, ...segs.map((s) => s.file)].reduce((n, f) => n + (f?.size ?? 0), 0), 'duplicate this project');
  const newId = crypto.randomUUID();
  const dst = await ctx.projectDir(newId, true);
  try {
    // The copy recovers exactly like the source: same positions, same live journal segments
    // (same generations), so the same records replay. No checkpoint can run during this
    // operation (the persist queue is serial); appends only add bytes past each size read.
    await copyFile(ctx, topo, dst, 'topo.bin');
    await copyFile(ctx, positions, dst, 'positions.bin');
    for (const s of segs) await copyFile(ctx, s.file, dst, `journal-${s.gen}.bin`);
    if (!segs.length) await ctx.writeWhole(dst, `journal-${m.journalGen}.bin`, new Uint8Array(0));
    if (state) await copyFile(ctx, state, dst, 'state.json');
    const name = cleanName(`${m.name} copy`);
    await ctx.writeManifest(dst, { schema: 1, id: newId, name, createdAt: new Date().toISOString(), gen: 1, checkpointSeq: m.checkpointSeq, journalGen: m.journalGen });
  } catch (e) {
    await removeDir(ctx, newId);
    throw e;
  }
  return (await describe(ctx, newId, dst))!;
}

// ---------- PRJ-5 / PRJ-6: archives ----------

/** A STORE-only ZIP assembled as a Blob: the CRC of each entry is computed before its header is
 *  emitted, so nothing is patched and nothing is written to storage. File parts are not copied
 *  into memory: the Blob refers to the project files. */
class ZipBlob {
  private parts: BlobPart[] = [];
  private at = 0;
  private entries: ZipEntry[] = [];
  private t = dosTime(new Date());
  constructor(private ctx: LibraryCtx) {}

  async add(name: string, data: File | Uint8Array): Promise<{ bytes: number; crc32: number }> {
    let c = CRC_START;
    let size: number;
    if (data instanceof Uint8Array) {
      size = data.length;
      c = crcUpdate(c, data);
    } else {
      size = data.size;
      for (let at = 0; at < size; at += CHUNK) {
        c = crcUpdate(c, new Uint8Array(await data.slice(at, Math.min(size, at + CHUNK)).arrayBuffer()));
        await this.ctx.serveJournal();
      }
    }
    const crc = crcFinish(c);
    const header = localHeader(enc.encode(name), crc, size, this.t);
    if (this.at + header.length + size > MAX_ZIP || this.entries.length >= 0xffff) {
      throw invalid('This archive would be larger than 4 GB, the limit of this format. Export projects one at a time.');
    }
    this.entries.push({ name, crc, size, offset: this.at });
    this.parts.push(header, data as BlobPart);
    this.at += header.length + size;
    return { bytes: size, crc32: crc };
  }

  finish(type: string): Blob {
    const cdOffset = this.at;
    let cdSize = 0;
    for (const e of this.entries) {
      const h = centralHeader(e, this.t);
      this.parts.push(h);
      cdSize += h.length;
    }
    if (cdOffset + cdSize + EOCD > MAX_ZIP) throw invalid('This archive would be larger than 4 GB.');
    this.parts.push(endOfCentral(this.entries.length, cdSize, cdOffset));
    return new Blob(this.parts, { type });
  }
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Adds one project's files under `prefix`. The open project's positions are copied into memory
 *  (a later checkpoint rewrites that file in place); other projects' files are referenced. */
async function addProject(ctx: LibraryCtx, zip: ZipBlob, id: string, prefix: string): Promise<{ name: string; tris: number }> {
  const { dir, m } = await mustManifest(ctx, id);
  const files = await filesOf(dir);
  const topo = files.get('topo.bin');
  const positionsFile = files.get('positions.bin');
  if (!topo || !positionsFile) throw invalid(`“${m.name}” is damaged (mesh files missing).`);
  const counts = topoCounts(new Uint8Array(await topo.slice(0, TOPO_HEADER).arrayBuffer()));
  if (!counts || positionsFile.size !== counts.verts * 12) throw invalid(`“${m.name}” is damaged (mesh files disagree).`);
  const isOpen = ctx.current()?.id === id;
  const positions = isOpen ? new Uint8Array(await positionsFile.arrayBuffer()) : positionsFile;
  // Records not yet folded into positions.bin: the intact prefix of each live segment, in order,
  // stopping at the first damaged record (the same rule recovery uses).
  const parts: Uint8Array[] = [];
  for (const s of segments(files, m)) {
    const b = new Uint8Array(await s.file.arrayBuffer());
    const ok = ctx.validPrefix(b);
    parts.push(b.subarray(0, ok));
    if (ok < b.length) break;
  }
  const journal = concat(parts);
  const state = files.get('state.json');
  const out: ProjectJson['files'] = {};
  out['topo.bin'] = await zip.add(prefix + 'topo.bin', topo);
  out['positions.bin'] = await zip.add(prefix + 'positions.bin', positions);
  if (journal.length) out['journal.bin'] = await zip.add(prefix + 'journal.bin', journal);
  if (state && state.size) out['state.json'] = await zip.add(prefix + 'state.json', new Uint8Array(await state.arrayBuffer()));
  const meta: ProjectJson = {
    format: PROJECT_FORMAT,
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    project: { name: m.name, createdAt: m.createdAt, checkpointSeq: m.checkpointSeq, sourceId: m.id },
    mesh: counts,
    files: out,
  };
  await zip.add(prefix + PROJECT_JSON, enc.encode(JSON.stringify(meta, null, 1)));
  return { name: m.name, tris: counts.tris };
}

async function exportProject(ctx: LibraryCtx, id: string): Promise<ExportedFile> {
  const zip = new ZipBlob(ctx);
  const p = await addProject(ctx, zip, id, '');
  const blob = zip.finish('application/octet-stream');
  return { file: new File([blob], `${displayFileName(p.name)}.maquette`, { type: 'application/octet-stream' }), name: `${displayFileName(p.name)}.maquette`, bytes: blob.size, projects: 1 };
}

async function backupAll(ctx: LibraryCtx): Promise<ExportedFile> {
  const live = (await listProjects(ctx)).filter((p) => !p.deletedAt);
  if (!live.length) throw invalid('There are no projects to back up.');
  const zip = new ZipBlob(ctx);
  const projects: BackupJson['projects'] = [];
  for (const [i, p] of live.entries()) {
    const folder = `${String(i + 1).padStart(2, '0')}-${slug(p.name)}`;
    const r = await addProject(ctx, zip, p.id, `${folder}/`);
    projects.push({ folder, name: r.name, tris: r.tris });
  }
  const index: BackupJson = { format: BACKUP_FORMAT, formatVersion: FORMAT_VERSION, exportedAt: new Date().toISOString(), projects };
  await zip.add(BACKUP_JSON, enc.encode(JSON.stringify(index, null, 1)));
  const blob = zip.finish('application/zip');
  const name = `Maquette backup ${new Date().toISOString().slice(0, 10)}.zip`;
  return { file: new File([blob], name, { type: 'application/zip' }), name, bytes: blob.size, projects: projects.length };
}

// ---------- PRJ-5 / PRJ-6: import ----------

async function readRange(file: Blob, at: number, len: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(at, at + len).arrayBuffer());
}

async function entryBytes(file: Blob, e: ZipEntry): Promise<Uint8Array> {
  const at = dataOffset(await readRange(file, e.offset, LOCAL_HEADER), e);
  const b = await readRange(file, at, e.size);
  if (b.length !== e.size || crc32(b) !== e.crc) throw new ZipError(`${e.name} is damaged (checksum mismatch)`);
  return b;
}

/** Streams one entry into a project file, checking its CRC; throws (before the project's
 *  manifest exists) if the bytes don't match. */
async function copyEntry(ctx: LibraryCtx, file: Blob, e: ZipEntry, dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  const start = dataOffset(await readRange(file, e.offset, LOCAL_HEADER), e);
  if (start + e.size > file.size) throw new ZipError(`${e.name} is truncated`);
  const h = await ctx.openHandle(dir, name, true);
  let c = CRC_START;
  try {
    h.truncate(0);
    for (let at = 0; at < e.size; at += CHUNK) {
      const part = await readRange(file, start + at, Math.min(CHUNK, e.size - at));
      c = crcUpdate(c, part);
      disk.spend(part.length);
      h.write(part, { at });
      await ctx.serveJournal();
    }
    h.flush();
  } finally {
    h.close();
  }
  if (crcFinish(c) !== e.crc) throw new ZipError(`${e.name} is damaged (checksum mismatch)`);
}

async function importOne(ctx: LibraryCtx, file: Blob, byName: Map<string, ZipEntry>, prefix: string): Promise<{ id: string; name: string; tris: number }> {
  let meta: ProjectJson;
  try {
    meta = JSON.parse(dec.decode(await entryBytes(file, byName.get(prefix + PROJECT_JSON)!))) as ProjectJson;
  } catch (e) {
    throw invalid(`${prefix || 'the file'}: ${e instanceof ZipError ? e.message : 'unreadable maquette.json'}`);
  }
  if (meta.format !== PROJECT_FORMAT) throw invalid('This is not a Maquette project.');
  if (!(meta.formatVersion <= FORMAT_VERSION)) throw invalid('This project was made by a newer version of Maquette. Update Maquette, then import it again.');
  const topo = byName.get(prefix + 'topo.bin');
  const positions = byName.get(prefix + 'positions.bin');
  if (!topo || !positions) throw invalid('The project file is incomplete (mesh files missing).');
  for (const e of [topo, positions, byName.get(prefix + 'journal.bin'), byName.get(prefix + 'state.json')]) {
    const listed = e && meta.files?.[e.name.slice(prefix.length)];
    if (e && listed && (listed.crc32 !== e.crc || listed.bytes !== e.size)) throw invalid(`${e.name} doesn't match maquette.json.`);
  }
  const head = await readRange(file, dataOffset(await readRange(file, topo.offset, LOCAL_HEADER), topo), Math.min(TOPO_HEADER, topo.size));
  const counts = topoCounts(head);
  if (!counts || positions.size !== counts.verts * 12) throw invalid('The project file is damaged (mesh files disagree).');
  const id = crypto.randomUUID();
  const dir = await ctx.projectDir(id, true);
  const name = cleanName(meta.project?.name) || 'Imported sculpt';
  try {
    await copyEntry(ctx, file, topo, dir, 'topo.bin');
    await copyEntry(ctx, file, positions, dir, 'positions.bin');
    const journal = byName.get(prefix + 'journal.bin');
    // The records replay on open exactly as they did in the exporting project (same order).
    if (journal) await copyEntry(ctx, file, journal, dir, 'journal-1.bin');
    else await ctx.writeWhole(dir, 'journal-1.bin', new Uint8Array(0));
    const state = byName.get(prefix + 'state.json');
    if (state) await copyEntry(ctx, file, state, dir, 'state.json');
    const createdAt = typeof meta.project?.createdAt === 'string' && !Number.isNaN(Date.parse(meta.project.createdAt)) ? meta.project.createdAt : new Date().toISOString();
    const checkpointSeq = Number.isInteger(meta.project?.checkpointSeq) && meta.project.checkpointSeq >= 0 ? meta.project.checkpointSeq : 0;
    // The commit point: until this manifest exists, the folder is invisible garbage.
    await ctx.writeManifest(dir, { schema: 1, id, name, createdAt, gen: 1, checkpointSeq, journalGen: 1 });
  } catch (e) {
    await removeDir(ctx, id);
    throw e;
  }
  return { id, name, tris: counts.tris };
}

async function importFile(ctx: LibraryCtx, file: Blob): Promise<ImportResult & { failed: { folder: string; error: string }[] }> {
  let entries: ZipEntry[];
  try {
    if (file.size < EOCD) throw new ZipError('too small');
    const tail = await readRange(file, Math.max(0, file.size - (EOCD + 0xffff)), Math.min(file.size, EOCD + 0xffff));
    const end = findEnd(tail, file.size);
    if (end.cdSize < end.count * CENTRAL_HEADER) throw new ZipError('damaged central directory');
    entries = parseCentral(await readRange(file, end.cdOffset, end.cdSize), end.count);
  } catch (e) {
    throw invalid(`This file is not a Maquette project or backup (${e instanceof ZipError ? e.message : 'unreadable'}).`);
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  // A project at the root (.maquette) or one per top-level folder (backup).
  const prefixes = entries.filter((e) => e.name === PROJECT_JSON || /^[^/]+\/maquette\.json$/.test(e.name)).map((e) => e.name.slice(0, -PROJECT_JSON.length));
  if (!prefixes.length) throw invalid('This file is not a Maquette project or backup.');
  const need = entries.filter((e) => prefixes.some((p) => e.name.startsWith(p))).reduce((n, e) => n + e.size, 0);
  await requireSpace(need, prefixes.length > 1 ? `import ${prefixes.length} projects` : 'import this project');
  const projects: ImportResult['projects'] = [];
  const failed: { folder: string; error: string }[] = [];
  for (const prefix of prefixes) {
    try {
      projects.push(await importOne(ctx, file, byName, prefix));
    } catch (e) {
      if (isQuotaError(e)) throw e instanceof Coded ? e : new Coded('quota', `Storage filled up during the import; ${projects.length} of ${prefixes.length} projects were imported.`);
      failed.push({ folder: prefix || '(root)', error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (!projects.length) throw invalid(failed[0]?.error ?? 'Nothing could be imported.');
  return { projects, failed };
}

// ---------- PRJ-11: preferences (sealed A/B document) ----------

const PREF_SLOTS = ['prefs-a.json', 'prefs-b.json'];
let prefsGen = 0;

function sealDoc(gen: number, body: unknown): Uint8Array {
  const inner = JSON.stringify({ gen, body });
  return enc.encode(JSON.stringify({ gen, body, crc: crc32(enc.encode(inner)) }));
}

async function readDoc(dir: FileSystemDirectoryHandle, name: string): Promise<{ gen: number; body: unknown } | null> {
  try {
    const text = await (await (await dir.getFileHandle(name)).getFile()).text();
    const d = JSON.parse(text) as { gen: number; body: unknown; crc: number };
    if (typeof d.gen !== 'number' || crc32(enc.encode(JSON.stringify({ gen: d.gen, body: d.body }))) !== d.crc) return null;
    return { gen: d.gen, body: d.body };
  } catch {
    return null;
  }
}

async function getPrefs(ctx: LibraryCtx): Promise<Partial<Prefs> | null> {
  const r = await ctx.root();
  const docs = (await Promise.all(PREF_SLOTS.map((n) => readDoc(r, n)))).filter((d): d is { gen: number; body: unknown } => !!d);
  docs.sort((a, b) => b.gen - a.gen);
  prefsGen = docs[0]?.gen ?? 0;
  return (docs[0]?.body as Partial<Prefs>) ?? null;
}

async function setPrefs(ctx: LibraryCtx, prefs: Prefs): Promise<void> {
  const gen = prefsGen + 1;
  await ctx.writeWhole(await ctx.root(), PREF_SLOTS[gen % 2], sealDoc(gen, prefs));
  prefsGen = gen;
}

// ---------- maintenance (once per session, after the engine is up) ----------

/** Purges Recently Deleted projects older than 30 days and removes folders that never got a
 *  manifest (an interrupted create, duplicate, import or purge). Returns what it did. */
async function maintenance(ctx: LibraryCtx): Promise<{ purged: number; garbage: number; garbageBytes: number }> {
  const projects = await projectsDir(ctx);
  let purged = 0;
  let garbage = 0;
  let garbageBytes = 0;
  const now = Date.now();
  const ids: [string, FileSystemDirectoryHandle][] = [];
  for await (const [id, h] of entriesOf(projects)) if (h.kind === 'directory') ids.push([id, h as FileSystemDirectoryHandle]);
  for (const [id, dir] of ids) {
    if (ctx.current()?.id === id) continue;
    const m = await ctx.loadManifest(dir);
    if (m) {
      if (m.deletedAt && now - Date.parse(m.deletedAt) > TRASH_DAYS * DAY) {
        await purge(ctx, id);
        purged++;
      }
      continue;
    }
    const files = await filesOf(dir);
    const newest = Math.max(0, ...[...files.values()].map((f) => f.lastModified));
    if (now - newest < GARBAGE_MIN_AGE_MS) continue;
    garbageBytes += [...files.values()].reduce((n, f) => n + f.size, 0);
    await removeDir(ctx, id);
    garbage++;
  }
  return { purged, garbage, garbageBytes };
}

// ---------- dispatch ----------

export async function handleLibrary(ctx: LibraryCtx, m: ToLibrary, reply: (r: LibraryReply, t?: Transferable[]) => void): Promise<void> {
  try {
    let value: unknown;
    switch (m.op) {
      case 'list':
        value = await listProjects(ctx);
        break;
      case 'rename':
        await rename(ctx, m.projectId, m.name);
        break;
      case 'duplicate':
        value = await duplicate(ctx, m.projectId);
        break;
      case 'trash':
        await setDeleted(ctx, m.projectId, true);
        break;
      case 'restore':
        await setDeleted(ctx, m.projectId, false);
        break;
      case 'purge':
        await purge(ctx, m.projectId);
        break;
      case 'export':
        value = await exportProject(ctx, m.projectId);
        break;
      case 'backup':
        value = await backupAll(ctx);
        break;
      case 'import':
        value = await importFile(ctx, m.file);
        break;
      case 'prefs-get':
        value = await getPrefs(ctx);
        break;
      case 'prefs-set':
        await setPrefs(ctx, m.prefs);
        break;
      case 'storage':
        value = await storageNumbers();
        break;
      case 'maintenance':
        value = await maintenance(ctx);
        break;
      case 'debug-disk':
        if (ctx.channel() !== 'dev') throw invalid('debug hooks exist only in the dev channel');
        disk.allowance = m.allowance;
        break;
    }
    reply({ id: m.id, ok: true, value });
  } catch (e) {
    reply({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e), code: e instanceof Coded ? e.code : isQuotaError(e) ? 'quota' : undefined });
  }
}
