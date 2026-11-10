#!/usr/bin/env node
// BL-572 / D-816：覆盖判据的三种结论必须都被钉住 —— 尤其是「没有分母」不许算绿。
// 跑法：`node --test scripts/l2/lib/coverage-verdict.test.mjs`（已挂进 `mise run test:cli`）。

import assert from 'node:assert/strict';
import test from 'node:test';

import { EXIT_CODES, coverageVerdict, coverageVerdictNote } from './coverage-verdict.mjs';

const names = (...items) => items;

test('expected=0 ⇒ NOT_EVALUATED + exit 2（空输入绝不算绿）', () => {
  const verdict = coverageVerdict({ expected: 0, missing: names(), unexpected: names(), duplicates: names() });
  assert.equal(verdict, 'NOT_EVALUATED');
  assert.equal(EXIT_CODES[verdict], 2);
  // 这三行是 BL-572 的原始缺陷形态：三项皆空曾被当成 PASS。
  assert.notEqual(verdict, 'PASS');
});

test('expected 缺失/NaN/负数 ⇒ NOT_EVALUATED（没分母的其它写法同样不判绿）', () => {
  for (const expected of [undefined, null, Number.NaN, -1]) {
    assert.equal(coverageVerdict({ expected, missing: [], unexpected: [], duplicates: [] }), 'NOT_EVALUATED');
  }
});

test('missing 非空 ⇒ FAIL + exit 1', () => {
  const verdict = coverageVerdict({ expected: 3, missing: names('A'), unexpected: names(), duplicates: names() });
  assert.equal(verdict, 'FAIL');
  assert.equal(EXIT_CODES[verdict], 1);
});

test('unexpected 非空 ⇒ FAIL（多跑出来的类也是漂移）', () => {
  assert.equal(coverageVerdict({ expected: 3, missing: [], unexpected: names('X'), duplicates: [] }), 'FAIL');
});

test('duplicates 非空 ⇒ FAIL（同一个类出现在两个分片）', () => {
  assert.equal(coverageVerdict({ expected: 3, missing: [], unexpected: [], duplicates: names('A') }), 'FAIL');
});

test('有分母且三项皆空 ⇒ PASS + exit 0', () => {
  const verdict = coverageVerdict({ expected: 3, missing: [], unexpected: [], duplicates: [] });
  assert.equal(verdict, 'PASS');
  assert.equal(EXIT_CODES[verdict], 0);
});

test('NOT_EVALUATED 必须自己说明原因（不许静默当成通过）', () => {
  const note = coverageVerdictNote('NOT_EVALUATED', { expected: 0, missing: [], unexpected: [], duplicates: [] });
  assert.match(note, /NOT_EVALUATED/);
  assert.match(note, /exit 2/);
});
