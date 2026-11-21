import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  LOCK_FILENAME,
  acquireTestLock,
  classifyForkConflict,
  findForeignMaven,
  lockPathFor,
  resolveTargetDir,
  runSelftest,
} from './cp-test-run.mjs';

const tmpRoots = [];
function tmpTree(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cp-test-run-test-${name}-`));
  tmpRoots.push(root);
  return root;
}
process.on('exit', () => {
  for (const root of tmpRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // 临时目录清不掉不影响断言。
    }
  }
});

test('resolveTargetDir: 显式 -Dxihe.target.dir 优先于 -Dxihe.build.suffix', () => {
  const pkg = tmpTree('resolve');
  const explicit = path.join(pkg, 'elsewhere', 'target');
  const got = resolveTargetDir([`-Dxihe.target.dir=${explicit}`, '-Dxihe.build.suffix=-race'], pkg);
  assert.equal(got.targetDir, explicit);
  assert.equal(got.source, 'target-dir');
});

test('锁元数据自证「锁的是哪棵树」：targetDir / pid / startedAt / argv0', () => {
  const tree = tmpTree('meta');
  const lock = acquireTestLock({
    targetDir: tree,
    argv0: 'node scripts/cp-test-run.mjs',
    runId: 'run-1',
  });
  assert.equal(lock.kind, 'acquired');
  assert.equal(lock.path, path.join(tree, LOCK_FILENAME));
  const holder = JSON.parse(fs.readFileSync(lock.path, 'utf8'));
  assert.equal(holder.targetDir, path.resolve(tree));
  assert.equal(holder.pid, process.pid);
  assert.equal(holder.argv0, 'node scripts/cp-test-run.mjs');
  assert.equal(holder.runId, 'run-1');
  assert.ok(Number.isFinite(Date.parse(holder.startedAt)), holder.startedAt);
  assert.equal(lock.release(), true);
  assert.equal(fs.existsSync(lock.path), false);
});

test('同树活持有者 ⇒ 拒绝，且不覆盖对方的锁', () => {
  const tree = tmpTree('held');
  const lockPath = lockPathFor(tree);
  fs.mkdirSync(tree, { recursive: true });
  const other = {
    pid: 4242,
    startedAt: new Date().toISOString(),
    targetDir: path.resolve(tree),
    argv0: 'other',
  };
  fs.writeFileSync(lockPath, JSON.stringify(other) + '\n', { flag: 'wx' });
  const got = acquireTestLock({ targetDir: tree, alive: () => true });
  assert.equal(got.kind, 'held');
  assert.equal(got.holder.pid, 4242);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, 4242);
});

test('持有者 pid 已死 ⇒ 判过期并接管（旧锁改名留现场）', () => {
  const tree = tmpTree('stale');
  const lockPath = lockPathFor(tree);
  fs.mkdirSync(tree, { recursive: true });
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      pid: 999_999,
      startedAt: new Date().toISOString(),
      targetDir: path.resolve(tree),
      argv0: 'dead',
    }) + '\n',
    { flag: 'wx' },
  );
  const got = acquireTestLock({ targetDir: tree, alive: () => false, log: () => {} });
  assert.equal(got.kind, 'acquired');
  assert.equal(JSON.parse(fs.readFileSync(got.path, 'utf8')).pid, process.pid);
  const parked = fs.readdirSync(tree).filter((name) => name.includes('.stale-'));
  assert.equal(parked.length, 1, JSON.stringify(fs.readdirSync(tree)));
  got.release();
});

test('不同 targetDir ⇒ 必须放行（stack lane 用 per-sha 目录，误拦症状是起栈失败）', () => {
  const pkg = tmpTree('pkg');
  const me = path.join(pkg, 'target');
  const stackLane = path.join(path.parse(pkg).root, 'xihe-build', 'cp', 'stack-2', '1fc5d4b57eb1');
  const entries = [
    {
      pid: 5001,
      parentPid: 1,
      commandLine: `mvn.cmd -B -o -Dxihe.target.dir=${stackLane} test`,
    },
  ];
  assert.deepEqual(findForeignMaven(entries, { targetDir: me, packageDir: pkg }), []);
});

test('同显式 targetDir 的外来 mvn ⇒ 拦；裸 mvn 在默认树 ⇒ 拦', () => {
  const pkg = tmpTree('pkg2');
  const me = path.join(pkg, 'target');
  const same = findForeignMaven(
    [{ pid: 5002, parentPid: 1, commandLine: `mvn.cmd -B -o -Dxihe.target.dir=${me} test` }],
    { targetDir: me, packageDir: pkg },
  );
  assert.equal(same.length, 1);
  const bare = findForeignMaven(
    [{ pid: 5003, parentPid: 1, commandLine: 'mvn.cmd -B -o clean test-compile' }],
    {
      targetDir: me,
      packageDir: pkg,
    },
  );
  assert.equal(bare.length, 1);
  assert.equal(bare[0].reason, 'unknown-bare');
});

test('classifyForkConflict: 本轮（mtime >= since）的 dumpstream 才是并发证据', () => {
  const pkg = tmpTree('classify');
  const tree = path.join(pkg, 'target');
  const reports = path.join(tree, 'surefire-reports');
  fs.mkdirSync(reports, { recursive: true });
  const dump = path.join(reports, '2026-11-21T13-04-37_523.dumpstream');
  fs.writeFileSync(
    dump,
    "Boot Manifest-JAR contains absolute paths in classpath 'X:\\p\\target\\test-classes'\n",
    { flag: 'wx' },
  );
  const fresh = classifyForkConflict({
    targetDir: tree,
    since: Date.now() - 60_000,
    packageDir: pkg,
  });
  assert.equal(fresh.conflict, true);
  const stale = classifyForkConflict({
    targetDir: tree,
    since: Date.now() + 3_600_000,
    packageDir: pkg,
  });
  assert.equal(stale.conflict, false);
});

test('runSelftest（注入替身，不起真 mvn）全绿', () => {
  const quiet = [];
  const code = runSelftest({ deps: { log: (...args) => quiet.push(args.join(' ')) } });
  assert.equal(code, 0, quiet.join('\n'));
  assert.ok(
    quiet.some((line) => line.includes('cases as expected')),
    quiet.join('\n'),
  );
});
