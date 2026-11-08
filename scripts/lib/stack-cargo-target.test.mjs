import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { CARGO_TARGET_ROOT_ENV, cargoTargetBase, cargoTargetForStack, cargoTargetRoot, isLinkedWorktree } from './stack-cargo-target.mjs';
import { DEFAULT_STACK_ID } from './stack-ports.mjs';

// PLAN-0656 R1: the default stack must keep the ambient config target, every other
// stack must get its own directory anchored to the SAME `.cargo/config.toml` base,
// and a pre-set CARGO_TARGET_DIR is never rewritten.

test('the default stack keeps the ambient target (returns undefined)', () => {
  assert.equal(cargoTargetForStack({ stackId: DEFAULT_STACK_ID, projectRoot: resolve('A03-xihe') }), undefined);
  assert.equal(cargoTargetForStack({ stackId: undefined, projectRoot: resolve('A03-xihe') }), undefined);
});

test('a non-default stack lands next to the nearest .cargo/config.toml anchor', () => {
  const projectRoot = resolve('A03-xihe');
  const exists = (p) => p === join(projectRoot, '.cargo', 'config.toml');
  const target = cargoTargetForStack({ stackId: 'stack-2', projectRoot, exists });
  assert.equal(target, resolve(projectRoot, '..', '.tmp', 'cargo-target', 'stack-2'));
  assert.ok(target.endsWith(join('.tmp', 'cargo-target', 'stack-2')));
  assert.notEqual(target, cargoTargetForStack({ stackId: 'stack-3', projectRoot, exists }));
});

test('a sparse checkout without .cargo walks up to the workspace anchor', () => {
  const workspace = resolve('one');
  const anchor = join(workspace, 'A03-xihe', '.cargo', 'config.toml');
  const projectRoot = join(workspace, 'A03-xihe', '.worktrees', 'plan-0656-dual-stack');
  const exists = (p) => p === anchor;
  const target = cargoTargetForStack({ stackId: 'stack-2', projectRoot, exists });
  assert.equal(target, resolve(workspace, '.tmp', 'cargo-target', 'stack-2'));
  assert.equal(cargoTargetBase(projectRoot, exists, {}), resolve(workspace, '.tmp', 'cargo-target'));
});

test('with no config anywhere the base falls back to the project root parent', () => {
  const projectRoot = resolve('somewhere', 'checkout');
  const target = cargoTargetForStack({ stackId: 'stack-4', projectRoot, exists: () => false });
  assert.equal(target, resolve(projectRoot, '..', '.tmp', 'cargo-target', 'stack-4'));
});

test('an existing CARGO_TARGET_DIR always wins (worktree-env / manual override)', () => {
  const projectRoot = resolve('A03-xihe');
  const target = cargoTargetForStack({
    stackId: 'stack-2',
    projectRoot,
    env: { CARGO_TARGET_DIR: join(resolve('elsewhere'), 'target') },
    exists: () => true,
  });
  assert.equal(target, join(resolve('elsewhere'), 'target'));
  assert.equal(cargoTargetForStack({ stackId: 'stack-2', projectRoot, env: { CARGO_TARGET_DIR: '  ' } }).endsWith('stack-2'), true);
});

// task-80: `XH_CARGO_TARGET_ROOT` relocates the whole key family off the workspace
// volume. Two properties matter more than the move itself:
//   1. UNSET is byte-identical to the pre-080 derivation (the regression guard).
//   2. SET but unusable THROWS instead of falling back to the old volume.
const ROOT = resolve('G:/zeotmp/xh-cargo-target');
const rootEnv = (root = ROOT) => ({ [CARGO_TARGET_ROOT_ENV]: root });
const rootExists = (root = ROOT) => (p) => p === resolve(root);

test('unset root keeps the pre-080 contract: default stack undefined, others on .tmp base', () => {
  const projectRoot = resolve('A03-xihe');
  const anchor = (p) => p === join(projectRoot, '.cargo', 'config.toml');
  // Blank/whitespace counts as unset — an empty env entry must not relocate anything.
  for (const env of [{}, { [CARGO_TARGET_ROOT_ENV]: '' }, { [CARGO_TARGET_ROOT_ENV]: '   ' }]) {
    assert.equal(cargoTargetForStack({ stackId: DEFAULT_STACK_ID, projectRoot, env, exists: anchor }), undefined);
    assert.equal(
      cargoTargetForStack({ stackId: 'stack-2', projectRoot, env, exists: anchor }),
      resolve(projectRoot, '..', '.tmp', 'cargo-target', 'stack-2'),
    );
    assert.equal(cargoTargetBase(projectRoot, anchor, env), resolve(projectRoot, '..', '.tmp', 'cargo-target'));
  }
});

