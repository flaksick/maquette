// Turntable camera with orbit around a surface pivot (NAV-1). State: eye position plus yaw and
// pitch; world up is +Y. Matrices are column-major (WebGL convention, same as core/src/mat4.rs).

export type V3 = [number, number, number];
export type M4 = Float32Array;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Rodrigues rotation of v around a unit axis. */
function rotate(v: V3, axis: V3, angle: number): V3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = cross(axis, v);
  const d = dot(axis, v) * (1 - c);
  return [v[0] * c + k[0] * s + axis[0] * d, v[1] * c + k[1] * s + axis[1] * d, v[2] * c + k[2] * s + axis[2] * d];
}

export function perspective(fovY: number, aspect: number, near: number, far: number): M4 {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

export function lookAt(eye: V3, target: V3, up: V3): M4 {
  const z = norm(sub(eye, target));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}

export function mul(a: M4, b: M4): M4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}

export function invert(m: M4): M4 {
  const a = Array.from(m);
  const inv = new Array(16).fill(0);
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  const det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  const out = new Float32Array(16);
  for (let i = 0; i < 16; i++) out[i] = inv[i] / det;
  return out;
}

const UP: V3 = [0, 1, 0];
const PITCH_LIMIT = 1.45;

export class Camera {
  eye: V3 = [0, 0, 3];
  yaw = 0;
  pitch = 0;
  fov = (45 * Math.PI) / 180;
  width = 1;
  height = 1;
  /** Scene scale (bounding radius): sets near/far and pan speed. */
  radius = 1;
  center: V3 = [0, 0, 0];

  forward(): V3 {
    return [-Math.sin(this.yaw) * Math.cos(this.pitch), -Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch)];
  }

  right(): V3 {
    return norm(cross(this.forward(), UP));
  }

  up(): V3 {
    return cross(this.right(), this.forward());
  }

  view(): M4 {
    return lookAt(this.eye, add(this.eye, this.forward()), UP);
  }

  proj(): M4 {
    const dist = Math.max(len(sub(this.eye, this.center)), this.radius * 0.01);
    const near = Math.max(dist - this.radius * 4, this.radius * 0.002);
    const far = dist + this.radius * 4;
    return perspective(this.fov, this.width / this.height, near, far);
  }

  viewProj(): M4 {
    return mul(this.proj(), this.view());
  }

  /** World units per device pixel at unit depth. */
  pxToWorld(): number {
    return (2 * Math.tan(this.fov / 2)) / this.height;
  }

  /** The 26 floats the Rust engine expects (core/src/engine.rs `Camera`). */
  pack(out: Float32Array): void {
    out.set(invert(this.viewProj()), 0);
    out.set(this.eye, 16);
    out.set(this.forward(), 19);
    out[22] = this.width;
    out[23] = this.height;
    out[24] = this.pxToWorld();
    out[25] = 0;
  }

  /** Turntable orbit around `pivot`: yaw about world Y, pitch about the camera's right axis. */
  orbit(dyaw: number, dpitch: number, pivot: V3): void {
    let rel = sub(this.eye, pivot);
    rel = rotate(rel, UP, dyaw);
    this.yaw += dyaw;
    const newPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + dpitch));
    const dp = newPitch - this.pitch;
    rel = rotate(rel, this.right(), -dp);
    this.pitch = newPitch;
    this.eye = add(pivot, rel);
  }

  pan(dxPx: number, dyPx: number, depth: number): void {
    const k = depth * this.pxToWorld();
    this.eye = add(this.eye, add(scale(this.right(), -dxPx * k), scale(this.up(), dyPx * k)));
  }

  /** Dolly toward `at` by `factor` (< 1 zooms in), keeping `at` fixed on screen. */
  zoom(factor: number, at: V3): void {
    const minDist = this.radius * 0.02;
    const next = add(at, scale(sub(this.eye, at), factor));
    if (len(sub(next, at)) < minDist) return;
    this.eye = next;
  }

  /** Point on the plane through the scene center facing the camera, under a screen point. */
  planePoint(x: number, y: number): V3 {
    const inv = invert(this.viewProj());
    const nx = (2 * x) / this.width - 1;
    const ny = 1 - (2 * y) / this.height;
    const un = (z: number): V3 => {
      const v = [0, 0, 0, 0];
      for (let r = 0; r < 4; r++) v[r] = inv[r] * nx + inv[4 + r] * ny + inv[8 + r] * z + inv[12 + r];
      return [v[0] / v[3], v[1] / v[3], v[2] / v[3]];
    };
    const o = un(-1);
    const d = norm(sub(un(1), o));
    const f = this.forward();
    const t = dot(sub(this.center, o), f) / (dot(d, f) || 1e-9);
    return add(o, scale(d, t));
  }

  depthOf(p: V3): number {
    return Math.max(dot(sub(p, this.eye), this.forward()), this.radius * 0.01);
  }

  /** Frame the bounding sphere, keeping the current orientation (NAV-4). */
  frame(center: V3, radius: number): void {
    this.center = center;
    this.radius = radius;
    const dist = (radius / Math.sin(this.fov / 2)) * 1.15;
    this.eye = sub(center, scale(this.forward(), dist));
  }

  reset(center: V3, radius: number): void {
    this.yaw = 0;
    this.pitch = 0;
    this.frame(center, radius);
  }
}
