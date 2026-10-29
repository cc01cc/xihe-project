#!/usr/bin/env node

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  CliError,
  addProvider,
  confirmAction,
  deleteProvider,
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
import { rotateCredentials } from './xihe-cli/credential.mjs';
import { runConfigExport } from './xihe-cli/config-export.mjs';
import {
  collectStatus,
  runAuditList,
  runCheckpointList,
  runCheckpointPreviewRevert,
  runJobCancel,
  runJobList,
  runJobOutput,
  runScheduledTaskList,
  runWorkspaceGet,
  runWorkspaceList,
} from './xihe-cli/readonly.mjs';
import { runVerify } from './xihe-cli/verify.mjs';
import { runVersion } from './xihe-cli/version.mjs';
import { loadEnvFileChain } from './lib/env-file.mjs';

function splitGlobalJsonFlag(args) {
  const rest = [];
  let json = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else rest.push(arg);
  }
  return { args: rest, json };
}

function parseCommandOptions(args, valueOptions, booleanOptions = []) {
  return parseOptions(args, valueOptions, booleanOptions);
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
    '  node scripts/xihe.mjs config export [--layer instance] [--include-secrets] [--out <file>] [--force]',
    '  node scripts/xihe.mjs verify --stack <n> --email <account> --workspace <wsId> [--wait-seconds <n>] [--yes]',
    '  node scripts/xihe.mjs version [--check]',
    '  node scripts/xihe.mjs status',
    '  node scripts/xihe.mjs workspace list',
    '  node scripts/xihe.mjs workspace get <wsId>',
    '  node scripts/xihe.mjs job list <wsId>',
    '  node scripts/xihe.mjs job output <wsId> <jobId> [--stream stdout|stderr] [--offset <n>] [--limit <n>]',
    '  node scripts/xihe.mjs job cancel <wsId> <jobId>',
    '  node scripts/xihe.mjs checkpoint list <wsId>',
    '  node scripts/xihe.mjs checkpoint preview-revert <wsId> <sliceRef>',
    '  node scripts/xihe.mjs scheduled-task list <wsId> [--page <n>] [--size <n>]',
    '  node scripts/xihe.mjs audit list [--type <type>] [--page <n>] [--size <n>]',
    '  node scripts/xihe.mjs provider add <id> --scope <USER|WORKSPACE> --label <label> [--models <id,id>] [--api-key-env <name>]',
    '  node scripts/xihe.mjs provider update <id> [--label <label>] [--base-url <url>] [--models <id,id>] [--api-key-env <name>]',
    '  node scripts/xihe.mjs provider list [--scope <USER|WORKSPACE>]',
    '  node scripts/xihe.mjs provider verify <id>',
    '  node scripts/xihe.mjs provider delete <id> [--yes]',
    '  node scripts/xihe.mjs credential rotate [--batch-size <n>] [--max-batches <n>] [--dry-run]',
    '  node scripts/xihe.mjs test real <e2e/real/spec.spec.ts> [--route <native|openai-compat>]',
    '',
    'Secrets are read from environment variables or a no-echo TTY prompt; never pass secret values as arguments.',
    'credential rotate authenticates with XIHE_CP_API_TOKEN (CP service Bearer) and never prints credential values.',
    'verify writes a principal/session/chat run into the target stack and calls the model provider; use an isolated stack and workspace.',
    'Real E2E uses XIHE_E2E_REAL_XIAOMI_KEY and does not test Provider Connection leases.',
  ].join('\n');
}

