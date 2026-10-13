// Journal record format shared by the S2 writer (worker) and the verifier (main thread).
// Record = 16-byte header (magic, seq, length, crc32 of payload; little-endian) + payload.
import { crc32 } from './opfs';

export const RECORD_MAGIC = 0x4d514a31; // "MQJ1"
export const HEADER_BYTES = 16;

export interface JournalScan {
  validRecords: number;
  lastValidSeq: number;
  stopReason: 'end' | 'torn-header' | 'torn-payload' | 'bad-magic' | 'seq-gap' | 'crc-mismatch';
  bytes: number;
}

export function scanJournal(buf: ArrayBuffer): JournalScan {
  const dv = new DataView(buf);
  let off = 0;
  let expected = 1;
  let valid = 0;
  let stopReason: JournalScan['stopReason'] = 'end';
  while (off < buf.byteLength) {
    if (off + HEADER_BYTES > buf.byteLength) {
      stopReason = 'torn-header';
      break;
    }
    if (dv.getUint32(off, true) !== RECORD_MAGIC) {
      stopReason = 'bad-magic';
      break;
    }
    const seq = dv.getUint32(off + 4, true);
    const len = dv.getUint32(off + 8, true);
    const crc = dv.getUint32(off + 12, true);
    if (seq !== expected) {
      stopReason = 'seq-gap';
      break;
    }
    if (off + HEADER_BYTES + len > buf.byteLength) {
      stopReason = 'torn-payload';
      break;
    }
    if (crc32(new Uint8Array(buf, off + HEADER_BYTES, len)) !== crc) {
      stopReason = 'crc-mismatch';
      break;
    }
    valid++;
    expected++;
    off += HEADER_BYTES + len;
  }
  return { validRecords: valid, lastValidSeq: valid, stopReason, bytes: buf.byteLength };
}
