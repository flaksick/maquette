// TOP-1 voxel remesh UI: a top-bar button, a sheet (target polys, keep sharp, live estimate of
// polys and memory against the budget, start) and a floating progress panel with Cancel. The
// panel is not modal: the view stays live while the engine works in slices.
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { bus } from './bus';
import { ui } from './state';
import type { RemeshEstimate, RemeshEvent } from './shared/protocol';

interface RemeshUi {
  estimate: RemeshEstimate | null;
  running: boolean;
  progress: number;
  stage: string;
  done: Extract<RemeshEvent, { kind: 'done' }> | null;
  validate: Extract<RemeshEvent, { kind: 'validate' }> | null;
  refused: string | null;
}

export const remeshUi = signal<RemeshUi>({ estimate: null, running: false, progress: 0, stage: '', done: null, validate: null, refused: null });
(globalThis as unknown as { __maquetteRemesh: unknown }).__maquetteRemesh = remeshUi; // tests

const set = (p: Partial<RemeshUi>) => (remeshUi.value = { ...remeshUi.value, ...p });
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/** Engine -> UI (main.tsx routes every { type: 'remesh' } message here). */
export function onRemeshEvent(ev: RemeshEvent): void {
  switch (ev.kind) {
    case 'estimate':
      set({ estimate: ev.est });
      break;
    case 'progress':
      set({ running: true, progress: ev.progress, stage: ev.stage });
      break;
    case 'done':
      set({ running: false, progress: 1, done: ev, refused: null });
      ui.notice.value = {
        level: ev.undoable ? 'info' : 'warn',
        text: `Remeshed: ${fmt(ev.quads)} polys in ${(ev.ms / 1000).toFixed(1)} s${ev.undoable ? '' : '. Undo is not available for this remesh (over the undo budget).'}`,
      };
      break;
    case 'cancelled':
      set({ running: false, progress: 0 });
      ui.notice.value = { level: 'info', text: 'Remesh cancelled; the sculpt is unchanged.' };
      break;
    case 'refused':
      set({ running: false, refused: ev.text });
      ui.notice.value = { level: 'warn', text: ev.text };
      break;
    case 'validate':
      set({ validate: ev });
      break;
  }
}

// Target slider: log scale, 1k .. 2M polys.
const MIN = 1_000;
const MAX = 2_000_000;
const toTarget = (v: number) => {
  const t = MIN * Math.pow(MAX / MIN, v / 1000);
  const step = t < 10_000 ? 500 : t < 100_000 ? 1_000 : 10_000;
  return Math.round(t / step) * step;
};
const toSlider = (t: number) => Math.round((1000 * Math.log(t / MIN)) / Math.log(MAX / MIN));

export function RemeshButton() {
  return (
    <button data-feature="TOP-1" disabled={remeshUi.value.running} onClick={() => (ui.sheet.value = 'remesh')}>
      Remesh
    </button>
  );
}

export function RemeshSheet() {
  const [target, setTarget] = useState(50_000);
  const [sharp, setSharp] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => bus.send({ type: 'remesh', cmd: { op: 'estimate', target, keepSharp: sharp } }), 60);
    return () => clearTimeout(t);
  }, [target, sharp]);
  const est = remeshUi.value.estimate;
  const current = est && est.target === target ? est : null;
  return (
    <div class="sheet-back" onClick={(e) => e.target === e.currentTarget && (ui.sheet.value = 'none')}>
      <div class="sheet" role="dialog" aria-label="Remesh">
        <div class="sheet-head">
          <h2>Remesh</h2>
          <button data-ui="chrome" onClick={() => (ui.sheet.value = 'none')}>Close</button>
        </div>
        <p class="dim">Rebuilds the whole sculpt as even quads at the density you choose: fills holes, merges overlaps. The shape stays; the old wireframe doesn't.</p>
        <label class="row">
          Polys
          <input type="range" min={0} max={1000} value={toSlider(target)} data-feature="TOP-1" onInput={(e) => setTarget(toTarget(Number((e.target as HTMLInputElement).value)))} />
          <span>{fmt(target)}</span>
        </label>
        <label class="row toggle">
          <input type="checkbox" checked={sharp} data-feature="TOP-1" onChange={(e) => setSharp((e.target as HTMLInputElement).checked)} />
          Keep sharp edges and corners
        </label>
        {current ? (
          <p data-testid="remesh-estimate">
            About {fmt(current.quads)} polys · voxel {current.voxel.toPrecision(2)} · memory {fmt(current.steadyMB)} MB after, {fmt(current.peakMB)} MB at peak of {fmt(current.budgetMB)} MB
            {!current.undoable && <span class="dim"> · undo not available (the current mesh, {fmt(current.undoMB)} MB, exceeds the undo budget)</span>}
          </p>
        ) : (
          <p class="dim">Estimating…</p>
        )}
        {current && !current.fits && <p class="dim">Over this iPad's memory budget: choose fewer polys.</p>}
        <button
          class="primary"
          data-feature="TOP-1"
          disabled={!current?.fits || remeshUi.value.running}
          onClick={() => {
            set({ running: true, progress: 0, stage: 'starting', done: null, validate: null, refused: null });
            bus.send({ type: 'remesh', cmd: { op: 'start', target, keepSharp: sharp } });
            ui.sheet.value = 'none';
          }}
        >
          Remesh
        </button>
      </div>
    </div>
  );
}

export function RemeshProgress() {
  const r = remeshUi.value;
  if (!r.running) return null;
  return (
    <div class="notice" role="status" data-testid="remesh-progress">
      Remeshing… {Math.round(r.progress * 100)}% {r.stage && <span class="dim">({r.stage})</span>}{' '}
      <button data-feature="TOP-1" onClick={() => bus.send({ type: 'remesh', cmd: { op: 'cancel' } })}>
        Cancel
      </button>
    </div>
  );
}