export async function runCommand(argv, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  // PLAN-0547: fill missing keys from the .env chain (.env → .env.$XIHE_ENV → .env.local)
  // before any consumer reads XIHE_DEV_ADMIN_PASSWORD. OS env and test-injected bags win;
  // called here (entry) not at module top so unit tests with injected env bags are unaffected.
  if (!dependencies.env) loadEnvFileChain({ env });
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
      const parsed = parseCommandOptions(args.slice(1), [], ['--check']);
      if (parsed.positionals.length !== 0) throw new CliError('INVALID_ARGUMENT', 'version takes no positional arguments.');
      const versionResult = runVersion({
        check: parsed.values['--check'] === true,
        root: dependencies.projectRoot,
      });
      return { exitCode: versionResult.exitCode, json, data: versionResult.data };
    }

    if (group === 'verify') {
      const parsed = parseCommandOptions(
        args.slice(1),
        ['--stack', '--email', '--workspace', '--wait-seconds'],
        ['--yes'],
      );
      if (parsed.positionals.length !== 0) {
        throw new CliError('INVALID_ARGUMENT', 'verify takes no positional arguments; use --stack, --email, and --workspace.');
      }
      const verifyResult = await runVerify({
        env,
        fetchImpl,
        options: parsed.values,
        json,
        stdout: dependencies.stdout ?? process.stdout,
        stderr: dependencies.stderr ?? process.stderr,
        promptSecret: prompt,
        confirm: dependencies.confirmAction ?? confirmAction,
        spawnSyncImpl: spawnSyncImpl ?? spawnSync,
        stdin: dependencies.stdin ?? process.stdin,
        nowImpl: dependencies.nowImpl,
        sleepImpl: dependencies.sleepImpl,
        root: dependencies.projectRoot,
      });
      return { exitCode: verifyResult.exitCode, json, data: verifyResult.data };
    }

    if (group === 'status') {
      const parsed = parseCommandOptions(rest, [], []);
      if (parsed.positionals.length !== 0) throw new CliError('INVALID_ARGUMENT', 'status takes no positional arguments.');
      const apiBase = getApiBase(env);
      const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret: prompt });
      const data = await collectStatus({ apiBase, fetchImpl, token });
      return { exitCode: 0, json, data };
    }

    if (group === 'workspace') {
      let parsed;
      if (command === 'list') {
        parsed = parseCommandOptions(rest, ['--email'], []);
      } else if (command === 'get') {
        parsed = parseCommandOptions(rest, ['--email'], []);
      } else {
        throw new CliError('INVALID_ARGUMENT', 'Unknown workspace command; use list/get.');
      }
      const apiBase = getApiBase(env);
      const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret: prompt });
      if (command === 'list') {
        if (parsed.positionals.length !== 0) throw new CliError('INVALID_ARGUMENT', 'workspace list takes no positional arguments.');
        return { exitCode: 0, json, data: await runWorkspaceList({ apiBase, fetchImpl, token }) };
      }
      if (parsed.positionals.length !== 1) throw new CliError('INVALID_ARGUMENT', 'workspace get requires one workspace ID.');
      const data = await runWorkspaceGet({ apiBase, fetchImpl, token, workspaceId: parsed.positionals[0] });
      return { exitCode: data.partial ? 1 : 0, json, data };
    }

    if (group === 'job') {
      let parsed;
      if (command === 'list') {
        parsed = parseCommandOptions(rest, ['--email'], []);
      } else if (command === 'output') {
        parsed = parseCommandOptions(rest, ['--stream', '--offset', '--limit', '--email'], []);
      } else if (command === 'cancel') {
        parsed = parseCommandOptions(rest, ['--email'], []);
      } else {
        throw new CliError('INVALID_ARGUMENT', 'Unknown job command; use list/output/cancel.');
      }
      if (command === 'list' && parsed.positionals.length !== 1) {
        throw new CliError('INVALID_ARGUMENT', 'job list requires one workspace ID.');
      }
      if (command === 'output' && parsed.positionals.length !== 2) {
        throw new CliError('INVALID_ARGUMENT', 'job output requires a workspace ID and a job ID.');
      }
      if (command === 'cancel' && parsed.positionals.length !== 2) {
        throw new CliError('INVALID_ARGUMENT', 'job cancel requires a workspace ID and a job ID.');
      }
      const apiBase = getApiBase(env);
      const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret: prompt });
      if (command === 'list') {
        return { exitCode: 0, json, data: await runJobList({ apiBase, fetchImpl, token, workspaceId: parsed.positionals[0] }) };
      }
      if (command === 'cancel') {
        const data = await runJobCancel({
          apiBase,
          fetchImpl,
          token,
          workspaceId: parsed.positionals[0],
          jobId: parsed.positionals[1],
        });
        return { exitCode: 0, json, data };
      }
      const data = await runJobOutput({
        apiBase,
        fetchImpl,
        token,
        workspaceId: parsed.positionals[0],
        jobId: parsed.positionals[1],
        options: parsed.values,
      });
      return { exitCode: 0, json, data };
    }

    if (group === 'checkpoint') {
      let parsed;
      if (command === 'list') {
        parsed = parseCommandOptions(rest, ['--email'], []);
      } else if (command === 'preview-revert') {
        parsed = parseCommandOptions(rest, ['--email'], []);
      } else {
        throw new CliError('INVALID_ARGUMENT', 'Unknown checkpoint command; use list/preview-revert.');
      }
      if (command === 'list' && parsed.positionals.length !== 1) {
        throw new CliError('INVALID_ARGUMENT', 'checkpoint list requires one workspace ID.');
      }
      if (command === 'preview-revert' && parsed.positionals.length !== 2) {
        throw new CliError('INVALID_ARGUMENT', 'checkpoint preview-revert requires a workspace ID and a sliceRef.');
      }
      const apiBase = getApiBase(env);
      const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret: prompt });
      if (command === 'list') {
        const data = await runCheckpointList({ apiBase, fetchImpl, token, workspaceId: parsed.positionals[0] });
        return { exitCode: data.partial ? 1 : 0, json, data };
      }
      const data = await runCheckpointPreviewRevert({
        apiBase,
        fetchImpl,
        token,
        workspaceId: parsed.positionals[0],
        sliceRef: parsed.positionals[1],
      });
      return { exitCode: 0, json, data };
    }

    if (group === 'scheduled-task' && command === 'list') {
      const parsed = parseCommandOptions(rest, ['--page', '--size', '--email'], []);
      if (parsed.positionals.length !== 1) throw new CliError('INVALID_ARGUMENT', 'scheduled-task list requires one workspace ID.');
      const apiBase = getApiBase(env);
      const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret: prompt });
      const data = await runScheduledTaskList({ apiBase, fetchImpl, token, workspaceId: parsed.positionals[0], options: parsed.values });
      return { exitCode: 0, json, data };
    }

    if (group === 'audit' && command === 'list') {
      const parsed = parseCommandOptions(rest, ['--type', '--page', '--size', '--email'], []);
      if (parsed.positionals.length !== 0) throw new CliError('INVALID_ARGUMENT', 'audit list takes no positional arguments.');
      const apiBase = getApiBase(env);
      const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret: prompt });
      const data = await runAuditList({ apiBase, fetchImpl, token, options: parsed.values });
      return { exitCode: 0, json, data };
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

    if (group === 'config' && command === 'export') {
      const parsed = parseCommandOptions(rest, ['--layer', '--out', '--email'], ['--include-secrets', '--force']);
      if (parsed.positionals.length !== 0) throw new CliError('INVALID_ARGUMENT', 'config export takes no positional arguments.');
      if (parsed.values['--layer'] !== undefined && parsed.values['--layer'] !== 'instance') {
        throw new CliError('INVALID_ARGUMENT', 'Only the instance layer can be exported (--layer instance).');
      }
      if (parsed.values['--out'] !== undefined && parsed.values['--out'].trim() === '') {
        throw new CliError('INVALID_ARGUMENT', '--out requires a file path.');
      }
      const apiBase = getApiBase(env);
      const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret: prompt });
      const data = await runConfigExport({
        apiBase,
        fetchImpl,
        options: parsed.values,
        positionals: parsed.positionals,
        token,
        json,
        stdout: dependencies.stdout ?? process.stdout,
        stderr: dependencies.stderr ?? process.stderr,
        confirm: dependencies.confirmAction ?? confirmAction,
        stdin: dependencies.stdin ?? process.stdin,
        fsImpl: dependencies.fsImpl,
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
      } else if (command === 'delete') {
        parsed = parseCommandOptions(rest, ['--email'], ['--yes']);
      } else {
        throw new CliError('INVALID_ARGUMENT', 'Unknown provider command; use add/update/list/verify/delete.');
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
      } else if (command === 'delete') {
        if (parsed.positionals.length !== 1) throw new CliError('INVALID_ARGUMENT', 'provider delete requires one connection ID.');
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
      if (command === 'delete') {
        const data = await deleteProvider({
          apiBase,
          fetchImpl,
          token,
          id,
          yes: parsed.values['--yes'] === true,
          confirm: dependencies.confirmAction ?? confirmAction,
          stdin: dependencies.stdin ?? process.stdin,
          stdout: dependencies.stdout ?? process.stdout,
          stderr: dependencies.stderr ?? process.stderr,
          json,
        });
        return { exitCode: 0, json, data };
      }
      const connection = await verifyConnection({ apiBase, fetchImpl, token, id });
      return { exitCode: 0, json, data: { connection } };
    }

    if (group === 'credential' && command === 'rotate') {
      const parsed = parseCommandOptions(rest, ['--batch-size', '--max-batches'], ['--dry-run']);
      if (parsed.positionals.length !== 0) {
        throw new CliError('INVALID_ARGUMENT', 'credential rotate takes no positional arguments.');
      }
      const data = await rotateCredentials({
        env,
        fetchImpl,
        options: parsed.values,
        stdout: dependencies.stdout ?? process.stdout,
      });
      return { exitCode: 0, json, data };
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

export function printResult(result) {
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
  if (result.data?.version === 'development checkout' && Array.isArray(result.data.modules)) {
    process.stdout.write(`CLI: ${result.data.version}\n`);
    for (const module of result.data.modules) {
      process.stdout.write(module.version
        ? `${module.name}: ${module.version} (${module.manifest})\n`
        : `${module.name}: ERROR ${module.error.code} (${module.manifest}) ${module.error.message}\n`);
    }
    if (result.data.check) {
      process.stdout.write(`Consistency: ${result.data.check.ok ? 'PASS' : 'FAIL'} `
        + `(${result.data.check.failureCount} failure(s))\n`);
      for (const failure of result.data.check.failures) process.stdout.write(`  ${failure}\n`);
    }
    return;
  }
  if (result.data?.mode === 'stdout' && typeof result.data.content === 'string') {
    const content = result.data.content;
    process.stdout.write(content.endsWith('\n') ? content : `${content}\n`);
    return;
  }
  if (result.data?.mode === 'file') return;
  if (result.data?.cleanup && result.data?.a) {
    const verify = result.data;
    process.stdout.write(`RESULT: A=${verify.a.status} B=${verify.b.status} RUN=${verify.run.status} (${verify.result})\n`);
    if (verify.b.detail) process.stdout.write(`B detail: ${verify.b.detail}\n`);
    process.stdout.write(`cleanup: sse=${verify.cleanup.sse} session=${verify.cleanup.session.status}\n`);
    if (verify.cleanup.runCancel) {
      process.stdout.write(`run cancel: ${verify.cleanup.runCancel.status}`
        + `${verify.cleanup.runCancel.code ? ` (${verify.cleanup.runCancel.code})` : ''}\n`);
    }
    if (verify.cleanup.session.status === 'unknown') {
      process.stdout.write('residual: session create outcome is unknown; check the target stack manually\n');
    }
    if (verify.cleanup.principal.status === 'retained') {
      process.stdout.write(`residual: agent principal ${verify.cleanup.principal.principalId} retained (no principal delete API)\n`);
    }
    if (verify.cleanup.principal.status === 'unknown') {
      process.stdout.write('residual: agent principal create outcome is unknown; check the target stack manually\n');
    }
    return;
  }
  if (result.data?.action === 'deleted' && result.data?.connectionId) {
    process.stdout.write(`deleted: ${result.data.connectionId}\n`);
    return;
  }
  const out = process.stdout;
  const endpointLabel = (view) => view?.status === 'ok' ? 'ok' : `failed(${view?.code ?? `HTTP ${view?.httpStatus ?? '?'}`})`;
  if (result.data?.kind === 'status') {
    const e = result.data.endpoints;
    out.write(`STATUS: ${result.data.overall} | status=${endpointLabel(e.status)} health=${endpointLabel(e.health)} version=${endpointLabel(e.version)}\n`);
    return;
  }
  if (result.data?.kind === 'workspace-list') {
    out.write(`workspaces: ${result.data.items.length}\n`);
    for (const item of result.data.items) {
      out.write(`${item.id}  ${item.name ?? ''}  ${item.workspaceRole ?? ''}${item.canWrite === false ? ' (readonly)' : ''}\n`);
    }
    return;
  }
  if (result.data?.kind === 'workspace') {
    const item = result.data.workspace ?? {};
    out.write(`${item.id ?? ''}  ${item.name ?? ''}  ${item.workspaceRole ?? ''}\n`);
    const env = result.data.environment;
    if (env?.retrieved === false) {
      out.write(`environment: failed(${env.code ?? `HTTP ${env.httpStatus ?? '?'}`})\n`);
    } else {
      out.write(`environment: status=${env?.status ?? '?'} executionMode=${env?.executionMode ?? '?'} backend=${env?.storageBackend ?? '?'}\n`);
    }
    return;
  }
  if (result.data?.kind === 'job-list') {
    out.write(`jobs: ${result.data.items.length}\n`);
    for (const item of result.data.items) {
      out.write(`${item.jobId}  ${item.status ?? ''}  ${item.startedAt ?? ''}\n`);
    }
    return;
  }
  if (result.data?.kind === 'job-output') {
    const text = result.data.text ?? '';
    out.write(text.endsWith('\n') || text === '' ? text : `${text}\n`);
    return;
  }
  if (result.data?.kind === 'checkpoint-list') {
    out.write(`checkpoints: ${result.data.items.length}\n`);
    for (const item of result.data.items) {
      out.write(`${item.sliceRef ?? item.id ?? ''}  ${item.state ?? ''}  ${item.capturedAt ?? ''}\n`);
    }
    const retention = result.data.retention;
    if (retention?.retrieved === false) {
      out.write(`retention: failed(${retention.code ?? `HTTP ${retention.httpStatus ?? '?'}`})\n`);
    } else {
      out.write(`retention: maxRuns=${retention?.maxRuns ?? '?'} ttlDays=${retention?.ttlDays ?? '?'} currentRuns=${retention?.currentRuns ?? '?'}\n`);
    }
    return;
  }
  if (result.data?.kind === 'job-cancel') {
    out.write(`cancel: ${result.data.jobId} status=${result.data.status ?? '?'} changed=${result.data.changed}\n`);
    return;
  }
  if (result.data?.kind === 'checkpoint-preview') {
    out.write(`preview: ${result.data.sliceRef} entries=${result.data.entries.length}`
      + ` truncated=${result.data.truncated} opaqueNestedRepos=${result.data.opaqueNestedRepos ?? '?'}\n`);
    return;
  }
  if (result.data?.kind === 'scheduled-task-list') {
    out.write(`scheduled tasks: ${result.data.items.length} (page ${result.data.page}, size ${result.data.size})\n`);
    for (const item of result.data.items) {
      out.write(`${item.id}  ${item.status ?? ''}  ${item.triggerKind ?? ''}${item.cronExpr ? ` ${item.cronExpr}` : ''}  next=${item.nextFireAt ?? ''}\n`);
    }
    return;
  }
  if (result.data?.kind === 'audit-list') {
    out.write(`audit entries: ${result.data.entries.length} (page ${result.data.page}/${result.data.totalPages ?? '?'}, total ${result.data.totalElements ?? '?'})\n`);
    for (const item of result.data.entries) {
      out.write(`${item.createdAt ?? ''}  ${item.type ?? ''}  ${item.status ?? ''}  ${item.id ?? ''}\n`);
    }
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
  if (result.data?.status?.pendingByVersion !== undefined) {
    const status = result.data.status;
    process.stdout.write(`Rotation target ${status.currentVersion}; ring ${(status.ringVersions ?? []).join(', ') || 'n/a'}\n`);
    for (const [version, count] of Object.entries(status.countsByVersion ?? {})) {
      process.stdout.write(`  version ${version}: ${count} row(s)\n`);
    }
    if (result.data.dryRun) {
      process.stdout.write(`Dry run: ${status.pendingTotal} row(s) pending migration.\n`);
      return;
    }
    process.stdout.write(`Migrated ${result.data.totals.migrated} row(s) in ${result.data.rounds} batch(es); `
      + `conflicts=${result.data.totals.conflicts} failures=${result.data.totals.failures}.\n`);
    if (status.pendingTotal === 0) {
      process.stdout.write('Retire check: all rows are on the current key version; the old key can be removed from the ring.\n');
    } else {
      process.stdout.write(`Retire check: ${status.pendingTotal} row(s) still pending.\n`);
    }
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
