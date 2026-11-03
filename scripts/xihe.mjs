#!/usr/bin/env node

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  CliError,
  addProvider,
  confirmAction,
  deleteProvider,
  exitCodeFor,
  getApiBase,
  resolveBaseUrl,
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
import { runApiEscape } from './xihe-cli/api.mjs';
import { runAuthCommand } from './xihe-cli/auth.mjs';
import { attachAuthRefresh } from './xihe-cli/auth-refresh.mjs';
import {
  bindSkill,
  deleteSkill,
  importSkills,
  listSkillBindings,
  listSkills,
  showSkill,
  unbindSkill,
} from './xihe-cli/skill.mjs';
import { checkDevelopmentEnvironment, runConfigImport, runRealTest } from './xihe-cli/host.mjs';
import {
  formatCredentialResult,
  rotateCredentials,
  runCredentialBindings,
  runCredentialCreate,
  runCredentialDelete,
  runCredentialEvents,
  runCredentialList,
  runCredentialPrecheck,
  runCredentialReferences,
  runCredentialReplace,
  runCredentialReveal,
} from './xihe-cli/credential.mjs';
import { runConfigExport } from './xihe-cli/config-export.mjs';
import {
  bindAgent,
  createAgent,
  disableAgent,
  listAgents,
  normalizeAgentScope,
  parseAgentOptions,
  parseLimitArgs,
  setProviderLimits,
  showProviderLimits,
  unbindAgent,
} from './xihe-cli/agent.mjs';
import {
  addParticipant,
  listParticipants,
  parseParticipantOptions,
  removeParticipant,
  sendChat,
  updateParticipantPolicy,
} from './xihe-cli/participants.mjs';
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

/**
 * PLAN-0643 T1.7 (design D4): the single global-option layer, run before group
 * dispatch so `--json` / `--help` work anywhere and `--base-url` / `--workspace`
 * work in the leading position (`xihe --base-url URL provider list`).
 *
 * `--base-url` is **leading-only** on purpose: `provider add|update` already owns a
 * command-level `--base-url` (the provider connection base URL) and its
 * `CUSTOM_BASE_URL_UNSUPPORTED` contract must not be shadowed by the global flag.
 * `--workspace` is exported into env and **re-appended** to the group arguments so a
 * group that declares it keeps its exact current semantics (T3.5 will switch the
 * consumers to the env value; this batch stays behavior-compatible).
 */
