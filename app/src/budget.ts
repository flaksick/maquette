// Device budgets (PLT-8, ARCHITECTURE "Device budgets"). Safari hides the iPad's model and RAM, so
// every limit is measured: a lab-measured class prior, a speed benchmark, and learning from the
// memory ledger's high-water marks across sessions. Pure functions and data: the persist worker
// applies them at session start, the UI describes them, tests/budgets.spec.ts drives them directly.

export interface DeviceClass {
  id: string;
  /** Budget for the whole app (WASM + tracked buffers + GPU): 0.6 x the lowest last-good allocation. */
  priorMB: number;
  /** The lowest last-good allocation measured for the class: learning never raises above it. */
  ceilingMB: number;
  source: string;
}

/** DECISIONS 2026-10-13: iPad Air 4 last good 2,432 MB -> 0.6 x 2,432 = 1,459 MB. Unknown iPads
 *  start on the 4 GB prior, the smallest class measured; the stress test measures the rest. */
export const CLASSES: Record<string, DeviceClass> = {
  '4GB': { id: '4GB', priorMB: 1459, ceilingMB: 2432, source: '4 GB-class prior, measured on iPad Air 4 (P0)' },
};
export const DEFAULT_CLASS = '4GB';

export const PRIOR_FACTOR = 0.6; // lab protocol: budget = 0.6 x the observed ceiling
export const CUT_AT = 0.85; // an unclean exit at >= 85% of the budget cuts it...
export const CUT = 0.1; // ...by 10%
export const RAISE_ABOVE = 0.9; // a clean session above 90% of the budget counts toward a raise
export const RAISE_AFTER = 3; // three of them raise it...
export const RAISE = 0.05; // ...by 5%, up to the ceiling
export const FLOOR_MB = 256; // repeated cuts stop here
export const MAX_CHANGES = 20;

/** Speed benchmark: engine time for one 60 Hz frame of a brush stroke must stay under this, leaving
 *  the rest of the 16.7 ms frame to rendering, uploads and the compositor. */
export const FRAME_TARGET_MS = 8;
export const BENCH_VERSION = 1;
/** CPU bytes per triangle in the benchmark (no GPU mirror): ~110 bytes per vertex, 2 tris/vertex. */
export const BENCH_BYTES_PER_TRI = 60;
/** Mesh bytes per triangle in the app (CPU + GPU, engine.worker BYTES_PER_VERTEX = 170 per vertex). */
export const APP_BYTES_PER_TRI = 85;

export interface BenchSize {
  tris: number;
  verts: number;
  setupMs: number;
  frames: number;
  frameMs: { p50: number; p95: number; mean: number };
  strokeEndMs: number;
}
export interface BenchResult {
  version: number;
  t: string;
  simd: boolean;
  totalMs: number;
  targetMs: number;
  sizes: BenchSize[];
  /** Largest polycount whose brush frames stay under targetMs (interpolated, capped by memory). */
  comfortableTris: number;
  limitedBy: 'speed' | 'memory';
  /** Largest mesh the benchmark was allowed to build (declared transient vs the budget). */
  maxTris: number;
}
export interface StressResult {
  t: string;
  /** killed: iPadOS closed the app (the real ceiling); refused: allocation failed first;
   *  capped: reached the cap without either (a lower bound only). */
  outcome: 'killed' | 'refused' | 'capped';
  lastOkMB: number;
  failedAtMB: number | null;
  /** The app's own memory (WASM + GPU) when the test started: part of what the iPad held. */
  appMB: number;
  totalMB: number;
}
export interface BudgetChange {
  t: string;
  fromMB: number;
  toMB: number;
  reason: string;
}
export interface BudgetState {
  schema: 1;
  classId: string;
  priorMB: number;
  ceilingMB: number;
  budgetMB: number;
  basis: 'prior' | 'learned' | 'stress-test';
  priorSource: string;
  /** Sessions learned from since the prior was set. */
  sessions: number;
  /** Clean sessions above 90% since the last change. */
  cleanHigh: number;
  changes: BudgetChange[];
  stress: StressResult | null;
  bench: BenchResult | null;
}
/** session.json (persist worker): one per launch; beats every 2 s carry the ledger high-water. */
export interface SessionRecord {
  open: boolean;
  start: string;
  beat: string;
  highWaterMB: number;
  seq: number;
  /** Budget in force during the session (the learning's denominator). */
  budgetMB?: number;
  /** Set when the app is about to kill itself on purpose: such exits teach nothing about real use. */
  deliberate?: 'kill-test' | 'stress-test' | null;
}
/** stress-marker.json: written durably BEFORE each allocation step (the S1 lab protocol). */
export interface StressMarker {
  t: string;
  phase: 'start' | 'growing' | 'ok' | 'refused' | 'capped';
  attemptMB: number;
  lastOkMB: number;
  appMB: number;
  applied: boolean;
}

