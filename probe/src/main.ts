// Maquette P0 probe: measures the nine riskiest assumptions on the actual iPad (plan: Risks &
// Phase 0 spikes). Every result is durable (OPFS via a worker) and goes into one shareable report.
import './style.css';
import S1Worker from './s1.worker?worker';
import S2Worker from './s2.worker?worker';
import S3Worker from './s3.worker?worker';
import S5Worker from './s5.worker?worker';
import BalloonWorker from './balloon.worker?worker';
import type { S1Mode } from './s1.worker';
import { results, store, SPIKES } from './store';
import { button, card, countdown, el, type Card } from './ui';
import { deviceInfo } from './device';
import { readJson, probeRoot } from './opfs';
import { scanJournal } from './journal';
import { continueReloadLoop, runThreads, startReloadLoop } from './s4';
import { openInputPad } from './s6';
import { mountFiles } from './s7';
import { mountInstall, recordLaunch } from './s8';

declare const __PROBE_BUILD__: string;
const app = document.getElementById('app')!;
const cards: Record<string, Card> = {};

async function registerSW(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
  if (!navigator.serviceWorker.controller) {
    // First visit: the page isn't controlled yet, so it has no isolation headers. Reload once
    // when the service worker takes control (guarded so it can never loop).
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!sessionStorage.getItem('probe-sw-reload')) {
        sessionStorage.setItem('probe-sw-reload', '1');
        location.reload();
      }
    });
  }
}

// ---------- S1: memory ceiling (crash-and-continue sequence) ----------
interface S1Job { mode: S1Mode; run: number; condition: string }
interface S1State { active: boolean; queue: S1Job[]; index: number }
const S1_MODES: S1Mode[] = ['wasm-grow', 'typed', 'wasm-reserve', 'gpu'];
const S1_RUNS = 2;
const jobKey = (j: { mode: string; run: number; condition: string }) => `${j.condition}/${j.mode}/${j.run}`;

async function s1Start(condition: string) {
  const queue: S1Job[] = [];
  for (let run = 1; run <= S1_RUNS; run++) for (const mode of S1_MODES) queue.push({ mode, run, condition });
  await store.set('s1-state.json', { active: true, queue, index: 0 });
  await s1RunCurrent();
}

async function s1RunCurrent() {
  const st = await store.get<S1State>('s1-state.json');
  if (!st?.active) return;
  const job = st.queue[st.index];
  const c = cards.s1;
  c.status(`run ${st.index + 1}/${st.queue.length}: ${jobKey(job)} — growing…`);
  const w = new S1Worker();
  w.onmessage = async (e: MessageEvent<Record<string, unknown>>) => {
    const m = e.data;
    if (m.type === 'progress') c.status(`run ${st.index + 1}/${st.queue.length}: ${jobKey(job)} — ${m.lastOkMB} MB ok`);
    if (m.type === 'reserved') c.status(`${jobKey(job)}: reserved ${m.reservedMB} MB up front`);
    if (m.type === 'end') {
      w.terminate();
      await s1Record(job, { outcome: m.phase, lastOkMB: m.lastOkMB, failedAtMB: m.failedAtMB ?? null, error: m.error ?? null });
      await s1Advance();
    }
  };
  w.postMessage({ ...job, capMB: job.mode === 'typed' ? 6144 : 4096, markerName: 's1-marker.json' });
}

async function s1Record(job: S1Job, r: Record<string, unknown>) {
  await results.append('s1', 'runs', { ...job, ...r, t: new Date().toISOString() });
}

async function s1Advance() {
  const st = (await store.get<S1State>('s1-state.json'))!;
  st.index++;
  if (st.index >= st.queue.length) {
    st.active = false;
    await store.set('s1-state.json', st);
    await s1Summarize();
    cards.s1.status('memory sequence complete');
    await refresh();
    return;
  }
  await store.set('s1-state.json', st);
  await refresh();
  countdown(cards.s1, 4, 'next memory run', () => void s1RunCurrent());
}

