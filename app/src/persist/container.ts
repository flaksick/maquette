// Project files (PRJ-5) and backups (PRJ-6) are STORE-only ZIP archives.
//
// Why ZIP: any unzip tool opens one, so a user (or a future Maquette) can always get the data
// out; stored entries need no compression code; and every entry carries its own CRC-32, checked
// on import before anything is committed.
//
// A project file (`<name>.maquette`) holds, at its root:
//   topo.bin        topology + BVH partition, exactly as on disk (core/src/store.rs; own CRC)
//   positions.bin   f32 xyz per vertex in leaf order, exactly as on disk
//   journal.bin     only if the project had records not yet folded into positions.bin: the
//                   intact records of every live journal segment, in order (core/src/history.rs)
//   state.json      only if saved: camera and tool state (PRJ-10)
//   maquette.json   written last: { format: 'maquette-project', formatVersion: 1, project: {...},
//                   mesh: { verts, tris }, files: { <name>: { bytes, crc32 } } }
// A backup (`Maquette backup <date>.zip`) holds one folder per project with the same files, and
// `maquette-backup.json` ({ format: 'maquette-backup', formatVersion: 1, projects: [...] }).
//
// Limits (checked, never silently exceeded): STORE only, no encryption, no ZIP64, so every entry
// and the whole archive stay under 4 GiB; at most 65,535 entries. Names are UTF-8.
//
// This module is pure (no storage access): byte layouts, CRC-32 and directory parsing, shared by
// the persist worker and the Node tests.

export const PROJECT_JSON = 'maquette.json';
export const BACKUP_JSON = 'maquette-backup.json';
export const PROJECT_FORMAT = 'maquette-project';
export const BACKUP_FORMAT = 'maquette-backup';
export const FORMAT_VERSION = 1;

export const LOCAL_SIG = 0x04034b50;
export const CENTRAL_SIG = 0x02014b50;
export const EOCD_SIG = 0x06054b50;
export const LOCAL_HEADER = 30;
export const CENTRAL_HEADER = 46;
export const EOCD = 22;
export const MAX_ZIP = 0xffffffff; // no ZIP64: sizes and offsets are u32
const UTF8_FLAG = 0x0800;
const VERSION = 20; // 2.0: the minimum for a stored entry with a directory structure

// ---------- CRC-32 (IEEE, the one ZIP and the journal use) ----------

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Running CRC: start with CRC_START, feed chunks with crcUpdate, finish with crcFinish. */
export const CRC_START = 0xffffffff;
export function crcUpdate(c: number, b: Uint8Array): number {
  for (let i = 0; i < b.length; i++) c = TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}
export function crcFinish(c: number): number {
  return (c ^ 0xffffffff) >>> 0;
}
export function crc32(b: Uint8Array): number {
  return crcFinish(crcUpdate(CRC_START, b));
}

// ---------- headers ----------

