// Main-thread side of the project library (P1b): the gallery's data (PRJ-1), project files and
// backups (PRJ-5/PRJ-6), storage numbers (PLT-4) and the disk-full state (PLT-11).
// It talks to the persist worker over its own port (shared/library.ts), so it keeps working while
// the engine restarts; only opening or creating a project goes through the engine.
import { computed, signal } from '@preact/signals';
import { bus } from './bus';
import type { FromEngine } from './shared/protocol';
import { LOW_SPACE_BYTES, type LibraryReply, type ProjectInfo, type StorageNumbers, type ToLibrary } from './shared/library';

export class LibraryError extends Error {
  constructor(
    message: string,
    readonly code?: LibraryReply['code'],
  ) {
    super(message);
  }
}

let port: MessagePort | null = null;
let nextId = 1;
const waiting = new Map<number, (r: LibraryReply) => void>();

export function connectLibrary(worker: Worker, channel: string): void {
  const ch = new MessageChannel();
  worker.postMessage({ type: 'connect-ui', port: ch.port1, channel }, [ch.port1]);
  port = ch.port2;
  port.onmessage = (e: MessageEvent<LibraryReply>) => {
    const w = waiting.get(e.data.id);
    if (w) {
      waiting.delete(e.data.id);
      w(e.data);
    }
  };
}

type Req = ToLibrary extends infer T ? (T extends { id: number } ? Omit<T, 'id'> : never) : never;

/** One library request; rejects with a LibraryError carrying the worker's message and code. */
export function call<T = unknown>(req: Req): Promise<T> {
  if (!port) return Promise.reject(new LibraryError('Storage is not connected.'));
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, (r) => (r.ok ? resolve(r.value as T) : reject(new LibraryError(r.error ?? 'failed', r.code))));
    port!.postMessage({ ...req, id });
  });
}

export const projects = signal<ProjectInfo[] | null>(null);
/** The project the engine has open (from its 'project' messages). */
export const current = signal<{ id: string; name: string } | null>(null);
export const storage = signal<StorageNumbers | null>(null);
/** PLT-11: the engine's journal was refused by a full disk; edits wait until it is saved. */
export const disk = signal<{ full: boolean; unsaved: number }>({ full: false, unsaved: 0 });
/** PLT-11: below the reserve, growth-causing edits are blocked up front. */
export const lowSpace = computed(() => {
  const s = storage.value;
  return !!s && s.quota > 0 && s.quota - s.usage < LOW_SPACE_BYTES;
});

export async function refreshProjects(): Promise<ProjectInfo[]> {
  const list = await call<ProjectInfo[]>({ op: 'list' });
  projects.value = list;
  return list;
}

export async function refreshStorage(): Promise<StorageNumbers | null> {
  try {
    storage.value = await call<StorageNumbers>({ op: 'storage' });
  } catch {
    storage.value = null;
  }
  return storage.value;
}

// ---------- engine: open / new (they change the mesh) ----------

type ProjectMsg = Extract<FromEngine, { type: 'project' }>;
let projectWaiter: { accept: (m: ProjectMsg) => boolean; resolve: (m: ProjectMsg) => void } | null = null;

function nextProject(accept: (m: ProjectMsg) => boolean, send: () => void): Promise<ProjectMsg> {
  return new Promise((resolve) => {
    projectWaiter = { accept, resolve };
    send();
  });
}

/** Opens a project in the engine; resolves once it is open, rejects with the engine's reason. */
export async function openProject(id: string): Promise<void> {
  const m = await nextProject(() => true, () => bus.send({ type: 'open-project', id }));
  if (m.id !== id) throw new LibraryError(m.error ?? 'That project could not be opened.');
}

/** Starts a new sphere project in the engine; resolves with the open project afterwards. */
export function newProject(n: number): Promise<ProjectMsg> {
  return nextProject(() => true, () => bus.send({ type: 'new-sphere', n }));
}

/** Moves a project to Recently Deleted. The open project is switched away from first (to the
 *  newest other live project, or a new sphere): the persist worker never trashes an open one. */
export async function trashProject(p: ProjectInfo, all: ProjectInfo[]): Promise<void> {
  if (p.id === current.value?.id) {
    const other = all.find((q) => !q.deletedAt && q.id !== p.id);
    if (other) await openProject(other.id);
    else {
      const m = await newProject(96);
      if (m.id === p.id) throw new LibraryError(m.error ?? 'Could not start a new project to switch to.');
    }
  }
  await call({ op: 'trash', projectId: p.id });
}

// ---------- engine messages this module follows (called from main.tsx) ----------

let maintained = false;
let persistAsked = false;

export function onEngineMessage(m: FromEngine): void {
  switch (m.type) {
    case 'project': {
      current.value = { id: m.id, name: m.name };
      const w = projectWaiter;
      if (w?.accept(m)) {
        projectWaiter = null;
        w.resolve(m);
      }
      break;
    }
    case 'disk':
      disk.value = { full: m.full, unsaved: m.unsaved };
      void refreshStorage();
      break;
    case 'ready':
      if (!maintained) {
        // Once per session, after the project is open: purge Recently Deleted past 30 days and
        // folders an interrupted operation left without a manifest.
        maintained = true;
        void call({ op: 'maintenance' }).catch(() => {});
      }
      void refreshStorage();
      break;
    case 'saved':
      // PLT-4: ask for persistent storage at the first save. Only the page can ask
      // (StorageManager.persist is not exposed to workers).
      if (!persistAsked) {
        persistAsked = true;
        void navigator.storage
          ?.persist?.()
          .catch(() => false)
          .then(() => refreshStorage());
      }
      break;
  }
}

/** PLT-11: re-measure free space now and then (and after every library operation). */
export function watchStorage(): void {
  setInterval(() => {
    if (document.visibilityState === 'visible') void refreshStorage();
  }, 60_000);
}
