// Input capture on the main thread (invariant 1: capture and forward, never compute).
// Pencil sculpts and fingers navigate (NAV-3): one finger orbits around the surface under it,
// two fingers pan and pinch-zoom (NAV-1). Touches are ignored while the Pencil is down (palm).
// Coalesced Pencil samples are forwarded as [x, y, pressure] triples in CSS pixels (STK-1).
import type { ToEngine } from './shared/protocol';
import { TAP_MAX_DRIFT_PX, TAP_MAX_MS, TwoFingerTap } from './taps';

type Send = (m: ToEngine, transfer?: Transferable[]) => void;

interface Pt {
  x: number;
  y: number;
}

export interface InputStats {
  penStrokes: number;
  penMoves: number;
  penSamples: number;
  penActiveMs: number;
  pressureMin: number;
  pressureMax: number;
  fractionalCoords: number;
  touchesIgnoredWhilePen: number;
  coalescedAvailable: boolean;
  /** NAV-2: two-finger taps recognized (each sent one undo). */
  twoFingerTaps: number;
}

export class InputController {
  readonly stats: InputStats = {
    penStrokes: 0,
    penMoves: 0,
    penSamples: 0,
    penActiveMs: 0,
    pressureMin: 1,
    pressureMax: 0,
    fractionalCoords: 0,
    touchesIgnoredWhilePen: 0,
    coalescedAvailable: typeof PointerEvent !== 'undefined' && typeof PointerEvent.prototype.getCoalescedEvents === 'function',
    twoFingerTaps: 0,
  };
  // NAV-2: two-finger tap = undo. With Finger sculpts on (NAV-3), a finger's stroke starts only
  // once it has moved TAP_MAX_DRIFT_PX or stayed down TAP_MAX_MS: a second finger before that
  // makes it a gesture, so a two-finger tap never leaves a dab behind (which the undo would
  // then remove instead of the stroke the user meant).
  private taps = new TwoFingerTap();
  private pendingFinger: { id: number; x: number; y: number; samples: number[]; timer: ReturnType<typeof setTimeout> } | null = null;
  private strokeStart = 0;
  private canvas: HTMLCanvasElement | null = null;
  private send: Send;
  private fingerSculpts: () => boolean;
  private rect: DOMRect | null = null;
  private strokeId: number | null = null;
  private strokeIsPen = false;
  private touches = new Map<number, Pt>();
  private mouseOrbit: Pt | null = null;
  private lastCentroid: Pt | null = null;
  private lastDist = 0;
  private detach: (() => void) | null = null;

  constructor(send: Send, fingerSculpts: () => boolean) {
    this.send = send;
    this.fingerSculpts = fingerSculpts;
  }

  private capture(id: number): void {
    try {
      this.canvas!.setPointerCapture(id);
    } catch {
      // Synthetic or already-released pointers can't be captured; input still works.
    }
  }

