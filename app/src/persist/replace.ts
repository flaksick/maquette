// 'replace-mesh' (TOP-1 remesh, and undo/redo across one): the topology changed, so the
// project's topo + positions files are replaced whole and the journal starts over, atomically.
//
// Files are never overwritten in place. The manifest names the data files (topoFile,
// positionsFile; absent = the original topo.bin / positions.bin), and the A/B manifest slots
// make the switch one write. Crash at any step:
//   1. new files written + flushed under new names (topo-<gen>.bin, positions-<gen>.bin) and an
//      empty journal segment journal-<newGen>.bin: the manifest still names the old files and old
//      journal, so the reopened project is exactly the old one (the remesh wasn't acknowledged).
//      Leftover new files are orphans; the next replace deletes them.
//   2. manifest flip, written to the slot that does NOT hold the current manifest: a torn write
//      fails its CRC and the other slot (old files) wins; a complete write names the new files,
//      which were flushed in step 1, plus the new empty journal: the new mesh, nothing to replay.
//   3. handles switch to the new positions file and journal segment (memory only).
//   4. old data files and older journal segments are deleted: harmless if interrupted (orphans).
// Journal records for the new mesh can't reach the old journal: the worker queues
// 'replace-mesh' with the journal records (FIFO), so later strokes are appended after step 3.

export interface ReplaceManifest {
  gen: number;
  checkpointSeq: number;
  journalGen: number;
  topoFile?: string;
  positionsFile?: string;
}

export interface ReplaceTarget<M extends ReplaceManifest, H> {
  dir: FileSystemDirectoryHandle;
  manifest: M;
  appendGen: number;
  journal: H & { close(): void };
  journalOffset: number;
  positions: H & { close(): void };
}

export interface ReplaceIo<M, H> {
  writeWhole(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<void>;
  openHandle(dir: FileSystemDirectoryHandle, name: string): Promise<H & { close(): void }>;
  writeManifest(dir: FileSystemDirectoryHandle, m: M): Promise<void>;
}

export const topoFileOf = (m: ReplaceManifest) => m.topoFile ?? 'topo.bin';
export const positionsFileOf = (m: ReplaceManifest) => m.positionsFile ?? 'positions.bin';

export async function replaceMesh<M extends ReplaceManifest, H>(
  c: ReplaceTarget<M, H>,
  io: ReplaceIo<M, H>,
  topo: ArrayBuffer,
  positions: ArrayBuffer,
  seq: number,
): Promise<void> {
  const gen = c.manifest.gen + 1;
  const newGen = c.appendGen + 1;
  const topoName = `topo-${gen}.bin`;
  const posName = `positions-${gen}.bin`;
  const keep = new Set([topoFileOf(c.manifest), positionsFileOf(c.manifest)]);
  // Orphans from a replace that crashed before its manifest flip.
  for (const name of await names(c.dir)) {
    if (/^(topo|positions)(-\d+)?\.bin$/.test(name) && !keep.has(name)) await remove(c.dir, name);
  }
  // 1. new data files and an empty journal segment, flushed
  await io.writeWhole(c.dir, topoName, new Uint8Array(topo));
  await io.writeWhole(c.dir, posName, new Uint8Array(positions));
  await io.writeWhole(c.dir, `journal-${newGen}.bin`, new Uint8Array(0));
  // 2. the switch
  const next = { ...c.manifest, gen, topoFile: topoName, positionsFile: posName, journalGen: newGen, checkpointSeq: seq };
  await io.writeManifest(c.dir, next);
  // 3. handles
  const oldTopo = topoFileOf(c.manifest);
  const oldPos = positionsFileOf(c.manifest);
  c.journal.close();
  c.positions.close();
  c.journal = await io.openHandle(c.dir, `journal-${newGen}.bin`);
  c.journalOffset = 0;
  c.positions = await io.openHandle(c.dir, posName);
  c.appendGen = newGen;
  c.manifest = next;
  // 4. cleanup
  for (const name of await names(c.dir)) {
    const j = /^journal-(\d+)\.bin$/.exec(name);
    if (name === oldTopo || name === oldPos || (j && Number(j[1]) < newGen)) await remove(c.dir, name);
  }
}

async function names(dir: FileSystemDirectoryHandle): Promise<string[]> {
  const out: string[] = [];
  for await (const [name] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) out.push(name);
  return out;
}

async function remove(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await dir.removeEntry(name);
  } catch {}
}
