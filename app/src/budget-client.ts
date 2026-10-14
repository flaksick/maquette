// PLT-8 on the main thread: shows the budget in force (the engine posts it after the persist
// worker's session-start learning), runs the speed benchmark (bench.worker) and the stress test
// (stress.worker), and stores their results through the persist worker on the main thread's own
// port. Every number shown carries its source (budget.ts budgetSource / ceilingSource).
import { signal } from '@preact/signals';
import BenchWorker from './bench.worker?worker';
import StressWorker from './stress.worker?worker';
import { BENCH_BYTES_PER_TRI, FRAME_TARGET_MS, budgetSource, fmtMB, fmtTris, initialBudget, setBudget, type BenchResult, type BudgetChange, type BudgetState, type StressResult } from './budget';
import { ui } from './state';
import { bus } from './bus';
import type { BudgetReply, PersistReply, ToPersist } from './shared/protocol';
import type { BenchJob } from './bench.worker';
import type { StressJob } from './stress.worker';

export const budget = signal<BudgetState>(initialBudget());
export const benchRun = signal<{ running: boolean; note: string }>({ running: false, note: '' });
export const stressRun = signal<{ running: boolean; lastOkMB: number; note: string }>({ running: false, lastOkMB: 0, note: '' });

const BENCH_MS = 10_000;
const BENCH_MAX_TRIS = 2_100_000;
const AUTO_BENCH_IDLE_MS = 4000;

// ---------- persist RPC (main thread's own port) ----------
let port: MessagePort | null = null;
let connectPort: ((p: MessagePort) => void) | null = null;
let nextId = 1;
const waiting = new Map<number, (r: PersistReply) => void>();
type Msg = ToPersist extends infer T ? (T extends { id: number } ? Omit<T, 'id'> : never) : never;

export function attachPersist(p: MessagePort, connect: (p: MessagePort) => void): void {
  port = p;
  connectPort = connect;
  port.onmessage = (e: MessageEvent<PersistReply>) => {
    waiting.get(e.data.id)?.(e.data);
    waiting.delete(e.data.id);
  };
}
function call(msg: Msg): Promise<PersistReply> {
  if (!port) return Promise.resolve({ id: 0, ok: false, error: 'persist not attached' });
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    port!.postMessage({ ...msg, id });
  });
}

function apply(b: BudgetState): void {
  setBudget(b);
  budget.value = b;
}

const appMB = () => (ui.stats.value ? ui.stats.value.wasmMiB + ui.stats.value.gpuMiB : 0);

/** The engine's 'budget' message: the budget in force for this session. */
export function onBudget(m: { budget: BudgetState; change: BudgetChange | null; stress: StressResult | null }): void {
  apply(m.budget);
  if (m.stress) {
    const s = m.stress;
    ui.notice.value = {
      level: 'info',
      text: `Stress test: this iPad ${s.outcome === 'killed' ? `held ${fmtMB(s.totalMB)} before iPadOS closed Maquette` : `reached ${fmtMB(s.totalMB)} (${s.outcome})`}. Memory budget now ${fmtMB(m.budget.budgetMB)} (0.6 × that).`,
    };
  } else if (m.change) {
    ui.notice.value = { level: m.change.toMB < m.change.fromMB ? 'warn' : 'info', text: `Memory budget ${fmtMB(m.change.fromMB)} → ${fmtMB(m.change.toMB)}: ${m.change.reason}.` };
  }
  scheduleAutoBench();
}

// ---------- speed benchmark ----------
let benchWorker: Worker | null = null;
let benchStop: (() => void) | null = null;

/** Runs the ~10 s benchmark in its own worker. Its mesh is a declared transient: it may use at
 *  most half the budget's free headroom (invariant 6), or it doesn't run. */
export async function runBench(opts: { timeMs?: number } = {}): Promise<BenchResult | null> {
  if (benchWorker) return null;
  const freeMB = budget.value.budgetMB - appMB();
  const maxTris = Math.min(BENCH_MAX_TRIS, Math.floor((freeMB * 0.5 * 2 ** 20) / BENCH_BYTES_PER_TRI));
  if (maxTris < 150_000) {
    benchRun.value = { running: false, note: `Not enough free memory for the speed test (${fmtMB(freeMB)} free of ${fmtMB(budget.value.budgetMB)}).` };
    return null;
  }
  benchRun.value = { running: true, note: 'Measuring brush speed…' };
  const w = new BenchWorker();
  benchWorker = w;
  const result = await new Promise<BenchResult | null>((resolve) => {
    benchStop = () => resolve(null);
    w.onmessage = (e) => {
      if (e.data.type === 'progress') benchRun.value = { running: true, note: `Measured ${fmtTris(e.data.size.tris)} triangles: ${e.data.size.frameMs.p95} ms per brush frame (p95)…` };
      if (e.data.type === 'done') resolve(e.data.result);
      if (e.data.type === 'error') {
        benchRun.value = { running: false, note: `Speed test failed: ${e.data.error}` };
        resolve(null);
      }
    };
    w.onerror = () => resolve(null);
    w.postMessage({ maxTris, budgetMB: budget.value.budgetMB, timeMs: opts.timeMs ?? BENCH_MS, targetMs: FRAME_TARGET_MS } satisfies BenchJob);
  });
  w.terminate();
  benchStop = null;
  if (benchWorker !== w) return null; // aborted
  benchWorker = null;
  if (!result) {
    benchRun.value = { running: false, note: benchRun.value.note || 'Speed test stopped.' };
    return null;
  }
  const r = await call({ type: 'budget-bench', bench: result });
  if (r.ok) apply((r.value as BudgetReply).budget);
  else apply({ ...budget.value, bench: result }); // storage unavailable: this session only
  benchRun.value = { running: false, note: '' };
  return result;
}

