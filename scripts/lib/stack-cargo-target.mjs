import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { DEFAULT_STACK_ID } from './stack-ports.mjs';

// PLAN-0656 R1: per-stack cargo target directory.
//
// Root cause (BL-221 / stack2-boot.log): `.cargo/config.toml` pins ONE project-level
// `target-dir`, so `stack-2`'s `cargo run --bin xihe-runtime` recompiles into the very
// directory `stack-1` is executing from — Windows then fails the overwrite with
// `os error 5`, or (worse) the build silently replaces a running binary.
// `CARGO_TARGET_DIR` outranks `config.toml`, so handing every non-default stack its own
// directory fixes the collision without touching the config (bare `cargo` and
// rust-analyzer keep the shared default exactly as before).

/**
 * Base directory for per-stack targets: the same anchor `.cargo/config.toml` uses.
 * The config resolves its relative `target-dir` against "the parent of the directory
 * that contains `.cargo/`" (see that file's header), so we walk up to the nearest
 * `.cargo/config.toml` and mirror its anchor: `<anchorParent>/.tmp/cargo-target`.
 * Sparse checkouts without their own `.cargo` therefore land on the same base as the
 * main checkout, never inside a worktree's missing subtree.
 */
export function cargoTargetBase(projectRoot, exists = existsSync) {
  let dir = resolve(projectRoot);
  for (;;) {
    if (exists(join(dir, '.cargo', 'config.toml'))) {
      return resolve(dirname(dir), '.tmp', 'cargo-target');
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(dirname(resolve(projectRoot)), '.tmp', 'cargo-target');
}

/**
 * The cargo target directory a stack's processes must use, or `undefined` when the
 * stack should keep whatever the ambient config resolves (the default stack, so its
 * warm cache stays byte-identical to pre-0656 behavior).
 *
 * Precedence: an existing `CARGO_TARGET_DIR` in `env` always wins (worktree-env.ps1
 * and manual overrides must not be silently rewritten).
 */
export function cargoTargetForStack({ stackId, projectRoot, env = {}, exists = existsSync } = {}) {
  if (stackId === undefined || stackId === DEFAULT_STACK_ID) return undefined;
  const existing = typeof env.CARGO_TARGET_DIR === 'string' ? env.CARGO_TARGET_DIR.trim() : '';
  if (existing !== '') return existing;
  return join(cargoTargetBase(projectRoot, exists), stackId);
}
