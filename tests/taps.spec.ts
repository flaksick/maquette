// NAV-2: the two-finger-tap recognizer (app/src/taps.ts) on synthetic touch traces. No device
// recordings exist yet (spike S6's gesture traces moved to the device gate), so the traces are
// generated from a seeded PRNG: pinches, spreads, pans and pinch-then-tap sequences that must
// never fire, and taps that must always fire. Runs in Node (no browser).
import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { TAP_MAX_DRIFT_PX, TAP_MAX_MS, TwoFingerTap, type TouchSample } from '../app/src/taps';

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261014);
const between = (a: number, b: number) => a + (b - a) * rand();

interface Finger {
  id: number;
  down: number;
  up: number;
  /** position at time t (ms since the trace start) */
  at: (t: number) => [number, number];
}

/** Interleaves fingers into one event stream: down, moves every 8–16 ms (±0.5 px jitter), up. */
function trace(fingers: Finger[], t0: number): TouchSample[] {
  const ev: TouchSample[] = [];
  for (const f of fingers) {
    const [x0, y0] = f.at(f.down);
    ev.push({ kind: 'down', id: f.id, t: t0 + f.down, x: x0, y: y0 });
    for (let t = f.down + between(8, 16); t < f.up; t += between(8, 16)) {
      const [x, y] = f.at(t);
      ev.push({ kind: 'move', id: f.id, t: t0 + t, x: x + between(-0.5, 0.5), y: y + between(-0.5, 0.5) });
    }
    const [x1, y1] = f.at(f.up);
    ev.push({ kind: 'up', id: f.id, t: t0 + f.up, x: x1, y: y1 });
  }
  return ev.sort((a, b) => a.t - b.t || (a.kind === 'down' ? -1 : 1));
}

let nextId = 1;
const lerp = (a: number, b: number, k: number) => a + (b - a) * Math.min(1, Math.max(0, k));

/** Two fingers around a centre: distance d0 -> d1, rotation, centroid drift, over `dur` ms. */
function twoFinger(o: { stagger: number; dur: number; d0: number; d1: number; rot: number; drift: [number, number]; liftStagger: number }): Finger[] {
  const cx = between(300, 800);
  const cy = between(250, 550);
  const a0 = between(0, Math.PI);
  const mk = (sign: number, down: number, up: number): Finger => ({
    id: nextId++,
    down,
    up,
    at: (t) => {
      const k = (t - Math.max(o.stagger, 0)) / o.dur;
      const d = lerp(o.d0, o.d1, k) / 2;
      const a = a0 + lerp(0, o.rot, k);
      return [cx + lerp(0, o.drift[0], k) + sign * d * Math.cos(a), cy + lerp(0, o.drift[1], k) + sign * d * Math.sin(a)];
    },
  });
  const end = o.stagger + o.dur;
  return rand() < 0.5 ? [mk(1, 0, end), mk(-1, o.stagger, end + o.liftStagger)] : [mk(1, 0, end + o.liftStagger), mk(-1, o.stagger, end)];
}

function run(events: TouchSample[], spoilAt?: number): number {
  const r = new TwoFingerTap();
  let fires = 0;
  for (const e of events) {
    if (spoilAt !== undefined && e.t >= spoilAt) {
      r.spoil();
      spoilAt = undefined;
    }
    if (r.feed(e)) fires++;
  }
  return fires;
}

