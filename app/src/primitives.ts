// New-project shapes: the quad sphere (PRM-1) and the other primitives (PRM-2). The counts mirror
// core/src/primitives.rs `counts` exactly (the New sheet shows them while the slider moves, the
// engine worker's pre-flight uses them); tests/primitives.spec.ts checks them against the engine.

export type PrimitiveKind = 'cube' | 'cylinder' | 'cone' | 'torus' | 'plane' | 'capsule' | 'icosphere';
export type ShapeKind = 'sphere' | PrimitiveKind;

/** core/src/primitives.rs `Primitive` codes. */
export const PRIMITIVE_ID: Record<PrimitiveKind, number> = { cube: 1, cylinder: 2, cone: 3, torus: 4, plane: 5, capsule: 6, icosphere: 7 };

export interface ShapeDef {
  label: string;
  feature: 'PRM-1' | 'PRM-2';
  param: string;
  min: number;
  max: number;
  step: number;
  def: number;
  blurb: string;
}

export const SHAPES: Record<ShapeKind, ShapeDef> = {
  sphere: { label: 'Sphere', feature: 'PRM-1', param: 'Resolution', min: 8, max: 512, step: 8, def: 96, blurb: 'An all-quad sphere.' },
  cube: { label: 'Cube', feature: 'PRM-2', param: 'Divisions', min: 1, max: 512, step: 1, def: 64, blurb: 'An all-quad cube.' },
  cylinder: { label: 'Cylinder', feature: 'PRM-2', param: 'Segments', min: 6, max: 2048, step: 2, def: 256, blurb: 'Quads, with a triangle fan at each cap centre.' },
  cone: { label: 'Cone', feature: 'PRM-2', param: 'Segments', min: 6, max: 2048, step: 2, def: 256, blurb: 'Quads, with triangle fans at the tip and the base centre.' },
  torus: { label: 'Torus', feature: 'PRM-2', param: 'Segments', min: 6, max: 2048, step: 3, def: 255, blurb: 'An all-quad ring.' },
  plane: { label: 'Plane', feature: 'PRM-2', param: 'Divisions', min: 1, max: 1024, step: 1, def: 128, blurb: 'An all-quad plane, open at its border.' },
  capsule: { label: 'Capsule', feature: 'PRM-2', param: 'Segments', min: 6, max: 2048, step: 2, def: 256, blurb: 'Quads, with a triangle fan at each pole.' },
  icosphere: { label: 'Icosphere', feature: 'PRM-2', param: 'Level', min: 0, max: 8, step: 1, def: 5, blurb: 'Even triangles all over.' },
};

export const SHAPE_ORDER: ShapeKind[] = ['sphere', 'cube', 'cylinder', 'cone', 'torus', 'plane', 'capsule', 'icosphere'];

export interface ShapeCounts {
  verts: number;
  quads: number;
  triFaces: number;
  tris: number;
}

const TAU = 2 * Math.PI;
const round = (x: number) => Math.max(0, Math.round(x));

/** Lathe rings (not poles) of cylinder, cone and capsule. */
function rings(kind: 'cylinder' | 'cone' | 'capsule', n: number): number {
  if (kind === 'cylinder') return 2 * Math.max(1, round(n / TAU)) + Math.max(1, round(n / Math.PI)) - 1;
  if (kind === 'cone') return Math.max(1, round(n / TAU)) + Math.max(1, round((Math.sqrt(5) * n) / TAU)) - 1;
  return 2 * Math.max(2, round(n / 4)) + Math.max(1, round(n / Math.PI)) - 1;
}

export function shapeCounts(kind: ShapeKind, n: number): ShapeCounts {
  switch (kind) {
    case 'sphere':
    case 'cube':
      return { verts: 6 * n * n + 2, quads: 6 * n * n, triFaces: 0, tris: 12 * n * n };
    case 'plane':
      return { verts: (n + 1) * (n + 1), quads: n * n, triFaces: 0, tris: 2 * n * n };
    case 'torus': {
      const m = Math.max(3, round(n / 3));
      return { verts: n * m, quads: n * m, triFaces: 0, tris: 2 * n * m };
    }
    case 'icosphere': {
      const f = 20 * 4 ** n;
      return { verts: f / 2 + 2, quads: 0, triFaces: f, tris: f };
    }
    default: {
      const k = rings(kind, n);
      return { verts: k * n + 2, quads: (k - 1) * n, triFaces: 2 * n, tris: 2 * k * n };
    }
  }
}
