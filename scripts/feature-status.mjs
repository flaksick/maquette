// Feature status, computed (never written down): every feature in spec.yaml gets PASS, FAIL,
// device-pending, no-evidence or deferred from
//   - Rust tests whose name starts with lowercase IDs:      prj4_random_kill_recovery_200_runs
//   - Playwright tests whose title starts with IDs:          'PLT-3: v1 -> v2 -> bad v3 -> revert'
//     (plus runtime annotations { type: 'feature', description: 'PRJ-4' } for conditional parts)
//   - the Blender oracle on an exported OBJ (EXP-1), written by verify.mjs
//   - device reports <= 14 days old (reports/*.json, ~/Downloads/maquette-report-*.json) whose
//     `features` map covers the feature; any device report is PLT-9's own evidence ("itself")
// Features whose acceptance needs the reference device (spec.mjs needsDevice) stay device-pending
// until a fresh device report covers them, whatever the local tests say.
// Usage: node scripts/feature-status.mjs [--rust FILE] [--playwright FILE] [--oracle FILE]
//                                        [--json FILE] [--all]
//   --rust defaults to running `cargo test` in core/; --all lists every phase, not just <= current.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { idsFromRustName, idsFromTitle, loadSpec, needsDevice, phaseIndex } from './spec.mjs';

export const DEVICE_REPORT_MAX_DAYS = 14;

/** `cargo test` output -> [{ name, status: pass|fail|ignored, ids }]. */
export function parseRust(output, known) {
  const tests = [];
  for (const line of output.split('\n')) {
    const m = /^test (\S+) \.\.\. (ok|FAILED|ignored)/.exec(line.trim());
    if (!m) continue;
    const name = m[1].split('::').pop();
    tests.push({ source: 'rust', name: m[1], status: m[2] === 'ok' ? 'pass' : m[2] === 'FAILED' ? 'fail' : 'skipped', ids: idsFromRustName(name, known) });
  }
  return tests;
}

/** Playwright JSON report -> [{ name, status, ids }]. */
export function parsePlaywright(report, known) {
  const tests = [];
  const walk = (suite, file) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const notes = [...(t.annotations ?? []), ...(t.results ?? []).flatMap((r) => r.annotations ?? [])];
        const extra = notes.filter((a) => a.type === 'feature').flatMap((a) => String(a.description ?? '').match(/[A-Z]{3}-\d+/g) ?? []);
        const ids = [...new Set([...idsFromTitle(spec.title, known), ...extra.filter((id) => known.has(id))])];
        const status = t.status === 'expected' || t.status === 'flaky' ? 'pass' : t.status === 'skipped' ? 'skipped' : 'fail';
        tests.push({ source: 'e2e', name: `${file ?? spec.file}: ${spec.title}`, status, ids });
      }
    }
    for (const s of suite.suites ?? []) walk(s, file ?? s.file);
  };
  for (const s of report.suites ?? []) walk(s, s.file);
  return tests;
}

