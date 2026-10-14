// Invariant 7 (no fake UI): loads the built app in WebKit with a persistent profile (WebKit's
// ephemeral contexts reject OPFS), opens every sheet the app declares (window.__maquette.sheets)
// and measures, over the main screen plus every sheet:
//   untagged   interactive elements (button, input, select, textarea, a[href], [role=button])
//              with neither data-feature nor data-ui="chrome"          must be 0
//   unknown    data-feature IDs that are not in spec.yaml               must be 0
//   future     data-feature IDs whose phase is after current_phase and whose computed status
//              is not PASS (FAIL, no-evidence, device-pending)          must be 0
//   early      later-phase IDs allowed because feature-status says PASS (reported, not an error):
//              a feature may ship before its phase only with evidence
//   badChrome  data-ui values other than "chrome"                       must be 0
// Usage: node scripts/check-ui.mjs [--url URL] [--tree DIR] [--port N] [--json FILE] [--status FILE]
//   Without --url it serves --tree (default deploy-e2e) like GitHub Pages on --port (default
//   $MAQUETTE_PORT or 8787) and checks the dev channel at /maquette/dev/. --status reads the JSON
//   written by feature-status.mjs (verify runs that first); without it the status is computed here
//   (cargo test + test-results/playwright.json if present).
import { webkit } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { computeStatus, gather, loadStatusMap } from './feature-status.mjs';
import { loadSpec, phaseIndex } from './spec.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
};
const port = Number(arg('--port', process.env.MAQUETTE_PORT ?? '8787'));
const tree = arg('--tree', 'deploy-e2e');
const jsonOut = arg('--json', 'test-results/ui-registry.json');
let url = arg('--url', null);
const statusFile = arg('--status', null);

/** id -> computed status row, every phase. */
function statusMap() {
  if (statusFile) return loadStatusMap(statusFile);
  const g = gather({});
  return new Map(computeStatus({ ...g, all: true }).map((r) => [r.id, r]));
}

// Sheets whose controls only appear after work starts: the same message the button sends.
const PREPARE = { export: (m) => m.send({ type: 'export-obj' }) };

const { spec, errors } = loadSpec();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
const phaseOf = new Map(spec.features.map((f) => [f.id, f.phase]));
const current = phaseIndex(spec, spec.current_phase);

async function serve() {
  const child = spawn(process.execPath, ['scripts/serve.mjs', tree, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`serve.mjs did not start on port ${port}`)), 10_000);
    child.stdout.on('data', (d) => String(d).includes('serving') && (clearTimeout(t), resolve()));
    child.on('exit', (code) => reject(new Error(`serve.mjs exited (${code}): port ${port} busy?`)));
  });
  return child;
}

/** Everything the registry cares about in the current DOM. */
function snapshot() {
  const sel = 'button, input, select, textarea, a[href], [role=button]';
  const describe = (e) => `<${e.tagName.toLowerCase()}${e.className ? ` class="${e.className}"` : ''}> ${(e.textContent || e.getAttribute('aria-label') || e.getAttribute('type') || '').trim().slice(0, 40)}`;
  const els = [...document.querySelectorAll(sel)];
  return {
    interactive: els.length,
    untagged: els.filter((e) => !e.hasAttribute('data-feature') && e.getAttribute('data-ui') !== 'chrome').map(describe),
    features: [...document.querySelectorAll('[data-feature]')].map((e) => e.getAttribute('data-feature')),
    ui: [...document.querySelectorAll('[data-ui]')].map((e) => e.getAttribute('data-ui')),
  };
}

/** Waits until the DOM's interactive and feature counts hold still for 3 polls (max 8 s). */
async function settle(page) {
  let last = '';
  let same = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const s = await page.evaluate(snapshot);
    const key = `${s.interactive}/${s.features.length}`;
    same = key === last ? same + 1 : 0;
    last = key;
    if (same >= 3) return s;
    await page.waitForTimeout(150);
  }
  return page.evaluate(snapshot);
}

