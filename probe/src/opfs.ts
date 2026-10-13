// Minimal typings for OPFS sync access handles (worker-only API, absent from the DOM lib),
// plus helpers shared by every worker that must write durably (invariant 4).

export interface SyncHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface FileHandleWithSync extends FileSystemFileHandle {
  createSyncAccessHandle(): Promise<SyncHandle>;
}

export async function probeRoot(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  // Channel-namespaced root (decision row "Persistence"): the probe never touches app data.
  return root.getDirectoryHandle('probe', { create: true });
}

export async function openSync(name: string): Promise<SyncHandle> {
  const dir = await probeRoot();
  const fh = (await dir.getFileHandle(name, { create: true })) as FileHandleWithSync;
  return fh.createSyncAccessHandle();
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Replace a small JSON file's contents and flush before returning. */
export function writeJsonSync(h: SyncHandle, value: unknown): void {
  const bytes = enc.encode(JSON.stringify(value));
  h.truncate(0);
  h.write(bytes, { at: 0 });
  h.flush();
}

export function readJsonSync<T>(h: SyncHandle): T | null {
  const size = h.getSize();
  if (size === 0) return null;
  const buf = new Uint8Array(size);
  h.read(buf, { at: 0 });
  try {
    return JSON.parse(dec.decode(buf)) as T;
  } catch {
    return null;
  }
}

/** Async read usable from the main thread (reads are safe; writes go through workers). */
export async function readJson<T>(name: string): Promise<T | null> {
  try {
    const dir = await probeRoot();
    const fh = await dir.getFileHandle(name);
    const text = await (await fh.getFile()).text();
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

export async function fileSize(name: string): Promise<number> {
  try {
    const dir = await probeRoot();
    return (await (await dir.getFileHandle(name)).getFile()).size;
  } catch {
    return -1;
  }
}

/** CRC32 (IEEE) for journal record checksums. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** xorshift32 fill: dirties memory with incompressible bytes (compressed pages don't count). */
export function fillRandom(words: Uint32Array, seed: number): number {
  let s = seed >>> 0 || 0x2545f491;
  for (let i = 0; i < words.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    words[i] = s >>> 0;
  }
  return s >>> 0;
}

export interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
  requestAnimationFrame?: (cb: (t: number) => void) => number;
  close(): void;
}
export const workerScope = (): WorkerScope => self as unknown as WorkerScope;
