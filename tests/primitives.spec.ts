// PRM-2 in WebKit, served like GitHub Pages: every primitive created from the New sheet, the
// engine's counts equal the ones the sheet showed, the sheet fits 1180x820 and 820x1180, and each
// primitive's OBJ lands in test-results/prm2-<shape>.obj for the Blender oracle (verify.mjs).
import { expect, test, webkit, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.MAQUETTE_APP_URL ?? `http://localhost:${process.env.MAQUETTE_PORT ?? '8787'}/maquette/dev/`;
// Small resolutions keep the run quick; the counts come from the sheet itself.
const SHAPES: [string, number][] = [['Cube', 8], ['Cylinder', 32], ['Cone', 32], ['Torus', 33], ['Plane', 16], ['Capsule', 32], ['Icosphere', 3]];

const stats = (page: Page) => page.evaluate(() => (window as any).__maquette.query().then((r: any) => r.stats));

async function openNew(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.locator('.sheet[role=dialog]')).toBeVisible();
}

/** The open sheet and its Create button lie inside the viewport. */
async function fitsViewport(page: Page): Promise<boolean> {
  const vp = page.viewportSize()!;
  const inside = (b: { x: number; y: number; width: number; height: number } | null) => !!b && b.x >= 0 && b.y >= 0 && b.x + b.width <= vp.width + 0.5 && b.y + b.height <= vp.height + 0.5;
  return inside(await page.locator('.sheet[role=dialog]').boundingBox()) && inside(await page.getByRole('button', { name: 'Create' }).boundingBox());
}

test('PRM-2: each primitive from the New sheet, counts as shown, fits both orientations, OBJ for the oracle', async () => {
  const results: Record<string, unknown> = {};
  const profile = mkdtempSync(join(tmpdir(), 'maquette-prm2-'));
  const ctx = await webkit.launchPersistentContext(profile, { viewport: { width: 1180, height: 820 } });
  const errors: string[] = [];
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  mkdirSync('test-results', { recursive: true });
  try {
    await page.goto(URL);
    await page.waitForFunction(() => (window as any).__maquette?.ui.ready.value === true, null, { timeout: 60_000 });
    for (const [label, n] of SHAPES) {
      await openNew(page);
      await page.getByRole('radio', { name: label, exact: true }).click();
      await page.locator('input[type=range][data-feature="PRM-2"]').fill(String(n));
      const shown = page.locator('[data-tris]');
      const want = { tris: Number(await shown.getAttribute('data-tris')), polys: Number(await shown.getAttribute('data-polys')) };
      const fits = await fitsViewport(page);
      await page.getByRole('button', { name: 'Create' }).click();
      await page.waitForFunction((t) => (window as any).__maquette.ui.stats.value?.tris === t, want.tris, { timeout: 20_000 });
      const st = await stats(page);
      // The OBJ export of what the engine now holds (EXP-1 writes polygon runs back as faces).
      await page.evaluate(() => {
        const m = (window as any).__maquette;
        m.ui.exportFile.value = null;
        m.send({ type: 'export-obj' });
      });
      await page.waitForFunction(() => !!(window as any).__maquette.ui.exportFile.value, null, { timeout: 20_000 });
      const obj: string = await page.evaluate(() => (window as any).__maquette.ui.exportFile.value.file.text());
      const faces = obj.split('\n').filter((l) => l.startsWith('f ')).length;
      writeFileSync(`test-results/prm2-${label.toLowerCase()}.obj`, obj);
      results[label] = { n, shown: want, tris: st.tris, verts: st.verts, objFaces: faces, fits1180x820: fits };
      expect(st.tris).toBe(want.tris);
      expect(faces).toBe(want.polys);
      expect(fits).toBe(true);
    }
    // Portrait: every shape's sheet still fits.
    await page.setViewportSize({ width: 820, height: 1180 });
    await openNew(page);
    const portrait: Record<string, boolean> = {};
    for (const [label] of [['Sphere'], ...SHAPES]) {
      await page.getByRole('radio', { name: label as string, exact: true }).click();
      portrait[label as string] = await fitsViewport(page);
    }
    results.fits820x1180 = portrait;
    expect(Object.values(portrait).every(Boolean)).toBe(true);
    await page.getByRole('button', { name: 'Close' }).click();
  } finally {
    // OPFS is shared between WebKit profiles here: leave the default sphere as the last project.
    try {
      await page.evaluate(() => (window as any).__maquette.send({ type: 'new-sphere', n: 96 }));
      await page.waitForFunction(() => (window as any).__maquette.ui.stats.value?.tris === 110592, null, { timeout: 20_000 });
    } catch {}
    results.pageErrors = errors;
    writeFileSync('test-results/prm2-webkit.json', JSON.stringify(results, null, 1));
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
  }
  expect(errors).toEqual([]);
});
