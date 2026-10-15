// TOP-3 dyntopo UI: a top-bar toggle and, while it's on, a detail panel (mode, value, live
// triangles, "detail capped" when the memory budget refused more slack).
import { signal } from '@preact/signals';
import { bus } from './bus';
import type { DetailMode, DyntopoStatus } from './shared/protocol';

interface DynUi {
  on: boolean;
  mode: DetailMode;
  value: Record<DetailMode, number>;
  status: DyntopoStatus | null;
}

// Defaults: constant 40 edges per unit (a unit sphere's edges ~0.025), Blender's 12 px and 25 %.
export const dynUi = signal<DynUi>({ on: false, mode: 1, value: { 0: 40, 1: 12, 2: 25 }, status: null });
(globalThis as unknown as { __maquetteDyntopo: unknown }).__maquetteDyntopo = dynUi; // tests

const MODES: { mode: DetailMode; label: string; min: number; max: number; unit: string }[] = [
  { mode: 0, label: 'Constant', min: 5, max: 400, unit: '/unit' },
  { mode: 1, label: 'Screen', min: 2, max: 40, unit: 'px' },
  { mode: 2, label: 'Brush', min: 5, max: 100, unit: '%' },
];

function push(p: Partial<DynUi>): void {
  const d = { ...dynUi.value, ...p };
  dynUi.value = d;
  bus.send({ type: 'dyntopo', on: d.on, mode: d.mode, value: d.value[d.mode] });
}

/** Engine -> UI (main.tsx routes { type: 'dyntopo' } here). */
export function onDyntopoStatus(status: DyntopoStatus): void {
  dynUi.value = { ...dynUi.value, status };
}

export function DyntopoButton() {
  const on = dynUi.value.on;
  return (
    <button data-feature="TOP-3" class={on ? 'on' : ''} aria-pressed={on} onClick={() => push({ on: !on })}>
      Dyntopo
    </button>
  );
}

export function DyntopoPanel() {
  const d = dynUi.value;
  if (!d.on) return null;
  const m = MODES[d.mode];
  const st = d.status;
  return (
    <div class="hud" style={{ top: '320px', bottom: 'auto', display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-start' }}>
      <div style={{ display: 'flex', gap: '4px' }}>
        {MODES.map((x) => (
          <button key={x.mode} data-feature="TOP-3" class={x.mode === d.mode ? 'on' : ''} onClick={() => push({ mode: x.mode })}>
            {x.label}
          </button>
        ))}
      </div>
      <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        Detail
        <input
          type="range"
          data-feature="TOP-3"
          min={m.min}
          max={m.max}
          value={d.value[d.mode]}
          onInput={(e) => push({ value: { ...d.value, [d.mode]: Number((e.target as HTMLInputElement).value) } })}
        />
        {d.value[d.mode]} {m.unit}
      </label>
      {st && (
        <span>
          {st.liveTris.toLocaleString('en-US')} tris{st.capped && <span class="chip bad" data-feature="TOP-3"> detail capped</span>}
        </span>
      )}
    </div>
  );
}
