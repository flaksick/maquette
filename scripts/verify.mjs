// The single verification entry point. Prints a numbered table: condition · measured · threshold ·
// PASS/FAIL. Exit code 1 if anything fails. A fix means re-running ALL of it, not one condition.
// Usage: node scripts/verify.mjs [--skip-e2e]
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const rows = [];
const env = { ...process.env, PATH: `/opt/homebrew/opt/rustup/bin:${homedir()}/.cargo/bin:/opt/homebrew/bin:${process.env.PATH}` };
const sh = (cmd, opts = {}) => spawnSync('sh', ['-c', cmd], { encoding: 'utf8', env, maxBuffer: 64 * 2 ** 20, ...opts });
function rec(name, measured, threshold, ok, note = '') {
  rows.push({ n: rows.length + 1, name, measured: String(measured), threshold, status: ok === null ? 'N/A' : ok ? 'PASS' : 'FAIL', note });
}
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// 1. Rust unit tests
{
  const r = sh('cd core && cargo test 2>&1');
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

// 5. WASM size
for (const v of ['simd', 'scalar']) {
  const p = `wasm/core.${v}.wasm`;
  const bytes = existsSync(p) ? statSync(p).size : -1;
  rec(`WASM core (${v}) bytes`, bytes, '< 2,000,000', bytes > 0 && bytes < 2_000_000);
}

// 6. Bundle audit: no external, LAN or analytics URLs in shipped files (invariant 0)
{
  const roots = ['dist/probe', 'dist/app'].filter(existsSync);
  const bad = [];
  const allowed = [/^https?:\/\/www\.w3\.org\//];
  for (const root of roots) {
    for (const f of walk(root).filter((p) => /\.(js|html|css|json|webmanifest)$/.test(p))) {
      const text = readFileSync(f, 'utf8');
      for (const url of text.match(/https?:\/\/[^\s"'`)<>]+/g) ?? []) if (!allowed.some((a) => a.test(url))) bad.push(`${f}: ${url}`);
      for (const lan of text.match(/\b(?:192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|[a-z0-9-]+\.local)\b/gi) ?? []) bad.push(`${f}: ${lan}`);
    }
  }
  rec('Bundle audit: external/LAN URLs', bad.length, '0', roots.length > 0 && bad.length === 0, bad.slice(0, 3).join('; '));
}

// 7. Secrets (invariant 11)
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

// 8. WebKit e2e (spike S9)
if (process.argv.includes('--skip-e2e')) rec('WebKit e2e (probe)', 'skipped', 'pass', null);
else {
  const r = sh('rm -rf deploy-e2e && mkdir -p deploy-e2e/dev && cp -R dist/probe deploy-e2e/dev/probe && npx playwright test 2>&1', {
    env: { ...env, MAQUETTE_DEPLOY: 'deploy-e2e' },
  });
  const passed = /(\d+) passed/.exec(r.stdout)?.[1] ?? 0;
  const failed = /(\d+) failed/.exec(r.stdout)?.[1] ?? 0;
  let note = '';
  try {
    const s9 = JSON.parse(readFileSync('test-results/s9-webkit.json', 'utf8'));
    note = `COI ${s9.env.crossOriginIsolated}; S3 composite ${s9.s3?.compositeScore}; journal p99 ${s9.s2?.latencySingleWorker?.journalLatencyMs?.p99} ms`;
  } catch {}
  rec('WebKit e2e (probe)', `${passed} passed, ${failed} failed`, '0 failed', r.status === 0, note);
  sh('rm -rf deploy-e2e');
}

// 9. Device report freshness (required from P1a on; informational in P0)
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

const w = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(`\n${w('#', 3)} ${w('condition', 36)} ${w('measured', 42)} ${w('threshold', 22)} status`);
for (const r of rows) {
  console.log(`${w(r.n, 3)} ${w(r.name, 36)} ${w(r.measured, 42)} ${w(r.threshold, 22)} ${r.status}${r.note ? `  · ${r.note}` : ''}`);
}
const failed = rows.filter((r) => r.status === 'FAIL');
console.log(`\n${rows.length} conditions @ scripts/verify.mjs: ${rows.filter((r) => r.status === 'PASS').length} pass, ${failed.length} fail, ${rows.filter((r) => r.status === 'N/A').length} n/a`);
process.exit(failed.length ? 1 : 0);
