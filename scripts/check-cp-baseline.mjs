#!/usr/bin/env node
/**
 * BL-368 (2026-11-06): explicit CP known-baseline gate.
 *
 * CP's full suite is red on two *known* baseline items while a larger refactor is pending. `validate`
 * must still be a binary answer, so this script compares the latest surefire reports against
 * `scripts/cp-known-baseline.json`:
 *   - every failure/error is in the baseline  ⇒ exit 0 (known red, still a usable gate)
 *   - any failure/error is NOT in the baseline ⇒ exit 1, listing the new ones
 *   - a baseline entry that is now green      ⇒ WARN (delete it; the baseline only shrinks)
 *   - a `reviewBy` date in the past           ⇒ exit 1 (a baseline may not live forever)
 *
 * This is deliberately **not** wired into `mvn test` (that would swallow Maven output). The workflow
 * is: run `mvn -o test` (it fails on the known items), then run the independent `test:cp:baseline`
 * task, which reads the reports Maven just wrote.
 *
 * Strict rules (also enforced by review, not just by this script):
 *   1. the baseline may only shrink; adding an entry requires a reason in the commit message;
 *   2. once an entry turns green it must be deleted (this script WARNs);
 *   3. `reviewBy` is mandatory; an expired entry fails the gate.
 *
 * Usage:
 *   node scripts/check-cp-baseline.mjs                       # read default reports + baseline
 *   node scripts/check-cp-baseline.mjs --reports <dir>       # alternate surefire-reports dir
 *   node scripts/check-cp-baseline.mjs --baseline <file>     # alternate baseline JSON
 *   node scripts/check-cp-baseline.mjs --json                # {ok, newFailures, greenEntries, expired}
 *
 * Exit codes: 0 = all failures covered by a fresh baseline; 1 = new failure or expired baseline;
 * 2 = usage / missing reports or baseline (a gate that cannot read evidence must never pass).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPORTS = path.join(ROOT, 'packages/control-plane/target/surefire-reports');
const DEFAULT_BASELINE = path.join(ROOT, 'scripts/cp-known-baseline.json');
const FAILURE_LINE = /^([\w.$]+) -- Time elapsed: .*<<< (FAILURE|ERROR)!$/;

function parseArgs(argv) {
  const out = {
    reports: DEFAULT_REPORTS,
    baseline: DEFAULT_BASELINE,
    json: false,
    allowStaleReports: false,
    headTime: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--reports') out.reports = path.resolve(argv[++i]);
    else if (argv[i] === '--baseline') out.baseline = path.resolve(argv[++i]);
    else if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--allow-stale-reports') out.allowStaleReports = true;
    else if (argv[i] === '--head-time') out.headTime = Number(argv[++i]);
  }
  return out;
}

/** Newest mtime (seconds) among surefire reports, or null when the directory has none. */
export function newestReportTime(reportsDir) {
  if (!fs.existsSync(reportsDir)) return null;
  let newest = null;
  for (const name of fs.readdirSync(reportsDir)) {
    if (!name.endsWith('.txt')) continue;
    const { mtimeMs } = fs.statSync(path.join(reportsDir, name));
    if (newest === null || mtimeMs > newest) newest = mtimeMs;
  }
  return newest === null ? null : Math.floor(newest / 1000);
}

/**
 * Reports produced *before* the current HEAD cannot describe it: a stale run would report failures the
 * working tree no longer has (or miss ones it now has), and the verdict would be about the wrong tree.
 * 2026-11-06: this exact case produced a false "1 new failure" verdict right after a baseline shrink.
 */
export function reportsAreStale({ reportsDir, headTime }) {
  if (!headTime) return { stale: false };
  const newest = newestReportTime(reportsDir);
  if (newest === null) return { stale: false };
  if (newest >= headTime) return { stale: false };
  return {
    stale: true,
    reportTime: newest,
    headTime,
    hint: 'surefire reports predate HEAD; run `mise run test:cp` first (or pass --allow-stale-reports)',
  };
}

