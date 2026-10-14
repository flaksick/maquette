// Import (IMP-0/1/2), project units (PRJ-9) and the export format (EXP-1/EXP-2), kept apart from
// app.tsx: the Import button with its picker and drag-and-drop, the import report sheet that asks
// for the units (the guess preselected), and the OBJ | STL row of the export sheet.
import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { bus } from './bus';
import { ui } from './state';
import { UNITS, UNIT_TO_MM, type FromEngine, type ImportReport, type Units } from './shared/protocol';

export const io = {
  /** The last import's counts (the import sheet shows them). */
  report: signal<ImportReport | null>(null),
  /** File being imported, or null. */
  busy: signal<string | null>(null),
  /** The open project's units. */
  units: signal<Units>('m'),
  /** The import sheet's choice before it's confirmed. */
  pick: signal<Units>('m'),
  format: signal<'obj' | 'stl'>('obj'),
  /** Watertight and scale facts of the last STL export (EXP-2). */
  stl: signal<{ boundaryEdges: number; units: Units; scale: number } | null>(null),
};

const EXTENSIONS = ['obj', 'stl'];

export function extensionOf(name: string): string {
  const m = /\.([^./\\]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

/** IMP-1: the picker has no accept filter (on iOS an extension filter greys out files whose type
 *  the system doesn't know, P0 finding S7), so the extension is checked here. */
export async function importFile(file: File): Promise<void> {
  const ext = extensionOf(file.name);
  if (!EXTENSIONS.includes(ext)) {
    ui.notice.value = { level: 'warn', text: `Maquette imports .obj and .stl files; “${file.name}” isn’t one.` };
    return;
  }
  if (io.busy.value) return;
  io.busy.value = file.name;
  ui.notice.value = { level: 'info', text: `Importing ${file.name}…` };
  try {
    const bytes = await file.arrayBuffer();
    bus.send({ type: 'import-mesh', name: file.name, ext, bytes }, [bytes]);
  } catch (e) {
    io.busy.value = null;
    ui.notice.value = { level: 'error', text: `Couldn’t read ${file.name}: ${e}` };
  }
}

/** Engine messages this module cares about (main.tsx hands it every message). */
export function ioMessage(m: FromEngine): void {
  switch (m.type) {
    case 'import-done':
      io.busy.value = null;
      io.report.value = m.report;
      io.pick.value = m.report.unitsGuess;
      ui.notice.value = null;
      ui.sheet.value = 'import';
      break;
    case 'import-failed':
      io.busy.value = null;
      ui.notice.value = { level: 'error', text: m.text };
      break;
    case 'units':
      io.units.value = m.units;
      break;
    case 'export-ready':
      io.stl.value = m.format === 'stl' ? { boundaryEdges: m.boundaryEdges ?? 0, units: m.units ?? io.units.value, scale: m.scale ?? 1 } : null;
      break;
  }
}

export function requestExport(): void {
  bus.send(io.format.value === 'stl' ? { type: 'export-stl' } : { type: 'export-obj' });
}

/** The Import button, its hidden picker, and drag-and-drop onto the viewport. */
export function ImportButton() {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const vp = document.getElementById('viewport');
    if (!vp) return;
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const drop = (e: DragEvent) => {
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      e.preventDefault();
      void importFile(f);
    };
    vp.addEventListener('dragover', over);
    vp.addEventListener('drop', drop);
    return () => {
      vp.removeEventListener('dragover', over);
      vp.removeEventListener('drop', drop);
    };
  }, []);
  return (
    <>
      <button data-feature="IMP-1" disabled={!!io.busy.value} onClick={() => input.current?.click()}>
        {io.busy.value ? 'Importing…' : 'Import'}
      </button>
      <input
        ref={input}
        type="file"
        data-feature="IMP-1"
        class="hidden-input"
        onChange={(e) => {
          const el = e.currentTarget as HTMLInputElement;
          const f = el.files?.[0];
          el.value = ''; // picking the same file again still fires
          if (f) void importFile(f);
        }}
      />
    </>
  );
}

function UnitChoice(props: { value: Units; onPick: (u: Units) => void }) {
  return (
    <span class="segmented" role="radiogroup" aria-label="Units">
      {UNITS.map((u) => (
        <button key={u} data-feature="PRJ-9" role="radio" aria-checked={props.value === u} class={props.value === u ? 'on' : ''} onClick={() => props.onPick(u)}>
          {u}
        </button>
      ))}
    </span>
  );
}

const n = (x: number) => x.toLocaleString('en-US');
const size = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toPrecision(3));

