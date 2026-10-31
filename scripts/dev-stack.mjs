#!/usr/bin/env node
/**
 * XH dev-stack — detached, turn-surviving full-stack supervisor (PLAN-0603 B′).
 *
 * Why: `mise run dev:host` is a foreground mise task; when the launching terminal /
 * agent turn ends the child tree is reaped. `scripts/ports.mjs dev xihe` is already
 * detached but can only start services that declare a `runner` (xihe: ui only) and
 * always uses the main checkout as cwd. This supervisor launches CP / Agent /
 * Runtime / UI through the existing `scripts/stack-run.mjs` targets (which own the
 * per-service command, cwd and stack env derivation), keeps per-service logs and a
 * PID JSON, waits for HTTP readiness, and supports status / stop / residual checks.
 *
 * Contract:
 *   node scripts/dev-stack.mjs start  [--stack N] [--cwd <repo>] [--with-pg] [--json] [--timeout S]
 *   node scripts/dev-stack.mjs status [--stack N] [--cwd <repo>] [--json]
 *   node scripts/dev-stack.mjs stop   [--stack N] [--cwd <repo>] [--with-pg] [--json]
 *
 * - Stack ports come from `<one>/scripts/ports.mjs`'s deriveStack() (single SSOT).
 * - Works from the main checkout and from `.worktrees/<name>`: project root defaults
 *   to the directory that contains this script; `--cwd` points it at another checkout.
 * - `stop` keeps PostgreSQL by default; pass `--with-pg` to stop the compose container
 *   (volumes are never removed).
 * - No `--next`: xihe uses explicit stack slots. Use `--stack <n>`.
 *
 * Zero dependencies, Node 24+.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptProjectRoot = resolve(dirname(scriptPath), '..');
const isWindows = process.platform === 'win32';
const SERVICES = ['cp', 'runtime', 'agent', 'ui'];
const ENDPOINTS = {
  cp: '/api/v1/auth/bootstrap-status',
  runtime: '/health',
  agent: '/internal/v1/agent/health',
  ui: '/',
};

/* ------------------------------------------------------------------ args */

function usage(exitCode = 2) {
  console.log('usage: node scripts/dev-stack.mjs <start|status|stop> [options]');
  console.log('  --stack N        stack id (stack-1..stack-8); default XIHE_STACK_ID or stack-1');
  console.log('  --cwd <repo>     checkout to run (default: this script\'s project root)');
  console.log('  --with-pg        start (start) / stop (stop) this stack\'s PostgreSQL container');
  console.log('  --timeout <s>    readiness timeout for start (default 300)');
  console.log('  --json           machine-readable output');
  console.log('  --help           this message');
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { action: 'status', stack: undefined, cwd: undefined, withPg: false, json: false, timeout: 300 };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') usage(0);
    else if (arg === '--json') args.json = true;
    else if (arg === '--with-pg') args.withPg = true;
    else if (arg === '--stack' || arg === '--stack=') {
      args.stack = arg.includes('=') ? arg.slice('--stack='.length) : argv[(i += 1)];
    } else if (arg.startsWith('--stack=')) args.stack = arg.slice('--stack='.length);
    else if (arg === '--cwd') args.cwd = argv[(i += 1)];
    else if (arg.startsWith('--cwd=')) args.cwd = arg.slice('--cwd='.length);
    else if (arg === '--timeout') args.timeout = Number(argv[(i += 1)]);
    else if (arg.startsWith('--timeout=')) args.timeout = Number(arg.slice('--timeout='.length));
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else rest.push(arg);
  }
  if (rest.length > 0) args.action = rest[0];
  if (!['start', 'status', 'stop'].includes(args.action)) usage(2);
  if (!Number.isFinite(args.timeout) || args.timeout <= 0) throw new Error('--timeout must be a positive number of seconds');
  return args;
}

/* ------------------------------------------------------------- one root */

