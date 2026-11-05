#!/usr/bin/env node
// L2 authoritative run, memory-constrained variant: the two shards run SEQUENTIALLY (not in
// parallel), one JVM at a time, so a single 4 GiB heap fits the machine's ~6 GB free RAM.
//
// WHAT THIS IS AND IS NOT
//   is:  per-shard wall clock, the failure set, the coverage union, head stability;
//   is NOT: a parallel wall clock. The 2-shard parallel figure (301 s, 2026-11-02) still stands and
//           must never be recomputed as "A + B" — sequential and parallel are different measurements.
//
// Creations: the framework logs `Spring test ApplicationContext cache statistics: [DefaultContextCache@…
// size = N … missCount = M]` in the shard logs. We read the LAST line of each shard and sum the
// missCounts. That is the same counter used by the instrumented runs, so the two-shard sum is directly
// comparable with the 2026-11-02 baseline (A 67 + B 66 = 133).
//
// HARDENING (BL-326, 2026-11-05 — a whole L2 round was invalidated by exactly the hole these close):
//   1. ISOLATED BUILD DIR. Every shard compiles into `--target-root/<runTag>-<shard>` (default under
//      H:/zeotmp). The main checkout's `target/` is never used: a sibling lane's probe had compiled a
//      "gate removed" class into it, and a round that ran `surefire:test` on those stale classes looked
//      like 34 real failures. The compile now happens HERE, per shard, so build == what was measured.
//   2. PROVENANCE GATE. `git status --short` must be empty before the compile and before EACH shard
//      (else fail-fast: a dirty tree means "I cannot tell you which tree I measured").
//   3. RECORDED PROVENANCE. The result JSON carries `rev-parse HEAD` before/after, the dirty snapshot
//      (`.local/` evidence writes excluded so a measuring lane stays "clean"; they stay in `rawDirty`),
//      each shard's targetDir, the compile exit code, and the `build-info.properties` commit/dirty when
//      the build emits it. A round that cannot answer "which tree, which sha, dirty?" is not evidence.
//   4. GUARD LITERAL. After compiling, a load-bearing literal (default `instance-admin`, the hard gate
//      that the BL-326 probe removed) must exist inside the compiled class; absent ⇒ fail-fast, because
//      build and source have drifted apart.
//
// USAGE
//   node scripts/l2/run-shards-sequential.mjs [--root <worktree>] [--out <dir>] [--run-tag <tag>]
//                                            [--target-root <dir>] [--guard-literal <s>]...
//                                            [--allow-dirty] [--compile-only]
// Env: JAVA_TOOL_OPTIONS must carry the heap cap (e.g. -Xmx4g); this script does not set it silently.
// The old contract ("caller compiled first, runner only runs surefire") is gone on purpose: the caller's
// compile is precisely what could not be trusted.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const flags = (name) => {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === `--${name}` && index + 1 < argv.length) values.push(argv[index + 1]);
  }
  return values;
};

const ROOT = resolve(flag('root', 'H:/zeogit/one/A03-xihe/.worktrees/plan-l2-phase3'));
const OUT = resolve(flag('out', 'H:/zeogit/one/.tmp/plan-l2-p3'));
const TARGET_ROOT = resolve(flag('target-root', 'H:/zeotmp'));
const RUN_TAG = flag('run-tag', `l2-${new Date().toISOString().replace(/[:.]/gu, '-')}`);
const ALLOW_DIRTY = argv.includes('--allow-dirty');
const COMPILE_ONLY = argv.includes('--compile-only');
const GUARD_LITERALS = flags('guard-literal').length ? flags('guard-literal') : ['instance-admin'];
const GUARD_CLASS = flag('guard-class', 'com/cc01cc/p/xihe/cp/service/AgentPrincipalService.class');
const MODULE = join(ROOT, 'packages/control-plane');
const PYTHON = [
  join(ROOT, 'packages/agent/.venv/Scripts/python.exe'),
  'H:/zeogit/one/A03-xihe/packages/agent/.venv/Scripts/python.exe',
].find((candidate) => existsSync(candidate));

mkdirSync(OUT, { recursive: true });

function git(...args) {
  try {
    return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim();
  } catch (error) {
    return `GIT-FAILED: ${error.message}`;
  }
}

