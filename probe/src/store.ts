// Main-thread client for the durable store worker. If OPFS is unavailable (WebKit throws
// UnknownError in private/ephemeral contexts), the store falls back to memory and says so,
// instead of failing the whole page (found by spike S9 on 2026-10-13).
import StoreWorker from './store.worker?worker';

const worker = new StoreWorker();
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let memory: Map<string, unknown> | null = null;
let failure: string | null = null;

worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; value?: unknown; error?: string }>) => {
  const p = pending.get(e.data.id);
  if (!p) return;
  pending.delete(e.data.id);
  if (e.data.ok) p.resolve(e.data.value);
  else p.reject(new Error(e.data.error));
};

function memoryOp(msg: { op: string; name: string; value?: unknown; key?: string }): unknown {
  const m = (memory ??= new Map());
  if (msg.op === 'get') return m.get(msg.name) ?? null;
  if (msg.op === 'set') {
    m.set(msg.name, msg.value);
    return true;
  }
  const cur = (m.get(msg.name) as Record<string, unknown>) ?? {};
  if (msg.op === 'merge') m.set(msg.name, { ...cur, ...(msg.value as Record<string, unknown>) });
  else {
    const list = Array.isArray(cur[msg.key!]) ? (cur[msg.key!] as unknown[]) : [];
    m.set(msg.name, { ...cur, [msg.key!]: [...list, msg.value] });
  }
  return true;
}

async function call<T>(msg: { op: string; name: string; value?: unknown; key?: string }): Promise<T> {
  if (memory) return memoryOp(msg) as T;
  const id = nextId++;
  try {
    return await new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ id, ...msg });
    });
  } catch (e) {
    failure = String(e);
    memory = new Map();
    return memoryOp(msg) as T;
  }
}

export const store = {
  get: <T>(name: string) => call<T | null>({ op: 'get', name }),
  set: (name: string, value: unknown) => call<boolean>({ op: 'set', name, value }),
  merge: (name: string, value: Record<string, unknown>) => call<boolean>({ op: 'merge', name, value }),
  append: (name: string, key: string, value: unknown) => call<boolean>({ op: 'append', name, key, value }),
  /** null when durable storage works; otherwise the error that forced memory-only mode. */
  failure: () => failure,
};

/** Every spike's results live in their own file: r-<key>.json. */
export const results = {
  get: <T = Record<string, unknown>>(key: string) => store.get<T>(`r-${key}.json`),
  merge: (key: string, value: Record<string, unknown>) =>
    store.merge(`r-${key}.json`, { ...value, updatedAt: new Date().toISOString() }),
  append: (key: string, list: string, value: unknown) => store.append(`r-${key}.json`, list, value),
};

export const SPIKES = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'] as const;
