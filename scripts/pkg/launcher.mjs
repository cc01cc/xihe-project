#!/usr/bin/env node
/**
 * PLAN-0632 M2-1: launcher skeleton for the packaged product.
 *
 * What it is: the product-facing supervisor that turns "double click" into "five services
 * up, in the only order that gives the user a sane first minute". It is deliberately NOT a
 * second orchestration system: ports come from `scripts/lib/stack-ports.mjs` (the repo's
 * single source of truth, PLAN-0612), the ordering/gate/diagnostics live in
 * `scripts/lib/service-supervisor.mjs`, and the PID/teardown conventions mirror
 * `scripts/dev-stack.mjs` (PID JSON + `taskkill /PID /T /F` + residual port check).
 *
 * What it is not (this slice): the installer, the first-run data root/secret generation, or
 * the CP-served UI (PLAN-0632 D32-06). The manifest below uses **install-relative paths** and
 * does not guess the real installer layout — override any entry with `--exe <service>=<path>`.
 *
 * Order and why (all measured, PLAN-0632 T1 2026-11-02):
 *   pg  -> TCP accept                      (bundled PG is the zonky server-only payload: no
 *                                           psql/pg_isready/pg_config exists, D32-15; and
 *                                           `postgres --single` exits 0 even on SQL errors, D32-13)
 *   cp  -> GET /actuator/health == 200     (CP runs Flyway on boot; it cannot start without PG,
 *                                           so CP is the real PostgreSQL gate)
 *   agent -> GET /internal/v1/agent/health (the Agent's startup config sync takes 0.025 s when
 *                                           the CP is reachable and 58.46 s of retry ladder when
 *                                           it is not — so it MUST come after the CP gate)
 *   runtime -> GET /health
 *   ui  -> GET / on the CP port            (D32-06 same-origin: the CP serves the SPA)
 *
 * Usage:
 *   node scripts/pkg/launcher.mjs start  [--install DIR] [--stack N] [--exe cp=PATH]... [--skip pg]...
 *   node scripts/pkg/launcher.mjs status [--stack N] [--json]
 *   node scripts/pkg/launcher.mjs stop   [--stack N] [--json]
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { connect } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_TIMEOUTS,
  formatFailure,
  runPhases,
  sanitizeNoProxyEnv,
  stopServices,
} from '../lib/service-supervisor.mjs';
import { DEFAULT_STACK_ID, deriveStack, normalizeStackArg, stackEnvDefaults } from '../lib/stack-ports.mjs';
import { buildCommitEnv, describeBuildCommit, resolveBuildCommit } from '../lib/build-commit-env.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..', '..');
const isWindows = process.platform === 'win32';

/**
 * Install-relative manifest. `{port}`/`{pgData}`/`{dataDir}` are substituted at build time.
 * `health` picks the gate: 'tcp' or 'http' (+ `path`, `okStatus`).
 */
export const MANIFEST = Object.freeze({
  pg: {
    exe: join('pgsql', 'bin', 'postgres.exe'),
    args: ['-D', '{pgData}', '-p', '{pgPort}'],
    health: 'tcp',
    portKey: 'postgres',
  },
  cp: {
    exe: join('cp', 'xihe-control-plane.exe'),
    args: [],
    health: 'http',
    path: '/actuator/health',
    okStatus: 200,
    portKey: 'cp',
  },
  agent: {
    exe: join('agent', 'xihe-agent-onedir.exe'),
    args: [],
    health: 'http',
    path: '/internal/v1/agent/health',
    okStatus: 200,
    portKey: 'agent',
  },
  runtime: {
    exe: join('runtime', 'xihe-runtime.exe'),
    args: [],
    health: 'http',
    path: '/health',
    okStatus: 200,
    portKey: 'runtime',
  },
  // D32-06: the SPA is served by the CP (same origin), so there is no UI process; the phase
  // only gates that the CP actually answers `/` (a CP with a broken static mapping is a real
  // failure mode for "double click -> browser").
  ui: {
    sameOrigin: 'cp',
    health: 'http',
    path: '/',
    okStatus: 200,
    portKey: 'cp',
  },
});