export interface DosTime {
  time: number;
  date: number;
}
export function dosTime(d: Date): DosTime {
  const y = Math.max(1980, Math.min(2107, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function localHeader(name: Uint8Array, crc: number, size: number, t: DosTime): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(LOCAL_HEADER + name.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, LOCAL_SIG, true);
  v.setUint16(4, VERSION, true);
  v.setUint16(6, UTF8_FLAG, true);
  v.setUint16(8, 0, true); // stored
  v.setUint16(10, t.time, true);
  v.setUint16(12, t.date, true);
  v.setUint32(14, crc, true);
  v.setUint32(18, size, true); // compressed = uncompressed: stored
  v.setUint32(22, size, true);
  v.setUint16(26, name.length, true);
  v.setUint16(28, 0, true);
  b.set(name, LOCAL_HEADER);
  return b;
}
/** Byte offset of the CRC field inside a local header (patched after streaming the data). */
export const LOCAL_CRC_AT = 14;

export interface ZipEntry {
  name: string;
  crc: number;
  size: number;
  /** Offset of the entry's local header. */
  offset: number;
}

export function centralHeader(e: ZipEntry, t: DosTime): Uint8Array<ArrayBuffer> {
  const name = enc.encode(e.name);
  const b = new Uint8Array(CENTRAL_HEADER + name.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, CENTRAL_SIG, true);
  v.setUint16(4, VERSION, true); // made by: MS-DOS / FAT attributes, spec 2.0
  v.setUint16(6, VERSION, true);
  v.setUint16(8, UTF8_FLAG, true);
  v.setUint16(10, 0, true);
  v.setUint16(12, t.time, true);
  v.setUint16(14, t.date, true);
  v.setUint32(16, e.crc, true);
  v.setUint32(20, e.size, true);
  v.setUint32(24, e.size, true);
  v.setUint16(28, name.length, true);
  // extra, comment, disk start, internal attributes, external attributes: all 0
  v.setUint32(42, e.offset, true);
  b.set(name, CENTRAL_HEADER);
  return b;
}

export function endOfCentral(count: number, cdSize: number, cdOffset: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(EOCD);
  const v = new DataView(b.buffer);
  v.setUint32(0, EOCD_SIG, true);
  v.setUint16(8, count, true);
  v.setUint16(10, count, true);
  v.setUint32(12, cdSize, true);
  v.setUint32(16, cdOffset, true);
  return b;
}

// ---------- reading ----------

export class ZipError extends Error {}

/** Finds the end-of-central-directory record in the archive's tail (it ends the file unless a
 *  comment follows it; comments are at most 65,535 bytes). */
export function findEnd(tail: Uint8Array, fileSize: number): { count: number; cdSize: number; cdOffset: number } {
  const v = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  for (let at = tail.length - EOCD; at >= 0; at--) {
    if (v.getUint32(at, true) !== EOCD_SIG) continue;
    const commentLen = v.getUint16(at + 20, true);
    if (at + EOCD + commentLen !== tail.length) continue;
    const count = v.getUint16(at + 10, true);
    const cdSize = v.getUint32(at + 12, true);
    const cdOffset = v.getUint32(at + 16, true);
    if (v.getUint16(at + 4, true) !== 0 || v.getUint16(at + 6, true) !== 0) throw new ZipError('multi-disk archives are not supported');
    if (count === 0xffff || cdSize === MAX_ZIP || cdOffset === MAX_ZIP) throw new ZipError('ZIP64 archives are not supported');
    if (cdOffset + cdSize > fileSize) throw new ZipError('the central directory is outside the file');
    return { count, cdSize, cdOffset };
  }
  throw new ZipError('not a ZIP archive (no end-of-directory record)');
}

/** Parses the central directory. Refuses anything this format never writes (compression,
 *  encryption, ZIP64) instead of guessing. */
export function parseCentral(cd: Uint8Array, count: number): ZipEntry[] {
  const v = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const out: ZipEntry[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_HEADER > cd.length || v.getUint32(at, true) !== CENTRAL_SIG) throw new ZipError(`central directory entry ${i + 1} is damaged`);
    const flags = v.getUint16(at + 8, true);
    const method = v.getUint16(at + 10, true);
    const crc = v.getUint32(at + 16, true);
    const csize = v.getUint32(at + 20, true);
    const size = v.getUint32(at + 24, true);
    const nameLen = v.getUint16(at + 28, true);
    const extraLen = v.getUint16(at + 30, true);
    const commentLen = v.getUint16(at + 32, true);
    const offset = v.getUint32(at + 42, true);
    const name = dec.decode(cd.subarray(at + CENTRAL_HEADER, at + CENTRAL_HEADER + nameLen));
    if (flags & 1) throw new ZipError(`${name} is encrypted`);
    if (method !== 0 || csize !== size) throw new ZipError(`${name} is compressed (Maquette files are stored)`);
    if (size === MAX_ZIP || offset === MAX_ZIP) throw new ZipError('ZIP64 archives are not supported');
    out.push({ name, crc, size, offset });
    at += CENTRAL_HEADER + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Offset of an entry's data, from its 30-byte local header. */
export function dataOffset(local: Uint8Array, e: ZipEntry): number {
  const v = new DataView(local.buffer, local.byteOffset, local.byteLength);
  if (local.length < LOCAL_HEADER || v.getUint32(0, true) !== LOCAL_SIG) throw new ZipError(`${e.name}: damaged local header`);
  return e.offset + LOCAL_HEADER + v.getUint16(26, true) + v.getUint16(28, true);
}

// ---------- project payload checks ----------

export const TOPO_MAGIC = 0x3154514d; // "MQT1", core/src/store.rs
export const TOPO_HEADER = 28;

/** Vertex and triangle counts from topo.bin's header ([magic, version, nverts, nowned, ntris,
 *  nnodes, nleaves], little-endian u32s), or null if it isn't one. */
export function topoCounts(head: Uint8Array): { verts: number; tris: number } | null {
  if (head.length < TOPO_HEADER) return null;
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (v.getUint32(0, true) !== TOPO_MAGIC) return null;
  return { verts: v.getUint32(8, true), tris: v.getUint32(16, true) };
}

export interface ProjectJson {
  format: typeof PROJECT_FORMAT;
  formatVersion: number;
  exportedAt: string;
  project: { name: string; createdAt: string; checkpointSeq: number; sourceId: string };
  mesh: { verts: number; tris: number };
  files: Record<string, { bytes: number; crc32: number }>;
}

export interface BackupJson {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  exportedAt: string;
  projects: { folder: string; name: string; tris: number }[];
}

/** File-name-safe slug for backup folders. */
export function slug(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s || 'project';
}

/** A name a user sees in Files: no path separators or characters Files refuses. */
export function displayFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Maquette project';
}
