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

test('BL-204 A(1): the security-level log list is explicit, ordered and source-attributed', () => {
  // The list itself: one entry per signature, each with its CP file:line. A keyword/regex match
  // would fail this test because the sources are asserted verbatim.
  assert.ok(
    /static\s+final\s+List<SecurityLogSignature>\s+SECURITY_LOG_SIGNATURES\s*=\s*List\.of\(/.test(source),
    'SECURITY_LOG_SIGNATURES is gone: the gate would be back to an ad-hoc keyword match',
  );
  const cpValidator = 'packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/SecurityDefaultsValidator.java';
  for (const sourceRef of [`${cpValidator}:45`, `${cpValidator}:49`]) {
    assert.ok(source.includes(sourceRef), `the signature table lost its source citation: ${sourceRef}`);
  }
  assert.ok(
    source.includes('SECURITY_REFUSED_SIGNATURE, "ERROR"')
      && source.includes('SECURITY_WARN_SIGNATURE, "WARN"'),
    'the table entries no longer declare their severity, so launcher.log cannot say which one fired',
  );
  assert.ok(
    source.includes('for (SecurityLogSignature candidate : SECURITY_LOG_SIGNATURES)'),
    'scanLogFile no longer iterates the table (a second matcher crept back in)',
  );
  // Narrowed on purpose: the generic "Refusing to start" also prefixes unrelated config refusals,
  // and mislabelling those as insecure defaults would be a false positive.
  assert.ok(
    /SECURITY_REFUSED_SIGNATURE\s*=\s*\n?\s*"Refusing to start: insecure default configuration in prod mode"/.test(source),
    'the refusal signature must stay narrowed to the insecure-defaults refusal',
  );
});

test('BL-204 A(2): an unprovable ACL is a refusal, and the old file survives it', () => {
  assert.ok(
    /static\s+final\s+String\s+CODE_SECRETS_ACL\s*=\s*"LAUNCHER_SECRETS_ACL_UNHARDENED"/.test(source),
    'CODE_SECRETS_ACL is gone: an ACL failure would be a warning again',
  );
  assert.ok(
    source.includes('throw new LauncherException(CODE_SECRETS_ACL'),
    'hardenPermissions must throw, not log-and-continue',
  );
  assert.ok(
    !/log\(\s*"WARN: could not harden/.test(source),
    'the silent WARN path is back — "wrote secrets we could not protect" must not ship',
  );
  assert.ok(source.includes('PosixFilePermission'), 'the POSIX 600 fallback is gone');
  assert.ok(source.includes('verifyHardened('), 'the post-move read-only verification is gone');
  // Ordering: harden tmp + parent BEFORE the atomic move, so a failure leaves the old file intact.
  const persistAt = source.indexOf('private boolean persistSecrets');
  const persist = source.slice(persistAt, source.indexOf('private void hardenPermissions'));
  assert.ok(persist.length > 0, 'persistSecrets not found — the ordering check would be vacuous');
  const hardenTmpAt = persist.indexOf('hardenPermissions(tmp)');
  const hardenParentAt = persist.indexOf('hardenPermissions(file.getParent())');
  const moveAt = persist.indexOf('Files.move(tmp, file, StandardCopyOption.ATOMIC_MOVE)');
  assert.ok(hardenTmpAt > 0 && hardenParentAt > 0 && moveAt > 0, 'harden/move call sites not found');
  assert.ok(hardenTmpAt < moveAt && hardenParentAt < moveAt,
    'hardening happens after publishing the file: an ACL failure would replace a good file with a bad one');
  assert.ok(persist.indexOf('Files.deleteIfExists(tmp);\n            throw failure;') > 0
    || /catch \(LauncherException failure\) \{\s*Files\.deleteIfExists\(tmp\);\s*throw failure;/.test(persist),
  'the failure path must drop the tmp file and rethrow');
});

test('PLAN-0650 A-2 gap: loading an existing secrets file re-asserts the DACL', () => {
  // The regression this pins: loadOrCreateSecrets used to read the existing file and hand it back
  // without touching the DACL, so a pre-BL-204 file (three inherited ACEs) stayed inherited for the
  // life of the install while the create-path gate reported green.
  const loadAt = source.indexOf('private Properties loadOrCreateSecrets');
  assert.ok(loadAt > 0, 'loadOrCreateSecrets() not found — this gate would be vacuous');
  const loadBody = source.slice(loadAt, source.indexOf('private boolean persistSecrets', loadAt));
  const existsAt = loadBody.indexOf('if (Files.isRegularFile(file))');
  const returnAt = loadBody.indexOf('return props;', existsAt);
  assert.ok(existsAt > 0 && returnAt > 0, 'the existing-file branch or its return is gone');
  const branch = loadBody.slice(existsAt, returnAt);
  const readAt = branch.indexOf('props.load(in)');
  const rehardenAt = branch.indexOf('rehardenExistingSecrets(file, dir)');
  assert.ok(rehardenAt > 0,
    'the existing-file branch returns unverified secrets: an upgraded install keeps its inherited ACEs');
  assert.ok(readAt > 0 && readAt < rehardenAt,
    'the load path must harden AFTER reading the props it is about to return');

  const helperAt = source.indexOf('private void rehardenExistingSecrets');
  assert.ok(helperAt > 0, 'rehardenExistingSecrets() is gone: the load path cannot harden at all');
  const helper = source.slice(helperAt, source.indexOf('private void hardenPermissions', helperAt));
  const fileAt = helper.indexOf('hardenPermissions(file)');
  const dirAt = helper.indexOf('hardenPermissions(dir)');
  const verifyAt = helper.indexOf('verifyHardened(file)');
  assert.ok(fileAt > 0 && dirAt > 0 && verifyAt > 0,
    'the load path must harden the file and its directory, then run the read-only verify');
  assert.ok(fileAt < dirAt && dirAt < verifyAt,
    'the load path must harden file → directory → verify, the same order as the create path');
  assert.ok(
    !/catch\s*\(/.test(helper),
    'the load path catches a hardening failure: an unprovable DACL must be exit 4, not a warning',
  );
});

test('BL-204 A(3): no nullable value can reach the child environment', () => {
  // The assembly must reject a blank/missing value before it can be put into the env map, and the
  // pre-flight sweep must keep listing exactly the keys the env assembly consumes.
  const envAt = source.indexOf('private Map<String, String> securityEnv');
  const envBody = source.slice(envAt, source.indexOf('private void attestSecurity'));
  assert.ok(envBody.length > 0, 'securityEnv() not found — this gate would be vacuous');
  assert.ok(
    envBody.indexOf('value == null || value.isBlank()') < envBody.indexOf('env.put(entry.getKey(), value)'),
    'securityEnv can put a null/blank value into the child environment',
  );
  assert.ok(
    !/env\.put\([^)]*props\.getProperty/.test(envBody),
    'a raw property read reaches env.put() again',
  );
  assert.ok(
    source.includes('requireAllSecrets(secrets);'),
    'the pre-flight requireAllSecrets() sweep is gone',
  );
  assert.ok(
    /private static final List<String> REQUIRED_SECRET_KEYS = List\.of\(/.test(source),
    'REQUIRED_SECRET_KEYS is gone: the sweep would have nothing to iterate',
  );
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
