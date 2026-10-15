// Hold-buttons (NAV-5) in WebKit: one hand holds Invert or Smooth at the left edge while the other
// draws. Held Invert makes a Draw stroke carve, held Smooth makes it smooth; the Draw tool stays
// selected, and Undo takes back exactly the held stroke. The surface radius under the stroke is
// read with the engine's probe (the default sphere has radius 1).
import { expect, test, webkit, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.MAQUETTE_APP_URL ?? `http://localhost:${process.env.MAQUETTE_PORT ?? '8787'}/maquette/dev/`;
const M = (page: Page) => page.evaluate.bind(page);

const ready = (page: Page) => page.waitForFunction(() => (window as any).__maquette?.ui.ready.value === true, null, { timeout: 60_000 });
const seqNow = (page: Page): Promise<number> => M(page)(() => (window as any).__maquette.ui.stats.value?.seq ?? 0);
const waitSaved = (page: Page, seq: number) => page.waitForFunction((s) => ((window as any).__maquette.ui.saved.value?.seq ?? 0) >= s, seq, { timeout: 20_000 });

/** Hash, and the surface radius under the middle of the canvas. */
async function probe(page: Page): Promise<{ hash: string; radius: number }> {
  const box = (await page.locator('#scene').boundingBox())!;
  const q = await M(page)((at) => (window as any).__maquette.query(at), { x: box.width / 2, y: box.height / 2 });
  return { hash: q.hash, radius: Math.hypot(q.hit[0], q.hit[1], q.hit[2]) };
}

/** A mouse stroke through the middle of the canvas; resolves when it is journaled. */
async function stroke(page: Page): Promise<void> {
  const s0 = await seqNow(page);
  const box = (await page.locator('#scene').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 60, cy);
  await page.mouse.down();
  for (let i = 0; i <= 12; i++) await page.mouse.move(cx - 60 + i * 10, cy);
  await page.mouse.up();
  await waitSaved(page, s0 + 1);
}

/** A finger on a hold-button (a second pointer, as the off hand). */
const hold = (page: Page, name: 'smooth' | 'invert', down: boolean) =>
  M(page)(([n, d]) => {
    const b = document.querySelector(`[data-hold="${n}"]`)!;
    b.dispatchEvent(new PointerEvent(d ? 'pointerdown' : 'pointerup', { bubbles: true, pointerId: 41, pointerType: 'touch' }));
  }, [name, down] as const);

async function undo(page: Page): Promise<void> {
  const s0 = await seqNow(page);
  await page.getByRole('button', { name: /^Undo/ }).click();
  await waitSaved(page, s0 + 1);
}

test('NAV-5 BRS-1 BRS-2: holding Invert carves and holding Smooth smooths the stroke; the tool stays; the buttons fit an iPad Air', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'maquette-holds-'));
  const ctx = await webkit.launchPersistentContext(profile, { viewport: { width: 1180, height: 820 } });
  const errors: string[] = [];
  const results: Record<string, unknown> = {};
  try {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(URL);
    await ready(page);
    await page.locator('[data-tool="draw"]').click();
    const start = await probe(page);

    // Held Invert: the Draw stroke carves.
    await hold(page, 'invert', true);
    await stroke(page);
    await hold(page, 'invert', false);
    const carved = await probe(page);
    const toolAfterInvert = await M(page)(() => (window as any).__maquette.ui.tool.value);
    await undo(page);
    const undone = await probe(page);

    // A plain Draw stroke raises a ridge. Held Smooth over it is exactly a Smooth-tool stroke
    // (the Smooth tool's strength, the current size): same hash, and it doesn't draw.
    await stroke(page);
    const raised = await probe(page);
    await hold(page, 'smooth', true);
    await stroke(page);
    await hold(page, 'smooth', false);
    const smoothed = await probe(page);
    const toolAfterSmooth = await M(page)(() => (window as any).__maquette.ui.tool.value);
    await undo(page);
    const smoothUndone = await probe(page);
    await M(page)(() => {
      const u = (window as any).__maquette.ui;
      u.tools.value = { ...u.tools.value, smooth: { ...u.tools.value.smooth, radius: u.tools.value.draw.radius } };
    });
    await page.locator('[data-tool="smooth"]').click();
    await stroke(page);
    const smoothTool = await probe(page);

    results.radius = { start: start.radius, heldInvert: carved.radius, plainDraw: raised.radius, heldSmooth: smoothed.radius };
    results.tool = { afterInvert: toolAfterInvert, afterSmooth: toolAfterSmooth };
    results.undo = { invertStroke: undone.hash === start.hash, smoothStroke: smoothUndone.hash === raised.hash };
    results.heldSmoothEqualsSmoothTool = smoothed.hash === smoothTool.hash;
    expect(carved.radius).toBeLessThan(start.radius - 1e-4);
    expect(raised.radius).toBeGreaterThan(start.radius + 1e-4);
    expect(smoothed.hash).not.toBe(raised.hash);
    expect(Math.abs(smoothed.radius - raised.radius)).toBeLessThan(0.25 * (raised.radius - start.radius));
    expect(smoothed.hash).toBe(smoothTool.hash);
    expect(toolAfterInvert).toBe('draw');
    expect(toolAfterSmooth).toBe('draw');
    expect(undone.hash).toBe(start.hash);
    expect(smoothUndone.hash).toBe(raised.hash);

    // The hold-buttons sit at the left edge, on screen, clear of the tool column and the HUD.
    for (const [w, h] of [[1180, 820], [820, 1180]]) {
      await page.setViewportSize({ width: w, height: h });
      const fit = await M(page)(([vw, vh]) => {
        const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
        const holds = r('.holds');
        const tools = r('.tools');
        const hud = document.querySelector('.hud')?.getBoundingClientRect();
        const apart = (a: DOMRect, b: DOMRect) => a.bottom <= b.top || b.bottom <= a.top || a.right <= b.left || b.right <= a.left;
        return { inside: holds.left >= 0 && holds.top >= 0 && holds.bottom <= vh && holds.right <= vw, clearOfTools: apart(holds, tools), clearOfHud: !hud || apart(holds, hud), left: Math.round(holds.left) };
      }, [w, h]);
      results[`fit ${w}x${h}`] = fit;
      expect(fit).toMatchObject({ inside: true, clearOfTools: true, clearOfHud: true });
    }
  } finally {
    results.pageErrors = errors;
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/holds-webkit.json', JSON.stringify(results, null, 1));
    console.log(JSON.stringify(results, null, 1));
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
  }
  expect(errors).toEqual([]);
});
