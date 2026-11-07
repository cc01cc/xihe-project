#!/usr/bin/env node
/**
 * 缺陷 3 的单测（`scripts/lib/e2e-runtime-target.mjs`）：
 * preflight 的 runtime 新鲜度必须指向**真实** target 目录，且解析不到时判"不可验证"。
 *
 * 判据（卡面原文）：真实跑用 `.tmp/cargo-target/{main,stack-2}/debug/xihe-runtime.exe`，
 * 仓库内的 `packages/runtime/target` 是废弃布局；**解析不到 ⇒ `unverifiable: true` 且阻塞**，
 * 不许降级成 WARN（"未知不等于安全"，与磁盘门同一条判据）。
 *
 * 所有用例注入假的 `runCapture`/`readdir`，不跑 cargo、不读真实磁盘。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CARGO_METADATA_ARGS,
  inspectRuntimeBinaries,
  legacyRuntimeTargetDir,
  parseCargoMetadataTargetDirectory,
  resolveRuntimeTargetDirs,
  siblingStackTargetDirs,
} from './e2e-runtime-target.mjs';

const projectRoot = 'H:/zeogit/one/A03-xihe';

/** 造一个 `cargo metadata`（--no-deps）成功响应。 */
function metadataOk(targetDirectory) {
  return {
    ok: true,
    code: 0,
    stdout: JSON.stringify({
      packages: [],
      workspace_root: projectRoot,
      target_directory: targetDirectory,
      version: 1,
    }),
    stderr: '',
  };
}

/** 造一个目录列表（Dirent 形状只需 name/isDirectory）。 */
function dirEntries(names, files = []) {
  return [
    ...names.map((name) => ({ name, isDirectory: () => true, isFile: () => false })),
    ...files.map((name) => ({ name, isDirectory: () => false, isFile: () => true })),
  ];
}

test('T1 真实布局：cargo metadata 给出的 target 目录 + 兄弟栈目录，全部来自 .tmp/cargo-target', () => {
  const calls = [];
  const cargoRoot = `${projectRoot}/packages/runtime`;
  const result = resolveRuntimeTargetDirs({
    projectRoot,
    env: {},
    cargoRoot,
    runCapture: (program, args, timeoutMs, cwd) => {
      calls.push({ program, args, timeoutMs, cwd });
      return metadataOk('H:/zeogit/one/.tmp/cargo-target/main');
    },
    readdir: () => dirEntries(['main', 'stack-2', 'm3-a13'], ['README.md']),
  });

  assert.equal(result.source, 'cargo-metadata');
  assert.equal(result.unverifiable, false);
  // 主目录在前，兄弟栈目录跟上；普通目录/文件不认。
  assert.deepEqual(
    result.targetDirs.map((entry) => entry.label),
    ['main', 'stack-2'],
  );
  assert.equal(result.targetDirs[0].dir, 'H:/zeogit/one/.tmp/cargo-target/main');
  assert.equal(result.targetDirs[1].dir, 'H:/zeogit/one/.tmp/cargo-target/stack-2');
  // 废弃的仓库内布局绝不参与判定，只作为"它不被采信"的说明字段带出来。
  assert.equal(result.legacyDir, 'H:/zeogit/one/A03-xihe/packages/runtime/target');
  assert.equal(
    result.targetDirs.some((entry) => entry.dir.includes('/packages/runtime/target')),
    false,
  );
  // 只用 cargo 自己的解析（不手写 TOML），且必须只读：--no-deps --offline --locked 都不构建、不联网、不写 lockfile。
  assert.equal(calls.length, 1);
  assert.equal(calls[0].program, 'cargo');
  assert.deepEqual(calls[0].args, [...CARGO_METADATA_ARGS]);
  assert.match(calls[0].args.join(' '), /--no-deps --offline --locked --format-version 1/);
  // cwd 必须是有 Cargo.toml 的那个目录（XH 的 workspace 根是 packages/runtime），
  // 否则 cargo 会报 "could not find Cargo.toml"。
  assert.equal(calls[0].cwd, cargoRoot);
});

