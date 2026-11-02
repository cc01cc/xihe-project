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
// USAGE
//   node scripts/l2/run-shards-sequential.mjs [--root <worktree>] [--out <dir>]
// Env: JAVA_TOOL_OPTIONS must carry the heap cap (e.g. -Xmx4g); this script does not set it silently.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};

const ROOT = resolve(flag('root', 'H:/zeogit/one/A03-xihe/.worktrees/plan-l2-phase3'));
const OUT = resolve(flag('out', 'H:/zeogit/one/.tmp/plan-l2-p3'));
const MODULE = join(ROOT, 'packages/control-plane');
const PYTHON = [
  join(ROOT, 'packages/agent/.venv/Scripts/python.exe'),
  'H:/zeogit/one/A03-xihe/packages/agent/.venv/Scripts/python.exe',
].find((candidate) => existsSync(candidate));

mkdirSync(OUT, { recursive: true });

function runOne(shard) {
  const logPath = join(OUT, `clean-shard-${shard}.log`);
  const command = `mvn -o surefire:test -Pl2-shard-${shard}`
    + (PYTHON ? ` -Dxihe.context.python=${PYTHON}` : '');
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
      done({
        shard,
        command,
        exitCode: code,
        wallSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
        logPath,
        reportDir: join(MODULE, `target/surefire-reports-shard-${shard}`),
      });
    });
  });
}

function lastCacheStats(logPath) {
  const text = readFileSync(logPath, 'utf8');
  const matches = [...text.matchAll(/DefaultContextCache@[0-9a-f]+ size = (\d+), maxSize = \d+, contextUsageCount = \d+, parentContextCount = \d+, hitCount = (\d+), missCount = (\d+), failureCount = (\d+)/g)];
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
    const tag = /<testsuite\b[^>]*>/.exec(head)?.[0] ?? '';
    const attr = (name) => {
      const found = new RegExp(`${name}="([^"]*)"`).exec(tag);
      return found ? found[1] : '0';
    };
    const name = attr('name');
    return {
      simpleClass: name.split('.').pop(),
      tests: Number(attr('tests')),
      failures: Number(attr('failures')),
      errors: Number(attr('errors')),
      skipped: Number(attr('skipped')),
    };
  });
}

const head = (() => {
  try {
    return readFileSync(join(ROOT, '.git', 'HEAD'), 'utf8').trim();
  } catch {
    return null;
  }
})();

const shards = [];
for (const shard of ['a', 'b']) {
  console.log(`[shard ${shard}] start`);
  const result = await runOne(shard);
  result.cache = lastCacheStats(result.logPath);
  result.suites = suitesOf(result.reportDir);
  result.tests = result.suites.reduce((sum, suite) => sum + suite.tests, 0);
  result.failures = result.suites.reduce((sum, suite) => sum + suite.failures + suite.errors, 0);
  shards.push(result);
  console.log(`[shard ${shard}] exit=${result.exitCode} wall=${result.wallSeconds}s `
    + `tests=${result.tests} failures+errors=${result.failures} missCount=${result.cache?.missCount ?? 'n/a'}`);
}

const { computeExpectedTestClasses } = await import('file:///H:/zeogit/one/.tmp/plan-eff-l2/lib/test-class-set.mjs');
const expected = computeExpectedTestClasses({ repoRoot: ROOT });
const expectedSet = new Set(expected.classes ?? expected);
const ran = shards.flatMap((shard) => shard.suites.map((suite) => suite.simpleClass));
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

const summary = {
  generatedAt: new Date().toISOString(),
  mode: 'sequential (memory-constrained; parallel wall clock NOT re-measured)',
  head,
  javaToolOptions: process.env.JAVA_TOOL_OPTIONS ?? null,
  instrumented: false,
  shards: shards.map((shard) => ({
    shard: shard.shard,
    exitCode: shard.exitCode,
    wallSeconds: shard.wallSeconds,
    tests: shard.tests,
    failuresAndErrors: shard.failures,
    cache: shard.cache,
    reportDir: shard.reportDir,
    logPath: shard.logPath,
  })),
  creationsShardSum: shards.reduce((sum, shard) => sum + (shard.cache?.missCount ?? 0), 0),
  totalTests: shards.reduce((sum, shard) => sum + shard.tests, 0),
  coverage,
  failingSuites: shards.flatMap((shard) => shard.suites
    .filter((suite) => suite.failures + suite.errors + suite.skipped > 0)
    .map((suite) => ({ shard: shard.shard, ...suite }))),
};

writeFileSync(join(OUT, 'clean-sequential-result.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ shards: summary.shards.map(({ shard, wallSeconds, tests, failuresAndErrors }) => ({ shard, wallSeconds, tests, failuresAndErrors })), creationsShardSum: summary.creationsShardSum, coverage: { ok: coverage.ok, expected: coverage.expected, ran: coverage.ran, missing: coverage.missing.length, unexpected: coverage.unexpected.length, duplicates: coverage.duplicates.length } }, null, 1));
