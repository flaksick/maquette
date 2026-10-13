//! SIMD self-test (decision row "Core"): Safari 27.0 fixed a regression that corrupted v128
//! function arguments. The app runs this on the device and only uses the SIMD build if the
//! SIMD path is bit-identical to the scalar path. Results: 1 pass, 0 fail, -1 not compiled.

/// Scalar reference: x = y * w + x, then a second dependent pass x = x * w + y.
pub fn kernel_scalar(x: &mut [f32], y: &[f32], w: &[f32]) {
    for i in 0..x.len() {
        x[i] = y[i] * w[i] + x[i];
    }
    for i in 0..x.len() {
        x[i] = x[i] * w[i] + y[i];
    }
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod imp {
    use core::arch::wasm32::*;

    // Never inlined, several v128 arguments: exactly the calling pattern the WebKit bug broke.
    #[inline(never)]
    fn mul_add(a: v128, b: v128, c: v128) -> v128 {
        f32x4_add(f32x4_mul(a, b), c)
    }

    #[inline(never)]
    fn mul_add_chain(a: v128, b: v128, c: v128, d: v128, e: v128) -> v128 {
        // (a*b + c) then *d + e: same operation order as the scalar kernel's two passes.
        mul_add(mul_add(a, b, c), d, e)
    }

    pub fn kernel_simd(x: &mut [f32], y: &[f32], w: &[f32]) {
        let n4 = x.len() / 4 * 4;
        let mut i = 0;
        while i < n4 {
            unsafe {
                let vx = v128_load(x.as_ptr().add(i) as *const v128);
                let vy = v128_load(y.as_ptr().add(i) as *const v128);
                let vw = v128_load(w.as_ptr().add(i) as *const v128);
                let r = mul_add_chain(vy, vw, vx, vw, vy);
                v128_store(x.as_mut_ptr().add(i) as *mut v128, r);
            }
            i += 4;
        }
        for j in n4..x.len() {
            x[j] = y[j] * w[j] + x[j];
            x[j] = x[j] * w[j] + y[j];
        }
    }
}

pub fn compiled_with_simd() -> bool {
    cfg!(all(target_arch = "wasm32", target_feature = "simd128"))
}

pub fn selftest(n: usize) -> i32 {
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        let mut seed = 0x9e37_79b9u32;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            (seed as f32 / u32::MAX as f32) * 4.0 - 2.0
        };
        let y: Vec<f32> = (0..n).map(|_| rnd()).collect();
        let w: Vec<f32> = (0..n).map(|_| rnd()).collect();
        let x0: Vec<f32> = (0..n).map(|_| rnd()).collect();
        let mut a = x0.clone();
        let mut b = x0;
        kernel_scalar(&mut a, &y, &w);
        imp::kernel_simd(&mut b, &y, &w);
        let same = a.iter().zip(&b).all(|(p, q)| p.to_bits() == q.to_bits());
        return same as i32;
    }
    #[allow(unreachable_code)]
    {
        let _ = n;
        -1
    }
}
