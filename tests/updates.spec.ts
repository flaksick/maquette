// PLT-3 safe updates (invariant 8), in WebKit served like GitHub Pages. Each test lays out its own
// prod tree under the served root (deploy-e2e/plt3*/ -> /maquette/plt3*/), so the service worker's
// scope is that folder; everything the worker does is relative to its scope, as on /maquette/.
// Projects live in OPFS (app-prod), which Playwright's WebKit shares across profiles on one port,
// so each test starts by deleting it (only this test origin's copy, never a device's).
import { expect, test, webkit, type BrowserContext, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleProd, restamp } from '../scripts/release.mjs';

const PORT = process.env.MAQUETTE_PORT ?? '8787';
const DEPLOY = process.env.MAQUETTE_DEPLOY ?? 'deploy';
const ORIGIN = `http://localhost:${PORT}`;
const OUT = 'test-results/plt3-updates.json';
const timings: Record<string, number> = {};

function record(k: Record<string, unknown>): void {
  mkdirSync('test-results', { recursive: true });
  const cur = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
  writeFileSync(OUT, JSON.stringify({ ...cur, ...k, timings: { ...(cur.timings ?? {}), ...timings } }, null, 1));
}

/** A page in this origin outside every Maquette scope (a 404), for storage and worker chores. */
async function chorePage(ctx: BrowserContext): Promise<Page> {
  const p = await ctx.newPage();
  await p.goto(`${ORIGIN}/maquette/__chores__`);
  return p;
}
async function clearProjects(ctx: BrowserContext): Promise<void> {
  const p = await chorePage(ctx);
  await p.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('app-prod', { recursive: true }).catch(() => {});
  });
  await p.close();
}
/** Waits until the worker for `scope` has no waiting successor (it activated). */
async function settleWorker(ctx: BrowserContext, scope: string): Promise<void> {
  const p = await chorePage(ctx);
  await p.waitForFunction(async (s) => {
    const r = await navigator.serviceWorker.getRegistration(s);
    return !!r?.active && !r.waiting && !r.installing;
  }, scope, { timeout: 30_000, polling: 200 });
  await p.close();
}
async function closeAll(ctx: BrowserContext): Promise<void> {
  for (const p of ctx.pages()) await p.close();
}
async function launch(ctx: BrowserContext, url: string, errors: string[] = []): Promise<Page> {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  if (process.env.PLT3_DEBUG) page.on('console', (m) => console.log('[console]', m.type(), m.text()));
  await page.goto(url);
  return page;
}
async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__maquette?.ui.ready.value === true, null, { timeout: 60_000 });
}
const scriptSrc = (page: Page) => page.evaluate(() => [...document.querySelectorAll('script[src]')].map((s) => (s as HTMLScriptElement).src).join(' '));
const hash = (page: Page) => page.evaluate(async () => (await (window as any).__maquette.query()).hash as string);
/** The worker's own view (status message), from inside a controlled page. */
async function swStatus(page: Page): Promise<any> {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const c = navigator.serviceWorker.controller;
        if (!c) return resolve(null);
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => resolve(e.data);
        c.postMessage({ type: 'status' }, [ch.port2]);
      }),
  );
}
async function stroke(page: Page, dx = 0): Promise<void> {
  const box = (await page.locator('#scene').boundingBox())!;
  const cx = box.x + box.width / 2 + dx;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 60, cy - 20);
  await page.mouse.down();
  for (let i = 0; i <= 12; i++) await page.mouse.move(cx - 60 + i * 10, cy - 20 + i * 3);
  await page.mouse.up();
}
async function strokeSaved(page: Page, dx = 0): Promise<void> {
  const before = await page.evaluate(() => (window as any).__maquette.ui.saved.value?.seq ?? 0);
  await stroke(page, dx);
  await page.waitForFunction((s) => ((window as any).__maquette.ui.saved.value?.seq ?? 0) > s, before, { timeout: 20_000 });
}