const PHASE_HINTS = {
  pg: 'PostgreSQL 未监听：确认 --data 指向已初始化的数据目录（首启 initdb 属 M1/M2-1 之后），并查看 pg.err.log；注意不要用 `postgres --single` 判断（SQL 错误也 exit 0）',
  cp: 'CP 未通过 /actuator/health：最常见原因是 PG 未就绪或 Flyway 失败（看 cp.err.log 的迁移报错）；确认 --install 下的 cp/ 与 agent/ 布局，或先手工跑一次 CP 看真实报错',
  agent: 'Agent 未通过 /internal/v1/agent/health：确认 CP 已在 200（本 launcher 已先等 CP），再看 agent.err.log；若日志出现 `Invalid port \':1]\'` 则 NO_PROXY 含 [::1]（本 launcher 已清洗，说明有别的层注入）',
  runtime: 'Runtime 未通过 /health：查看 runtime.err.log；确认 XIHE_RUNTIME_STATE_DIR 可写',
  ui: 'CP 未返回 `/`：静态伺服（D32-06）可能未启用/未打包 dist，检查 CP 的 cp.ui.dist-dir 配置',
};

/* ------------------------------------------------------------------ args */

export function parseArgs(argv) {
  const args = {
    action: 'status',
    install: projectRoot,
    stack: undefined,
    data: undefined,
    exes: {},
    skip: [],
    timeouts: {},
    json: false,
    cleanupOnFailure: false,
    pollMs: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => argv[++i];
    if (token === 'start' || token === 'stop' || token === 'status') args.action = token;
    else if (token === '--install') args.install = next();
    else if (token === '--stack') args.stack = next();
    else if (token === '--data') args.data = next();
    else if (token === '--exe') {
      const [name, ...rest] = String(next()).split('=');
      if (!name || rest.length === 0) throw new Error('--exe expects <service>=<path>');
      args.exes[name] = rest.join('=');
    } else if (token === '--skip') args.skip.push(next());
    else if (token === '--timeout') {
      const [name, ...rest] = String(next()).split('=');
      const value = Number(rest.join('='));
      if (!name || !Number.isFinite(value) || value <= 0) throw new Error('--timeout expects <service>=<seconds>');
      args.timeouts[name] = Math.round(value * 1000);
    } else if (token === '--poll-ms') args.pollMs = Number(next());
    else if (token === '--json') args.json = true;
    else if (token === '--cleanup-on-failure') args.cleanupOnFailure = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`unknown argument ${JSON.stringify(token)}`);
  }
  return args;
}

function usage() {
  console.log(
    [
      'usage: node scripts/pkg/launcher.mjs <start|stop|status> [options]',
      '',
      '  --install <dir>         安装目录（manifest 的 exe 相对此目录）',
      '  --stack <id|N>          stack-1..stack-8（端口来自 scripts/lib/stack-ports.mjs）',
      '  --exe <service>=<path>  覆盖某个服务的可执行文件（可重复）',
      '  --skip <service>        跳过某 phase（可重复；本刀用它免 PG 做冒烟）',
      '  --timeout <svc>=<sec>   覆盖该 step 的 readiness 上限（可重复）',
      '  --data <dir>            PG 父数据目录（默认 <install>/../data）',
      '  --poll-ms <ms>          readiness 轮询间隔（默认 500）',
      '  --cleanup-on-failure    启动失败时回收已启动的进程（默认保留供排查）',
      '  --json                 机读输出',
      '',
      `phases: pg(tcp) -> cp(http /actuator/health) -> agent -> runtime -> ui(same-origin)`,
    ].join('\n'),
  );
}

/* -------------------------------------------------------------- services */

function exePathFor(name, { installDir, exes }) {
  if (exes[name]) return isAbsolute(exes[name]) ? exes[name] : resolve(installDir, exes[name]);
  const entry = MANIFEST[name];
  if (!entry?.exe) return null;
  return resolve(installDir, entry.exe);
}

/**
 * Build the service table the supervisor drives. Exported so the smoke test and future
 * installer tooling share one definition instead of re-deriving paths.
 */
export function buildServices({ installDir, exes = {}, skip = [], derived, dataDir, logDir }) {
  const services = {};
  for (const [name, entry] of Object.entries(MANIFEST)) {
    if (skip.includes(name)) continue;
    const port = derived.ports[entry.portKey];
    if (entry.sameOrigin) {
      services[name] = {
        name,
        sameOrigin: entry.sameOrigin,
        // Gated but never spawned: with D32-06 the SPA is served by the CP, so there is no UI
        // process to start — the phase exists to prove the CP really answers `/`.
        spawn: false,
        port,
        url: `http://127.0.0.1:${port}${entry.path}`,
        health: entry.health,
        okStatus: entry.okStatus,
      };
      continue;
    }
    const exe = exePathFor(name, { installDir, exes });
    const pgData = join(dataDir, 'pg');
    const args = (entry.args ?? []).map((arg) =>
      String(arg)
        .replaceAll('{pgData}', pgData)
        .replaceAll('{dataDir}', dataDir)
        .replaceAll('{pgPort}', String(derived.ports.postgres)),
    );
    services[name] = {
      name,
      exe,
      args,
      cwd: dirname(exe),
      port,
      url: `http://127.0.0.1:${port}${entry.path ?? ''}`,
      health: entry.health,
      okStatus: entry.okStatus,
      pgData: name === 'pg' ? pgData : undefined,
      logPaths: { out: join(logDir, `${name}.out.log`), err: join(logDir, `${name}.err.log`) },
    };
  }
  return services;
}

