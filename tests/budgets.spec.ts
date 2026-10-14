// PLT-8 device budgets. The learning policy is tested directly (pure functions, no browser); the
// app is tested in WebKit served like GitHub Pages, with session records written into OPFS the
// way the persist worker writes them (a real 1.3 GB high-water mark isn't reproducible on a Mac).
import { expect, test, webkit, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyStress, comfortableTris, fits, initialBudget, learn, setBudget, stressFromMarker, type BudgetState, type SessionRecord } from '../app/src/budget';

const BASE = `http://localhost:${process.env.MAQUETTE_PORT ?? '8787'}/maquette/dev/`;
const OUT = 'test-results/plt8-budgets.json';

function record(k: Record<string, unknown>): void {
  mkdirSync('test-results', { recursive: true });
  const cur = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
  writeFileSync(OUT, JSON.stringify({ ...cur, ...k }, null, 1));
}

const T = '2026-10-14T10:00:00.000Z';
const session = (open: boolean, highWaterMB: number, budgetMB: number, deliberate: SessionRecord['deliberate'] = null): SessionRecord => ({
  open,
  start: T,
  beat: T,
  highWaterMB,
  seq: 3,
  budgetMB,
  deliberate,
});

test('PLT-8: learning: unclean exit at >= 85% cuts 10%, three clean sessions above 90% raise 5%, never past the ceiling', () => {
  let s: BudgetState = initialBudget();
  expect(s.budgetMB).toBe(1459);
  expect(s.ceilingMB).toBe(2432);
  // Unclean exit at 89% of the budget: cut 10%.
  let r = learn(s, session(true, 1300, 1459), T);
  expect(r.state.budgetMB).toBe(1313);
  expect(r.change?.reason).toContain('89%');
  s = r.state;
  // Unclean at 84%: not a memory kill (no cut), but it resets the raise streak.
  s = learn({ ...s, cleanHigh: 2 }, session(true, 0.84 * 1313, 1313), T).state;
  expect([s.budgetMB, s.cleanHigh]).toEqual([1313, 0]);
  // Deliberate exits (kill test, stress test) teach nothing and don't count as sessions.
  const before = s.sessions;
  s = learn(s, session(true, 1313, 1313, 'kill-test'), T).state;
  expect([s.budgetMB, s.sessions]).toEqual([1313, before]);
  // Clean at 80%: neutral. Clean above 90% three times: +5%.
  s = learn(s, session(false, 0.8 * 1313, 1313), T).state;
  expect(s.cleanHigh).toBe(0);
  for (let i = 0; i < 2; i++) s = learn(s, session(false, 0.95 * 1313, 1313), T).state;
  expect(s.budgetMB).toBe(1313);
  r = learn(s, session(false, 0.95 * 1313, 1313), T);
  expect(r.state.budgetMB).toBe(1379); // round(1313 x 1.05)
  // Never above the ceiling.
  let hi: BudgetState = { ...initialBudget(), budgetMB: 2400 };
  for (let i = 0; i < 3; i++) hi = learn(hi, session(false, 2300, 2400), T).state;
  expect(hi.budgetMB).toBe(2432);
  // Repeated cuts stop at the floor.
  expect(learn({ ...initialBudget(), budgetMB: 270 }, session(true, 260, 270), T).state.budgetMB).toBe(256);
  record({ priorMB: 1459, policyCutMB: 1313, policyRaiseMB: 1379, policyCeilingMB: hi.budgetMB });
});

test('PLT-8: stress test result: budget = 0.6 x what the iPad held; a capped run never lowers it', () => {
  const killed = stressFromMarker({ t: T, phase: 'growing', attemptMB: 2368, lastOkMB: 2304, appMB: 128, applied: false }, T)!;
  expect([killed.outcome, killed.totalMB, killed.failedAtMB]).toEqual(['killed', 2432, 2368]);
  const a = applyStress(initialBudget(), killed, T).state;
  expect([a.budgetMB, a.ceilingMB, a.basis]).toEqual([1459, 2432, 'stress-test']);
  const big = applyStress(initialBudget(), { ...killed, lastOkMB: 5000, totalMB: 5128 }, T).state;
  expect(big.budgetMB).toBe(3077); // round(0.6 x 5,128)
  const capped = stressFromMarker({ t: T, phase: 'capped', attemptMB: 128, lastOkMB: 128, appMB: 60, applied: false }, T)!;
  const c = applyStress(initialBudget(), capped, T).state;
  expect([c.budgetMB, c.ceilingMB]).toEqual([1459, 2432]);
  expect(stressFromMarker({ t: T, phase: 'ok', attemptMB: 64, lastOkMB: 64, appMB: 1, applied: true }, T)).toBeNull();
});

