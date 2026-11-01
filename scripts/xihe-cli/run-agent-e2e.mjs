#!/usr/bin/env node
/**
 * PLAN-0622 T2.3 runner: one command for the A5 (PERSONAL lifecycle) + A6
 * (connection limit 429) evidence, against a live CP.
 *
 *   node scripts/xihe-cli/run-agent-e2e.mjs --cp <url> [--ui-workspace <ws>] [--json]
 *        [--email <account>] [--password-env <ENV_NAME>]
 *
 * Exit codes: 0 pass · 1 verification failure · 2 usage error ·
 *             3 SCOPE_UNSUPPORTED (CP M1.2 missing) · 4 LIMIT_UNSUPPORTED (CP M1.5 missing).
 * Provisional outcomes are reported as their own exit code — never as a pass.
 */
import { pathToFileURL } from 'node:url';
import { CliError, parseOptions } from './provider.mjs';
import { bindingRequestBody, resolveSessionBinding } from './session-binding.mjs';
import { runPersonalLifecycleProbe, runResourceLimitProbe } from './verify.mjs';

function usageError(message) {
  return new CliError('INVALID_ARGUMENT', message, {}, 2);
}

// Authorization is never captured at all (evidence only carries response fields);
// the pattern also drops any header-shaped key defensively.
const SENSITIVE_KEY = /token|secret|password|apikey|api_key|credential|authorization|bearer/i;

/** Evidence is quoted in plans: never leak tokens/keys, and bound long strings. */
function sanitizeEvidence(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeEvidence(item));
  if (typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) continue;
      result[key] = sanitizeEvidence(item);
    }
    return result;
  }
  return value;
}

/** Raw step statuses (probe vocabulary) → the three outcomes quoted in evidence. */
function outcomeOf(status) {
  if (status === 'PASS') return 'pass';
  if (status === 'FAIL') return 'fail';
  return 'unsupported';
}

function summarize({ exitCode, data, error, apiBase, workspaceId }) {
  const a5 = data?.personal ? outcomeOf(data.personal.status) : 'n/a';
  const a6 = data?.limit ? outcomeOf(data.limit.status) : 'n/a';
  const label = exitCode === 0 ? 'PASS'
    : exitCode === 3 ? 'SCOPE_UNSUPPORTED'
      : exitCode === 4 ? 'LIMIT_UNSUPPORTED' : 'FAIL';
  const reason = error?.message ?? data?.gate ?? null;
  return {
    exitCode,
    label,
    a5,
    a6,
    cp: apiBase,
    workspaceId,
    at: new Date().toISOString(),
    ...(exitCode === 0 ? {} : { reason }),
  };
}

function summaryLine(summary) {
  return `[agent-e2e] exit=${summary.exitCode} ${summary.label}`
    + `  a5=${summary.a5} a6=${summary.a6}  cp=${summary.cp} ws=${summary.workspaceId} at=${summary.at}`;
}

function createClient({ apiBase, fetchImpl, token }) {
  return {
    async call(method, pathname, { body, timeoutMs = 10_000 } = {}) {
      const headers = { Authorization: `Bearer ${token}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let response;
      try {
        response = await fetchImpl(`${apiBase}${pathname}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
        return {
          status: 0,
          body: null,
          code: aborted ? 'REQUEST_TIMEOUT' : 'CONNECTION_FAILED',
          retryAfter: null,
        };
      }
      let text = '';
      try { text = await response.text(); } catch { /* status carries the result */ }
      let parsed = null;
      if (text.trim() !== '') {
        try { parsed = JSON.parse(text); } catch { parsed = null; }
      }
      return {
        status: response.status,
        body: parsed,
        code: typeof parsed?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(parsed.code) ? parsed.code : null,
        retryAfter: response.headers?.get?.('retry-after') ?? null,
      };
    },
  };
}

