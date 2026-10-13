//! Minimal f32 vector math. Kept explicit (no SIMD types) so native and WASM builds share
//! one code path and the same floating-point operation order.

#[inline(always)]
pub fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

#[inline(always)]
pub fn add(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

#[inline(always)]
pub fn scale(a: [f32; 3], s: f32) -> [f32; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}

#[inline(always)]
pub fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline(always)]
pub fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[inline(always)]
pub fn len_sq(a: [f32; 3]) -> f32 {
    dot(a, a)
}

#[inline(always)]
pub fn normalize(a: [f32; 3]) -> [f32; 3] {
    let l = len_sq(a).sqrt();
    if l > 1e-20 { scale(a, 1.0 / l) } else { [0.0, 0.0, 0.0] }
}

#[inline(always)]
pub fn get3(buf: &[f32], i: usize) -> [f32; 3] {
    [buf[3 * i], buf[3 * i + 1], buf[3 * i + 2]]
}

#[inline(always)]
pub fn set3(buf: &mut [f32], i: usize, v: [f32; 3]) {
    buf[3 * i] = v[0];
    buf[3 * i + 1] = v[1];
    buf[3 * i + 2] = v[2];
}

/// Blender's "Smooth" falloff preset with p = 1 - d/r: 3p^2 - 2p^3.
#[inline(always)]
pub fn falloff_smooth(p: f32) -> f32 {
    p * p * (3.0 - 2.0 * p)
}