test('PLT-8: pre-flight fits() uses the learned budget and names its source', () => {
  setBudget(initialBudget());
  expect(fits(50, 1345, 'This sphere').ok).toBe(true); // 1,395 <= 1,459 under the prior
  setBudget(learn(initialBudget(), session(true, 1300, 1459), T).state);
  const p = fits(50, 1345, 'This sphere');
  expect([p.ok, p.budgetMB, p.peakMB]).toEqual([false, 1313, 1395]);
  expect(p.text).toContain('1,313 MB');
  expect(p.text).toContain('learned over 1 session');
  setBudget(initialBudget());
  // Comfortable polycount: interpolated between the last size under the target and the next.
  const z = (tris: number, p95: number) => ({ tris, verts: tris / 2, setupMs: 1, frames: 72, frameMs: { p50: p95, p95, mean: p95 }, strokeEndMs: 1 });
  expect(comfortableTris([z(200_000, 2), z(800_000, 6), z(1_200_000, 10)], 8, 10_000_000)).toEqual({ tris: 1_000_000, limitedBy: 'speed' });
  expect(comfortableTris([z(200_000, 1), z(800_000, 2)], 8, 1_000_000)).toEqual({ tris: 1_000_000, limitedBy: 'memory' });
});

// ---------- WebKit ----------
async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__maquette?.ui.ready.value === true, null, { timeout: 60_000 });
  // The engine posts the learned budget right after session-start, before 'ready'.
  await page.waitForFunction(() => (window as any).__maquette.budget.state.value.schema === 1, null, { timeout: 10_000 });
}
async function open(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(BASE);
  await ready(page);
  return page;
}
const budgetOf = (page: Page) => page.evaluate(() => (window as any).__maquette.budget.state.value as BudgetState);

/** Writes (or, for null, deletes) JSON files in the dev channel's OPFS root from a page that isn't
 *  running the app, through a sync access handle in a worker (what the persist worker uses).
 *  Playwright's WebKit keeps OPFS per origin under ~/Library/WebKit/org.webkit.Playwright, shared by
 *  every persistent profile, so each test starts by deleting the budget state it depends on. */
const FRESH = { 'budget.json': null, 'session.json': null, 'stress-marker.json': null };

async function writeOpfs(ctx: BrowserContext, files: Record<string, unknown>): Promise<void> {
  const page = await ctx.newPage();
  await page.goto(BASE + 'manifest.webmanifest');
  await page.evaluate(async (files) => {
    const code = `onmessage = async (e) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('app-dev', { create: true });
      for (const [name, value] of Object.entries(e.data)) {
        if (value === null) {
          await dir.removeEntry(name).catch(() => {});
          continue;
        }
        const fh = await dir.getFileHandle(name, { create: true });
        let h = null;
        for (let i = 0; i < 40 && !h; i++) {
          try { h = await fh.createSyncAccessHandle(); } catch { await new Promise((r) => setTimeout(r, 50)); }
        }
        const bytes = new TextEncoder().encode(JSON.stringify(value));
        h.truncate(0); h.write(bytes, { at: 0 }); h.flush(); h.close();
      }
      postMessage('ok');
    };`;
    const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    await new Promise((resolve, reject) => {
      w.onmessage = resolve;
      w.onerror = (e) => reject(new Error(e.message));
      w.postMessage(files);
    });
    w.terminate();
  }, files);
  await page.close();
}

