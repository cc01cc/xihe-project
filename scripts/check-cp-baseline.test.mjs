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