test('T1b cwd 派生：packages/runtime 存在就用它，否则退回仓库根（cargo 仍会向上找 .cargo/config.toml）', () => {
  const seen = [];
  const runCapture = (_program, _args, _timeoutMs, cwd) => {
    seen.push(cwd);
    return metadataOk('H:/zeogit/one/.tmp/cargo-target/main');
  };
  const withManifest = resolveRuntimeTargetDirs({
    projectRoot,
    env: {},
    runCapture,
    readdir: () => dirEntries(['main']),
    exists: (path) => path === `${projectRoot}/packages/runtime/Cargo.toml`,
  });
  assert.equal(withManifest.source, 'cargo-metadata');
  assert.equal(seen[0], `${projectRoot}/packages/runtime`);

  seen.length = 0;
  resolveRuntimeTargetDirs({
    projectRoot,
    env: {},
    runCapture,
    readdir: () => dirEntries(['main']),
    exists: () => false,
  });
  assert.equal(seen[0], projectRoot);
});

test('T2 CARGO_TARGET_DIR 优先于 config.toml：直接用它，不扫兄弟目录（worktree-env 外置）', () => {
  let called = false;
  const result = resolveRuntimeTargetDirs({
    projectRoot,
    env: { CARGO_TARGET_DIR: 'H:\\zeolib\\cargo-target\\m3-a13' },
    runCapture: () => {
      called = true;
      return metadataOk('H:/ignored/target');
    },
    readdir: () => dirEntries(['main', 'stack-2']),
  });
  assert.equal(result.source, 'env');
  assert.equal(result.unverifiable, false);
  assert.deepEqual(result.targetDirs.map((entry) => entry.dir), ['H:/zeolib/cargo-target/m3-a13']);
  assert.equal(result.targetDirs[0].label, 'm3-a13');
  assert.equal(called, false, 'env override must win without asking cargo');
});

test('T3 相对 CARGO_TARGET_DIR 相对仓库根解析（cargo 的语义）', () => {
  const result = resolveRuntimeTargetDirs({
    projectRoot,
    env: { CARGO_TARGET_DIR: '../.tmp/cargo-target/m3-a13' },
    runCapture: () => metadataOk('H:/unused'),
    readdir: () => dirEntries([]),
  });
  assert.equal(result.source, 'env');
  assert.equal(result.targetDirs[0].dir, 'H:/zeogit/one/.tmp/cargo-target/m3-a13');
});

test('T4 cargo metadata 失败 ⇒ unverifiable（阻塞），reason 带 cargo 自己的错误行', () => {
  const result = resolveRuntimeTargetDirs({
    projectRoot,
    env: {},
    runCapture: () => ({ ok: false, code: 101, stdout: '', stderr: 'error: failed to load manifest\nCaused by: ...' }),
    readdir: () => dirEntries([]),
  });
  assert.equal(result.source, 'unverifiable');
  assert.equal(result.unverifiable, true);
  assert.deepEqual(result.targetDirs, []);
  assert.match(result.reason, /cargo metadata failed/);
  assert.match(result.reason, /failed to load manifest/);
});

test('T5 输出不是 JSON / 缺 target_directory / 空串 ⇒ unverifiable（不猜路径）', () => {
  const cases = [
    { name: '非 JSON', stdout: 'not json at all' },
    { name: '缺字段', stdout: JSON.stringify({ workspace_root: projectRoot }) },
    { name: '空串', stdout: JSON.stringify({ target_directory: '   ' }) },
    { name: '非字符串', stdout: JSON.stringify({ target_directory: 42 }) },
  ];
  for (const item of cases) {
    const result = resolveRuntimeTargetDirs({
      projectRoot,
      env: {},
      runCapture: () => ({ ok: true, code: 0, stdout: item.stdout, stderr: '' }),
      readdir: () => dirEntries(['main']),
    });
    assert.equal(result.unverifiable, true, `${item.name}: must be unverifiable`);
    assert.equal(result.source, 'unverifiable', item.name);
    assert.deepEqual(result.targetDirs, [], item.name);
    assert.match(result.reason, /target_directory|metadata/, item.name);
  }
});

