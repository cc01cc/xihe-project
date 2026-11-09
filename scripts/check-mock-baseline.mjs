#!/usr/bin/env node
/**
 * PLAN-0735 / BL-164: compare the mock-lane report against the registered baseline.
 *
 * Why: Playwright exits 0 while skipped tests simply do not run; a "green" run can
 * silently shrink the suite (a spec turned fixme/skip) or absorb new failures as flaky.
 * This reads the JSON report `test:mock` wrote, compares counts and skip titles with
 * `packages/ui/e2e/mock-baseline.json`, and fails with `E_MOCK_BASELINE_DRIFT` on any
 * change (or `--allow-drift` to accept it deliberately).
 *
 * Usage: node scripts/check-mock-baseline.mjs [--report <json>] [--baseline <json>] [--allow-drift]
 * Exit 0 = match; 1 = drift; 2 = missing/unparsable inputs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {
    report: path.resolve(HERE, "../../../packages/ui/e2e/.mock-report.json"),
    baseline: path.resolve(HERE, "../../../packages/ui/e2e/mock-baseline.json"),
    allowDrift: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--report") out.report = path.resolve(argv[++i]);
    else if (arg === "--baseline") out.baseline = path.resolve(argv[++i]);
    else if (arg === "--allow-drift") out.allowDrift = true;
    else throw new Error("unknown argument: " + arg);
  }
  return out;
}

function readJson(file, label) {
  if (!fs.existsSync(file)) {
    throw new Error(`missing ${label}: ${file}`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot parse ${label} ${file}: ${error.message}`);
  }
}

/** Normalise a skip title: drop Playwright's retry prefix and padding. */
function normalizeTitle(value) {
  return String(value ?? "").replace(/^\[retry\]#?\d+\s*/, "").trim();
}

export function summarizeReport(report) {
  const stats = report?.stats ?? {};
  const expected = Math.trunc(Number(stats.expected ?? 0));
  const failed = Math.trunc(Number(stats.unexpected ?? 0));
  const flaky = Math.trunc(Number(stats.flaky ?? 0));
  const skipped = Math.trunc(Number(stats.skipped ?? 0));
  const skipNames = [];
  const walk = (suite) => {
    for (const spec of suite?.specs ?? []) {
      const ran = (spec?.tests ?? []).some((test) => (test?.results ?? []).length > 0);
      if (!ran) skipNames.push(normalizeTitle(spec?.title));
    }
    for (const child of suite?.suites ?? []) walk(child);
  };
  for (const file of report?.suites ?? []) walk(file);
  return { expected, failed, flaky, skipped, skipNames };
}

export function compareWithBaseline(summary, baseline) {
  const problems = [];
  const counts = baseline?.counts ?? {};
  for (const field of ["expected", "skipped", "failed", "flaky"]) {
    const expectedValue = Math.trunc(Number(counts[field] ?? 0));
    if (summary[field] !== expectedValue) {
      problems.push(`${field}: baseline=${expectedValue} actual=${summary[field]}`);
    }
  }
  const registered = new Set((baseline?.skipNames ?? []).map(normalizeTitle));
  const actual = new Set(summary.skipNames);
  const unregistered = [...actual].filter((name) => !registered.has(name));
  const retired = [...registered].filter((name) => !actual.has(name));
  for (const name of unregistered) problems.push(`skip unregistered: ${name}`);
  for (const name of retired) problems.push(`skip no longer present: ${name}`);
  return { problems, unregistered, retired };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[check-mock-baseline] ${error.message}`);
    return 2;
  }
  let report;
  let baseline;
  try {
    report = readJson(options.report, "report");
    baseline = readJson(options.baseline, "baseline");
  } catch (error) {
    console.error(`[check-mock-baseline] ${error.message}`);
    return 2;
  }
  const summary = summarizeReport(report);
  const { problems, unregistered, retired } = compareWithBaseline(summary, baseline);
  const line =
    `[check-mock-baseline] expected=${summary.expected} skipped=${summary.skipped} `
    + `failed=${summary.failed} flaky=${summary.flaky} skips=${summary.skipNames.length}`;
  console.log(line);
  if (problems.length > 0) {
    if (options.allowDrift) {
      console.log(`[check-mock-baseline] drift accepted (--allow-drift): ${problems.length} item(s)`);
      for (const problem of problems) console.log(`  drift: ${problem}`);
      return 0;
    }
    console.error(`E_MOCK_BASELINE_DRIFT: ${problems.length} difference(s) vs ${options.baseline}`);
    for (const problem of problems) console.error(`  drift: ${problem}`);
    console.error(`  update e2e/mock-baseline.json only after triage; use --allow-drift to accept deliberately`);
    return 1;
  }
  console.log("[check-mock-baseline] OK");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
