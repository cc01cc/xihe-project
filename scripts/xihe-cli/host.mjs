import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CliError } from './provider.mjs';

const PREFLIGHT_REQUEST_TIMEOUT_MS = 1_500;
const TOOL_TIMEOUT_MS = 5_000;
const CONFIG_IMPORT_TIMEOUT_MS = 30_000;
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

const toolChecks = [
  { name: 'mise', command: 'mise', args: ['--version'] },
  { name: 'Java', command: 'java', args: ['--version'] },
  { name: 'Node.js', command: 'node', args: ['--version'] },
  { name: 'pnpm', command: 'pnpm', args: ['--version'], windowsCmd: true },
  { name: 'uv', command: 'uv', args: ['--version'] },
  { name: 'Cargo', command: 'cargo', args: ['--version'] },
  { name: 'Docker Compose', command: 'docker', args: ['compose', 'version'] },
  { name: 'Docker Engine', command: 'docker', args: ['version', '--format', '{{.Server.Version}}'] },
];

const portChecks = [
  { name: 'UI', port: 12630, url: 'http://127.0.0.1:12630/' },
  { name: 'CP', port: 12631, url: 'http://127.0.0.1:12631/actuator/health' },
  { name: 'Agent', port: 12632, url: 'http://127.0.0.1:12632/internal/v1/agent/health' },
  { name: 'Runtime', port: 12633, url: 'http://127.0.0.1:12633/ready' },
  { name: 'PostgreSQL', port: 12634 },
];

function runTool(item, env, spawnSyncImpl) {
  let command = item.command;
  let args = item.args;
  if (process.platform === 'win32' && item.windowsCmd) {
    command = env.ComSpec ?? 'cmd.exe';
    args = ['/d', '/s', '/c', `${item.command}.cmd ${item.args.join(' ')}`];
  }
  const result = spawnSyncImpl(command, args, {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
    timeout: TOOL_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return { status: 'missing', errorCode: result.error?.code ?? `EXIT_${result.status ?? 'UNKNOWN'}` };
  }
  const version = `${result.stdout ?? ''}${result.stderr ?? ''}`.split(/\r?\n/, 1)[0].trim().slice(0, 120);
  return { status: 'available', version };
}

function probePort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => resolve({
      free: false,
      occupied: error.code === 'EADDRINUSE',
      errorCode: error.code,
    }));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve({ free: true })));
  });
}

async function probeHttp(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(PREFLIGHT_REQUEST_TIMEOUT_MS) });
    return response.ok ? 'ready' : `http-${response.status}`;
  } catch {
    return 'unresponsive';
  }
}

async function probeTcp(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (state) => {
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(PREFLIGHT_REQUEST_TIMEOUT_MS, () => done('unresponsive'));
    socket.once('connect', () => done('listening'));
    socket.once('error', () => done('unresponsive'));
  });
}

export async function checkDevelopmentEnvironment({
  env,
  fetchImpl = fetch,
  spawnSyncImpl = spawnSync,
  portProbeFn = probePort,
  httpProbeFn = probeHttp,
  tcpProbeFn = probeTcp,
}) {
  const checks = [];
  let failed = false;
  for (const item of toolChecks) {
    const result = runTool(item, env, spawnSyncImpl);
    checks.push({ category: 'tool', name: item.name, ...result });
    if (result.status !== 'available') failed = true;
  }

  const hostRoot = env.XIHE_WORKSPACE_HOST_ROOT || path.join(projectRoot, '.xihe-workspaces');
  let hostRootStatus = 'not-created';
  try {
    const stat = fs.statSync(hostRoot);
    hostRootStatus = stat.isDirectory() ? 'present' : 'not-a-directory';
    if (stat.isDirectory()) fs.accessSync(hostRoot, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      hostRootStatus = 'unavailable';
      failed = true;
    }
  }
  checks.push({ category: 'storage', name: 'workspace host root', status: hostRootStatus });

  for (const item of portChecks) {
    const state = await portProbeFn(item.port);
    if (state.free) {
      checks.push({ category: 'port', name: item.name, port: item.port, status: 'free' });
      continue;
    }
    if (!state.occupied) {
      checks.push({ category: 'port', name: item.name, port: item.port, status: 'probe-error', errorCode: state.errorCode });
      failed = true;
      continue;
    }
    const service = item.url ? await httpProbeFn(item.url, fetchImpl) : await tcpProbeFn(item.port);
    const status = service === 'ready' || service === 'listening' || service === 'responding'
      ? service
      : 'occupied-unresponsive';
    checks.push({ category: 'port', name: item.name, port: item.port, status });
    if (status === 'occupied-unresponsive') failed = true;
  }

  const localConfig = path.join(projectRoot, 'config.import.local.jsonc');
  const envFiles = ['.env', `.env.${env.XIHE_ENV || 'dev'}`, '.env.local']
    .filter((name) => fs.existsSync(path.join(projectRoot, name)));
  checks.push({ category: 'config', name: 'config.import.local.jsonc', status: fs.existsSync(localConfig) ? 'present' : 'absent' });
  checks.push({ category: 'config', name: 'dotenv file names', status: envFiles.length ? envFiles.join(',') : 'none' });
  checks.push({
    category: 'config',
    name: 'Xiaomi API key in current process',
    status: env.XIHE_XIAOMI_API_KEY ? 'present' : 'not-in-process',
  });
  checks.push({
    category: 'config',
    name: 'real E2E Xiaomi key in current process',
    status: env.XIHE_E2E_REAL_XIAOMI_KEY ? 'present' : 'not-in-process',
  });
  return { ok: !failed, checks };
}

