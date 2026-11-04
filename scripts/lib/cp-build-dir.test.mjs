/**
 * BL-253 L3 unit tests: per-stack build dir derivation, `.current` pointer and retention.
 *
 * The two properties worth pinning: (1) `XIHE_CP_TARGET_DIR` always wins (rollback channel must
 * never be weakened by the derivation), and (2) retention can only ever see
 * `<root>/<stack-N>/<sha12>[-dirty]` — legacy dirs (`dev-host`, `bl240-cp`, `stack-2-<sha>`,
 * E2E `e2e/`, rust targets) live outside this root and outside this pattern, so a wrong `--keep`
 * cannot delete them.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_KEEP,
  POINTER_FILE,
  cpBuildRoot,
  cpBuildSlot,
  listStacksUnderRoot,
  pointerPath,
  readPointer,
  resolveCpTargetDir,
  sameTargetDir,
  scanStackBuilds,
  selectPrunable,
  writePointer,
} from './cp-build-dir.mjs';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const SHA_A = '0123456789abcdef0123456789abcdef01234567';
const SHA_B = 'fedcba9876543210fedcba9876543210fedcba98';
const SHA_C = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function tempRoot(t) {
  const directory = mkdtempSync(join(tmpdir(), 'xihe-cp-build-dir-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Create `<root>/<stack>/<slot>` dirs with explicit mtimes (dir mtime = creation order is flaky). */
function makeSlot(root, stackId, slot, mtimeMs) {
  const dir = join(root, stackId, slot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'marker'), 'x');
  const stamp = new Date(mtimeMs);
  // Explicit mtimes keep the retention sort deterministic across filesystems.
  utimesSync(dir, stamp, stamp);
  return dir;
}

test('cpBuildRoot: XIHE_CP_BUILD_ROOT wins, otherwise platform default', () => {
  assert.equal(cpBuildRoot({ env: { XIHE_CP_BUILD_ROOT: 'G:/zeotmp/cp' }, platform: 'win32' }), resolve('G:/zeotmp/cp'));
  assert.equal(cpBuildRoot({ env: {}, platform: 'win32' }), resolve('C:/xihe-build/cp'));
  assert.ok(cpBuildRoot({ env: {}, platform: 'linux' }).endsWith('xihe-cp-build'));
  // Relative override resolves against cwd (documented as "use an absolute root").
  assert.equal(cpBuildRoot({ env: { XIHE_CP_BUILD_ROOT: '   ' }, platform: 'win32' }), resolve('C:/xihe-build/cp'));
});

test('cpBuildSlot: sha12 for clean, -dirty suffix for dirty, null for unknown', () => {
  assert.equal(cpBuildSlot({ commit: SHA_A }), '0123456789ab');
  assert.equal(cpBuildSlot({ commit: SHA_A, dirty: true }), '0123456789ab-dirty');
  assert.equal(cpBuildSlot({ commit: SHA_A.toUpperCase() }), '0123456789ab', 'lowercased');
  assert.equal(cpBuildSlot({ commit: 'abc1234' }), 'abc1234', 'abbreviated sha is a usable slot');
  assert.equal(cpBuildSlot({ commit: 'abc' }), null, 'too short to be recognisable by retention');
  assert.equal(cpBuildSlot({ commit: null }), null);
  assert.equal(cpBuildSlot({}), null);
});

test('resolveCpTargetDir: explicit XIHE_CP_TARGET_DIR always wins (rollback channel)', () => {
  const layout = resolveCpTargetDir({
    stackId: 'stack-2',
    env: { XIHE_CP_TARGET_DIR: 'D:/hand-picked/cp' },
    commit: SHA_A,
    dirty: true,
    platform: 'win32',
  });
  assert.equal(layout.source, 'env');
  assert.equal(layout.targetDir, resolve('D:/hand-picked/cp'));
  assert.equal(layout.slot, null);
});

test('resolveCpTargetDir: derives <root>/<stack>/<sha12>[-dirty]', () => {
  const clean = resolveCpTargetDir({
    stackId: 'stack-1',
    env: { XIHE_CP_BUILD_ROOT: 'G:/zeotmp/cp' },
    commit: SHA_A,
    dirty: false,
    platform: 'win32',
  });
  assert.equal(clean.source, 'derived');
  assert.equal(clean.targetDir, join(resolve('G:/zeotmp/cp'), 'stack-1', '0123456789ab'));
  assert.equal(clean.slot, '0123456789ab');

  const dirty = resolveCpTargetDir({
    stackId: 'stack-2',
    env: { XIHE_CP_BUILD_ROOT: 'G:/zeotmp/cp' },
    commit: SHA_B,
    dirty: true,
    platform: 'win32',
  });
  assert.equal(dirty.targetDir, join(resolve('G:/zeotmp/cp'), 'stack-2', 'fedcba987654-dirty'));
});

test('resolveCpTargetDir: no commit ⇒ unresolved (caller keeps legacy target/)', () => {
  const layout = resolveCpTargetDir({ stackId: 'stack-1', env: {}, commit: null, platform: 'win32' });
  assert.equal(layout.source, 'unresolved');
  assert.equal(layout.targetDir, null);
  assert.match(layout.reason, /without a HEAD commit/u);
});

