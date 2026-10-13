// Spike S6: Apple Pencil fidelity and browser-gesture suppression (PLT-6, NAV-2, NAV-3).
// Counts what leaked through instead of asking whether things "felt fine".
import { button, el } from './ui';
import { round } from './stats';

interface TypeStats {
  downs: number;
  moves: number;
  coalesced: number;
  predicted: number;
  activeMs: number;
  pressureMin: number;
  pressureMax: number;
  tiltXRange: [number, number];
  tiltYRange: [number, number];
  altitudeSeen: boolean;
  azimuthSeen: boolean;
  twistValues: Set<number>;
  hoverMoves: number;
  cancels: number;
  fractionalCoords: number;
}

const newStats = (): TypeStats => ({
  downs: 0, moves: 0, coalesced: 0, predicted: 0, activeMs: 0,
  pressureMin: Infinity, pressureMax: -Infinity,
  tiltXRange: [Infinity, -Infinity], tiltYRange: [Infinity, -Infinity],
  altitudeSeen: false, azimuthSeen: false, twistValues: new Set(), hoverMoves: 0, cancels: 0,
  fractionalCoords: 0,
});

const STEPS = [
  'Draw slow lines with the Pencil, then fast scribbles (about 10 seconds).',
  'Press and hold the Pencil still on the pad for 2 seconds.',
  'Tap with two fingers a few times, then with three fingers a few times.',
  'Pinch and spread with two fingers.',
  'Swipe in from the left and right screen edges.',
  'Draw with the Pencil while resting your palm on the screen.',
];

const QUESTIONS: [string, string][] = [
  ['magnifier', 'Holding the Pencil still: did a magnifier, loupe or menu appear?'],
  ['systemBar', 'Three-finger tap: did the system Undo/Copy bar appear?'],
  ['pageMoved', 'Did the page zoom, scroll or bounce at any point?'],
  ['palmBroke', 'Palm resting while drawing: did the line break or stop?'],
];

