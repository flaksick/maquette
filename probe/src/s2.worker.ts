// Spike S2: durable saves.
// Latency (invariant 4: journal record durable p99 <= 100 ms after stroke end), measured under a
// realistic load — three 64 MB checkpoints in 15 s while 256 KB records arrive every 200 ms —
// for the two candidate designs:
//   'single'       one persist worker, journal records jump ahead between 4 MB checkpoint chunks
//   'ckpt-only' +  two workers on separate files, so a slow checkpoint flush can't block the
//   'journal-only' journal (main thread runs both at once)
// Durability: writes checksummed records + a durable ack after each flush until the balloon
// worker gets the page killed; the next launch verifies every acknowledged record survived.
import { crc32, fillRandom, openSync, writeJsonSync, workerScope, type SyncHandle } from './opfs';
import { HEADER_BYTES, RECORD_MAGIC } from './journal';
import { stats } from './stats';

const scope = workerScope();
const MB = 2 ** 20;
const CHUNK = 4 * MB;
const RECORD = 256 * 1024;
const CHECKPOINT_BYTES = 64 * MB;
const CHECKPOINT_AT_MS = [1000, 6000, 11000];
const RECORD_EVERY_MS = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOAD = { checkpointMB: CHECKPOINT_BYTES / MB, checkpoints: CHECKPOINT_AT_MS.length, chunkMB: CHUNK / MB, recordKB: RECORD / 1024, recordEveryMs: RECORD_EVERY_MS };

function randomBytes(n: number, seed: number): Uint8Array {
  const b = new Uint8Array(n);
  fillRandom(new Uint32Array(b.buffer), seed);
  return b;
}

/** Writes the checkpoint schedule; returns per-chunk write+flush times. `between` runs after
 *  every chunk (the single-worker design services the journal there). */
async function checkpoints(h: SyncHandle, seconds: number, between: () => void) {
  const chunk = randomBytes(CHUNK, 7);
  const chunkMs: number[] = [];
  const start = performance.now();
  for (const at of CHECKPOINT_AT_MS) {
    while (performance.now() - start < at) {
      between();
      await sleep(5);
    }
    for (let off = 0; off < CHECKPOINT_BYTES; off += CHUNK) {
      const t = performance.now();
      h.write(chunk, { at: off });
      h.flush();
      chunkMs.push(performance.now() - t);
      between();
    }
  }
  while (performance.now() - start < seconds * 1000) {
    between();
    await sleep(5);
  }
  return chunkMs;
}

function journalWriter(h: SyncHandle) {
  const record = randomBytes(RECORD, 9);
  let off = 0;
  const latencies: number[] = [];
  const writeMs: number[] = [];
  return {
    write(enqueuedAt: number) {
      const t = performance.now();
      h.write(record, { at: off });
      h.flush();
      const done = performance.now();
      writeMs.push(done - t);
      latencies.push(done - enqueuedAt);
      off = (off + RECORD) % (32 * MB);
    },
    result: () => ({ journalLatencyMs: stats(latencies), journalWriteFlushMs: stats(writeMs) }),
  };
}

async function single(seconds: number) {
  const ckpt = await openSync('s2-ckpt.bin');
  const jh = await openSync('s2-latency-journal.bin');
  const j = journalWriter(jh);
  const start = performance.now();
  let next = start + RECORD_EVERY_MS;
  const service = () => {
    while (performance.now() >= next) {
      j.write(next);
      next += RECORD_EVERY_MS;
    }
  };
  const chunkMs = await checkpoints(ckpt, seconds, service);
  ckpt.truncate(0);
  jh.truncate(0);
  ckpt.close();
  jh.close();
  return { design: 'single-worker', load: LOAD, ...j.result(), checkpointChunkWriteFlushMs: stats(chunkMs) };
}

async function ckptOnly(seconds: number) {
  const ckpt = await openSync('s2-ckpt.bin');
  const chunkMs = await checkpoints(ckpt, seconds, () => {});
  ckpt.truncate(0);
  ckpt.close();
  return { checkpointChunkWriteFlushMs: stats(chunkMs) };
}

async function journalOnly(seconds: number) {
  const jh = await openSync('s2-latency-journal.bin');
  const j = journalWriter(jh);
  const start = performance.now();
  let next = start + RECORD_EVERY_MS;
  while (performance.now() - start < seconds * 1000) {
    while (performance.now() >= next) {
      j.write(next);
      next += RECORD_EVERY_MS;
    }
    await sleep(2);
  }
  jh.truncate(0);
  jh.close();
  return { design: 'two-workers', load: LOAD, ...j.result() };
}

async function durability() {
  const jrnl = await openSync('s2-dur-journal.bin');
  const ack = await openSync('s2-dur-ack.json');
  jrnl.truncate(0);
  jrnl.flush();
  writeJsonSync(ack, { seq: 0, end: 0, t: Date.now() });
  const payload = new Uint8Array(RECORD);
  const header = new DataView(new ArrayBuffer(HEADER_BYTES));
  let off = 0;
  for (let seq = 1; ; seq++) {
    fillRandom(new Uint32Array(payload.buffer), seq * 2654435761);
    header.setUint32(0, RECORD_MAGIC, true);
    header.setUint32(4, seq, true);
    header.setUint32(8, RECORD, true);
    header.setUint32(12, crc32(payload), true);
    jrnl.write(new Uint8Array(header.buffer), { at: off });
    jrnl.write(payload, { at: off + HEADER_BYTES });
    jrnl.flush();
    off += HEADER_BYTES + RECORD;
    // Acknowledge only after the record's flush returned: an acked record must survive.
    writeJsonSync(ack, { seq, end: off, t: Date.now() });
    if (seq % 4 === 0) scope.postMessage({ type: 'acked', seq });
    if (off > 400 * MB) {
      off = 0;
      jrnl.truncate(0);
    }
    await sleep(15);
  }
}

type Mode = 'single' | 'ckpt-only' | 'journal-only' | 'durability';
scope.onmessage = async (e: MessageEvent<{ mode: Mode; seconds?: number }>) => {
  const seconds = e.data.seconds ?? 15;
  try {
    if (e.data.mode === 'single') scope.postMessage({ type: 'done', result: await single(seconds) });
    else if (e.data.mode === 'ckpt-only') scope.postMessage({ type: 'done', result: await ckptOnly(seconds) });
    else if (e.data.mode === 'journal-only') scope.postMessage({ type: 'done', result: await journalOnly(seconds) });
    else await durability();
  } catch (err) {
    scope.postMessage({ type: 'error', error: String(err) });
  }
};
