#!/bin/sh
# Builds the Rust core to WebAssembly in two variants (SIMD128 and scalar), optimizes both
# with wasm-opt, and assembles the hand-written threads test module (probe spike S4).
set -e
cd "$(dirname "$0")/.."
. scripts/toolchain.sh
mkdir -p wasm

build() {
  variant="$1"; flags="$2"
  RUSTFLAGS="$flags" cargo build --manifest-path core/Cargo.toml --release \
    --target wasm32-unknown-unknown --target-dir "core/target/$variant" -q
  wasm-opt -O3 "core/target/$variant/wasm32-unknown-unknown/release/maquette_core.wasm" \
    -o "wasm/core.$variant.wasm"
}

build simd "-C target-feature=+simd128"
build scalar ""
wasm-as --enable-threads --enable-bulk-memory probe/wasm/threads.wat -o wasm/threads.wasm

for f in wasm/*.wasm; do
  printf '%s %s bytes\n' "$f" "$(wc -c < "$f" | tr -d ' ')"
done