function provenance(label) {
  const raw = git('status', '--short', '--untracked-files=all').split('\n').filter(Boolean);
  const paths = raw.map((line) => line.replace(/^.{2}\s+/u, '').trim());
  // BL-326: evidence/bookkeeping writes under `.local/` must not make a measurement round look dirty —
  // the lane writes evidence while it measures, so counting `.local/` would make every round "cannot
  // name its tree". They are still kept verbatim in `rawDirty` for audit (nothing is hidden).
  const isLocalNoise = (path) => path === '.local' || path.startsWith('.local/') || path.startsWith('.local\\');
  const dirty = paths.filter((path) => !isLocalNoise(path));
  return {
    label,
    head: git('rev-parse', 'HEAD'),
    // JSON 里只放路径（Lead 2026-11-06 定死 `afterDirty: ["docs/…"]` 的形状）；原始 `M`/`??` 前缀另存
    // 供控制台报错用，避免把 git 状态码混进机器可读字段。
    dirty,
    localNoise: paths.filter(isLocalNoise),
    rawDirty: raw,
    at: new Date().toISOString(),
  };
}

function assertClean(snapshot) {
  if (ALLOW_DIRTY || (snapshot.rawDirty ?? snapshot.dirty).length === 0) return;
  console.error(`[preflight] ${snapshot.label}: working tree is DIRTY (${(snapshot.rawDirty ?? snapshot.dirty).length} entries) — refusing to measure.`);
  for (const line of (snapshot.rawDirty ?? snapshot.dirty).slice(0, 10)) console.error(`  ${line}`);
  throw new Error(`dirty working tree at ${snapshot.label}; a round that cannot name the tree it measured is not evidence`);
}

function run(command, logPath) {
  const startedAt = Date.now();
  return new Promise((done) => {
    const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'sh';
    const child = spawn(shell, ['/c', command], { cwd: MODULE, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', (buffer) => chunks.push(buffer));
    child.stderr.on('data', (buffer) => chunks.push(buffer));
    child.on('close', (code) => {
      const text = Buffer.concat(chunks).toString('utf8');
      writeFileSync(logPath, text, 'utf8');
      done({ command, exitCode: code, wallSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)), logPath });
    });
  });
}

function guardCheck(targetDir) {
  const classFile = join(targetDir, 'classes', GUARD_CLASS);
  if (!existsSync(classFile)) {
    return { ok: false, reason: `guard class missing: ${classFile}`, literals: GUARD_LITERALS };
  }
  const bytes = readFileSync(classFile);
  const missing = GUARD_LITERALS.filter((literal) => !bytes.includes(Buffer.from(literal, 'utf8')));
  return { ok: missing.length === 0, reason: missing.length ? `literals absent: ${missing.join(',')}` : 'ok', literals: GUARD_LITERALS, classFile };
}

function buildInfo(targetDir) {
  const file = join(targetDir, 'classes', 'META-INF', 'build-info.properties');
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const pick = (key) => new RegExp(`^${key}=(.*)$`, 'mu').exec(text)?.[1]?.trim() ?? null;
  return { commit: pick('build.commit') ?? pick('git.commit.id') ?? pick('commit'), dirty: pick('build.dirty') ?? pick('git.dirty'), builtAt: pick('build.time') ?? pick('git.build.time') };
}

function lastCacheStats(logPath) {
  const text = readFileSync(logPath, 'utf8');
  const matches = [...text.matchAll(/DefaultContextCache@[0-9a-f]+ size = (\d+), maxSize = \d+, contextUsageCount = \d+, parentContextCount = \d+, hitCount = (\d+), missCount = (\d+), failureCount = (\d+)/gu)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  return { size: Number(last[1]), hitCount: Number(last[2]), missCount: Number(last[3]) };
}

function suitesOf(reportDir) {
  if (!existsSync(reportDir)) return [];
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.xml')) files.push(full);
    }
  };
  walk(reportDir);
  return files.map((file) => {
    const head = readFileSync(file, 'utf8').slice(0, 4000);
    const tag = /<testsuite\b[^>]*>/u.exec(head)?.[0] ?? '';
    const attr = (name) => {
      const found = new RegExp(`${name}="([^"]*)"`, 'u').exec(tag);
      return found ? found[1] : '0';
    };
    const name = attr('name');
    return {
      simpleClass: name.split('.').pop(),
      fullClass: name,
      tests: Number(attr('tests')),
      failures: Number(attr('failures')),
      errors: Number(attr('errors')),
      skipped: Number(attr('skipped')),
    };
  });
}

const before = provenance('before');
assertClean(before);

