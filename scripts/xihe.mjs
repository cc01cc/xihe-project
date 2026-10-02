#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CliError,
  addProvider,
  getApiBase,
  initProvider,
  listProviderConnections,
  login,
  normalizeScope,
  parseOptions,
  promptSecret,
  requireOption,
  updateProvider,
  verifyConnection,
} from './xihe-cli/provider.mjs';
import { checkDevelopmentEnvironment, runConfigImport, runRealTest } from './xihe-cli/host.mjs';

function splitGlobalJsonFlag(args) {
  const rest = [];
  let json = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else rest.push(arg);
  }
  return { args: rest, json };
}

function parseCommandOptions(args, valueOptions) {
  return parseOptions(args, valueOptions);
}

function helpText() {
  return [
    'XH development and operations CLI',
    '',
    'Usage:',
    '  mise run xihe -- provider list [--scope <USER|WORKSPACE>]',
    '  node scripts/xihe.mjs dev check [--json]',
    '  node scripts/xihe.mjs dev init --provider <id> --scope <USER|WORKSPACE> --label <label> [--models <id,id>] [--api-key-env <name>]',
    '  node scripts/xihe.mjs config import [file]',
    '  node scripts/xihe.mjs provider add <id> --scope <USER|WORKSPACE> --label <label> [--models <id,id>] [--api-key-env <name>]',
    '  node scripts/xihe.mjs provider update <id> [--label <label>] [--base-url <url>] [--models <id,id>] [--api-key-env <name>]',
    '  node scripts/xihe.mjs provider list [--scope <USER|WORKSPACE>]',
    '  node scripts/xihe.mjs provider verify <id>',
    '  node scripts/xihe.mjs test real <e2e/real/spec.spec.ts> [--route <native|openai-compat>]',
    '',
    'Secrets are read from environment variables or a no-echo TTY prompt; never pass secret values as arguments.',
    'Real E2E uses XIHE_E2E_REAL_XIAOMI_KEY and does not test Provider Connection leases.',
  ].join('\n');
}