test('T6 没有 runCapture 可问 ⇒ unverifiable（不能"假装查过"）', () => {
  const result = resolveRuntimeTargetDirs({ projectRoot, env: {}, readdir: () => dirEntries([]) });
  assert.equal(result.unverifiable, true);
  assert.match(result.reason, /no runCapture/);
});

test('T7 纯解析：target_directory 前后空白会被 trim，反斜杠归一化由调用方的目录拼接负责', () => {
  assert.equal(parseCargoMetadataTargetDirectory(JSON.stringify({ target_directory: ' H:/x/y ' })), 'H:/x/y');
  assert.equal(parseCargoMetadataTargetDirectory(''), null);
});

test('T8 兄弟目录扫描只认 main / stack-N，且主目录永远排第一', () => {
  const entries = siblingStackTargetDirs('H:/one/.tmp/cargo-target/main', {
    readdir: () => dirEntries(['stack-1', 'stack-2', 'tmp', 'target'], ['CACHEDIR.TAG']),
  });
  // stack-1 是旧命名（真实跑法是 main），不额外排除：它同样是 cargo 的 target 目录。
  assert.deepEqual(entries.map((entry) => entry.label), ['main', 'stack-1', 'stack-2']);
  // 主目录是 base 找不到时的唯一答案（readdir 抛错也不能丢主目录）。
  const fallback = siblingStackTargetDirs('H:/one/.tmp/cargo-target/main', {
    readdir: () => {
      throw new Error('EPERM');
    },
  });
  assert.deepEqual(fallback.map((entry) => entry.label), ['main']);
});

test('T9 废弃布局的路径可被显式点名（用于输出"它不被采信"的证据）', () => {
  assert.equal(
    legacyRuntimeTargetDir('H:\\zeogit\\one\\A03-xihe\\.worktrees\\m3-a13'),
    'H:/zeogit/one/A03-xihe/.worktrees/m3-a13/packages/runtime/target',
  );
});

// ---------------------------------------------------------------------------
// inspectRuntimeBinaries：缺陷 3 的**判据**（哪条阻塞、哪条只 WARN/INFO）。
// 用假的 exists/stat 喂真实布局，不碰磁盘。
// ---------------------------------------------------------------------------
function resolutionFixture(dirs, extra = {}) {
  return {
    source: 'cargo-metadata',
    targetDirs: dirs.map((dir) => ({ dir, label: dir.split('/').pop() })),
    legacyDir: `${projectRoot}/packages/runtime/target`,
    unverifiable: false,
    reason: '.cargo/config.toml [build] target-dir resolved by cargo: H:/zeogit/one/.tmp/cargo-target/main',
    ...extra,
  };
}

/** exists/stat 的假文件系统：路径 → mtimeMs。 */
function fakeFs(files) {
  return {
    exists: (path) => Object.hasOwn(files, path),
    stat: (path) => ({ mtimeMs: files[path] }),
  };
}

const mainDir = 'H:/zeogit/one/.tmp/cargo-target/main';
const stack2Dir = 'H:/zeogit/one/.tmp/cargo-target/stack-2';

