// Preferences and presets (PRJ-11): one sealed document in OPFS (A/B slots, written by the
// persist worker), global to the app, so it survives switching projects and app updates.
// It replaces P1a's localStorage key, migrated once and removed after the file is written.
// Per-tool presets are keyed by the tool's stable name; tools missing from the file start from
// the UI's defaults (state.ts), so adding tools needs no change here.
import { effect, signal } from '@preact/signals';
import { ui, type ToolSetting } from './state';
import { call } from './projects';
import type { BrushState } from './shared/protocol';
import type { Prefs, ToolPreset } from './shared/library';

const TOOL_DEFAULTS: Record<string, ToolPreset> = Object.fromEntries(
  Object.entries(ui.tools.value as Record<string, ToolSetting>).map(([k, v]) => [k, { radius: v.radius, strength: v.strength }]),
);

function defaults(): Prefs {
  return { fingerSculpts: false, gamma: 1, tools: { ...TOOL_DEFAULTS }, autoUpdate: true, gestureCardSeen: false, lastBackupAt: null };
}

/** P1a kept one preference in localStorage. */
const LEGACY_AUTO_UPDATE = 'maquette-auto-update';

function readLegacy(): { values: Partial<Prefs>; keys: string[] } {
  try {
    const v = localStorage.getItem(LEGACY_AUTO_UPDATE);
    return v === null ? { values: {}, keys: [] } : { values: { autoUpdate: v !== 'off' }, keys: [LEGACY_AUTO_UPDATE] };
  } catch {
    return { values: {}, keys: [] };
  }
}

/** Accepts only well-formed fields; anything else keeps its default. Unknown tools are kept. */
function sanitize(raw: unknown, base: Prefs): Prefs {
  const p: Prefs = { ...base, tools: { ...base.tools } };
  if (!raw || typeof raw !== 'object') return p;
  const r = raw as Partial<Prefs>;
  if (typeof r.fingerSculpts === 'boolean') p.fingerSculpts = r.fingerSculpts;
  if (typeof r.gamma === 'number' && r.gamma >= 0.1 && r.gamma <= 5) p.gamma = r.gamma;
  if (typeof r.autoUpdate === 'boolean') p.autoUpdate = r.autoUpdate;
  if (typeof r.gestureCardSeen === 'boolean') p.gestureCardSeen = r.gestureCardSeen;
  if (typeof r.lastBackupAt === 'string' && !Number.isNaN(Date.parse(r.lastBackupAt))) p.lastBackupAt = r.lastBackupAt;
  if (r.tools && typeof r.tools === 'object') {
    for (const [name, t] of Object.entries(r.tools)) {
      if (t && Number.isFinite(t.radius) && Number.isFinite(t.strength)) p.tools[name] = { radius: t.radius, strength: t.strength };
    }
  }
  return p;
}

export const prefs = signal<Prefs>(defaults());
/** 'file': stored in OPFS. 'memory': storage unavailable (private browsing), this session only. */
export const prefsSource = signal<'loading' | 'file' | 'memory'>('loading');
/** How many legacy localStorage values the first load moved into the file. */
export const migrated = signal(0);
let resolveReady!: () => void;
export const prefsReady = new Promise<void>((r) => (resolveReady = r));

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export async function savePrefsNow(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (prefsSource.value !== 'file') return;
  await call({ op: 'prefs-set', prefs: prefs.value });
}

function saveSoon(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void savePrefsNow().catch(() => {}), 300);
}

export function setPref(patch: Partial<Prefs>): void {
  prefs.value = { ...prefs.value, ...patch };
  saveSoon();
}

export async function loadPrefs(): Promise<void> {
  let stored: unknown = null;
  let backed = true;
  try {
    stored = await call({ op: 'prefs-get' });
  } catch {
    backed = false;
  }
  const legacy = readLegacy();
  const p = sanitize(stored, stored ? defaults() : { ...defaults(), ...legacy.values });
  prefs.value = p;
  ui.fingerSculpts.value = p.fingerSculpts;
  ui.gamma.value = p.gamma;
  prefsSource.value = backed ? 'file' : 'memory';
  resolveReady();
  if (backed && !stored) {
    // First run of this version: create the file, then retire the localStorage copies.
    try {
      await savePrefsNow();
      for (const k of legacy.keys) localStorage.removeItem(k);
      migrated.value = legacy.keys.length;
    } catch {}
  }
}

/** True while a project's saved brush is being applied: that is not the user changing a preset
 *  (a project's state is saved a second after the last change, so it can be older than the
 *  presets, which must not be overwritten with it). */
let holding = false;
export function holdPresets(): void {
  holding = true;
}

/** After the engine opens a project: the project brings back its tool and mirror setting
 *  (PRJ-10); size and strength per tool come from the presets (PRJ-11), as does the pressure
 *  curve. Then the brush goes out to the engine. */
export async function onProjectOpened(m: { brush: BrushState; brushRestored: boolean }): Promise<void> {
  holding = true;
  try {
    await prefsReady;
    if (m.brushRestored) {
      ui.tool.value = m.brush.tool;
      ui.symmetry.value = m.brush.symmetryX;
    }
    const tools = { ...(ui.tools.value as Record<string, ToolSetting>) };
    for (const name of Object.keys(tools)) {
      const t = prefs.value.tools[name];
      if (t) tools[name] = { ...tools[name], radius: t.radius, strength: t.strength };
    }
    ui.tools.value = tools as typeof ui.tools.value;
    ui.gamma.value = prefs.value.gamma;
  } finally {
    holding = false;
  }
  ui.pushBrush();
}

// Whatever the user changes in the UI becomes the new preset (debounced write).
effect(() => {
  const fingerSculpts = ui.fingerSculpts.value;
  const gamma = ui.gamma.value;
  const tools = ui.tools.value as Record<string, ToolSetting>;
  if (prefsSource.peek() === 'loading' || holding) return;
  const p = prefs.peek();
  const nextTools = { ...p.tools };
  let changed = p.fingerSculpts !== fingerSculpts || p.gamma !== gamma;
  for (const [name, t] of Object.entries(tools)) {
    const old = p.tools[name];
    if (!old || old.radius !== t.radius || old.strength !== t.strength) {
      nextTools[name] = { radius: t.radius, strength: t.strength };
      changed = true;
    }
  }
  if (!changed) return;
  prefs.value = { ...p, fingerSculpts, gamma, tools: nextTools };
  saveSoon();
});
