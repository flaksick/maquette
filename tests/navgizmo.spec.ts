// NAV-4: the navigation orb in WebKit. Every axis ball snaps the camera (forward within 1e-5 of
// the axis), dragging the orb orbits, the hand pans, the magnifier zooms, the grid button toggles
// orthographic (and a stroke still sculpts), idle renders nothing, and the gizmo fits both iPad
// Air orientations without touching the status chips or the Frame / Reset view buttons.
import { expect, test, webkit, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.MAQUETTE_APP_URL ?? `http://localhost:${process.env.MAQUETTE_PORT ?? '8787'}/maquette/dev/`;
type V3 = [number, number, number];
interface Cam {
  yaw: number;
  pitch: number;
  ortho: boolean;
  forward: V3;
  eye: V3;
  projW: [number, number];
}

const cam = (page: Page): Promise<Cam> => page.evaluate(() => (window as any).__maquette.nav.camera());
const q = (page: Page): Promise<{ hash: string; stats: any }> => page.evaluate(() => (window as any).__maquette.query());
const maxErr = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

/** Blender axis ball -> the camera's view direction after tapping it (camera on that side). */
const EXPECTED: Record<string, V3> = {
  '+x': [-1, 0, 0],
  '-x': [1, 0, 0],
  '+y': [0, 0, 1], // Blender +Y = our -Z
  '-y': [0, 0, -1],
  '+z': [0, -1, 0], // Blender +Z = our +Y (up): top view looks down
  '-z': [0, 1, 0],
};

/** The camera once the engine has rendered everything sent so far (two equal reads 150 ms apart). */
async function settled(page: Page): Promise<Cam> {
  let last = '';
  for (let i = 0; i < 40; i++) {
    const c = await cam(page);
    const key = JSON.stringify(c);
    if (key === last) return c;
    last = key;
    await page.waitForTimeout(150);
  }
  throw new Error('camera never settled');
}

async function drag(page: Page, x: number, y: number, dx: number, dy: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x + (dx * i) / 10, y + (dy * i) / 10);
  await page.mouse.up();
}