test('T10 解析不到 target 目录 ⇒ unverifiable + 阻塞（不许降级成 WARN），且绝不退回废弃布局', () => {
  const inspection = inspectRuntimeBinaries(
    {
      resolution: { source: 'unverifiable', targetDirs: [], legacyDir: `${projectRoot}/packages/runtime/target`, unverifiable: true, reason: 'cargo metadata failed (could not find Cargo.toml)' },
      binaryName: 'xihe-runtime.exe',
      sourceNewest: { path: `${projectRoot}/packages/runtime/src/main.rs`, mtimeMs: 1000 },
    },
    fakeFs({}),
  );
  assert.equal(inspection.status, 'unverifiable');
  assert.equal(inspection.blocking, true);
  assert.equal(inspection.severity, 'FAIL');
  assert.match(inspection.message, /UNVERIFIABLE/);
  assert.match(inspection.message, /could not find Cargo\.toml/);
  assert.match(inspection.hint, /CARGO_TARGET_DIR/);
  // 这条是缺陷本体：解析不出来也不许拿 packages/runtime/target 当依据。
  assert.deepEqual(inspection.binaries, []);
  assert.equal(inspection.targetDirs.length, 0);
});

test('T11 真实布局：取最新 debug binary 判定，逐栈列出；release 只作信息', () => {
  const sources = { path: `${projectRoot}/packages/runtime/src/main.rs`, mtimeMs: 1_700_000_000_000 };
  const fs = fakeFs({
    [`${mainDir}/debug/xihe-runtime.exe`]: 1_699_999_000_000, // 比源码旧 1000s
    [`${stack2Dir}/debug/xihe-runtime.exe`]: 1_700_000_500_000, // 比源码新 ⇒ 判定用这一个
    [`${mainDir}/release/xihe-runtime.exe`]: 1_699_990_000_000,
  });
  const inspection = inspectRuntimeBinaries(
    { resolution: resolutionFixture([mainDir, stack2Dir]), binaryName: 'xihe-runtime.exe', sourceNewest: sources },
    fs,
  );
  assert.equal(inspection.status, 'fresh');
  assert.equal(inspection.severity, null);
  assert.equal(inspection.newest.label, 'stack-2');
  assert.deepEqual(inspection.binaries.map((entry) => entry.label), ['main', 'stack-2']);
  assert.deepEqual(inspection.releases.map((entry) => entry.label), ['main']);
  // 废弃布局存在也不参与判定，只标记"它存在但不被采信"。
  assert.equal(inspection.legacyPresent, false);
});

test('T12 全部 debug binary 都比源码旧 ⇒ 只 WARN（cargo 会先重编），不阻塞开窗', () => {
  const inspection = inspectRuntimeBinaries(
    {
      resolution: resolutionFixture([mainDir, stack2Dir]),
      binaryName: 'xihe-runtime.exe',
      sourceNewest: { path: `${projectRoot}/packages/runtime/src/main.rs`, mtimeMs: 1_700_000_000_000 },
    },
    fakeFs({
      [`${mainDir}/debug/xihe-runtime.exe`]: 1_699_900_000_000,
      [`${stack2Dir}/debug/xihe-runtime.exe`]: 1_699_950_000_000,
    }),
  );
  assert.equal(inspection.status, 'stale');
  assert.equal(inspection.severity, 'WARN');
  assert.equal(inspection.blocking, false);
  assert.match(inspection.message, /older than runtime sources/);
  assert.equal(inspection.newest.label, 'stack-2');
  assert.equal(inspection.staleByMs, 50_000_000);
});

test('T13 解析成功但没有 debug binary ⇒ missing，只 INFO（第一次 cargo run 本来就会建）', () => {
  const inspection = inspectRuntimeBinaries(
    {
      resolution: resolutionFixture([mainDir]),
      binaryName: 'xihe-runtime.exe',
      sourceNewest: { path: `${projectRoot}/packages/runtime/src/main.rs`, mtimeMs: 1 },
    },
    fakeFs({}),
  );
  assert.equal(inspection.status, 'missing');
  assert.equal(inspection.severity, null);
  assert.equal(inspection.blocking, false);
  assert.match(inspection.reason, /first `cargo run` will build it/);
});

test('T14 入参缺失 fail-fast（不静默当成"没问题"）', () => {
  assert.throws(() => inspectRuntimeBinaries({ binaryName: 'xihe-runtime.exe' }), /resolution/);
  assert.throws(() => inspectRuntimeBinaries({ resolution: resolutionFixture([mainDir]) }), /binaryName/);
});