/** On every launch: if a memory run was in flight, the marker says where iOS killed it. */
async function s1Resume(): Promise<void> {
  const st = await store.get<S1State>('s1-state.json');
  if (!st?.active) return;
  const job = st.queue[st.index];
  const marker = await readJson<Record<string, unknown>>('s1-marker.json');
  if (marker && jobKey(marker as unknown as S1Job) === jobKey(job)) {
    const killed = ['start', 'growing', 'reserved'].includes(String(marker.phase));
    await s1Record(job, {
      outcome: killed ? 'killed' : marker.phase,
      killedAtMB: killed ? marker.attemptMB ?? 0 : null,
      lastOkMB: marker.lastOkMB ?? 0,
      reservedMB: marker.reservedMB ?? null,
      error: marker.error ?? null,
    });
    await s1Advance();
  } else {
    // Killed between finishing one run and starting the next: just start the current one.
    countdown(cards.s1, 4, 'next memory run', () => void s1RunCurrent());
  }
}

async function s1Summarize() {
  const r = await results.get<{ runs?: Record<string, unknown>[] }>('s1');
  const groups: Record<string, number[]> = {};
  for (const run of r?.runs ?? []) {
    const key = `${run.condition}/${run.mode}`;
    const ceiling = Number(run.killedAtMB ?? run.failedAtMB ?? run.lastOkMB ?? 0);
    (groups[key] ??= []).push(ceiling);
  }
  const summary: Record<string, unknown> = {};
  for (const [k, xs] of Object.entries(groups)) {
    xs.sort((a, b) => a - b);
    summary[k] = { runs: xs.length, minMB: xs[0], medianMB: xs[Math.floor(xs.length / 2)], all: xs };
  }
  await results.merge('s1', { summary });
}

// ---------- S2: durable saves ----------
interface S2State { active: boolean; remaining: number; inProgress: boolean }

async function s2DurabilityRun() {
  const st = (await store.get<S2State>('s2-state.json'))!;
  await store.set('s2-state.json', { ...st, inProgress: true });
  const c = cards.s2;
  c.status(`kill test: writing journal records… (${st.remaining} run(s) left)`);
  const writer = new S2Worker();
  let balloonStarted = false;
  writer.onmessage = (e: MessageEvent<Record<string, unknown>>) => {
    if (e.data.type === 'acked') {
      c.status(`kill test: ${e.data.seq} records acknowledged; inflating memory to get killed…`);
      if (!balloonStarted && Number(e.data.seq) >= 12) {
        balloonStarted = true;
        const b = new BalloonWorker();
        b.onmessage = (m: MessageEvent<Record<string, unknown>>) => c.status(`kill test: balloon at ${m.data.mb} MB`);
        b.postMessage({ delayMs: Math.floor(Math.random() * 1500) });
      }
    }
    if (e.data.type === 'error') c.status(`kill test error: ${e.data.error}`);
  };
  writer.postMessage({ mode: 'durability' });
}

async function s2Resume(): Promise<void> {
  const st = await store.get<S2State>('s2-state.json');
  if (!st?.active || !st.inProgress) return;
  const dir = await probeRoot();
  let scan = null;
  try {
    const buf = await (await (await dir.getFileHandle('s2-dur-journal.bin')).getFile()).arrayBuffer();
    scan = scanJournal(buf);
  } catch (e) {
    scan = { error: String(e) };
  }
  const ack = await readJson<{ seq: number }>('s2-dur-ack.json');
  const lastValid = (scan as { lastValidSeq?: number }).lastValidSeq ?? -1;
  const pass = ack !== null && lastValid >= ack.seq;
  await results.append('s2', 'killRuns', { t: new Date().toISOString(), ackedSeq: ack?.seq ?? null, scan, pass });
  const remaining = st.remaining - 1;
  await store.set('s2-state.json', { active: remaining > 0, remaining, inProgress: false });
  cards.s2.status(`kill run verified: ${pass ? 'PASS' : 'FAIL'} (acked ${ack?.seq}, intact ${lastValid})`);
  if (remaining > 0) countdown(cards.s2, 4, 'next kill run', () => void s2DurabilityRun());
}

