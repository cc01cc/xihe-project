/**
 * PLAN-0632 M2-1 launcher tests (node --test, zero dependencies, no services required).
 *
 * The two contracts the Lead called out:
 *   1. **No CP => the Agent is never started.** The Agent's startup config sync costs 58.46 s
 *      of retry ladder against a missing CP (measured 2026-11-02), which the user experiences
 *      as "the app is hung". The supervisor must fail at the CP step instead.
 *   2. **CP ready => the start order is exactly pg -> cp -> agent -> runtime -> ui.**
 *
 * Plus the two environment/packaging traps that only reproduce in an installed build:
 *   - NO_PROXY containing `[::1]` kills the Agent at import (`Invalid port ':1]'`),
 *   - PostgreSQL readiness cannot rely on psql/pg_isready (the zonky payload is server-only),
 *     so pg's gate is a plain TCP accept.
 *
 * Run: node --test scripts/lib/service-supervisor.test.mjs
 */
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { buildServices, parseNetstatListeners, planPhases } from '../pkg/launcher.mjs';
import { deriveStack } from './stack-ports.mjs';
import {
  DEFAULT_TIMEOUTS,
  PHASE_ORDER,
  formatFailure,
  runPhases,
  sanitizeNoProxyEnv,
  stopServices,
  waitForPhase,
} from './service-supervisor.mjs';

const derived = deriveStack('stack-1');

function fakeServices(ports = derived.ports) {
  return {
    pg: { name: 'pg', port: ports.postgres, health: 'tcp', url: `tcp://127.0.0.1:${ports.postgres}` },
    cp: { name: 'cp', port: ports.cp, health: 'http', url: `http://127.0.0.1:${ports.cp}/actuator/health` },
    agent: { name: 'agent', port: ports.agent, health: 'http', url: `http://127.0.0.1:${ports.agent}/internal/v1/agent/health` },
    runtime: { name: 'runtime', port: ports.runtime, health: 'http', url: `http://127.0.0.1:${ports.runtime}/health` },
    ui: { name: 'ui', port: ports.cp, health: 'http', url: `http://127.0.0.1:${ports.cp}/` },
  };
}