function findOneRoot(start) {
  let current = resolve(start);
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(current, 'config', 'ports.mjs')) && existsSync(join(current, 'scripts', 'ports.mjs'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

const oneRoot = findOneRoot(scriptProjectRoot);
if (!oneRoot) {
  console.error(`[dev-stack] ERROR: cannot locate the one workspace root above ${scriptProjectRoot}`);
  process.exit(2);
}
const portsModule = await import(pathToFileURL(join(oneRoot, 'scripts', 'ports.mjs')).href);
const { deriveStack, normalizeStackArg } = portsModule;

/* ---------------------------------------------------------------- utils */

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function isPortListening(port, timeoutMs = 500) {
  return new Promise((done) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      done(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function httpStatus(url, timeoutMs = 1500) {
  return new Promise((done) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      response.resume();
      done(response.statusCode ?? 0);
    });
    request.once('timeout', () => {
      request.destroy();
      done(null);
    });
    request.once('error', () => done(null));
  });
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commandLine(pid) {
  if (!isWindows) return '';
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`],
    { encoding: 'utf8', windowsHide: true },
  );
  return result.status === 0 ? String(result.stdout || '') : '';
}

/** The recorded PID is the cmd.exe wrapper started by `start`; never kill pid-reused strangers. */
function looksLikeOurWrapper(pid) {
  if (!isWindows) return true;
  const line = commandLine(pid);
  return /stack-run\.mjs/i.test(line);
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function checkProjectRoot(projectRoot) {
  const missing = ['packages/control-plane', 'packages/runtime', 'packages/agent', 'packages/ui', 'scripts/stack-run.mjs'].filter(
    (rel) => !existsSync(join(projectRoot, rel)),
  );
  if (missing.length > 0) {
    throw new Error(`not an A03-xihe checkout (missing ${missing.join(', ')}): ${projectRoot}`);
  }
}

function tableRows(rows, columns) {
  const lines = [];
  for (const column of columns) lines.push(column);
  return lines;
}

/* --------------------------------------------------------------- context */

const args = parseArgs(process.argv.slice(2));
const derived = (() => {
  try {
    return deriveStack(normalizeStackArg(args.stack ?? process.env.XIHE_STACK_ID ?? undefined));
  } catch (error) {
    console.error(`[dev-stack] ERROR: ${error.message}`);
    process.exit(2);
  }
})();
const projectRoot = resolve(args.cwd ?? scriptProjectRoot);
try {
  checkProjectRoot(projectRoot);
} catch (error) {
  console.error(`[dev-stack] ERROR: ${error.message}`);
  process.exit(2);
}
const logDir = resolve(projectRoot, derived.logDir);
const pidFile = join(logDir, 'dev-stack-pids.json');
const stackRun = join(projectRoot, 'scripts', 'stack-run.mjs');
const ports = derived.ports;
const childEnv = {
  ...process.env,
  XIHE_STACK_ID: derived.stackId,
  XIHE_ENV: process.env.XIHE_ENV ?? 'dev',
};

function endpointUrl(service) {
  return `http://127.0.0.1:${ports[service]}${ENDPOINTS[service]}`;
}

/* ---------------------------------------------------------------- spawn */

function spawnDetached(service, outPath, errPath) {
  const inner = `node "${stackRun}" ${service}`;
  if (isWindows) {
    const safeCwd = projectRoot.replace(/'/g, "''");
    const script =
      `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/s','/c','${inner.replace(/'/g, "''")} 1> "${outPath.replace(/'/g, "''")}" 2> "${errPath.replace(/'/g, "''")}"' ` +
      `-WorkingDirectory '${safeCwd}' -WindowStyle Hidden -PassThru; $p.Id`;
    return new Promise((done) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.once('error', () => done(null));
      child.once('exit', () => {
        const pid = Number(stdout.trim().split(/\r?\n/).pop());
        done(Number.isInteger(pid) && pid > 0 ? pid : null);
      });
    });
  }
  const outFd = openSync(outPath, 'a');
  const errFd = openSync(errPath, 'a');
  const child = spawn(process.execPath, [stackRun, service], {
    cwd: projectRoot,
    env: childEnv,
    detached: true,
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
  });
  child.unref();
  closeSync(outFd);
  closeSync(errFd);
  return Promise.resolve(child.pid ?? null);
}

/* -------------------------------------------------------------- readiness */

async function probeService(service) {
  const listening = await isPortListening(ports[service]);
  if (!listening) return { service, port: ports[service], listening, status: null, ready: false };
  const status = await httpStatus(endpointUrl(service));
  const ready = status !== null && status < 500;
  return { service, port: ports[service], listening, status, ready };
}

async function waitReady(timeoutSeconds, servicesToWait) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const state = {};
  while (Date.now() < deadline) {
    let allReady = true;
    for (const service of servicesToWait) {
      const result = await probeService(service);
      state[service] = result;
      if (!result.ready) allReady = false;
    }
    if (allReady) return { ready: true, state };
    if (!args.json) {
      const parts = servicesToWait.map((s) => `${s}=${state[s].ready ? 'ready' : state[s].listening ? 'http?' : 'port?'}`);
      console.log(`[dev-stack] waiting ${Math.round((deadline - Date.now()) / 1000)}s: ${parts.join(' ')}`);
    }
    await sleep(3000);
  }
  for (const service of servicesToWait) state[service] ??= await probeService(service);
  return { ready: servicesToWait.every((s) => state[s].ready), state };
}

/* ------------------------------------------------------------------- pg */

async function ensurePg() {
  if (!args.withPg) {
    if (!(await isPortListening(ports.postgres))) {
      throw new Error(
        `PostgreSQL is not listening on ${ports.postgres}; re-run with --with-pg (or start this stack's PG first)`,
      );
    }
    return { started: false, listening: true };
  }
  console.log(`[dev-stack] starting PostgreSQL for ${derived.stackId} (compose project ${derived.composeProject}) ...`);
  const result = spawnSync(process.execPath, [stackRun, 'pg', '--stack', derived.stackId], {
    cwd: projectRoot,
    env: childEnv,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`PostgreSQL start failed (exit ${result.status}); see docker compose output above`);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await isPortListening(ports.postgres)) return { started: true, listening: true };
    await sleep(1000);
  }
  throw new Error(`PostgreSQL did not listen on ${ports.postgres} within 60s`);
}

async function stopPg() {
  console.log(`[dev-stack] stopping PostgreSQL for ${derived.stackId} (compose project ${derived.composeProject}; volume kept) ...`);
  const result = spawnSync('docker', ['compose', '-p', derived.composeProject, 'stop', 'postgres'], {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`failed to stop PostgreSQL (exit ${result.status})`);
}

/* ---------------------------------------------------------------- start */

async function start() {
  mkdirSync(logDir, { recursive: true });
  console.log(
    `[dev-stack] ${args.action} ${derived.stackId} cwd=${projectRoot} ports ui=${ports.ui} cp=${ports.cp} agent=${ports.agent} runtime=${ports.runtime} pg=${ports.postgres}`,
  );
  console.log(`[dev-stack] logs: ${logDir}`);

  const pg = await ensurePg();
  const previous = readJson(pidFile) ?? {};
  const record = {
    stackId: derived.stackId,
    projectRoot,
    startedAt: previous.startedAt ?? new Date().toISOString(),
    pgStarted: pg.started || Boolean(previous.pgStarted),
    services: {},
  };

  for (const service of SERVICES) {
    const prior = previous.services?.[service];
    if (prior?.pid && processAlive(prior.pid) && looksLikeOurWrapper(prior.pid)) {
      record.services[service] = prior;
      console.log(`[dev-stack] ${service} already running (pid ${prior.pid})`);
      continue;
    }
    if (await isPortListening(ports[service])) {
      throw new Error(
        `${service}: port ${ports[service]} is already in use by another process; stop it or use a different --stack`,
      );
    }
    const outPath = join(logDir, `${service}.out.log`);
    const errPath = join(logDir, `${service}.err.log`);
    const pid = await spawnDetached(service, outPath, errPath);
    if (!pid) throw new Error(`${service}: launcher failed; see ${outPath} / ${errPath}`);
    record.services[service] = { pid, port: ports[service], startedAt: new Date().toISOString() };
    writeJson(pidFile, record);
    console.log(`[dev-stack] started ${service} (pid ${pid}) port=${ports[service]} log=${outPath}`);
  }
  writeJson(pidFile, record);
  console.log(`[dev-stack] pid file: ${pidFile}`);
  console.log(`[dev-stack] note: CP compiles on boot (~60-120s); Runtime uses the cargo cache; waiting for readiness ...`);

  const { ready, state } = await waitReady(args.timeout, SERVICES);
  const rows = SERVICES.map((service) => ({
    service,
    port: ports[service],
    pid: record.services[service]?.pid ?? null,
    listening: state[service]?.listening ?? false,
    httpStatus: state[service]?.status ?? null,
    ready: state[service]?.ready ?? false,
  }));

  if (args.json) {
    console.log(
      JSON.stringify(
        { action: 'start', stackId: derived.stackId, projectRoot, pg, ready, services: rows, logDir },
        null,
        2,
      ),
    );
  } else {
    for (const row of rows) {
      console.log(
        `  ${row.service.padEnd(8)} pid=${String(row.pid ?? '-').padEnd(7)} port=${String(row.port).padEnd(6)} ` +
          `listen=${row.listening} http=${row.httpStatus ?? '-'} ready=${row.ready}`,
      );
    }
    console.log(`[dev-stack] ${ready ? 'all four services are ready' : `not ready within ${args.timeout}s`}`);
  }
  if (!ready) {
    console.error(`[dev-stack] readiness timeout; inspect ${logDir}/*.err.log and retry status`);
    process.exitCode = 2;
  }
}

/* --------------------------------------------------------------- status */

async function status() {
  const record = readJson(pidFile);
  const rows = [];
  for (const service of SERVICES) {
    const saved = record?.services?.[service];
    const probe = await probeService(service);
    rows.push({
      service,
      port: ports[service],
      pid: saved?.pid ?? null,
      alive: saved?.pid ? processAlive(saved.pid) : false,
      listening: probe.listening,
      httpStatus: probe.status,
      ready: probe.ready,
    });
  }
  const pgListening = await isPortListening(ports.postgres);
  const ok = rows.every((row) => row.alive && row.listening) && pgListening;
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          action: 'status',
          stackId: derived.stackId,
          projectRoot,
          pidFile,
          pidFileExists: existsSync(pidFile),
          pg: { port: ports.postgres, listening: pgListening },
          services: rows,
          ok,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`[dev-stack] status ${derived.stackId} cwd=${projectRoot}`);
    for (const row of rows) {
      console.log(
        `  ${row.service.padEnd(8)} pid=${String(row.pid ?? '-').padEnd(7)} alive=${row.alive} ` +
          `port=${String(row.port).padEnd(6)} listen=${row.listening} http=${row.httpStatus ?? '-'} ready=${row.ready}`,
      );
    }
    console.log(`  PostgreSQL port ${ports.postgres} listen=${pgListening}`);
    console.log(`[dev-stack] ${ok ? 'stack is up' : 'stack is not fully up'}`);
  }
  if (!ok) process.exitCode = 1;
}

