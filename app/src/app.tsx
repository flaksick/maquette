// The UI. Every control here maps to a P1a feature in spec.yaml (data-feature attributes are
// checked by the no-fake-UI script, invariant 7).
import { useEffect, useRef, useState } from 'preact/hooks';
import { ui } from './state';
import { bus } from './bus';
import { offline, updateWaiting, autoUpdate, setAutoUpdate, checkForUpdate } from './sw-client';
import BalloonWorker from './balloon.worker?worker';
import type { ToolName } from './shared/protocol';
import { BUDGET, CHANNEL } from './config';

const TOOLS: { id: ToolName; label: string; feature: string }[] = [
  { id: 'draw', label: 'Draw', feature: 'BRS-1' },
  { id: 'smooth', label: 'Smooth', feature: 'BRS-2' },
  { id: 'grab', label: 'Grab', feature: 'BRS-3' },
];

const fmt = (n: number) => n.toLocaleString('en-US');

function SaveChip() {
  const st = ui.stats.value;
  const saved = ui.saved.value;
  if (!ui.storage.value.ok) return <span class="chip bad" data-feature="PLT-13">Not saved: storage unavailable</span>;
  if (!st) return <span class="chip">Starting…</span>;
  const pending = st.seq > (saved?.seq ?? st.lastAcked);
  return (
    <span class={pending ? 'chip' : 'chip ok'} data-feature="PRJ-3" title={saved ? `last save ${saved.latencyMs} ms` : ''}>
      {pending ? 'Saving…' : 'Saved'}
    </span>
  );
}

function TopBar() {
  const st = ui.stats.value;
  return (
    <header class="top">
      <div class="brand">Maquette</div>
      <div class="group">
        <button data-feature="NAV-2" disabled={!st?.undoDepth} onClick={() => bus.send({ type: 'undo' })}>
          Undo{st?.undoDepth ? ` (${st.undoDepth})` : ''}
        </button>
        <button data-feature="NAV-2" disabled={!st?.redoDepth} onClick={() => bus.send({ type: 'redo' })}>
          Redo{st?.redoDepth ? ` (${st.redoDepth})` : ''}
        </button>
      </div>
      <div class="group">
        <button
          data-feature="SYM-1"
          class={ui.symmetry.value ? 'on' : ''}
          aria-pressed={ui.symmetry.value}
          onClick={() => {
            ui.symmetry.value = !ui.symmetry.value;
            ui.pushBrush();
          }}
        >
          Mirror X
        </button>
        <button data-feature="PRM-1" onClick={() => (ui.sheet.value = 'new')}>New</button>
        <button data-feature="EXP-7" onClick={() => {
          ui.exportFile.value = null;
          ui.sheet.value = 'export';
          bus.send({ type: 'export-obj' });
        }}>Export</button>
        <button data-feature="PLT-9" onClick={() => (ui.sheet.value = 'settings')}>Settings</button>
      </div>
      <div class="group right">
        {offline.value.ready ? <span class="chip ok" data-feature="PLT-1">Ready offline</span> : <span class="chip" data-feature="PLT-1">Not offline yet</span>}
        <SaveChip />
      </div>
    </header>
  );
}

function Tools() {
  return (
    <nav class="tools">
      {TOOLS.map((t) => (
        <button key={t.id} data-feature={t.feature} class={ui.tool.value === t.id ? 'tool on' : 'tool'} onClick={() => ui.setTool(t.id)}>
          {t.label}
        </button>
      ))}
    </nav>
  );
}