/** Virtual clock: sleeps advance time instead of waiting, so a 240 s budget costs 0 ms. */
function virtualClock() {
  let clock = 0;
  return {
    deps: {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
    get elapsed() {
      return clock;
    },
  };
}

function recordingDeps({ clock, probe, spawnOrder = [] }) {
  const logs = [];
  const probes = [];
  return {
    logs,
    probes,
    deps: {
      ...clock.deps,
      spawnService: async (name) => {
        spawnOrder.push(name);
        return { pid: 4000 + spawnOrder.length };
      },
      probe,
      log: (line) => logs.push(line),
      logProbe: Object.assign((entry) => probes.push(entry), { console: (line) => logs.push(line) }),
    },
    spawnOrder,
  };
}

test('no CP -> the Agent is never spawned (fail-fast at the CP gate)', async () => {
  const services = fakeServices();
  const clock = virtualClock();
  const rec = recordingDeps({
    clock,
    probe: async (name) => {
      if (name === 'pg') return { ready: true, state: 'tcp accept', listening: true };
      return { ready: false, state: 'http ECONNREFUSED', listening: false, url: services[name].url };
    },
  });
  const phases = planPhases({ services, timeouts: { pg: 1_000, cp: 3_000 } });

  const result = await runPhases({ phases, services, deps: rec.deps });

  assert.equal(result.ok, false, 'start must fail when the CP never becomes ready');
  assert.equal(result.failed.phase, 'cp');
  assert.equal(result.failed.reason, 'readiness timeout');
  assert.deepEqual(rec.spawnOrder, ['pg', 'cp'], 'nothing after the failed CP phase may be spawned');
  assert.ok(!rec.spawnOrder.includes('agent'), 'THE contract: the Agent must not start without a ready CP');
  // Every probe is persisted (post-mortem support), and the wait never exceeded the budget.
  const cpProbes = rec.probes.filter((entry) => entry.phase === 'cp');
  assert.ok(cpProbes.length >= 2, `every probe must be logged, got ${cpProbes.length}`);
  assert.ok(result.failed.elapsedMs <= 3_000, 'the gate must respect its own timeout');
  assert.ok(clock.elapsed >= 2_000, 'the gate must actually poll until the deadline, not give up early');
  // The CP hint is wired from the launcher manifest (diagnosability, not a generic message).
  assert.match(result.failed.hint, /CP/);
  assert.match(result.failed.hint, /actuator\/health/);
  // formatFailure is what the user actually sees.
  const report = formatFailure({ failed: result.failed, started: result.started, logDir: 'C:/logs' });
  assert.match(report, /FAILED at step=cp/);
  assert.match(report, /next:/);
  assert.match(report, /launcher log: C:\/logs|launcher log: C:[/\\]logs/);
});

test('CP ready -> order is pg, cp, agent, runtime, ui', async () => {
  const services = fakeServices();
  const clock = virtualClock();
  let cpAttempts = 0;
  const rec = recordingDeps({
    clock,
    probe: async (name) => {
      if (name === 'cp') {
        cpAttempts += 1;
        return cpAttempts === 1
          ? { ready: false, state: 'HTTP 503', listening: true, httpStatus: 503, url: services.cp.url }
          : { ready: true, state: 'HTTP 200', listening: true, httpStatus: 200, url: services.cp.url };
      }
      return { ready: true, state: 'ready', listening: true, httpStatus: 200, url: services[name].url };
    },
  });
  const phases = planPhases({ services });

  const result = await runPhases({ phases, services, deps: rec.deps });

  assert.equal(result.ok, true);
  assert.deepEqual(
    rec.spawnOrder,
    ['pg', 'cp', 'agent', 'runtime', 'ui'],
    'the packaged order must be pg -> cp -> agent -> runtime -> ui',
  );
  assert.deepEqual(
    result.events.map((entry) => `${entry.event}:${entry.phase}`),
    [
      'spawn:pg',
      'ready:pg',
      'spawn:cp',
      'ready:cp',
      'spawn:agent',
      'ready:agent',
      'spawn:runtime',
      'ready:runtime',
      'spawn:ui',
      'ready:ui',
    ],
  );
  // A 503 counts as not ready and costs exactly one poll interval (no fixed sleep).
  const cpReady = result.events.find((entry) => entry.event === 'ready' && entry.phase === 'cp');
  assert.equal(cpReady.attempts, 2);
  assert.equal(cpReady.elapsedMs, DEFAULT_TIMEOUTS.pollMs);
  // Per-step timing is available for the launcher's summary table.
  assert.ok(result.events.every((entry) => entry.event !== 'ready' || typeof entry.elapsedMs === 'number'));
});

test('a failing spawn reports the step and its hint instead of retrying blindly', async () => {
  const services = fakeServices();
  const clock = virtualClock();
  const deps = {
    ...clock.deps,
    spawnService: async (name) => {
      if (name === 'agent') throw new Error('executable not found: C:\\install\\agent\\xihe-agent-onedir.exe');
      return { pid: 5001 };
    },
    probe: async () => ({ ready: true, state: 'ready', listening: true }),
    log: () => {},
    logProbe: Object.assign(() => {}, { console: () => {} }),
  };
  const result = await runPhases({ phases: planPhases({ services }), services, deps });
  assert.equal(result.ok, false);
  assert.equal(result.failed.phase, 'agent');
  assert.match(result.failed.reason, /spawn failed/);
  assert.match(result.failed.hint, /Agent/);
  assert.ok(!result.events.some((entry) => entry.event === 'spawn' && entry.service === 'agent'));
});

test('waitForPhase records every probe and stops at the deadline', async () => {
  const clock = virtualClock();
  const probes = [];
  const consoleLines = [];
  const phase = { name: 'cp', timeoutMs: 1_000 };
  const result = await waitForPhase({
    phase,
    service: 'cp',
    spec: { url: 'http://127.0.0.1:12631/actuator/health' },
    probe: async () => ({ ready: false, state: 'http ECONNREFUSED' }),
    now: clock.deps.now,
    sleep: clock.deps.sleep,
    pollMs: 250,
    logProbe: Object.assign((entry) => probes.push(entry), { console: (line) => consoleLines.push(line) }),
  });
  assert.equal(result.ready, false);
  assert.equal(result.attempts, 5, 'attempts = deadline / pollMs + 1');
  assert.equal(probes.length, result.attempts, 'one log line per probe');
  assert.equal(consoleLines.length, 1, 'the console only hears about state changes');
  assert.ok(probes.every((entry) => entry.url?.includes('/actuator/health')));
});

test('a service that crashes on boot fails in seconds, not after the whole budget', async () => {
  const services = fakeServices();
  const clock = virtualClock();
  const rec = recordingDeps({
    clock,
    probe: async (name) =>
      name === 'pg'
        ? { ready: true, state: 'tcp accept', listening: true }
        : { ready: false, state: 'http ECONNREFUSED', listening: false, url: services[name].url },
  });
  // The CP process dies right after spawn; every other service stays alive.
  const deps = { ...rec.deps, isServiceRunning: (name) => name !== 'cp' };
  const phases = planPhases({ services, timeouts: { pg: 1_000, cp: 240_000 } });

  const result = await runPhases({ phases: phases.slice(0, 2), services, deps });

  assert.equal(result.ok, false);
  assert.equal(result.failed.phase, 'cp');
  assert.equal(result.failed.reason, 'process exited before becoming ready');
  assert.ok(
    result.failed.elapsedMs < 5_000,
    `must not burn the 240 s budget on a dead process (took ${result.failed.elapsedMs}ms)`,
  );
  assert.match(result.failed.hint, /进程已退出/);
  assert.ok(!rec.spawnOrder.includes('agent'));
});

test('stop kills in reverse order and reports residual listeners', async () => {
  const clock = virtualClock();
  const killed = [];
  const deps = {
    ...clock.deps,
    spawnService: async () => ({ pid: 1 }),
    probe: async () => ({ ready: true, state: 'ready' }),
    log: () => {},
    logProbe: Object.assign(() => {}, { console: () => {} }),
    killTree: async (record) => {
      killed.push(record.service);
      return { ok: true, exitCode: 0 };
    },
    isServiceRunning: () => true,
  };
  const started = [
    { service: 'pg', pid: 11, port: 12634 },
    { service: 'cp', pid: 12, port: 12631 },
    { service: 'agent', pid: 13, port: 12632 },
  ];
  const clean = await stopServices({ started, deps, verifyPorts: async () => [] });
  assert.deepEqual(killed, ['agent', 'cp', 'pg'], 'reverse order: dependents die before their dependencies');
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.residual, []);

  const leaked = await stopServices({
    started,
    deps,
    verifyPorts: async () => [{ port: 12631, pid: 999, image: 'java.exe' }],
    residualDeadlineMs: 1_000,
  });
  assert.equal(leaked.ok, false, 'a port still held after the kill must be reported, not hidden');
  assert.equal(leaked.residual[0].pid, 999);
});

