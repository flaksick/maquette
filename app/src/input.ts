// Input capture on the main thread (invariant 1: capture and forward, never compute).
// Pencil sculpts and fingers navigate (NAV-3): one finger orbits around the surface under it,
// two fingers pan and pinch-zoom (NAV-1). Touches are ignored while the Pencil is down (palm).
// Coalesced Pencil samples are forwarded as [x, y, pressure] triples in CSS pixels (STK-1).
import type { ToEngine } from './shared/protocol';

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
  };
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
