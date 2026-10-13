// Generates the PNG icons (a shaded clay sphere) with no image libraries: raw RGBA -> zlib -> PNG.
// Usage: node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel((x + 0.5) / size, (y + 0.5) / size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
function sphere(tint) {
  const bg = [20, 20, 24];
  const L = [-0.45, -0.55, 0.7];
  const ll = Math.hypot(...L);
  return (u, v) => {
    const x = (u - 0.5) / 0.34;
    const y = (v - 0.53) / 0.34;
    const r2 = x * x + y * y;
    if (r2 > 1) return bg;
    const z = Math.sqrt(1 - r2);
    const d = Math.max(0, (x * L[0] + y * L[1] + z * L[2]) / ll);
    const spec = Math.pow(Math.max(0, d), 24) * 0.35;
    const s = 0.22 + 0.78 * d;
    return tint.map((c) => clamp(c * s + 255 * spec));
  };
}

const sets = [
  ['probe/public/icons', [['probe', [140, 170, 205]], ['dummy', [150, 150, 150]]]],
  ['public/icons', [['app', [217, 199, 179]]]],
];
for (const [dir, items] of sets) {
  mkdirSync(dir, { recursive: true });
  for (const [name, tint] of items) {
    for (const size of [180, 192, 512]) writeFileSync(`${dir}/${name}-${size}.png`, png(size, sphere(tint)));
  }
}
console.log('icons written');
