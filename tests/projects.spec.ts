// P1b projects in WebKit: the gallery (PRJ-1), project files (PRJ-5) and back up all (PRJ-6).
// Each test runs in its own persistent profile (WebKit's ephemeral contexts reject OPFS) and
// records its measured numbers in test-results/<id>.json.
import { expect, test, webkit, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

const URL = process.env.MAQUETTE_APP_URL ?? `http://localhost:${process.env.MAQUETTE_PORT ?? '8787'}/maquette/dev/`;

interface Info {
  id: string;
  name: string;
  tris: number;
  bytes: number;
  deletedAt: string | null;
  current: boolean;
}

async function launch(): Promise<{ ctx: BrowserContext; page: Page; done: () => Promise<void>; errors: string[] }> {
  const profile = mkdtempSync(join(tmpdir(), 'maquette-prj-'));
  const ctx = await webkit.launchPersistentContext(profile, { viewport: { width: 1180, height: 820 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await wipe(page);
  await page.goto(URL);
  await ready(page);
  return {
    ctx,
    page,
    errors,
    done: async () => {
      await wipe(page).catch(() => {});
      await ctx.close();
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
/** WebKit keeps OPFS per origin in one place for every Playwright profile
 *  (~/Library/WebKit/org.webkit.Playwright/WebsiteData), so a fresh profile is not a fresh disk:
 *  each test starts (and ends) by deleting the dev channel's storage from a page without workers. */
async function wipe(page: Page): Promise<void> {
  await page.goto(`${URL}precache.json`);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('app-dev', { recursive: true }).catch(() => {});
  });
}
async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__maquette?.ui.ready.value === true, null, { timeout: 60_000 });
}
async function q(page: Page): Promise<{ hash: string; stats: any }> {
  return page.evaluate(() => (window as any).__maquette.query());
}
async function lib<T = any>(page: Page, req: Record<string, unknown>): Promise<T> {
  return page.evaluate((r) => (window as any).__maquette.library.call(r), req);
}
async function list(page: Page): Promise<Info[]> {
  return lib<Info[]>(page, { op: 'list' });
}
async function currentId(page: Page): Promise<string> {
  return (await list(page)).find((p) => p.current)!.id;
}
/** A mouse stroke across the canvas, then waits until the engine's journal ack covers it. */
async function strokeSaved(page: Page, dx = 0): Promise<string> {
  const before = (await q(page)).stats.seq;
  const box = (await page.locator('#scene').boundingBox())!;
  const cx = box.x + box.width / 2 + dx;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 60, cy - 20);
  await page.mouse.down();
  for (let i = 0; i <= 12; i++) await page.mouse.move(cx - 60 + i * 10, cy - 20 + i * 3);
  await page.mouse.up();
  await expect.poll(async () => {
    const s = (await q(page)).stats;
    return s.seq > before && s.lastAcked >= s.seq;
  }, { timeout: 20_000 }).toBe(true);
  return (await q(page)).hash;
}
async function waitCurrent(page: Page, pred: (id: string) => boolean): Promise<string> {
  let id = '';
  await expect.poll(async () => pred((id = await currentId(page))), { timeout: 30_000 }).toBe(true);
  return id;
}
function save(name: string, data: unknown): void {
  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/${name}.json`, JSON.stringify(data, null, 1));
  console.log(JSON.stringify(data, null, 1));
}
/** Interactive elements inside the open sheet with neither data-feature nor data-ui="chrome". */
async function untagged(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.sheet button, .sheet input, .sheet select, .sheet textarea, .sheet a[href]')]
      .filter((e) => !e.hasAttribute('data-feature') && e.getAttribute('data-ui') !== 'chrome')
      .map((e) => e.outerHTML.slice(0, 80)),
  );
}
const row = (page: Page, id: string) => page.locator(`li[data-project="${id}"]`);
/** Expands Recently Deleted (the toggle remembers its state between openings). */
async function showTrash(page: Page): Promise<void> {
  const b = page.getByRole('button', { name: /^Recently Deleted/ });
  if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click();
}

test('PRJ-1: gallery creates, switches, renames, duplicates, deletes to Recently Deleted, restores and purges', async () => {
  const { page, done, errors } = await launch();
  const r: Record<string, unknown> = {};
  try {
    const idA = await currentId(page);
    const hA = await strokeSaved(page);

    // New project from the gallery.
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await expect(page.locator('ul.projects li.project')).toHaveCount(1);
    await page.getByRole('button', { name: 'New sphere…' }).click();
    await page.getByRole('button', { name: 'Create' }).click();
    const idB = await waitCurrent(page, (id) => id !== idA);
    const hB0 = (await q(page)).hash;
    const hB = await strokeSaved(page, 40);
    expect(hB).not.toBe(hB0);

    // Switch both ways through the gallery: each project reopens exactly as saved.
    const switchMs: number[] = [];
    for (const [id, h] of [
      [idA, hA],
      [idB, hB],
    ] as const) {
      await page.getByRole('button', { name: 'Projects', exact: true }).click();
      await expect(page.locator('ul.projects li.project')).toHaveCount(2);
      const t0 = Date.now();
      await row(page, id).getByRole('button', { name: 'Open' }).click();
      await waitCurrent(page, (c) => c === id);
      switchMs.push(Date.now() - t0);
      expect((await q(page)).hash).toBe(h);
    }
    r.switchMs = switchMs;
    r.hashesMatchAfterSwitch = true;

    // Rename A; the name survives a relaunch.
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await row(page, idA).getByRole('button', { name: 'Rename' }).click();
    r.untaggedWhileRenaming = (await untagged(page)).length;
    await row(page, idA).locator('input.rename').fill('Bust study');
    await row(page, idA).getByRole('button', { name: 'Save' }).click();
    await expect(row(page, idA).locator('.project-name')).toHaveText('Bust study');
    await page.reload();
    await ready(page);
    expect((await list(page)).find((p) => p.id === idA)?.name).toBe('Bust study');
    expect(await currentId(page)).toBe(idB);
    expect((await q(page)).hash).toBe(hB);
    r.renameSurvivesRelaunch = true;

    // Duplicate A: an identical, independent project.
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await row(page, idA).getByRole('button', { name: 'Duplicate' }).click();
    await expect(page.locator('ul.projects li.project')).toHaveCount(3);
    const copy = (await list(page)).find((p) => p.name === 'Bust study copy')!;
    expect(copy).toBeTruthy();
    await row(page, copy.id).getByRole('button', { name: 'Open' }).click();
    await waitCurrent(page, (c) => c === copy.id);
    expect((await q(page)).hash).toBe(hA);
    r.duplicateHashMatches = true;

    // Delete the open project (the copy): the gallery switches away first, then it moves to
    // Recently Deleted.
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await row(page, copy.id).getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('button', { name: 'Recently Deleted (1)' })).toBeVisible();
    await expect(page.locator('ul.projects li.project')).toHaveCount(2);
    const afterDelete = await currentId(page);
    expect(afterDelete).not.toBe(copy.id);
    // Delete B too, then restore it.
    await row(page, idB).getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('button', { name: 'Recently Deleted (2)' })).toBeVisible();
    await showTrash(page);
    r.untaggedWithTrashOpen = (await untagged(page)).length;
    await row(page, idB).getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByRole('button', { name: 'Recently Deleted (1)' })).toBeVisible();
    await row(page, idB).getByRole('button', { name: 'Open' }).click();
    await waitCurrent(page, (c) => c === idB);
    expect((await q(page)).hash).toBe(hB);
    r.restoredHashMatches = true;

    // Purge the copy for good: two taps, and its folder is gone.
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await showTrash(page);
    await row(page, copy.id).getByRole('button', { name: 'Delete now…' }).click();
    await row(page, copy.id).getByRole('button', { name: 'Delete forever' }).click();
    await expect(page.getByRole('button', { name: 'Recently Deleted (0)' })).toBeVisible();
    const folders = await lib<{ total: number; withManifest: number }>(page, { op: 'debug-folders' });
    r.foldersAfterPurge = folders;
    expect(folders).toEqual({ total: 2, withManifest: 2 });
    r.untaggedInGallery = (await untagged(page)).length;
    await page.getByRole('button', { name: 'Close' }).click();

    // 30-day rule: an entry deleted 31 days ago is purged by the session's maintenance; an
    // interrupted write's manifest-less folder is removed too.
    const dup = await lib<Info>(page, { op: 'duplicate', projectId: idA });
    await lib(page, { op: 'trash', projectId: dup.id });
    await lib(page, { op: 'debug-backdate', projectId: dup.id, days: 31 });
    const garbageId = await lib<string>(page, { op: 'debug-garbage' });
    const m = await lib<{ purged: number; garbage: number }>(page, { op: 'maintenance', minAgeMs: 0 });
    r.maintenance = m;
    expect(m.purged).toBe(1);
    expect(m.garbage).toBe(1);
    const ids = (await list(page)).map((p) => p.id);
    expect(ids).not.toContain(dup.id);
    expect(ids).not.toContain(garbageId);
    expect(await lib(page, { op: 'debug-folders' })).toEqual({ total: 2, withManifest: 2 });

    // Portrait iPad Air: the gallery fits without horizontal scrolling.
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await expect(page.locator('ul.projects li.project')).toHaveCount(2);
    const fit = await page.evaluate(() => ({ docW: document.documentElement.scrollWidth, winW: innerWidth, sheetW: document.querySelector('.sheet')!.getBoundingClientRect().width }));
    r.portrait = fit;
    expect(fit.docW).toBeLessThanOrEqual(fit.winW);
    await page.screenshot({ path: 'test-results/prj1-gallery-portrait.png' });
    expect(r.untaggedWhileRenaming).toBe(0);
    expect(r.untaggedWithTrashOpen).toBe(0);
    expect(r.untaggedInGallery).toBe(0);
  } finally {
    r.pageErrors = errors;
    save('prj1-gallery', r);
    await done();
  }
  expect(errors).toEqual([]);
});
