#!/usr/bin/env node
/**
 * PLAN-0650 A-4: the packaging security gate, pinned as a static test.
 *
 * Why a text-level test instead of a Java test: the launcher is a single file compiled by
 * `javac` inside `scripts/pkg/build-installer.mjs` — there is no Java test harness, no test
 * classpath and no JUnit dependency in the package (and adding one to a double-click installer
 * build would be its own cost). `scripts/pkg/phase-parity.test.mjs` established the pattern in
 * this repo: read the Java source as text, assert the literals that must never drift.
 *
 * What is asserted (all literal, no "close enough"):
 *   1. the five CP security envs the prod validator requires are still wired;
 *   2. the CP is still started with XIHE_ENV=prod, through ONE constant that is actually used;
 *   3. the three `*_ALLOW_DEV_KEY=false` switches are still passed;
 *   4. the gate machinery exists: attestation line, both CP log signatures, exit code 4,
 *      atomic secrets write, ACL hardening;
 *   5. no bare `getProperty` can reach an env map — every read carries the marker;
 *   6. ordering invariants: secrets are validated before anything spawns, and the attestation is
 *      emitted before the first-run work (otherwise it is written into a log that gets truncated).
 *
 * Run: `node --test scripts/pkg/launcher-security.test.mjs` (from the A03 repo root).
 * It must also appear in a mise `run = ...` line (scripts/test-wiring.test.mjs enforces that).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = join(
  PKG_DIR,
  'launcher',
  'src',
  'com',
  'cc01cc',
  'xihe',
  'pkg',
  'Launcher.java',
);

/** The contract itself: a typo in either side must fail here. */
const SECURITY_KEYS = [
  'XIHE_CP_JWT_SECRET',
  'XIHE_CP_CREDENTIALS_KEY',
  'XIHE_CP_CREDENTIALS_FINGERPRINT_KEY',
  'XIHE_CP_PROVIDER_CREDENTIALS_KEY',
  'XIHE_CP_OAUTH_ENCRYPTION_KEY',
];
const DEV_KEY_SWITCHES = [
  'XIHE_CP_CREDENTIALS_ALLOW_DEV_KEY',
  'XIHE_CP_PROVIDER_CREDENTIALS_ALLOW_DEV_KEY',
  'XIHE_CP_OAUTH_ALLOW_DEV_KEY',
];
/** Verbatim texts from the CP's SecurityDefaultsValidator (cross-module contract). */
const CP_WARN_SIGNATURE = 'Insecure default configuration detected';
const CP_REFUSED_SIGNATURE = 'Refusing to start';

const source = readFileSync(LAUNCHER, 'utf8');
const lines = source.split(/\r?\n/);

function lineOf(fragment) {
  return lines.find((line) => line.includes(fragment));
}

test('the five CP security envs are still wired into the packaged CP', () => {
  for (const key of SECURITY_KEYS) {
    assert.ok(
      source.includes(`"${key}"`),
      `${key} disappeared from Launcher.java: the packaged CP would boot without it`,
    );
  }
});

test('the CP still starts with XIHE_ENV=prod via the shared constant', () => {
  const constant = /static\s+final\s+String\s+SECURITY_ENV_CP\s*=\s*"prod"\s*;/.exec(source);
  assert.ok(constant, 'SECURITY_ENV_CP = "prod" is missing or no longer prod');
  assert.ok(
    /common\.put\(\s*"XIHE_ENV"\s*,\s*SECURITY_ENV_CP\s*\)/.test(source),
    'the CP env no longer takes XIHE_ENV from SECURITY_ENV_CP (two opinions again)',
  );
  assert.ok(
    source.includes('attestSecurity(SECURITY_ENV_CP'),
    'the attestation must report the same env value the CP receives',
  );
});

test('all three dev-key fallbacks are still explicitly disabled', () => {
  for (const key of DEV_KEY_SWITCHES) {
    const expected = `env.put("${key}", "false")`;
    assert.ok(
      source.includes(expected),
      `${key} is not pinned to "false" — a public fallback key could be accepted in prod`,
    );
  }
});

