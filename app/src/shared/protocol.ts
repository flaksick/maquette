// Messages between the three threads. The main thread never touches the mesh (invariant 1);
// the engine worker is its only writer (invariant 2); the persist worker owns storage.
import type { BenchResult, BudgetChange, BudgetState, StressResult } from '../budget';

// Tool names are stable: saved brush state and presets are keyed by them. Ids are the engine's
// (core/src/brushes.rs Tool).
export type ToolName =
  | 'draw' | 'smooth' | 'grab' | 'inflate' | 'flatten' | 'clay' | 'clay-strips'
  | 'crease' | 'pinch' | 'snake-hook' | 'layer' | 'fill' | 'scrape' | 'planar';
export const TOOL_ID: Record<ToolName, number> = {
  draw: 0, smooth: 1, grab: 2, inflate: 3, flatten: 4, clay: 5, 'clay-strips': 6,
  crease: 7, pinch: 8, 'snake-hook': 9, layer: 10, fill: 11, scrape: 12, planar: 13,
};

/** Falloff presets (STK-4), engine ids in order. */
export const FALLOFFS = ['smooth', 'smoother', 'sphere', 'root', 'sharp', 'linear', 'pow4', 'invsquare', 'constant'] as const;
export type FalloffName = (typeof FALLOFFS)[number];

export interface BrushState {
  tool: ToolName;
  radiusPx: number; // CSS pixels; the engine converts to device pixels
  strength: number;
  pressureRadius: boolean;
  pressureStrength: boolean;
  gamma: number;
  symmetryX: boolean;
  // Optional so brush state saved before they existed still loads (PRJ-10).
  symmetryY?: boolean;
  symmetryZ?: boolean;
  falloff?: FalloffName;
  hardness?: number;
  autosmooth?: number;
  accumulate?: boolean;
}

export interface Stats {
  verts: number;
  tris: number;
  leaves: number;
  pages: number;
  undoDepth: number;
  redoDepth: number;
  undoKiB: number;
  seq: number;
  gpuMiB: number;
  wasmMiB: number;
  dirtyLeaves: number;
  frames: number;
  lastAcked: number;
  journalBytes: number;
}

export interface CameraState {
  eye: [number, number, number];
  yaw: number;
  pitch: number;
}

/** Main -> engine. */
export type ToEngine =
  | { type: 'init'; canvas: OffscreenCanvas; dpr: number; width: number; height: number; persist: MessagePort; channel: string; budgetMB: number }
  | { type: 'resize'; width: number; height: number; dpr: number }
  | { type: 'brush'; brush: BrushState }
  | { type: 'stroke-begin'; x: number; y: number; p: number }
  | { type: 'stroke-move'; samples: Float32Array }
  | { type: 'stroke-end' }
  | { type: 'gesture-begin'; x: number; y: number }
  | { type: 'orbit'; dx: number; dy: number }
  | { type: 'pan'; dx: number; dy: number }
  | { type: 'zoom'; factor: number; x: number; y: number }
  | { type: 'preview-radius'; on: boolean }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'frame-view' }
  | { type: 'reset-view' }
  | { type: 'new-sphere'; n: number }
  | { type: 'export-obj' }
  // [io] import / units / STL export (IMP-0/1/2, PRJ-9, EXP-2)
  | { type: 'import-mesh'; name: string; ext: string; bytes: ArrayBuffer }
  | { type: 'set-units'; units: Units }
  | { type: 'export-stl' }
  | { type: 'visible' }
  | { type: 'hidden' }
  | { type: 'debug-trap' }
  | { type: 'query' }
  // P1b projects (PRJ-1): load another project by id; PLT-11: retry records the disk refused.
  | { type: 'open-project'; id: string }
  | { type: 'disk-retry' }
  // ---- PLT-8 device budgets ----
  | { type: 'budget'; budget: BudgetState }
  | { type: 'remesh'; cmd: RemeshCmd }
  | { type: 'dyntopo'; on: boolean; mode: DetailMode; value: number };

/** TOP-3 dyntopo detail: 0 constant (resolution, edges per unit), 1 screen (pixels), 2 brush (% radius). */
export type DetailMode = 0 | 1 | 2;
export interface DyntopoStatus {
  on: boolean;
  ready: boolean;
  capped: boolean;
  liveTris: number;
  splits: number;
  collapses: number;
}

/** TOP-1 voxel remesh: one envelope each way (engine.worker.ts "TOP-1 remesh" block). */
export type RemeshCmd =
  | { op: 'estimate'; target: number; keepSharp: boolean }
  | { op: 'start'; target: number; keepSharp: boolean }
  | { op: 'cancel' }
  | { op: 'validate' };

export interface RemeshEstimate {
  target: number;
  quads: number;
  voxel: number;
  steadyMB: number;
  transientMB: number;
  peakMB: number;
  budgetMB: number;
  undoMB: number;
  undoable: boolean;
  fits: boolean;
}

export type RemeshEvent =
  | { kind: 'estimate'; est: RemeshEstimate }
  | { kind: 'progress'; progress: number; stage: string }
  | { kind: 'done'; quads: number; verts: number; tris: number; ms: number; slices: number; maxSliceMs: number; undoable: boolean; peakMB: number }
  | { kind: 'cancelled' }
  | { kind: 'refused'; text: string }
  | { kind: 'validate'; boundaryEdges: number; nonManifoldEdges: number; inconsistentEdges: number; nonManifoldVerts: number; components: number; euler: number };

