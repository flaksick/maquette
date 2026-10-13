# Maquette architecture

An offline sculpting web app for iPad, installed from Safari with Add to Home Screen.
Reference device: iPad Air 4 (A14, 4 GB RAM, 60 Hz, Apple Pencil 2). Feature list: `SPEC.md`.
Measured decisions: `DECISIONS.md`.

## Invariants

0. **Everything runs on the iPad.** No server computes, renders, stores or sees user data. The
   network only delivers the app's own files (install and update checks, which can be turned off).
   No telemetry, analytics, accounts or external requests; the bundle audit enforces it.
1. **Input never waits for compute.** The UI thread only captures and forwards input. Pencil
   samples are never dropped; if queued dab work exceeds 150 ms, the queue is respaced along the
   same path and the HUD says "brush heavy".
2. **One writer per mesh.** The engine worker is the only mutator. Helpers work on copies.
3. **Every mutation is a node transaction.** It declares the BVH nodes it touches. The first touch
   copies the node's before-state: the undo record and the stroke's original-coordinate cache. At
   stroke end the same nodes' after-state is the journal record. The touched set also drives
   normals, bounds refit and GPU upload. Allocator and BVH changes are part of the transaction;
   slots never move during a stroke.
4. **Durable within one stroke, with no help from the OS.** Each stroke's after-state (and every
   undo/redo) is compressed, checksummed and flushed to the OPFS journal: p99 ≤ 100 ms after stroke
   end. Journal writes jump ahead of checkpoint writes; checkpoints are incremental (dirty nodes
   only, ≤ 4 MB chunks).
5. **Threads accelerate, never required.** Single-threaded by default; threads (and the COOP/COEP
   service-worker injection they need) only if the device spike shows them stable and ≥ 1.5× faster.
6. **Limits are budgets against peak.** A process-wide ledger counts WASM pages, tracked
   ArrayBuffers and GPU bytes. Every operation declares its transient; it runs only if steady +
   transient fits, otherwise it's refused up front with the numbers shown.
7. **No fake UI.** Controls render from the feature registry; prod strips anything unverified;
   a script asserts that interactive elements without a feature ID = 0.
8. **A bad deploy can't brick the app.** Immutable version folders, SHA-verified switch, boot-health
   revert after two failed boots. `sw.js` keeps one URL forever.
9. **One core instance per session.** WASM memory never shrinks, so mesh memory lives in reusable
   1–4 MB pages; projects switch by resetting the heap, not by reloading.
10. **Idle is free.** Frames render only when something changed.
11. **Nothing secret reaches the public repo.** Allow-list `.gitignore`, gitleaks in pre-commit and
   pre-push (source, history, built files), GitHub push protection, no-reply commit email.

## Processes

```
 Main thread                Engine worker (owns the mesh)              Persist worker(s)      Helper worker
 Preact UI ─ input ─▶      Rust/WASM core: pools, BVH, stroke,     ─▶ OPFS sync handles,     meshoptimizer,
 Pencil/touch capture       brushes, undo, dyntopo, multires, SDF      LZ4, A/B manifest,     manifold-3d
 (never touches mesh) ◀─    remesh; heavy ops in ≤ 8 ms slices;        journal first          (on copies,
                state       WebGL2 on OffscreenCanvas                                         budgeted)
 Service worker: immutable versions, SHA-verified switch, boot-health revert, offline.
```

## Engine

- **Mesh.** Triangles with an opposite-corner table; "same polygon as next triangle" bits keep
  quads and n-gons for subdivision and export. Validator: edge-manifold, consistently oriented,
  holes allowed. Vertex/triangle pools are allocated in 1–4 MB pages aligned to BVH leaves.
- **BVH.** Median split on the dominant centroid axis, preorder nodes (refit is one reverse sweep),
  every vertex owned by exactly one leaf (`core/src/bvh.rs`).
- **Brush = deform primitive × factor pipeline × stroke method.** Factor order: mask → hidden →
  region → front-face → distance → hardness → falloff → automask → alpha. Named brushes are presets.
- **Voxel remesh.** Sparse 8³ bricks within ±2 voxels of the surface; triangles rasterized into the
  band; sign by flood fill from outside (winding numbers for holed input); `fast-surface-nets`,
  manifold repair, relax, reproject.
- **Multires.** Catmull-Clark; levels ≥ 1 as per-base-face displacement grids in tangent space.

## GPU

WebGL2 in the engine worker (OffscreenCanvas, worker rAF). Each object is split into GPU pages
(≤ 16 MB; set by spike S5) with local vertex copies for cross-page triangles, attributes
interleaved in a 4-byte-aligned stride, and one `multiDrawElementsWEBGL` per page over visible leaf
ranges. Context loss or a blank canvas after resume rebuilds the mirror from the pools.

## Storage

OPFS through sync access handles only (never `createWritable`). One module owns
`navigator.storage.getDirectory()` and hands out `root/<channel>`. Journal records carry a magic,
sequence number, length and CRC32 (`probe/src/journal.ts` is the prototype).

## Device budgets

Safari hides the iPad model and RAM, so limits are measured: a lab-measured class prior
(0.6 × the minimum observed ceiling), a non-crashing speed benchmark, and adaptive learning from
the memory ledger's high-water marks across sessions. Every limit is shown with its source.

## Blender as reference

Blender's source is read for algorithms and constants only; nothing is transliterated, so the app
carries no GPL obligations. Permissive dependencies are listed in `THIRD_PARTY_NOTICES.md`.