function parseCommandOptions(args, valueOptions) {
  const values = {};
  const positionals = [];
  const allowed = new Set(valueOptions);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const separator = token.indexOf('=');
    const flag = separator === -1 ? token : token.slice(0, separator);
    if (!allowed.has(flag)) throw new CliError('INVALID_ARGUMENT', `Unknown option ${flag}`);
    const value = separator === -1 ? args[index + 1] : token.slice(separator + 1);
    if (value === undefined || (separator === -1 && value.startsWith('--'))) {
      throw new CliError('INVALID_ARGUMENT', `Option ${flag} requires a value`);
    }
    values[flag] = value;
    if (separator === -1) index += 1;
  }
  return { values, positionals };
}

function secretValues(env) {
  return Object.entries(env)
    .filter(([name, value]) => /(API_KEY|_KEY|PASSWORD|TOKEN|SECRET)$/i.test(name) && typeof value === 'string' && value.length > 0)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
}

function redactSecrets(text, secrets) {
  let result = text;
  for (const secret of secrets) result = result.replaceAll(secret, '***');
  return result;
}

export async function runConfigImport({
  args,
  env,
  spawnSyncImpl = spawnSync,
  promptSecret,
  json = false,
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  const { positionals, values } = parseCommandOptions(args, ['--email']);
  if (positionals.length > 1) throw new CliError('INVALID_ARGUMENT', 'config import accepts one file path.');
  const importPath = path.resolve(projectRoot, positionals[0] ?? 'config.import.local.jsonc');
  if (!fs.existsSync(importPath) || !fs.statSync(importPath).isFile()) {
    throw new CliError('CONFIG_FILE_NOT_FOUND', 'The requested config import file does not exist.');
  }
  const password = env.XIHE_DEV_ADMIN_PASSWORD || await promptSecret('XH local admin password');
  const importerPath = path.join(projectRoot, 'scripts', 'dev-host-import-config.mjs');
  const childEnv = {
    ...env,
    XIHE_DEV_ADMIN_PASSWORD: password,
    XIHE_DEV_IMPORT_CONFIG_PATH: importPath,
    ...(values['--email'] ? { XIHE_DEV_ADMIN_EMAIL: values['--email'] } : {}),
  };
  const child = spawnSyncImpl(process.execPath, [importerPath], {
    cwd: projectRoot,
    env: childEnv,
    encoding: 'utf8',
    timeout: CONFIG_IMPORT_TIMEOUT_MS,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  if (child.error) {
    throw new CliError(child.error.code === 'ETIMEDOUT' ? 'OPERATION_OUTCOME_UNKNOWN' : 'CONFIG_IMPORT_FAILED', 'Config import helper failed; inspect the imported configuration before retrying.');
  }
  const secrets = secretValues(childEnv);
  if (child.status === 70) {
    throw new CliError('OPERATION_OUTCOME_UNKNOWN', 'Config import outcome is unknown; inspect config state before retrying.');
  }
  if (child.status !== 0) throw new CliError('CONFIG_IMPORT_FAILED', `Config import failed (exit ${child.status ?? 'unknown'}).`);
  if (child.stdout && !json) stdout.write(redactSecrets(child.stdout, secrets));
  if (child.stderr && !json) stderr.write(redactSecrets(child.stderr, secrets));
  return { importedFile: path.basename(importPath) };
}

function forwardRedacted(stream, destination, secrets) {
  if (!stream) return;
  const maxSecretLength = Math.max(0, ...secrets.map((value) => value.length));
  let pending = '';
  const flush = (final) => {
    let splitAt = final ? pending.length : Math.max(0, pending.length - maxSecretLength + 1);
    if (!final && splitAt > 0) {
      for (const secret of secrets) {
        let start = pending.indexOf(secret);
        while (start >= 0 && start < splitAt) {
          if (start + secret.length > splitAt) splitAt = start;
          start = pending.indexOf(secret, start + 1);
        }
      }
    }
    if (splitAt <= 0) return;
    const safe = pending.slice(0, splitAt);
    pending = pending.slice(splitAt);
    destination.write(redactSecrets(safe, secrets));
  };
  stream.on('data', (chunk) => {
    pending += chunk.toString('utf8');
    flush(false);
  });
  stream.on('end', () => flush(true));
}

function spawnRealRunner({
  spec,
  env,
  spawnImpl = spawn,
  json = false,
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  const runnerPath = path.join(projectRoot, 'scripts', 'e2e-host.mjs');
  const runnerEnv = { ...env, XIHE_E2E_LLM_MODE: 'real' };
  const args = [runnerPath, '--llm-mode=real', '--retries=0', spec];
  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, args, {
      cwd: projectRoot,
      env: runnerEnv,
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const secrets = secretValues(runnerEnv);
    forwardRedacted(child.stdout, json ? stderr : stdout, secrets);
    forwardRedacted(child.stderr, stderr, secrets);
    const onInterrupt = () => child.kill('SIGINT');
    process.once('SIGINT', onInterrupt);
    child.once('error', (error) => {
      process.removeListener('SIGINT', onInterrupt);
      reject(new CliError('REAL_RUNNER_START_FAILED', `Could not start the host runner (${error.code ?? 'unknown'}).`));
    });
    child.once('close', (code, signal) => {
      process.removeListener('SIGINT', onInterrupt);
      if (signal) reject(new CliError('REAL_RUNNER_INTERRUPTED', `Host runner stopped by ${signal}.`));
      else if (code !== 0) reject(new CliError('REAL_TEST_FAILED', `Host runner failed with exit ${code ?? 'unknown'}; it was not automatically rerun.`));
      else resolve({ runner: 'e2e-host', spec, llmMode: 'real', playwrightRetries: 0 });
    });
  });
}

export async function runRealTest({
  args,
  env,
  spawnImpl,
  json = false,
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  const { positionals, values } = parseCommandOptions(args, ['--route']);
  if (positionals.length !== 1) throw new CliError('INVALID_ARGUMENT', 'test real requires exactly one Playwright spec path.');
  const spec = positionals[0].replaceAll('\\', '/');
  if (!/^e2e\/real\/[A-Za-z0-9._-]+\.spec\.ts$/.test(spec)) {
    throw new CliError('INVALID_ARGUMENT', 'Real test must be one spec under e2e/real/.');
  }
  if (!env.XIHE_E2E_REAL_XIAOMI_KEY) throw new CliError('REAL_PROVIDER_KEY_REQUIRED', 'Set XIHE_E2E_REAL_XIAOMI_KEY before starting a real test.');
  const route = values['--route'] ?? env.XIHE_E2E_REAL_ROUTE;
  if (!route || !['native', 'openai-compat'].includes(route)) {
    throw new CliError('REAL_PROVIDER_ROUTE_REQUIRED', 'Set XIHE_E2E_REAL_ROUTE to native or openai-compat.');
  }
  const report = json ? stderr : stdout;
  report.write(`Real test preflight: spec=${spec} route=${route} mode=real retries=0\n`);
  return spawnRealRunner({ spec, env: { ...env, XIHE_E2E_REAL_ROUTE: route }, spawnImpl, json, stdout, stderr });
}