  private local(e: { clientX: number; clientY: number }): Pt {
    const r = this.rect ?? this.canvas!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  attach(canvas: HTMLCanvasElement): void {
    this.detach?.();
    this.canvas = canvas;
    canvas.style.touchAction = 'none';
    const block = (e: Event) => e.preventDefault();
    const opts = { passive: false } as AddEventListenerOptions;
    const down = (e: PointerEvent) => this.down(e);
    const move = (e: PointerEvent) => this.move(e);
    const up = (e: PointerEvent) => this.up(e);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = this.local(e);
      this.send({ type: 'zoom', factor: Math.exp(e.deltaY * 0.0015), x: p.x, y: p.y });
    };
    canvas.addEventListener('pointerdown', down, opts);
    canvas.addEventListener('pointermove', move, opts);
    canvas.addEventListener('pointerup', up, opts);
    canvas.addEventListener('pointercancel', up, opts);
    canvas.addEventListener('touchstart', block, opts); // stops the tap-and-hold magnifier
    canvas.addEventListener('touchmove', block, opts);
    canvas.addEventListener('contextmenu', block, opts);
    canvas.addEventListener('wheel', wheel, opts);
    document.addEventListener('gesturestart', block, opts);
    document.addEventListener('gesturechange', block, opts);
    this.detach = () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('touchstart', block);
      canvas.removeEventListener('touchmove', block);
      canvas.removeEventListener('contextmenu', block);
      canvas.removeEventListener('wheel', wheel);
      document.removeEventListener('gesturestart', block);
      document.removeEventListener('gesturechange', block);
    };
  }

  private down(e: PointerEvent): void {
    e.preventDefault();
    this.rect = this.canvas!.getBoundingClientRect();
    const p = this.local(e);
    const sculpts =
      e.pointerType === 'pen' ||
      (e.pointerType === 'mouse' && e.button === 0) ||
      (e.pointerType === 'touch' && this.fingerSculpts() && this.touches.size === 0 && this.strokeId === null);
    if (e.pointerType === 'touch' && this.strokeId !== null && this.strokeIsPen) {
      this.stats.touchesIgnoredWhilePen++; // palm
      return;
    }
    if (e.pointerType === 'touch') this.taps.feed({ kind: 'down', id: e.pointerId, t: e.timeStamp, x: p.x, y: p.y });
    else {
      this.taps.spoil();
      if (e.pointerType === 'pen') this.dropPendingFinger(); // the pen wins over a resting finger
    }
    if (this.pendingFinger && e.pointerType === 'touch') {
      // A second finger before the first one's stroke began: both navigate.
      const f = this.pendingFinger;
      this.dropPendingFinger();
      this.touches.set(f.id, { x: f.x, y: f.y });
      this.send({ type: 'gesture-begin', x: f.x, y: f.y });
      this.capture(e.pointerId);
      this.touches.set(e.pointerId, p);
      this.resetBaseline();
      return;
    }
    if (sculpts && this.strokeId === null && e.pointerType === 'touch' && this.touches.size === 0) {
      this.capture(e.pointerId);
      this.pendingFinger = { id: e.pointerId, x: p.x, y: p.y, samples: [], timer: setTimeout(() => this.startPendingFinger(), TAP_MAX_MS) };
      return;
    }
    if (sculpts && this.strokeId === null) {
      this.strokeId = e.pointerId;
      this.strokeIsPen = e.pointerType === 'pen';
      if (this.strokeIsPen) {
        this.stats.penStrokes++;
        this.strokeStart = e.timeStamp;
      }
      this.capture(e.pointerId);
      this.send({ type: 'stroke-begin', x: p.x, y: p.y, p: this.pressure(e) });
      return;
    }
    if (e.pointerType === 'mouse') {
      this.mouseOrbit = p;
      this.capture(e.pointerId);
      this.send({ type: 'gesture-begin', x: p.x, y: p.y });
      return;
    }
    if (e.pointerType === 'touch') {
      this.capture(e.pointerId);
      this.touches.set(e.pointerId, p);
      if (this.touches.size === 1) this.send({ type: 'gesture-begin', x: p.x, y: p.y });
      this.resetBaseline();
    }
  }

  private dropPendingFinger(): void {
    if (this.pendingFinger) clearTimeout(this.pendingFinger.timer);
    this.pendingFinger = null;
  }

  /** The waiting finger turned out to be a stroke: begin it where it landed, replay its path. */
  private startPendingFinger(): void {
    const f = this.pendingFinger;
    if (!f) return;
    this.dropPendingFinger();
    this.strokeId = f.id;
    this.strokeIsPen = false;
    this.send({ type: 'stroke-begin', x: f.x, y: f.y, p: 1 });
    if (f.samples.length) {
      const samples = new Float32Array(f.samples);
      this.send({ type: 'stroke-move', samples }, [samples.buffer]);
    }
  }

  private pressure(e: PointerEvent): number {
    if (e.pointerType === 'pen') return e.pressure > 0 ? e.pressure : 0.5;
    return 1;
  }

  private resetBaseline(): void {
    const pts = [...this.touches.values()];
    if (pts.length >= 2) {
      this.lastCentroid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      this.lastDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    } else this.lastCentroid = null;
  }

  private move(e: PointerEvent): void {
    const f = this.pendingFinger;
    if (f && e.pointerId === f.id) {
      const p = this.local(e);
      this.taps.feed({ kind: 'move', id: e.pointerId, t: e.timeStamp, x: p.x, y: p.y });
      f.samples.push(p.x, p.y, 1);
      if (Math.hypot(p.x - f.x, p.y - f.y) >= TAP_MAX_DRIFT_PX) this.startPendingFinger();
      return;
    }
    if (e.pointerType === 'touch' && e.pointerId !== this.strokeId) {
      const p = this.local(e);
      this.taps.feed({ kind: 'move', id: e.pointerId, t: e.timeStamp, x: p.x, y: p.y });
    }
    if (e.pointerId === this.strokeId) {
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      const list = events.length ? events : [e];
      const samples = new Float32Array(list.length * 3);
      if (this.strokeIsPen) {
        this.stats.penMoves++;
        this.stats.penSamples += list.length;
      }
      list.forEach((c, i) => {
        if (this.strokeIsPen) {
          if (c.pressure > 0) {
            this.stats.pressureMin = Math.min(this.stats.pressureMin, c.pressure);
            this.stats.pressureMax = Math.max(this.stats.pressureMax, c.pressure);
          }
          if (c.clientX % 1 !== 0 || c.clientY % 1 !== 0) this.stats.fractionalCoords++;
        }
        const p = this.local(c);
        samples[3 * i] = p.x;
        samples[3 * i + 1] = p.y;
        samples[3 * i + 2] = this.pressure(c);
      });
      this.send({ type: 'stroke-move', samples }, [samples.buffer]);
      return;
    }
    const p = this.local(e);
    if (this.mouseOrbit && e.pointerType === 'mouse') {
      this.send({ type: 'orbit', dx: p.x - this.mouseOrbit.x, dy: p.y - this.mouseOrbit.y });
      this.mouseOrbit = p;
      return;
    }
    const prev = this.touches.get(e.pointerId);
    if (!prev) return;
    this.touches.set(e.pointerId, p);
    if (this.touches.size === 1) {
      this.send({ type: 'orbit', dx: p.x - prev.x, dy: p.y - prev.y });
    } else if (this.touches.size >= 2 && this.lastCentroid) {
      const pts = [...this.touches.values()];
      const c = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      this.send({ type: 'pan', dx: c.x - this.lastCentroid.x, dy: c.y - this.lastCentroid.y });
      if (this.lastDist > 0 && dist > 0) this.send({ type: 'zoom', factor: this.lastDist / dist, x: c.x, y: c.y });
      this.lastCentroid = c;
      this.lastDist = dist;
    }
  }

  private up(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      const p = this.local(e);
      if (this.taps.feed({ kind: e.type === 'pointercancel' ? 'cancel' : 'up', id: e.pointerId, t: e.timeStamp, x: p.x, y: p.y })) {
        this.stats.twoFingerTaps++;
        this.send({ type: 'undo' });
      }
    }
    if (this.pendingFinger?.id === e.pointerId) {
      // Lifted before it moved or stayed: one finger tapped once, which sculpts a dab.
      if (e.type === 'pointercancel') this.dropPendingFinger();
      else this.startPendingFinger();
    }
    if (e.pointerId === this.strokeId) {
      if (this.strokeIsPen) this.stats.penActiveMs += e.timeStamp - this.strokeStart;
      this.strokeId = null;
      this.send({ type: 'stroke-end' });
      return;
    }
    if (e.pointerType === 'mouse') {
      this.mouseOrbit = null;
      return;
    }
    if (this.touches.delete(e.pointerId)) this.resetBaseline();
  }
}
