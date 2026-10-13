# Decisions

Dated records. Each cites the measured number that drove it (`N @ source`). When a later
measurement disagrees, a new record supersedes the old one; old records are never edited.

## Pending: decided by the device run (P0 probe on the iPad Air 4)

| Spike | Question | Decided by |
|---|---|---|
| S1 | Memory budget for the 4 GB class; restart-in-session vs "swipe-close and reopen" (PLT-7) | `s1.summary` + re-instantiation in the device report |
| S2 | One persist worker or two | `s2.latencySingleWorker` vs `s2.latencyTwoWorkers` p99 |
| S3 | Rust confirmed (composite score ≥ 1.0)? Ship the scalar build? | `s3.compositeScore`, `s3.selftest` |
| S4 | Threads on or off | `s4.bestSpeedup` ≥ 1.5 and `s4ReloadLoop` stable 20/20 |
| S5 | GPU page size; comfortable polycount; WebGPU no/yes | `s5.tris*.perPage.fps`, `s5.upload` |
| S6 | Input layer; is three-finger redo usable? | `s6.threeFingerRedoUsable`, `s6.gestureLeaks` |
| S7 | Export path (share vs download) and picker `accept` | `s7.exports`, `s7.imports` |
| S8 | Offline cold launch works; Home Screen/Safari isolation; icon-delete wording | `s8.launches`, `s8.*SeesOtherContext`, `s8.dummyMarkerSurvivedIconDelete` |

## 2026-10-13 · Raw C ABI instead of wasm-bindgen
The engine boundary is pointers into linear memory plus counts (mesh arrays are read in place
by the renderer), so a binding generator adds a build step and glue without removing any work.
Exports are `mq_*` functions in `core/src/abi.rs`; typed views live in `probe/src/core.ts`.

## 2026-10-13 · Native and WASM builds are bit-identical
Reference workload (2M-tri cube-sphere, 200 composite steps) checksum `-1067.8115111484658`
in native ARM64, WASM SIMD and WASM scalar @ `cargo test` + Node 22. SIMD self-test passes in
V8 and in WebKit 27.2 (Mac) @ `test-results/s9-webkit.json`.

## 2026-10-13 · Hot loops use unchecked indexing
Native composite step 0.435 → 0.302 ms @ `cargo test --release bench_native` after replacing
checked indexing in the hot loops (results bit-identical, pinned by `reference_checksum_is_stable`).
WebKit WASM 0.832 → 0.716 ms/step @ s9-webkit.json. Indices come from validated topology.

## 2026-10-13 · S3 measures two workloads, not one
Streaming float kernels are where JavaScriptCore comes closest to WASM, so S3 also times the
structural rebuild (adjacency + BVH) in both languages. Mac WebKit 27.2: kernel TS/Rust 0.96,
rebuild 1.50, composite (geometric mean) 1.20 @ s9-webkit.json → Rust provisionally confirmed;
the device run decides. Dyntopo is not yet in either language; it joins the re-check at P3.

## 2026-10-13 · OPFS fails in ephemeral WebKit contexts
`navigator.storage.getDirectory()` throws `UnknownError` in Playwright's ephemeral WebKit
context and works in a persistent profile @ scratchpad check 2026-10-13. Private browsing
behaves the same way. Consequences: tests use persistent profiles; the probe falls back to
memory-only with a visible warning; new feature PLT-13 (the app must say so and never pretend
to save).

## 2026-10-13 · Save-latency test uses a realistic load
The first version wrote checkpoints continuously (12,409 × 4 MB in 20 s @ s9-webkit.json) and saw
483–583 ms flush stalls — a flash-wearing stress artifact, not a save pattern. It now writes three
64 MB checkpoints in 15 s with a 256 KB record every 200 ms, for one-worker and two-worker designs.
Mac WebKit: journal latency p99 8.4 ms (one worker) and 6.9 ms (two workers) @ s9-webkit.json.

## 2026-10-13 · Memory lab runs: 2 per mode per condition
The plan called for 10 runs per condition. Each run ends in a crash-and-reopen, so 10 × 4 modes ×
2 conditions = 80 crashes would take far beyond the ~30 minutes of device time P0 asks for. P0 runs
2 per mode per condition (16 runs); the shipped budget uses 0.6 × the minimum observed, and the
adaptive learning in PLT-8 corrects it from real sessions.

## 2026-10-13 · Service-worker isolation works in WebKit (Mac)
Served without COOP/COEP headers (like GitHub Pages), the probe's own service worker made the page
`crossOriginIsolated = true`; shared memories with 16384/32768/65536 max pages all created; 8 workers
ran the WASM kernel 3.95–4.56× faster than one @ s9-webkit.json. Whether the same holds in the
installed Home Screen app on iPadOS is S4's device question.

## 2026-10-13 · Icons are generated, not committed
`scripts/gen-icons.mjs` renders the PNG icons at build time (no image libraries), so the public
repo carries no binary assets.
