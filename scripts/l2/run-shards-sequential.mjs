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
//   --root 默认取当前 checkout 的 `git rev-parse --show-toplevel`（BL-362：不再硬编码某个 worktree，
//   也不再在目录不存在时"只打印一行 fatal 就继续"——启动自检会直接退出并打印实测值）。
// Env: JAVA_TOOL_OPTIONS must carry the heap cap (e.g. -Xmx4g); this script does not set it silently.
// Env: 需要能启动 shell 的环境（BL-362）。spawn 用 `shell: true`；若在受限沙箱里仍然 ENOENT，
//   脚本会打印可操作提示（改在宿主跑 / 或只跑 mvn 后用 solo-rerun.mjs 消费既有结果），
//   并把 `spawnError` 写进结果 JSON，而不是让整轮静默失败。
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

// BL-362 (bug 1): 不再硬编码一个可能已不存在的 worktree —— 不传 --root 时取当前 checkout 的
// `git rev-parse --show-toplevel`。实际使用的 ROOT 一律打印（见下方 preflight）：量错树比跑不起来更危险。
function readToplevel() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
const ROOT_ARG = flag('root', null);
const ROOT = resolve(ROOT_ARG ?? readToplevel() ?? process.cwd());
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

// BL-362: 启动自检 —— 下面三件事任何一件不成立，后面的测量都不可能是证据。上一版在 ROOT 不存在时
// 只打印 `fatal: cannot change to …` 然后继续跑（最坏情况：量到了错误的树）。现在直接退出，
// 并把**实测值**打印出来，让人一眼看出错在哪。
function preflightFail(message, details) {
  console.error('[preflight] ' + message);
  for (const line of details) console.error('  ' + line);
  process.exit(2);
}
if (!existsSync(ROOT)) {
  preflightFail('--root 指向的目录不存在，拒绝测量', [
    'root    = ' + ROOT,
    'rootArg = ' + (ROOT_ARG ?? '(未传，取自 git rev-parse --show-toplevel)'),
    'cwd     = ' + process.cwd(),
    'usage   = node scripts/l2/run-shards-sequential.mjs --root <存在的 checkout> ...',
  ]);
}
if (!existsSync(MODULE)) {
  preflightFail('ROOT 下没有 packages/control-plane，拒绝测量', ['root = ' + ROOT, 'module = ' + MODULE]);
}
const HEAD_PROBE = git('rev-parse', 'HEAD');
if (!/^[0-9a-f]{7,40}$/u.test(HEAD_PROBE)) {
  preflightFail('git rev-parse HEAD 不可用，拒绝测量（无法命名被测的树）', [
    'root = ' + ROOT,
    'git  = ' + HEAD_PROBE,
  ]);
}
console.log('[preflight] root=' + ROOT + ' head=' + HEAD_PROBE + ' module=' + MODULE + ' python=' + (PYTHON ?? '(none)'));

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

// BL-362 (bug 2): 旧写法 spawn(ComSpec, ['/c', command]) 在受限环境里会 ENOENT（cmd.exe 明明存在却
// 起不来），且失败没有任何可操作提示。现在用 shell: true 让 Node 自己选 shell；spawn 失败会记进
// 结果（exitCode=-1 + spawnError）并打印可操作提示，不静默、也不伪装成"测试失败"。
function run(command, logPath) {
  const startedAt = Date.now();
  return new Promise((done) => {
    const child = spawn(command, { cwd: MODULE, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let settled = false;
    const elapsed = () => Number(((Date.now() - startedAt) / 1000).toFixed(1));
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      done(payload);
    };
    child.stdout.on('data', (buffer) => chunks.push(buffer));
    child.stderr.on('data', (buffer) => chunks.push(buffer));
    child.on('error', (error) => {
      const text = Buffer.concat(chunks).toString('utf8');
      const hint = error.code === 'ENOENT'
        ? 'spawn 失败（ENOENT）：本脚本需要能启动 shell 的环境。请在宿主 PowerShell/Terminal 运行；'
          + '若在受限沙箱内，请在沙箱外执行，或只跑 mvn 后用 solo-rerun.mjs 消费既有结果。'
        : 'spawn 失败：' + error.message;
      writeFileSync(logPath, text + '\n[spawn-error] ' + hint + '\n', 'utf8');
      console.error('[spawn] ' + hint);
      finish({
        command,
        exitCode: -1,
        wallSeconds: elapsed(),
        logPath,
        spawnError: { code: error.code ?? null, message: error.message, hint },
      });
    });
    child.on('close', (code) => {
      const text = Buffer.concat(chunks).toString('utf8');
      writeFileSync(logPath, text, 'utf8');
      finish({ command, exitCode: code, wallSeconds: elapsed(), logPath });
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
