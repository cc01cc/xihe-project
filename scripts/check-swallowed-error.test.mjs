import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  RULES,
  isTestSource,
  scanText,
  main,
} from './check-swallowed-error.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-swallowed-error.mjs');

function runCli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  });
  return { status: result.status, output: (result.stdout ?? '') + (result.stderr ?? '') };
}

function tempTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swallowed-error-test-'));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return root;
}

function writeBaseline(root, files, name = 'baseline.json') {
  const file = path.join(root, name);
  const total = Object.values(files).reduce(
    (sum, rules) => sum + Object.values(rules).reduce((inner, count) => inner + count, 0),
    0,
  );
  fs.writeFileSync(file, JSON.stringify({ total, files }), 'utf8');
  return file;
}

test('Java: catch (Throwable), catch (Error), java.lang.Throwable and multi-catch are hits', () => {
  const source = [
    'class A {',
    '  void one() { try { } catch (Throwable boom) { throw boom; } }',
    '  void two() { try { } catch (Error boom) { throw boom; } }',
    '  void three() { try { } catch (java.lang.Throwable boom) { throw boom; } }',
    '  void four() { try { } catch (java.io.IOException | Error boom) { throw boom; } }',
    '}',
  ].join('\n');
  const result = scanText(source, 'java');
  assert.equal(result.hits.length, 4);
  assert.ok(result.hits.every((hit) => hit.rule === RULES.JAVA));
});

test('Java: catch (Exception) and commented/string mentions are not hits', () => {
  const source = [
    'class B {',
    '  void one() { try { } catch (Exception boom) { throw boom; } }',
    '  // catch (Throwable boom) { }',
    '  String note = "catch (Throwable boom) { }";',
    '}',
  ].join('\n');
  assert.equal(scanText(source, 'java').hits.length, 0);
});

test('Python: bare except and BaseException hits; Exception and comments do not', () => {
  const source = [
    'try:',
    '    work()',
    'except:',
    '    pass',
    'try:',
    '    work()',
    'except BaseException as exc:',
    '    raise',
    'try:',
    '    work()',
    'except (ValueError, BaseException) as exc:',
    '    raise',
    'try:',
    '    work()',
    'except Exception:',
    '    pass',
    '# except:',
    '# except BaseException:',
  ].join('\n');
  const result = scanText(source, 'python');
  assert.equal(result.hits.length, 3);
  assert.equal(result.hits.filter((hit) => hit.rule === RULES.PY_BARE).length, 1);
  assert.equal(result.hits.filter((hit) => hit.rule === RULES.PY_BASE).length, 2);
});

test('TypeScript: empty catch bodies hit; non-empty bodies and non-catch braces do not', () => {
  const source = [
    'function a() { try { work(); } catch { } }',
    'function b() { try { work(); } catch (error) {} }',
    'function c() {',
    '  try { work(); } catch {',
    '    // 有意为之：本地存储不可用',
    '  }',
    '}',
    'function d() { try { work(); } catch (error) { report(error); } }',
    'function e() { try { work(); } catch (error) { throw error; } }',
    'const f = () => { if (true) { } };',
  ].join('\n');
  const result = scanText(source, 'ts');
  assert.equal(result.hits.length, 3);
  assert.ok(result.hits.every((hit) => hit.rule === RULES.TS_EMPTY));
});

test('inline OK comment exempts a hit; an OK without a reason does not', () => {
  const exemptSource =
    'class C { void run() { try { } catch (Throwable boom) { throw boom; } } } // OK: 观测后原样重抛\n';
  const exempt = scanText(exemptSource, 'java');
  assert.equal(exempt.hits.length, 0);
  assert.equal(exempt.exempt.length, 1);

  const noReason = 'class D { void run() { try { } catch (Throwable boom) { throw boom; } } } // OK:\n';
  assert.equal(scanText(noReason, 'java').hits.length, 1);
});

test('test sources are excluded from the production scan', () => {
  assert.equal(isTestSource('features/x/__tests__/a.ts'), true);
  assert.equal(isTestSource('features/x/a.spec.ts'), true);
  assert.equal(isTestSource('features/x/a.test.ts'), true);
  assert.equal(isTestSource('features/x/a.ts'), false);
});

