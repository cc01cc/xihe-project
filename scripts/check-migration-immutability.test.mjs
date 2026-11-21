#!/usr/bin/env node
/**
 * `scripts/check-migration-immutability.mjs` 的自测（task-134）。
 *
 * 为什么必须是**真 git 仓库 + 真退出码**：这条判据的全部难点在「已发布集合怎么算」——
 * `git merge-base develop HEAD` 那棵树里的 `**\/db/migration/V*.sql`。用内存里拼一个
 * 「假 published 集合」只能证明比较函数会比较，证明不了 merge-base 取对了、改名/删除
 * 会命中、git 不可用时不会伪装成绿。
 *
 * 每个夹具是 `os.tmpdir()` 下的临时仓库，用 plumbing（`update-ref` + `symbolic-ref`）
 * 建分支，不 checkout，不碰调用方工作树；跑完即删。
 *
 * 跑法：`node --test scripts/check-migration-immutability.test.mjs`
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildFixture,
  CODES,
  evaluate,
  EXIT,
  parseArgs,
} from './check-migration-immutability.mjs';

const SCRIPT = fileURLToPath(new URL('./check-migration-immutability.mjs', import.meta.url));

function runScript(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function withFixture(kind, fn) {
  const fixture = buildFixture(kind);
  try {
    return fn(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test('改已发布 V1（只改注释）=> exit 1，点名 V1 文件', () => {
  withFixture('modified-published', ({ root }) => {
    const result = runScript(['--repo', root]);
    assert.equal(result.code, EXIT.FOUND, result.stdout);
    assert.match(result.stdout, /E_PUBLISHED_MIGRATION_MODIFIED V1 /);
    assert.match(result.stdout, /V1__fixture\.sql/);
  });
});

test('新增更高号 V2 => exit 0（未发布号可改）', () => {
  withFixture('new-higher-number', ({ root }) => {
    const result = runScript(['--repo', root]);
    assert.equal(result.code, EXIT.OK, result.stdout);
    assert.match(result.stdout, /published=1 /);
    assert.match(result.stdout, /OK 已发布迁移未改动/);
  });
});

test('改未发布号 V2（只在 HEAD 之后新增）=> exit 0', () => {
  withFixture('modified-unpublished', ({ root }) => {
    const result = runScript(['--repo', root]);
    assert.equal(result.code, EXIT.OK, result.stdout);
    assert.match(result.stdout, /OK 已发布迁移未改动/);
  });
});

test('改已发布文件名 V1 -> V9 => exit 1，E_RENAMED', () => {
  withFixture('renamed-published', ({ root }) => {
    const result = runScript(['--repo', root]);
    assert.equal(result.code, EXIT.FOUND, result.stdout);
    assert.match(result.stdout, /E_PUBLISHED_MIGRATION_RENAMED V1 /);
  });
});

test('取不到 merge-base => exit 2（判不了 ≠ 通过）', () => {
  withFixture('no-merge-base', ({ root }) => {
    const result = runScript(['--repo', root, '--base', 'develop']);
    assert.equal(result.code, EXIT.USAGE, result.stdout);
    assert.match(result.stdout, /E_CANNOT_EVALUATE/);
    assert.doesNotMatch(result.stdout, /OK /);
  });
});

test('逃生口成对出现 => exit 0 + WARN 留痕', () => {
  withFixture('modified-published', ({ root }) => {
    const result = runScript([
      '--repo',
      root,
      '--allow-published-edit',
      'V1',
      '--reason',
      'fixture: approved in test',
    ]);
    assert.equal(result.code, EXIT.OK, result.stdout);
    assert.match(result.stdout, /WARN allow-published-edit V1 reason=fixture: approved in test/);
    assert.match(result.stdout, /1 条已按逃生口放行/);
  });
});

test('逃生口只写一半 / 未知参数 => exit 2', () => {
  assert.throws(
    () => parseArgs(['--allow-published-edit', 'V1']),
    /成对必填/,
  );
  assert.throws(() => parseArgs(['--reason', 'x']), /只能作为/);
  assert.throws(() => parseArgs(['--selftest-off']), /未知参数/);
  const result = runScript(['--allow-published-edit', 'V1']);
  assert.equal(result.code, EXIT.USAGE, result.stdout);
});

test('--report-only：命中仍 exit 0，但输出 REPORT-ONLY', () => {
  withFixture('modified-published', ({ root }) => {
    const result = runScript(['--repo', root, '--report-only']);
    assert.equal(result.code, EXIT.OK, result.stdout);
    assert.match(result.stdout, /REPORT-ONLY 命中 1 条/);
  });
});

test('evaluate 的读数可断言：published 集合来自 merge-base 而不是工作树', () => {
  withFixture('modified-unpublished', ({ root }) => {
    const result = evaluate({ repo: root, base: 'develop' });
    // V1 is published, V2 exists only after the merge-base => published must stay 1.
    assert.equal(result.publishedCount, 1);
    assert.equal(result.violations.length, 0);
  });
});

test('改名用 E_RENAMED 而不是只报删除', () => {
  withFixture('renamed-published', ({ root }) => {
    const result = evaluate({ repo: root, base: 'develop' });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].code, CODES.RENAMED);
  });
});