test('PLT-8: the learned budget is shown with its source and drives the pre-flight refusals', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'maquette-plt8-'));
  const ctx = await webkit.launchPersistentContext(profile, { viewport: { width: 1180, height: 820 } });
  try {
    await writeOpfs(ctx, FRESH);
    let page = await open(ctx);
    let b = await budgetOf(page);
    expect([b.budgetMB, b.basis]).toEqual([1459, 'prior']);
    await expect(page.locator('.hud')).toContainText('/ 1,459 MB (4 GB prior)');
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('.budget')).toContainText('Budget 1,459 MB · 4 GB-class prior, measured on iPad Air 4 (P0)');
    await expect(page.locator('.budget')).toContainText('Ceiling 2,432 MB');
    await page.close();

    // The last session died at 89% of the budget (what the 2 s beats would have left behind).
    await writeOpfs(ctx, { 'session.json': session(true, 1300, 1459) });
    page = await open(ctx);
    b = await budgetOf(page);
    expect([b.budgetMB, b.basis, b.sessions]).toEqual([1313, 'learned', 1]);
    expect(await page.evaluate(() => (window as any).__maquette.ui.notice.value?.text)).toContain('1,459 MB → 1,313 MB');
    await expect(page.locator('.hud')).toContainText('/ 1,313 MB (learned ×1)');
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('.budget')).toContainText('Budget 1,313 MB · learned over 1 session');
    await page.getByRole('button', { name: 'Close' }).click();

    // Pre-flight: the engine refuses before allocating, naming the learned budget and its source.
    await page.evaluate(() => (window as any).__maquette.send({ type: 'new-sphere', n: 2048 }));
    await page.waitForFunction(() => /sphere needs about/.test((window as any).__maquette.ui.notice.value?.text ?? ''), null, { timeout: 10_000 });
    const refusal: string = await page.evaluate(() => (window as any).__maquette.ui.notice.value.text);
    expect(refusal).toContain("over this iPad's 1,313 MB budget (learned over 1 session");
    expect((await page.evaluate(() => (window as any).__maquette.query())).stats.tris).toBe(110592); // nothing was built
    await page.getByRole('button', { name: 'New' }).click();
    await expect(page.locator('.sheet')).toContainText('of a 1,313 MB budget (learned over 1 session');
    await page.close();

    // Three clean sessions above 90%: +5%.
    for (let i = 0; i < 3; i++) {
      await writeOpfs(ctx, { 'session.json': session(false, Math.round(0.95 * 1313), 1313) });
      page = await open(ctx);
      if (i < 2) await page.close();
    }
    b = await budgetOf(page);
    expect([b.budgetMB, b.sessions]).toEqual([1379, 4]);
    expect(await page.evaluate(() => (window as any).__maquette.ui.notice.value?.text)).toContain('raised 5%');
    record({ afterCutMB: 1313, afterRaiseMB: b.budgetMB, refusedAtMB: 1313, refusal });
  } finally {
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('PLT-8: speed benchmark measures the brush pipeline and sets the comfortable polycount', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'maquette-plt8b-'));
  const ctx = await webkit.launchPersistentContext(profile, { viewport: { width: 1180, height: 820 } });
  try {
    await writeOpfs(ctx, FRESH);
    let page = await open(ctx);
    const t0 = Date.now();
    const r = await page.evaluate(() => (window as any).__maquette.budget.runBench());
    const wallMs = Date.now() - t0;
    expect(r).not.toBeNull();
    expect(r.sizes.length).toBeGreaterThanOrEqual(2);
    expect(r.totalMs).toBeLessThanOrEqual(13_000);
    expect(r.comfortableTris).toBeGreaterThan(0);
    for (const z of r.sizes) expect(z.frames).toBeGreaterThanOrEqual(72);
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('.budget')).toContainText(/Comfortable [\d.]+[kM]? triangles · speed test/);
    await page.close();
    // Stored: the next launch shows it without measuring again.
    page = await open(ctx);
    const b = await budgetOf(page);
    expect(b.bench?.comfortableTris).toBe(r.comfortableTris);
    const big = r.sizes[r.sizes.length - 1];
    record({ benchMs: r.totalMs, benchWallMs: wallMs, comfortableTris: r.comfortableTris, limitedBy: r.limitedBy, benchSizes: r.sizes.map((z: any) => `${z.tris}: p95 ${z.frameMs.p95} ms`), benchBiggest: `${big.tris} tris p95 ${big.frameMs.p95} ms` });
  } finally {
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('PLT-8: stress test: deliberate exit, durable marker, budget = 0.6 x what this machine held', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'maquette-plt8s-'));
  let ctx = await webkit.launchPersistentContext(profile, { viewport: { width: 1180, height: 820 } });
  try {
    await writeOpfs(ctx, FRESH);
    let page = await open(ctx);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Stress-test this iPad…' }).click();
    await expect(page.getByText('Maquette will close.')).toBeVisible();
    // The real button uses a 16 GB cap; this run stops itself by closing the browser at >= 320 MB.
    await page.evaluate(() => (window as any).__maquette.budget.startStressTest({ capMB: 4096, stepMB: 64, pauseMs: 30 }));
    await page.waitForFunction(() => (window as any).__maquette.budget.stress.value.lastOkMB >= 320, null, { timeout: 60_000 });
    const app = await page.evaluate(() => {
      const s = (window as any).__maquette.ui.stats.value;
      return s.wasmMiB + s.gpuMiB;
    });
    await ctx.close(); // the "kill": nothing gets to clean up
    ctx = await webkit.launchPersistentContext(profile, { viewport: { width: 1180, height: 820 } });
    page = await open(ctx);
    const b = await budgetOf(page);
    expect(b.basis).toBe('stress-test');
    expect(b.stress?.outcome).toBe('killed');
    expect(b.stress!.lastOkMB).toBeGreaterThanOrEqual(320);
    expect(b.stress!.appMB).toBe(Math.round(app));
    expect(b.budgetMB).toBe(Math.max(256, Math.round(0.6 * (b.stress!.lastOkMB + b.stress!.appMB))));
    expect(b.sessions).toBe(0); // the deliberate exit taught the learning nothing
    expect(await page.evaluate(() => (window as any).__maquette.ui.notice.value?.text)).toContain('before iPadOS closed Maquette');
    // A run that survives to its cap is a lower bound: it is recorded and never lowers the budget.
    await page.evaluate(() => (window as any).__maquette.budget.startStressTest({ capMB: 128, stepMB: 64, pauseMs: 10 }));
    await page.waitForFunction(() => (window as any).__maquette.budget.state.value.stress?.outcome === 'capped', null, { timeout: 30_000 });
    const c = await budgetOf(page);
    expect(c.budgetMB).toBe(b.budgetMB);
    record({ stressLastOkMB: b.stress!.lastOkMB, stressAppMB: b.stress!.appMB, stressBudgetMB: b.budgetMB });
  } finally {
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
