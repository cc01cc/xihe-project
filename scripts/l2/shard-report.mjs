#!/usr/bin/env node
// Reads the two shard surefire report directories + their logs and prints the authoritative summary:
// per-shard tests / failures / errors / skipped, the failing class list, the union coverage check, and
// whether the framework's context cache summary is present (creations) in a non-instrumented run.
//
// USAGE node scripts/l2/shard-report.mjs [--root <worktree>] [--log-dir <dir>] [--json <file>]

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { coverageVerdict, coverageVerdictNote, EXIT_CODES } from './lib/coverage-verdict.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};

/**
 * git toplevel —— 从任意子目录调用都要拿到它（此前 `execFileSync` 缺 import，抛 `ReferenceError`
 * 被 `catch {}` 吞掉，于是恒返回 null、`ROOT` 静默退回 `process.cwd()`：从子目录跑会读错根且没有任何提示）。
 * 取不到时才回落调用方 cwd，并且必须把原因打出来（MUST NOT 静默降级）。
 */
function readToplevel() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
  } catch (error) {
    console.error(`[shard-report] git rev-parse --show-toplevel failed; falling back to cwd (${process.cwd()}): ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

const ROOT = resolve(flag('root') ?? readToplevel() ?? process.cwd());
const LOG_DIR = resolve(
  flag('log-dir') ?? process.env.XH_L2_OUT ?? join(process.cwd(), '.tmp', 'plan-l2-p3'),
);
const JSON_OUT = flag('json', null);
const MODULE = join(ROOT, 'packages/control-plane');

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
    const tag = /<testsuite\b[^>]*>/.exec(head)?.[0] ?? '';
    const attr = (name) => {
      const found = new RegExp(`${name}="([^"]*)"`).exec(tag);
      return found ? found[1] : '0';
    };
    return {
      cls: attr('name').split('.').pop(),
      fullClass: attr('name'),
      tests: Number(attr('tests')),
      failures: Number(attr('failures')),
      errors: Number(attr('errors')),
      skipped: Number(attr('skipped')),
      time: Number(attr('time')),
    };
  });
}

const shards = ['a', 'b'].map((shard) => {
  const suites = suitesOf(join(MODULE, `target/surefire-reports-shard-${shard}`));
  const logPath = join(LOG_DIR, `clean-shard-${shard}.log`);
  let cacheStats = 0;
  let startedLines = 0;
  let oom = 0;
  if (existsSync(logPath)) {
    const text = readFileSync(logPath, 'utf8');
    cacheStats = (text.match(/DefaultContextCache@/g) ?? []).length;
    startedLines = (text.match(/Started \w+ in [\d.]+ seconds/g) ?? []).length;
    oom = (text.match(/OutOfMemoryError/g) ?? []).length;
  }
  return {
    shard,
    suites,
    tests: suites.reduce((sum, suite) => sum + suite.tests, 0),
    failures: suites.reduce((sum, suite) => sum + suite.failures, 0),
    errors: suites.reduce((sum, suite) => sum + suite.errors, 0),
    skipped: suites.reduce((sum, suite) => sum + suite.skipped, 0),
    seconds: Number(suites.reduce((sum, suite) => sum + suite.time, 0).toFixed(1)),
    failing: suites.filter((suite) => suite.failures + suite.errors + suite.skipped > 0),
    logPath,
    cacheStatsLines: cacheStats,
    startedLines,
    outOfMemory: oom,
  };
});

