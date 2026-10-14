// UI state (signals). Per-tool size and strength persist across sessions (PRJ-10 tool state is
// also saved with the project by the engine; this keeps the last-used values for new projects).
import { signal } from '@preact/signals';
import { bus } from './bus';
import type { BrushState, RecoveryInfo, Stats, ToolName } from './shared/protocol';

export interface ToolSetting {
  radius: number;
  strength: number;
}

const DEFAULTS: Record<ToolName, ToolSetting> = {
  draw: { radius: 40, strength: 0.5 },
  smooth: { radius: 50, strength: 0.5 },
  grab: { radius: 90, strength: 1 },
};
/** Every sheet the app can show. scripts/check-ui.mjs opens each one (invariant 7: no fake UI),
 *  so a sheet missing from this list is a sheet the registry check never sees. */
export const SHEETS = ['new', 'export', 'settings', 'diag', 'remesh'] as const;
export type SheetName = (typeof SHEETS)[number];

const PRESSURE: Record<ToolName, { radius: boolean; strength: boolean }> = {
  draw: { radius: false, strength: true },
  smooth: { radius: false, strength: true },
  grab: { radius: false, strength: false },
};

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
      pressureRadius: PRESSURE[t].radius,
      pressureStrength: PRESSURE[t].strength,
      gamma: ui.gamma.value,
      symmetryX: ui.symmetry.value,
    };
  },

  pushBrush(): void {
    bus.send({ type: 'brush', brush: ui.brush() });
  },

  applyBrush(b: BrushState): void {
    ui.tool.value = b.tool;
    ui.symmetry.value = b.symmetryX;
    ui.gamma.value = b.gamma;
    ui.tools.value = { ...ui.tools.value, [b.tool]: { radius: b.radiusPx, strength: b.strength } };
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