test('the security gate machinery is present (attestation, log signatures, exit 4)', () => {
  assert.ok(lineOf('security: env='), 'the A-1 attestation line is gone');
  assert.ok(lineOf(' keys=') && lineOf(' allowDevKeys='), 'the attestation stopped reporting keys/allowDevKeys');
  assert.ok(source.includes(CP_WARN_SIGNATURE), `missing CP signature: ${CP_WARN_SIGNATURE}`);
  assert.ok(source.includes(CP_REFUSED_SIGNATURE), `missing CP signature: ${CP_REFUSED_SIGNATURE}`);
  assert.ok(
    /static\s+final\s+int\s+EXIT_SECURITY\s*=\s*4\s*;/.test(source),
    'exit code 4 (security-policy refusal, ruling Q-2) is gone',
  );
  assert.ok(
    source.includes('cp.out.log') && source.includes('cp.err.log'),
    'the log gate must scan both CP streams, not just one',
  );
  assert.ok(source.includes('ATOMIC_MOVE'), 'the secrets write is no longer atomic');
  assert.ok(source.includes('AclFileAttributeView'), 'the secrets DACL hardening is gone');
  assert.ok(source.includes('restoreAcl('), 'the ACL failure path (restore) is gone');
});

test('no bare getProperty can reach a child environment', () => {
  // `props.getProperty` is the only legal way to read launcher.properties, and only from the
  // two marked places (requireSecret / the pre-flight sweep). `System.getProperty` is unrelated
  // and must not be caught by this check.
  const offenders = lines.filter(
    (line) => /\bprops\.getProperty\(/.test(line) && !line.includes('launcher-secret-read-ok:'),
  );
  assert.deepEqual(
    offenders,
    [],
    'every secrets read must go through requireSecret() and carry the marker: '
      + offenders.join(' | '),
  );
  assert.ok(
    !source.includes('secrets.getProperty('),
    'a raw secrets.getProperty(...) reappeared instead of requireSecret(...)',
  );
  assert.ok(
    source.includes('requireSecret('),
    'requireSecret() is gone: a missing key would reach spawn() as null again',
  );
});

/** The body of start(): ordering assertions must be scoped there, not to the whole file. */
const startAt = source.indexOf('private int start()');
const startBody = startAt > 0 ? source.slice(startAt) : '';

test('ordering: secrets are validated before anything spawns', () => {
  const validateAt = startBody.indexOf('requireAllSecrets(secrets)');
  const spawnAt = startBody.indexOf('spec.pid = spawn(spec)');
  const payloadAt = startBody.indexOf('ensurePostgresPayload();');
  assert.ok(startBody.length > 0, 'start() not found — this ordering check would be vacuous');
  assert.ok(validateAt > 0, 'the pre-flight requireAllSecrets() call is gone from start()');
  assert.ok(spawnAt > 0, 'spawn() call site not found in start()');
  assert.ok(
    validateAt < spawnAt,
    'secrets are validated AFTER spawn: a missing key would reach the child environment',
  );
  assert.ok(
    validateAt < payloadAt,
    'secrets are validated after the first-run payload work — the refusal would look like a payload failure',
  );
});

test('ordering: the attestation is emitted before the first-run work truncates the log', () => {
  const truncateAt = startBody.indexOf('truncateLauncherLog();');
  const attestAt = startBody.indexOf('attestSecurity(SECURITY_ENV_CP');
  const payloadAt = startBody.indexOf('ensurePostgresPayload();');
  assert.ok(truncateAt > 0 && attestAt > 0 && payloadAt > 0, 'truncate/attestation/payload call sites not found');
  assert.ok(
    truncateAt < attestAt,
    'the attestation is written before the log is truncated, so it would be erased',
  );
  assert.ok(
    attestAt < payloadAt,
    'the attestation must precede first-run work (that work logs lines the user needs on failure)',
  );
});

test('the security log gate runs on the cp phase, not only on failure', () => {
  assert.ok(
    /if\s*\(\s*"cp"\.equals\(name\)\s*\)/.test(source),
    'the cp branch of the phase loop is gone; the security scan would never run',
  );
  assert.ok(
    source.includes('scanCpSecurityLogs()'),
    'scanCpSecurityLogs() is not called — the dangerous "healthy but insecure" case is ungated',
  );
  const scanAt = startBody.indexOf('String violation = scanCpSecurityLogs();');
  const readyAt = startBody.indexOf('if (!probe.ready) {');
  assert.ok(scanAt > 0 && readyAt > 0, 'scan/ready call sites not found in start()');
  assert.ok(
    scanAt < readyAt,
    'the scan happens after the readiness branch, so a CP that reaches health 200 would skip the gate',
  );
});