export function initialBudget(classId = DEFAULT_CLASS): BudgetState {
  const c = CLASSES[classId] ?? CLASSES[DEFAULT_CLASS];
  return {
    schema: 1,
    classId: c.id,
    priorMB: c.priorMB,
    ceilingMB: c.ceilingMB,
    budgetMB: c.priorMB,
    basis: 'prior',
    priorSource: c.source,
    sessions: 0,
    cleanHigh: 0,
    changes: [],
    stress: null,
    bench: null,
  };
}

/** A stored state from an older or damaged file becomes a valid one (missing fields from the prior). */
export function normalizeBudget(raw: unknown): BudgetState {
  const base = initialBudget((raw as BudgetState | null)?.classId);
  if (!raw || typeof raw !== 'object') return base;
  const s = { ...base, ...(raw as Partial<BudgetState>) } as BudgetState;
  const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : d);
  s.priorMB = num(s.priorMB, base.priorMB);
  s.ceilingMB = num(s.ceilingMB, base.ceilingMB);
  s.budgetMB = Math.min(num(s.budgetMB, base.budgetMB), Math.max(s.ceilingMB, s.priorMB));
  s.sessions = Math.max(0, Math.floor(Number(s.sessions) || 0));
  s.cleanHigh = Math.max(0, Math.floor(Number(s.cleanHigh) || 0));
  if (!Array.isArray(s.changes)) s.changes = [];
  if (!['prior', 'learned', 'stress-test'].includes(s.basis)) s.basis = 'prior';
  if (s.bench && s.bench.version !== BENCH_VERSION) s.bench = null; // a changed workload re-measures
  return s;
}

const pct = (f: number) => `${Math.round(f * 100)}%`;
const withChange = (s: BudgetState, c: BudgetChange): BudgetState => ({ ...s, budgetMB: c.toMB, changes: [...s.changes, c].slice(-MAX_CHANGES) });

/** Learns from the previous session (session start). Returns the new state and the change, if any. */
export function learn(s: BudgetState, prev: SessionRecord | null, now: string): { state: BudgetState; change: BudgetChange | null } {
  if (!prev?.start) return { state: s, change: null };
  if (prev.deliberate) return { state: s, change: null };
  const budgetThen = prev.budgetMB && prev.budgetMB > 0 ? prev.budgetMB : s.budgetMB;
  const frac = Math.max(0, prev.highWaterMB) / budgetThen;
  let next: BudgetState = { ...s, sessions: s.sessions + 1 };
  let change: BudgetChange | null = null;
  if (prev.open && frac >= CUT_AT) {
    const to = Math.max(FLOOR_MB, Math.round(next.budgetMB * (1 - CUT)));
    next.cleanHigh = 0;
    if (to < next.budgetMB) {
      change = { t: now, fromMB: next.budgetMB, toMB: to, reason: `cut 10%: Maquette closed unexpectedly at ${pct(frac)} of the ${budgetThen.toLocaleString('en-US')} MB budget` };
      next = { ...withChange(next, change), basis: 'learned' };
    }
  } else if (prev.open) {
    // An unclean exit well under the budget isn't a memory kill, but it isn't evidence of headroom.
    next.cleanHigh = 0;
  } else if (frac > RAISE_ABOVE) {
    next.cleanHigh += 1;
    if (next.cleanHigh >= RAISE_AFTER) {
      next.cleanHigh = 0;
      const to = Math.min(next.ceilingMB, Math.round(next.budgetMB * (1 + RAISE)));
      if (to > next.budgetMB) {
        change = { t: now, fromMB: next.budgetMB, toMB: to, reason: `raised 5%: ${RAISE_AFTER} clean sessions above 90% of the budget` };
        next = { ...withChange(next, change), basis: 'learned' };
      }
    }
  }
  return { state: next, change };
}

