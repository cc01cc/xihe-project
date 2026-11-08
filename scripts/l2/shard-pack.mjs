#!/usr/bin/env node
// L2 Phase 3 step 3: shard rebalancing by MEASURED PER-CLASS duration (greedy LPT), not by package.
//
// WHY: the Phase 2 split grouped whole packages; `chat` alone carried 311 s and landed in shard A, so A
// ran 84 classes fewer but 40 s longer. Package grouping cannot see that one class costs 40 s. LPT
// (longest processing time first, assign to the currently lighter bin) keeps the two bins within one
// class of each other and is optimal-ish for two machines.
//
// INPUT (any one of):
//   --profile <surefire-profile.json>   the harness profile (profile.suites[].{simpleClass,timeSeconds})
//   --report-dir <dir>                  a surefire XML directory (TEST-*.xml with <testsuite time>)
//   --from-json <file>                  the output of context-timings.mjs (--out), whose
//                                       `.surefire.byClass` is {simpleClass, seconds}[]
//
// OUTPUT (into --out dir, default one/.tmp/plan-l2-p3):
//   shard-a-classes.txt / shard-b-classes.txt   one top-level class name per line (runner input)
//   shard-split.json                            per-class seconds, bin sums, delta, balance verdict
//
// USAGE
//   node scripts/l2/shard-pack.mjs --profile one/.tmp/plan-eff-l2/surefire-profile.json
//   node scripts/l2/shard-pack.mjs --report-dir <target/surefire-reports-shard-a> --json

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : null;
};

const PROFILE = flag('profile');
const REPORT_DIR = flag('report-dir');
const FROM_JSON = flag('from-json');
const OUT_DIR = resolve(
  flag('out') ?? process.env.XH_L2_OUT ?? join(process.cwd(), '.tmp', 'plan-l2-p3'),
);
const TARGET_DELTA = Number(flag('target-delta') ?? 10);
const asJson = argv.includes('--json');

if (!PROFILE && !REPORT_DIR && !FROM_JSON) {
  console.error('usage: shard-pack.mjs (--profile <surefire-profile.json> | --report-dir <dir> | '
    + '--from-json <context-timings.json>) [--out <dir>] [--target-delta 10] [--json]');
  process.exit(2);
}

function fromProfile(file) {
  const data = JSON.parse(readFileSync(resolve(file), 'utf8'));
  const suites = data.suites ?? data.profile?.suites ?? [];
  return suites.map((suite) => ({
    simpleClass: suite.simpleClass,
    seconds: Number(suite.timeSeconds ?? suite.seconds ?? 0),
  }));
}

function fromTimingsJson(file) {
  const data = JSON.parse(readFileSync(resolve(file), 'utf8'));
  return (data.surefire?.byClass ?? []).map((entry) => ({
    simpleClass: entry.simpleClass,
    seconds: Number(entry.seconds ?? 0),
  }));
}

function fromReportDir(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.xml')) files.push(full);
    }
  };
  walk(resolve(dir));
  return files.map((file) => {
    const head = readFileSync(file, 'utf8').slice(0, 4000);
    const tag = /<testsuite\b[^>]*>/.exec(head)?.[0] ?? '';
    const name = /name="([^"]*)"/.exec(tag)?.[1] ?? '';
    const seconds = Number(/time="([^"]*)"/.exec(tag)?.[1] ?? 0);
    return { simpleClass: name.split('.').pop(), seconds };
  });
}

const source = PROFILE ? fromProfile(PROFILE) : REPORT_DIR ? fromReportDir(REPORT_DIR) : fromTimingsJson(FROM_JSON);
const classes = source
  .filter((entry) => entry.simpleClass && Number.isFinite(entry.seconds))
  .sort((a, b) => b.seconds - a.seconds);

if (!classes.length) {
  console.error('no classes found in the input');
  process.exit(1);
}

// Greedy LPT: heaviest first, always into the lighter bin.
const bins = [
  { name: 'a', seconds: 0, classes: [] },
  { name: 'b', seconds: 0, classes: [] },
];
for (const entry of classes) {
  const target = bins[0].seconds <= bins[1].seconds ? bins[0] : bins[1];
  target.classes.push(entry);
  target.seconds += entry.seconds;
}

const total = bins[0].seconds + bins[1].seconds;
const delta = Math.abs(bins[0].seconds - bins[1].seconds);
const heaviest = classes[0];

const result = {
  generatedAt: new Date().toISOString(),
  source: PROFILE ? resolve(PROFILE) : REPORT_DIR ? resolve(REPORT_DIR) : resolve(FROM_JSON),
  classes: classes.length,
  totalSecondsSum: Number(total.toFixed(1)),
  shards: bins.map((bin) => ({
    name: bin.name,
    classes: bin.classes.length,
    seconds: Number(bin.seconds.toFixed(1)),
    top: bin.classes.slice(0, 6).map((entry) => `${entry.simpleClass} (${entry.seconds}s)`),
  })),
  deltaSeconds: Number(delta.toFixed(1)),
  targetDeltaSeconds: TARGET_DELTA,
  balanced: delta <= TARGET_DELTA,
  heavyClass: { simpleClass: heaviest.simpleClass, seconds: heaviest.seconds },
  // A single class heavier than the target delta means no packing can meet the target.
  deltaFloorSeconds: Number(heaviest.seconds.toFixed(1)),
};

mkdirSync(OUT_DIR, { recursive: true });
for (const bin of bins) {
  const file = join(OUT_DIR, `shard-${bin.name}-classes.txt`);
  writeFileSync(file, `${bin.classes.map((entry) => entry.simpleClass).join('\n')}\n`, 'utf8');
}
writeFileSync(join(OUT_DIR, 'shard-split.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

console.log('# Shard pack (greedy LPT by measured per-class duration)');
console.log('');
console.log(`classes .................... ${result.classes}`);
console.log(`sum of per-class seconds ... ${result.totalSecondsSum}s`);
for (const shard of result.shards) {
  console.log(`shard ${shard.name} .................... ${shard.classes} classes / ${shard.seconds}s`);
}
console.log(`delta ...................... ${result.deltaSeconds}s  (target <= ${TARGET_DELTA}s) `
  + `${result.balanced ? 'OK' : 'MISS'}`);
console.log(`heaviest single class ...... ${result.heavyClass.simpleClass} (${result.heavyClass.seconds}s) `
  + '= lower bound for any 2-shard delta');
console.log('');
console.log(`written: ${join(OUT_DIR, 'shard-a-classes.txt')}, ${join(OUT_DIR, 'shard-b-classes.txt')}, `
  + join(OUT_DIR, 'shard-split.json'));
if (!existsSync(join(OUT_DIR, 'shard-a-classes.txt'))) {
  process.exit(1);
}