test('NO_PROXY entries with brackets are stripped (the Agent dies on `[::1]`)', () => {
  const env = sanitizeNoProxyEnv({
    NO_PROXY: 'localhost,127.0.0.1,[::1]',
    no_proxy: '[::1],example.test',
    HTTPS_PROXY: 'http://127.0.0.1:12510',
  });
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1');
  assert.equal(env.no_proxy, 'example.test');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:12510', 'proxies are untouched');
  const untouched = { NO_PROXY: 'localhost,127.0.0.1' };
  assert.equal(sanitizeNoProxyEnv(untouched).NO_PROXY, 'localhost,127.0.0.1');
});

test('pg gate is TCP (the bundled payload has no pg_isready) and phases skip cleanly', () => {
  const services = buildServices({
    installDir: 'C:/install',
    exes: { agent: 'T1/agent/xihe-agent-onedir.exe' },
    derived,
    dataDir: 'C:/data',
    logDir: 'C:/logs',
  });
  assert.equal(services.pg.health, 'tcp', 'no psql/pg_isready exists in the zonky server-only payload');
  assert.equal(services.cp.health, 'http');
  assert.equal(services.cp.url, 'http://127.0.0.1:12631/actuator/health');
  assert.equal(services.ui.sameOrigin, 'cp', 'D32-06: the CP serves the SPA, there is no UI process');
  assert.equal(
    services.agent.exe,
    resolve('C:/install', 'T1/agent/xihe-agent-onedir.exe'),
    '--exe overrides are install-relative',
  );
  assert.equal(services.pg.args[0], '-D');
  assert.equal(services.pg.args[1], join('C:/data', 'pg'), 'the PG data dir is substituted, not guessed');
  assert.deepEqual(
    planPhases({ services, skip: ['pg'] }).map((phase) => phase.name),
    ['cp', 'agent', 'runtime', 'ui'],
    '--skip removes exactly that phase (this slice has no initdb)',
  );
  assert.deepEqual(planPhases({ services }).map((phase) => phase.name), [...PHASE_ORDER]);
});

test('parseNetstatListeners extracts pid + port from real netstat rows', () => {
  const sample = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:12630        0.0.0.0:0              LISTENING       12345',
    '  TCP    127.0.0.1:12631        0.0.0.0:0              LISTENING       23456',
    '  TCP    [::1]:12632            [::]:0                 LISTENING       34567',
    '  TCP    127.0.0.1:12631        127.0.0.1:51000        ESTABLISHED     23456',
    '  UDP    0.0.0.0:53              *:*                                    9999',
  ].join('\r\n');
  const rows = parseNetstatListeners(sample);
  assert.deepEqual(
    rows.map((row) => row.pid),
    [12345, 23456, 34567],
    'only TCP LISTENING rows, UDP/ESTABLISHED excluded',
  );
  assert.match(rows[2].local, /12632/, 'IPv6 listeners are recognised too');
});