let server = null;
const profile = mkdtempSync(join(tmpdir(), 'maquette-ui-'));
let ctx = null;
let exitCode = 0;
try {
  if (!url) {
    server = await serve();
    url = `http://localhost:${port}/maquette/dev/`;
  }
  ctx = await webkit.launchPersistentContext(profile, { viewport: { width: 1180, height: 820 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(url);
  await page.waitForFunction(() => window.__maquette?.ui.ready.value === true, null, { timeout: 60_000 });
  const sheets = await page.evaluate(() => window.__maquette.sheets ?? null);
  if (!Array.isArray(sheets) || !sheets.length) throw new Error('the app does not expose its sheet list (window.__maquette.sheets)');
  const states = [];
  for (const sheet of ['none', ...sheets]) {
    await page.evaluate(
      ([s, prep]) => {
        const m = window.__maquette;
        m.ui.sheet.value = 'none';
        m.ui.sheet.value = s;
        if (prep) new Function('m', `(${prep})(m)`)(m);
      },
      [sheet, PREPARE[sheet] ? String(PREPARE[sheet]) : null],
    );
    states.push({ sheet, ...(await settle(page)) });
  }
  await page.evaluate(() => (window.__maquette.ui.sheet.value = 'none'));

  const ids = [...new Set(states.flatMap((s) => s.features))].sort();
  const unknown = ids.filter((id) => !phaseOf.has(id));
  const later = ids.filter((id) => phaseOf.has(id) && phaseIndex(spec, phaseOf.get(id)) > current);
  const st = later.length ? statusMap() : new Map();
  const early = later.filter((id) => st.get(id)?.status === 'PASS').map((id) => `${id} (${phaseOf.get(id)}, PASS: ${st.get(id).evidence})`);
  const future = later.filter((id) => st.get(id)?.status !== 'PASS').map((id) => `${id} (${phaseOf.get(id)}, ${st.get(id)?.status ?? 'no status'})`);
  const badChrome = [...new Set(states.flatMap((s) => s.ui))].filter((v) => v !== 'chrome');
  const untagged = states.flatMap((s) => s.untagged.map((d) => `${s.sheet}: ${d}`));
  const interactive = states.reduce((n, s) => n + s.interactive, 0);
  const result = {
    url,
    currentPhase: spec.current_phase,
    states: states.map(({ sheet, interactive, untagged, features }) => ({ sheet, interactive, untagged, features: [...new Set(features)].sort() })),
    totals: { states: states.length, interactive, untagged: untagged.length, unknown: unknown.length, future: future.length, early: early.length, badChrome: badChrome.length, featureIds: ids.length },
    untagged,
    unknown,
    future,
    early,
    badChrome,
    featureIds: ids,
    pageErrors,
  };
  mkdirSync(dirname(jsonOut), { recursive: true });
  writeFileSync(jsonOut, JSON.stringify(result, null, 1));
  for (const s of result.states) console.log(`${s.sheet.padEnd(10)} ${String(s.interactive).padStart(3)} interactive · ${s.untagged.length} untagged · features ${s.features.join(' ')}`);
  for (const u of untagged) console.log(`  untagged: ${u}`);
  for (const u of unknown) console.log(`  not in spec.yaml: ${u}`);
  for (const u of early) console.log(`  after ${spec.current_phase}, allowed by evidence: ${u}`);
  for (const u of future) console.log(`  after ${spec.current_phase}, no PASS evidence: ${u}`);
  for (const u of badChrome) console.log(`  data-ui="${u}" (only "chrome" is allowed)`);
  console.log(
    `UI registry @ ${url}: ${states.length} states, ${interactive} interactive elements, untagged ${untagged.length}, unknown IDs ${unknown.length}, later-phase IDs ${early.length} allowed by PASS evidence / ${future.length} without, bad data-ui ${badChrome.length}; ${ids.length} feature IDs rendered`,
  );
  if (untagged.length || unknown.length || future.length || badChrome.length || pageErrors.length) exitCode = 1;
  if (pageErrors.length) console.log(`page errors: ${pageErrors.join('; ')}`);
} catch (e) {
  console.error(`check-ui failed: ${e?.message ?? e}`);
  exitCode = 2;
} finally {
  await ctx?.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
  server?.kill();
}
process.exit(exitCode);
