#!/usr/bin/env node
// Transparent `cargo` launcher for the mise tasks that call cargo directly.
//
// Why this exists (task-80, 2026-11-08): `XH_CARGO_TARGET_ROOT` is only read by our own
// scripts (`stack-cargo-target.mjs` -> `stack-run.mjs` / `e2e-host.mjs`). Cargo itself
// knows nothing about it, so every `mise run <task>` that runs a bare `cargo …` kept
// writing `.tmp/cargo-target/main` through `.cargo/config.toml` — i.e. H: kept regrowing
// a multi-GB cache while the dev stacks were already on the new root. This wrapper is the
// missing link: it injects `CARGO_TARGET_DIR` for those tasks only.
//
// Usage: node scripts/cargo-run.mjs <cargo args…>
//
// Contract (deliberately boring — it must be indistinguishable from cargo):
//   1. `spawnSync('cargo', args, { stdio: 'inherit' })` — no capture, no rewrite of
//      cargo's stdout/stderr, no extra banner lines.
//   2. The child's exit code is propagated verbatim (`null` status => 1).
//   3. Nothing is injected unless `CARGO_TARGET_ROOT_ENV` is set: with the variable unset
//      this is byte-identical to the previous `cargo …` invocation (old contract, the
//      "未设变量时行为逐字节不变" regression guarantee of this card).
//   4. An already-set `CARGO_TARGET_DIR` always wins — `worktree-env.ps1`, a manual
//      override, or `stack-run.mjs` must never be silently rewritten.
//   5. The target directory comes from `cargoTargetForStack()` — the ONE derivation in
//      `scripts/lib/stack-cargo-target.mjs`; no second copy of the layout rules here.
//      The default stack key is `<root>/main` (or `<root>/<worktree-dir>/main` in a lane),
//      the same key the volume move created.
//   6. A set-but-unusable root (relative / missing) fails fast with exit 2 instead of
//      quietly building on H: — same judgement as `check-runtime-target.mjs`.
//
// Not covered on purpose: IDE / rust-analyzer / any bare `cargo` that does not go through
// here still resolves `.cargo/config.toml` (`target-dir = "../.tmp/cargo-target/main"`, H:).
// That residual gap is documented in DEV-002 §6 and A03 AGENTS.md; this wrapper narrows it,
// it does not remove it.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_STACK_ID } from './lib/stack-ports.mjs';
import { cargoTargetForStack } from './lib/stack-cargo-target.mjs';

// <A03> is the project root the layout rules are keyed on (`isLinkedWorktree` reads .git,
// the anchor walk-up looks for .cargo/config.toml), not the task's cwd (packages/runtime).
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('usage: node scripts/cargo-run.mjs <cargo args…>');
  process.exit(2);
}

const env = { ...process.env };
let target;
try {
  target = cargoTargetForStack({ stackId: DEFAULT_STACK_ID, projectRoot, env });
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(2);
}

// `target` is undefined when no root is configured (and CARGO_TARGET_DIR was unset):
// keep the ambient config target, exactly as before this wrapper existed.
const alreadySet = typeof env.CARGO_TARGET_DIR === 'string' && env.CARGO_TARGET_DIR.trim() !== '';
if (!alreadySet && typeof target === 'string' && target !== '') env.CARGO_TARGET_DIR = target;

const result = spawnSync('cargo', args, { stdio: 'inherit', env });
if (result.error) {
  console.error(`error: failed to spawn cargo: ${result.error.message}`);
  process.exit(result.error.code === 'ENOENT' ? 127 : 1);
}
// A signal-killed child has status === null; report non-success rather than pretending 0.
process.exit(typeof result.status === 'number' ? result.status : 1);
