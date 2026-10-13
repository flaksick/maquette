//! Maquette core: the sculpting engine. Everything here runs on the iPad (invariant 0).
//! The same code is tested natively (`cargo test`) and shipped as WebAssembly.

pub mod abi;
pub mod bvh;
pub mod kernels;
pub mod math;
pub mod simd;
pub mod sphere;
pub mod topo;