/** IMP-0's counts, every one shown (a zero is a measurement too). */
function Counts(props: { r: ImportReport }) {
  const r = props.r;
  const rows: [string, string, number][] = [
    ['weldedVerts', 'Duplicate vertices welded', r.weldedVerts],
    ['droppedDuplicate', 'Duplicate faces dropped', r.droppedDuplicate],
    ['droppedDegenerate', 'Degenerate faces dropped', r.droppedDegenerate],
    ['flippedFaces', 'Faces flipped to match their part', r.flippedFaces],
    ['splitNonManifold', 'Vertices split to undo non-manifold joins', r.splitNonManifold],
    ['components', 'Separate parts', r.components],
    ['boundaryEdges', 'Open edges (holes)', r.boundaryEdges],
  ];
  return (
    <table class="counts" data-feature="IMP-0">
      <tbody>
        {rows.map(([key, label, value]) => (
          <tr key={key}>
            <td>{label}</td>
            <td data-count={key}>{n(value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** After an import: what came in, what cleanup changed, and what one unit means (PRJ-9). Opened
 *  without an import, it shows the open project's units. */
export function ImportSheet() {
  const r = io.report.value;
  useEffect(() => {
    if (!r) io.pick.value = io.units.value;
  }, [r]);
  const close = () => (ui.sheet.value = 'none');
  const pick = io.pick.value;
  const dims = r ? [0, 1, 2].map((k) => r.bbox[3 + k] - r.bbox[k]) : null;
  return (
    <div class="sheet-back" onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="sheet" role="dialog" aria-label={r ? `Imported ${r.name}` : 'Units'}>
        <div class="sheet-head">
          <h2>{r ? `Imported ${r.name}` : 'Units'}</h2>
          <button data-ui="chrome" onClick={close}>Close</button>
        </div>
        {r && (
          <>
            <p>
              {n(r.verts)} vertices · {n(r.faces)} faces ({n(r.tris)} triangles) · {r.format.toUpperCase()} · {n(r.ms)} ms. A new project; your previous sculpt stays saved.
            </p>
            <Counts r={r} />
            {r.looseVerts > 0 && <p class="dim">{n(r.looseVerts)} vertices no face used were left out.</p>}
            {r.groups > 1 && <p class="dim">{n(r.groups)} objects and groups were merged into one.</p>}
            {r.coloredVerts > 0 && <p class="dim">{n(r.coloredVerts)} vertex colors were read but not kept: colors arrive with painting.</p>}
            {r.ignoredElements > 0 && <p class="dim">{n(r.ignoredElements)} lines, points or curves were skipped.</p>}
          </>
        )}
        <p>What is one unit of this model? It sets the size of STL exports{r ? '; guessed from its size' : ''}.</p>
        <div class="row">
          <UnitChoice value={pick} onPick={(u) => (io.pick.value = u)} />
          {dims && <span class="dim">{`${dims.map(size).join(' × ')} ${pick}`}</span>}
        </div>
        <button
          class="primary"
          data-feature="PRJ-9"
          onClick={() => {
            bus.send({ type: 'set-units', units: io.pick.value });
            close();
          }}
        >
          Use {pick}
        </button>
      </div>
    </div>
  );
}

/** The format row of the export sheet: OBJ (EXP-1) or binary STL in millimetres (EXP-2). */
export function ExportFormat() {
  const format = io.format.value;
  const stl = io.stl.value;
  const choose = (f: 'obj' | 'stl') => {
    if (f === io.format.value) return;
    io.format.value = f;
    ui.exportFile.value = null;
    requestExport();
  };
  return (
    <>
      <div class="row">
        <span class="segmented" role="radiogroup" aria-label="Format">
          <button data-feature="EXP-1" role="radio" aria-checked={format === 'obj'} class={format === 'obj' ? 'on' : ''} onClick={() => choose('obj')}>
            OBJ
          </button>
          <button data-feature="EXP-2" role="radio" aria-checked={format === 'stl'} class={format === 'stl' ? 'on' : ''} onClick={() => choose('stl')}>
            STL
          </button>
        </span>
      </div>
      {format === 'stl' && (
        <>
          <div class="row">
            One unit is
            <UnitChoice
              value={io.units.value}
              onPick={(u) => {
                bus.send({ type: 'set-units', units: u });
                ui.exportFile.value = null;
                requestExport();
              }}
            />
          </div>
          <p class="dim">Binary STL in millimetres (× {n(UNIT_TO_MM[io.units.value])}), Z up.</p>
          {stl && stl.boundaryEdges > 0 && (
            <p class="warn-text" data-feature="EXP-2" role="alert">
              Not watertight: {n(stl.boundaryEdges)} open edges. Slicers may refuse it or print it hollow.
            </p>
          )}
        </>
      )}
    </>
  );
}
