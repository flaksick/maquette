// Messages between the three threads. The main thread never touches the mesh (invariant 1);
// the engine worker is its only writer (invariant 2); the persist worker owns storage.

export type ToolName = 'draw' | 'smooth' | 'grab';
export const TOOL_ID: Record<ToolName, number> = { draw: 0, smooth: 1, grab: 2 };

export interface BrushState {
  tool: ToolName;
  radiusPx: number; // CSS pixels; the engine converts to device pixels
  strength: number;
  pressureRadius: boolean;
  pressureStrength: boolean;
  gamma: number;
  symmetryX: boolean;
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
  | { type: 'visible' }
  | { type: 'hidden' }
  | { type: 'debug-trap' }
  | { type: 'query' }
  | { type: 'remesh'; cmd: RemeshCmd };

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
  | { type: 'export-ready'; name: string; bytes: ArrayBuffer; faces: number; verts: number }
  | { type: 'refused'; text: string }
  | { type: 'state'; brush?: BrushState }
  | { type: 'fatal'; error: string }
  | { type: 'query-result'; hash: string; stats: Stats; storageOk: boolean }
  | { type: 'remesh'; ev: RemeshEvent };

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
  | { id: number; type: 'journal'; seq: number; bytes: ArrayBuffer }
  | { id: number; type: 'checkpoint'; seq: number; ranges: Uint32Array; data: ArrayBuffer }
  | { id: number; type: 'state'; json: string }
  | { id: number; type: 'session-start' }
  | { id: number; type: 'session-beat'; highWaterMB: number; seq: number }
  | { id: number; type: 'session-end' }
  | { id: number; type: 'estimate' }
  | { id: number; type: 'replace-mesh'; topo: ArrayBuffer; positions: ArrayBuffer; seq: number };

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
}

/** Channel-namespaced storage root (decision row "Persistence"). */
export const STORAGE_ROOT = (channel: string) => `app-${channel}`;
