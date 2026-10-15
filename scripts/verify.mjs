// The single verification entry point. Prints a numbered table: condition · measured · threshold ·
// PASS/FAIL, then the per-feature status table. Exit code 1 if anything fails. A fix means
// re-running ALL of it, not one condition.
// Usage: node scripts/verify.mjs [--skip-e2e]
//   MAQUETTE_PORT     port for the e2e server and the UI check (default 8787)
//   MAQUETTE_NO_KILL  set it to skip the e2e steps that SIGKILL Playwright's WebKit content processes
//                     (they hit every WebKit test on the machine): parallel runs set it, the lead's
//                     verify run doesn't
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { computeStatus, gather, printStatus, splitByPhase, writeStatusJson } from './feature-status.mjs';
import { assembleProd } from './release.mjs';

const rows = [];
const env = { ...process.env, PATH: `/opt/homebrew/opt/rustup/bin:${homedir()}/.cargo/bin:/opt/homebrew/bin:${process.env.PATH}` };
const sh = (cmd, opts = {}) => spawnSync('sh', ['-c', cmd], { encoding: 'utf8', env, maxBuffer: 256 * 2 ** 20, ...opts });
const PORT = process.env.MAQUETTE_PORT ?? '8787';
const BLENDER = '/Applications/Blender.app/Contents/MacOS/Blender';
const skipE2E = process.argv.includes('--skip-e2e');
function rec(name, measured, threshold, ok, note = '') {
  rows.push({ n: rows.length + 1, name, measured: String(measured), threshold, status: ok === null ? 'N/A' : ok ? 'PASS' : 'FAIL', note });
}
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
mkdirSync('test-results', { recursive: true });

// 1. Rust unit tests (output kept: feature status reads the ID-tagged test names from it; it
// stays in memory because Playwright empties test-results/ when it starts)
let rustText = '';
{
  const r = sh('cd core && cargo test 2>&1');
  rustText = r.stdout;
  const m = /test result: \w+\. (\d+) passed; (\d+) failed/.exec(r.stdout);
  const passed = m ? Number(m[1]) : 0;
  const failed = m ? Number(m[2]) : -1;
  rec('Rust tests', `${passed} passed, ${failed} failed`, '0 failed', r.status === 0 && failed === 0);
}

// 2. TypeScript
{
  const r = sh('npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.node.json');
  const errors = (r.stdout.match(/error TS/g) ?? []).length;
  rec('TypeScript errors', errors, '0', r.status === 0);
}

// 3. Feature registry
{
  const r = sh('node scripts/gen-spec.mjs --check');
  rec('spec.yaml valid, SPEC.md current', r.stdout.trim() || r.stderr.trim(), 'current', r.status === 0);
}

// 4. Third-party notices
{
  const r = sh('node scripts/gen-notices.mjs --check');
  rec('THIRD_PARTY_NOTICES current', r.stdout.trim() || r.stderr.trim(), 'current', r.status === 0);
}

// 5. Build everything the e2e serves: engine, app (dev + prod), probe
{
  const t0 = Date.now();
  const r = sh(
    'node scripts/gen-icons.mjs && sh scripts/build-core.sh && npx vite build --config vite.app.config.ts --mode dev && npx vite build --config vite.app.config.ts --mode prod && npx vite build --config vite.probe.config.ts 2>&1',
  );
  rec('Build (core, app dev+prod, probe)', r.status === 0 ? `${((Date.now() - t0) / 1000).toFixed(1)} s` : (r.stderr || r.stdout).trim().split('\n').pop(), 'builds', r.status === 0);
}

// 6. WASM size
for (const v of ['simd', 'scalar']) {
  const p = `wasm/core.${v}.wasm`;
  const bytes = existsSync(p) ? statSync(p).size : -1;
  rec(`WASM core (${v}) bytes`, bytes, '< 2,000,000', bytes > 0 && bytes < 2_000_000);
}

