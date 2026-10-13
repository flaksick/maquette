// Durable JSON store for the probe. All OPFS writes go through sync access handles in this
// worker (decision row "Persistence": createWritable has a silent-data-loss report).
import { openSync, readJsonSync, writeJsonSync, workerScope } from './opfs';

type Req =
  | { id: number; op: 'get'; name: string }
  | { id: number; op: 'set'; name: string; value: unknown }
  | { id: number; op: 'merge'; name: string; value: Record<string, unknown> }
  | { id: number; op: 'append'; name: string; key: string; value: unknown };

const scope = workerScope();
let chain: Promise<unknown> = Promise.resolve();

async function handle(req: Req): Promise<unknown> {
  const h = await openSync(req.name);
  try {
    if (req.op === 'get') return readJsonSync(h);
    if (req.op === 'set') {
      writeJsonSync(h, req.value);
      return true;
    }
    const cur = (readJsonSync<Record<string, unknown>>(h) ?? {}) as Record<string, unknown>;
    if (req.op === 'merge') {
      writeJsonSync(h, { ...cur, ...req.value });
      return true;
    }
    const list = Array.isArray(cur[req.key]) ? (cur[req.key] as unknown[]) : [];
    list.push(req.value);
    writeJsonSync(h, { ...cur, [req.key]: list });
    return true;
  } finally {
    h.close();
  }
}

scope.onmessage = (e: MessageEvent<Req>) => {
  const req = e.data;
  // Serialize operations so two writes to one file never race for its lock.
  chain = chain.then(
    () => handle(req).then(
      (value) => scope.postMessage({ id: req.id, ok: true, value }),
      (err) => scope.postMessage({ id: req.id, ok: false, error: String(err) }),
    ),
  );
};