test('CLI: current hits covered by the baseline exit 0', () => {
  const root = tempTree({
    'Probe.java': 'class Probe { void run() { try { } catch (Throwable boom) { throw boom; } } }\n',
  });
  const baseline = writeBaseline(root, { 'Probe.java': { [RULES.JAVA]: 1 } });
  try {
    const result = runCli(['--root', root, '--baseline', baseline]);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /over=0/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: a new hit over the baseline exits 1 and names the file', () => {
  const root = tempTree({
    'Probe.java': 'class Probe { void run() { try { } catch (Error boom) { throw boom; } } }\n',
  });
  const baseline = writeBaseline(root, {});
  try {
    const result = runCli(['--root', root, '--baseline', baseline]);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /E_SWALLOWED_ERROR/u);
    assert.match(result.output, /Probe\.java/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: deleting an entry from the baseline turns the same tree red', () => {
  const root = tempTree({
    'Probe.java': 'class Probe { void run() { try { } catch (Throwable boom) { throw boom; } } }\n',
  });
  const full = writeBaseline(root, { 'Probe.java': { [RULES.JAVA]: 1 } }, 'full-baseline.json');
  const shrunken = writeBaseline(root, {}, 'shrunken-baseline.json');
  try {
    assert.equal(runCli(['--root', root, '--baseline', full]).status, 0);
    const result = runCli(['--root', root, '--baseline', shrunken]);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /OVER\s+Probe\.java/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: a stale baseline entry is reported but does not fail (ratchet only forbids growth)', () => {
  const root = tempTree({ 'Probe.java': 'class Probe { void run() { } }\n' });
  const baseline = writeBaseline(root, { 'Probe.java': { [RULES.JAVA]: 1 } });
  try {
    const result = runCli(['--root', root, '--baseline', baseline]);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /STALE/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: missing scan root exits 2 with a structural error', () => {
  const root = tempTree({});
  const baseline = writeBaseline(root, {});
  try {
    const result = runCli(['--root', path.join(root, 'nope'), '--baseline', baseline]);
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /E_SCAN_ROOT_MISSING/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: missing baseline exits 2; --write-baseline then makes the tree green', () => {
  const root = tempTree({
    'Probe.java': 'class Probe { void run() { try { } catch (Throwable boom) { throw boom; } } }\n',
  });
  const baseline = path.join(root, 'baseline.json');
  try {
    const missing = runCli(['--root', root, '--baseline', baseline]);
    assert.equal(missing.status, 2, missing.output);
    assert.match(missing.output, /E_NO_BASELINE/u);

    const written = runCli(['--root', root, '--baseline', baseline, '--write-baseline']);
    assert.equal(written.status, 0, written.output);
    const check = runCli(['--root', root, '--baseline', baseline]);
    assert.equal(check.status, 0, check.output);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: malformed baseline exits 2 (unknown rule)', () => {
  const root = tempTree({ 'Probe.java': 'class Probe { }\n' });
  const baseline = path.join(root, 'baseline.json');
  fs.writeFileSync(
    baseline,
    JSON.stringify({ total: 1, files: { 'Probe.java': { 'made-up-rule': 1 } } }),
    'utf8',
  );
  try {
    const result = runCli(['--root', root, '--baseline', baseline]);
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /E_BAD_BASELINE/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: default mode outside a git work tree exits 2 (missing git face is not green)', () => {
  const root = tempTree({
    'scripts/check-swallowed-error.mjs': fs.readFileSync(SCRIPT, 'utf8'),
    'packages/control-plane/src/main/java/Probe.java': 'class Probe { }\n',
    'packages/agent/src/probe.py': 'pass\n',
    'packages/ui/src/probe.ts': 'export const probe = true;\n',
    'packages/runtime/lib.rs': 'pub fn probe() {}\n',
  });
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'scripts', 'check-swallowed-error.mjs')],
      { encoding: 'utf8', timeout: 120000, windowsHide: true },
    );
    const output = (result.stdout ?? '') + (result.stderr ?? '');
    assert.equal(result.status, 2, output);
    assert.match(output, /E_NOT_A_GIT_TREE/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--selftest covers hit, exemption, baseline growth and structural failure', () => {
  assert.equal(main(['--selftest']), 0);
});
