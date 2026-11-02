#!/usr/bin/env node
// L2 Phase 3: dynamic measurement for the two numbers Phase 3 is judged on.
//
//   1. how many times a Spring context was actually CREATED, and under which cache key
//      (authoritative: the framework's own cache DEBUG lines - not an inference);
//   2. per-test-class durations and Spring startup seconds (the shard packing input).
//
// WHY the log, not the source: the static census (context-census.mjs) can only give the number of
// distinct keys. The quantity Phase 3 must move is CREATIONS, and only the runtime knows how many
// times a dirty close forced a re-start. Enable the logger when running a shard:
//
//   mvn -o test -Dtest=A,B,C \
//     -Dlogging.level.org.springframework.test.context.cache=DEBUG > shard.log 2>&1
//
// USAGE
//   node scripts/l2/context-timings.mjs --log shard.log [--report-dir <surefire dir>] [--json]

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : null;
};

const LOG = flag('log');
const REPORT_DIR = flag('report-dir');
const OUT = flag('out');
const asJson = argv.includes('--json');

if (!LOG && !REPORT_DIR) {
  console.error('usage: context-timings.mjs --log <maven log> [--report-dir <surefire dir>] [--out <json>] [--json]');
  process.exit(2);
}

// ---------------------------------------------------------------- log parsing

const STORED = /Storing ApplicationContext \[(.+?)\] in cache under key \[(.+)\]$/;
const CLOSED_DIRTY = /Closing ApplicationContext .*since it is marked as .*dirty/i;
const STATS = /Spring test ApplicationContext cache statistics: (.*)$/;
// The framework's own counter: one line per test event, `missCount` is exactly the creation count.
const CACHE_SUMMARY = /DefaultContextCache@[0-9a-f]+ size = (\d+), maxSize = \d+, contextUsageCount = \d+, parentContextCount = \d+, hitCount = (\d+), missCount = (\d+), failureCount = \d+/;
const STARTED = /Started \w+ in ([\d.]+) seconds/;

/** A cache key's readable identity: profile + webEnvironment + the count of customizers. */
function keyLabel(raw) {
  const profiles = /activeProfiles=\[([^\]]*)\]/.exec(raw);
  const web = /webEnvironment=(\w+)/.exec(raw);
  const declarers = /dynamicPropertySourceMethods=\[([^\]]*)\]/.exec(raw);
  const customizers = (raw.match(/ContextCustomizer/g) ?? []).length;
  const label = [];
  if (profiles && profiles[1].trim()) label.push(`profiles=${profiles[1].replace(/\s+/g, '')}`);
  if (web) label.push(`web=${web[1]}`);
  if (declarers && declarers[1].trim()) {
    label.push(`dynamic=${declarers[1].split(',').filter((part) => part.trim()).length}`);
  }
  label.push(`customizers=${customizers}`);
  return label.join(' ');
}

let creations = 0;
let dirtyCloses = 0;
const keyCounts = new Map();
const startedSeconds = [];
let statsLine = null;
// The framework's own summary is the AUTHORITATIVE count: one line per test event, and its
// `missCount` is exactly the number of context creations. Spring Test logs it at DEBUG for the cache
// logger (`Spring test ApplicationContext cache statistics: [DefaultContextCache@… size = N, …,
// hitCount = H, missCount = M, …]`). `STORED` lines are optional extra detail (per-key attribution).
let cacheSummary = null;

if (LOG) {
  const lines = readFileSync(LOG, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const stored = STORED.exec(line);
    if (stored) {
      creations += 1;
      const label = keyLabel(stored[2]);
      keyCounts.set(label, (keyCounts.get(label) ?? 0) + 1);
      continue;
    }
    if (CLOSED_DIRTY.test(line)) {
      dirtyCloses += 1;
      continue;
    }
    const summaryMatch = CACHE_SUMMARY.exec(line);
    if (summaryMatch) {
      // Keep the LAST occurrence: the counter is cumulative for the JVM.
      cacheSummary = {
        size: Number(summaryMatch[1]),
        hitCount: Number(summaryMatch[2]),
        missCount: Number(summaryMatch[3]),
      };
      continue;
    }
    const stats = STATS.exec(line);
    if (stats) {
      statsLine = stats[1].trim();
      continue;
    }
    const started = STARTED.exec(line);
    if (started) {
      startedSeconds.push(Number(started[1]));
    }
  }
}