function abortBench(): void {
  if (!benchWorker) return;
  benchWorker.terminate();
  benchWorker = null;
  benchStop?.();
  benchRun.value = { running: false, note: 'Speed test paused while you sculpt; it resumes when Maquette is idle.' };
  scheduleAutoBench();
}

// Measure once per iPad (and again when the workload changes), only while nothing else happens:
// any touch aborts it, and it retries after the next quiet spell.
let lastInput = performance.now();
let autoTimer: ReturnType<typeof setTimeout> | null = null;
let autoTries = 0;
addEventListener(
  'pointerdown',
  () => {
    lastInput = performance.now();
    abortBench();
  },
  { capture: true },
);
export function scheduleAutoBench(): void {
  if (autoTimer || budget.value.bench || autoTries >= 3 || !ui.storage.value.ok) return;
  autoTimer = setTimeout(function tick() {
    autoTimer = null;
    if (budget.value.bench || stressRun.value.running) return;
    const quiet = performance.now() - lastInput;
    if (!ui.ready.value || quiet < AUTO_BENCH_IDLE_MS || ui.sheet.value !== 'none') {
      autoTimer = setTimeout(tick, Math.max(500, AUTO_BENCH_IDLE_MS - quiet));
      return;
    }
    autoTries++;
    void runBench();
  }, AUTO_BENCH_IDLE_MS);
}

// ---------- stress test ----------
/** Deliberately fills memory until iPadOS closes Maquette (or allocation fails / the cap is hit).
 *  The session is marked deliberate first, so its exit teaches the learning nothing; the next
 *  launch reads the durable marker and sets the budget to 0.6 x what this iPad held. */
export async function startStressTest(opts: { capMB?: number; stepMB?: number; pauseMs?: number } = {}): Promise<void> {
  if (stressRun.value.running) return;
  const st = ui.stats.value;
  if (!ui.storage.value.ok) {
    stressRun.value = { running: false, lastOkMB: 0, note: 'The stress test needs storage to record its result, and storage is unavailable here.' };
    return;
  }
  if (!st || st.seq !== st.lastAcked) {
    stressRun.value = { running: false, lastOkMB: 0, note: 'Wait until the last stroke shows Saved, then start the stress test.' };
    return;
  }
  abortBench();
  const m = await call({ type: 'session-mark', deliberate: 'stress-test', appMB: appMB() });
  if (!m.ok) {
    stressRun.value = { running: false, lastOkMB: 0, note: `Couldn't record the stress test (${m.error}).` };
    return;
  }
  stressRun.value = { running: true, lastOkMB: 0, note: 'Filling memory…' };
  const ch = new MessageChannel();
  connectPort!(ch.port1);
  const w = new StressWorker();
  w.onmessage = async (e) => {
    if (e.data.type === 'progress') {
      stressRun.value = { running: true, lastOkMB: e.data.lastOkMB, note: `Holding ${fmtMB(e.data.lastOkMB + appMB())}…` };
      return;
    }
    if (e.data.type !== 'end') return;
    w.terminate();
    if (e.data.outcome === 'error') {
      stressRun.value = { running: false, lastOkMB: e.data.lastOkMB, note: `Stress test stopped: ${e.data.error}` };
      return;
    }
    // Survived (allocation refused, or the cap): record it now; no relaunch needed.
    const r = await call({ type: 'stress-end', outcome: e.data.outcome, lastOkMB: e.data.lastOkMB, failedAtMB: e.data.failedAtMB });
    if (r.ok) {
      const v = r.value as BudgetReply;
      apply(v.budget);
      bus.send({ type: 'budget', budget: v.budget });
      onBudget({ budget: v.budget, change: v.change, stress: v.stress });
    }
    stressRun.value = { running: false, lastOkMB: e.data.lastOkMB, note: '' };
  };
  w.postMessage({ persist: ch.port2, capMB: opts.capMB ?? 16_384, stepMB: opts.stepMB ?? 64, pauseMs: opts.pauseMs ?? 120 } satisfies StressJob, [ch.port2]);
}

/** Before the diagnostics kill test (balloon): its exit is deliberate, not a memory signal. */
export async function markKillTest(): Promise<void> {
  await call({ type: 'session-mark', deliberate: 'kill-test', appMB: appMB() });
}

// ---------- device report coverage (scripts/feature-status.mjs reads `features`) ----------
export function deviceFeatures(killTests: { pass: boolean; t?: string }[], crashLog: { entries?: { kind?: string; t?: string }[] } | null): Record<string, { pass: boolean; measured: string }> {
  const f: Record<string, { pass: boolean; measured: string }> = {};
  const passed = killTests.filter((k) => k.pass).length;
  if (killTests.length >= 10) f['PRJ-4'] = { pass: passed === killTests.length, measured: `${passed}/${killTests.length} device kill tests recovered the last acknowledged stroke` };
  const kills = (crashLog?.entries ?? []).filter((e) => e.kind === 'unclean-exit' || e.kind?.startsWith('deliberate-'));
  if (killTests.length) f['PLT-12'] = { pass: kills.length > 0, measured: `${kills.length} crash-log entries after ${killTests.length} kill tests` };
  const b = budget.value;
  if (b.bench) {
    f['PLT-8'] = {
      pass: b.bench.comfortableTris > 0,
      measured: `budget ${fmtMB(b.budgetMB)} (${budgetSource(b)}); comfortable ${fmtTris(b.bench.comfortableTris)} tris (speed test ${b.bench.totalMs} ms)`,
    };
  }
  return f;
}
