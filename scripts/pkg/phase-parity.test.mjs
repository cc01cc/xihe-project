#!/usr/bin/env node
/**
 * PLAN-0632: the **only** guard between the two launcher implementations.
 *
 * The product ships one launcher: `scripts/pkg/launcher/src/com/cc01cc/xihe/pkg/Launcher.java`
 * (a clean Windows machine has no Node, so the installer cannot ship `scripts/pkg/launcher.mjs`).
 * The Node lane (`scripts/lib/service-supervisor.mjs` + `scripts/pkg/launcher.mjs`) is kept as the
 * dev/CI equivalent. Two implementations of one ordering contract drift silently unless something
 * compares them; this test is that something.
 *
 * What is asserted (all literal, no "close enough"):
 *   1. Java `PHASE_ORDER` === Node `PHASE_ORDER`, in order: pg, cp, agent, runtime, ui.
 *   2. The order is exactly that list — adding/reordering a phase in either file fails here.
 *   3. The five readiness budgets are equal too (Node `DEFAULT_TIMEOUTS.*Ms` vs Java
 *      `*_TIMEOUT_MS`). The Java file's own comment claims the numbers are copied from Node, so
 *      the claim is checked instead of trusted.
 *
 * Run: `node --test scripts/pkg/phase-parity.test.mjs` (from the A03 repo root).
 * Zero dependencies; reads the two source files as text and imports the Node module directly.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_TIMEOUTS, PHASE_ORDER } from '../lib/service-supervisor.mjs';

const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(PKG_DIR, '..', '..');
const JAVA_LAUNCHER = join(
  PKG_DIR,
  'launcher',
  'src',
  'com',
  'cc01cc',
  'xihe',
  'pkg',
  'Launcher.java',
);

/** The contract itself. Kept literal on purpose: a typo in either implementation must fail here. */
const EXPECTED_PHASES = ['pg', 'cp', 'agent', 'runtime', 'ui'];

function readJava() {
  return readFileSync(JAVA_LAUNCHER, 'utf8');
}

function javaPhases(source) {
  const match = /private\s+static\s+final\s+List<String>\s+PHASE_ORDER\s*=\s*List\.of\(([^)]*)\)/.exec(
    source,
  );
  assert.ok(match, `PHASE_ORDER declaration not found in ${JAVA_LAUNCHER}`);
  return [...match[1].matchAll(/"([a-z]+)"/g)].map((entry) => entry[1]);
}

/** `private static final long PG_TIMEOUT_MS = 45_000;` -> 45000 */
function javaBudget(source, constant) {
  const match = new RegExp(`private\\s+static\\s+final\\s+long\\s+${constant}\\s*=\\s*([0-9_]+)L?\\s*;`).exec(
    source,
  );
  assert.ok(match, `${constant} not found in ${JAVA_LAUNCHER}`);
  return Number.parseInt(match[1].replaceAll('_', ''), 10);
}

test('Java PHASE_ORDER is exactly the Node PHASE_ORDER (same elements, same order)', () => {
  const java = javaPhases(readJava());
  assert.deepEqual(java, [...PHASE_ORDER], 'Java PHASE_ORDER drifted from Node PHASE_ORDER');
});

test('Node PHASE_ORDER is the frozen contract pg -> cp -> agent -> runtime -> ui', () => {
  assert.deepEqual([...PHASE_ORDER], EXPECTED_PHASES);
});

test('Java phase list has no duplicates and no extra phase', () => {
  const java = javaPhases(readJava());
  assert.equal(new Set(java).size, java.length, `duplicate phase in ${JSON.stringify(java)}`);
  assert.deepEqual([...java].sort(), [...EXPECTED_PHASES].sort());
});

test('Java readiness budgets equal the Node DEFAULT_TIMEOUTS (same evidence, two languages)', () => {
  const source = readJava();
  const pairs = [
    ['PG_TIMEOUT_MS', DEFAULT_TIMEOUTS.pgMs],
    ['CP_TIMEOUT_MS', DEFAULT_TIMEOUTS.cpMs],
    ['AGENT_TIMEOUT_MS', DEFAULT_TIMEOUTS.agentMs],
    ['RUNTIME_TIMEOUT_MS', DEFAULT_TIMEOUTS.runtimeMs],
    ['UI_TIMEOUT_MS', DEFAULT_TIMEOUTS.uiMs],
  ];
  for (const [constant, expected] of pairs) {
    assert.equal(javaBudget(source, constant), expected, `${constant} drifted from Node (${expected} ms)`);
  }
});