// Prefer the framework summary; fall back to counting "Storing …" lines when the logger was not enabled.
const creationsAuthoritative = cacheSummary ? cacheSummary.missCount : creations;

// ------------------------------------------------------------ surefire parsing

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.xml')) out.push(full);
  }
  return out;
}

const ATTRIBUTE = (text, name) => {
  const match = new RegExp(`${name}="([^"]*)"`).exec(text);
  return match ? match[1] : null;
};

let suites = [];
if (REPORT_DIR) {
  suites = walk(resolve(REPORT_DIR)).map((file) => {
    const head = readFileSync(file, 'utf8').slice(0, 4000);
    const suiteTag = /<testsuite\b[^>]*>/.exec(head);
    const tag = suiteTag ? suiteTag[0] : '';
    const name = ATTRIBUTE(tag, 'name') ?? '';
    return {
      suite: name,
      simpleClass: name.split('.').pop(),
      seconds: Number(ATTRIBUTE(tag, 'time') ?? 0),
      tests: Number(ATTRIBUTE(tag, 'tests') ?? 0),
      failures: Number(ATTRIBUTE(tag, 'failures') ?? 0),
      errors: Number(ATTRIBUTE(tag, 'errors') ?? 0),
      skipped: Number(ATTRIBUTE(tag, 'skipped') ?? 0),
    };
  });
}

suites.sort((a, b) => b.seconds - a.seconds);
const suiteSeconds = suites.reduce((sum, suite) => sum + suite.seconds, 0);

const report = {
  log: LOG ? resolve(LOG) : null,
  reportDir: REPORT_DIR ? resolve(REPORT_DIR) : null,
  contexts: {
    creations: creationsAuthoritative,
    creationsFromStoredLines: creations,
    cacheSummary,
    dirtyCloses,
    distinctKeys: keyCounts.size,
    keys: [...keyCounts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count),
    frameworkStatsLine: statsLine,
    springStartedSeconds: {
      samples: startedSeconds.length,
      sum: Number(startedSeconds.reduce((sum, value) => sum + value, 0).toFixed(3)),
      max: startedSeconds.length ? Math.max(...startedSeconds) : 0,
    },
  },
  surefire: {
    suites: suites.length,
    tests: suites.reduce((sum, suite) => sum + suite.tests, 0),
    failures: suites.reduce((sum, suite) => sum + suite.failures, 0),
    errors: suites.reduce((sum, suite) => sum + suite.errors, 0),
    skipped: suites.reduce((sum, suite) => sum + suite.skipped, 0),
    suiteSecondsSum: Number(suiteSeconds.toFixed(1)),
    slowest: suites.slice(0, 12),
    byClass: suites.map(({ simpleClass, seconds }) => ({ simpleClass, seconds })),
  },
};

if (OUT) {
  writeFileSync(resolve(OUT), JSON.stringify(report, null, 2), 'utf8');
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log('# Context timings (dynamic)');
if (LOG) {
  console.log('');
  console.log(`log ........................ ${report.log}`);
  console.log(`context CREATIONS .......... ${report.contexts.creations}   <-- framework missCount: the number Phase 3 must move`);
  console.log(`dirty closes ............... ${dirtyCloses}`);
  console.log(`distinct cache keys ........ ${keyCounts.size}`);
  console.log(`spring 'Started ... in' .... ${report.contexts.springStartedSeconds.samples} samples, `
    + `sum ${report.contexts.springStartedSeconds.sum}s`);
  if (statsLine) console.log(`framework stats ............ ${statsLine}`);
  console.log('');
  console.log('## Creations per cache key (the re-creation offenders)');
  console.log('');
  console.log('| creations | key |');
  console.log('|---|---|');
  for (const key of report.contexts.keys.slice(0, 15)) {
    console.log(`| ${key.count} | ${key.label} |`);
  }
}
if (REPORT_DIR) {
  console.log('');
  console.log(`surefire ................... ${suites.length} suites / ${report.surefire.tests} tests / `
    + `${report.surefire.suiteSecondsSum}s (sum of suite times)`);
  console.log(`failures+errors ............ ${report.surefire.failures}+${report.surefire.errors} `
    + `(skipped ${report.surefire.skipped})`);
  console.log('');
  console.log('## Slowest classes');
  console.log('');
  console.log('| seconds | class | tests |');
  console.log('|---|---|---|');
  for (const suite of report.surefire.slowest) {
    console.log(`| ${suite.seconds} | ${suite.simpleClass} | ${suite.tests} |`);
  }
}