/** What a stress test that ended (by a kill or otherwise) measured, from its durable marker. */
export function stressFromMarker(m: StressMarker | null, now: string): StressResult | null {
  if (!m || m.applied) return null;
  // 'growing' = killed while attempting attemptMB; 'ok'/'start' = killed between steps.
  const outcome: StressResult['outcome'] = m.phase === 'refused' ? 'refused' : m.phase === 'capped' ? 'capped' : 'killed';
  const failedAtMB = outcome === 'capped' ? null : m.phase === 'growing' || m.phase === 'refused' ? m.attemptMB : null;
  return { t: now, outcome, lastOkMB: m.lastOkMB, failedAtMB, appMB: m.appMB, totalMB: m.lastOkMB + m.appMB };
}

/** A measured ceiling replaces the class prior (0.6 x what this iPad held). A capped run is only a
 *  lower bound, so it can raise the prior and ceiling but never lower them. */
export function applyStress(s: BudgetState, r: StressResult, now: string): { state: BudgetState; change: BudgetChange | null } {
  const held = Math.round(r.totalMB);
  const day = now.slice(0, 10);
  let prior = Math.max(FLOOR_MB, Math.round(PRIOR_FACTOR * held));
  let ceiling = Math.max(held, prior);
  if (r.outcome === 'capped') {
    prior = Math.max(prior, s.priorMB);
    ceiling = Math.max(ceiling, s.ceilingMB);
  }
  const verb = r.outcome === 'killed' ? 'held' : r.outcome === 'refused' ? 'allocated' : 'held at least';
  const next: BudgetState = {
    ...s,
    priorMB: prior,
    ceilingMB: ceiling,
    basis: 'stress-test',
    priorSource: `stress test on this iPad (${day}): ${verb} ${held.toLocaleString('en-US')} MB`,
    sessions: 0,
    cleanHigh: 0,
    stress: r,
  };
  if (prior === s.budgetMB) return { state: next, change: null };
  const change = { t: now, fromMB: s.budgetMB, toMB: prior, reason: `stress test: this iPad ${verb} ${held.toLocaleString('en-US')} MB; budget = 0.6 x that` };
  return { state: withChange(next, change), change };
}

/** Where the budget comes from, in words (every limit in the UI shows its source). */
export function budgetSource(s: BudgetState): string {
  if (s.basis === 'learned') return `learned over ${s.sessions} session${s.sessions === 1 ? '' : 's'} (from the ${s.priorSource})`;
  if (s.sessions > 0) return `${s.priorSource}; unchanged over ${s.sessions} session${s.sessions === 1 ? '' : 's'}`;
  return s.priorSource;
}

/** One-word source for tight spots (HUD). */
export function shortSource(s: BudgetState): string {
  if (s.basis === 'learned') return `learned ×${s.sessions}`;
  if (s.basis === 'stress-test') return 'stress-tested';
  return s.classId === DEFAULT_CLASS && s.priorMB === CLASSES[DEFAULT_CLASS].priorMB ? '4 GB prior' : 'prior';
}

