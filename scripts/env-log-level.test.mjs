#!/usr/bin/env node
/**
 * Static gate: `XIHE_LOG_LEVEL*` values in every `.env*` file MUST be uppercase.
 *
 * Why this exists (2026-11-03 PLAN-0630 walkthrough, ~2 rounds burned):
 *   `.env` shipped `XIHE_LOG_LEVEL=info` (lowercase). That value flows through
 *   `application.properties:152` -> `logging.level.com.cc01cc.p.xihe.cp=${XIHE_LOG_LEVEL_CP:${XIHE_LOG_LEVEL:INFO}}`.
 *   Spring Boot 2.4+ parses `logging.level.*` **strictly against the `LogLevel` enum**, so lowercase
 *   `info` throws `IllegalArgumentException: No enum constant org.springframework.boot.logging.LogLevel.info`
 *   and the control plane dies on startup — before any health endpoint exists, which makes the
 *   failure look like "CP never became ready" rather than "bad config value".
 *
 *   The three consumers disagree about case, which is exactly why the files must not rely on it:
 *     - `application.properties`  -> Spring enum:  UPPERCASE ONLY
 *     - `logback-spring.xml`      -> Logback:      case-insensitive
 *     - `LoggingConfigInitializer.parseLogLevel` -> calls `toUpperCase()` itself
 *   Uppercase is the only spelling all three accept.
 *
 * Run: `node --test scripts/env-log-level.test.mjs` (from the A03 repo root).
 * Zero dependencies.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/** The only values Spring's `LogLevel` enum accepts (uppercase, exact). */
const ALLOWED = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL', 'OFF'];

/**
 * Every `.env*` file in the repo root. `.env.example` is a template, but it is checked too on
 * purpose: a lowercase example is how the next person reintroduces the bug.
 */
function envFiles() {
  return readdirSync(REPO_ROOT)
    .filter((name) => name === '.env' || name.startsWith('.env.'))
    .sort();
}

/** `XIHE_LOG_LEVEL=info  # comment` -> [{ file, key, value }] */
function logLevelAssignments(file) {
  const text = readFileSync(join(REPO_ROOT, file), 'utf8');
  const found = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(XIHE_LOG_LEVEL(?:_[A-Z]+)?)\s*=\s*([^\s#]*)/.exec(line);
    if (match) {
      found.push({ file, key: match[1], value: match[2] });
    }
  }
  return found;
}

test('every XIHE_LOG_LEVEL* assignment in .env* files is an uppercase LogLevel', () => {
  const files = envFiles();
  assert.ok(files.length > 0, 'no .env* files found at repo root');

  const assignments = files.flatMap(logLevelAssignments);
  assert.ok(assignments.length > 0, 'no XIHE_LOG_LEVEL* assignments found — gate would be vacuous');

  const offenders = assignments.filter((entry) => !ALLOWED.includes(entry.value));
  assert.deepEqual(
    offenders,
    [],
    'XIHE_LOG_LEVEL must be one of ' +
      ALLOWED.join('/') +
      ' (uppercase). Lowercase values crash the control plane on startup via ' +
      'logging.level.* StrictEnum parsing. Offenders: ' +
      JSON.stringify(offenders),
  );
});

test('application.properties keeps an uppercase default for the same key', () => {
  const text = readFileSync(
    join(REPO_ROOT, 'packages', 'control-plane', 'src', 'main', 'resources', 'application.properties'),
    'utf8',
  );
  const line = text
    .split(/\r?\n/)
    .find((entry) => entry.startsWith('logging.level.com.cc01cc.p.xihe.cp='));
  assert.ok(line, 'logging.level.com.cc01cc.p.xihe.cp is missing from application.properties');

  // `${XIHE_LOG_LEVEL_CP:${XIHE_LOG_LEVEL:INFO}}` -> collect every literal default in the chain.
  const defaults = [...line.matchAll(/:([A-Za-z]+)\}/g)].map((match) => match[1]);
  assert.ok(defaults.length > 0, `cannot read the placeholder default chain from: ${line}`);
  for (const value of defaults) {
    assert.ok(
      ALLOWED.includes(value),
      `non-uppercase default "${value}" in application.properties would crash CP when the env var is absent`,
    );
  }
});
