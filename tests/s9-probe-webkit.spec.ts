// Spike S9: does Playwright's WebKit run the production path? Drives the real probe build
// (served like GitHub Pages) in a PERSISTENT profile — WebKit's ephemeral contexts reject OPFS
// with UnknownError, like private browsing — and records which capabilities work off-device.
import { expect, test, webkit, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function waitStatus(page: Page, id: string, done: RegExp, timeout = 180_000) {
  await expect(page.locator(`#${id} .status`)).toHaveText(done, { timeout });
  const text = await page.locator(`#${id} pre.result`).textContent();
  return text ? JSON.parse(text) : null;
}

test('S9: probe runs in WebKit served like GitHub Pages', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'maquette-wk-'));
  const ctx = await webkit.launchPersistentContext(profile, { viewport: { width: 1180, height: 820 } });
  const page = await ctx.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  try {
    await page.goto(process.env.MAQUETTE_URL ?? `http://localhost:${process.env.MAQUETTE_PORT ?? '8787'}/maquette/dev/probe/`);
    // First load registers the service worker, which reloads the page once to get isolation.
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 60_000 });
    await page.waitForLoadState('load');
    await page.waitForSelector('#s3 button');

    const env = await page.evaluate(() => ({
      crossOriginIsolated,
      controlled: !!navigator.serviceWorker.controller,
      storageFailure: document.querySelector('main > p.status')?.textContent ?? null,
      userAgent: navigator.userAgent,
    }));

    await page.getByRole('button', { name: 'Run speed test' }).click();
    const s3 = await waitStatus(page, 's3', /speed test complete|error/);

    await page.getByRole('button', { name: 'Save-latency test (30 s)' }).click();
    const s2 = await waitStatus(page, 's2', /latency test complete|error/);

    await page.getByRole('button', { name: 'Run threads test' }).click();
    const s4 = await waitStatus(page, 's4', /threads test complete|error/);

    await page.getByRole('button', { name: 'Run upload test' }).click();
    const s5 = await waitStatus(page, 's5', /upload test complete|GPU error/);

    const report = { env, s3, s2, s4, s5, consoleErrors };
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/s9-webkit.json', JSON.stringify(report, null, 1));
    console.log(
      JSON.stringify(
        {
          env,
          s3: s3 && { selftest: s3.selftest, rustMs: s3.simd?.steady?.mean, scalarMs: s3.scalar?.steady?.mean, tsMs: s3.ts?.steady?.mean, tsOverRust: s3.tsOverRust, bitIdentical: s3.simdBitIdenticalToScalar, tsRelDiff: s3.tsChecksumRelDiff },
          s2: s2 && { single: s2.latencySingleWorker?.journalLatencyMs, two: s2.latencyTwoWorkers?.journalLatencyMs, chunkSingle: s2.latencySingleWorker?.checkpointChunkWriteFlushMs },
          s4: s4 && { coi: s4.crossOriginIsolated, best: s4.bestSpeedup, curve: s4.curve, ping: s4.pingRoundTripUs, shared: s4.sharedMemory },
          s5: s5 && { renderer: s5.caps?.renderer, multiDraw: s5.caps?.multiDraw, workerRaf: s5.caps?.workerRaf, upload: s5.upload },
          consoleErrors,
        },
        null,
        1,
      ),
    );
    expect(env.storageFailure).toBeNull();
    expect(consoleErrors).toEqual([]);
  } finally {
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
