// Spike S7: moving files in and out on the iPad (IMP/EXP delivery path).
// Exports test files through the share sheet and <a download>, then imports them back through
// four `accept` variants and checks every byte via SHA-256.
import { button, el, sha256Hex, type Card } from './ui';
import { results } from './store';

interface TestFile {
  file: File;
  sha256: string;
}

function objCube(): string {
  const v = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ];
  const f = [[1, 4, 3, 2], [5, 6, 7, 8], [1, 2, 6, 5], [2, 3, 7, 6], [3, 4, 8, 7], [4, 1, 5, 8]];
  return '# maquette probe\n' + v.map((p) => `v ${p.join(' ')}`).join('\n') + '\n' + f.map((q) => `f ${q.join(' ')}`).join('\n') + '\n';
}

function stlTetra(): ArrayBuffer {
  const pts = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const tris = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  tris.forEach((t, i) => {
    const o = 84 + i * 50;
    t.forEach((v, k) => pts[v].forEach((c, a) => dv.setFloat32(o + 12 + k * 12 + a * 4, c, true)));
  });
  return buf;
}

function plyTriangle(): string {
  return [
    'ply', 'format ascii 1.0', 'element vertex 3', 'property float x', 'property float y', 'property float z',
    'property uchar red', 'property uchar green', 'property uchar blue', 'element face 1',
    'property list uchar int vertex_indices', 'end_header',
    '0 0 0 255 0 0', '1 0 0 0 255 0', '0 1 0 0 0 255', '3 0 1 2', '',
  ].join('\n');
}

function glbTriangle(): ArrayBuffer {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const json = JSON.stringify({
    asset: { version: '2.0', generator: 'maquette-probe' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
  });
  const jsonBytes = new TextEncoder().encode(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
  const total = 12 + 8 + jsonBytes.length + 8 + 36;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x46546c67, true); // glTF
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true); // JSON
  new Uint8Array(buf, 20, jsonBytes.length).set(jsonBytes);
  const binAt = 20 + jsonBytes.length;
  dv.setUint32(binAt, 36, true);
  dv.setUint32(binAt + 4, 0x004e4942, true); // BIN
  new Uint8Array(buf, binAt + 8, 36).set(new Uint8Array(positions.buffer));
  return buf;
}

async function makeFile(name: string, data: BlobPart, type: string): Promise<TestFile> {
  const file = new File([data], name, { type });
  return { file, sha256: await sha256Hex(await file.arrayBuffer()) };
}

export function mountFiles(c: Card): void {
  const files: TestFile[] = [];
  const known = new Map<string, string>(); // sha256 -> name

  const exportRow = el('div', { cls: 'actions' });
  const importRow = el('div', { cls: 'actions' });
  c.root.append(el('h3', {}, 'Export (each needs its own tap)'), exportRow, el('h3', {}, 'Import back'), importRow);

  c.actions.append(
    button('1. Make test files', async () => {
      c.status('making files…');
      files.length = 0;
      files.push(await makeFile('probe-cube.obj', objCube(), 'text/plain'));
      files.push(await makeFile('probe-tetra.stl', stlTetra(), 'application/octet-stream'));
      files.push(await makeFile('probe-tri.ply', plyTriangle(), 'text/plain'));
      files.push(await makeFile('probe-tri.glb', glbTriangle(), 'model/gltf-binary'));
      const big = new Uint8Array(200 * 2 ** 20);
      for (let o = 0; o < big.length; o += 65536) crypto.getRandomValues(big.subarray(o, o + 65536));
      files.push(await makeFile('probe-200MB.bin', big, 'application/octet-stream'));
      for (const f of files) known.set(f.sha256, f.file.name);
      exportRow.replaceChildren(
        ...files.flatMap((f) => [
          button(`Share ${f.file.name}`, () => share(f)),
          button(`Download ${f.file.name}`, () => download(f)),
        ]),
      );
      c.status('Files ready. Share each to Files (On My iPad), then import them back below.');
    }),
  );

  async function share(f: TestFile) {
    const t = performance.now();
    let outcome: string;
    try {
      if (navigator.canShare && !navigator.canShare({ files: [f.file] })) outcome = 'canShare=false';
      else {
        await navigator.share({ files: [f.file], title: f.file.name });
        outcome = 'shared';
      }
    } catch (e) {
      outcome = (e as Error).name || String(e);
    }
    await results.append('s7', 'exports', { via: 'share', name: f.file.name, bytes: f.file.size, outcome, ms: Math.round(performance.now() - t) });
    c.status(`share ${f.file.name}: ${outcome}`);
  }

  async function download(f: TestFile) {
    const url = URL.createObjectURL(f.file);
    const a = el('a', { href: url, download: f.file.name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    await results.append('s7', 'exports', { via: 'download', name: f.file.name, bytes: f.file.size, outcome: 'clicked' });
    c.status(`download ${f.file.name}: triggered (note whether Safari offered to save it)`);
  }

  const variants: [string, string | null][] = [
    ['no accept', null],
    ['extensions', '.obj,.stl,.glb,.ply,.bin'],
    ['MIME types', 'model/obj,model/stl,model/gltf-binary,application/octet-stream,text/plain'],
    ['*/*', '*/*'],
  ];
  for (const [label, accept] of variants) {
    const input = el('input', { type: 'file', multiple: true });
    if (accept) input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', async () => {
      const picked = [];
      for (const f of Array.from(input.files ?? [])) {
        const hash = await sha256Hex(await f.arrayBuffer());
        picked.push({ name: f.name, bytes: f.size, type: f.type, matches: known.get(hash) ?? null });
      }
      await results.append('s7', 'imports', { accept: label, picked });
      c.status(`import (${label}): ${picked.length} file(s), ${picked.filter((p) => p.matches).length} byte-identical`);
      input.value = '';
    });
    importRow.append(input, button(`Pick files (${label})`, () => input.click()));
  }

  const drop = el('div', { cls: 'drop' }, 'Or drag files here from Files in Split View');
  drop.addEventListener('dragover', (e) => e.preventDefault());
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    const dropped = [];
    for (const f of Array.from(e.dataTransfer?.files ?? [])) {
      const hash = await sha256Hex(await f.arrayBuffer());
      dropped.push({ name: f.name, bytes: f.size, matches: known.get(hash) ?? null });
    }
    await results.append('s7', 'drops', { dropped });
    c.status(`dropped ${dropped.length} file(s)`);
  });
  c.root.append(drop);
}
