// UI <-> persist worker: the project library (P1b). The main thread gets its own MessagePort to
// the persist worker, so the gallery, project files, backups and preferences keep working even
// while the engine restarts (a backup must never depend on the engine being healthy). Messages
// share the persist worker's queue with the engine's, so they are serialized with checkpoints;
// long operations serve journal appends between chunks (journal first, invariant 4).
// Opening a project goes through the engine (it must load the mesh): ToEngine 'open-project'.

import type { ToolName } from './protocol';

export interface ProjectInfo {
  id: string;
  name: string;
  createdAt: string;
  /** Newest write to the mesh files (ms since epoch). */
  modifiedAt: number;
  /** Every file in the project folder. */
  bytes: number;
  tris: number;
  verts: number;
  /** Journal records not yet folded into positions.bin by a checkpoint. */
  journalBytes: number;
  /** Set while the project is in Recently Deleted. */
  deletedAt: string | null;
  /** The project the engine has open. */
  current: boolean;
}

export interface ToolPreset {
  radius: number;
  strength: number;
}

/** Global preferences and presets (PRJ-11): survive projects and updates. */
export interface Prefs {
  fingerSculpts: boolean;
  /** Pressure curve exponent (STK-2). */
  gamma: number;
  /** Last-used size and strength per tool: what a new project starts with. */
  tools: Record<ToolName, ToolPreset>;
  autoUpdate: boolean;
  /** NAV-10: the gesture card was dismissed once. */
  gestureCardSeen: boolean;
  /** PRJ-6: when the user last shared or downloaded a backup of everything. */
  lastBackupAt: string | null;
}

export interface ExportedFile {
  file: File;
  /** The name to give the user's copy. */
  name: string;
  bytes: number;
  projects: number;
}

export interface StorageNumbers {
  usage: number;
  quota: number;
  persisted: boolean;
  /** True when the numbers come from the dev-channel simulated disk (PLT-11 tests). */
  simulated: boolean;
}

export interface ImportResult {
  projects: { id: string; name: string; tris: number }[];
}

export type ToLibrary =
  | { id: number; op: 'list' }
  | { id: number; op: 'rename'; projectId: string; name: string }
  | { id: number; op: 'duplicate'; projectId: string }
  | { id: number; op: 'trash'; projectId: string }
  | { id: number; op: 'restore'; projectId: string }
  | { id: number; op: 'purge'; projectId: string }
  | { id: number; op: 'export'; projectId: string }
  | { id: number; op: 'backup' }
  | { id: number; op: 'import'; file: File }
  | { id: number; op: 'prefs-get' }
  | { id: number; op: 'prefs-set'; prefs: Prefs }
  | { id: number; op: 'storage' }
  | { id: number; op: 'maintenance' }
  | { id: number; op: 'debug-disk'; allowance: number | null };

export type LibraryOp = ToLibrary['op'];

/** `code` lets the UI react without parsing messages: 'quota' = out of space (PLT-11),
 *  'current' = the operation needs another project open first. */
export interface LibraryReply {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
  code?: 'quota' | 'current' | 'invalid';
}

/** PLT-11: below this much free space, growth-causing edits are blocked up front. */
export const LOW_SPACE_BYTES = 200 * 2 ** 20;
/** PRJ-1: Recently Deleted keeps a project this long before purging it. */
export const TRASH_DAYS = 30;