const shards = [];
for (const shard of ['a', 'b']) {
  const targetDir = join(TARGET_ROOT, `${RUN_TAG}-${shard}`);
  mkdirSync(targetDir, { recursive: true });
  // Forward slashes and no quoting: `cmd /c` mangles nested double quotes ("-Dprop=H:\a\b" breaks).
  const targetArg = targetDir.replaceAll('\\', '/');
  console.log(`[shard ${shard}] compile -> ${targetDir}`);
  const compile = await run(
    `mvn -o -q -Dxihe.target.dir=${targetArg} clean test-compile`,
    join(OUT, `compile-shard-${shard}.log`),
  );
  const guard = guardCheck(targetDir);
  const info = buildInfo(targetDir);
  const shardProvenance = provenance(`shard-${shard}`);
  assertClean(shardProvenance);
  if (compile.exitCode !== 0) {
    throw new Error(`shard ${shard}: test-compile failed (exit ${compile.exitCode}); see ${compile.logPath}`);
  }
  if (!guard.ok) {
    throw new Error(`shard ${shard}: guard literal check failed (${guard.reason}); build/source have drifted — refusing to measure`);
  }
  if (COMPILE_ONLY) {
    shards.push({ shard, targetDir, compile, guard, buildInfo: info, provenance: shardProvenance, skippedRun: true, exitCode: null, wallSeconds: 0, tests: 0, failures: 0, cache: null, suites: [] });
    console.log(`[shard ${shard}] compile+guard OK (compile-only) guard=${guard.literals.join(',')} buildInfo=${info ? `${info.commit ?? '?'}/${info.dirty ?? '?'}` : 'absent'}`);
    continue;
  }
  console.log(`[shard ${shard}] start (targetDir=${targetDir})`);
  const command = `mvn -o surefire:test -Pl2-shard-${shard} -Dxihe.target.dir=${targetArg}`
    + (PYTHON ? ` -Dxihe.context.python=${PYTHON.replaceAll('\\', '/')}` : '');
  const result = await run(command, join(OUT, `clean-shard-${shard}.log`));
  result.reportDir = join(targetDir, `surefire-reports-shard-${shard}`);
  result.suites = suitesOf(result.reportDir);
  result.tests = result.suites.reduce((sum, suite) => sum + suite.tests, 0);
  result.failures = result.suites.reduce((sum, suite) => sum + suite.failures + suite.errors, 0);
  result.cache = lastCacheStats(result.logPath);
  result.targetDir = targetDir;
  result.compile = compile;
  result.guard = guard;
  result.buildInfo = info;
  result.provenance = shardProvenance;
  shards.push(result);
  console.log(`[shard ${shard}] exit=${result.exitCode} wall=${result.wallSeconds}s `
    + `tests=${result.tests} failures+errors=${result.failures} missCount=${result.cache?.missCount ?? 'n/a'} `
    + `guard=${guard.ok ? 'ok' : 'FAIL'} head=${shardProvenance.head.slice(0, 8)} dirty=${shardProvenance.dirty.length}`);
}

// 自测钩子（仅验证"收尾脏"分支）：在最后一个 shard 断言之后、after 快照之前写一个临时文件，
// 精确复现 2026-11-06 的真实故障窗口（第三方在收尾时刻写 docs）。生产用法不传这个参数。
const DIRTY_PROBE = flag('after-dirty-probe', null);
if (DIRTY_PROBE) {
  writeFileSync(join(ROOT, DIRTY_PROBE), `after-dirty probe ${new Date().toISOString()}\n`, 'utf8');
  console.log(`[self-test] wrote probe ${DIRTY_PROBE} (simulates a third-party write in the after window)`);
}
const after = provenance('after');
// BL-326 收尾缺陷修复（2026-11-06，Lead 批准）：`after` 变脏 **不再抛错丢弃整轮证据**。
// 判据是"measure 时刻 clean"：before / shard-a / shard-b 三处断言仍致命（脏了就不测），但收尾那一刻
// 若第三方在冻结窗口写了文件（2026-11-06 实测：跑完最后一例后被 lane 写入 3 个 docs 文件），
// 正确做法是把 `ok` 降级为 false、把脏清单记进 `afterDirty`、**保留两 shard 全部测量数据**，
// 让归档读者自己判断；而不是把 13 分钟的有效测量换成一句异常。
const afterDirty = after.dirty;
if (afterDirty.length > 0) {
  console.error(`[after] working tree became DIRTY after the last measurement (${afterDirty.length} entries) — evidence kept, ok=false`);
  for (const line of afterDirty.slice(0, 10)) console.error(`  ${line}`);
}