/** Fresh device reports with what they cover: [{ file, generatedAt, ageDays, features }]. */
export function deviceReports(now = Date.now()) {
  const files = [];
  if (existsSync('reports')) for (const f of readdirSync('reports')) if (f.endsWith('.json')) files.push(join('reports', f));
  const dl = join(homedir(), 'Downloads');
  if (existsSync(dl)) for (const f of readdirSync(dl)) if (/^maquette-report-.*\.json$/.test(f)) files.push(join(dl, f));
  const seen = new Set();
  const out = [];
  for (const file of files) {
    let r;
    try {
      r = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const t = Date.parse(r.generatedAt ?? '') || statSync(file).mtimeMs;
    const key = r.generatedAt ?? file;
    if (seen.has(key)) continue; // the same report saved twice (Downloads + reports/)
    seen.add(key);
    const ageDays = (now - t) / 864e5;
    const features = { ...(r.features ?? {}) };
    if (!features['PLT-9']) features['PLT-9'] = { pass: true, measured: 'device report produced by the diagnostics' };
    out.push({ file, generatedAt: new Date(t).toISOString(), ageDays: Math.round(ageDays * 10) / 10, fresh: ageDays <= DEVICE_REPORT_MAX_DAYS, features });
  }
  return out.sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
}

/** Per-feature status rows. */
export function computeStatus({ spec, tests, oracle, reports, all = false }) {
  const current = phaseIndex(spec, spec.current_phase);
  const rows = [];
  for (const f of spec.features) {
    if (!all && phaseIndex(spec, f.phase) > current) continue;
    const ev = tests.filter((t) => t.ids.includes(f.id));
    if (f.id === 'EXP-1' && oracle) ev.push({ source: 'oracle', name: 'Blender oracle on the e2e export', status: oracle.pass ? 'pass' : 'fail', ids: ['EXP-1'] });
    const pass = ev.filter((t) => t.status === 'pass');
    const fail = ev.filter((t) => t.status === 'fail');
    const skipped = ev.filter((t) => t.status === 'skipped');
    const dev = reports.filter((r) => r.fresh && r.features[f.id]).map((r) => ({ ...r.features[f.id], report: r.file, ageDays: r.ageDays }))[0] ?? null;
    const device = needsDevice(f);
    let status;
    if (f.test.trim() === '-') status = 'deferred';
    else if (fail.length || (dev && dev.pass === false)) status = 'FAIL';
    else if (device) status = dev?.pass ? 'PASS' : 'device-pending';
    else status = pass.length || dev?.pass ? 'PASS' : 'no-evidence';
    const bySource = (src) => {
      const e = ev.filter((t) => t.source === src);
      return e.length ? `${src} ${e.filter((t) => t.status === 'pass').length}/${e.length - e.filter((t) => t.status === 'skipped').length}` : null;
    };
    const evidence = [bySource('rust'), bySource('e2e'), bySource('oracle'), skipped.length ? `${skipped.length} skipped` : null, dev ? `device ${dev.pass ? 'pass' : 'FAIL'}${dev.measured ? ` (${dev.measured})` : ''}, ${dev.ageDays} d old` : device ? 'device: no fresh report covers it' : null]
      .filter(Boolean)
      .join(' · ');
    rows.push({ id: f.id, name: f.name, phase: f.phase, tier: f.tier, device, status, evidence: evidence || 'none', tests: ev.map((t) => `${t.status} ${t.name}`) });
  }
  return rows;
}

export const STATUSES = ['PASS', 'FAIL', 'device-pending', 'no-evidence', 'deferred'];

export function phaseCounts(spec, rows) {
  const counts = {};
  for (const p of spec.phases) {
    const r = rows.filter((x) => x.phase === p);
    if (!r.length) continue;
    counts[p] = Object.fromEntries([['features', r.length], ...STATUSES.map((s) => [s, r.filter((x) => x.status === s).length])]);
  }
  return counts;
}

/** Rows up to the current phase, and later-phase rows (features shipping early). */
export function splitByPhase(spec, rows) {
  const current = phaseIndex(spec, spec.current_phase);
  return { upTo: rows.filter((r) => phaseIndex(spec, r.phase) <= current), later: rows.filter((r) => phaseIndex(spec, r.phase) > current) };
}

/** Writes the status JSON: counts and rows up to the current phase, plus every later-phase row
 *  (check-ui allows a later-phase control only when its row says PASS). */
export function writeStatusJson(file, spec, allRows) {
  const { upTo, later } = splitByPhase(spec, allRows);
  const totals = Object.fromEntries(STATUSES.map((s) => [s, upTo.filter((r) => r.status === s).length]));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ currentPhase: spec.current_phase, generatedAt: new Date().toISOString(), counts: phaseCounts(spec, upTo), totals, rows: upTo, later }, null, 1));
}

/** id -> status row, for every phase, from a JSON written by writeStatusJson. */
export function loadStatusMap(file) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  return new Map([...(j.rows ?? []), ...(j.later ?? [])].map((r) => [r.id, r]));
}

