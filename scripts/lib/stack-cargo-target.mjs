import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

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
//
// task-80 (2026-11-08): the base directory is now configurable via
// `XH_CARGO_TARGET_ROOT` so the whole per-stack family (main / stack-N / e2e) can live
// on another volume — H: ran out of room, G: replaced nothing else. Two hard rules:
//   1. When the variable is unset the derivation below is byte-identical to pre-080
//      behavior (`<anchorParent>/.tmp/cargo-target`); the default stack still returns
//      `undefined` and keeps the ambient config target.
//   2. A variable that is set but unusable (relative, or missing on this machine)
//      THROWS. Never fall back to the H: path: a silent fallback reproduces exactly the
//      failure mode this card exists to kill — a check that points at a directory the
//      operator is not actually building into, then reports green.
export const CARGO_TARGET_ROOT_ENV = 'XH_CARGO_TARGET_ROOT';

/**
 * Resolve the configured root, or `null` when the variable is unset/blank.
 * Throws on a set-but-unusable value (see rule 2 above) — callers must not catch this
 * to "fall back"; that would hide the misconfiguration.
 */
export function cargoTargetRoot({ env = {}, exists = existsSync } = {}) {
  const raw = typeof env[CARGO_TARGET_ROOT_ENV] === 'string' ? env[CARGO_TARGET_ROOT_ENV].trim() : '';
  if (raw === '') return null;
  if (!isAbsolute(raw)) {
    throw new Error(
      `${CARGO_TARGET_ROOT_ENV} must be an absolute path (got "${raw}"); ` +
        'it is the root that holds main/ stack-N/ e2e/ cargo target keys',
    );
  }
  const root = resolve(raw);
  if (!exists(root)) {
    throw new Error(
      `${CARGO_TARGET_ROOT_ENV}=${root} does not exist on this machine; ` +
        'create it (mkdir) or unset the variable — this check refuses to silently build somewhere else',
    );
  }
  return root;
}

/**
 * A linked `git worktree` has `.git` as a FILE (`gitdir: ...`); the primary checkout has
 * `.git` as a directory. Used to keep lanes from sharing one stack key on the shared root
 * (two lanes both running stack-2 must not compile over each other — the BL-221 failure,
 * just relocated). Uses the injected `exists` so it stays testable without a real repo.
 */
export function isLinkedWorktree(projectRoot, exists = existsSync) {
  const dotGit = join(resolve(projectRoot), '.git');
  return exists(dotGit) && !exists(join(dotGit, 'HEAD'));
}

/**
 * Layout under `XH_CARGO_TARGET_ROOT`:
 *   primary checkout  -> <root>/{main,stack-N,e2e}
 *   linked worktree   -> <root>/<worktree-dir>/{main,stack-N,e2e}
 * The primary layout is the one the volume move created, so `main` keeps its meaning; the
 * worktree prefix is what keeps per-stack isolation intact across concurrent lanes.
 */
export function cargoTargetRootForProject(projectRoot, { env = {}, exists = existsSync } = {}) {
  const root = cargoTargetRoot({ env, exists });
  if (root === null) return null;
  if (isLinkedWorktree(projectRoot, exists)) return join(root, resolve(projectRoot).split(/[\\/]/).pop());
  return root;
}

/**
 * Base directory for per-stack targets. Precedence:
 *   1. `XH_CARGO_TARGET_ROOT` when set (and existing) — the whole family relocates.
 *   2. The same anchor `.cargo/config.toml` uses: the config resolves its relative
 *      `target-dir` against "the parent of the directory that contains `.cargo/`", so we
 *      walk up to the nearest `.cargo/config.toml` and mirror that anchor:
 *      `<anchorParent>/.tmp/cargo-target`. Sparse checkouts without their own `.cargo`
 *      therefore land on the same base as the main checkout, never inside a worktree's
 *      missing subtree.
 */
export function cargoTargetBase(projectRoot, exists = existsSync, env = process.env) {
  const root = cargoTargetRootForProject(projectRoot, { env, exists });
  if (root !== null) return root;
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
 * warm cache stays byte-identical to pre-0656 behavior — that contract is unchanged
 * unless `XH_CARGO_TARGET_ROOT` opts in, in which case the default stack gets
 * `<root>/main`, matching the on-disk key name the move created).
 *
 * Precedence: an existing `CARGO_TARGET_DIR` in `env` always wins (worktree-env.ps1
 * and manual overrides must not be silently rewritten).
 */
export function cargoTargetForStack({ stackId, projectRoot, env = {}, exists = existsSync } = {}) {
  const isDefault = stackId === undefined || stackId === DEFAULT_STACK_ID;
  const existing = typeof env.CARGO_TARGET_DIR === 'string' ? env.CARGO_TARGET_DIR.trim() : '';
  if (existing !== '') return existing;
  const root = cargoTargetRootForProject(projectRoot, { env, exists });
  if (root !== null) return join(root, isDefault ? 'main' : stackId);
  // No root configured => old contract: the default stack keeps the ambient config
  // target (undefined), every other stack gets `<base>/<stackId>`.
  if (isDefault) return undefined;
  return join(cargoTargetBase(projectRoot, exists, env), stackId);
}