export function ceilingSource(s: BudgetState): string {
  return s.stress ? `measured by the stress test (${s.stress.outcome})` : `${CLASSES[s.classId]?.source ?? 'class'} (last good allocation)`;
}

/** Largest polycount whose brush frames stay under the target: interpolated between the last size
 *  that met it and the first that didn't, extrapolated (at most 2x) when every size met it, and
 *  never above what memory allows. */
export function comfortableTris(sizes: BenchSize[], targetMs: number, memoryTris: number): { tris: number; limitedBy: 'speed' | 'memory' } {
  if (!sizes.length) return { tris: 0, limitedBy: 'speed' };
  const p95 = (z: BenchSize) => Math.max(z.frameMs.p95, 1e-3);
  const okIdx = sizes.map((z, i) => (p95(z) <= targetMs ? i : -1)).filter((i) => i >= 0);
  let tris: number;
  if (okIdx.length === sizes.length) {
    const z = sizes[sizes.length - 1];
    tris = z.tris * Math.min(2, targetMs / p95(z));
  } else if (!okIdx.length) {
    tris = (sizes[0].tris * targetMs) / p95(sizes[0]);
  } else {
    const a = sizes[okIdx[okIdx.length - 1]];
    const b = sizes[okIdx[okIdx.length - 1] + 1];
    const f = (targetMs - p95(a)) / Math.max(p95(b) - p95(a), 1e-6);
    tris = a.tris + Math.min(1, Math.max(0, f)) * (b.tris - a.tris);
  }
  const limitedBy = memoryTris < tris ? 'memory' : 'speed';
  return { tris: Math.max(1000, Math.round(Math.min(tris, memoryTris) / 1000) * 1000), limitedBy };
}

/** Triangles whose mesh fits half the budget (the other half: undo history, transients, GPU slack). */
export function memoryTris(budgetMB: number): number {
  return Math.floor((budgetMB * 0.5 * 2 ** 20) / APP_BYTES_PER_TRI);
}

export const fmtTris = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
export const fmtMB = (n: number) => `${Math.round(n).toLocaleString('en-US')} MB`;

// ---------- the budget in force (per thread) ----------
// The engine worker sets it from session-start (learning happens there); the main thread sets it
// from the engine's 'budget' message. Helper workers get the number passed in with their job.
let inForce: BudgetState = initialBudget();

export function setBudget(s: BudgetState): void {
  inForce = s;
}
export function currentBudget(): BudgetState {
  return inForce;
}
/** The learned memory budget for the whole app, in MB (PLT-8). */
export function budgetMB(): number {
  return inForce.budgetMB;
}

export interface Preflight {
  ok: boolean;
  steadyMB: number;
  transientMB: number;
  peakMB: number;
  budgetMB: number;
  /** The refusal sentence, with the numbers and the budget's source (empty when ok). */
  text: string;
}
/** Invariant 6 pre-flight: an operation runs only if steady + transient fits the learned budget;
 *  otherwise it is refused before it starts, with the numbers shown. `steadyMB` is what the app
 *  holds now (WASM memory + GPU; WASM never shrinks), `transientMB` what the operation adds at its
 *  peak (an operation that frees the current mesh first passes the new mesh minus what it frees). */
export function fits(steadyMB: number, transientMB: number, what = 'This operation'): Preflight {
  const b = inForce.budgetMB;
  const peak = Math.max(0, steadyMB) + Math.max(0, transientMB);
  const ok = peak <= b;
  const text = ok
    ? ''
    : `${what} needs about ${fmtMB(transientMB)} on top of ${fmtMB(steadyMB)} in use; this iPad's budget is ${fmtMB(b)} (${budgetSource(inForce)}).`;
  return { ok, steadyMB, transientMB, peakMB: peak, budgetMB: b, text };
}
