# Maquette

Offline digital sculpting for iPad, built as a web app and installed through Safari's Add to Home
Screen. Everything runs on the device; GitHub Pages only serves the static files.
**This repository is public: never commit personal data, credentials, or code under GPL.**

## Read first
- `SPEC.md`: the 134 features, tiers, phases and acceptance (generated from `spec.yaml`).
- `ARCHITECTURE.md`: invariants and design.
- `DECISIONS.md`: dated decisions, each with the measured number behind it, plus what the
  device run still decides.
- How this app is built (plan, device probe, parallel agent streams, gated releases): the
  workspace system `systems/app-build/SYSTEM.md`, outside this repo.

## Status
**P0 done 2026-10-13** (device report `reports/2026-10-13-air4-safari26.6.json`; decisions in
DECISIONS.md): 4 GB-class budget prior 1,459 MB; Rust + SIMD confirmed (composite 1.22); GPU draws
8M tris at 57 fps; threads viable but deferred.
**Shipped to prod 2026-10-15** (app 131380e1c4dd; `npm run verify` 31 pass, 0 fail): P1a and P1b
complete (projects gallery + backups, OBJ/STL import + STL export, units, per-iPad budgets,
versioned safe updates), plus from P2/P3: 14 brushes + falloff/hardness/XYZ symmetry, Invert and
hold buttons, stabilizer, voxel remesh, dyntopo, primitives, Smooth/Flat/Wire shading, navigation
orb with ortho. Feature status is computed: `npm run status`.
**Next:** mask brush (MSK-1), dyntopo for Grab/Snake Hook and saved detail settings, parametric
primitives, custom falloff curve, and the device timings still marked device-pending.
**Open, not a feature:** the parallel build left 6 branches and their worktrees behind —
`feat/{app,brushes,dyntopo,io,platform,remesh}`, all 6 merged @ `git branch --merged main`, their
worktrees under a dead session's scratchpad and all `prunable` @ `git worktree list`. Nothing is
unmerged, so this is safe: `git worktree prune`, then delete the six branches.

## Layout
```
core/            Rust engine (WASM + native tests). abi.rs = exports, kernels.rs = brush kernels
probe/           P0 probe page: one module per spike (s1..s8), workers, service worker
scripts/         build-core.sh, gen-spec.mjs, gen-icons.mjs, serve.mjs, verify.mjs, deploy.mjs, hooks/
tests/           Playwright WebKit e2e
reports/         device reports from the probe/app diagnostics (measurements only)
spec.yaml        feature registry (source of truth) → SPEC.md
```

## Run
- Toolchain: `source scripts/toolchain.sh` (Homebrew rustup is keg-only), Node 22.
- Engine tests: `cd core && cargo test -- --test-threads=1` (124 pass, 0 fail, 3 ignored, 39.7 s
  @ re-run 2026-10-23). **Serial is required, not
  tidiness:** the budget tests measure wall clock, so a parallel run under another build's CPU load
  fails them falsely — dyntopo measured 8.17 ms against its 8 ms limit in parallel and passed alone.
  `verify.mjs` and `feature-status.mjs` already pass the flag; a hand-run `cargo test` is the one
  that lies. Native benchmark: `cargo test --release -- --ignored --nocapture bench_native`
- Probe: `npm run probe:build` → `dist/probe`; local dev with isolation headers: `npm run probe:dev`
- WebKit e2e: build, copy to `deploy/dev/probe`, `npx playwright test` (serves like GitHub Pages)
- Everything: `npm run verify` (numbered conditions, measured values, PASS/FAIL): builds, Rust, types,
  registry, bundle audit, secrets, every WebKit e2e, the Blender oracle on the e2e's OBJ export, the
  no-fake-UI check and the feature-status table. Parallel runs set `MAQUETTE_PORT` and `MAQUETTE_NO_KILL=1`.
- Feature status: `npm run status` (computed from ID-tagged tests + device reports <= 14 days old)
- No fake UI (invariant 7): `npm run check-ui` (every control has a feature ID of the current phase or earlier).
  A feature's `phase` in `spec.yaml` is its real phase and is **never** edited to make a control pass the
  check — only a PASS, or device-pending with its tests passing, lets UI ship. PRM-2 was moved to P1b to
  clear the check and had to be set back to P2.
- Deploy the dev channel: `npm run deploy:dev` → https://flaksick.github.io/maquette/dev/probe/

## Conventions
- Every acceptance criterion is a script that prints a number; any fix re-runs every condition.
- Tests that verify a feature carry its ID: Rust names start with lowercase IDs (`prj4_random_kill_...`,
  `brs1_sym1_und1_draw_...`), Playwright titles with IDs (`PLT-3: ...`); conditional parts add a
  `{ type: 'feature', description: 'PRJ-4' }` annotation. Status is never written by hand.
- Every control renders with `data-feature="<ID>"` (or `data-ui="chrome"` for close buttons and the
  like); every sheet is listed in `SHEETS` (app/src/state.ts) so the UI check opens it.
- WebKit's ephemeral contexts reject OPFS: tests use persistent profiles.
- Commits use the GitHub no-reply email (repo-local config). Hooks live in `scripts/hooks`
  (`git config core.hooksPath scripts/hooks`).