// ---------- S5: GPU worker ----------
let gpu: Worker | null = null;
function mountGpu(c: Card) {
  const canvas = el('canvas', { cls: 'gpu' });
  c.root.insertBefore(canvas, c.root.querySelector('.status'));
  const start = () => {
    if (gpu) return gpu;
    canvas.width = Math.round(canvas.clientWidth * devicePixelRatio);
    canvas.height = Math.round(canvas.clientHeight * devicePixelRatio);
    const off = canvas.transferControlToOffscreen();
    gpu = new S5Worker();
    gpu.onmessage = async (e: MessageEvent<Record<string, unknown>>) => {
      const m = e.data;
      if (m.type === 'caps') await results.merge('s5', { caps: m.caps });
      if (m.type === 'progress') c.status(String(m.text));
      if (m.type === 'size') {
        await results.merge('s5', { [`tris${12 * Number(m.n) ** 2}`]: m.result });
        c.status(`rendered ${12 * Number(m.n) ** 2} triangles`);
        await refresh();
      }
      if (m.type === 'render-done') c.status('render test complete (2M mesh kept for the upload test)');
      if (m.type === 'upload-done') {
        await results.merge('s5', { upload: m.result });
        c.status('upload test complete');
        await refresh();
      }
      if (m.type === 'resume-log') await results.merge('s5', { resume: m.log });
      if (m.type === 'error') c.status(`GPU error: ${m.error}`);
    };
    gpu.postMessage({ type: 'init', canvas: off }, [off]);
    return gpu;
  };
  c.actions.append(
    button('Run render test (1→8M triangles)', () => start().postMessage({ type: 'render-test', sizes: [289, 408, 577, 816], seconds: 3 })),
    button('Run upload test', () => start().postMessage({ type: 'upload-test', seconds: 3 })),
  );
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && gpu) gpu.postMessage({ type: 'resumed' });
  });
}

// ---------- report ----------
async function buildReport() {
  const report: Record<string, unknown> = {
    probeBuild: __PROBE_BUILD__,
    generatedAt: new Date().toISOString(),
    device: await deviceInfo(),
  };
  for (const k of SPIKES) report[k] = await results.get(k);
  report.s4ReloadLoop = await store.get('s4-reload.json');
  return report;
}