/** A row backed by something: a tagged test (any result) or a device report's verdict. */
const hasEvidence = (r) => r.tests.length > 0 || r.status === 'PASS' || r.status === 'FAIL';

export function printStatus(spec, rows, later = []) {
  const w = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(`\n${w('feature', 8)} ${w('phase', 5)} ${w('name', 34)} ${w('status', 15)} evidence`);
  for (const r of rows) console.log(`${w(r.id, 8)} ${w(r.phase, 5)} ${w(r.name, 34)} ${w(r.status, 15)} ${r.evidence}`);
  const early = later.filter(hasEvidence);
  if (early.length) {
    console.log(`\nlater-phase features with evidence (shipping before ${spec.current_phase}):`);
    for (const r of early) console.log(`${w(r.id, 8)} ${w(r.phase, 5)} ${w(r.name, 34)} ${w(r.status, 15)} ${r.evidence}`);
  }
  const counts = phaseCounts(spec, rows);
  console.log(`\n${w('phase', 6)} ${w('features', 9)} ${STATUSES.map((s) => w(s, 15)).join(' ')}`);
  for (const [p, c] of Object.entries(counts)) console.log(`${w(p, 6)} ${w(c.features, 9)} ${STATUSES.map((s) => w(c[s], 15)).join(' ')}`);
  const tot = Object.fromEntries(STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length]));
  console.log(`\nFeature status @ scripts/feature-status.mjs (current phase ${spec.current_phase}): ${rows.length} features · ${STATUSES.map((s) => `${s} ${tot[s]}`).join(' · ')}`);
  if (early.length) console.log(`Later phases: ${early.length} features with evidence · PASS ${early.filter((r) => r.status === 'PASS').length} · FAIL ${early.filter((r) => r.status === 'FAIL').length}`);
  return { ...tot, laterPass: early.filter((r) => r.status === 'PASS').length, laterFail: early.filter((r) => r.status === 'FAIL').length };
}

export function rustOutput(file) {
  if (file) return readFileSync(file, 'utf8');
  const env = { ...process.env, PATH: `/opt/homebrew/opt/rustup/bin:${homedir()}/.cargo/bin:/opt/homebrew/bin:${process.env.PATH}` };
  const r = spawnSync('sh', ['-c', 'cd core && cargo test 2>&1'], { encoding: 'utf8', env, maxBuffer: 64 * 2 ** 20 });
  return r.stdout;
}

export function gather({ rustFile, rustText, playwrightFile = 'test-results/playwright.json', oracleFile = 'test-results/oracle.json' } = {}) {
  const { spec, errors } = loadSpec();
  if (errors.length) throw new Error(errors.join('\n'));
  const known = new Set(spec.features.map((f) => f.id));
  const tests = parseRust(rustText ?? rustOutput(rustFile), known);
  let playwright = null;
  if (playwrightFile && existsSync(playwrightFile)) {
    playwright = JSON.parse(readFileSync(playwrightFile, 'utf8'));
    tests.push(...parsePlaywright(playwright, known));
  }
  const oracle = oracleFile && existsSync(oracleFile) ? JSON.parse(readFileSync(oracleFile, 'utf8')) : null;
  return { spec, tests, oracle, reports: deviceReports(), playwrightRan: !!playwright };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : def;
  };
  const g = gather({ rustFile: arg('--rust', null), playwrightFile: arg('--playwright', 'test-results/playwright.json'), oracleFile: arg('--oracle', 'test-results/oracle.json') });
  const all = computeStatus({ ...g, all: true });
  const { upTo, later } = splitByPhase(g.spec, all);
  if (!g.playwrightRan) console.log('(no Playwright JSON report: e2e evidence missing; npm run verify writes test-results/playwright.json)');
  const tot = process.argv.includes('--all') ? printStatus(g.spec, all) : printStatus(g.spec, upTo, later);
  writeStatusJson(arg('--json', 'test-results/feature-status.json'), g.spec, all);
  process.exit(tot.FAIL || tot.laterFail ? 1 : 0);
}
