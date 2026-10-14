// Shared reader for the feature registry (spec.yaml). One parser, one set of rules, used by
// gen-spec.mjs, check-ui.mjs and feature-status.mjs.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const FEATURE_KEYS = new Set(['id', 'tier', 'phase', 'note', 'name', 'done_when', 'test', 'device']);

/** Parses and validates spec.yaml. Returns { spec, errors }. */
export function loadSpec(path = 'spec.yaml') {
  const spec = parse(readFileSync(path, 'utf8'));
  const errors = [];
  const ids = new Set();
  if (!spec.phases?.includes(spec.current_phase)) errors.push(`current_phase ${spec.current_phase} is not one of phases`);
  for (const f of spec.features) {
    if (ids.has(f.id)) errors.push(`duplicate id ${f.id}`);
    ids.add(f.id);
    if (!/^[A-Z]{3}-\d+$/.test(f.id)) errors.push(`${f.id}: id must look like ABC-1`);
    const area = f.id.split('-')[0];
    if (!spec.areas[area]) errors.push(`${f.id}: unknown area ${area}`);
    if (!['D', 'R', 'N'].includes(f.tier)) errors.push(`${f.id}: bad tier ${f.tier}`);
    if (!spec.phases.includes(f.phase)) errors.push(`${f.id}: bad phase ${f.phase}`);
    for (const k of ['name', 'done_when', 'test']) if (!f[k]) errors.push(`${f.id}: missing ${k}`);
    // An unquoted comma inside a flow mapping silently splits a value into extra keys
    // ("name: A, B" -> name "A" plus key "B"), so unknown keys are errors.
    for (const k of Object.keys(f)) if (!FEATURE_KEYS.has(k)) errors.push(`${f.id}: unknown key "${k}" (unquoted comma in a value?)`);
    if ('device' in f && typeof f.device !== 'boolean') errors.push(`${f.id}: device must be true or false`);
  }
  return { spec, errors };
}

export const phaseIndex = (spec, phase) => spec.phases.indexOf(phase);

/** True if the feature's acceptance needs the reference device (explicit flag, else the name or
 *  test mentions "device"). */
export function needsDevice(f) {
  if (typeof f.device === 'boolean') return f.device;
  return /\bdevice\b/i.test(`${f.name} ${f.test}`);
}

/** Feature IDs at the start of a Rust test name: `brs1_sym1_draw_...` -> [BRS-1, SYM-1]. Only IDs
 *  that exist in the registry count; the first token that isn't one ends the prefix. */
export function idsFromRustName(name, known) {
  const ids = [];
  for (const tok of name.split('_')) {
    const m = /^([a-z]{3})(\d+)$/.exec(tok);
    if (!m) break;
    const id = `${m[1].toUpperCase()}-${m[2]}`;
    if (!known.has(id)) break;
    ids.push(id);
  }
  return ids;
}

/** Feature IDs at the start of a Playwright title: `PLT-3 PLT-8: ...` -> [PLT-3, PLT-8]. */
export function idsFromTitle(title, known) {
  const m = /^((?:[A-Z]{3}-\d+[\s,/+]*)+)(?::|\s|$)/.exec(title);
  if (!m) return [];
  return (m[1].match(/[A-Z]{3}-\d+/g) ?? []).filter((id) => known.has(id));
}
