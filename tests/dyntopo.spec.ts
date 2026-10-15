// TOP-3 dyntopo end to end in WebKit (persistent profile: OPFS), plus the save-design numbers:
// a dyntopo stroke is journaled as one KIND_TOPO record (the touched leaves' slabs), and the
// whole mesh is written (replace-mesh) only when the layout changes or a checkpoint is due. The
// test prints both latencies at ~100k and ~500k triangles.
import { expect, test, webkit, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.MAQUETTE_APP_URL ?? `http://localhost:${process.env.MAQUETTE_PORT ?? '8787'}/maquette/dev/`;

const ready = (p: Page) => p.waitForFunction(() => (window as any).__maquette?.ui.ready.value === true, null, { timeout: 60_000 });
const q = (p: Page): Promise<{ hash: string; stats: any }> => p.evaluate(() => (window as any).__maquette.query());
const dyn = (p: Page) => p.evaluate(() => (globalThis as any).__maquetteDyntopo.value);
/** Waits until everything up to the engine's current seq is saved; returns that save's latency. */
async function saved(p: Page): Promise<number> {
  const seq = (await q(p)).stats.seq;
  await p.waitForFunction((s) => ((window as any).__maquette.ui.saved.value?.seq ?? 0) >= s, seq, { timeout: 60_000 });
  return p.evaluate(() => (window as any).__maquette.ui.saved.value.latencyMs);
}
async function stroke(p: Page, dx: number, dy = 0): Promise<void> {
  const box = (await p.locator('#scene').boundingBox())!;
  const cx = box.x + box.width / 2 + dx;
  const cy = box.y + box.height / 2 + dy;
  await p.mouse.move(cx - 50, cy - 10);
  await p.mouse.down();
  for (let i = 0; i <= 10; i++) await p.mouse.move(cx - 50 + i * 10, cy - 10 + i * 2);
  await p.mouse.up();
}
async function sphere(p: Page, n: number): Promise<void> {
  await p.evaluate((n) => (window as any).__maquette.send({ type: 'new-sphere', n }), n);
  await p.waitForFunction((t) => (window as any).__maquette.ui.stats.value?.tris === t && (window as any).__maquette.ui.stats.value?.seq === 0, 12 * n * n, { timeout: 60_000 });
}
/** Dyntopo on (lays the mesh out with slack and saves it whole); returns the whole-save latency. */
async function dyntopoOn(p: Page, value: number): Promise<number> {
  if ((await dyn(p)).on) await p.getByRole('button', { name: 'Dyntopo' }).click();
  await p.getByRole('button', { name: 'Dyntopo' }).click();
  await p.waitForFunction(() => (globalThis as any).__maquetteDyntopo.value.status?.ready === true, null, { timeout: 60_000 });
  const ms = await saved(p);
  // Screen detail, small enough that the sphere's edges split under the brush.
  await p.locator('input[type=range][data-feature="TOP-3"]').evaluate((el: HTMLInputElement, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  return ms;
}
const p99 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(0.99 * xs.length) - 1)];

test('TOP-3 UND-1 PRJ-3: dyntopo stroke adds triangles, undo restores the hash, survives a reload', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'maquette-dyntopo-'));
  const ctx = await webkit.launchPersistentContext(profile, { viewport: { width: 1180, height: 820 } });
  const errors: string[] = [];
  let page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  const out: Record<string, unknown> = {};
  try {
    await page.goto(URL);
    await ready(page);
    await sphere(page, 96); // 110,592 triangles
    out.wholeSave100kMs = await dyntopoOn(page, 3);
    const before = await q(page);
    await stroke(page, 0);
    const journal100k = [await saved(page)];
    const after = await q(page);
    out.tris = { before: before.stats.tris, after: after.stats.tris };
    expect(after.stats.tris).toBeGreaterThan(before.stats.tris);
    expect(after.hash).not.toBe(before.hash);
    // Undo restores the exact pre-stroke mesh; redo the stroke.
    await page.getByRole('button', { name: /^Undo/ }).click();
    await page.waitForFunction((h) => (window as any).__maquette.query().then((r: any) => r.hash === h), before.hash, { timeout: 20_000 });
    expect((await q(page)).stats.tris).toBe(before.stats.tris);
    await saved(page);
    await page.getByRole('button', { name: /^Redo/ }).click();
    await page.waitForFunction((h) => (window as any).__maquette.query().then((r: any) => r.hash === h), after.hash, { timeout: 20_000 });
    await saved(page);
    for (let i = 1; i <= 6; i++) {
      await stroke(page, -150 + 60 * i, 40);
      journal100k.push(await saved(page));
    }
    const last = await q(page);
    // Survives a reload: journal records (and any whole save) bring the same mesh back.
    await page.close();
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(URL);
    await ready(page);
    const back = await q(page);
    out.reload = { hash: back.hash === last.hash, tris: back.stats.tris };
    expect(back.hash).toBe(last.hash);
    expect(back.stats.tris).toBe(last.stats.tris);
    // 500k: the same saves on a bigger mesh.
    await sphere(page, 205); // 504,300 triangles
    out.wholeSave500kMs = await dyntopoOn(page, 3);
    const journal500k: number[] = [];
    for (let i = 0; i < 6; i++) {
      await stroke(page, -150 + 60 * i, -30);
      journal500k.push(await saved(page));
    }
    out.journalP99Ms = { at100k: p99(journal100k), at500k: p99(journal500k), samples: [journal100k, journal500k] };
    // Leave the default sphere as the last project, dyntopo off (other tests expect it).
    await page.getByRole('button', { name: 'Dyntopo' }).click();
    await sphere(page, 96);
  } finally {
    console.log(JSON.stringify({ dyntopo: out }, null, 1));
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/dyntopo-webkit.json', JSON.stringify(out, null, 1));
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
  }
  expect(errors).toEqual([]);
});