export function openInputPad(onDone: (result: Record<string, unknown>) => void): void {
  const byType: Record<string, TypeStats> = {};
  const counters = {
    viewportScaleChanges: 0, maxViewportScale: 1, scrolls: 0, selections: 0, contextMenus: 0,
    touchDownsWhilePen: 0, twoFingerTaps: 0, threeFingerTaps: 0, gesturestart: 0,
  };
  const answers: Record<string, boolean | null> = Object.fromEntries(QUESTIONS.map(([k]) => [k, null]));
  const pensDown = new Set<number>();
  const strokeStart = new Map<number, number>();
  const touches = new Map<number, { t: number; x: number; y: number; moved: boolean }>();
  let tapGroup: { ids: Set<number>; start: number; moved: boolean; ended: number } | null = null;

  const pad = el('canvas', { cls: 'pad' });
  const counterEl = el('pre', { cls: 'counters' });
  const qEls = QUESTIONS.map(([key, text]) => {
    const yes = button('Yes', () => setAnswer(key, true));
    const no = button('No', () => setAnswer(key, false));
    const row = el('div', { cls: 'question' }, el('span', {}, text), yes, no);
    return { key, row, yes, no };
  });
  function setAnswer(key: string, v: boolean) {
    answers[key] = v;
    for (const q of qEls) {
      if (q.key !== key) continue;
      q.yes.classList.toggle('on', v);
      q.no.classList.toggle('on', !v);
    }
  }
  const overlay = el(
    'div',
    { cls: 'overlay' },
    el('div', { cls: 'pad-side' },
      el('h2', {}, 'Pencil & gestures'),
      el('ol', {}, ...STEPS.map((s) => el('li', {}, s))),
      ...qEls.map((q) => q.row),
      counterEl,
      button('Done', () => finish(), 'primary'),
    ),
    pad,
  );
  document.body.append(overlay);

  const ctx = pad.getContext('2d')!;
  const resize = () => {
    pad.width = pad.clientWidth * devicePixelRatio;
    pad.height = pad.clientHeight * devicePixelRatio;
    ctx.scale(devicePixelRatio, devicePixelRatio);
    ctx.lineCap = 'round';
  };
  resize();

  const st = (t: string) => (byType[t] ??= newStats());

  function sample(e: PointerEvent, s: TypeStats) {
    if (e.pressure > 0) {
      s.pressureMin = Math.min(s.pressureMin, e.pressure);
      s.pressureMax = Math.max(s.pressureMax, e.pressure);
    }
    s.tiltXRange = [Math.min(s.tiltXRange[0], e.tiltX), Math.max(s.tiltXRange[1], e.tiltX)];
    s.tiltYRange = [Math.min(s.tiltYRange[0], e.tiltY), Math.max(s.tiltYRange[1], e.tiltY)];
    const ext = e as PointerEvent & { altitudeAngle?: number; azimuthAngle?: number };
    if (typeof ext.altitudeAngle === 'number') s.altitudeSeen = true;
    if (typeof ext.azimuthAngle === 'number') s.azimuthSeen = true;
    s.twistValues.add(e.twist);
    if (e.clientX % 1 !== 0 || e.clientY % 1 !== 0) s.fractionalCoords++;
  }

  // Suppression exactly as planned for the app (Architecture → Input).
  const block = (e: Event) => e.preventDefault();
  pad.addEventListener('touchstart', block, { passive: false });
  pad.addEventListener('touchmove', block, { passive: false });
  const onGesture = (e: Event) => {
    counters.gesturestart++;
    e.preventDefault();
  };
  document.addEventListener('gesturestart', onGesture as EventListener, { passive: false });
  document.addEventListener('gesturechange', block as EventListener, { passive: false });
  const onContext = (e: Event) => {
    counters.contextMenus++;
    e.preventDefault();
  };
  document.addEventListener('contextmenu', onContext);
  const onSelection = () => {
    if ((document.getSelection()?.toString() ?? '').length > 0) counters.selections++;
  };
  document.addEventListener('selectionchange', onSelection);
  const onScroll = () => counters.scrolls++;
  window.addEventListener('scroll', onScroll);
  const onViewport = () => {
    const sc = window.visualViewport?.scale ?? 1;
    if (sc !== 1) counters.viewportScaleChanges++;
    counters.maxViewportScale = Math.max(counters.maxViewportScale, sc);
  };
  window.visualViewport?.addEventListener('resize', onViewport);

  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const s = st(e.pointerType);
    s.downs++;
    sample(e, s);
    if (e.pointerType === 'pen') {
      pensDown.add(e.pointerId);
      strokeStart.set(e.pointerId, e.timeStamp);
    } else if (e.pointerType === 'touch') {
      if (pensDown.size > 0) counters.touchDownsWhilePen++;
      touches.set(e.pointerId, { t: e.timeStamp, x: e.clientX, y: e.clientY, moved: false });
      if (!tapGroup || e.timeStamp - tapGroup.start > 150) tapGroup = { ids: new Set(), start: e.timeStamp, moved: false, ended: 0 };
      tapGroup.ids.add(e.pointerId);
    }
    pad.setPointerCapture(e.pointerId);
    ctx.beginPath();
    ctx.moveTo(e.offsetX, e.offsetY);
  });

  pad.addEventListener('pointermove', (e) => {
    const s = st(e.pointerType);
    if (e.pointerType === 'pen' && e.buttons === 0) {
      s.hoverMoves++;
      return;
    }
    if (e.buttons === 0) return;
    s.moves++;
    const co = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const pr = e.getPredictedEvents ? e.getPredictedEvents() : [];
    s.coalesced += co.length;
    s.predicted += pr.length;
    for (const c of co) {
      sample(c, s);
      ctx.lineWidth = e.pointerType === 'pen' ? 1 + c.pressure * 8 : 3;
      ctx.strokeStyle = e.pointerType === 'pen' ? '#d9c7b3' : '#5c7a99';
      ctx.lineTo(c.offsetX, c.offsetY);
    }
    ctx.stroke();
    ctx.beginPath();
    const last = co[co.length - 1] ?? e;
    ctx.moveTo(last.offsetX, last.offsetY);
    const t = touches.get(e.pointerId);
    if (t && Math.hypot(e.clientX - t.x, e.clientY - t.y) > 10) {
      t.moved = true;
      if (tapGroup?.ids.has(e.pointerId)) tapGroup.moved = true;
    }
  });

  const end = (e: PointerEvent, cancelled: boolean) => {
    const s = st(e.pointerType);
    if (cancelled) s.cancels++;
    if (e.pointerType === 'pen') {
      const t0 = strokeStart.get(e.pointerId);
      if (t0 !== undefined) s.activeMs += e.timeStamp - t0;
      pensDown.delete(e.pointerId);
      strokeStart.delete(e.pointerId);
    } else if (e.pointerType === 'touch') {
      touches.delete(e.pointerId);
      if (tapGroup?.ids.has(e.pointerId)) {
        tapGroup.ended++;
        if (tapGroup.ended === tapGroup.ids.size && !tapGroup.moved && e.timeStamp - tapGroup.start < 300) {
          if (tapGroup.ids.size === 2) counters.twoFingerTaps++;
          if (tapGroup.ids.size === 3) counters.threeFingerTaps++;
        }
      }
    }
  };
  pad.addEventListener('pointerup', (e) => end(e, false));
  pad.addEventListener('pointercancel', (e) => end(e, true));

  const show = setInterval(() => {
    const pen = byType.pen;
    counterEl.textContent = JSON.stringify(
      {
        penSamplesPerSec: pen && pen.activeMs > 0 ? round((pen.coalesced / pen.activeMs) * 1000, 0) : null,
        penEventsPerSec: pen && pen.activeMs > 0 ? round((pen.moves / pen.activeMs) * 1000, 0) : null,
        ...counters,
      },
      null,
      1,
    );
  }, 500);

  function finish() {
    clearInterval(show);
    document.removeEventListener('gesturestart', onGesture as EventListener);
    document.removeEventListener('gesturechange', block as EventListener);
    document.removeEventListener('contextmenu', onContext);
    document.removeEventListener('selectionchange', onSelection);
    window.removeEventListener('scroll', onScroll);
    window.visualViewport?.removeEventListener('resize', onViewport);
    overlay.remove();
    const types: Record<string, unknown> = {};
    for (const [k, s] of Object.entries(byType)) {
      types[k] = {
        ...s,
        twistValues: [...s.twistValues].slice(0, 10),
        samplesPerSec: s.activeMs > 0 ? round((s.coalesced / s.activeMs) * 1000, 0) : null,
        eventsPerSec: s.activeMs > 0 ? round((s.moves / s.activeMs) * 1000, 0) : null,
        coalescedPerEvent: s.moves > 0 ? round(s.coalesced / s.moves, 2) : null,
      };
    }
    const leaks =
      counters.viewportScaleChanges + counters.scrolls + counters.selections + counters.contextMenus +
      (byType.pen?.cancels ?? 0) + (answers.magnifier ? 1 : 0) + (answers.pageMoved ? 1 : 0);
    onDone({
      types,
      counters,
      answers,
      gestureLeaks: leaks,
      threeFingerRedoUsable: answers.systemBar === false,
      coalescedAvailable: typeof PointerEvent.prototype.getCoalescedEvents === 'function',
      predictedAvailable: typeof PointerEvent.prototype.getPredictedEvents === 'function',
    });
  }
}
