// Shade Smooth / Shade Flat and the wireframe overlay (PNT-6) in WebKit: each changes the rendered
// pixels, switching back restores them exactly, idle stays free, and the setting is part of the
// project's view state (PRJ-10): it survives a relaunch with identical pixels.
import { expect, test, webkit, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.MAQUETTE_APP_URL ?? `http://localhost:${process.env.MAQUETTE_PORT ?? '8787'}/maquette/dev/`;

const ready = (page: Page) => page.waitForFunction(() => (window as any).__maquette?.ui.ready.value === true, null, { timeout: 60_000 });
const frames = async (page: Page): Promise<number> => (await page.evaluate(() => (window as any).__maquette.query())).stats.frames;

/** Hash of the middle of the canvas (no UI overlaps it), once two captures in a row agree. */
async function shot(page: Page): Promise<string> {
  const box = (await page.locator('#scene').boundingBox())!;
  const clip = { x: box.x + box.width / 2 - 150, y: box.y + box.height / 2 - 150, width: 300, height: 300 };
  let last = '';
  for (let i = 0; i < 20; i++) {
    const h = createHash('sha256').update(await page.screenshot({ clip })).digest('hex').slice(0, 16);
    if (h === last) return h;
    last = h;
    await page.waitForTimeout(100);
  }
  throw new Error('canvas never settled');
}

/** Clicks a view control and waits until the engine has drawn the result. */
async function toggle(page: Page, name: string): Promise<void> {
  const f0 = await frames(page);
  await page.getByRole('button', { name, exact: true }).click();
  await page.waitForFunction(async (f) => (await (window as any).__maquette.query()).stats.frames > f, f0, { timeout: 10_000 });
}

test('PNT-6 PRJ-10: Flat and wireframe change the pixels, Smooth restores them exactly, the setting survives a relaunch', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'maquette-shading-'));
  const ctx = await webkit.launchPersistentContext(profile, { viewport: { width: 1180, height: 820 } });
  const errors: string[] = [];
  const results: Record<string, unknown> = {};
  try {
    let page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(URL);
    await ready(page);
    const smooth = await shot(page);

    await toggle(page, 'Shade Flat');
    const flat = await shot(page);
    await toggle(page, 'Shade Smooth');
    const smoothAgain = await shot(page);
    await toggle(page, 'Wireframe');
    const wire = await shot(page);
    await toggle(page, 'Wireframe');
    const unwired = await shot(page);
    results.hashes = { smooth, flat, smoothAgain, wire, unwired };
    expect(flat).not.toBe(smooth);
    expect(smoothAgain).toBe(smooth);
    expect(wire).not.toBe(smooth);
    expect(unwired).toBe(smooth);

    // Idle is free (PLT-10): a toggle draws once, then nothing.
    await toggle(page, 'Shade Flat');
    await page.waitForTimeout(500);
    const f0 = await frames(page);
    await page.waitForTimeout(2000);
    results.idleFramesIn2s = (await frames(page)) - f0;
    expect(results.idleFramesIn2s).toBe(0);
    const flatBeforeRelaunch = await shot(page);
    expect(flatBeforeRelaunch).toBe(flat);

    // Saved with the project's view state: relaunch shows Flat again, pixel for pixel.
    await page.waitForTimeout(2500); // the view state is written 1 s after the last change
    await page.close();
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(URL);
    await ready(page);
    const restored = await page.evaluate(() => (window as any).__maquette.ui.view.value);
    const flatAfterRelaunch = await shot(page);
    results.afterRelaunch = { view: restored, pixelsMatch: flatAfterRelaunch === flat };
    expect(restored).toEqual({ shading: 'flat', wireframe: false });
    expect(await page.getByRole('button', { name: 'Shade Flat', exact: true }).getAttribute('aria-pressed')).toBe('true');
    expect(flatAfterRelaunch).toBe(flat);

    // The controls fit an iPad Air both ways and stay clear of the HUD.
    for (const [w, h] of [[820, 1180], [1180, 820]]) {
      await page.setViewportSize({ width: w, height: h });
      const fit = await page.evaluate(([vw, vh]) => {
        const bar = document.querySelector('.viewbtns')!.getBoundingClientRect();
        const hud = document.querySelector('.hud')?.getBoundingClientRect();
        return { inside: bar.left >= 0 && bar.right <= vw && bar.bottom <= vh, clearOfHud: !hud || hud.right <= bar.left || hud.bottom <= bar.top };
      }, [w, h]);
      results[`fit ${w}x${h}`] = fit;
      expect(fit).toEqual({ inside: true, clearOfHud: true });
    }
  } finally {
    results.pageErrors = errors;
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/shading-webkit.json', JSON.stringify(results, null, 1));
    console.log(JSON.stringify(results, null, 1));
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
  }
  expect(errors).toEqual([]);
});
