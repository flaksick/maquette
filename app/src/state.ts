// UI state (signals). Per-tool size and strength persist across sessions (PRJ-10 tool state is
// also saved with the project by the engine; this keeps the last-used values for new projects).
import { signal } from '@preact/signals';
import { bus } from './bus';
import type { BrushState, FalloffName, RecoveryInfo, Stats, ToolName } from './shared/protocol';

export interface ToolSetting {
  radius: number;
  strength: number;
  falloff: FalloffName;
  hardness: number;
  autosmooth: number;
  /** Sample the current surface (true) or the stroke-start one (false) (STK-11). */
  accumulate: boolean;
}

// Per-tool defaults. Crease is Dam Standard (sharp falloff); Clay Strips samples the stroke-start
// surface so one stroke lays one strip; drags start at full strength.
const tool = (radius: number, strength: number, more: Partial<ToolSetting> = {}): ToolSetting => ({ radius, strength, falloff: 'smooth', hardness: 0, autosmooth: 0, accumulate: true, ...more });
const DEFAULTS: Record<ToolName, ToolSetting> = {
  draw: tool(40, 0.5),
  smooth: tool(50, 0.5),
  grab: tool(90, 1),
  inflate: tool(50, 0.5),
  flatten: tool(60, 0.5),
  clay: tool(50, 0.5),
  'clay-strips': tool(50, 0.6, { hardness: 0.3, accumulate: false }),
  crease: tool(25, 0.5, { falloff: 'sharp' }),
  pinch: tool(50, 0.5),
  'snake-hook': tool(60, 1),
  layer: tool(50, 0.5),
  fill: tool(60, 0.5),
  scrape: tool(60, 0.5),
  planar: tool(60, 0.6),
};
/** Every sheet the app can show. scripts/check-ui.mjs opens each one (invariant 7: no fake UI),
 *  so a sheet missing from this list is a sheet the registry check never sees. */
export const SHEETS = ['new', 'export', 'settings', 'diag', 'projects', 'import', 'stress', 'remesh'] as const;
export type SheetName = (typeof SHEETS)[number];

/** Pressure drives strength, except for the drags (Grab, Snake Hook), which follow the pencil. */
const pressureOf = (t: ToolName) => ({ radius: false, strength: t !== 'grab' && t !== 'snake-hook' });

export const ui = {
  ready: signal(false),
  stats: signal<Stats | null>(null),
  saved: signal<{ seq: number; latencyMs: number } | null>(null),
  storage: signal<{ ok: boolean; error?: string }>({ ok: true }),
  notice: signal<{ level: 'info' | 'warn' | 'error'; text: string } | null>(null),
  recovered: signal<RecoveryInfo | null>(null),
  simd: signal(true),
  tool: signal<ToolName>('draw'),
  tools: signal<Record<ToolName, ToolSetting>>({ ...DEFAULTS }),
  symmetry: signal(true),
  symmetryY: signal(false),
  symmetryZ: signal(false),
  gamma: signal(1),
  fingerSculpts: signal(false),
  sheet: signal<'none' | SheetName>('none'),
  exportFile: signal<{ name: string; file: File; faces: number; verts: number } | null>(null),

  brush(): BrushState {
    const t = ui.tool.value;
    const s = ui.tools.value[t];
    return {
      tool: t,
      radiusPx: s.radius,
      strength: s.strength,
      pressureRadius: pressureOf(t).radius,
      pressureStrength: pressureOf(t).strength,
      gamma: ui.gamma.value,
      symmetryX: ui.symmetry.value,
      symmetryY: ui.symmetryY.value,
      symmetryZ: ui.symmetryZ.value,
      falloff: s.falloff,
      hardness: s.hardness,
      autosmooth: s.autosmooth,
      accumulate: s.accumulate,
    };
  },

  pushBrush(): void {
    bus.send({ type: 'brush', brush: ui.brush() });
  },

  applyBrush(b: BrushState): void {
    if (!(b.tool in DEFAULTS)) return; // saved by a newer version: keep this version's state
    ui.tool.value = b.tool;
    ui.symmetry.value = b.symmetryX;
    ui.symmetryY.value = b.symmetryY ?? false;
    ui.symmetryZ.value = b.symmetryZ ?? false;
    ui.gamma.value = b.gamma;
    const d = ui.tools.value[b.tool];
    ui.tools.value = {
      ...ui.tools.value,
      [b.tool]: { ...d, radius: b.radiusPx, strength: b.strength, falloff: b.falloff ?? d.falloff, hardness: b.hardness ?? d.hardness, autosmooth: b.autosmooth ?? d.autosmooth, accumulate: b.accumulate ?? d.accumulate },
    };
  },

  /** Changes settings of the current tool (STK-4, STK-11). */
  setToolSetting(patch: Partial<ToolSetting>): void {
    const t = ui.tool.value;
    ui.tools.value = { ...ui.tools.value, [t]: { ...ui.tools.value[t], ...patch } };
    ui.pushBrush();
  },

  setTool(t: ToolName): void {
    ui.tool.value = t;
    ui.pushBrush();
  },

  setRadius(r: number): void {
    const t = ui.tool.value;
    ui.tools.value = { ...ui.tools.value, [t]: { ...ui.tools.value[t], radius: r } };
    ui.pushBrush();
  },

  setStrength(s: number): void {
    const t = ui.tool.value;
    ui.tools.value = { ...ui.tools.value, [t]: { ...ui.tools.value[t], strength: s } };
    ui.pushBrush();
  },
};