/** Vertical edge slider (NAV-6). Size shows a live brush ring on the model while dragging. */
function Slider(props: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; preview?: boolean; feature: string; display: string }) {
  const track = useRef<HTMLDivElement>(null);
  const set = (clientY: number) => {
    const r = track.current!.getBoundingClientRect();
    const t = 1 - Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    props.onChange(props.min + t * (props.max - props.min));
  };
  const frac = (props.value - props.min) / (props.max - props.min);
  return (
    <div class="slider" data-feature={props.feature}>
      <div class="slider-label">{props.label}</div>
      <div
        class="track"
        ref={track}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          if (props.preview) bus.send({ type: 'preview-radius', on: true });
          set(e.clientY);
        }}
        onPointerMove={(e) => {
          if (e.buttons) set(e.clientY);
        }}
        onPointerUp={() => props.preview && bus.send({ type: 'preview-radius', on: false })}
        onPointerCancel={() => props.preview && bus.send({ type: 'preview-radius', on: false })}
      >
        <div class="fill" style={{ height: `${frac * 100}%` }} />
      </div>
      <div class="slider-value">{props.display}</div>
    </div>
  );
}

function Sliders() {
  const s = ui.tools.value[ui.tool.value];
  return (
    <div class="sliders">
      <Slider label="Size" feature="NAV-6" value={s.radius} min={5} max={250} preview onChange={(v) => ui.setRadius(Math.round(v))} display={`${Math.round(s.radius)}`} />
      <Slider label="Strength" feature="NAV-6" value={s.strength} min={0.02} max={1} onChange={(v) => ui.setStrength(Math.round(v * 100) / 100)} display={`${Math.round(s.strength * 100)}%`} />
    </div>
  );
}

function Hud() {
  const st = ui.stats.value;
  if (!st) return null;
  const used = st.wasmMiB + st.gpuMiB;
  return (
    <div class="hud" data-feature="TOP-8">
      {fmt(st.tris)} tris · {fmt(st.verts)} verts · memory {fmt(used)} / {fmt(BUDGET.mb)} MB
    </div>
  );
}

function ViewButtons() {
  return (
    <div class="viewbtns">
      <button data-feature="NAV-4" onClick={() => bus.send({ type: 'frame-view' })}>Frame</button>
      <button data-feature="NAV-4" onClick={() => bus.send({ type: 'reset-view' })}>Reset view</button>
    </div>
  );
}