function splitGlobalOptions(args) {
  const rest = [];
  const globals = { json: false, baseUrl: undefined, workspace: undefined, help: false };
  let groupSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      globals.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      globals.help = true;
      continue;
    }
    const matches = (name) => arg === name || arg.startsWith(`${name}=`);
    if (!groupSeen && matches('--base-url')) {
      const value = arg.includes('=') ? arg.slice('--base-url='.length) : args[index + 1];
      if (value === undefined || value === '') throw new CliError('INVALID_ARGUMENT', '--base-url requires a value.');
      if (!arg.includes('=')) index += 1;
      globals.baseUrl = value;
      continue;
    }
    if (!groupSeen && matches('--workspace')) {
      const value = arg.includes('=') ? arg.slice('--workspace='.length) : args[index + 1];
      if (value === undefined || value === '') throw new CliError('INVALID_ARGUMENT', '--workspace requires a value.');
      if (!arg.includes('=')) index += 1;
      globals.workspace = value;
      continue;
    }
    if (!groupSeen && arg.startsWith('--')) {
      // Unknown leading option: leave it to the group parser so the existing
      // "unknown option" error text and exit code do not change.
      groupSeen = true;
      rest.push(arg);
      continue;
    }
    groupSeen = true;
    rest.push(arg);
  }
  // Re-append after the loop: putting it back in place would let a leading
  // `--workspace` become the group token (`xihe --workspace ws-1 skill list`).
  if (globals.workspace !== undefined) rest.push('--workspace', globals.workspace);
  return { args: rest, ...globals };
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
    '  node scripts/xihe.mjs skill list [--scope instance|workspace] [--workspace <wsId>]',
    '  node scripts/xihe.mjs skill show <skillId> [--include-body]',
    '  node scripts/xihe.mjs skill import --file <request.json>',
    '  node scripts/xihe.mjs skill bind --skill <id> --subject <user|agent_principal> --subject-id <id> [--scope instance|workspace --workspace <wsId>]',
    '  node scripts/xihe.mjs skill unbind <bindingId> [--yes]',
    '  node scripts/xihe.mjs skill delete <skillId> [--yes]',
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
    '  node scripts/xihe.mjs agent create --scope personal|workspace|instance --name <n> [--template <t>] [--default-model <p>:<m>] [--allow-model <p>:<m> ...]',
    '  node scripts/xihe.mjs agent list [--workspace <wsId>] [--scope <scope>]',
    '  node scripts/xihe.mjs agent bind --principal <p> --workspace <wsId>',
    '  node scripts/xihe.mjs agent unbind --principal <p> --workspace <wsId>',
    '  node scripts/xihe.mjs agent disable --principal <p>',
    '  node scripts/xihe.mjs provider limit set --connection <c> [--max-inflight N] [--max-queue N] [--tokens N --window S] [--model <p>:<m> --max-inflight N ...]',
    '  node scripts/xihe.mjs provider limit show --connection <c>',
    '  node scripts/xihe.mjs provider list [--scope <USER|WORKSPACE>]',
    '  node scripts/xihe.mjs session participants list --session <sessionId> [--workspace <wsId>]',
    '  node scripts/xihe.mjs session participants add --session <sessionId> --principal <principalId> --kind AGENT|HUMAN [--role MEMBER|GUARD] [--wake ALL_MESSAGES|MENTION] [--respond ALWAYS|WHEN_MENTIONED|JUDGE|MUTED]',
    '  node scripts/xihe.mjs session participants remove --session <sessionId> --participant <participantId>  (soft disable: 参与者行/游标/审计保留，非硬删除)',
    '  node scripts/xihe.mjs session participants policy --session <sessionId> --participant <participantId> [--wake MENTION|ALL_MESSAGES|SCHEDULE [--interval <seconds> [--jitter <seconds>] [--max-concurrent <n>]]] [--respond ALWAYS|WHEN_MENTIONED|JUDGE|MUTED]',
    '  node scripts/xihe.mjs chat send --session <sessionId> --branch <branchId> --content <text> [--as <participantId>]',
    '  node scripts/xihe.mjs provider verify <id>',
    '  node scripts/xihe.mjs provider delete <id> [--yes]',
    '  node scripts/xihe.mjs credential rotate [--batch-size <n>] [--max-batches <n>] [--dry-run]',
    '  node scripts/xihe.mjs credential list [--owner-type USER|WORKSPACE --owner-id <id>]',
    '  node scripts/xihe.mjs credential references <id> --workspace <wsId>',
    '  node scripts/xihe.mjs credential events <id> --workspace <wsId>',
    '  node scripts/xihe.mjs credential precheck --permissions <atom[,atom...]>',
    '  node scripts/xihe.mjs credential create --kind token|key_pair --owner-type <USER|WORKSPACE> --owner-id <id> --label <label> [--delivery-tier <tier>] (--secret-env <NAME> | --access-key-env <NAME> --secret-key-env <NAME>)',
    '  node scripts/xihe.mjs credential replace <id> --kind token|key_pair --workspace <wsId> (--secret-env <NAME> | --access-key-env <NAME> --secret-key-env <NAME>)',
    '  node scripts/xihe.mjs credential delete <id> --workspace <wsId> [--yes]',
    '  node scripts/xihe.mjs credential bind <id> --workspace <wsId> --agent <principalId[,principalId...]>',
    '  node scripts/xihe.mjs credential unbind <id> --workspace <wsId> --agent <principalId[,principalId...]>',
    '  node scripts/xihe.mjs credential reveal <id> --workspace <wsId> (--password-env <NAME> | TTY) [--out <file> [--force]]',
    '  node scripts/xihe.mjs test real <e2e/real/spec.spec.ts> [--route <native|openai-compat>]',
    '  node scripts/xihe.mjs auth login [--email <account>] [--force] [--no-cache]',
    '  node scripts/xihe.mjs auth status',
    '  node scripts/xihe.mjs auth logout [--force]',
    '  node scripts/xihe.mjs api [METHOD] <path> [--yes] [--allow-dangerous] [--body-file <file> | --stdin] [--raw] [--timeout <ms>] [--max-bytes <bytes>]',
    '',
    'Global options: --json (machine envelope), --base-url <url>, --workspace <wsId>, --help.',
    'Exit codes: 0 = success; 1 = business/runtime failure; 2 = usage error (unknown command/option, missing argument, forbidden api target).',
    'Set XIHE_CLI_LEGACY_EXIT_CODES=1 to restore the pre-0643 codes for one batch.',
    'xihe api only forwards /api/v1/**; /api/v1/mcp and --include-secrets need --allow-dangerous;',
    'mutating methods need --yes; request bodies come from stdin or --body-file (never argv).',
    '',
    'Secrets are read from environment variables or a no-echo TTY prompt; never pass secret values as arguments.',
    'credential rotate authenticates with XIHE_CP_API_TOKEN (CP service Bearer) and never prints credential values.',
    'credential create/replace/reveal read secrets only from --*-env <NAME> or a no-echo TTY prompt; reveal prints plaintext only on explicit request (stdout or --out file).',
    'verify writes a principal/session/chat run into the target stack and calls the model provider; use an isolated stack and workspace.',
    'Real E2E uses XIHE_E2E_REAL_XIAOMI_KEY and does not test Provider Connection leases.',
  ].join('\n');
}

