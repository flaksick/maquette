// Import, units and STL export in WebKit, served like GitHub Pages. Blender-made fixtures go in
// through the real picker (setInputFiles, no accept filter) and drag-and-drop; counts are compared
// with Blender's own (tests/fixtures/blender_counts.json). The STL lands in test-results/export.stl,
// where verify.mjs hands it to the Blender oracle (oracle/check_stl.py).
import { expect, test, webkit, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.MAQUETTE_APP_URL ?? `http://localhost:${process.env.MAQUETTE_PORT ?? '8787'}/maquette/dev/`;
const BLENDER = JSON.parse(readFileSync('tests/fixtures/blender_counts.json', 'utf8')).fixtures;

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__maquette?.ui.ready.value === true, null, { timeout: 60_000 });
}
const stats = (page: Page) => page.evaluate(() => (window as any).__maquette.query().then((r: any) => r.stats));
const report = (page: Page) => page.evaluate(() => (window as any).__maquette.io.report.value);
async function imported(page: Page, name: string): Promise<any> {
  await page.waitForFunction((n) => (window as any).__maquette.io.report.value?.name === n, name, { timeout: 30_000 });
  return report(page);
}

test('IMP-1 IMP-2 IMP-0 PRJ-9 EXP-2: import fixtures (picker + drop), units survive relaunch, STL export', async () => {
  const results: Record<string, unknown> = {};
  const profile = mkdtempSync(join(tmpdir(), 'maquette-io-'));
  const ctx = await webkit.launchPersistentContext(profile, { viewport: { width: 1180, height: 820 }, acceptDownloads: true });
  const errors: string[] = [];
  let page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    await page.goto(URL);
    await ready(page);
    const picker = () => page.locator('input[type=file][data-feature="IMP-1"]');
    expect(await picker().getAttribute('accept')).toBeNull(); // P0 S7: no accept filter

    // IMP-1: a subdivided monkey through the picker; counts are Blender's.
    await picker().setInputFiles('tests/fixtures/monkey_subdiv.obj');
    const r1 = await imported(page, 'monkey_subdiv.obj');
    const b1 = BLENDER['monkey_subdiv.obj'].blender;
    const s1 = await stats(page);
    results.monkeyObj = { report: r1, stats: { verts: s1.verts, tris: s1.tris } };
    expect([r1.verts, r1.faces, r1.tris, r1.components, r1.boundaryEdges]).toEqual([b1.vertices, b1.faces, b1.triangles, b1.loose_parts, b1.boundary_edges]);
    expect([s1.verts, s1.tris]).toEqual([b1.vertices, b1.triangles]);
    expect([r1.weldedVerts, r1.droppedDuplicate, r1.droppedDegenerate, r1.flippedFaces, r1.splitNonManifold]).toEqual([0, 0, 0, 0, 0]);

    // PRJ-9: the sheet asks, guess preselected (2.7 units across -> m); choose cm.
    await expect(page.getByRole('dialog', { name: 'Imported monkey_subdiv.obj' })).toBeVisible();
    await expect(page.locator('[role=radiogroup][aria-label=Units] [aria-checked=true]')).toHaveText('m');
    expect(await page.locator('table.counts [data-count=boundaryEdges]').textContent()).toBe(String(b1.boundary_edges));
    await page.getByRole('radio', { name: 'cm' }).click();
    await page.getByRole('button', { name: 'Use cm' }).click();
    await page.waitForFunction(() => (window as any).__maquette.io.units.value === 'cm');

    // Relaunch: the imported project reopens with its units (stored with the project).
    await page.waitForTimeout(500);
    await page.close();
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(URL);
    await ready(page);
    await page.waitForFunction(() => (window as any).__maquette.io.units.value === 'cm', null, { timeout: 10_000 });
    const s2 = await stats(page);
    expect([s2.verts, s2.tris]).toEqual([b1.vertices, b1.triangles]);
    results.relaunch = { units: 'cm', verts: s2.verts, tris: s2.tris };

    // EXP-2: binary STL in millimetres (cm -> x10), Z up, with the watertight warning.
    await page.getByRole('button', { name: 'Export' }).click();
    await page.getByRole('radio', { name: 'STL' }).click();
    await expect(page.getByRole('button', { name: 'Download' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('alert')).toContainText(`${b1.boundary_edges} open edges`);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
    expect(dl.suggestedFilename()).toMatch(/\.stl$/);
    mkdirSync('test-results', { recursive: true });
    await dl.saveAs('test-results/export.stl');
    const stl = readFileSync('test-results/export.stl');
    const n = stl.readUInt32LE(80);
    expect(stl.length).toBe(84 + 50 * n);
    expect(n).toBe(b1.triangles);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let t = 0; t < n; t++)
      for (let k = 0; k < 9; k++) {
        const x = stl.readFloatLE(84 + 50 * t + 12 + 4 * k);
        lo[k % 3] = Math.min(lo[k % 3], x);
        hi[k % 3] = Math.max(hi[k % 3], x);
      }
    // engine (x, y, z) -> file (x, -z, y), times 10; engine bbox = the import report's.
    const e = r1.bbox;
    const want = [[10 * e[0], -10 * e[5], 10 * e[1]], [10 * e[3], -10 * e[2], 10 * e[4]]];
    const delta = Math.max(...[0, 1, 2].flatMap((k) => [Math.abs(lo[k] - want[0][k]), Math.abs(hi[k] - want[1][k])]));
    results.stl = { triangles: n, bytes: stl.length, bbox: [lo, hi], bboxDelta: delta };
    expect(delta).toBeLessThanOrEqual(1e-3);
    await page.getByRole('button', { name: 'Close' }).click();

    // IMP-2: a binary STL dropped on the viewport; the weld count is Blender's.
    const cube = [...readFileSync('tests/fixtures/cube_binary.stl')];
    await page.evaluate((bytes) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], 'cube_binary.stl'));
      const vp = document.getElementById('viewport')!;
      vp.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      vp.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, cube);
    const r2 = await imported(page, 'cube_binary.stl');
    const b2 = BLENDER['cube_binary.stl'].blender;
    results.droppedStl = r2;
    expect([r2.verts, r2.tris, r2.weldedVerts]).toEqual([b2.vertices, b2.faces, 3 * b2.faces - b2.vertices]);
    await page.getByRole('button', { name: 'Close' }).click();

    // IMP-0: two cubes sharing an edge come apart into two closed cubes.
    await picker().setInputFiles('tests/fixtures/defect_nonmanifold.obj');
    const r3 = await imported(page, 'defect_nonmanifold.obj');
    const d3 = BLENDER['defect_nonmanifold.obj'].defect;
    results.nonmanifold = r3;
    expect([r3.splitNonManifold, r3.components, r3.boundaryEdges]).toEqual([d3.vertex_copies_to_split, d3.components_after_split, 0]);
    expect((await stats(page)).verts).toBe(r3.verts);
    await page.getByRole('button', { name: 'Close' }).click();

    // A file that isn't OBJ/STL is refused in JS; the sculpt is unchanged.
    await picker().setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await expect(page.locator('.notice')).toContainText('imports .obj and .stl');
    expect((await stats(page)).verts).toBe(r3.verts);
  } finally {
    // OPFS is shared between WebKit profiles here (app.spec then opened this test's last import):
    // leave the default sphere as the last project, as a fresh app has it.
    try {
      await page.evaluate(() => (window as any).__maquette.send({ type: 'new-sphere', n: 96 }));
      await page.waitForFunction(() => (window as any).__maquette.ui.stats.value?.tris === 110592, null, { timeout: 20_000 });
    } catch {}
    results.pageErrors = errors;
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/io-webkit.json', JSON.stringify(results, null, 1));
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
  }
  expect(errors).toEqual([]);
});