function Sheet(props: { title: string; children: preact.ComponentChildren }) {
  return (
    <div class="sheet-back" onClick={(e) => e.target === e.currentTarget && (ui.sheet.value = 'none')}>
      <div class="sheet" role="dialog" aria-label={props.title}>
        <div class="sheet-head">
          <h2>{props.title}</h2>
          <button data-ui="chrome" onClick={() => (ui.sheet.value = 'none')}>Close</button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

function NewSheet() {
  const [n, setN] = useState(96);
  const tris = 12 * n * n;
  const needMB = Math.round(((6 * n * n + 2) * 170) / 2 ** 20);
  const fits = needMB <= BUDGET.mb;
  return (
    <Sheet title="New sphere">
      <p class="dim">An all-quad sphere. The current sculpt stays saved on this iPad.</p>
      <label class="row">
        Resolution
        <input type="range" min={8} max={512} step={8} value={n} onInput={(e) => setN(Number((e.target as HTMLInputElement).value))} data-feature="PRM-1" />
      </label>
      <p>
        {fmt(tris)} triangles · about {fmt(needMB)} MB {fits ? '' : `· over this iPad's ${fmt(BUDGET.mb)} MB budget`}
      </p>
      <button class="primary" data-feature="PRM-1" disabled={!fits} onClick={() => {
        bus.send({ type: 'new-sphere', n });
        ui.sheet.value = 'none';
      }}>
        Create
      </button>
    </Sheet>
  );
}

function ExportSheet() {
  const f = ui.exportFile.value;
  const [msg, setMsg] = useState('');
  const share = async () => {
    if (!f) return;
    try {
      if (navigator.canShare?.({ files: [f.file] })) {
        await navigator.share({ files: [f.file], title: f.name });
        setMsg('Shared.');
        return;
      }
      setMsg('This browser can’t share files; use Download.');
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setMsg(`Share failed: ${e}`);
    }
  };
  const download = () => {
    if (!f) return;
    const url = URL.createObjectURL(f.file);
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  return (
    <Sheet title="Export OBJ">
      {!f ? (
        <p>Preparing…</p>
      ) : (
        <>
          <p>
            {f.name} · {fmt(f.verts)} vertices · {fmt(f.faces)} faces · {(f.file.size / 2 ** 20).toFixed(1)} MB
          </p>
          <div class="row">
            <button class="primary" data-feature="EXP-7" onClick={share}>Share…</button>
            <button data-feature="EXP-7" onClick={download}>Download</button>
          </div>
          {msg && <p class="dim">{msg}</p>}
        </>
      )}
    </Sheet>
  );
}

function SettingsSheet() {
  const [auto, setAuto] = useState(autoUpdate());
  const [upd, setUpd] = useState('');
  return (
    <Sheet title="Settings">
      <label class="row toggle">
        <input type="checkbox" checked={ui.fingerSculpts.value} onChange={(e) => (ui.fingerSculpts.value = (e.target as HTMLInputElement).checked)} data-feature="NAV-3" />
        Finger sculpts (one finger draws; two fingers still move the view)
      </label>
      <label class="row">
        Pressure
        <input type="range" min={0.4} max={2.5} step={0.05} value={ui.gamma.value} data-feature="STK-2" onInput={(e) => {
          ui.gamma.value = Number((e.target as HTMLInputElement).value);
          ui.pushBrush();
        }} />
        <span class="dim">{ui.gamma.value < 0.95 ? 'soft' : ui.gamma.value > 1.05 ? 'firm' : 'linear'}</span>
      </label>
      <label class="row toggle">
        <input type="checkbox" checked={auto} data-feature="PLT-2" onChange={(e) => {
          const on = (e.target as HTMLInputElement).checked;
          setAuto(on);
          setAutoUpdate(on);
        }} />
        Check for updates automatically (only ever downloads Maquette's own files)
      </label>
      <div class="row">
        <button data-feature="PLT-2" onClick={async () => setUpd(await checkForUpdate())}>Check for updates now</button>
        {upd && <span class="dim">{upd}</span>}
      </div>
      {updateWaiting.value && <p class="ok-text">An update is ready. It applies the next time you open Maquette.</p>}
      <p class="dim">Undo history clears when Maquette closes; your sculpt itself is saved after every stroke.</p>
      <p class="dim">
        Version {offline.value.version ?? 'dev'} · engine {ui.simd.value ? 'SIMD' : 'scalar'} · memory budget {fmt(BUDGET.mb)} MB ({BUDGET.source})
      </p>
      <button data-feature="PLT-9" onClick={() => (ui.sheet.value = 'diag')}>Diagnostics…</button>
    </Sheet>
  );
}

// ---------- diagnostics: device kill test (PRJ-4 on device) and report (PLT-9) ----------
const KILL_PENDING = 'maquette-killtest-pending';
const KILL_RESULTS = 'maquette-killtests';
function readLS<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
}
function writeLS(k: string, v: unknown): void {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
}

/** Called once the engine is ready: finishes a kill test started before the app died. */
export async function finishKillTest(): Promise<void> {
  const pending = readLS<{ hash: string; seq: number; t: string } | null>(KILL_PENDING, null);
  if (!pending) return;
  localStorage.removeItem(KILL_PENDING);
  const q = await bus.query();
  const pass = q.hash === pending.hash;
  const results = readLS<unknown[]>(KILL_RESULTS, []);
  results.push({ t: pending.t, seq: pending.seq, expected: pending.hash, got: q.hash, pass });
  writeLS(KILL_RESULTS, results);
  ui.notice.value = { level: pass ? 'info' : 'error', text: `Kill test ${results.length}: ${pass ? 'PASS, nothing lost' : 'FAIL, the recovered sculpt differs'}.` };
}

async function readCrashLog(): Promise<unknown> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(`app-${CHANNEL}`).catch(() => null);
    if (!dir) return null;
    const f = await (await dir.getFileHandle('crashlog.json')).getFile();
    return JSON.parse(await f.text());
  } catch {
    return null;
  }
}

function DiagSheet() {
  const [info, setInfo] = useState<string>('');
  const results = readLS<{ pass: boolean }[]>(KILL_RESULTS, []);
  useEffect(() => {
    void bus.query().then((q) => setInfo(JSON.stringify({ hash: q.hash, ...q.stats, storageOk: q.storageOk }, null, 1)));
  }, []);
  const startKill = async () => {
    const st = ui.stats.value;
    if (!st || st.seq !== st.lastAcked) {
      ui.notice.value = { level: 'warn', text: 'Wait until the last stroke shows Saved, then start the kill test.' };
      return;
    }
    const q = await bus.query();
    writeLS(KILL_PENDING, { hash: q.hash, seq: st.seq, t: new Date().toISOString() });
    ui.notice.value = { level: 'warn', text: 'Kill test running: Maquette will fill memory until iOS closes it. Reopen it from the Home Screen.' };
    new BalloonWorker().postMessage({});
  };
  const share = async () => {
    const q = await bus.query();
    const report = {
      generatedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio },
      standalone: matchMedia('(display-mode: standalone)').matches,
      offline: offline.value,
      budget: BUDGET,
      stats: q.stats,
      hash: q.hash,
      storageOk: q.storageOk,
      recovered: ui.recovered.value,
      killTests: readLS(KILL_RESULTS, []),
      input: (window as unknown as { __maquette?: { input?: unknown } }).__maquette?.input ?? null,
      crashLog: await readCrashLog(),
      estimate: await navigator.storage.estimate().catch(() => null),
      persisted: await navigator.storage.persisted().catch(() => null),
    };
    const name = `maquette-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const file = new File([JSON.stringify(report, null, 1)], name, { type: 'application/json' });
    try {
      if (navigator.canShare?.({ files: [file] })) return await navigator.share({ files: [file], title: name });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    a.click();
  };
  return (
    <Sheet title="Diagnostics">
      <p class="dim">Kill tests so far: {results.length} ({results.filter((r) => r.pass).length} passed)</p>
      <div class="row">
        <button data-feature="PLT-9" onClick={startKill}>Run kill test</button>
        <button data-feature="PLT-9" onClick={() => void share()}>Share report</button>
        <button data-feature="PLT-7" onClick={() => bus.send({ type: 'debug-trap' })}>Engine crash test</button>
      </div>
      <pre class="diag">{info}</pre>
    </Sheet>
  );
}

function Notice() {
  const n = ui.notice.value;
  if (!n) return null;
  return (
    <div class={`notice ${n.level}`} onClick={() => (ui.notice.value = null)}>
      {n.text}
    </div>
  );
}

function StorageBanner() {
  if (ui.storage.value.ok) return null;
  return (
    <div class="banner" data-feature="PLT-13">
      Storage is unavailable here ({ui.storage.value.error ?? 'private browsing?'}). Your work can’t be saved in this window: open
      Maquette from its Home Screen icon. Export still works.
    </div>
  );
}

export function App() {
  const sheet = ui.sheet.value;
  return (
    <div class="app">
      <TopBar />
      <StorageBanner />
      <main id="viewport">
        <Tools />
        <Sliders />
        <Hud />
        <ViewButtons />
        <Notice />
        {!ui.ready.value && <div class="loading">Loading your sculpt…</div>}
      </main>
      {sheet === 'new' && <NewSheet />}
      {sheet === 'export' && <ExportSheet />}
      {sheet === 'settings' && <SettingsSheet />}
      {sheet === 'diag' && <DiagSheet />}
    </div>
  );
}