export async function runCommand(argv, dependencies = {}) {
  const baseEnv = dependencies.env ?? process.env;
  // PLAN-0547: fill missing keys from the .env chain (.env → .env.$XIHE_ENV → .env.local)
  // before any consumer reads XIHE_DEV_ADMIN_PASSWORD. OS env and test-injected bags win;
  // called here (entry) not at module top so unit tests with injected env bags are unaffected.
  if (!dependencies.env) loadEnvFileChain({ env: baseEnv });
  const rawFetch = dependencies.fetchImpl ?? fetch;
  const spawnSyncImpl = dependencies.spawnSyncImpl;
  const spawnImpl = dependencies.spawnImpl;
  const prompt = dependencies.promptSecret ?? ((label) => promptSecret(label));
  const globals = splitGlobalOptions([...argv]);
  const { args, json } = globals;
  // PLAN-0643 T1.7: a shallow copy so `--base-url` / `--workspace` never mutate the
  // caller's env bag; every existing `getApiBase(env)` call site picks the override up
  // through the `XIHE_CP_URL` precedence link (design D5) with no per-command edit.
  const env = { ...baseEnv };
  if (globals.baseUrl !== undefined) env.XIHE_CP_URL = globals.baseUrl;
  if (globals.workspace !== undefined) env.XIHE_WORKSPACE_ID = globals.workspace;
  // PLAN-0643 T1.2: test-injected env bags must never read or write the developer's
  // real %LOCALAPPDATA%\Xihe token cache. The cache stays inert unless the caller
  // points XIHE_CLI_TOKEN_FILE at an isolated path.
  if (dependencies.env !== undefined && env.XIHE_CLI_TOKEN_FILE === undefined) env.XIHE_CLI_TOKEN_CACHE = 'off';
  // PLAN-0643 R5: a 401 on a cached token refreshes once (single-flight across
  // processes) and replays the request; 403 / non-CP origins are untouched.
  const fetchImpl = attachAuthRefresh({
    fetchImpl: rawFetch,
    env,
    promptSecret: prompt,
    fsImpl: dependencies.fsImpl,
    platform: dependencies.platform,
    waitMs: dependencies.authRefreshWaitMs,
    pollMs: dependencies.authRefreshPollMs,
  });
  const [group, command, ...rest] = args;

  try {
    // T1.7: validate the flag value before dispatch so a malformed `--base-url`
    // reports INVALID_BASE_URL (the env link alone would report INVALID_CP_URL).
    if (globals.baseUrl !== undefined) resolveBaseUrl({}, globals.baseUrl);
    if (!group || group === 'help' || globals.help) {
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

    if (group === 'skill') {
      if (command === 'list') {
        const parsed = parseCommandOptions(rest, ['--scope', '--workspace', '--email'], []);
        if (parsed.positionals.length !== 0) throw new CliError('INVALID_ARGUMENT', 'skill list takes no positional arguments.');
        const apiBase = getApiBase(env);
        const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret: prompt });
        return { exitCode: 0, json, data: await listSkills({ apiBase, fetchImpl, token, options: parsed.values }) };
      }
      if (command === 'show') {
        // `--include-body` is a flag, not a valued option: declared as a value option it either
        // demanded an argument or recorded the string "true", and `=== true` below never matched
        // (PLAN-0628 M3 found this with the runCommand-level test).
        const parsed = parseCommandOptions(rest, ['--email'], ['--include-body']);
        if (parsed.positionals.length !== 1) throw new CliError('INVALID_ARGUMENT', 'skill show requires one skill ID.');
        const apiBase = getApiBase(env);
        const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret: prompt });
        return {
          exitCode: 0,
          json,
          data: await showSkill({
            apiBase, fetchImpl, token,
            skillId: parsed.positionals[0],
            includeBody: parsed.values['--include-body'] === true,
          }),
        };
      }
      if (command === 'bindings') {
        const parsed = parseCommandOptions(rest, ['--email'], []);
        if (parsed.positionals.length !== 1) throw new CliError('INVALID_ARGUMENT', 'skill bindings requires one skill ID.');
        const apiBase = getApiBase(env);
        const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret: prompt });
        return { exitCode: 0, json, data: await listSkillBindings({ apiBase, fetchImpl, token, skillId: parsed.positionals[0] }) };
      }
      if (command === 'import') {
        const parsed = parseCommandOptions(rest, ['--file', '--email'], []);
        if (parsed.positionals.length !== 0) throw new CliError('INVALID_ARGUMENT', 'skill import takes no positional arguments; use --file.');
        const file = requireOption(parsed.values, '--file');
        const request = JSON.parse(readFileSync(file, 'utf8'));
        const apiBase = getApiBase(env);
        const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret: prompt });
        return { exitCode: 0, json, data: await importSkills({ apiBase, fetchImpl, token, request }) };
      }
      if (command === 'bind') {
        const parsed = parseCommandOptions(rest, ['--skill', '--subject', '--subject-id', '--scope', '--workspace', '--email'], []);
        if (parsed.positionals.length !== 0) throw new CliError('INVALID_ARGUMENT', 'skill bind takes no positional arguments.');
        const apiBase = getApiBase(env);
        const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret: prompt });
        return { exitCode: 0, json, data: await bindSkill({ apiBase, fetchImpl, token, options: parsed.values }) };
      }
      if (command === 'unbind') {
        const parsed = parseCommandOptions(rest, ['--email'], ['--yes']);
        if (parsed.positionals.length !== 1) throw new CliError('INVALID_ARGUMENT', 'skill unbind requires one binding ID.');
        const apiBase = getApiBase(env);
        const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret: prompt });
        return {
          exitCode: 0,
          json,
          data: await unbindSkill({
            apiBase, fetchImpl, token,
            bindingId: parsed.positionals[0],
            assumeYes: parsed.values['--yes'] === true,
            stdin: dependencies.stdin,
          }),
        };
      }
      if (command === 'delete') {
        const parsed = parseCommandOptions(rest, ['--email'], ['--yes']);
        if (parsed.positionals.length !== 1) throw new CliError('INVALID_ARGUMENT', 'skill delete requires one skill ID.');
        const apiBase = getApiBase(env);
        const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret: prompt });
        return {
          exitCode: 0,
          json,
          data: await deleteSkill({
            apiBase, fetchImpl, token,
            skillId: parsed.positionals[0],
            assumeYes: parsed.values['--yes'] === true,
            stdin: dependencies.stdin,
          }),
        };
      }
      throw new CliError('INVALID_ARGUMENT', 'Unknown skill command; use list|show|bindings|import|bind|unbind|delete.');
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

    if (group === 'session' && command === 'participants') {
      const sub = rest[0];
      const tail = rest.slice(1);
      const apiBase = getApiBase(env);
      let parsed;
      if (sub === 'list') {
        parsed = parseParticipantOptions(tail, ['--session', '--workspace', '--email']);
      } else if (sub === 'add') {
        parsed = parseParticipantOptions(tail, ['--session', '--principal', '--kind', '--role', '--wake', '--respond', '--workspace', '--email']);
      } else if (sub === 'remove') {
        parsed = parseParticipantOptions(tail, ['--session', '--participant', '--workspace', '--email']);
      } else if (sub === 'policy') {
        parsed = parseParticipantOptions(tail, ['--session', '--participant', '--wake', '--respond', '--interval', '--jitter', '--max-concurrent', '--workspace', '--email']);
      } else {
        throw new CliError('INVALID_ARGUMENT', 'Unknown session participants command; use list/add/remove/policy.', {}, 2);
      }
      if (parsed.positionals.length !== 0) {
        throw new CliError('INVALID_ARGUMENT', `session participants ${sub} takes no positional arguments.`, {}, 2);
      }
      const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret: prompt });
      if (sub === 'list') {
        return { exitCode: 0, json, data: await listParticipants({ apiBase, fetchImpl, token, options: parsed.values }) };
      }
      if (sub === 'add') {
        return { exitCode: 0, json, data: await addParticipant({ apiBase, fetchImpl, token, options: parsed.values }) };
      }
      if (sub === 'remove') {
        return { exitCode: 0, json, data: await removeParticipant({ apiBase, fetchImpl, token, options: parsed.values }) };
      }
      return { exitCode: 0, json, data: await updateParticipantPolicy({ apiBase, fetchImpl, token, options: parsed.values }) };
    }

    if (group === 'chat' && command === 'send') {
      const parsed = parseParticipantOptions(rest, ['--session', '--branch', '--content', '--as', '--workspace', '--email']);
      if (parsed.positionals.length !== 0) {
        throw new CliError('INVALID_ARGUMENT', 'chat send takes no positional arguments.', {}, 2);
      }
      const apiBase = getApiBase(env);
      const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret: prompt });
      return { exitCode: 0, json, data: await sendChat({ apiBase, fetchImpl, token, options: parsed.values }) };
    }

    if (group === 'agent') {
      const apiBase = getApiBase(env);
      let parsed;
      if (command === 'create') {
        parsed = parseAgentOptions(rest, ['--scope', '--name', '--template', '--default-model', '--allow-model', '--email']);
      } else if (command === 'list') {
        parsed = parseAgentOptions(rest, ['--workspace', '--scope', '--email']);
      } else if (command === 'bind' || command === 'unbind') {
        parsed = parseAgentOptions(rest, ['--principal', '--workspace', '--email']);
      } else if (command === 'disable') {
        parsed = parseAgentOptions(rest, ['--principal', '--email']);
      } else {
        throw new CliError('INVALID_ARGUMENT', 'Unknown agent command; use create/list/bind/unbind/disable.', {}, 2);
      }
      if (parsed.positionals.length !== 0) {
        throw new CliError('INVALID_ARGUMENT', `agent ${command} takes no positional arguments.`, {}, 2);
      }
      if (command === 'create') normalizeAgentScope(parsed.values['--scope']);
      const token = await login({ apiBase, fetchImpl, env, options: parsed.values, promptSecret: prompt });
      if (command === 'create') {
        return {
          exitCode: 0,
          json,
          data: await createAgent({ apiBase, fetchImpl, token, options: parsed.values }),
        };
      }
      if (command === 'list') {
        return {
          exitCode: 0,
          json,
          data: await listAgents({ apiBase, fetchImpl, token, options: parsed.values }),
        };
      }
      if (command === 'bind') {
        return { exitCode: 0, json, data: await bindAgent({ apiBase, fetchImpl, token, options: parsed.values }) };
      }
      if (command === 'unbind') {
        return { exitCode: 0, json, data: await unbindAgent({ apiBase, fetchImpl, token, options: parsed.values }) };
      }
      return { exitCode: 0, json, data: await disableAgent({ apiBase, fetchImpl, token, options: parsed.values }) };
    }

    if (group === 'provider' && command === 'limit') {
      const apiBase = getApiBase(env);
      const sub = rest[0];
      if (sub !== 'set' && sub !== 'show') {
        throw new CliError('INVALID_ARGUMENT', 'Unknown provider limit command; use set/show.', {}, 2);
      }
      const parsed = parseLimitArgs(rest.slice(1));
      const token = await login({
        apiBase,
        fetchImpl,
        env,
        options: parsed.email ? { '--email': parsed.email } : {},
        promptSecret: prompt,
      });
      if (sub === 'set') {
        return { exitCode: 0, json, data: await setProviderLimits({ apiBase, fetchImpl, token, options: parsed }) };
      }
      return { exitCode: 0, json, data: await showProviderLimits({ apiBase, fetchImpl, token, options: parsed }) };
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

    if (group === 'credential') {
      if (command === 'rotate') {
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

      const credentialApi = async (values) => {
        const apiBase = getApiBase(env);
        const token = await login({ apiBase, fetchImpl, env, options: values, promptSecret: prompt });
        return { apiBase, token };
      };

      if (command === 'list') {
        const parsed = parseCommandOptions(rest, ['--owner-type', '--owner-id']);
        if (parsed.positionals.length !== 0) throw new CliError('INVALID_ARGUMENT', 'credential list takes no positional arguments.');
        const { apiBase, token } = await credentialApi(parsed.values);
        return { exitCode: 0, json, data: await runCredentialList({ apiBase, fetchImpl, token, options: parsed.values }) };
      }
      if (command === 'references' || command === 'events') {
        const parsed = parseCommandOptions(rest, ['--workspace']);
        const { apiBase, token } = await credentialApi(parsed.values);
        const runner = command === 'references' ? runCredentialReferences : runCredentialEvents;
        return {
          exitCode: 0,
          json,
          data: await runner({ apiBase, fetchImpl, token, options: parsed.values, positionals: parsed.positionals }),
        };
      }
      if (command === 'precheck') {
        const parsed = parseCommandOptions(rest, ['--permissions']);
        if (parsed.positionals.length !== 0) throw new CliError('INVALID_ARGUMENT', 'credential precheck takes no positional arguments.');
        const { apiBase, token } = await credentialApi(parsed.values);
        return { exitCode: 0, json, data: await runCredentialPrecheck({ apiBase, fetchImpl, token, options: parsed.values }) };
      }
      if (command === 'create') {
        const parsed = parseCommandOptions(rest, [
          '--kind', '--owner-type', '--owner-id', '--label', '--delivery-tier',
          '--secret-env', '--access-key-env', '--secret-key-env', '--workspace',
        ]);
        const { apiBase, token } = await credentialApi(parsed.values);
        return {
          exitCode: 0,
          json,
          data: await runCredentialCreate({
            apiBase,
            fetchImpl,
            env,
            token,
            options: parsed.values,
            positionals: parsed.positionals,
            promptSecret: prompt,
            stdin: dependencies.stdin ?? process.stdin,
          }),
        };
      }
      if (command === 'replace') {
        const parsed = parseCommandOptions(rest, [
          '--kind', '--workspace', '--secret-env', '--access-key-env', '--secret-key-env',
        ]);
        const { apiBase, token } = await credentialApi(parsed.values);
        return {
          exitCode: 0,
          json,
          data: await runCredentialReplace({
            apiBase,
            fetchImpl,
            env,
            token,
            options: parsed.values,
            positionals: parsed.positionals,
            promptSecret: prompt,
            stdin: dependencies.stdin ?? process.stdin,
          }),
        };
      }
      if (command === 'delete') {
        const parsed = parseCommandOptions(rest, ['--workspace'], ['--yes']);
        const { apiBase, token } = await credentialApi(parsed.values);
        return {
          exitCode: 0,
          json,
          data: await runCredentialDelete({
            apiBase,
            fetchImpl,
            token,
            options: parsed.values,
            positionals: parsed.positionals,
            yes: parsed.values['--yes'] === true,
            confirm: dependencies.confirmAction ?? confirmAction,
            stdin: dependencies.stdin ?? process.stdin,
            stderr: dependencies.stderr ?? process.stderr,
            json,
          }),
        };
      }
      if (command === 'bind' || command === 'unbind') {
        const parsed = parseCommandOptions(rest, ['--workspace', '--agent']);
        const { apiBase, token } = await credentialApi(parsed.values);
        return {
          exitCode: 0,
          json,
          data: await runCredentialBindings({
            apiBase,
            fetchImpl,
            token,
            options: parsed.values,
            positionals: parsed.positionals,
            bind: command === 'bind',
          }),
        };
      }
      if (command === 'reveal') {
        const parsed = parseCommandOptions(rest, ['--workspace', '--password-env', '--out'], ['--force']);
        const { apiBase, token } = await credentialApi(parsed.values);
        return {
          exitCode: 0,
          json,
          data: await runCredentialReveal({
            apiBase,
            fetchImpl,
            env,
            token,
            options: parsed.values,
            positionals: parsed.positionals,
            promptSecret: prompt,
            stdin: dependencies.stdin ?? process.stdin,
            json,
            stdout: dependencies.stdout ?? process.stdout,
            stderr: dependencies.stderr ?? process.stderr,
            confirm: dependencies.confirmAction ?? confirmAction,
            fsImpl: dependencies.fsImpl,
            force: parsed.values['--force'] === true,
            outPath: parsed.values['--out'],
          }),
        };
      }
      throw new CliError(
        'INVALID_ARGUMENT',
        'Unknown credential command; use list/references/events/precheck/create/replace/delete/bind/unbind/reveal/rotate.',
      );
    }

    if (group === 'auth') {
      // PLAN-0643 T1.2–T1.5: token cache surface (login/status/logout).
      const authResult = await runAuthCommand({
        command,
        rest,
        env,
        fetchImpl,
        apiBase: getApiBase(env),
        promptSecret: prompt,
        stdin: dependencies.stdin ?? process.stdin,
        stderr: dependencies.stderr ?? process.stderr,
        fsImpl: dependencies.fsImpl,
        aclRunner: dependencies.aclRunner,
        platform: dependencies.platform,
        now: dependencies.now,
      });
      return { exitCode: 0, json, data: authResult };
    }

    if (group === 'api') {
      // PLAN-0643 T1.1/T1.6/T1.8: the escape hatch. Gates live in xihe-cli/api.mjs so the
      // dispatch layer stays thin; the envelope is printed verbatim in --json mode.
      const apiResult = await runApiEscape({
        args: [command, ...rest].filter((value) => value !== undefined),
        env,
        fetchImpl,
        apiBase: getApiBase(env),
        promptSecret: prompt,
        stdin: dependencies.stdin ?? process.stdin,
        stderr: dependencies.stderr ?? process.stderr,
        fsImpl: dependencies.fsImpl,
        confirm: dependencies.confirmAction ?? confirmAction,
      });
      return {
        exitCode: apiResult.exitCode,
        json,
        envelope: apiResult.envelope,
        data: { kind: 'api-response', bodyText: apiResult.bodyText },
      };
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
      exitCode: cliError.exitCode ?? exitCodeFor(cliError.code, env),
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
    const value = result.envelope
      ?? (result.error
        ? { ok: false, error: result.error }
        : { ok: result.exitCode === 0, data: result.data });
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
  if (result.data?.kind === 'api-response' && typeof result.data.bodyText === 'string') {
    const text = result.data.bodyText;
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    return;
  }
  if (result.data?.kind === 'auth-status') {
    const data = result.data;
    // Metadata only: never the token value, never a fragment of it.
    process.stdout.write(`base URL       : ${data.baseUrl ?? ''}\n`);
    process.stdout.write(`source         : ${data.source}\n`);
    process.stdout.write(`token          : ${data.hasToken ? `present (${data.charCount} chars)` : 'absent'}\n`);
    process.stdout.write(`expiresAt      : ${data.expiresAt ?? 'n/a'}${data.expired === true ? ' (expired)' : ''}\n`);
    process.stdout.write(`cache file     : ${data.path} [${data.fileState}${data.reason ? `: ${data.reason}` : ''}]\n`);
    process.stdout.write(`cache disabled : ${data.cacheDisabled ? 'yes' : 'no'}\n`);
    process.stdout.write(`acl tightened  : ${data.acl.tightened === null ? 'unknown' : data.acl.tightened ? 'yes' : 'NO'} (${data.acl.detail})\n`);
    if (data.verification) {
      process.stdout.write(`verification   : ${data.verification}${data.entryDropped ? ' (cached entry dropped)' : ''}\n`);
    }
    return;
  }
  if (result.data?.kind === 'auth-login') {
    process.stdout.write(`Logged in: ${result.data.baseUrl}\n`);
    process.stdout.write(`token cache: ${result.data.persisted ? `written to ${result.data.path}` : `not written (${result.data.reason})`}\n`);
    if (result.data.verified) process.stdout.write(`verification: ${result.data.verified}\n`);
    return;
  }
  if (result.data?.kind === 'auth-logout') {
    process.stdout.write(`Logged out: ${result.data.baseUrl} (${result.data.removed ? (result.data.fileDeleted ? 'token file deleted' : 'entry removed') : 'no cached entry'})\n`);
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
  if (typeof result.data?.kind === 'string' && result.data.kind.startsWith('credential-')) {
    if (result.data.kind === 'credential-reveal' && result.data.mode === 'stdout') {
      const value = String(result.data.value);
      process.stdout.write(value.endsWith('\n') ? value : `${value}\n`);
      return;
    }
    const formatted = formatCredentialResult(result.data);
    if (formatted !== null) {
      process.stdout.write(`${formatted}\n`);
      return;
    }
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
  if (result.data?.kind === 'session-participants') {
    const items = result.data.participants ?? [];
    out.write(`participants: ${items.length}\n`);
    for (const item of items) {
      out.write(`${item.role ?? ''}  ${item.principalKind ?? ''}  ${item.principalId ?? ''}`
        + `  order=${item.orderIndex ?? '?'}  wake=${item.wakePolicy ?? '?'}  respond=${item.respondPolicy ?? '?'}`
        + `${item.disabledAt ? '  disabled' : ''}\n`);
    }
    return;
  }
  if (result.data?.kind === 'session-participant') {
    if (result.data.action === 'remove') {
      out.write(`removed: ${result.data.participantId}\n`);
    } else {
      const view = result.data.participant ?? {};
      const id = view.participantId ?? result.data.participantId ?? '';
      out.write(`${result.data.action === 'add' ? 'added' : 'updated'}: ${id}`
        + `  role=${view.role ?? '?'}  wake=${view.wakePolicy ?? '?'}  respond=${view.respondPolicy ?? '?'}\n`);
    }
    return;
  }
  if (result.data?.kind === 'chat-sent') {
    out.write(`run: ${result.data.runId ?? ''}  status: ${result.data.status ?? ''}`
      + `${result.data.asParticipantId ? `  as=${result.data.asParticipantId}` : ''}\n`);
    return;
  }
  if (result.data?.kind === 'agent-created') {
    const id = result.data.principalId ?? result.data.principal?.principalId ?? '';
    out.write(`${result.data.created ? 'created' : 'existing'}: ${id}${result.data.idempotent ? ' (idempotent)' : ''}\n`);
    return;
  }
  if (result.data?.kind === 'agent-list') {
    out.write(`agents: ${result.data.items.length}\n`);
    for (const item of result.data.items) {
      out.write(`${item.principalId ?? item.id ?? ''}  ${item.name ?? ''}  ${item.scope ?? item.source ?? ''}\n`);
    }
    return;
  }
  if (result.data?.kind === 'agent-binding') {
    const verb = result.data.action === 'bind'
      ? (result.data.alreadyBound ? 'already bound' : 'bound')
      : (result.data.alreadyUnbound ? 'already unbound' : 'unbound');
    out.write(`${verb}: ${result.data.principalId} -> ${result.data.workspaceId}\n`);
    return;
  }
  if (result.data?.kind === 'agent-disabled') {
    out.write(`${result.data.alreadyDisabled ? 'already disabled' : 'disabled'}: ${result.data.principalId}\n`);
    return;
  }
  if (result.data?.kind === 'provider-limits') {
    const limits = result.data.limits ?? {};
    out.write(`connection: ${result.data.connectionId}\n`);
    for (const key of ['maxInflight', 'maxQueue', 'windowTokenBudget', 'windowSeconds']) {
      if (limits[key] !== undefined) out.write(`${key}: ${limits[key]}\n`);
    }
    if (Array.isArray(limits.modelLimits)) {
      for (const item of limits.modelLimits) {
        out.write(`model ${item.provider}:${item.model}  maxInflight=${item.maxInflight ?? '-'} maxQueue=${item.maxQueue ?? '-'}\n`);
      }
    }
    return;
  }
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
  if (Array.isArray(result.data?.skills)) {
    for (const skill of result.data.skills) {
      const scope = skill.definitionScope?.type === 'workspace'
        ? `workspace:${skill.definitionScope.workspaceId}`
        : 'instance';
      process.stdout.write(`${skill.skillId}  ${skill.name}  ${scope}  v${skill.version}`
        + `${skill.oversize ? '  OVERSIZE' : ''}${skill.trusted ? '  trusted' : ''}\n`);
    }
    if (result.data.skills.length === 0) process.stdout.write('No visible skills.\n');
    return;
  }
  if (Array.isArray(result.data?.bindings)) {
    for (const binding of result.data.bindings) {
      const scope = binding.scopeType === 'workspace' ? `workspace:${binding.scopeId}` : 'instance';
      process.stdout.write(`${binding.bindingId}  ${binding.subjectType}:${binding.subjectId}  ${scope}\n`);
    }
    if (result.data.bindings.length === 0) process.stdout.write('No bindings.\n');
    return;
  }
  if (result.data?.summary && Array.isArray(result.data?.results)) {
    const { summary } = result.data;
    process.stdout.write(`created=${summary.created} updated=${summary.updated} unchanged=${summary.unchanged} rejected=${summary.rejected} oversize=${summary.oversize}\n`);
    for (const rejected of result.data.rejected) {
      process.stderr.write(`[${rejected.code}] ${rejected.sourcePath ?? '<unknown>'}: ${rejected.detail ?? ''}\n`);
    }
    return;
  }
  if (result.data?.skill) {
    const skill = result.data.skill;
    process.stdout.write(`${skill.skillId}  ${skill.name}  v${skill.version}  ${skill.bodyTokensEst} tok${skill.oversize ? '  OVERSIZE' : ''}\n`);
    return;
  }
  if (result.data?.binding) {
    process.stdout.write(`bound ${result.data.binding.bindingId}\n`);
    return;
  }
  if (typeof result.data?.removed === 'string') {
    process.stdout.write(`removed ${result.data.removed}\n`);
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
  // spec §3 row 0: a success that reports `partial: true` is not a full success.
  const partial = result.exitCode === 0 && result.data?.partial === true;
  process.exitCode = partial ? 1 : result.exitCode;
}