async function login({ apiBase, fetchImpl, email, password }) {
  const response = await fetchImpl(`${apiBase}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: email, password }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => null);
  if (response.status !== 200 || typeof body?.accessToken !== 'string') {
    throw new CliError(body?.code ?? 'LOGIN_FAILED', `Login failed (HTTP ${response.status}).`, {}, 1);
  }
  return body.accessToken;
}

function codeOf(response, fallback) {
  return response.code ?? fallback;
}

export async function runAgentE2E({ env, fetchImpl = fetch, options }) {
  const apiBase = String(options['--cp'] ?? '').trim().replace(/\/$/, '');
  if (!apiBase) throw usageError('--cp <url> is required (e.g. --cp http://127.0.0.1:12631).');
  const workspaceId = String(options['--ui-workspace'] ?? '').trim();
  if (!workspaceId) throw usageError('--ui-workspace <wsId> is required.');
  const email = String(options['--email'] ?? 'admin@xihe.local').trim();
  const passwordEnv = String(options['--password-env'] ?? 'XIHE_DEV_ADMIN_PASSWORD').trim();
  const password = env[passwordEnv];
  if (typeof password !== 'string' || password === '') {
    throw usageError(`Set the CP password via --password-env (default ${passwordEnv}); it is never read from argv.`);
  }

  const steps = [];
  const step = (name, rawStatus, detail = null, evidence = null) => {
    const entry = {
      name,
      status: outcomeOf(rawStatus),
      rawStatus,
      ...(detail ? { detail } : {}),
      ...(evidence ? { evidence: sanitizeEvidence(evidence) } : {}),
    };
    steps.push(entry);
    return entry;
  };

  const token = await login({ apiBase, fetchImpl, email, password });
  const client = createClient({ apiBase, fetchImpl, token });

  // Gate 1: CP M1.2 (scope support). A bare 404/400 here means the contract is absent.
  const scopeProbe = await client.call('GET', '/api/v1/agent-principals?scope=PERSONAL');
  if (scopeProbe.status !== 200) {
    if ([400, 404, 405, 422].includes(scopeProbe.status)) {
      step('scope support', 'SCOPE_UNSUPPORTED', `GET /agent-principals?scope=PERSONAL → HTTP ${scopeProbe.status}（CP M1.2 未交付）`, {
        httpStatus: scopeProbe.status,
        endpoint: 'GET /agent-principals?scope=PERSONAL',
      });
      return { exitCode: 3, data: { kind: 'agent-e2e', steps, gate: 'SCOPE_UNSUPPORTED' } };
    }
    throw new CliError(codeOf(scopeProbe, 'SCOPE_PROBE_FAILED'), `Scope probe failed (HTTP ${scopeProbe.status}).`, {}, 1);
  }
  step('scope support', 'PASS', 'GET /agent-principals?scope=PERSONAL → 200', {
    httpStatus: 200,
    endpoint: 'GET /agent-principals?scope=PERSONAL',
  });

  const personal = await runPersonalLifecycleProbe({ client, workspaceId });
  step('A5 PERSONAL lifecycle', personal.status, personal.detail, {
    principalId: personal.principalId ?? null,
    lifecycle: 'create/bind/list(source=personal)/unbind/list-absent',
  });
  if (personal.status === 'FAIL') {
    throw new CliError(personal.code, personal.detail, { step: 'A5' }, 1);
  }
  if (personal.status !== 'PASS' || !personal.principalId) {
    step('A5 PERSONAL lifecycle', 'SKIP_PROVISIONAL', personal.code ?? 'no principalId');
    return { exitCode: 3, data: { kind: 'agent-e2e', steps, gate: personal.code ?? 'SCOPE_UNSUPPORTED', personal } };
  }

  // A6 needs a bound principal + session + branch on a direct_attach workspace.
  const bound = await client.call('PUT', `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(personal.principalId)}`, {
    body: { permissions: [] },
  });
  if (![200, 201, 204, 409].includes(bound.status)) {
    throw new CliError(codeOf(bound, 'PERSONAL_REBIND_FAILED'), `Re-binding the PERSONAL principal failed (HTTP ${bound.status}).`, { step: 'A6-prep' }, 1);
  }
  step('A6 prep bind', 'PASS', `principal=${personal.principalId}`);

  const resolved = await resolveSessionBinding({ client, stack: 'agent-e2e' });
  if (resolved.error) {
    throw new CliError(resolved.error.code, resolved.error.message, { step: 'A6-prep' }, 1);
  }
  const session = await client.call('POST', '/api/v1/sessions', {
    body: bindingRequestBody(resolved.binding, {
      title: 'xihe-agent-e2e',
      agentPrincipalId: personal.principalId,
    }),
  });
  const sessionId = typeof session.body?.id === 'string' ? session.body.id
    : typeof session.body?.sessionId === 'string' ? session.body.sessionId : null;
  if (![200, 201].includes(session.status) || !sessionId) {
    throw new CliError(codeOf(session, 'SESSION_CREATE_FAILED'), `Creating the A6 session failed (HTTP ${session.status}).`, { step: 'A6-prep' }, 1);
  }
  step('A6 prep session', 'PASS', `session=${sessionId}`);

  let branchId = null;
  try {
    const branches = await client.call('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/branches`);
    branchId = Array.isArray(branches.body?.items) ? branches.body.items[0]?.branchId : null;
    if (branches.status !== 200 || typeof branchId !== 'string') {
      throw new CliError('SESSION_BRANCH_MISSING', 'The A6 session has no root branch.', { step: 'A6-prep' }, 1);
    }
    step('A6 prep branch', 'PASS', `branch=${branchId}`);

    const limit = await runResourceLimitProbe({
      client,
      connectionId: resolved.binding.connectionId,
      sessionId,
      branchId,
    });
    step('A6 RESOURCE_EXHAUSTED 429', limit.status, limit.detail, limit.evidence
      ?? { code: limit.code ?? null, connectionId: resolved.binding.connectionId });
    if (limit.status === 'FAIL') {
      throw new CliError(limit.code, limit.detail, { step: 'A6' }, 1);
    }
    if (limit.status !== 'PASS') {
      // Governor missing (M1.5) or not observable: a distinct provisional exit, never a pass.
      return {
        exitCode: 4,
        data: {
          kind: 'agent-e2e',
          steps,
          gate: limit.code ?? 'LIMIT_UNSUPPORTED',
          personal,
          session: { id: sessionId, branchId },
          limit,
        },
      };
    }
    return {
      exitCode: 0,
      data: {
        kind: 'agent-e2e',
        steps,
        personal,
        session: { id: sessionId, branchId },
        binding: resolved.binding,
        limit,
      },
    };
  } finally {
    const deleted = await client.call('DELETE', `/api/v1/sessions/${encodeURIComponent(sessionId)}`);
    step('cleanup session', deleted.status === 204 || deleted.status === 200 ? 'PASS' : 'WARN', `HTTP ${deleted.status}`);
  }
}

