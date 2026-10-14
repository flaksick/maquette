// Two-finger tap = undo (NAV-2). A pure state machine over touch events, so it can be tested on
// recorded or synthetic traces without a browser (tests/taps.spec.ts).
//
// A two-finger tap is a gesture that
//   - starts with no finger on the screen (so it can never fire inside a pinch or pan),
//   - has exactly two fingers go down, and both down at the same time at some point,
//   - ends (last finger up) less than TAP_MAX_MS after the first finger landed,
//   - never moves any finger TAP_MAX_DRIFT_PX or more from where it landed,
//   - has no cancelled pointer and no pen or mouse contact.
// Three-finger redo is deliberately absent: iPadOS shows its own Undo/Redo bar for three-finger
// gestures and a web page can't suppress it (DECISIONS: redo stays a button).

export const TAP_MAX_MS = 250;
export const TAP_MAX_DRIFT_PX = 10;

export interface TouchSample {
  kind: 'down' | 'move' | 'up' | 'cancel';
  /** pointerId */
  id: number;
  /** ms (event timeStamp) */
  t: number;
  /** CSS px */
  x: number;
  y: number;
}

export class TwoFingerTap {
  private fingers = new Map<number, { x: number; y: number }>();
  private t0 = 0;
  private downs = 0;
  private together = 0;
  private candidate = false;

  /** Feeds one touch event; true when it completes a two-finger tap. */
  feed(e: TouchSample): boolean {
    if (e.kind === 'down') {
      if (this.fingers.size === 0) {
        this.t0 = e.t;
        this.downs = 0;
        this.together = 0;
        this.candidate = true;
      }
      this.fingers.set(e.id, { x: e.x, y: e.y });
      this.downs++;
      this.together = Math.max(this.together, this.fingers.size);
      if (this.downs > 2 || e.t - this.t0 >= TAP_MAX_MS) this.candidate = false;
      return false;
    }
    const start = this.fingers.get(e.id);
    if (!start) return false; // a contact we never saw land (palm, pen time): not ours
    if (e.kind === 'cancel' || e.t - this.t0 >= TAP_MAX_MS || Math.hypot(e.x - start.x, e.y - start.y) >= TAP_MAX_DRIFT_PX) this.candidate = false;
    if (e.kind === 'move') return false;
    this.fingers.delete(e.id);
    if (this.fingers.size > 0) return false;
    const fired = this.candidate && this.downs === 2 && this.together === 2;
    this.candidate = false;
    return fired;
  }

  /** A pen or mouse contact: whatever the fingers are doing is not a tap. */
  spoil(): void {
    this.candidate = false;
  }
}
