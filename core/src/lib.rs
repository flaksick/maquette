//! Maquette core: the sculpting engine. Everything here runs on the iPad (invariant 0).
//! The same code is tested natively (`cargo test`) and shipped as WebAssembly.

pub mod abi;
pub mod brushes;
pub mod bvh;
pub mod engine;
pub mod gpu;
pub mod history;
pub mod io;
pub mod kernels;
pub mod mat4;
pub mod math;
pub mod objio;
pub mod mesh;
pub mod dyntopo;
pub mod remesh;
pub mod simd;
pub mod sphere;
pub mod store;
pub mod topo;
