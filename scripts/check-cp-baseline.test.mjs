import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// BL-368: three contract cases for the explicit CP baseline gate.
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-cp-baseline.mjs');

function fixture({ report, baseline }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-baseline-'));
  const reports = path.join(root, 'reports');
  fs.mkdirSync(reports, { recursive: true });
  fs.writeFileSync(path.join(reports, 'com.acme.FooTest.txt'), report);
  const baselineFile = path.join(root, 'baseline.json');
  fs.writeFileSync(baselineFile, JSON.stringify(baseline));
  return { reports, baselineFile };
}

const reportFor = (tests) => [
  'Test set: com.acme.FooTest',
  `Tests run: ${tests.length}, Failures: ${tests.length}, Errors: 0, Skipped: 0`,
  ...tests.map((name) => `${name} -- Time elapsed: 0.01 s <<< FAILURE!`),
  'org.opentest4j.AssertionFailedError: boom',
  '',
].join('\n');

const run = ({ reports, baselineFile }) =>
  spawnSync(process.execPath, [SCRIPT, '--reports', reports, '--baseline', baselineFile], {
    encoding: 'utf8',
  });

test('all failures covered by a fresh baseline exits 0', () => {
  const fx = fixture({
    report: reportFor(['com.acme.FooTest.known']),
    baseline: {
      entries: [
        { test: 'com.acme.FooTest.known', kind: 'fail', reason: 'known', reviewBy: '2999-01-01' },
      ],
    },
  });
  const out = run(fx);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /1\/1 failure\(s\) covered/u);
});

test('a failure not in the baseline exits 1 and is named', () => {
  const fx = fixture({
    report: reportFor(['com.acme.FooTest.known', 'com.acme.FooTest.newOne']),
    baseline: {
      entries: [
        { test: 'com.acme.FooTest.known', kind: 'fail', reason: 'known', reviewBy: '2999-01-01' },
      ],
    },
  });
  const out = run(fx);
  assert.equal(out.status, 1, out.stdout);
  assert.match(out.stderr, /NEW FAIL: com\.acme\.FooTest\.newOne/u);
});

test('an expired reviewBy exits 1 even if every failure is covered', () => {
  const fx = fixture({
    report: reportFor(['com.acme.FooTest.known']),
    baseline: {
      entries: [
        { test: 'com.acme.FooTest.known', kind: 'fail', reason: 'known', reviewBy: '2000-01-01' },
      ],
    },
  });
  const out = run(fx);
  assert.equal(out.status, 1, out.stdout);
  assert.match(out.stderr, /EXPIRED: com\.acme\.FooTest\.known/u);
});

// BL-368 follow-up (2026-11-06): stale surefire reports must not produce a verdict about a tree that no
// longer exists. A run that predates HEAD reported a failure that had already been fixed, and the gate
// answered "1 new failure" — a false red about the wrong tree.
test('stale surefire reports (older than HEAD) exit 2', () => {
  const fx = fixture({
    report: reportFor(['com.acme.FooTest.known']),
    baseline: {
      entries: [
        { test: 'com.acme.FooTest.known', kind: 'fail', reason: 'known', reviewBy: '2999-01-01' },
      ],
    },
  });
  const futureHead = Math.floor(Date.now() / 1000) + 3600;
  const out = spawnSync(
    process.execPath,
    [SCRIPT, '--reports', fx.reports, '--baseline', fx.baselineFile, '--head-time', String(futureHead)],
    { encoding: 'utf8' },
  );
  assert.equal(out.status, 2);
  assert.match(out.stderr, /STALE:/);
});

test('--allow-stale-reports is an explicit escape hatch', () => {
  const fx = fixture({
    report: reportFor(['com.acme.FooTest.known']),
    baseline: {
      entries: [
        { test: 'com.acme.FooTest.known', kind: 'fail', reason: 'known', reviewBy: '2999-01-01' },
      ],
    },
  });
  const futureHead = Math.floor(Date.now() / 1000) + 3600;
  const out = spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--reports',
      fx.reports,
      '--baseline',
      fx.baselineFile,
      '--head-time',
      String(futureHead),
      '--allow-stale-reports',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(out.status, 0);
  assert.match(out.stdout, /baseline OK/);
});

// BL-370 audit follow-up: report health is observational and never changes the exit code.
function healthFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-health-'));
  const reports = path.join(root, 'reports');
  fs.mkdirSync(reports);
  const baselineFile = path.join(root, 'baseline.json');
  fs.writeFileSync(baselineFile, JSON.stringify({ entries: [] }));
  const healthFile = path.join(root, 'cp-report-health.json');
  const write = (name, summary) =>
    fs.writeFileSync(path.join(reports, `${name}.txt`), [
      `Test set: ${name}`,
      summary,
      '',
    ].join('\n'));
  const run = () => spawnSync(process.execPath, [
    SCRIPT, '--reports', reports, '--baseline', baselineFile,
    '--health-file', healthFile, '--allow-stale-reports',
  ], { encoding: 'utf8' });
  return { reports, write, run, healthFile };
}

test('report health: a zero-test class warns but keeps exit 0', () => {
  const fx = healthFixture();
  fx.write('com.acme.HealthTest', 'Tests run: 2, Failures: 0, Errors: 0, Skipped: 0');
  assert.equal(fx.run().status, 0, 'first run records a baseline without warnings');
  fx.write('com.acme.EmptyTest', 'Tests run: 0, Failures: 0, Errors: 0, Skipped: 0');
  const out = fx.run();
  assert.equal(out.status, 0, 'health warnings never change the exit code');
  assert.match(out.stderr, /zero-test class: com\.acme\.EmptyTest/u);
});

test('report health: a dropping report count warns', () => {
  const fx = healthFixture();
  fx.write('com.acme.OneTest', 'Tests run: 1, Failures: 0, Errors: 0, Skipped: 0');
  fx.write('com.acme.TwoTest', 'Tests run: 1, Failures: 0, Errors: 0, Skipped: 0');
  assert.equal(fx.run().status, 0);
  fs.rmSync(path.join(fx.reports, 'com.acme.TwoTest.txt'));
  const out = fx.run();
  assert.equal(out.status, 0);
  assert.match(out.stderr, /report count dropped: 2 → 1/u);
});

test('report health: a skipped jump warns', () => {
  const fx = healthFixture();
  fx.write('com.acme.SkipTest', 'Tests run: 3, Failures: 0, Errors: 0, Skipped: 0');
  assert.equal(fx.run().status, 0);
  fx.write('com.acme.SkipTest', 'Tests run: 3, Failures: 0, Errors: 0, Skipped: 3');
  const out = fx.run();
  assert.equal(out.status, 0);
  assert.match(out.stderr, /skipped jumped: 0 → 3/u);
});