test('a set root relocates base, default stack (main) and stack-N keys', () => {
  const projectRoot = resolve('A03-xihe');
  const env = rootEnv();
  assert.equal(cargoTargetRoot({ env, exists: rootExists() }), ROOT);
  assert.equal(cargoTargetBase(projectRoot, rootExists(), env), ROOT);
  assert.equal(cargoTargetForStack({ stackId: DEFAULT_STACK_ID, projectRoot, env, exists: rootExists() }), join(ROOT, 'main'));
  assert.equal(cargoTargetForStack({ stackId: undefined, projectRoot, env, exists: rootExists() }), join(ROOT, 'main'));
  assert.equal(cargoTargetForStack({ stackId: 'stack-2', projectRoot, env, exists: rootExists() }), join(ROOT, 'stack-2'));
  assert.equal(cargoTargetForStack({ stackId: 'e2e', projectRoot, env, exists: rootExists() }), join(ROOT, 'e2e'));
  // The anchor walk is irrelevant once the root is configured (no config.toml needed):
  // `rootExists()` only vouches for the root itself, never for a `.cargo/config.toml`.
  assert.equal(cargoTargetBase(projectRoot, rootExists(), env), ROOT);
});

test('CARGO_TARGET_DIR still outranks the configured root, on every stack', () => {
  const projectRoot = resolve('A03-xihe');
  const explicit = join(resolve('elsewhere'), 'lane-target');
  const env = { ...rootEnv(), CARGO_TARGET_DIR: explicit };
  assert.equal(cargoTargetForStack({ stackId: DEFAULT_STACK_ID, projectRoot, env, exists: rootExists() }), explicit);
  assert.equal(cargoTargetForStack({ stackId: 'stack-2', projectRoot, env, exists: rootExists() }), explicit);
});

test('a set root that does not exist throws (no silent fallback to the old volume)', () => {
  const projectRoot = resolve('A03-xihe');
  const env = rootEnv('G:/zeotmp/typo-target-root');
  for (const stackId of [DEFAULT_STACK_ID, 'stack-2']) {
    assert.throws(
      () => cargoTargetForStack({ stackId, projectRoot, env, exists: () => false }),
      /XH_CARGO_TARGET_ROOT=.*does not exist/,
    );
  }
  assert.throws(() => cargoTargetBase(projectRoot, () => false, env), /XH_CARGO_TARGET_ROOT=.*does not exist/);
});

test('a relative root is rejected instead of being resolved against the cwd', () => {
  const projectRoot = resolve('A03-xihe');
  for (const bad of ['zeotmp/xh-cargo-target', '.tmp/cargo-target']) {
    assert.throws(
      () => cargoTargetRoot({ env: rootEnv(bad), exists: () => true }),
      /XH_CARGO_TARGET_ROOT must be an absolute path/,
    );
  }
});

// Two lanes both running `dev:stack --stack 2` must not compile over each other on the
// shared root — that is the BL-221 failure relocated to another volume. Linked worktrees
// therefore namespace their keys under <root>/<worktree-dir>/; the primary checkout keeps
// the flat layout the volume move created (main / stack-N / e2e).
test('linked worktrees namespace their keys; the primary checkout stays flat', () => {
  const primary = resolve('A03-xihe');
  const lane = resolve('A03-xihe/.worktrees/plan-0631-t32');
  const env = rootEnv();
  const primaryExists = (p) => p === ROOT || p === join(primary, '.git') || p === join(primary, '.git', 'HEAD');
  const laneExists = (p) => p === ROOT || p === join(lane, '.git');
  assert.equal(isLinkedWorktree(primary, primaryExists), false);
  assert.equal(isLinkedWorktree(lane, laneExists), true);
  assert.equal(cargoTargetBase(primary, primaryExists, env), ROOT);
  assert.equal(cargoTargetBase(lane, laneExists, env), join(ROOT, 'plan-0631-t32'));
  assert.equal(
    cargoTargetForStack({ stackId: 'stack-2', projectRoot: primary, env, exists: primaryExists }),
    join(ROOT, 'stack-2'),
  );
  assert.equal(
    cargoTargetForStack({ stackId: DEFAULT_STACK_ID, projectRoot: lane, env, exists: laneExists }),
    join(ROOT, 'plan-0631-t32', 'main'),
  );
  assert.equal(
    cargoTargetForStack({ stackId: 'stack-2', projectRoot: lane, env, exists: laneExists }),
    join(ROOT, 'plan-0631-t32', 'stack-2'),
  );
});