const { computeExpectedTestClasses } = await import('./lib/test-class-set.mjs');
const expectedRaw = computeExpectedTestClasses({ repoRoot: ROOT });
// BL-572 的第二层缺陷（本门改完才暴露）：helper 的契约字段是 `expected`，而这里读的是
// `classes` / `classNames` —— 两个都不存在 ⇒ **分母恒为 0**，覆盖判据从构造上就是空转。
// 三条字段都认，但一条都读不到就**说出来并以 exit 2 收场**，不再静默退化成空数组。
const EXPECTED_FIELDS = ['expected', 'classes', 'classNames'];
const expectedFieldName = EXPECTED_FIELDS.find((name) => Array.isArray(expectedRaw?.[name])) ?? null;
if (!expectedFieldName) {
  console.error('[shard-report] BUG: computeExpectedTestClasses() 没返回 expected[]/classes[]/classNames[] —— '
    + '覆盖判据没有分母（这不是通过，是脚本契约破了）');
  process.exitCode = 2;
}
const expected = expectedFieldName ? expectedRaw[expectedFieldName] : [];
const expectedSet = new Set(expected);
const ran = shards.flatMap((shard) => shard.suites.map((suite) => suite.fullClass));
const ranSet = new Set(ran);
const duplicates = [...new Set(ran.filter((name, index) => ran.indexOf(name) !== index))];
const coverage = {
  expected: expectedSet.size,
  expectedField: expectedFieldName,
  ran: ranSet.size,
  missing: [...expectedSet].filter((name) => !ranSet.has(name)).sort(),
  unexpected: [...ranSet].filter((name) => !expectedSet.has(name)).sort(),
  duplicates,
};
// BL-572 / D-816：判据硬门。此前是
//   `coverage.ok = missing==0 && unexpected==0 && duplicates==0`
// —— `expected==0`（报告目录不存在、源码根指错）时**恒为 true**，于是空输入印 `coverage ok=true`
// 且整个脚本没有一处 exit ⇒ 永远 exit 0。这是「声称结论却不阻断」的假绿门形态。
// 现在：没有分母 ⇒ NOT_EVALUATED/exit 2；有分母但覆盖不全 ⇒ FAIL/exit 1；齐全才 PASS/exit 0。
const verdict = coverageVerdict(coverage);
coverage.verdict = verdict;
coverage.ok = verdict === 'PASS';

const report = {
  generatedAt: new Date().toISOString(),
  mode: 'sequential (memory-constrained) — parallel wall clock NOT measured here',
  instrumented: false,
  shards: shards.map((shard) => ({
    shard: shard.shard,
    suites: shard.suites.length,
    tests: shard.tests,
    failures: shard.failures,
    errors: shard.errors,
    skipped: shard.skipped,
    suiteSeconds: shard.seconds,
    cacheStatsLines: shard.cacheStatsLines,
    startedLines: shard.startedLines,
    outOfMemory: shard.outOfMemory,
    failing: shard.failing,
  })),
  totals: {
    tests: shards.reduce((sum, shard) => sum + shard.tests, 0),
    failures: shards.reduce((sum, shard) => sum + shard.failures, 0),
    errors: shards.reduce((sum, shard) => sum + shard.errors, 0),
    skipped: shards.reduce((sum, shard) => sum + shard.skipped, 0),
  },
  coverage,
  verdict,
  exitCode: EXIT_CODES[verdict],
  creationsAvailable: shards.every((shard) => shard.cacheStatsLines > 0),
};

if (JSON_OUT) writeFileSync(resolve(JSON_OUT), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`=== root: ${ROOT}`);
for (const shard of report.shards) {
  console.log(`=== shard ${shard.shard}: suites=${shard.suites} tests=${shard.tests} `
    + `F=${shard.failures} E=${shard.errors} S=${shard.skipped} suiteSeconds=${shard.suiteSeconds}`);
  if (shard.outOfMemory) console.log(`    OOM markers: ${shard.outOfMemory}`);
  console.log(`    cacheStatsLines=${shard.cacheStatsLines} startedLines=${shard.startedLines}`);
  for (const suite of shard.failing) {
    console.log(`    ${suite.cls}  tests=${suite.tests} F=${suite.failures} E=${suite.errors} S=${suite.skipped}`);
  }
}
console.log(`=== totals: tests=${report.totals.tests} F=${report.totals.failures} E=${report.totals.errors} S=${report.totals.skipped}`);
console.log(`=== coverage ${verdict} expected=${coverage.expected} ran=${coverage.ran} `
  + `missing=${coverage.missing.length} unexpected=${coverage.unexpected.length} duplicates=${coverage.duplicates.length}`);
console.log(`    ${coverageVerdictNote(verdict, coverage)}`);
if (coverage.missing.length) console.log(`    missing: ${coverage.missing.slice(0, 10).join(', ')}`);
if (coverage.unexpected.length) console.log(`    unexpected: ${coverage.unexpected.slice(0, 10).join(', ')}`);
console.log(`=== creations available from a clean run: ${report.creationsAvailable}`);

// 用 exitCode 而不是 process.exit()：后者在 Windows 管道上可能截断尚未 flush 的 stdout/report。
// 结论与退出码同源（EXIT_CODES），保证「印了什么」和「返回什么」不会各说一套。
process.exitCode = EXIT_CODES[verdict];
