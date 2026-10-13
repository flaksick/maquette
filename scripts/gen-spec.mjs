// Generates SPEC.md from spec.yaml and validates the registry. Prints the counts it wrote.
// Usage: node scripts/gen-spec.mjs [--check]   (--check fails if SPEC.md is stale)
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';

const spec = parse(readFileSync('spec.yaml', 'utf8'));
const errors = [];
const ids = new Set();
for (const f of spec.features) {
  if (ids.has(f.id)) errors.push(`duplicate id ${f.id}`);
  ids.add(f.id);
  const area = f.id.split('-')[0];
  if (!spec.areas[area]) errors.push(`${f.id}: unknown area ${area}`);
  if (!['D', 'R', 'N'].includes(f.tier)) errors.push(`${f.id}: bad tier ${f.tier}`);
  if (!spec.phases.includes(f.phase)) errors.push(`${f.id}: bad phase ${f.phase}`);
  for (const k of ['name', 'done_when', 'test']) if (!f[k]) errors.push(`${f.id}: missing ${k}`);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

const byTier = { D: 0, R: 0, N: 0 };
const byPhase = Object.fromEntries(spec.phases.map((p) => [p, 0]));
for (const f of spec.features) {
  byTier[f.tier]++;
  byPhase[f.phase]++;
}
const esc = (s) => String(s).replace(/\|/g, '\\|');
const lines = [
  '# Maquette feature specification',
  '',
  '_Generated from `spec.yaml` by `scripts/gen-spec.mjs`. Do not hand-edit._',
  '',
  `**${spec.features.length} features** @ spec.yaml: ${byTier.D} daily, ${byTier.R} regular, ${byTier.N} niche.`,
  `First-ship phase counts @ spec.yaml: ${spec.phases.map((p) => `${p} ${byPhase[p]}`).join(', ')}.`,
  'Status is computed from tagged test results and device reports (`npm run verify`), never written here.',
  '',
  '**Universal gates:** ' + spec.universal_gates.join('; ') + '.',
  '',
  '**Brush gates:** ' + spec.brush_gates.join('; ') + '.',
  '',
];
for (const [area, title] of Object.entries(spec.areas)) {
  const fs = spec.features.filter((f) => f.id.startsWith(area + '-'));
  if (!fs.length) continue;
  lines.push(`## ${area} · ${title}`, '', '| ID | Feature | Tier | Phase | Done when | Test |', '|---|---|---|---|---|---|');
  for (const f of fs) {
    const phase = f.note ? `${f.phase} (${f.note})` : f.phase;
    lines.push(`| ${f.id} | ${esc(f.name)} | ${f.tier} | ${esc(phase)} | ${esc(f.done_when)} | ${esc(f.test)} |`);
  }
  lines.push('');
}
const out = lines.join('\n');
if (process.argv.includes('--check')) {
  const cur = (() => {
    try {
      return readFileSync('SPEC.md', 'utf8');
    } catch {
      return '';
    }
  })();
  if (cur !== out) {
    console.error('SPEC.md is stale: run npm run spec');
    process.exit(1);
  }
  console.log(`SPEC.md current: ${spec.features.length} features`);
} else {
  writeFileSync('SPEC.md', out);
  console.log(`SPEC.md written: ${spec.features.length} features (D ${byTier.D}, R ${byTier.R}, N ${byTier.N})`);
}
