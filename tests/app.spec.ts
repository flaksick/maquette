// P1a app end-to-end in WebKit, served like GitHub Pages (tests/s9 shows which production paths
// WebKit on the Mac exercises). Real kills: the test SIGKILLs Playwright's own WebKit content
// processes (never anything else) — the closest Mac equivalent of iOS killing the app.
import { expect, test, webkit, type BrowserContext, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.MAQUETTE_APP_URL ?? `http://localhost:${process.env.MAQUETTE_PORT ?? '8787'}/maquette/dev/`;
// Kills target every Playwright WebKit content process on the machine, so parallel runs set
// MAQUETTE_NO_KILL=1 and the lead runs the kill steps alone.
const KILLS = !process.env.MAQUETTE_NO_KILL;
const results: Record<string, unknown> = {};

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__maquette?.ui.ready.value === true, null, { timeout: 60_000 });
}
async function q(page: Page): Promise<{ hash: string; stats: any; storageOk: boolean }> {
  return page.evaluate(() => (window as any).__maquette.query());
}
async function savedSeq(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__maquette.ui.saved.value?.seq ?? (window as any).__maquette.ui.stats.value?.lastAcked ?? 0);
}
async function waitSaved(page: Page, seq: number): Promise<void> {
  await page.waitForFunction((s) => {
    const m = (window as any).__maquette.ui;
    return (m.saved.value?.seq ?? 0) >= s;
  }, seq, { timeout: 20_000 });
}
/** A mouse stroke across the middle of the canvas (mouse = sculpt with pressure 1). */
async function stroke(page: Page, dx = 0, finish = true): Promise<void> {
  const box = (await page.locator('#scene').boundingBox())!;
  const cx = box.x + box.width / 2 + dx;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 60, cy - 20);
  await page.mouse.down();
  for (let i = 0; i <= 12; i++) await page.mouse.move(cx - 60 + i * 10, cy - 20 + i * 3);
  if (finish) await page.mouse.up();
}
function killWebContent(): number {
  let pids: string[] = [];
  try {
    pids = execSync("pgrep -f 'ms-playwright/webkit.*WebContent'", { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return 0;
  }
  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {}
  }
  return pids.length;
}
async function reopen(ctx: BrowserContext, page: Page): Promise<Page> {
  try {
    await page.close();
  } catch {}
  const p = await ctx.newPage();
  await p.goto(URL);
  await ready(p);
  return p;
}

// Title IDs are this test's feature evidence (scripts/feature-status.mjs); PRJ-4 is added as an
// annotation only when the real kills ran.
test('UND-1 NAV-2 PLT-10 PLT-2 EXP-7 PLT-7: sculpt, undo/redo, idle, offline relaunch, export, engine trap (+ PRJ-4 kills)', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'maquette-app-'));
  const ctx = await webkit.launchPersistentContext(profile, { viewport: { width: 1180, height: 820 }, acceptDownloads: true });
  const errors: string[] = [];
  let page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    const t0 = Date.now();
    await page.goto(URL);
    await ready(page);
    results.firstLoadMs = Date.now() - t0;
    const h0 = (await q(page)).hash;
    const st0 = (await q(page)).stats;
    results.defaultMesh = { tris: st0.tris, verts: st0.verts, pages: st0.pages };
    expect(st0.tris).toBe(110592);

    // Sculpt (BRS-1 via mouse = full pressure), wait for the journal ack.
    await stroke(page);
    await waitSaved(page, 1);
    const h1 = (await q(page)).hash;
    expect(h1).not.toBe(h0);
    results.strokeChangedMesh = true;

    // Undo / redo are exact (UND-1).
    await page.getByRole('button', { name: /^Undo/ }).click();
    await waitSaved(page, 2);
    expect((await q(page)).hash).toBe(h0);
    await page.getByRole('button', { name: /^Redo/ }).click();
    await waitSaved(page, 3);
    expect((await q(page)).hash).toBe(h1);
    results.undoRedoExact = true;

    // Real kill after an acknowledged stroke (PRJ-4): nothing acknowledged may be lost.
    await stroke(page, 80);
    await waitSaved(page, 4);
    const h2 = (await q(page)).hash;
    if (KILLS) {
    const killed1 = killWebContent();
    page = await reopen(ctx, page);
    page.on('pageerror', (e) => errors.push(String(e)));
    const after1 = await q(page);
    results.killAfterAck = { killedProcesses: killed1, hashMatches: after1.hash === h2, recovered: await page.evaluate(() => (window as any).__maquette.ui.recovered.value) };
    expect(after1.hash).toBe(h2);

    // Kill mid-stroke: the in-flight stroke is the only thing allowed to be lost.
    await stroke(page, -120, false);
    await page.waitForTimeout(150);
    const killed2 = killWebContent();
    page = await reopen(ctx, page);
    page.on('pageerror', (e) => errors.push(String(e)));
    const after2 = await q(page);
    results.killMidStroke = { killedProcesses: killed2, hashMatchesLastAck: after2.hash === h2 };
    expect(after2.hash).toBe(h2);
    test.info().annotations.push({ type: 'feature', description: 'PRJ-4' });
    }

    // Idle is free (PLT-10): no frames while nothing changes.
    await page.waitForTimeout(1500);
    const f0 = (await q(page)).stats.frames;
    await page.waitForTimeout(10_000);
    const f1 = (await q(page)).stats.frames;
    results.idleFramesIn10s = f1 - f0;
    expect(f1 - f0).toBe(0);

    // Checkpoint happened while idle: journal compacted (PRJ-3).
    results.journalBytesAfterIdle = (await q(page)).stats.journalBytes;

    // Offline cold launch (PLT-2): the service worker serves everything.
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30_000 });
    await ctx.setOffline(true);
    const t1 = Date.now();
    page = await reopen(ctx, page);
    results.offlineLaunchMs = Date.now() - t1;
    expect((await q(page)).hash).toBe(h2);
    await ctx.setOffline(false);

    // Export OBJ (EXP-1, EXP-7 download path).
    await page.getByRole('button', { name: 'Export' }).click();
    await expect(page.getByRole('button', { name: 'Download' })).toBeVisible({ timeout: 20_000 });
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
    mkdirSync('test-results', { recursive: true });
    const objPath = 'test-results/export.obj';
    await dl.saveAs(objPath);
    const obj = readFileSync(objPath, 'utf8');
    const vCount = obj.split('\n').filter((l) => l.startsWith('v ')).length;
    const quads = obj.split('\n').filter((l) => l.startsWith('f ') && l.trim().split(/\s+/).length === 5).length;
    results.export = { vertices: vCount, quadFaces: quads, bytes: obj.length };
    expect(vCount).toBe(st0.verts);
    expect(quads).toBe(st0.tris / 2);
    await page.getByRole('button', { name: 'Close' }).click();

    // Engine crash containment (PLT-7): a WASM trap restarts the engine with nothing lost.
    await page.evaluate(() => (window as any).__maquette.send({ type: 'debug-trap' }));
    await page.waitForFunction(() => (window as any).__maquette.ui.ready.value === false, null, { timeout: 10_000 });
    await ready(page);
    results.trapRecovered = (await q(page)).hash === h2;
    expect(results.trapRecovered).toBe(true);
  } finally {
    results.pageErrors = errors;
    writeFileSync('test-results/app-webkit.json', JSON.stringify(results, null, 1));
    console.log(JSON.stringify(results, null, 1));
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
  }
  expect(errors).toEqual([]);
});

test('PLT-13: storage unavailable is said out loud', async () => {
  const browser = await webkit.launch();
  const ctx = await browser.newContext(); // ephemeral: OPFS throws UnknownError, like private browsing
  const page = await ctx.newPage();
  await page.goto(URL);
  await ready(page);
  await expect(page.locator('[data-feature="PLT-13"]').first()).toBeVisible();
  await expect(page.getByText('Saved', { exact: true })).toHaveCount(0);
  await browser.close();
});