/**
 * Environment for one service. Mirrors `scripts/stack-run.mjs`:
 * stack defaults only fill what the caller did not set, and NO_PROXY is scrubbed for the
 * Agent (bracketed `[::1]` breaks httpx URLPatterns — see sanitizeNoProxyEnv).
 */
export function buildServiceEnv(name, { derived, baseEnv = process.env, buildCommit = null }) {
  const env = { ...baseEnv, ...stackEnvDefaults(derived, baseEnv), XIHE_STACK_ID: derived.stackId };
  env.XIHE_ENV ??= 'prod';
  // G12（task-154）：与 dev-stack 同一口径 —— 只注入 env，项目侧仍只读 env（env-first）。
  // 传 `buildCommit` 时**总是**写一个键（缺失即空串），这样三个服务的读取行为一致；
  // 不传则保持原样（既有调用方/单测不受影响）。
  if (buildCommit) Object.assign(env, buildCommitEnv(buildCommit));
  return name === 'agent' ? sanitizeNoProxyEnv(env) : env;
}

export function planPhases({ services, timeouts = {}, pollMs, skip = [] }) {
  const budget = {
    pg: timeouts.pg ?? DEFAULT_TIMEOUTS.pgMs,
    cp: timeouts.cp ?? DEFAULT_TIMEOUTS.cpMs,
    agent: timeouts.agent ?? DEFAULT_TIMEOUTS.agentMs,
    runtime: timeouts.runtime ?? DEFAULT_TIMEOUTS.runtimeMs,
    ui: timeouts.ui ?? DEFAULT_TIMEOUTS.uiMs,
  };
  const phases = [];
  for (const name of ['pg', 'cp', 'agent', 'runtime', 'ui']) {
    if (skip.includes(name) || !services[name]) continue;
    phases.push({
      name,
      services: [name],
      timeoutMs: budget[name],
      pollMs,
      failureHint: () => PHASE_HINTS[name],
    });
  }
  return phases;
}

/* ---------------------------------------------------------------- probes */

function tcpProbe(port, timeoutMs = 1500) {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      done(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ listening: true, state: 'tcp accept' }));
    socket.once('timeout', () => finish({ listening: false, state: `tcp timeout ${timeoutMs}ms` }));
    socket.once('error', (error) => finish({ listening: false, state: `tcp ${error.code ?? error.message}` }));
  });
}

function httpProbe(url, okStatus, timeoutMs = 2000) {
  return new Promise((done) => {
    const request = httpGet(url, { timeout: timeoutMs }, (response) => {
      response.resume();
      const status = response.statusCode ?? 0;
      done({
        listening: true,
        httpStatus: status,
        ready: okStatus === undefined ? status < 500 : status === okStatus,
        state: `HTTP ${status}`,
      });
    });
    request.once('timeout', () => {
      request.destroy();
      done({ listening: false, state: `http timeout ${timeoutMs}ms` });
    });
    request.once('error', (error) => done({ listening: false, state: `http ${error.code ?? error.message}` }));
  });
}

export function makeProbe({ timeoutMs = 2000 } = {}) {
  return async (name, spec) => {
    if (!spec) return { ready: false, state: 'no manifest entry' };
    if (spec.health === 'tcp') {
      const result = await tcpProbe(spec.port, timeoutMs);
      return { ...result, ready: Boolean(result.listening), url: `tcp://127.0.0.1:${spec.port}` };
    }
    const result = await httpProbe(spec.url, spec.okStatus, timeoutMs);
    return { ...result, url: spec.url };
  };
}

/* ------------------------------------------------------- listeners/pids */