const { computeExpectedTestClasses } = await import('./lib/test-class-set.mjs');
const expected = computeExpectedTestClasses({ repoRoot: ROOT });
// `computeExpectedTestClasses` 的返回形状随 helper 演进而变：现在是
// `{ repoRoot, sourceFileCount, expected: [...classNames], excludedAbstract, ... }`，
// 早期版本直接返回数组 / Set。这里按优先级依次取 `classes` → `expected` → 自身，
// 再归一成名字数组：形状变化不得把 coverage 判定打成
// `TypeError: object is not iterable`（2026-11-03 实测：helper 一变，L2 测量完好但判定整段丢失，
// 且 `Object.keys()` 兜底会把 `repoRoot`/`sourceFileCount` 当成测试类 —— 兜底必须拒绝这种误判）。
const expectedNames = (() => {
  const candidates = [expected?.classes, expected?.expected, expected];
  for (const value of candidates) {
    if (Array.isArray(value)) return value;
    if (value instanceof Set) return [...value];
  }
  throw new Error(
    'run-shards-sequential: cannot derive expected test-class names from '
      + `computeExpectedTestClasses() (keys: ${Object.keys(expected ?? {}).join(',')}); `
      + 'refusing to guess — a wrong guess would silently corrupt the coverage judgement',
  );
})();
const expectedSet = new Set(expectedNames);
const ran = shards.flatMap((shard) => shard.suites.map((suite) => suite.fullClass));
const ranSet = new Set(ran);
const duplicates = ran.filter((name, index) => ran.indexOf(name) !== index);
const coverage = {
  expected: expectedSet.size,
  ran: ranSet.size,
  missing: [...expectedSet].filter((name) => !ranSet.has(name)).sort(),
  unexpected: [...ranSet].filter((name) => !expectedSet.has(name)).sort(),
  duplicates: [...new Set(duplicates)].sort(),
};
coverage.ok = coverage.missing.length === 0 && coverage.unexpected.length === 0 && coverage.duplicates.length === 0;

const headStable = before.head === after.head && shards.every((shard) => shard.provenance?.head === before.head);
// `ok` 的语义（Lead 2026-11-06 定死）：**测量有效性**，不是"测试全绿"。
//   ok = 收尾无脏 + coverage 完整 + 头稳定 + 每个 shard 的守卫通过。
//   测试失败（基线红）由 `failingSuites` 表达，**不影响 ok**——否则每个含基线红的轮次都会被误判为无效。
const roundOk = afterDirty.length === 0
  && (COMPILE_ONLY || coverage.ok) // --compile-only 不跑测试，coverage 天然为 false：那是模式差异，不是测量缺陷
  && headStable
  && shards.every((shard) => shard.guard?.ok !== false);
const summary = {
  ok: roundOk,
  afterDirty,
  generatedAt: new Date().toISOString(),
  mode: 'sequential (memory-constrained; parallel wall clock NOT re-measured)',
  runTag: RUN_TAG,
  root: ROOT,
  targetRoot: TARGET_ROOT,
  // legacy field kept for old readers; now a real sha instead of `ref: refs/heads/develop`
  head: before.head,
  // BL-326: the three keys a reader needs to answer "which tree was measured?", mirrored at the top
  // level because that is where consumers look first. They are mirrors, not new measurements:
  // `headCommit` === `head`; `dirty` === the (non-`.local/`) before/after union captured below;
  // `targetDir` === `targetRoot` (each shard's own dir stays in `shards[].targetDir`).
  headCommit: before.head,
  targetDir: TARGET_ROOT,
  dirty: afterDirty,
  headStable,
  provenance: { before, after, shards: shards.map((shard) => shard.provenance) },
  javaToolOptions: process.env.JAVA_TOOL_OPTIONS ?? null,
  instrumented: false,
  compileOnly: COMPILE_ONLY,
  shards: shards.map((shard) => ({
    shard: shard.shard,
    exitCode: shard.exitCode,
    wallSeconds: shard.wallSeconds,
    tests: shard.tests,
    failuresAndErrors: shard.failures,
    cache: shard.cache,
    targetDir: shard.targetDir,
    reportDir: shard.reportDir,
    logPath: shard.logPath,
    compile: shard.compile && { exitCode: shard.compile.exitCode, wallSeconds: shard.compile.wallSeconds, logPath: shard.compile.logPath },
    guard: shard.guard,
    buildInfo: shard.buildInfo,
  })),
  creationsShardSum: shards.reduce((sum, shard) => sum + (shard.cache?.missCount ?? 0), 0),
  totalTests: shards.reduce((sum, shard) => sum + shard.tests, 0),
  coverage,
  failingSuites: shards.flatMap((shard) => shard.suites
    .filter((suite) => suite.failures + suite.errors + suite.skipped > 0)
    .map((suite) => ({ shard: shard.shard, ...suite }))),
};

writeFileSync(join(OUT, 'clean-sequential-result.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  runTag: RUN_TAG,
  ok: roundOk,
  afterDirty: afterDirty.length,
  head: summary.head,
  headStable,
  shards: summary.shards.map(({ shard, wallSeconds, tests, failuresAndErrors, targetDir }) => ({ shard, wallSeconds, tests, failuresAndErrors, targetDir })),
  creationsShardSum: summary.creationsShardSum,
  coverage: { ok: coverage.ok, expected: coverage.expected, ran: coverage.ran, missing: coverage.missing.length, unexpected: coverage.unexpected.length, duplicates: coverage.duplicates.length },
}, null, 1));

// 退出码：测量无效（收尾脏 / coverage 不全 / 头不稳 / 守卫失败）⇒ 非零；基线红不影响退出码。
process.exit(roundOk ? 0 : 1);