test('NAV-4: navigation orb snaps to each axis, orbits, pans, zooms and toggles ortho; idle stays free', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'maquette-nav4-'));
  const ctx = await webkit.launchPersistentContext(profile, { viewport: { width: 1180, height: 820 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const r: Record<string, unknown> = {};
  try {
    // WebKit shares OPFS between Playwright profiles per origin: start from an empty disk.
    await page.goto(`${URL}precache.json`);
    await page.evaluate(async () => (await navigator.storage.getDirectory()).removeEntry('app-dev', { recursive: true }).catch(() => {}));
    await page.goto(URL);
    await page.waitForFunction(() => (window as any).__maquette?.ui.ready.value === true, null, { timeout: 60_000 });
    await expect.poll(async () => !!(await cam(page))).toBe(true);
    r.untaggedControls = await page.evaluate(() => [...document.querySelectorAll('.navgizmo button, .navgizmo [role=button]')].filter((e) => !e.hasAttribute('data-feature')).length);

    // Every ball, in an order where the next one is never hidden behind its opposite.
    const snapErr: Record<string, number> = {};
    for (const id of ['+x', '+y', '-x', '-y', '+z', '+x', '-z']) {
      await page.locator(`[data-axis="${id}"]`).click();
      await expect.poll(async () => maxErr((await cam(page)).forward, EXPECTED[id]), { timeout: 5_000 }).toBeLessThan(1e-5);
      snapErr[id] = maxErr((await cam(page)).forward, EXPECTED[id]);
    }
    r.snapForwardError = snapErr;

    // Drag on the orb: orbit. Hand: pan (direction kept). Magnifier: zoom (closer or farther).
    await page.locator('[data-axis="-y"]').click(); // front view: off the pole, yaw turns the view
    await expect.poll(async () => maxErr((await cam(page)).forward, EXPECTED['-y'])).toBeLessThan(1e-5);
    const orb = (await page.locator('.navorb').boundingBox())!;
    const c0 = await settled(page);
    await drag(page, orb.x + orb.width / 2 - 22, orb.y + orb.height / 2 + 26, 60, -20);
    const c1 = await settled(page);
    r.orbitTurnRad = Math.acos(Math.min(1, c0.forward.reduce((s, v, i) => s + v * c1.forward[i], 0)));
    expect(r.orbitTurnRad as number).toBeGreaterThan(0.1);
    const hand = (await page.getByRole('button', { name: /^Pan/ }).boundingBox())!;
    await drag(page, hand.x + 22, hand.y + 22, -40, 30);
    const c2 = await settled(page);
    r.panMoved = maxErr(c2.eye, c1.eye);
    r.panKeptDirection = maxErr(c2.forward, c1.forward);
    expect(r.panMoved as number).toBeGreaterThan(1e-3);
    expect(r.panKeptDirection as number).toBeLessThan(1e-9);
    const mag = (await page.getByRole('button', { name: /^Zoom/ }).boundingBox())!;
    await drag(page, mag.x + 22, mag.y + 22, 0, -60);
    const c3 = await settled(page);
    r.zoomMoved = maxErr(c3.eye, c2.eye);
    expect(r.zoomMoved as number).toBeGreaterThan(1e-3);

    // Ortho: the projection really changes, and a stroke still sculpts.
    await page.getByRole('button', { name: 'Reset view' }).click();
    const persp = await settled(page);
    await page.getByRole('button', { name: /^Perspective view/ }).click();
    await expect.poll(async () => (await cam(page)).ortho).toBe(true);
    const ortho = await cam(page);
    r.projW = { perspective: persp.projW, ortho: ortho.projW };
    expect(persp.projW).toEqual([-1, 0]);
    expect(ortho.projW).toEqual([0, 1]);
    const before = await q(page);
    const scene = (await page.locator('#scene').boundingBox())!;
    await drag(page, scene.x + scene.width / 2 - 60, scene.y + scene.height / 2, 120, 30);
    await expect.poll(async () => {
      const s = (await q(page)).stats;
      return s.seq > before.stats.seq && s.lastAcked >= s.seq;
    }).toBe(true);
    r.orthoStrokeChangedMesh = (await q(page)).hash !== before.hash;
    expect(r.orthoStrokeChangedMesh).toBe(true);
    await expect(page.getByRole('button', { name: /^Orthographic view/ })).toHaveAttribute('aria-pressed', 'true');

    // Idle is free with the orb on screen.
    await page.waitForTimeout(1500);
    const f0 = (await q(page)).stats.frames;
    await page.waitForTimeout(3000);
    r.idleFramesIn3s = (await q(page)).stats.frames - f0;
    expect(r.idleFramesIn3s).toBe(0);

    // Both orientations: no collisions, touch targets >= 40 px, screenshots.
    mkdirSync('test-results', { recursive: true });
    const layouts: Record<string, unknown> = {};
    for (const [w, h] of [
      [1180, 820],
      [820, 1180],
    ]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(400);
      const m = await page.evaluate(() => {
        const box = (e: Element) => {
          const b = e.getBoundingClientRect();
          return { x: b.x, y: b.y, w: b.width, h: b.height };
        };
        const hit = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
          a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        const gizmo = box(document.querySelector('.navgizmo')!);
        const others = [...document.querySelectorAll('header .chip'), ...document.querySelectorAll('.viewbtns button')].map(box);
        const targets = [...document.querySelectorAll('.navgizmo button'), ...document.querySelectorAll('.navball > circle:first-child')].map(box);
        return {
          gizmo,
          collisions: others.filter((o) => hit(gizmo, o)).length,
          minTargetPx: Math.min(...targets.map((t) => Math.min(t.w, t.h))),
          insideViewport: gizmo.x >= 0 && gizmo.x + gizmo.w <= innerWidth && gizmo.y + gizmo.h <= innerHeight,
          horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
        };
      });
      layouts[`${w}x${h}`] = m;
      await page.screenshot({ path: `test-results/nav4-${w}x${h}.png` });
      expect(m.collisions).toBe(0);
      expect(m.minTargetPx).toBeGreaterThanOrEqual(40);
      expect(m.insideViewport).toBe(true);
      expect(m.horizontalOverflow).toBeLessThanOrEqual(0);
    }
    r.layouts = layouts;
    expect(r.untaggedControls).toBe(0);
  } finally {
    r.pageErrors = errors;
    writeFileSync('test-results/nav4.json', JSON.stringify(r, null, 1));
    console.log(JSON.stringify(r, null, 1));
    await page.goto(`${URL}precache.json`).catch(() => {});
    await page.evaluate(async () => (await navigator.storage.getDirectory()).removeEntry('app-dev', { recursive: true }).catch(() => {})).catch(() => {});
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
  }
  expect(errors).toEqual([]);
});