/** `netstat -ano` → [{pid, local}] for TCP LISTENING rows (no PowerShell dependency). */
export function parseNetstatListeners(output) {
  const rows = [];
  for (const line of String(output).split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0].toUpperCase() !== 'TCP') continue;
    if (!/LISTENING/i.test(parts[parts.length - 2])) continue;
    const pid = Number(parts[parts.length - 1]);
    if (Number.isInteger(pid) && pid > 0) rows.push({ local: parts[1], pid });
  }
  return rows;
}

function listenerPort(row) {
  const match = /:(\d+)$/.exec(row.local);
  return match ? Number(match[1]) : null;
}

function listListeners(ports) {
  if (!isWindows) return [];
  const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
  const rows = parseNetstatListeners(result.stdout ?? '');
  const wanted = new Set(ports);
  return rows.filter((row) => wanted.has(listenerPort(row))).map((row) => ({ ...row, port: listenerPort(row) }));
}

function imageName(pid) {
  const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const match = /^"([^"]+)"/.exec((result.stdout ?? '').trim());
  return match ? match[1] : null;
}

function processAlive(pid) {
  if (!isWindows || !pid) return false;
  const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return (result.stdout ?? '').includes(String(pid));
}

function killTree(pid) {
  if (!isWindows) {
    try {
      process.kill(-pid, 'SIGTERM');
      return { ok: true, exitCode: 0 };
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
        return { ok: true, exitCode: 0 };
      } catch (error) {
        return { ok: false, exitCode: null, error: error.message };
      }
    }
  }
  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
  return { ok: result.status === 0, exitCode: result.status };
}

/* ----------------------------------------------------------------- deps */

function makeDeps({ logDir, console_ = console }) {
  const launcherLog = join(logDir, 'launcher.log');
  const appendLog = (line) => {
    try {
      writeFileSync(launcherLog, `${line}\n`, { encoding: 'utf8', flag: 'a' });
    } catch {
      /* logging must never break the launcher */
    }
  };
  const log = (line) => {
    appendLog(line);
    console_.log(line);
  };
  const logProbe = (entry) => {
    // Every probe lands in launcher.log (the "one minute of nothing" post-mortem depends on
    // this); the console only sees state changes so a 240 s wait does not flood the terminal.
    appendLog(
      `probe at=${entry.at} step=${entry.phase} service=${entry.service} attempt=${entry.attempt}` +
        ` url=${entry.url ?? '-'} http=${entry.httpStatus ?? '-'} listen=${entry.listening ?? '-'}` +
        ` state=${JSON.stringify(entry.state)} elapsed=${(entry.elapsedMs / 1000).toFixed(2)}s`,
    );
  };
  logProbe.console = (line) => {
    appendLog(line);
    console_.log(line);
  };
  return {
    log,
    logProbe,
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    probe: makeProbe(),
    isServiceRunning: (_name, spec) => Boolean(spec?.pid) && processAlive(spec.pid),
    killTree: async (record) => killTree(record.pid),
    async spawnService(name, spec) {
      mkdirSync(logDir, { recursive: true });
      if (!existsSync(spec.exe)) throw new Error(`executable not found: ${spec.exe} (install dir / --exe ${name}=...)`);
      if (spec.pgData && !existsSync(join(spec.pgData, 'PG_VERSION'))) {
        throw new Error(`PostgreSQL data directory is not initialized: ${spec.pgData} (initdb belongs to first-run, not this slice)`);
      }
      const outFd = openSync(spec.logPaths.out, 'a');
      const errFd = openSync(spec.logPaths.err, 'a');
      const env = buildServiceEnv(name, { derived: spec.derived, baseEnv: process.env, buildCommit: spec.buildCommit ?? null });
      const child = spawn(spec.exe, spec.args, {
        cwd: spec.cwd,
        env,
        stdio: ['ignore', outFd, errFd],
        detached: true,
        windowsHide: true,
      });
      closeSync(outFd);
      closeSync(errFd);
      child.unref();
      return { pid: child.pid ?? null };
    },
  };
}

/* ------------------------------------------------------------- pid file */

function pidFilePath(logDir) {
  return join(logDir, 'launcher-pids.json');
}