async function shareReport() {
  const json = JSON.stringify(await buildReport(), null, 1);
  const name = `maquette-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const file = new File([json], name, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return;
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
  }
  const url = URL.createObjectURL(file);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

async function refresh() {
  for (const k of SPIKES) cards[k]?.result(await results.get(k));
}

// ---------- UI ----------
function buildUI(launch: Record<string, unknown>) {
  app.append(
    el('header', {},
      el('h1', {}, 'Maquette probe'),
      el('p', { cls: 'desc' }, `build ${__PROBE_BUILD__} · everything runs on this iPad; results stay here until you share the report.`),
      el('div', { cls: 'actions' },
        button('Share report (AirDrop to the Mac)', () => void shareReport(), 'primary'),
      ),
    ),
  );

  const s1 = (cards.s1 = card('s1', 'S1 · Memory ceiling',
    'Finds how much memory iOS gives this app before it kills it. The app WILL crash and reopen several times: that is the test. About 10 minutes; keep the app open. Run once with nothing else open (idle), then once after opening a few heavy apps (loaded).'));
  const cond = el('select', {}, el('option', { value: 'idle' }, 'idle'), el('option', { value: 'loaded' }, 'loaded'));
  s1.actions.append(cond, button('Start memory sequence', () => void s1Start(cond.value)));

  const s2 = (cards.s2 = card('s2', 'S2 · Durable saves',
    'How fast a stroke is safely saved while a big checkpoint streams, for two designs (automatic, 30 s); then 3 kill runs: the app writes journal records and gets itself killed; on reopen it checks that every acknowledged record survived.'));
  s2.actions.append(
    button('Save-latency test (30 s)', async () => {
      const run = (mode: string) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const w = new S2Worker();
          w.onmessage = (e: MessageEvent<Record<string, unknown>>) => {
            w.terminate();
            if (e.data.type === 'done') resolve(e.data.result as Record<string, unknown>);
            else reject(new Error(String(e.data.error)));
          };
          w.postMessage({ mode, seconds: 15 });
        });
      try {
        s2.status('single persist worker: 15 s…');
        const single = await run('single');
        s2.status('two persist workers: 15 s…');
        const [ckpt, journal] = await Promise.all([run('ckpt-only'), run('journal-only')]);
        await results.merge('s2', { latencySingleWorker: single, latencyTwoWorkers: { ...journal, ...ckpt } });
        s2.status('latency test complete');
      } catch (e) {
        s2.status(`error: ${e}`);
      }
      await refresh();
    }),
    button('Kill-durability test ×3', async () => {
      await store.set('s2-state.json', { active: true, remaining: 3, inProgress: false });
      await s2DurabilityRun();
    }),
    button('Ask for persistent storage', async () => {
      const persisted = await navigator.storage.persist();
      await results.merge('s2', { persistGranted: persisted, estimate: await navigator.storage.estimate() });
      s2.status(`persist() → ${persisted}`);
      await refresh();
    }),
  );

  const s3 = (cards.s3 = card('s3', 'S3 · Engine speed',
    'Runs the same brush workload (2M triangles, 200 steps) in Rust/WASM with and without SIMD and in TypeScript. About a minute.'));
  s3.actions.append(
    button('Run speed test', () => {
      const w = new S3Worker();
      w.onmessage = async (e: MessageEvent<Record<string, unknown>>) => {
        if (e.data.stage === 'done') {
          await results.merge('s3', e.data.result as Record<string, unknown>);
          s3.status('speed test complete');
          w.terminate();
          await refresh();
        } else if (e.data.stage === 'error') s3.status(`error: ${e.data.error}`);
        else s3.status(`running: ${e.data.stage}…`);
      };
      w.postMessage({});
    }),
  );

  const s4 = (cards.s4 = card('s4', 'S4 · Threads',
    'Checks cross-origin isolation through the service worker, shared-memory limits, and how much faster 1→8 workers run. The reload test reopens the app 20 times by itself.'));
  s4.actions.append(
    button('Run threads test', async () => {
      try {
        const r = await runThreads((t) => s4.status(t));
        await results.merge('s4', r);
        s4.status('threads test complete');
      } catch (e) {
        s4.status(`error: ${e}`);
      }
      await refresh();
    }),
    button('Run 20-reload test', () => void startReloadLoop()),
  );

  const s5 = (cards.s5 = card('s5', 'S5 · GPU',
    'Renders 1, 2, 4 and 8 million triangles the way the app will, then measures partial GPU uploads. Afterwards, switch to another app and back 5 times; each return is checked for a lost or blank canvas.'));
  mountGpu(s5);

  const s6 = (cards.s6 = card('s6', 'S6 · Pencil & gestures',
    'A drawing pad that counts Pencil samples and every browser gesture that leaks through. About 3 minutes.'));
  s6.actions.append(
    button('Open pad', () =>
      openInputPad(async (r) => {
        await results.merge('s6', r);
        s6.status('pencil & gesture results saved');
        await refresh();
      }),
    ),
  );

  const s7 = (cards.s7 = card('s7', 'S7 · Files',
    'Exports test files (including a 200 MB one) through Share and Download, then imports them back with four picker settings and checks every byte.'));
  mountFiles(s7);

  const s8 = (cards.s8 = card('s8', 'S8 · Install & offline',
    'Records every launch (standalone? online? ready offline?) and whether Safari and the Home Screen app can see each other’s data.'));
  mountInstall(s8, launch);

  app.append(...SPIKES.map((k) => cards[k].root));
}

async function main() {
  await registerSW();
  const launch = await recordLaunch();
  buildUI(launch);
  if (store.failure()) {
    app.prepend(
      el('p', { cls: 'status' },
        `Storage is unavailable here (${store.failure()}). Private browsing? Results are kept in memory only; ` +
          'open the probe from the Home Screen icon instead.'),
    );
  }
  await refresh();
  await continueReloadLoop(() => void refresh());
  await s1Resume();
  await s2Resume();
  await refresh();
}

main().catch((e) => {
  app.append(el('pre', { cls: 'result' }, `probe failed to start: ${e}`));
});