test('pointer round-trips, and corrupt/missing pointers read as null', (t) => {
  const root = tempRoot(t);
  const file = writePointer({
    root,
    stackId: 'stack-1',
    pointer: {
      targetDir: join(root, 'stack-1', '0123456789ab'),
      commit: SHA_A,
      dirty: false,
      verdict: 'fresh',
      builtAt: '2026-11-04T21:00:00.000Z',
      startedAt: '2026-11-04T21:05:00.000Z',
      source: 'derived',
    },
  });
  assert.equal(file, pointerPath({ root, stackId: 'stack-1' }));
  assert.ok(file.endsWith(POINTER_FILE));
  const pointer = readPointer({ root, stackId: 'stack-1' });
  assert.equal(pointer.stackId, 'stack-1');
  assert.equal(pointer.targetDir, join(root, 'stack-1', '0123456789ab'));
  assert.equal(pointer.commit, SHA_A);

  assert.equal(readPointer({ root, stackId: 'stack-9' }), null, 'missing pointer');
  mkdirSync(join(root, 'stack-9'), { recursive: true });
  writeFileSync(pointerPath({ root, stackId: 'stack-9' }), '{not json');
  assert.equal(readPointer({ root, stackId: 'stack-9' }), null, 'corrupt pointer');
});

test('sameTargetDir compares Windows paths case/separator-insensitively', () => {
  assert.equal(sameTargetDir('C:/xihe-build/cp/stack-1/0123456789ab', 'C:\\xihe-build\\cp\\stack-1\\0123456789AB'), true);
  assert.equal(sameTargetDir('C:/xihe-build/cp/stack-1/a', 'C:/xihe-build/cp/stack-2/a'), false);
  assert.equal(sameTargetDir('', 'C:/x'), false);
});

test('scanStackBuilds sees only slot dirs, newest first', (t) => {
  const root = tempRoot(t);
  makeSlot(root, 'stack-1', '0123456789ab', Date.parse('2026-11-04T20:00:00Z'));
  makeSlot(root, 'stack-1', 'fedcba987654', Date.parse('2026-11-04T21:00:00Z'));
  makeSlot(root, 'stack-1', 'aaaaaaaaaaaa-dirty', Date.parse('2026-11-04T19:00:00Z'));
  mkdirSync(join(root, 'stack-1', 'dev-host'), { recursive: true });
  mkdirSync(join(root, 'stack-1', 'not-a-sha'), { recursive: true });
  writeFileSync(join(root, 'stack-1', '0123456789ab-note.txt'), 'x');

  const entries = scanStackBuilds({ root, stackId: 'stack-1' });
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['fedcba987654', '0123456789ab', 'aaaaaaaaaaaa-dirty'],
  );
  assert.deepEqual(scanStackBuilds({ root, stackId: 'stack-2' }), []);
});

test('selectPrunable keeps N newest + the pointer target, never legacy names', () => {
  const entries = [
    { name: 'aaaaaaaaaaaa', path: '/r/s/aaaaaaaaaaaa', mtimeMs: 5 },
    { name: 'bbbbbbbbbbbb', path: '/r/s/bbbbbbbbbbbb', mtimeMs: 4 },
    { name: 'cccccccccccc', path: '/r/s/cccccccccccc', mtimeMs: 3 },
    { name: 'dddddddddddd', path: '/r/s/dddddddddddd', mtimeMs: 2 },
    { name: 'eeeeeeeeeeee', path: '/r/s/eeeeeeeeeeee', mtimeMs: 1 },
    { name: 'dev-host', path: '/r/s/dev-host', mtimeMs: 0 },
    { name: 'bl240-cp', path: '/r/s/bl240-cp', mtimeMs: 0 },
  ];
  const plan = selectPrunable({ entries, keep: 2 });
  assert.deepEqual(plan.kept, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  assert.deepEqual(plan.pruned, ['cccccccccccc', 'dddddddddddd', 'eeeeeeeeeeee']);
  assert.deepEqual(plan.prunedPaths, ['/r/s/cccccccccccc', '/r/s/dddddddddddd', '/r/s/eeeeeeeeeeee']);

  // The pointer target is pinned even when it is the oldest dir.
  const pinned = selectPrunable({ entries, keep: 2, keepPath: '/r/s/eeeeeeeeeeee' });
  assert.deepEqual(pinned.kept, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  assert.equal(pinned.pruned.includes('eeeeeeeeeeee'), false, 'pointer target is never pruned');
  assert.deepEqual(pinned.pruned, ['cccccccccccc', 'dddddddddddd']);
});

test('selectPrunable default keep is 3 and keep=0 prunes every unpinned slot', () => {
  const entries = ['a', 'b', 'c', 'd'].map((name, index) => ({
    name: name.repeat(12),
    mtimeMs: 10 - index,
  }));
  assert.equal(DEFAULT_KEEP, 3);
  assert.equal(selectPrunable({ entries }).pruned.length, 1);
  assert.equal(selectPrunable({ entries, keep: 0 }).pruned.length, 4);
});

test('listStacksUnderRoot only returns stack-N dirs', (t) => {
  const root = tempRoot(t);
  for (const name of ['stack-1', 'stack-2', 'dev-host', 'e2e', 'bl240-cp', 'rust-audit-target']) {
    mkdirSync(join(root, name), { recursive: true });
  }
  writeFileSync(join(root, 'stack-1', POINTER_FILE), '{}');
  assert.deepEqual(listStacksUnderRoot({ root }), ['stack-1', 'stack-2']);
  assert.deepEqual(listStacksUnderRoot({ root: join(projectRoot, 'no-such-root') }), []);
});