export async function runCommand(argv, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const spawnSyncImpl = dependencies.spawnSyncImpl;
  const spawnImpl = dependencies.spawnImpl;
  const prompt = dependencies.promptSecret ?? ((label) => promptSecret(label));
  const { args, json } = splitGlobalJsonFlag([...argv]);
  const [group, command, ...rest] = args;

  try {
    if (!group || group === 'help' || args.includes('--help') || args.includes('-h')) {
      return { exitCode: 0, json, data: { help: helpText() } };
    }
    if (group === '--version' || group === 'version') {
      return { exitCode: 0, json, data: { version: 'development checkout' } };
    }

    if (group === 'dev' && command === 'check') {
      const parsed = parseCommandOptions(rest, []);
      if (parsed.positionals.length !== 0) throw new CliError('INVALID_ARGUMENT', 'dev check takes no positional arguments.');
      const data = await checkDevelopmentEnvironment({
        env,
        fetchImpl,
        spawnSyncImpl,
        portProbeFn: dependencies.portProbeFn,
        httpProbeFn: dependencies.httpProbeFn,
        tcpProbeFn: dependencies.tcpProbeFn,
      });
      return { exitCode: data.ok ? 0 : 1, json, data };
    }

    if (group === 'dev' && command === 'init') {
      const parsed = parseCommandOptions(rest, ['--provider', '--scope', '--label', '--api-key-env', '--base-url', '--models', '--email']);
      if (parsed.positionals.length !== 0) throw new CliError('INVALID_ARGUMENT', 'Use --provider and --scope with dev init.');
      requireOption(parsed.values, '--provider');
      normalizeScope(parsed.values['--scope']);
      if (parsed.values['--label'] !== undefined) requireOption(parsed.values, '--label');
      const apiBase = getApiBase(env);
      const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret: prompt });
      const data = await initProvider({ apiBase, fetchImpl, env, options: parsed.values, positionals: parsed.positionals, token, promptSecret: prompt });
      return { exitCode: 0, json, data };
    }

    if (group === 'config' && command === 'import') {
      const data = await runConfigImport({
        args: rest,
        env,
        spawnSyncImpl,
        promptSecret: prompt,
        json,
        stdout: dependencies.stdout,
        stderr: dependencies.stderr,
      });
      return { exitCode: 0, json, data };
    }

    if (group === 'provider') {
      const apiBase = getApiBase(env);
      let parsed;
      if (command === 'add') {
        parsed = parseCommandOptions(rest, ['--scope', '--label', '--api-key-env', '--base-url', '--models', '--email']);
      } else if (command === 'update') {
        parsed = parseCommandOptions(rest, ['--label', '--api-key-env', '--base-url', '--models', '--email']);
      } else if (command === 'list') {
        parsed = parseCommandOptions(rest, ['--scope', '--email']);
      } else if (command === 'verify') {
        parsed = parseCommandOptions(rest, ['--email']);
      } else {
        throw new CliError('INVALID_ARGUMENT', 'Unknown provider command; use add/update/list/verify.');
      }

      if (command === 'add') {
        if (parsed.positionals.length !== 1) throw new CliError('INVALID_ARGUMENT', 'provider add requires one provider ID.');
        normalizeScope(parsed.values['--scope']);
        requireOption(parsed.values, '--label');
      } else if (command === 'update') {
        if (parsed.positionals.length !== 1) throw new CliError('INVALID_ARGUMENT', 'provider update requires one connection ID.');
        if (!['--label', '--base-url', '--models', '--api-key-env'].some((key) => parsed.values[key] !== undefined)) {
          throw new CliError('INVALID_ARGUMENT', 'Provide at least one explicit field to update the connection.');
        }
        if (parsed.values['--label'] !== undefined) requireOption(parsed.values, '--label');
      } else if (command === 'list') {
        if (parsed.positionals.length !== 0) throw new CliError('INVALID_ARGUMENT', 'provider list takes no positional arguments.');
        if (parsed.values['--scope']) normalizeScope(parsed.values['--scope']);
      } else if (parsed.positionals.length !== 1) {
        throw new CliError('INVALID_ARGUMENT', 'provider verify requires one connection ID.');
      }

      const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret: prompt });
      if (command === 'add') {
        const data = await addProvider({ apiBase, fetchImpl, env, options: parsed.values, positionals: parsed.positionals, token, promptSecret: prompt });
        return { exitCode: 0, json, data };
      }
      if (command === 'update') {
        const data = await updateProvider({ apiBase, fetchImpl, env, options: parsed.values, positionals: parsed.positionals, token, promptSecret: prompt });
        return { exitCode: 0, json, data };
      }
      if (command === 'list') {
        const data = await listProviderConnections({ apiBase, fetchImpl, options: parsed.values, token });
        return { exitCode: 0, json, data };
      }
      const id = parsed.positionals[0];
      const connection = await verifyConnection({ apiBase, fetchImpl, token, id });
      return { exitCode: 0, json, data: { connection } };
    }

    if (group === 'test' && command === 'real') {
      const data = await runRealTest({
        args: rest,
        env,
        spawnImpl,
        json,
        stdout: dependencies.stdout,
        stderr: dependencies.stderr,
      });
      return { exitCode: 0, json, data };
    }

    throw new CliError('INVALID_ARGUMENT', 'Unknown XH command; run --help for available commands.');
  } catch (error) {
    const cliError = error instanceof CliError
      ? error
      : new CliError('UNEXPECTED_ERROR', 'The command failed unexpectedly; sensitive details were not printed.');
    return {
      exitCode: cliError.exitCode ?? 1,
      json,
      error: {
        code: cliError.code,
        message: cliError.message,
        ...(cliError.details && Object.keys(cliError.details).length > 0 ? { details: cliError.details } : {}),
      },
    };
  }
}

function printResult(result) {
  if (result.json) {
    const value = result.error
      ? { ok: false, error: result.error }
      : { ok: result.exitCode === 0, data: result.data };
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (result.error) {
    process.stderr.write(`[${result.error.code}] ${result.error.message}\n`);
    if (result.error.details?.connection?.id) {
      process.stderr.write(`Connection ID: ${result.error.details.connection.id}\n`);
    }
    return;
  }
  if (result.data?.help) {
    process.stdout.write(`${result.data.help}\n`);
    return;
  }
  if (Array.isArray(result.data?.checks)) {
    for (const check of result.data.checks) {
      const detail = check.version ? ` (${check.version})` : '';
      process.stdout.write(`${check.name}: ${check.status}${detail}\n`);
    }
    process.stdout.write(`Preflight: ${result.data.ok ? 'ready' : 'needs attention'}\n`);
    return;
  }
  if (Array.isArray(result.data?.connections)) {
    for (const connection of result.data.connections) {
      process.stdout.write(`${connection.id}  ${connection.scope}  ${connection.providerId}  ${connection.status}  key=${connection.hasKey ? 'yes' : 'no'}\n`);
    }
    if (result.data.connections.length === 0) process.stdout.write('No visible provider connections.\n');
    return;
  }
  const connection = result.data?.connection;
  if (connection) {
    process.stdout.write(`${result.data.action ?? 'verified'}: ${connection.id} ${connection.scope}/${connection.providerId} status=${connection.status}\n`);
    for (const warning of result.data.warnings ?? []) process.stdout.write(`Warning: ${warning}\n`);
    return;
  }
  process.stdout.write('Command completed.\n');
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const result = await runCommand(process.argv.slice(2));
  printResult(result);
  process.exitCode = result.exitCode;
}
