#!/usr/bin/env node
/**
 * PLAN-0632 D32-11 parity test: the packaged `ports.json` must equal the dev stack's ports.
 *
 * Why this exists: the packaged launcher is Java and cannot import `scripts/lib/stack-ports.mjs`,
 * so its port knowledge is a rendered artifact. A rendered artifact that nobody asserts against
 * its source is a copy, and copies drift. This test is the assertion.
 *
 * Run: `node --test scripts/pkg/ports-json.test.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STACK_ID, STACK_IDS, deriveStack } from '../lib/stack-ports.mjs';
import { PORTS_JSON_KEYS, parsePortsJson, renderPortsJson } from './ports-json.mjs';

test('every registered stack renders its own ports and round-trips', () => {
  for (const stackId of STACK_IDS) {
    const derived = deriveStack(stackId);
    const parsed = parsePortsJson(renderPortsJson(stackId));
    assert.equal(parsed.stackId, stackId);
    for (const key of PORTS_JSON_KEYS) {
      assert.equal(parsed.ports[key], derived.ports[key], `${stackId}.${key}`);
    }
  }
});

test('render is byte-stable for the same stack (no timestamps in the artifact)', () => {
  assert.equal(renderPortsJson(DEFAULT_STACK_ID), renderPortsJson(DEFAULT_STACK_ID));
});

test('default stack-1 ports match the packaged layout the launcher expects', () => {
  const parsed = parsePortsJson(renderPortsJson(DEFAULT_STACK_ID));
  assert.deepEqual(parsed.ports, { ui: 12630, cp: 12631, agent: 12632, runtime: 12633, postgres: 12634 });
});

test('parse rejects a missing port instead of defaulting it', () => {
  const document = JSON.parse(renderPortsJson(DEFAULT_STACK_ID));
  delete document.ports.postgres;
  assert.throws(() => parsePortsJson(JSON.stringify(document)), /postgres/);
});

test('parse rejects an unexpected extra port key', () => {
  const document = JSON.parse(renderPortsJson(DEFAULT_STACK_ID));
  document.ports.extra = 1;
  assert.throws(() => parsePortsJson(JSON.stringify(document)), /unexpected port keys/);
});

test('parse rejects non-integer / out-of-range values', () => {
  const document = JSON.parse(renderPortsJson(DEFAULT_STACK_ID));
  document.ports.cp = '12631';
  assert.throws(() => parsePortsJson(JSON.stringify(document)), /integer port/);
  document.ports.cp = 70000;
  assert.throws(() => parsePortsJson(JSON.stringify(document)), /integer port/);
});
