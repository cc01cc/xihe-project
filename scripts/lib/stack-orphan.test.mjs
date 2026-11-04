import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyListener, SERVICE_OWNER, serviceForPort } from './stack-orphan.mjs';

// PLAN-0656 R3/R5: the ownership decision must be pure and testable without PowerShell.
// Ownership = listens on a stack port AND matches the service identity profile;
// anything else is foreign (reported, never killed).

const PORTS = { cp: 12631, runtime: 12633, agent: 12632, ui: 12630, postgres: 12634 };

test('a runtime listener on the runtime port is killable', () => {
  const decision = classifyListener(
    { port: 12633, pid: 111, name: 'xihe-runtime', cmdline: 'H:\\t\\debug\\xihe-runtime.exe' },
    { ports: PORTS, isWindows: true },
  );
  assert.deepEqual(decision, { kind: 'kill', service: 'runtime' });
});

test('a maven/cp listener matches by command line even when the process name is generic', () => {
  const decision = classifyListener(
    { port: 12631, pid: 222, name: 'cmd', cmdline: 'cmd.exe /d /s /c mvn spring-boot:run -Dxihe.target.dir=...' },
    { ports: PORTS, isWindows: true },
  );
  assert.deepEqual(decision, { kind: 'kill', service: 'cp' });
});

test('a foreign squatter on our runtime port is reported, not killed', () => {
  const decision = classifyListener(
    { port: 12633, pid: 333, name: 'python', cmdline: 'python -m http.server 12633' },
    { ports: PORTS, isWindows: true },
  );
  assert.deepEqual(decision, { kind: 'foreign', service: 'runtime' });
});

test('a listener on an unknown port is foreign with no service', () => {
  const decision = classifyListener({ port: 9999, pid: 444, name: 'xihe-runtime', cmdline: '' }, { ports: PORTS, isWindows: true });
  assert.deepEqual(decision, { kind: 'foreign', service: null });
});

test('the services filter ignores out-of-scope listeners (healthy siblings stay silent)', () => {
  const decision = classifyListener(
    { port: 12633, pid: 555, name: 'xihe-runtime', cmdline: 'xihe-runtime.exe' },
    { ports: PORTS, services: ['cp'], isWindows: true },
  );
  assert.deepEqual(decision, { kind: 'ignored', service: 'runtime' });
});

test('non-Windows platforms do not sweep at all', () => {
  const decision = classifyListener(
    { port: 12633, pid: 666, name: 'xihe-runtime', cmdline: 'xihe-runtime.exe' },
    { ports: PORTS, isWindows: false },
  );
  assert.deepEqual(decision, { kind: 'unsupported' });
});

test('serviceForPort maps only known services', () => {
  assert.equal(serviceForPort(PORTS, 12633), 'runtime');
  assert.equal(serviceForPort(PORTS, 12634), 'postgres');
  assert.equal(serviceForPort(PORTS, 1), undefined);
  assert.equal(typeof SERVICE_OWNER.runtime.test('xihe-runtime.exe'), 'boolean');
});
