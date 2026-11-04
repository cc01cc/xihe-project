#!/usr/bin/env node
// Reads the two shard surefire report directories + their logs and prints the authoritative summary:
// per-shard tests / failures / errors / skipped, the failing class list, the union coverage check, and
// whether the framework's context cache summary is present (creations) in a non-instrumented run.
//
// USAGE node scripts/l2/shard-report.mjs [--root <worktree>] [--log-dir <dir>] [--json <file>]

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};

const ROOT = resolve(flag('root', 'H:/zeogit/one/A03-xihe/.worktrees/plan-l2-phase3'));
const LOG_DIR = resolve(flag('log-dir', 'H:/zeogit/one/.tmp/plan-l2-p3'));
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
const expected = expectedRaw?.classes ?? expectedRaw?.classNames ?? [];
const expectedSet = new Set(expected);
const ran = shards.flatMap((shard) => shard.suites.map((suite) => suite.cls));
const ranSet = new Set(ran);
const duplicates = [...new Set(ran.filter((name, index) => ran.indexOf(name) !== index))];
const coverage = {
  expected: expectedSet.size,
  ran: ranSet.size,
  missing: [...expectedSet].filter((name) => !ranSet.has(name)).sort(),
  unexpected: [...ranSet].filter((name) => !expectedSet.has(name)).sort(),
  duplicates,
};
coverage.ok = coverage.missing.length === 0 && coverage.unexpected.length === 0 && coverage.duplicates.length === 0;

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
  creationsAvailable: shards.every((shard) => shard.cacheStatsLines > 0),
};

if (JSON_OUT) writeFileSync(resolve(JSON_OUT), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

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
console.log(`=== coverage ok=${coverage.ok} expected=${coverage.expected} ran=${coverage.ran} `
  + `missing=${coverage.missing.length} unexpected=${coverage.unexpected.length} duplicates=${coverage.duplicates.length}`);
if (coverage.missing.length) console.log(`    missing: ${coverage.missing.slice(0, 10).join(', ')}`);
if (coverage.unexpected.length) console.log(`    unexpected: ${coverage.unexpected.slice(0, 10).join(', ')}`);
console.log(`=== creations available from a clean run: ${report.creationsAvailable}`);
