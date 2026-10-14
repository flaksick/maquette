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

/** Reads a STORE-only ZIP's central directory (Node side, independent of the app's reader). */
function unzip(buf: Buffer): Map<string, { data: Buffer; crc: number }> {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('no end-of-central-directory record');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map<string, { data: Buffer; crc: number }>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central header');
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30);
    const comment = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    if (method !== 0) throw new Error(`${name} is not stored`);
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.set(name, { data: buf.subarray(dataAt, dataAt + size), crc });
    at += 46 + nameLen + extra + comment;
  }
  return out;
}
const crcOk = (z: Map<string, { data: Buffer; crc: number }>) => [...z.values()].every((e) => crc32(e.data) >>> 0 === e.crc);

test('PRJ-5: .maquette file exports, re-imports hash-identical, and refuses damaged files', async () => {
  const { page, done, errors } = await launch();
  const r: Record<string, unknown> = {};
  try {
    const src = await currentId(page);
    const h1 = await strokeSaved(page);

    // Export through the gallery (two-step: prepare, then a fresh tap on Download).
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    const t0 = Date.now();
    await row(page, src).getByRole('button', { name: 'Export' }).click();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-prepared="project"]').getByRole('button', { name: 'Download' }).click()]);
    r.exportMs = Date.now() - t0;
    const file = 'test-results/prj5-export.maquette';
    await dl.saveAs(file);
    r.fileName = dl.suggestedFilename();
    const bytes = readFileSync(file);
    const z = unzip(bytes);
    const meta = JSON.parse(z.get('maquette.json')!.data.toString('utf8'));
    r.file = { bytes: bytes.length, entries: [...z.keys()], crcsValid: crcOk(z), format: meta.format, formatVersion: meta.formatVersion, mesh: meta.mesh };
    expect(r.fileName).toMatch(/\.maquette$/);
    expect(crcOk(z)).toBe(true);
    expect(meta.format).toBe('maquette-project');
    expect(z.get('positions.bin')!.data.length).toBe(meta.mesh.verts * 12);

    // Import it back through the picker (no accept filter) and open the copy.
    const t1 = Date.now();
    await page.locator('input[type=file][data-feature="PRJ-5"]').setInputFiles(file);
    await expect(page.getByText('Imported 1 project.')).toBeVisible();
    r.importMs = Date.now() - t1;
    const imported = (await list(page)).find((p) => p.id !== src)!;
    await row(page, imported.id).getByRole('button', { name: 'Open' }).click();
    await waitCurrent(page, (c) => c === imported.id);
    const hImported = (await q(page)).hash;
    r.hashes = { exported: h1, reimported: hImported };
    expect(hImported).toBe(h1);

    // A project with records not yet checkpointed: the file carries them (journal.bin) and the
    // import replays them to the same mesh.
    const h2 = await strokeSaved(page, 30);
    const viaJournal = await page.evaluate(async (id) => {
      const lib = (window as any).__maquette.library;
      const exp = await lib.call({ op: 'export', projectId: id });
      const text = new TextDecoder().decode(new Uint8Array(await exp.file.arrayBuffer()));
      const imp = await lib.call({ op: 'import', file: exp.file });
      return { hasJournal: text.includes('journal.bin'), bytes: exp.bytes, id: imp.projects[0].id };
    }, imported.id);
    await page.evaluate((id) => (window as any).__maquette.library.openProject(id), viaJournal.id);
    const h2Imported = (await q(page)).hash;
    r.journalPath = { hasJournal: viaJournal.hasJournal, bytes: viaJournal.bytes, hashMatches: h2Imported === h2 };
    expect(viaJournal.hasJournal).toBe(true);
    expect(h2Imported).toBe(h2);

    // Damaged and foreign files are refused, and leave no project behind.
    const before = await lib<{ total: number; withManifest: number }>(page, { op: 'debug-folders' });
    const damaged = Buffer.from(bytes);
    const pos = z.get('positions.bin')!.data;
    damaged[pos.byteOffset - bytes.byteOffset + 100] ^= 0xff;
    writeFileSync('test-results/prj5-damaged.maquette', damaged);
    writeFileSync('test-results/prj5-foreign.maquette', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.locator('input[type=file][data-feature="PRJ-5"]').setInputFiles('test-results/prj5-damaged.maquette');
    await expect(page.getByText(/checksum mismatch/)).toBeVisible();
    await page.locator('input[type=file][data-feature="PRJ-5"]').setInputFiles('test-results/prj5-foreign.maquette');
    await expect(page.getByText(/not a Maquette project or backup/)).toBeVisible();
    const after = await lib<{ total: number; withManifest: number }>(page, { op: 'debug-folders' });
    r.refused = { before, after };
    expect(after).toEqual(before);
    expect(after.total).toBe(after.withManifest);
  } finally {
    r.pageErrors = errors;
    save('prj5-roundtrip', r);
    await done();
  }
  expect(errors).toEqual([]);
});