/** Surefire .txt shape: one `Test set:` header, then `<test id> -- Time elapsed: ... <<< FAILURE!`. */
export function parseSurefireFailures(reportsDir) {
  if (!fs.existsSync(reportsDir)) return null;
  const failures = [];
  for (const name of fs.readdirSync(reportsDir)) {
    if (!name.endsWith('.txt')) continue;
    const file = path.join(reportsDir, name);
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = FAILURE_LINE.exec(line.trim());
      if (!match) continue;
      failures.push({ test: match[1], kind: match[2] === 'FAILURE' ? 'fail' : 'error', file: name });
    }
  }
  return failures;
}

function todayIso() {
  // Local calendar date, not UTC: `reviewBy` is an operator-facing date and a +08 evening run must
  // not look like yesterday (the UTC slice would expire a baseline up to 8h early).
  return new Date().toLocaleDateString('sv-SE');
}

export function checkBaseline({ reportsDir, baselineFile, today = todayIso() }) {
  const failures = parseSurefireFailures(reportsDir);
  if (failures === null) {
    return { ok: false, code: 2, error: `no surefire reports at ${reportsDir} (run mvn -o test first)` };
  }
  let baseline;
  try {
    baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  } catch (error) {
    return { ok: false, code: 2, error: `cannot read baseline ${baselineFile}: ${error.message}` };
  }
  const entries = Array.isArray(baseline.entries) ? baseline.entries : [];
  const expired = entries.filter((entry) => !entry.reviewBy || entry.reviewBy < today);
  const key = (test, kind) => `${test}#${kind}`;
  const known = new Map(entries.map((entry) => [key(entry.test, entry.kind), entry]));
  const newFailures = failures.filter((failure) => !known.has(key(failure.test, failure.kind)));
  const seen = new Set(failures.map((failure) => key(failure.test, failure.kind)));
  const greenEntries = entries
    .filter((entry) => !seen.has(key(entry.test, entry.kind)))
    .map((entry) => entry.test);
  const ok = expired.length === 0 && newFailures.length === 0;
  return { ok, code: ok ? 0 : 1, failures, entries, newFailures, greenEntries, expired, today };
}

function headCommitTime() {
  try {
    const raw = execFileSync('git', ['log', '-1', '--format=%ct', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function main(argv) {
  const args = parseArgs(argv);
  const headTime = args.headTime ?? headCommitTime();
  const staleness = reportsAreStale({ reportsDir: args.reports, headTime });
  if (staleness.stale && !args.allowStaleReports) {
    console.error(`[cp-baseline] STALE: ${staleness.hint}`);
    console.error(`[cp-baseline]   newest report=${new Date(staleness.reportTime * 1000).toLocaleString()} `
      + `head commit=${new Date(staleness.headTime * 1000).toLocaleString()}`);
    process.exitCode = 2;
    return;
  }
  const result = checkBaseline({ reportsDir: args.reports, baselineFile: args.baseline });
  if (result.error) {
    console.error(`[cp-baseline] ERROR: ${result.error}`);
    process.exitCode = 2;
    return;
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      ok: result.ok,
      today: result.today,
      failures: result.failures,
      newFailures: result.newFailures,
      greenEntries: result.greenEntries,
      expired: result.expired.map((entry) => entry.test),
    })}\n`);
  } else {
    if (result.expired.length > 0) {
      for (const entry of result.expired) {
        console.error(`[cp-baseline] EXPIRED: ${entry.test} (reviewBy=${entry.reviewBy || '(missing)'})`);
      }
    }
    for (const failure of result.newFailures) {
      console.error(`[cp-baseline] NEW ${failure.kind.toUpperCase()}: ${failure.test} (${failure.file})`);
    }
    for (const test of result.greenEntries) {
      console.warn(`[cp-baseline] WARN: ${test} is green now — delete it from cp-known-baseline.json`);
    }
    const covered = result.failures.length - result.newFailures.length;
    console.log(`[cp-baseline] ${covered}/${result.failures.length} failure(s) covered; `
      + `${result.newFailures.length} new; ${result.expired.length} expired — `
      + `baseline ${result.ok ? 'OK' : 'FAILED'} (exit ${result.ok ? 0 : 1})`);
  }
  process.exitCode = result.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
