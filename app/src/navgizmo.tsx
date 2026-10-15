// NAV-4: Blender's navigation gizmo, top right of the viewport. An axis orb (tap a ball: that
// axis view; drag: orbit) and three drag/tap tools below it: pan, zoom, perspective/ortho.
// The orb redraws only when the engine posts a changed camera (from a rendered frame), so an
// idle app stays at zero frames.
import { signal } from '@preact/signals';
import { useRef } from 'preact/hooks';
import { bus } from './bus';
import { basis, type AxisView, type V3 } from './engine/camera';
import type { FromEngine } from './shared/protocol';

type CameraMsg = Extract<FromEngine, { type: 'camera' }>;
export const camera = signal<CameraMsg | null>(null);

/** Blender's axes in our coordinates, as a default OBJ import shows them: Blender X = our X,
 *  Blender Y = our -Z, Blender Z = our +Y (up). Tapping a ball looks from that side. */
const AXES: { id: string; label?: string; dir: V3; color: string; view: AxisView; name: string }[] = [
  { id: '+x', label: 'X', dir: [1, 0, 0], color: '#ff3352', view: 'right', name: 'Right view (X)' },
  { id: '-x', dir: [-1, 0, 0], color: '#ff3352', view: 'left', name: 'Left view (-X)' },
  { id: '+y', label: 'Y', dir: [0, 0, -1], color: '#8bdc00', view: 'back', name: 'Back view (Y)' },
  { id: '-y', dir: [0, 0, 1], color: '#8bdc00', view: 'front', name: 'Front view (-Y)' },
  { id: '+z', label: 'Z', dir: [0, 1, 0], color: '#2890ff', view: 'top', name: 'Top view (Z)' },
  { id: '-z', dir: [0, -1, 0], color: '#2890ff', view: 'bottom', name: 'Bottom view (-Z)' },
];
const SIZE = 112;
const C = SIZE / 2;
const R = 34; // ball distance from the centre
const BALL = 10; // drawn radius; the touch target is a 40 px circle around it
const DRAG_PX = 4;
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The screen centre in canvas CSS pixels: orbit, pan and zoom from the gizmo pivot there. */
function viewCenter(): { x: number; y: number } {
  const r = document.getElementById('scene')?.getBoundingClientRect();
  return { x: (r?.width ?? 0) / 2, y: (r?.height ?? 0) / 2 };
}

/** Pointer drags on a gizmo control: `move` gets the delta since the last event. A press that
 *  never moves past DRAG_PX is a tap. */
function useDrag(onMove: (dx: number, dy: number) => void, onTap?: (target: Element) => void) {
  const st = useRef<{ id: number; x: number; y: number; moved: boolean; target: Element } | null>(null);
  return {
    onPointerDown: (e: PointerEvent) => {
      e.preventDefault();
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      st.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, target: e.target as Element };
      const c = viewCenter();
      bus.send({ type: 'gesture-begin', x: c.x, y: c.y });
    },
    onPointerMove: (e: PointerEvent) => {
      const s = st.current;
      if (!s || s.id !== e.pointerId) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (!s.moved && Math.hypot(dx, dy) < DRAG_PX) return;
      s.moved = true;
      s.x = e.clientX;
      s.y = e.clientY;
      onMove(dx, dy);
    },
    onPointerUp: (e: PointerEvent) => {
      const s = st.current;
      st.current = null;
      if (s && s.id === e.pointerId && !s.moved && e.type === 'pointerup') onTap?.(s.target);
    },
    onPointerCancel: () => (st.current = null),
  };
}

function Icon(props: { d: string; fill?: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path d={props.d} fill={props.fill ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
const HAND = 'M7 11h10v5a5 5 0 0 1-10 0zM8.5 11V5.5M11 11V4M13.5 11V4.5M16 11V6.5M7 14l-2.5-2.5';
const MAGNIFIER = 'M10.5 4a6.5 6.5 0 1 1 0 13a6.5 6.5 0 1 1 0-13zM15.3 15.3L20 20';
const GRID = 'M4 4h16v16H4zM4 9.3h16M4 14.7h16M9.3 4v16M14.7 4v16';
const PERSP = 'M8 5h8l4 14H4zM6 12h12M10.7 5L9.3 19M13.3 5l1.4 14';

export function NavGizmo() {
  const cam = camera.value;
  const b = basis(cam?.yaw ?? 0, cam?.pitch ?? 0);
  const balls = AXES.map((a) => ({ ...a, x: C + R * dot(a.dir, b.right), y: C - R * dot(a.dir, b.up), depth: dot(a.dir, b.forward) }))
    // Farthest first: a ball pointing toward the viewer is drawn (and tapped) on top.
    .sort((p, q) => q.depth - p.depth);
  const orb = useDrag(
    (dx, dy) => bus.send({ type: 'orbit', dx, dy }),
    (target) => {
      const view = target.closest('[data-view]')?.getAttribute('data-view') as AxisView | null;
      if (view) bus.send({ type: 'view-axis', view });
    },
  );
  const pan = useDrag((dx, dy) => bus.send({ type: 'pan', dx, dy }));
  const zoom = useDrag((_dx, dy) => {
    const c = viewCenter();
    bus.send({ type: 'zoom', factor: Math.exp(dy * 0.01), x: c.x, y: c.y }); // drag up = closer
  });
  const ortho = !!cam?.ortho;
  return (
    <div class="navgizmo">
      <svg class="navorb" width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="group" aria-label="View orientation: drag to orbit, tap an axis" data-feature="NAV-4" {...orb}>
        <circle cx={C} cy={C} r={C - 2} class="navorb-disc" />
        {balls
          .filter((a) => a.label)
          .map((a) => (
            <line key={`l${a.id}`} x1={C} y1={C} x2={a.x} y2={a.y} stroke={a.color} stroke-width="2.5" opacity={a.depth > 0.3 ? 0.55 : 1} />
          ))}
        {balls.map((a) => (
          <g key={a.id} role="button" aria-label={a.name} data-feature="NAV-4" data-axis={a.id} data-view={a.view} class="navball">
            <circle cx={a.x} cy={a.y} r={20} fill="transparent" />
            {a.label ? (
              <>
                <circle cx={a.x} cy={a.y} r={BALL} fill={a.color} />
                <text x={a.x} y={a.y + 4.5} text-anchor="middle" class="navball-label">
                  {a.label}
                </text>
              </>
            ) : (
              <circle cx={a.x} cy={a.y} r={BALL - 1.5} fill="rgba(30,30,34,0.85)" stroke={a.color} stroke-width="2.5" />
            )}
          </g>
        ))}
      </svg>
      <button data-feature="NAV-4" aria-label="Pan: drag to move the view" title="Drag to pan" {...pan}>
        <Icon d={HAND} />
      </button>
      <button data-feature="NAV-4" aria-label="Zoom: drag up or down" title="Drag to zoom" {...zoom}>
        <Icon d={MAGNIFIER} />
      </button>
      <button
        data-feature="NAV-4"
        class={ortho ? 'on' : ''}
        aria-pressed={ortho}
        aria-label={ortho ? 'Orthographic view: tap for perspective' : 'Perspective view: tap for orthographic'}
        title={ortho ? 'Orthographic' : 'Perspective'}
        onClick={() => bus.send({ type: 'projection', ortho: !ortho })}
      >
        <Icon d={ortho ? GRID : PERSP} />
      </button>
    </div>
  );
}
