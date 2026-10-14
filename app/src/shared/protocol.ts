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
  // P1b projects (PRJ-1): load another project by id; PLT-11: retry records the disk refused.
  | { type: 'open-project'; id: string }
  | { type: 'disk-retry' };

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
  // P1b: the open project (after launch, new, open; `error` = a switch failed and this one stayed
  // open). `brushRestored` = the brush came from the project's saved state (PRJ-10).
  | { type: 'project'; id: string; name: string; brush: BrushState; brushRestored: boolean; error?: string }
  // PLT-11: the disk refused journal records; edits are blocked until they are saved.
  | { type: 'disk'; full: boolean; unsaved: number };

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
  | { id: number; type: 'estimate' };

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