/* ----------------------------------------------------------------- stop */

async function stop() {
  const record = readJson(pidFile);
  if (!record) {
    console.log(`[dev-stack] no pid file at ${pidFile}; nothing recorded for this stack`);
  } else {
    for (const service of SERVICES) {
      const saved = record.services?.[service];
      if (!saved?.pid) continue;
      if (!processAlive(saved.pid)) {
        console.log(`[dev-stack] ${service} pid ${saved.pid} not running`);
        continue;
      }
      if (!looksLikeOurWrapper(saved.pid)) {
        console.error(`[dev-stack] WARN: pid ${saved.pid} (${service}) does not look like our wrapper; skipping kill`);
        continue;
      }
      if (isWindows) {
        spawnSync('taskkill', ['/PID', String(saved.pid), '/T', '/F'], { stdio: 'inherit', windowsHide: true });
      } else {
        try {
          process.kill(-saved.pid, 'SIGTERM');
        } catch {
          try {
            process.kill(saved.pid, 'SIGTERM');
          } catch {
            /* already gone */
          }
        }
      }
      console.log(`[dev-stack] stopped ${service} (pid ${saved.pid}, tree)`);
    }
  }

  const deadline = Date.now() + 15000;
  let remaining = SERVICES.filter((service) => ports[service]);
  while (Date.now() < deadline) {
    remaining = [];
    for (const service of SERVICES) if (await isPortListening(ports[service])) remaining.push(service);
    if (remaining.length === 0) break;
    await sleep(500);
  }
  if (existsSync(pidFile)) rmSync(pidFile, { force: true });

  let pg = { port: ports.postgres, listening: await isPortListening(ports.postgres), stopped: false };
  if (args.withPg) {
    await stopPg();
    pg = { port: ports.postgres, listening: await isPortListening(ports.postgres), stopped: true };
  }

  const residual = {
    listeningServices: remaining,
    pgListening: pg.listening,
    pgStopped: args.withPg,
    pidFileExists: existsSync(pidFile),
  };
  if (args.json) {
    console.log(JSON.stringify({ action: 'stop', stackId: derived.stackId, projectRoot, ...residual }, null, 2));
  } else {
    console.log(`[dev-stack] residual: services=${remaining.length ? remaining.join(',') : 'none'} pgListening=${pg.listening} pidFile=${residual.pidFileExists}`);
    if (!args.withPg) console.log('[dev-stack] PostgreSQL left running (pass --with-pg to stop the container; volume always kept)');
  }
  if (remaining.length > 0 || residual.pidFileExists) process.exitCode = 1;
}

/* ----------------------------------------------------------------- main */

try {
  if (args.action === 'start') await start();
  else if (args.action === 'status') await status();
  else await stop();
} catch (error) {
  console.error(`[dev-stack] ERROR: ${error.message}`);
  process.exit(2);
}