/** Engine -> main. */
export type FromEngine =
  | { type: 'ready'; stats: Stats; recovered: RecoveryInfo; brush?: BrushState; simd: boolean }
  | { type: 'stats'; stats: Stats }
  | { type: 'saved'; seq: number; latencyMs: number }
  | { type: 'status'; text: string; level: 'info' | 'warn' | 'error' }
  | { type: 'storage'; ok: boolean; error?: string; persisted?: boolean }
  | { type: 'export-ready'; name: string; bytes: ArrayBuffer; faces: number; verts: number; format?: 'obj' | 'stl'; mime?: string; boundaryEdges?: number; units?: Units; scale?: number }
  // [io] import / units (IMP-0/1/2, PRJ-9)
  | { type: 'import-done'; report: ImportReport }
  | { type: 'import-failed'; text: string }
  | { type: 'units'; units: Units }
  | { type: 'refused'; text: string }
  | { type: 'state'; brush?: BrushState }
  | { type: 'fatal'; error: string }
  | { type: 'query-result'; hash: string; stats: Stats; storageOk: boolean }
  // P1b: the open project (after launch, new, open; `error` = a switch failed and this one stayed
  // open). `brushRestored` = the brush came from the project's saved state (PRJ-10).
  | { type: 'project'; id: string; name: string; brush: BrushState; brushRestored: boolean; error?: string }
  // PLT-11: the disk refused journal records; edits are blocked until they are saved.
  | { type: 'disk'; full: boolean; unsaved: number }
  // ---- PLT-8 device budgets: the budget in force after session-start learning ----
  | { type: 'budget'; budget: BudgetState; change: BudgetChange | null; stress: StressResult | null }
  | { type: 'remesh'; ev: RemeshEvent }
  | { type: 'dyntopo'; status: DyntopoStatus };

export interface RecoveryInfo {
  project: string;
  records: number;
  stoppedAt: string | null;
  lastSeq: number;
  uncleanExit: boolean;
}

/** Engine <-> persist (over a MessageChannel). */
export type ToPersist =
  | { id: number; type: 'open-last' }
  | { id: number; type: 'create'; projectId: string; name: string; topo: ArrayBuffer; positions: ArrayBuffer }
  | { id: number; type: 'journal'; seq: number; bytes: ArrayBuffer; projectId?: string; resume?: boolean }
  | { id: number; type: 'checkpoint'; seq: number; ranges: Uint32Array; data: ArrayBuffer; projectId?: string }
  | { id: number; type: 'state'; json: string; projectId?: string }
  | { id: number; type: 'open'; projectId: string }
  | { id: number; type: 'session-start' }
  | { id: number; type: 'session-beat'; highWaterMB: number; seq: number }
  | { id: number; type: 'session-end' }
  | { id: number; type: 'estimate' }
  | { id: number; type: 'replace-mesh'; topo: ArrayBuffer; positions: ArrayBuffer; seq: number; projectId?: string }
  // ---- PLT-8 device budgets (main thread and the stress worker have their own ports) ----
  | { id: number; type: 'budget-get' }
  | { id: number; type: 'budget-bench'; bench: BenchResult }
  | { id: number; type: 'session-mark'; deliberate: 'kill-test' | 'stress-test'; appMB: number }
  | { id: number; type: 'stress-mark'; phase: 'growing' | 'ok'; attemptMB: number; lastOkMB: number }
  | { id: number; type: 'stress-end'; outcome: 'refused' | 'capped'; lastOkMB: number; failedAtMB: number | null };

/** session-start reply (PLT-8 learning happens inside it). */
export interface SessionStartResult {
  uncleanExit: boolean;
  budget: BudgetState;
  change: BudgetChange | null;
  stress: StressResult | null;
}
/** stress-end / budget-bench / budget-get reply. */
export interface BudgetReply {
  budget: BudgetState;
  change: BudgetChange | null;
  stress: StressResult | null;
}

export interface OpenResult {
  status: 'none' | 'ok';
  projectId?: string;
  name?: string;
  topo?: ArrayBuffer;
  positions?: ArrayBuffer;
  journal?: ArrayBuffer;
  checkpointSeq?: number;
  state?: string | null;
}

export interface PersistReply {
  id: number;
  ok: boolean;
  error?: string;
  value?: unknown;
  /** 'quota': the disk is full (PLT-11); the operation can be retried once space is freed. */
  code?: 'quota';
}

/** Channel-namespaced storage root (decision row "Persistence"). */
export const STORAGE_ROOT = (channel: string) => `app-${channel}`;

// ---------- [io] import, units, STL export (IMP-0/1/2, PRJ-9, EXP-2) ----------

/** What one unit of the project means (PRJ-9). Index = the engine's code (core/src/io Units). */
export type Units = 'mm' | 'cm' | 'm';
export const UNITS: readonly Units[] = ['mm', 'cm', 'm'];
/** STL export scale: project units -> millimetres. */
export const UNIT_TO_MM: Record<Units, number> = { mm: 1, cm: 10, m: 1000 };

/** IMP-0 counts from core/src/io ImportReport (exact). */
export interface ImportReport {
  name: string;
  format: 'obj' | 'stl-binary' | 'stl-ascii';
  inVerts: number;
  inFaces: number;
  weldedVerts: number;
  droppedDuplicate: number;
  droppedDegenerate: number;
  flippedFaces: number;
  splitNonManifold: number;
  components: number;
  boundaryEdges: number;
  looseVerts: number;
  verts: number;
  faces: number;
  tris: number;
  coloredVerts: number;
  groups: number;
  ignoredElements: number;
  unitsGuess: Units;
  /** min xyz, max xyz in file units (engine axes: Y up). */
  bbox: number[];
  ms: number;
}