test('PLT-3: the installed P1a app (gh-pages) updates into version folders, works offline and keeps every project', async () => {
  const tree = join(DEPLOY, 'plt3m');
  const base = `${ORIGIN}/maquette/plt3m/`;
  rmSync(tree, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  // 1. Exactly what users have installed today: the deployed prod tree (local gh-pages branch).
  execSync(`git archive gh-pages | tar -x -C "${tree}"`);
  rmSync(join(tree, 'dev'), { recursive: true, force: true });
  const legacy = JSON.parse(readFileSync(join(tree, 'precache.json'), 'utf8')).version as string;
  const profile = mkdtempSync(join(tmpdir(), 'maquette-plt3m-'));
  const ctx = await webkit.launchPersistentContext(profile, { viewport: { width: 1180, height: 820 } });
  const errors: string[] = [];
  try {
    await clearProjects(ctx);
    let page = await launch(ctx, base, errors);
    await ready(page);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30_000 });
    expect((await swStatus(page)).verified).toBe(true);
    // Two projects, each sculpted and saved (P1a's New replaces the open project with a new one).
    await strokeSaved(page);
    const hA = await hash(page);
    await page.evaluate(() => (window as any).__maquette.send({ type: 'new-sphere', n: 64 }));
    await page.waitForFunction(() => (window as any).__maquette.ui.stats.value?.tris === 49152, null, { timeout: 20_000 });
    await strokeSaved(page, 40);
    const hB = await hash(page);
    await closeAll(ctx);

    // 2. The first release with version folders lands on the server.
    const rel = assembleProd({ dist: 'dist/app-prod', root: tree });
    expect(existsSync(join(tree, 'assets'))).toBe(false);

    // 3. The user opens Maquette online: P1a starts as usual, its update check installs the new
    //    worker, which downloads and verifies v/<id>/ and adopts the P1a cache. No swap mid-session.
    let t = Date.now();
    page = await launch(ctx, base, errors);
    await ready(page);
    expect(await scriptSrc(page)).not.toContain('/v/');
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting, null, { timeout: 60_000, polling: 200 });
    timings.migrationInstallMs = Date.now() - t;
    expect(await scriptSrc(page)).not.toContain('/v/'); // still the P1a session
    expect(await hash(page)).toBe(hB);
    await closeAll(ctx);
    await settleWorker(ctx, base);

    // 4. Next launch: the new version, the same projects.
    t = Date.now();
    page = await launch(ctx, base, errors);
    await ready(page);
    timings.migrationFirstLaunchMs = Date.now() - t;
    expect(await scriptSrc(page)).toContain(`/v/${rel.version}/`);
    expect(await hash(page)).toBe(hB);
    await page.waitForFunction(async (id) => {
      const st: any = await new Promise((resolve) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => resolve(e.data);
        navigator.serviceWorker.controller!.postMessage({ type: 'status' }, [ch.port2]);
      });
      return st.good.includes(id);
    }, rel.version, { timeout: 20_000, polling: 300 });
    const st = await swStatus(page);
    expect(st.good).toEqual([legacy, rel.version]); // the P1a version stays as the fallback
    const projects: { id: string }[] = await page.evaluate(() => (window as any).__maquette.library.call({ op: 'list' }));
    const hashes: string[] = [];
    for (const p of projects) {
      await page.evaluate((id) => (window as any).__maquette.library.openProject(id), p.id);
      hashes.push(await hash(page));
    }
    expect(projects.length).toBe(2);
    expect(hashes.sort()).toEqual([hA, hB].sort());

    // 5. Offline cold launch of the new version.
    await ctx.setOffline(true);
    await closeAll(ctx);
    t = Date.now();
    page = await launch(ctx, base, errors);
    await ready(page);
    timings.migrationOfflineLaunchMs = Date.now() - t;
    expect(await scriptSrc(page)).toContain(`/v/${rel.version}/`);
    expect([hA, hB]).toContain(await hash(page));
    const keys: string[] = await page.evaluate(() => caches.keys());
    expect(keys).toContain(`maquette-prod-${legacy}`);
    await ctx.setOffline(false);
    record({ migration: { legacy, version: rel.version, projects: projects.length, hashesKept: 2, good: st.good } });
  } finally {
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
    rmSync(tree, { recursive: true, force: true });
  }
  expect(errors).toEqual([]);
});

