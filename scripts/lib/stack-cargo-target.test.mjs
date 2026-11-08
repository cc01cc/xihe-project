import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { cargoTargetBase, cargoTargetForStack } from './stack-cargo-target.mjs';
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
  assert.equal(cargoTargetBase(projectRoot, exists), resolve(workspace, '.tmp', 'cargo-target'));
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
