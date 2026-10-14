# Decisions

Dated records. Each cites the measured number that drove it (`N @ source`). When a later
measurement disagrees, a new record supersedes the old one; old records are never edited.

## 2026-10-13 · P0 device run: decisions
Source for every number below: `reports/2026-10-13-air4-safari26.6.json` (iPad Air 4, 820×1180 @2x,
Safari 26.6, `hardwareConcurrency` 4). All tests ran in a Safari tab (every launch has
`standalone: false`), not the installed Home Screen app.

| Spike | Measured | Decision |
|---|---|---|
| S1 memory | Killed at 2,496 (wasm-grow), 2,496 (typed arrays), 2,560 MB (reserve); last OK 2,432 / 2,432 / 2,496 MB; idle; 3 of 8 planned runs | **4 GB-class budget prior = 0.6 × 2,432 = 1,459 MB** for the whole app (WASM + tracked buffers). GPU and "loaded" runs not measured: the prior's 0.4 margin plus PLT-8 learning cover them |
| S2 saves | 3/3 balloon-kill runs pass: acked 200 → 201 intact, 240 → 240, 240 → 240; `persist()` false in a tab; quota 34.8 GB | Journal design (flush, then ack; CRC-checked records) confirmed on device. One persist worker to start (Mac p99 8.4 vs 6.9 ms for two); device latency measured by PRJ-3's own trace in P1a |
| S3 engine | Kernel TS/Rust 0.93, rebuild 1.61, composite **1.22**; Rust kernel 1.01 ms/step at 2M tris; setup 437 ms; SIMD self-test 1/1; SIMD = scalar bit-identical | **Rust confirmed. Ship the SIMD build only**; keep the self-test as a boot check |
| S4 threads | `crossOriginIsolated` via our service worker; shared memory up to 65,536 pages OK 20/20 reloads; speedup 1.61 / 2.24 / 2.88 / 2.62× at 2 / 4 / 6 / 8 workers; ping 6 µs | Threads are viable (≥ 1.5×, stable). **Adoption deferred** until a feature needs them (dyntopo/remesh, P2–P3) and they're confirmed in the Home Screen app. Pool size comes from the measured curve (6), never `hardwareConcurrency` (reports 4) |
| S5 GPU | Paged multi-draw at 57.5 / 58.3 / 58.4 / 57.5 fps for 1 / 2 / 4 / 8M tris (5 pages, 168 MB at 8M); multi-draw ≈ per-page draw; worker rAF and OffscreenCanvas WebGL2 present | **GPU is not the limit on the Air 4** (60 fps cap). 16 MB pages kept. WebGL2 stays; WebGPU not needed. Comfortable polycount is set by memory and engine time |
| S7 files | Share-sheet export of an OBJ worked; re-import through a picker with **no `accept` filter** was byte-identical | Import uses no `accept` filter (plan). 200 MB export moves to EXP-7's P1a gate |
| S8 install | Dummy app: marker did **not** survive deleting the Home Screen icon | Deleting the icon deletes the app's data: PRJ-6 says so in plain words. Offline cold launch and Home Screen isolation move to P1a's exit gate (they need the installed app) |

Not measured on device, now part of P1a's gates instead: S2 save latency (PRJ-3 device trace),
S5 uploads and resume-after-background (PLT-5), S6 Pencil and gestures (NAV-2/NAV-3: redo stays a
button until the system three-finger bar is checked), S8 standalone/offline (PLT-1/PLT-2).
Probe bug noted: the wasm-reserve marker lost `reservedMB` once growth began (it didn't affect the
kill point).

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

## 2026-10-14 · Playwright WebKit shares OPFS across persistent profiles
WebKit (Playwright, Mac) keeps OPFS per origin under `~/Library/WebKit/org.webkit.Playwright/
WebsiteData`, not in the profile directory: every persistent profile on one port sees the same
`app-dev/` files @ a fresh-profile run that opened with the previous test's budget.json (256 MB,
stress-test basis). Consequences: e2e tests that depend on stored state delete it first
(tests/budgets.spec.ts `FRESH`); parallel streams stay isolated only because each uses its own port.

## 2026-10-14 · PLT-8 budgets: policy constants
Unclean exit at >= 85% of the budget cuts it 10%; three clean sessions above 90% raise it 5%, never
above the class ceiling (2,432 MB, the Air 4's last good allocation); floor 256 MB; a stress test
sets budget = 0.6 x what the iPad held (the lab formula), and a run that only reached its cap can
raise but never lower it. Comfortable polycount = largest mesh whose brush frame (4 coalesced
samples + frame update) stays <= 8 ms p95. Mac WebKit: 5 ms p95 at 2.0M tris -> 3.2M comfortable
@ test-results/plt8-budgets.json; without cross-origin isolation Safari's timer has 1 ms steps, so
p95 rounds up (conservative). The device run sets the real number.