export async function main(argv = process.argv.slice(2), { env = process.env, fetchImpl = fetch } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${[
      'PLAN-0622 agent E2E runner (A5 PERSONAL lifecycle + A6 connection limit 429)',
      '',
      'Usage:',
      '  node scripts/xihe-cli/run-agent-e2e.mjs --cp <url> --ui-workspace <wsId> [--json]',
      '       [--email <account>] [--password-env <ENV_NAME>]',
      '',
      'Exit codes: 0 pass · 1 verification failure · 2 usage error ·',
      '            3 SCOPE_UNSUPPORTED (CP M1.2 missing) · 4 LIMIT_UNSUPPORTED (CP M1.5 missing).',
    ].join('\n')}\n`);
    return 0;
  }
  let json = false;
  const args = [];
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else args.push(arg);
  }
  let result;
  let apiBase = '';
  let workspaceId = '';
  try {
    const parsed = parseOptions(args, ['--cp', '--ui-workspace', '--email', '--password-env'], []);
    if (parsed.positionals.length !== 0) throw usageError('run-agent-e2e takes no positional arguments.');
    apiBase = String(parsed.values['--cp'] ?? '').trim().replace(/\/$/, '');
    workspaceId = String(parsed.values['--ui-workspace'] ?? '').trim();
    result = await runAgentE2E({ env, fetchImpl, options: parsed.values });
  } catch (error) {
    const cliError = error instanceof CliError
      ? error
      : new CliError('UNEXPECTED_ERROR', 'The runner failed unexpectedly; sensitive details were not printed.');
    result = {
      exitCode: cliError.exitCode ?? 1,
      error: { code: cliError.code, message: cliError.message, ...(cliError.details ?? {}) },
    };
  }
  const summary = summarize({
    exitCode: result.exitCode,
    data: result.data,
    error: result.error,
    apiBase,
    workspaceId,
  });
  if (json) {
    const payload = result.error
      ? { ok: false, summary, error: result.error }
      : { ok: result.exitCode === 0, summary, data: result.data };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    for (const stepItem of result.data?.steps ?? []) {
      process.stdout.write(`${stepItem.name}: ${stepItem.status}${stepItem.detail ? ` (${stepItem.detail})` : ''}\n`);
    }
    if (result.error) process.stderr.write(`[${result.error.code}] ${result.error.message}\n`);
    if (result.data?.gate) process.stdout.write(`gate: ${result.data.gate}\n`);
  }
  // 供 Lead 直接 grep/引用的一行总结（stderr：保持 --json 的 stdout 可解析）。
  process.stderr.write(`${summaryLine(summary)}\n`);
  if (summary.reason) process.stderr.write(`[agent-e2e] reason: ${summary.reason}\n`);
  return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = await main();
  process.exitCode = exitCode;
}