test('PLT-3: v1 -> v2 -> broken v3: updates apply on a cold launch, two failed boots revert to v2, nothing lost', async () => {
  const tree = join(DEPLOY, 'plt3');
  const base = `${ORIGIN}/maquette/plt3/`;
  rmSync(tree, { recursive: true, force: true });
  // Three releases from one build: v2 differs by one comment; v3 throws at startup but is
  // internally consistent, so it downloads and verifies like any release.
  const work = mkdtempSync(join(tmpdir(), 'maquette-plt3-builds-'));
  const mk = (name: string, edit: (main: string) => string) => {
    const dir = join(work, name);
    cpSync('dist/app-prod', dir, { recursive: true });
    const main = /src="\.\/(assets\/index-[^"]+\.js)"/.exec(readFileSync(join(dir, 'index.html'), 'utf8'))![1];
    writeFileSync(join(dir, main), edit(readFileSync(join(dir, main), 'utf8')));
    return { dir, id: restamp(dir) };
  };
  const v1 = mk('v1', (s) => s);
  const v2 = mk('v2', (s) => s + '\n/* v2 */\n');
  const v3 = mk('v3', () => "throw new Error('broken v3');\n");
  const profile = mkdtempSync(join(tmpdir(), 'maquette-plt3-'));
  const ctx = await webkit.launchPersistentContext(profile, { viewport: { width: 1180, height: 820 } });
  const errors: string[] = [];
  const goodIncludes = (page: Page, id: string) =>
    page.waitForFunction(
      async (id) => {
        const c = navigator.serviceWorker.controller;
        if (!c) return false;
        const st: any = await new Promise((resolve) => {
          const ch = new MessageChannel();
          ch.port1.onmessage = (e) => resolve(e.data);
          c.postMessage({ type: 'status' }, [ch.port2]);
        });
        return st.good.includes(id);
      },
      id,
      { timeout: 30_000, polling: 300 },
    );
  const checkUpdate = async (page: Page) => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Check for updates now' }).click();
    await expect(page.locator('.sheet')).toContainText(/downloaded and verified|latest|failed to start/, { timeout: 60_000 });
    const text = await page.locator('.sheet').innerText();
    await page.getByRole('button', { name: 'Close' }).click();
    return text;
  };
  try {
    await clearProjects(ctx);
    // v1: first visit (boot page), the worker installs and takes over; v1 opens a project -> good.
    assembleProd({ dist: v1.dir, root: tree });
    let t = Date.now();
    let page = await launch(ctx, base, errors);
    await ready(page);
    await goodIncludes(page, v1.id);
    timings.v1InstallMs = Date.now() - t;
    await strokeSaved(page);
    const h1 = await hash(page);

    // v2 is deployed. The check downloads and verifies it; nothing changes mid-session, and a second
    // window opened now still gets v1 (not a cold launch).
    assembleProd({ dist: v2.dir, root: tree });
    t = Date.now();
    expect(await checkUpdate(page)).toContain('downloaded and verified');
    timings.v2DownloadVerifyMs = Date.now() - t;
    expect(await scriptSrc(page)).toContain(`/v/${v1.id}/`);
    const second = await launch(ctx, base, errors);
    await ready(second);
    expect(await scriptSrc(second)).toContain(`/v/${v1.id}/`);
    await closeAll(ctx);

    // Cold launch: v2, same project.
    t = Date.now();
    page = await launch(ctx, base, errors);
    await ready(page);
    timings.v2ColdLaunchMs = Date.now() - t;
    expect(await scriptSrc(page)).toContain(`/v/${v2.id}/`);
    expect(await hash(page)).toBe(h1);
    await goodIncludes(page, v2.id);

    // Broken v3 is deployed and downloaded. Two cold launches fail; the third runs v2 again.
    assembleProd({ dist: v3.dir, root: tree });
    expect(await checkUpdate(page)).toContain('downloaded and verified');
    await closeAll(ctx);
    for (const n of [1, 2]) {
      const errs: string[] = [];
      t = Date.now();
      page = await launch(ctx, base, errs);
      await page.waitForTimeout(2500);
      expect(await scriptSrc(page)).toContain(`/v/${v3.id}/`);
      expect(errs.join(' ')).toContain('broken v3');
      expect(await page.evaluate(() => !!(window as any).__maquette)).toBe(false);
      timings[`v3FailedBoot${n}Ms`] = Date.now() - t;
      await closeAll(ctx);
    }
    t = Date.now();
    page = await launch(ctx, base, errors);
    await ready(page);
    timings.revertLaunchMs = Date.now() - t;
    expect(await scriptSrc(page)).toContain(`/v/${v2.id}/`);
    expect(await hash(page)).toBe(h1); // v3 never touched the projects
    const st = await swStatus(page);
    expect(st.reverted).toMatchObject({ from: v3.id, to: v2.id });
    expect(st.bad).toEqual([v3.id]);
    await expect(page.locator('.notice')).toContainText(`version ${v3.id} failed to start twice`);
    // The bad version is never tried again, even though the server still lists it.
    expect(await checkUpdate(page)).toContain('failed to start');
    await closeAll(ctx);
    page = await launch(ctx, base, errors);
    await ready(page);
    expect(await scriptSrc(page)).toContain(`/v/${v2.id}/`);
    record({ updates: { v1: v1.id, v2: v2.id, v3: v3.id, reverted: st.reverted, bad: st.bad } });
    console.log(JSON.stringify({ timings }, null, 1));
  } finally {
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
    rmSync(tree, { recursive: true, force: true });
  }
  expect(errors).toEqual([]);
});
