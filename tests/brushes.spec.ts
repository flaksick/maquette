// The brush set end to end in WebKit: every tool in the palette sculpts the mesh, the stroke is
// journaled, and Undo restores the exact pre-stroke hash; the palette and brush panel fit an
// iPad Air in both orientations. Per-brush geometry is pinned by the Rust tests (brushes.rs).
import { expect, test, webkit, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.MAQUETTE_APP_URL ?? `http://localhost:${process.env.MAQUETTE_PORT ?? '8787'}/maquette/dev/`;

const ready = (page: Page) => page.waitForFunction(() => (window as any).__maquette?.ui.ready.value === true, null, { timeout: 60_000 });
const hash = async (page: Page): Promise<string> => (await page.evaluate(() => (window as any).__maquette.query())).hash;
const seqNow = (page: Page): Promise<number> => page.evaluate(() => (window as any).__maquette.ui.stats.value?.seq ?? 0);
const waitSaved = (page: Page, seq: number) =>
  page.waitForFunction((s) => ((window as any).__maquette.ui.saved.value?.seq ?? 0) >= s, seq, { timeout: 20_000 });

/** A mouse stroke over the middle of the sphere (mouse = full pressure). Drags pull outward. */
async function stroke(page: Page, drag: boolean): Promise<void> {
  const box = (await page.locator('#scene').boundingBox())!;
  const cx = box.x + box.width / 2 + 30; // off the X mirror plane, so mirrored drags don't cancel
  const cy = box.y + box.height / 2 - 20;
  await page.mouse.move(cx - 50, cy);
  await page.mouse.down();
  for (let i = 0; i <= 12; i++) await page.mouse.move(cx - 50 + i * 8, cy + (drag ? -i * 4 : i * 2));
  await page.mouse.up();
}

/** Sets a range input the way a finger drag does (input event). */
const setRange = (page: Page, label: string, v: number) =>
  page.evaluate(([l, val]) => {
    const input = [...document.querySelectorAll('.brushopts label')].find((e) => e.textContent?.startsWith(l as string))?.querySelector('input') as HTMLInputElement;
    input.value = String(val);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, [label, v] as const);

test('BRS-1 BRS-2 BRS-3 BRS-4 BRS-5 BRS-6 BRS-7 BRS-8 BRS-9 BRS-10 BRS-11 STK-4 STK-11 SYM-1: every tool sculpts and undoes exactly; the palette fits an iPad Air', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'maquette-brushes-'));
  const ctx = await webkit.launchPersistentContext(profile, { viewport: { width: 1180, height: 820 } });
  const errors: string[] = [];
  const results: Record<string, unknown> = {};
  try {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(URL);
    await ready(page);

    // The palette and panel stay on screen and clear of the size/strength sliders.
    for (const [w, h] of [[1180, 820], [820, 1180]]) {
      await page.setViewportSize({ width: w, height: h });
      const fit = await page.evaluate(([vw, vh]) => {
        const tools = document.querySelector('.tools')!.getBoundingClientRect();
        const sliders = document.querySelector('.sliders')!.getBoundingClientRect();
        const controls = [...document.querySelectorAll('.tools button, .tools select, .tools input')].map((e) => e.getBoundingClientRect());
        return {
          controls: controls.length,
          offscreen: controls.filter((r) => r.left < 0 || r.top < 0 || r.right > vw || r.bottom > vh).length,
          overlapsSliders: tools.right > sliders.left,
          bottom: Math.round(tools.bottom),
        };
      }, [w, h]);
      results[`fit ${w}x${h}`] = fit;
      expect(fit.offscreen).toBe(0);
      expect(fit.overlapsSliders).toBe(false);
    }
    await page.setViewportSize({ width: 1180, height: 820 });

    // The brush panel drives the engine: sharp falloff, 50% hardness, auto-smooth, mirror Y.
    await page.locator('[data-tool="draw"]').click();
    await page.locator('.brushopts select').selectOption('sharp');
    await setRange(page, 'Hardness', 0.5);
    await setRange(page, 'Auto-smooth', 0.3);
    await page.getByRole('button', { name: 'Mirror Y' }).click();
    expect(await page.evaluate(() => (window as any).__maquette.ui.brush())).toMatchObject({ falloff: 'sharp', hardness: 0.5, autosmooth: 0.3, symmetryX: true, symmetryY: true });

    const tools: string[] = await page.locator('[data-tool]').evaluateAll((els) => els.map((e) => e.getAttribute('data-tool')!));
    expect(tools).toHaveLength(14);
    const perTool: Record<string, string> = {};
    for (const t of tools) {
      await page.locator(`[data-tool="${t}"]`).click();
      const h0 = await hash(page);
      const s0 = await seqNow(page);
      await stroke(page, t === 'grab' || t === 'snake-hook');
      await waitSaved(page, s0 + 1);
      const h1 = await hash(page);
      await page.getByRole('button', { name: /^Undo/ }).click();
      await waitSaved(page, s0 + 2);
      const h2 = await hash(page);
      perTool[t] = h1 !== h0 && h2 === h0 ? 'changed, undo exact' : h1 === h0 ? 'NO CHANGE' : 'UNDO MISMATCH';
    }
    results.tools = perTool;
    expect(Object.values(perTool).every((v) => v === 'changed, undo exact')).toBe(true);
  } finally {
    results.pageErrors = errors;
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/brushes-webkit.json', JSON.stringify(results, null, 1));
    console.log(JSON.stringify(results, null, 1));
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
  }
  expect(errors).toEqual([]);
});