test('PRJ-6: back up all is one zip of every project; the gallery shows days since the last backup', async () => {
  const { page, done, errors } = await launch();
  const r: Record<string, unknown> = {};
  try {
    const idA = await currentId(page);
    const hA = await strokeSaved(page);
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: 'New sphere…' }).click();
    await page.getByRole('button', { name: 'Create' }).click();
    const idB = await waitCurrent(page, (id) => id !== idA);
    const hB = await strokeSaved(page, 40);
    await lib(page, { op: 'rename', projectId: idA, name: 'Head' });
    await lib(page, { op: 'rename', projectId: idB, name: 'Hand' });

    // Before any backup: the plain warning and "never".
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await expect(page.locator('.backup-age')).toHaveAttribute('data-days', 'never');
    await expect(page.getByText('Deleting the Maquette icon from the Home Screen deletes all of them.', { exact: false })).toBeVisible();

    const t0 = Date.now();
    await page.getByRole('button', { name: 'Back up all…' }).click();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-prepared="backup"]').getByRole('button', { name: 'Download' }).click()]);
    r.backupMs = Date.now() - t0;
    const file = 'test-results/prj6-backup.zip';
    await dl.saveAs(file);
    const bytes = readFileSync(file);
    const z = unzip(bytes);
    const index = JSON.parse(z.get('maquette-backup.json')!.data.toString('utf8'));
    const folders = index.projects.map((p: { folder: string }) => p.folder);
    r.backup = { name: dl.suggestedFilename(), bytes: bytes.length, entries: z.size, projects: index.projects.length, folders, crcsValid: crcOk(z) };
    expect(dl.suggestedFilename()).toMatch(/^Maquette backup \d{4}-\d{2}-\d{2}\.zip$/);
    expect(index.projects.length).toBe(2);
    expect(crcOk(z)).toBe(true);
    for (const f of folders) for (const name of ['maquette.json', 'topo.bin', 'positions.bin']) expect(z.has(`${f}/${name}`)).toBe(true);

    // Days since the last backup.
    await expect(page.locator('.backup-age')).toHaveAttribute('data-days', '0');
    await expect(page.locator('.backup-age')).toHaveText('Last backed up today.');
    await page.evaluate(async () => {
      const lib = (window as any).__maquette.library;
      lib.setPref({ lastBackupAt: new Date(Date.now() - 3 * 864e5 - 60_000).toISOString() });
      await lib.savePrefsNow();
    });
    await page.reload();
    await ready(page);
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await expect(page.locator('.backup-age')).toHaveText('Last backed up 3 days ago.');
    r.daysShownAfterBackdate = Number(await page.locator('.backup-age').getAttribute('data-days'));

    // Restore: importing the backup brings every project back, mesh-identical.
    await page.locator('input[type=file][data-feature="PRJ-5"]').setInputFiles(file);
    await expect(page.getByText('Imported 2 projects.')).toBeVisible();
    const all = await list(page);
    const restored = all.filter((p) => p.id !== idA && p.id !== idB);
    r.liveAfterRestore = all.length;
    expect(restored.map((p) => p.name).sort()).toEqual(['Hand', 'Head']);
    const hashes: Record<string, boolean> = {};
    for (const [name, h] of [
      ['Head', hA],
      ['Hand', hB],
    ] as const) {
      const p = restored.find((x) => x.name === name)!;
      await page.evaluate((id) => (window as any).__maquette.library.openProject(id), p.id);
      hashes[name] = (await q(page)).hash === h;
    }
    r.restoredHashesMatch = hashes;
    expect(hashes).toEqual({ Head: true, Hand: true });
  } finally {
    r.pageErrors = errors;
    save('prj6-backup', r);
    await done();
  }
  expect(errors).toEqual([]);
});
