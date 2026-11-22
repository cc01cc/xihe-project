import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RULES, scanJavaText } from './check-spring-ctor-injection.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-spring-ctor-injection.mjs');

function runCli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  });
  return { status: result.status, output: (result.stdout ?? '') + (result.stderr ?? '') };
}

function tempTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spring-ctor-test-'));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return root;
}

test('multi-constructor class without @Autowired is a hit', () => {
  const result = scanJavaText([
    'class Service {',
    '  Service(int a) { }',
    '  Service(String b) { }',
    '}',
  ].join('\n'));
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].rule, RULES.MULTI_CTOR_NO_AUTOWIRED);
  assert.equal(result.hits[0].constructors, 2);
  assert.equal(result.hits[0].stereotype, false);
});

test('single constructor, annotated constructor, and @Autowired FQN are not hits', () => {
  assert.equal(
    scanJavaText('class A { A(int a) { } }').hits.length,
    0,
  );
  assert.equal(
    scanJavaText([
      'class B {',
      '  B() { }',
      '  @Autowired',
      '  B(int a) { }',
      '}',
    ].join('\n')).hits.length,
    0,
  );
  assert.equal(
    scanJavaText([
      'class C {',
      '  C() { }',
      '  @org.springframework.beans.factory.annotation.Autowired C(int a) { }',
      '}',
    ].join('\n')).hits.length,
    0,
  );
});

test('comments, strings, new expressions and class literals do not count as constructors', () => {
  const result = scanJavaText([
    'class D {',
    '  // D(1) in a comment',
    '  String note = "D(2) in a string";',
    '  Object made = new D();',
    '  void call() { helper(D.class); }',
    '  D() { }',
    '}',
  ].join('\n'));
  assert.equal(result.hits.length, 0);
  assert.equal(result.types[0].constructors, 1);
});

test('nested class constructors do not leak into the enclosing class', () => {
  const result = scanJavaText([
    'class Outer {',
    '  Outer() { }',
    '  static class Inner {',
    '    Inner() { }',
    '    Inner(int a) { }',
    '  }',
    '}',
  ].join('\n'));
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].type, 'Inner');
});

test('record compact constructor counts toward the constructor total', () => {
  const result = scanJavaText([
    'record Point(int x, int y) {',
    '  Point {',
    '    if (x < 0) throw new IllegalArgumentException();',
    '  }',
    '  Point(int both) {',
    '    this(both, both);',
    '  }',
    '}',
  ].join('\n'));
  assert.equal(result.types[0].constructors, 2);
  assert.equal(result.hits.length, 1);
});

test('inline OK comment on the class line or a constructor line exempts the class', () => {
  const onClass = scanJavaText([
    'class E { // OK: 测试装配，Spring 不实例化',
    '  E() { }',
    '  E(int a) { }',
    '}',
  ].join('\n'));
  assert.equal(onClass.hits.length, 0);
  assert.equal(onClass.exempt.length, 1);

  const onConstructor = scanJavaText([
    'class F {',
    '  F() { }',
    '  F(int a) { } // OK: 只由测试直接 new',
    '}',
  ].join('\n'));
  assert.equal(onConstructor.hits.length, 0);
  assert.equal(onConstructor.exempt.length, 1);

  const noReason = scanJavaText([
    'class G { // OK:',
    '  G() { }',
    '  G(int a) { }',
    '}',
  ].join('\n'));
  assert.equal(noReason.hits.length, 1);
});

test('Spring stereotype annotation is reported as classification only, not as a decision change', () => {
  const result = scanJavaText([
    '@Component',
    'class H {',
    '  H() { }',
    '  H(int a) { }',
    '}',
  ].join('\n'));
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].stereotype, true);
});

test('CLI: clean tree inside baseline exits 0, over-baseline exits 1, structural failures exit 2', () => {
  const root = tempTree({
    'A.java': 'class A {\n  A(int a) { }\n  A(String b) { }\n}\n',
    'nested/B.java': 'class B {\n  B() { }\n}\n',
  });
  const baseline = path.join(root, 'baseline.json');

  const wrote = runCli(['--root', root, '--baseline', baseline, '--write-baseline']);
  assert.equal(wrote.status, 0, wrote.output);
  assert.match(wrote.output, /total=1/u);

  const clean = runCli(['--root', root, '--baseline', baseline]);
  assert.equal(clean.status, 0, clean.output);
  assert.match(clean.output, /hits=1/u);

  fs.writeFileSync(
    path.join(root, 'C.java'),
    'class C {\n  C(int a) { }\n  C(String b) { }\n}\n',
    'utf8',
  );
  const over = runCli(['--root', root, '--baseline', baseline]);
  assert.equal(over.status, 1, over.output);
  assert.match(over.output, /E_SPRING_CTOR_INJECTION/u);
  assert.match(over.output, /C\.java/u);

  const missing = runCli(['--root', path.join(root, 'nope'), '--baseline', baseline]);
  assert.equal(missing.status, 2, missing.output);
  assert.match(missing.output, /E_SCAN_ROOT_MISSING/u);

  const empty = tempTree({ 'readme.txt': 'no java here\n' });
  const noFiles = runCli(['--root', empty, '--baseline', baseline]);
  assert.equal(noFiles.status, 2, noFiles.output);
  assert.match(noFiles.output, /E_NO_SOURCE_FILES/u);

  const badBaseline = path.join(root, 'bad.json');
  fs.writeFileSync(badBaseline, '{"total":1,"files":{"A.java":2}}', 'utf8');
  const corrupted = runCli(['--root', root, '--baseline', badBaseline]);
  assert.equal(corrupted.status, 2, corrupted.output);
  assert.match(corrupted.output, /E_BAD_BASELINE/u);
});

test('CLI: selftest passes', () => {
  const result = runCli(['--selftest']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /passed/u);
});