function readRecord(logDir) {
  const path = pidFilePath(logDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeRecord(logDir, record) {
  mkdirSync(logDir, { recursive: true });
  writeFileSync(pidFilePath(logDir), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/* --------------------------------------------------------------- actions */

async function start({ args, derived, services, logDir }) {
  mkdirSync(logDir, { recursive: true });
  rmSync(join(logDir, 'launcher.log'), { force: true });
  const deps = makeDeps({ services, logDir });
  const previous = readRecord(logDir);
  // Reuse live pids from a previous start so `start` is idempotent.
  for (const [name, spec] of Object.entries(services)) {
    const prior = previous?.services?.[name];
    if (prior?.pid && processAlive(prior.pid)) spec.pid = prior.pid;
  }
  const phases = planPhases({ services, timeouts: args.timeouts, pollMs: args.pollMs, skip: args.skip });
  console.log(
    `[launcher] ${derived.stackId} install=${args.install} ports ui=${derived.ports.ui} cp=${derived.ports.cp} agent=${derived.ports.agent} runtime=${derived.ports.runtime} pg=${derived.ports.postgres}`,
  );
  console.log(`[launcher] order: ${phases.map((p) => p.name).join(' -> ')} (gated)`);

  const result = await runPhases({ phases, services, deps });
  const record = {
    stackId: derived.stackId,
    installDir: args.install,
    startedAt: previous?.startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    services: {},
  };
  for (const entry of result.started) {
    record.services[entry.service] = {
      pid: entry.pid,
      port: entry.port,
      exe: entry.exe,
      startedAt: entry.startedAt,
      logPaths: entry.logPaths,
    };
  }
  for (const [name, spec] of Object.entries(services)) {
    if (spec.pid && !record.services[name]) {
      record.services[name] = { ...previous?.services?.[name], pid: spec.pid, port: spec.port };
    }
  }
  writeRecord(logDir, record);

  if (!result.ok) {
    console.error(formatFailure({ failed: result.failed, started: result.started, logDir }));
    if (args.cleanupOnFailure) {
      const stopped = await stopServices({ started: result.started, deps, verifyPorts: () => verifyPorts(derived) });
      console.error(`[launcher] cleanup-on-failure: killed=${stopped.killed.length} residual=${stopped.residual.length}`);
    } else if (result.started.length > 0) {
      console.error(`[launcher] 进程已保留供排查；排查完执行: node scripts/pkg/launcher.mjs stop --stack ${derived.stackId}`);
    }
    return 2;
  }

  const rows = phases.map((phase) => {
    const ready = result.events.find((e) => e.event === 'ready' && e.phase === phase.name);
    const spawned = result.events.find((e) => e.event === 'spawn' && e.phase === phase.name);
    return {
      step: phase.name,
      pid: spawned?.pid ?? record.services[phase.name]?.pid ?? null,
      port: services[phase.name]?.port ?? null,
      ms: ready?.elapsedMs ?? null,
    };
  });
  const totalMs = rows.reduce((sum, row) => sum + (row.ms ?? 0), 0);
  if (args.json) {
    console.log(JSON.stringify({ action: 'start', stackId: derived.stackId, ok: true, totalMs, steps: rows, logDir }, null, 2));
  } else {
    for (const row of rows) {
      console.log(`  ${row.step.padEnd(8)} pid=${String(row.pid ?? '-').padEnd(7)} port=${String(row.port ?? '-').padEnd(6)} ready in ${((row.ms ?? 0) / 1000).toFixed(2)}s`);
    }
    console.log(`[launcher] up in ${(totalMs / 1000).toFixed(2)}s -> http://127.0.0.1:${derived.ports.cp}/`);
    console.log(`[launcher] logs: ${logDir}`);
  }
  return 0;
}

async function verifyPorts(derived) {
  const record = readRecord(derived.logDir) ?? { services: {} };
  const ours = new Set(Object.values(record.services ?? {}).map((entry) => entry.pid).filter(Boolean));
  return listListeners([derived.ports.cp, derived.ports.agent, derived.ports.runtime, derived.ports.postgres])
    .filter((row) => !ours.has(row.pid))
    .map((row) => ({ ...row, image: imageName(row.pid) }));
}

async function stop({ args, derived, services, logDir }) {
  const record = readRecord(logDir);
  if (!record) {
    console.log(`[launcher] no pid file at ${pidFilePath(logDir)}; nothing recorded for ${derived.stackId}`);
  }
  const deps = makeDeps({ services, logDir });
  const started = Object.entries(record?.services ?? {}).map(([service, entry]) => ({ service, ...entry }));
  const result = await stopServices({ started, deps, verifyPorts: () => verifyPorts(derived) });
  rmSync(pidFilePath(logDir), { force: true });
  const payload = {
    action: 'stop',
    stackId: derived.stackId,
    killed: result.killed.map((k) => ({ service: k.service, pid: k.pid, alreadyGone: Boolean(k.alreadyGone), exitCode: k.exitCode ?? null })),
    residual: result.residual,
    pidFileExists: existsSync(pidFilePath(logDir)),
  };
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else {
    for (const row of payload.killed) {
      console.log(`  stop ${row.service.padEnd(8)} pid=${String(row.pid ?? '-').padEnd(7)} ${row.alreadyGone ? 'already gone' : `tree exit=${row.exitCode ?? '-'}`}`);
    }
    console.log(
      `[launcher] residual listeners on our ports: ${payload.residual.length ? payload.residual.map((r) => `${r.port}(pid=${r.pid},${r.image ?? 'unknown'})`).join(' ') : 'none'}`,
    );
    console.log(`[launcher] pid file removed=${!payload.pidFileExists}`);
  }
  return result.residual.length === 0 && !existsSync(pidFilePath(logDir)) ? 0 : 1;
}

async function status({ args, derived, services, logDir }) {
  const record = readRecord(logDir);
  const probe = makeProbe();
  const rows = [];
  for (const [name, spec] of Object.entries(services)) {
    const saved = record?.services?.[name];
    const probeResult = await probe(name, spec);
    rows.push({
      step: name,
      pid: saved?.pid ?? null,
      alive: saved?.pid ? processAlive(saved.pid) : false,
      port: spec.port,
      listening: Boolean(probeResult.listening),
      httpStatus: probeResult.httpStatus ?? null,
      url: probeResult.url ?? null,
      state: probeResult.state,
      ready: Boolean(probeResult.ready),
    });
  }
  const foreign = await verifyPorts(derived);
  const ok = rows.every((row) => row.ready) && foreign.length === 0;
  if (args.json) {
    console.log(
      JSON.stringify({ action: 'status', stackId: derived.stackId, pidFileExists: existsSync(pidFilePath(logDir)), steps: rows, foreignListeners: foreign, ok }, null, 2),
    );
  } else {
    console.log(`[launcher] status ${derived.stackId}`);
    for (const row of rows) {
      console.log(
        `  ${row.step.padEnd(8)} pid=${String(row.pid ?? '-').padEnd(7)} alive=${row.alive} port=${String(row.port).padEnd(6)} listen=${row.listening} http=${row.httpStatus ?? '-'} ready=${row.ready}`,
      );
    }
    console.log(
      `[launcher] ports held by processes this launcher does not own: ${foreign.length ? foreign.map((f) => `${f.port}(pid=${f.pid},${f.image ?? 'unknown'})`).join(' ') : 'none'}`,
    );
    console.log(`[launcher] ${ok ? 'stack is up' : 'stack is not fully up'}`);
  }
  return ok ? 0 : 1;
}

/* ------------------------------------------------------------------ main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return 0;
  }
  let derived;
  try {
    derived = deriveStack(normalizeStackArg(args.stack ?? process.env.XIHE_STACK_ID ?? DEFAULT_STACK_ID));
  } catch (error) {
    console.error(`[launcher] ERROR: ${error.message}`);
    return 2;
  }
  const installDir = resolve(args.install);
  const dataDir = resolve(args.data ?? join(installDir, '..', 'data'));
  const logDir = resolve(projectRoot, derived.logDir);
  const services = buildServices({ installDir, exes: args.exes, skip: args.skip, derived, dataDir, logDir });
  // G12（task-154）：打包安装用的是 CP exe（没有 `classes/META-INF/build-info.properties`），
  // 所以这里解析出来通常是 `unknown/missing-build-info` —— 仍然注入空串并显式记录，
  // 而不是跳过（跳过会让「没有字段」和「值为空」两种状态混在一起）。
  // 待办（不在本卡范围）：installer 组装 payload 时把 build-info 一起写进去，launcher 就能拿到真值。
  const buildCommit = resolveBuildCommit({ targetDir: join(installDir, 'cp') });
  for (const spec of Object.values(services)) {
    spec.derived = derived;
    spec.buildCommit = buildCommit;
  }
  if (args.action === 'start') {
    console.log(`[launcher] XIHE_BUILD_COMMIT=${buildCommit.value === '' ? '(空串)' : buildCommit.value} — ${describeBuildCommit(buildCommit)}`);
  }

  try {
    if (args.action === 'start') return await start({ args, derived, services, logDir });
    if (args.action === 'stop') return await stop({ args, derived, services, logDir });
    return await status({ args, derived, services, logDir });
  } catch (error) {
    console.error(`[launcher] ERROR: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
