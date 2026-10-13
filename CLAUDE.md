# Maquette

Offline digital sculpting for iPad, built as a web app and installed through Safari's Add to Home
Screen. Everything runs on the device; GitHub Pages only serves the static files.
**This repository is public: never commit personal data, credentials, or code under GPL.**

## Read first
- `SPEC.md`: the 134 features, tiers, phases and acceptance (generated from `spec.yaml`).
- `ARCHITECTURE.md`: invariants and design.
- `DECISIONS.md`: dated decisions, each with the measured number behind it, plus what the
  device run still decides.

## Status
**Phase P0 (probe).** The probe measures the nine riskiest assumptions on the reference iPad
(memory ceiling, durable saves, engine speed, threads, GPU, Pencil/gestures, files, install). It
runs end to end in WebKit on the Mac (`tests/s9-probe-webkit.spec.ts`). Next: device run, then
P1a "First clay" (installable, never loses work, first brushes).

## Layout
```
core/            Rust engine (WASM + native tests). abi.rs = exports, kernels.rs = brush kernels
probe/           P0 probe page: one module per spike (s1..s8), workers, service worker
scripts/         build-core.sh, gen-spec.mjs, gen-icons.mjs, serve.mjs, verify.mjs, deploy.mjs, hooks/
tests/           Playwright WebKit e2e
spec.yaml        feature registry (source of truth) → SPEC.md
```

## Run
- Toolchain: `source scripts/toolchain.sh` (Homebrew rustup is keg-only), Node 22.
- Engine tests: `cd core && cargo test` · native benchmark: `cargo test --release -- --ignored --nocapture bench_native`
- Probe: `npm run probe:build` → `dist/probe`; local dev with isolation headers: `npm run probe:dev`
- WebKit e2e: build, copy to `deploy/dev/probe`, `npx playwright test` (serves like GitHub Pages)
- Everything: `npm run verify` (numbered conditions, measured values, PASS/FAIL)
- Deploy the dev channel: `npm run deploy:dev` → https://flaksick.github.io/maquette/dev/probe/

## Conventions
- Every acceptance criterion is a script that prints a number; any fix re-runs every condition.
- WebKit's ephemeral contexts reject OPFS: tests use persistent profiles.
- Commits use the GitHub no-reply email (repo-local config). Hooks live in `scripts/hooks`
  (`git config core.hooksPath scripts/hooks`).
