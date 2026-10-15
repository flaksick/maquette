// Main thread: UI, input capture and supervision of the engine and persist workers.
import { render } from 'preact';
import './style.css';
import EngineWorker from './engine/engine.worker?worker';
import PersistWorker from './persist/persist.worker?worker';
import { App, finishKillTest } from './app';
import { BUDGET, CHANNEL } from './config';
import { SHEETS, ui } from './state';
import { bus } from './bus';
import { InputController } from './input';
import { registerServiceWorker } from './sw-client';
import { onRemeshEvent } from './remesh';
import { onDyntopoStatus } from './dyntopo-ui';
import { call, connectLibrary, onEngineMessage, openProject, refreshProjects, watchStorage } from './projects';
import { holdPresets, loadPrefs, onProjectOpened, prefs, savePrefsNow, setPref } from './prefs';
import { io, ioMessage } from './io-ui';
import { attachPersist, benchRun, budget, onBudget, runBench, startStressTest, stressRun } from './budget-client';
import type { FromEngine, ToEngine } from './shared/protocol';


const persist = new PersistWorker();
// P1b: the main thread's own port to the persist worker (projects, backups, preferences).
connectLibrary(persist, CHANNEL);
void loadPrefs();
watchStorage();
// PLT-8: the main thread's own persist port (budget, speed test, stress test); the stress worker
// gets one more through `connect`.
{
  const ch = new MessageChannel();
  persist.postMessage({ type: 'connect', port: ch.port1, channel: CHANNEL }, [ch.port1]);
  attachPersist(ch.port2, (p) => persist.postMessage({ type: 'connect', port: p, channel: CHANNEL }, [p]));
}
let engine: Worker | null = null;
let canvas: HTMLCanvasElement | null = null;
let restarts = 0;
const queryWaiters: ((r: Extract<FromEngine, { type: 'query-result' }>) => void)[] = [];

export function send(m: ToEngine, transfer: Transferable[] = []): void {
  engine?.postMessage(m, transfer);
}

const input = new InputController(send, () => ui.fingerSculpts.value);

function startEngine(): void {
  const host = document.getElementById('viewport')!;
  canvas?.remove();
  canvas = document.createElement('canvas'); // a transferred canvas can't be transferred again
  canvas.id = 'scene';
  host.prepend(canvas);
  const rect = host.getBoundingClientRect();
  const off = canvas.transferControlToOffscreen();
  const ch = new MessageChannel();
  persist.postMessage({ type: 'connect', port: ch.port1, channel: CHANNEL }, [ch.port1]);
  engine = new EngineWorker();
  engine.onmessage = (e: MessageEvent<FromEngine>) => onEngine(e.data);
  engine.onerror = (e) => {
    e.preventDefault();
    restartEngine(String(e.message));
  };
  engine.postMessage(
    {
      type: 'init',
      canvas: off,
      dpr: Math.min(devicePixelRatio || 1, 2),
      width: rect.width,
      height: rect.height,
      persist: ch.port2,
      channel: CHANNEL,
      budgetMB: BUDGET.mb,
    } satisfies ToEngine,
    [off, ch.port2],
  );
  input.attach(canvas);
}

/** PLT-7: the engine stopped (WASM trap). Every acknowledged stroke is on disk; restart. */
function restartEngine(error: string): void {
  restarts++;
  engine?.terminate();
  engine = null;
  ui.notice.value = { level: 'error', text: `The engine stopped (${error.slice(0, 80)}). Restarting — your work is saved up to the last finished stroke.` };
  ui.ready.value = false;
  if (restarts > 3) {
    ui.notice.value = { level: 'error', text: 'The engine keeps stopping. Your work is saved; close Maquette fully and reopen it.' };
    return;
  }
  setTimeout(startEngine, 300);
}

function onEngine(m: FromEngine): void {
  onEngineMessage(m); // projects / storage / disk state (P1b)
  if (m.type === 'ready') holdPresets(); // its restored brush is not a preset change (prefs.ts)
  ioMessage(m); // [io] import report, units, STL export details
  switch (m.type) {
    case 'project':
      if (m.error) ui.notice.value = { level: 'warn', text: m.error };
      void onProjectOpened(m);
      break;
    case 'ready':
      ui.ready.value = true;
      onResize(); // the layout may have changed while the engine was starting
      ui.stats.value = m.stats;
      ui.simd.value = m.simd;
      ui.recovered.value = m.recovered;
      if (m.brush) ui.applyBrush(m.brush);
      ui.pushBrush();
      void finishKillTest();
      break;
    case 'stats':
      ui.stats.value = m.stats;
      break;
    case 'saved':
      ui.saved.value = { seq: m.seq, latencyMs: m.latencyMs };
      break;
    case 'status':
      ui.notice.value = { level: m.level, text: m.text };
      break;
    case 'storage':
      ui.storage.value = { ok: m.ok, error: m.error };
      break;
    case 'refused':
      ui.notice.value = { level: 'warn', text: m.text };
      break;
    case 'export-ready':
      ui.exportFile.value = { name: m.name, file: new File([m.bytes], m.name, { type: m.mime ?? 'text/plain' }), faces: m.faces, verts: m.verts };
      break;
    case 'fatal':
      restartEngine(m.error);
      break;
    case 'query-result':
      queryWaiters.shift()?.(m);
      break;
    case 'remesh':
      onRemeshEvent(m.ev);
      break;
    case 'dyntopo':
      onDyntopoStatus(m.status);
      break;
    case 'budget':
      onBudget(m);
      break;
  }
}

/** Test and diagnostics hook: current mesh hash and stats from the engine. */
export function query(): Promise<Extract<FromEngine, { type: 'query-result' }>> {
  return new Promise((resolve) => {
    queryWaiters.push(resolve);
    send({ type: 'query' });
  });
}

function onResize(): void {
  const host = document.getElementById('viewport');
  if (!host) return;
  const r = host.getBoundingClientRect();
  send({ type: 'resize', width: r.width, height: r.height, dpr: Math.min(devicePixelRatio || 1, 2) });
}

bus.send = send;
bus.query = query;
render(<App />, document.getElementById('root')!);
startEngine();
void registerServiceWorker();
// The canvas backing store must track the viewport's real size. Window 'resize' isn't enough:
// in a Home Screen app the status bar / safe-area layout settles after launch without one,
// which left the scene stretched. A ResizeObserver sees every layout change.
let resizeQueued = 0;
const queueResize = () => {
  if (resizeQueued) return;
  resizeQueued = requestAnimationFrame(() => {
    resizeQueued = 0;
    onResize();
  });
};
new ResizeObserver(queueResize).observe(document.getElementById('viewport')!);
window.addEventListener('resize', queueResize);
window.addEventListener('orientationchange', queueResize);
document.addEventListener('visibilitychange', () => send({ type: document.visibilityState === 'visible' ? 'visible' : 'hidden' }));
(window as unknown as { __maquette: unknown }).__maquette = {
  ui,
  query,
  send,
  input: input.stats,
  sheets: SHEETS,
  io,
  // P1b test and diagnostics hooks: the library (persist worker) and preferences.
  budget: { state: budget, bench: benchRun, stress: stressRun, runBench, startStressTest },
  library: { call, refreshProjects, openProject, prefs: () => prefs.value, setPref, savePrefsNow },
};