test('NAV-2: two-finger tap recognizer: 0 false fires on 50 pinch traces, every tap detected', () => {
  const pinch: TouchSample[][] = [];
  const kinds: Record<string, number> = {};
  const add = (kind: string, ev: TouchSample[]) => {
    pinch.push(ev);
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  };
  // 30 pinches and spreads at ordinary speeds and sizes.
  for (let i = 0; i < 30; i++) {
    const d0 = between(120, 420);
    const d1 = d0 + (rand() < 0.5 ? -1 : 1) * between(24, 300);
    add('pinch/spread', trace(twoFinger({ stagger: between(0, 80), dur: between(150, 1200), d0, d1: Math.max(40, d1), rot: between(-0.5, 0.5), drift: [between(-40, 40), between(-40, 40)], liftStagger: between(0, 80) }), 0));
  }
  // 8 fast, small pinches: shorter than the tap window, but each finger travels >= 11 px.
  for (let i = 0; i < 8; i++) {
    const d0 = between(150, 300);
    add('fast small pinch', trace(twoFinger({ stagger: between(0, 30), dur: between(90, 170), d0, d1: d0 + (rand() < 0.5 ? -1 : 1) * between(24, 40), rot: 0, drift: [0, 0], liftStagger: between(0, 30) }), 0));
  }
  // 6 two-finger pans.
  for (let i = 0; i < 6; i++) {
    const d0 = between(120, 300);
    add('pan', trace(twoFinger({ stagger: between(0, 60), dur: between(120, 600), d0, d1: d0, rot: 0, drift: [between(-200, 200), between(15, 200) * (rand() < 0.5 ? -1 : 1)], liftStagger: between(0, 60) }), 0));
  }
  // 6 pinch, lift one finger, tap a third finger while the other stays down.
  for (let i = 0; i < 6; i++) {
    const d0 = between(150, 300);
    const [a, b] = twoFinger({ stagger: 20, dur: between(300, 700), d0, d1: d0 + between(40, 120), rot: 0, drift: [0, 0], liftStagger: 0 });
    const end = Math.min(a.up, b.up);
    const keep: Finger = { ...a, up: end + 400 };
    const lifted: Finger = { ...b, up: end };
    const tx = between(300, 800);
    const ty = between(250, 550);
    const third: Finger = { id: nextId++, down: end + 60, up: end + 140, at: () => [tx, ty] };
    add('pinch then tap inside', trace([keep, lifted, third], 0));
  }
  expect(pinch.length).toBe(50);

  const taps: TouchSample[][] = [];
  for (let i = 0; i < 50; i++) {
    const stagger = between(0, 60);
    const liftStagger = between(0, 40);
    const dur = between(30, TAP_MAX_MS - 15 - stagger - liftStagger);
    const d0 = between(60, 260);
    const drift = between(0, 4); // each finger moves at most ~4 px plus jitter
    taps.push(trace(twoFinger({ stagger, dur, d0, d1: d0 + (rand() < 0.5 ? -1 : 1) * drift, rot: 0, drift: [between(-drift, drift), between(-drift, drift)], liftStagger }), 0));
  }

  // Controls that must not fire either (not counted in the 50).
  const controls: Record<string, TouchSample[][]> = { slow: [], drifting: [], threeFinger: [], oneFinger: [], sequential: [], withPen: [] };
  for (let i = 0; i < 10; i++) {
    const d0 = between(80, 200);
    controls.slow.push(trace(twoFinger({ stagger: 10, dur: between(TAP_MAX_MS + 5, 400), d0, d1: d0, rot: 0, drift: [0, 0], liftStagger: 0 }), 0));
    const off = between(TAP_MAX_DRIFT_PX + 1, 20);
    controls.drifting.push(trace(twoFinger({ stagger: 10, dur: 120, d0, d1: d0 + 2 * off, rot: 0, drift: [0, 0], liftStagger: 0 }), 0));
    const x = between(300, 800);
    const y = between(250, 550);
    controls.threeFinger.push(trace([0, 1, 2].map((k) => ({ id: nextId++, down: 10 * k, up: 150 + 10 * k, at: () => [x + 60 * k, y] as [number, number] })), 0));
    controls.oneFinger.push(trace([{ id: nextId++, down: 0, up: between(60, 200), at: () => [x, y] }], 0));
  }
  for (let i = 0; i < 5; i++) {
    const x = between(300, 800);
    const y = between(250, 550);
    controls.sequential.push(trace([{ id: nextId++, down: 0, up: 60, at: () => [x, y] }, { id: nextId++, down: 100, up: 180, at: () => [x + 80, y] }], 0));
    const d0 = between(80, 200);
    controls.withPen.push(trace(twoFinger({ stagger: 10, dur: 120, d0, d1: d0, rot: 0, drift: [0, 0], liftStagger: 0 }), 0));
  }

  const pinchFires = pinch.map((ev) => run(ev));
  const tapFires = taps.map((ev) => run(ev));
  const controlFires = Object.fromEntries(
    Object.entries(controls).map(([k, list]) => [k, list.reduce((n, ev) => n + (k === 'withPen' ? run(ev, ev[1].t) : run(ev)), 0)]),
  );
  // All traces through one recognizer, back to back: state resets between gestures.
  const stream: TouchSample[] = [];
  let t = 0;
  for (const ev of [...pinch, ...taps, ...controls.slow, ...controls.threeFinger]) {
    for (const e of ev) stream.push({ ...e, t: e.t + t });
    t = stream[stream.length - 1].t + 500;
  }
  const streamFires = run(stream);

  const result = {
    pinchTraces: pinch.length,
    pinchKinds: kinds,
    falseFiresOnPinch: pinchFires.reduce((a, b) => a + b, 0),
    tapTraces: taps.length,
    tapsDetected: tapFires.filter((n) => n === 1).length,
    controls: Object.fromEntries(Object.entries(controls).map(([k, v]) => [k, v.length])),
    controlFires,
    streamTraces: pinch.length + taps.length + controls.slow.length + controls.threeFinger.length,
    streamFires,
    thresholds: { maxMs: TAP_MAX_MS, maxDriftPx: TAP_MAX_DRIFT_PX },
  };
  console.log(JSON.stringify(result, null, 1));
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/nav2-taps.json', JSON.stringify(result, null, 1));
  expect(result.falseFiresOnPinch).toBe(0);
  expect(result.tapsDetected).toBe(50);
  expect(Object.values(controlFires).reduce((a, b) => a + b, 0)).toBe(0);
  expect(streamFires).toBe(50);
});