// 7. Bundle audit: no external, LAN or analytics URLs in shipped files (invariant 0)
{
  const roots = ['dist/probe', 'dist/app-dev', 'dist/app-prod'].filter(existsSync);
  const bad = [];
  const allowed = [/^https?:\/\/www\.w3\.org\//];
  for (const root of roots) {
    for (const f of walk(root).filter((p) => /\.(js|html|css|json|webmanifest)$/.test(p))) {
      const text = readFileSync(f, 'utf8');
      for (const url of text.match(/https?:\/\/[^\s"'`)<>]+/g) ?? []) if (!allowed.some((a) => a.test(url))) bad.push(`${f}: ${url}`);
      // LAN addresses; mDNS hosts only as URL hosts ("this.local" is a property, not a host)
      for (const lan of text.match(/\b(?:192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)\b|\/\/[a-z0-9-]+\.local\b/gi) ?? []) bad.push(`${f}: ${lan}`);
    }
  }
  rec('Bundle audit: external/LAN URLs', bad.length, '0', roots.length === 3 && bad.length === 0, bad.slice(0, 3).join('; ') || `${roots.length} bundles`);
}

// 8. Secrets (invariant 11)
for (const [label, cmd] of [
  ['gitleaks: working tree', 'gitleaks dir . --redact --no-banner -l error'],
  ['gitleaks: git history', 'gitleaks git . --redact --no-banner -l error'],
  ['gitleaks: deploy tree', existsSync('deploy') ? 'gitleaks dir deploy --redact --no-banner -l error' : null],
]) {
  if (!cmd) {
    rec(label, 'no deploy tree', '0 findings', null);
    continue;
  }
  const r = sh(cmd);
  const m = /leaks found: (\d+)/.exec(r.stdout + r.stderr);
  const findings = r.status === 0 ? 0 : m ? Number(m[1]) : 'error';
  rec(label, findings, '0 findings', r.status === 0);
}
{
  const remotes = sh('git remote -v').stdout;
  const leaky = /https:\/\/[^/@\s]+@/.test(remotes);
  rec('Credentials in remote URLs', leaky ? 1 : 0, '0', !leaky);
}

// 9. The e2e tree, laid out like GitHub Pages: prod in version folders at the root (the real
// release assembly, scripts/release.mjs), the dev app at /dev/, the probe at /dev/probe/.
const TREE = 'deploy-e2e';
rmSync(TREE, { recursive: true, force: true });
cpSync('dist/app-dev', `${TREE}/dev`, { recursive: true });
cpSync('dist/probe', `${TREE}/dev/probe`, { recursive: true });
try {
  const rel = assembleProd({ dist: 'dist/app-prod', root: TREE });
  rec('Release assembly (prod)', rel.describe, 'assembles', true);
} catch (e) {
  rec('Release assembly (prod)', String(e.message ?? e).slice(0, 60), 'assembles', false);
}

// 10. WebKit e2e: every Playwright test, served like GitHub Pages; one row per spec file
const e2eStart = Date.now();
if (skipE2E) rec('WebKit e2e', 'skipped', '0 failed', null);
else {
  rmSync('test-results/playwright.json', { force: true });
  // One retry: a timing-sensitive test (speed bench, probe) can time out while other builds load the
  // machine. A test that passes only on retry is counted and printed as flaky, never hidden.
  const r = sh('npx playwright test --retries=1 --reporter=list,json 2>&1', {
    env: { ...env, MAQUETTE_DEPLOY: TREE, MAQUETTE_PORT: PORT, PLAYWRIGHT_JSON_OUTPUT_FILE: 'test-results/playwright.json' },
  });
  writeFileSync('test-results/playwright.txt', r.stdout);
  const report = readJson('test-results/playwright.json');
  if (!report) rec('WebKit e2e', 'no report', '0 failed', false, r.stdout.trim().split('\n').slice(-3).join(' | '));
  else {
    const byFile = new Map();
    const walkSuite = (s, file) => {
      for (const spec of s.specs ?? [])
        for (const t of spec.tests ?? []) {
          const f = byFile.get(file) ?? { passed: 0, failed: 0, skipped: 0, flaky: 0, ms: 0 };
          if (t.status === 'flaky') f.flaky++;
          if (t.status === 'expected' || t.status === 'flaky') f.passed++;
          else if (t.status === 'skipped') f.skipped++;
          else f.failed++;
          f.ms += (t.results ?? []).reduce((n, x) => n + (x.duration ?? 0), 0);
          byFile.set(file, f);
        }
      for (const c of s.suites ?? []) walkSuite(c, file);
    };
    for (const s of report.suites ?? []) walkSuite(s, s.file);
    const notes = {
      's9-probe-webkit.spec.ts': () => {
        const s9 = readJson('test-results/s9-webkit.json');
        return s9 ? `COI ${s9.env.crossOriginIsolated}; S3 composite ${s9.s3?.compositeScore}; journal p99 ${s9.s2?.latencySingleWorker?.journalLatencyMs?.p99} ms` : '';
      },
      'app.spec.ts': () => {
        const a = readJson('test-results/app-webkit.json');
        return a ? `idle frames/10 s ${a.idleFramesIn10s}; offline relaunch ${a.offlineLaunchMs} ms; kills ${a.killAfterAck ? 'ran' : 'skipped (MAQUETTE_NO_KILL)'}` : '';
      },
      'updates.spec.ts': () => {
        const u = readJson('test-results/plt3-updates.json');
        return u?.timings ? Object.entries(u.timings).map(([k, v]) => `${k} ${v} ms`).join('; ') : '';
      },
      'budgets.spec.ts': () => {
        const b = readJson('test-results/plt8-budgets.json');
        return b ? `budget ${b.priorMB} -> cut ${b.afterCutMB} -> raised ${b.afterRaiseMB} MB; refusal ${b.refusedAtMB} MB; bench ${b.benchMs ?? '-'} ms` : '';
      },
    };
    for (const [file, f] of [...byFile].sort()) {
      const note = notes[file]?.() ?? '';
      rec(`WebKit e2e: ${file}`, `${f.passed} passed, ${f.failed} failed${f.flaky ? ` (${f.flaky} only on retry)` : ''}${f.skipped ? `, ${f.skipped} skipped` : ''} (${(f.ms / 1000).toFixed(0)} s)`, '0 failed', f.failed === 0 && f.passed > 0, note);
    }
  }
}

// 11. Blender oracle (EXP-1) on the OBJ the app e2e just exported through the Download path
{
  const obj = 'test-results/export.obj';
  rmSync('test-results/oracle.json', { force: true });
  if (!existsSync(BLENDER)) rec('Blender oracle (EXP-1)', 'Blender not installed', 'counts exact, bbox <= 1e-4', null);
  else if (!existsSync(obj) || statSync(obj).mtimeMs < e2eStart) rec('Blender oracle (EXP-1)', 'no fresh export (e2e skipped?)', 'counts exact, bbox <= 1e-4', null);
  else {
    const r = sh(`"${BLENDER}" --background --factory-startup --python oracle/check_obj.py -- ${obj} 2>&1`);
    const line = r.stdout.split('\n').find((l) => l.startsWith('ORACLE '));
    const o = line ? JSON.parse(line.slice(7)) : null;
    if (o) writeFileSync('test-results/oracle.json', JSON.stringify({ ...o, obj }, null, 1));
    rec(
      'Blender oracle (EXP-1)',
      o ? `v ${o.blender.vertices}/${o.file.vertices} f ${o.blender.faces}/${o.file.faces} q ${o.blender.quads}/${o.file.quads} Δ ${o.bbox_max_delta?.toExponential(1)}` : 'no ORACLE line',
      'counts exact, bbox <= 1e-4',
      !!o?.pass,
      o ? `Blender ${o.blender.version}; non-manifold edges ${o.blender.non_manifold_edges}` : r.stdout.trim().split('\n').slice(-2).join(' | '),
    );
  }
}

// ----- [io] Blender oracle (EXP-2) on the STL tests/io.spec.ts just exported (io stream's block) -----
{
  const stl = 'test-results/export.stl';
  rmSync('test-results/oracle-stl.json', { force: true });
  const want = 'tris + positions exact, bbox <= 1e-4';
  if (!existsSync(BLENDER)) rec('Blender oracle (EXP-2)', 'Blender not installed', want, null);
  else if (!existsSync(stl) || statSync(stl).mtimeMs < e2eStart) rec('Blender oracle (EXP-2)', 'no fresh STL export (e2e skipped?)', want, null);
  else {
    const r = sh(`"${BLENDER}" --background --factory-startup --python oracle/check_stl.py -- ${stl} 2>&1`);
    const line = r.stdout.split('\n').find((l) => l.startsWith('ORACLE '));
    const o = line ? JSON.parse(line.slice(7)) : null;
    if (o) writeFileSync('test-results/oracle-stl.json', JSON.stringify({ ...o, stl }, null, 1));
    rec(
      'Blender oracle (EXP-2)',
      o ? `tris ${o.blender.faces}/${o.file.triangles} v ${o.blender.vertices}/${o.file.unique_positions} Δ ${o.bbox_max_delta?.toExponential(1)}` : 'no ORACLE line',
      want,
      !!o?.pass,
      o ? `Blender ${o.blender.version}; boundary edges ${o.blender.boundary_edges}` : r.stdout.trim().split('\n').slice(-2).join(' | '),
    );
  }
}
// PRM-2: Blender oracle on each primitive's OBJ (tests/primitives.spec.ts exports one per shape)
{
  const shapes = ['cube', 'cylinder', 'cone', 'torus', 'plane', 'capsule', 'icosphere'];
  const want = '7/7 counts exact, bbox <= 1e-4';
  const files = shapes.map((s) => `test-results/prm2-${s}.obj`);
  if (!existsSync(BLENDER)) rec('Blender oracle (PRM-2)', 'Blender not installed', want, null);
  else if (files.some((f) => !existsSync(f) || statSync(f).mtimeMs < e2eStart)) rec('Blender oracle (PRM-2)', 'no fresh primitive exports (e2e skipped?)', want, null);
  else {
    const out = files.map((f) => {
      const line = sh(`"${BLENDER}" --background --factory-startup --python oracle/check_obj.py -- ${f} 2>&1`).stdout.split('\n').find((l) => l.startsWith('ORACLE '));
      return line ? JSON.parse(line.slice(7)) : null;
    });
    writeFileSync('test-results/oracle-prm2.json', JSON.stringify(Object.fromEntries(shapes.map((s, i) => [s, out[i]])), null, 1));
    const pass = out.filter((o) => o?.pass).length;
    const nm = out.map((o, i) => `${shapes[i]} ${o?.blender.non_manifold_edges ?? '?'}`).join(', ');
    rec('Blender oracle (PRM-2)', `${pass}/${shapes.length} pass`, want, pass === shapes.length, `non-manifold edges: ${nm} (plane = its border)`);
  }
}
// ----- [io] end -----

// 12. Feature status, computed from the tagged tests above and fresh device reports. Runs before
// the UI check: a control for a later-phase feature is allowed only when this says PASS.
let status = null;
{
  try {
    writeFileSync('test-results/rust-tests.txt', rustText);
    const g = gather({ rustText });
    const all = computeStatus({ ...g, all: true });
    writeStatusJson('test-results/feature-status.json', g.spec, all);
    const { upTo, later } = splitByPhase(g.spec, all);
    status = { g, upTo, later };
    const c = (s) => upTo.filter((r) => r.status === s).length;
    const laterPass = later.filter((r) => r.status === 'PASS').length;
    const laterFail = later.filter((r) => r.status === 'FAIL').length;
    rec(
      `Feature status (<= ${g.spec.current_phase})`,
      `${c('PASS')} PASS · ${c('FAIL')} FAIL · ${c('device-pending')} device-pending · ${c('no-evidence')} none`,
      '0 FAIL',
      c('FAIL') === 0 && laterFail === 0,
      `later phases: ${laterPass} PASS, ${laterFail} FAIL${g.playwrightRan ? '' : '; no e2e evidence (skipped)'}`,
    );
  } catch (e) {
    rec('Feature status', String(e.message ?? e).slice(0, 60), '0 FAIL', false);
  }
}

// 13. No fake UI (invariant 7): every control carries a feature ID of this phase or earlier, or of
// a later phase that already has PASS evidence
{
  const st = existsSync('test-results/feature-status.json') ? '--status test-results/feature-status.json' : '';
  const r = sh(`node scripts/check-ui.mjs --tree ${TREE} --port ${PORT} --json test-results/ui-registry.json ${st}`);
  const u = readJson('test-results/ui-registry.json');
  const t = u?.totals;
  rec(
    'UI registry: untagged controls (inv. 7)',
    t && r.status !== 2 ? `${t.untagged} untagged of ${t.interactive} in ${t.states} states` : 'check did not run',
    '0 untagged, 0 bad IDs',
    r.status === 0,
    t
      ? `unknown IDs ${t.unknown}; after ${u.currentPhase}: ${t.early} allowed by PASS evidence, ${t.future} without; bad data-ui ${t.badChrome}; ${t.featureIds} feature IDs rendered`
      : (r.stderr || r.stdout).trim().split('\n').pop(),
  );
}
rmSync(TREE, { recursive: true, force: true });

// 14. Device report freshness (required from P1a on; informational until device runs are routine)
{
  const dl = join(homedir(), 'Downloads');
  const reports = existsSync(dl) ? readdirSync(dl).filter((f) => /^maquette-report-.*\.json$/.test(f)) : [];
  if (!reports.length) rec('Device report age', 'none yet', '<= 14 days (from P1a)', null);
  else {
    const newest = reports.map((f) => ({ f, t: statSync(join(dl, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
    const days = Math.round(((Date.now() - newest.t) / 864e5) * 10) / 10;
    rec('Device report age', `${days} days (${newest.f})`, '<= 14 days (from P1a)', null);
  }
}

if (status) printStatus(status.g.spec, status.upTo, status.later);
const w = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(`\n${w('#', 3)} ${w('condition', 40)} ${w('measured', 52)} ${w('threshold', 26)} status`);
for (const r of rows) {
  console.log(`${w(r.n, 3)} ${w(r.name, 40)} ${w(r.measured, 52)} ${w(r.threshold, 26)} ${r.status}${r.note ? `  · ${r.note}` : ''}`);
}
const failed = rows.filter((r) => r.status === 'FAIL');
console.log(`\n${rows.length} conditions @ scripts/verify.mjs: ${rows.filter((r) => r.status === 'PASS').length} pass, ${failed.length} fail, ${rows.filter((r) => r.status === 'N/A').length} n/a`);
process.exit(failed.length ? 1 : 0);
