/**
 * PLAN-0643 M6-2 (T3.1-T3.4) — chat run/cancel/approvals read+write surface and
 * session list/get/export read surface.
 *
 * Dispatch contract (spec/cli-contract.md §2): `chat run` GETs
 * /api/v1/chat/runs/{runId} (optional --attempts / --trace side reads), `chat cancel`
 * POSTs .../cancel (CP is idempotent for an already-cancelling run and answers
 * 409 RUN_NOT_CANCELLABLE for a terminal one — both pass through verbatim),
 * `chat approvals` GETs /api/v1/approvals/pending (array envelope), and
 * `chat approve|reject` POSTs the decision body. `session list/get/export` hit
 * /api/v1/sessions, /{id} and /{id}/export (Markdown text).
 *
 * Workspace context: spec §7 — these endpoints carry X-Workspace-Id. A per-command
 * `--workspace` sets the header explicitly (same semantics as the participants
 * family); without it, the runCommand-level wrapper injects the header from
 * XIHE_WORKSPACE_ID (same source after V12 conflict checking). CP error codes pass
 * through with `preserveServerCodes` (409 WORKSPACE_CONTEXT_REQUIRED /
 * RUN_NOT_CANCELLABLE etc. surface verbatim, exit 1 — business failures, not
 * usage errors).
 */
import { CliError, login, parseOptions, requestJson } from './provider.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;

function usageError(message) {
  // No 4th argument: INVALID_ARGUMENT is a usage code and the runCommand catch
  // maps it to exit 2 (same convention as config.mjs).
  return new CliError('INVALID_ARGUMENT', message);
}

function requirePositionalCount(parsed, count, usage) {
  if (parsed.positionals.length !== count) {
    throw usageError(usage);
  }
  return parsed.positionals;
}

function requireBranch(options) {
  const branchId = String(options['--branch'] ?? '').trim();
  if (branchId === '') throw usageError('This command requires --branch <branchId>.');
  return branchId;
}

// V12 trailing-flag form: runCommand guards the leading `--workspace` (stripped
// into globals), so a conflict between a group-level --workspace and
// XIHE_WORKSPACE_ID is checked here with the same message and exit code.
function assertWorkspaceAgreement(workspaceId, env) {
  if (workspaceId === '') return;
  const fromEnv = typeof env.XIHE_WORKSPACE_ID === 'string' ? env.XIHE_WORKSPACE_ID.trim() : '';
  if (fromEnv !== '' && fromEnv !== workspaceId) {
    throw usageError('--workspace and XIHE_WORKSPACE_ID are both set with different values; provide only one of them.');
  }
}

async function fetchMarkdown({ apiBase, fetchImpl, token, path, workspaceId }) {
  // /sessions/{id}/export answers text/markdown, not JSON, so this side read does
  // its own fetch instead of going through requestJson.
  const headers = { Authorization: `Bearer ${token}` };
  if (workspaceId) headers['X-Workspace-Id'] = workspaceId;
  let response;
  try {
    response = await fetchImpl(`${apiBase}${path}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    throw new CliError(aborted ? 'REQUEST_TIMEOUT' : 'CONNECTION_FAILED', `CP did not answer GET ${path}.`);
  }
  if (response.status !== 200) {
    let code = `HTTP_${response.status}`;
    try {
      const problem = JSON.parse(await response.text());
      if (typeof problem?.code === 'string' && /^[A-Z0-9_]{1,90}$/.test(problem.code)) code = problem.code;
    } catch { /* status carries the result */ }
    throw new CliError(code, `CP rejected session export (HTTP ${response.status}).`, { httpStatus: response.status });
  }
  return response.text();
}

function asArrayEnvelope(body, kind) {
  if (!Array.isArray(body)) {
    throw new CliError('CP_RESPONSE_INVALID', `CP returned no array envelope for ${kind}.`);
  }
  return body;
}

// spec §7: session/chat/audit/workspace-scoped reads carry X-Workspace-Id. A
// per-command `--workspace` sets it explicitly (participants semantics); without
// one, the runCommand-level wrapper injects it from XIHE_WORKSPACE_ID (same
// source after V12 conflict checking), so an empty value here stays header-less
// only when neither channel provided a workspace.
function workspaceHeaders(workspaceId) {
  return workspaceId ? { 'X-Workspace-Id': workspaceId } : undefined;
}

export async function runChatRun({ apiBase, fetchImpl, token, runId, options, workspaceId }) {
  const headers = workspaceHeaders(workspaceId);
  const run = await requestJson(`/api/v1/chat/runs/${encodeURIComponent(runId)}`, {
    apiBase, fetchImpl, token, headers, preserveServerCodes: true,
  });
  const data = { kind: 'chat-run', ...run };
  if (options['--attempts'] === true) {
    data.attempts = await requestJson(`/api/v1/chat/runs/${encodeURIComponent(runId)}/attempts`, {
      apiBase, fetchImpl, token, headers, preserveServerCodes: true,
    });
  }
  if (options['--trace'] === true) {
    data.trace = await requestJson(`/api/v1/chat/runs/${encodeURIComponent(runId)}/trace`, {
      apiBase, fetchImpl, token, headers, preserveServerCodes: true,
    });
  }
  return data;
}

export async function runChatCancel({ apiBase, fetchImpl, token, runId, options, workspaceId }) {
  const reason = String(options['--reason'] ?? '').trim();
  const body = reason === '' ? undefined : { reason };
  const result = await requestJson(`/api/v1/chat/runs/${encodeURIComponent(runId)}/cancel`, {
    apiBase, fetchImpl, token, method: 'POST', body, headers: workspaceHeaders(workspaceId), preserveServerCodes: true,
  });
  return { kind: 'chat-cancelled', runId, ...(result ?? {}) };
}

export async function runChatApprovals({ apiBase, fetchImpl, token, workspaceId }) {
  const pending = asArrayEnvelope(
    await requestJson('/api/v1/approvals/pending', {
      apiBase, fetchImpl, token, headers: workspaceHeaders(workspaceId), preserveServerCodes: true,
    }),
    'chat approvals',
  );
  return { kind: 'chat-approvals', items: pending };
}

export async function runChatApprovalDecision({ apiBase, fetchImpl, token, requestId, decision, options, workspaceId }) {
  const body = { decision };
  const feedback = String(options['--feedback'] ?? '').trim();
  if (feedback !== '') {
    if (decision !== 'reject') {
      throw usageError('--feedback only applies to chat reject.');
    }
    body.feedback = feedback;
  }
  const result = await requestJson(`/api/v1/chat/approvals/${encodeURIComponent(requestId)}/decision`, {
    apiBase, fetchImpl, token, method: 'POST', body, headers: workspaceHeaders(workspaceId), preserveServerCodes: true,
  });
  return { kind: 'chat-approval-decision', requestId, decision, ...(result ?? {}) };
}

export async function runSessionList({ apiBase, fetchImpl, token, workspaceId }) {
  const body = await requestJson('/api/v1/sessions', {
    apiBase, fetchImpl, token, headers: workspaceHeaders(workspaceId), preserveServerCodes: true,
  });
  if (!Array.isArray(body?.sessions)) {
    throw new CliError('CP_RESPONSE_INVALID', 'CP returned no {sessions:[...]} envelope.');
  }
  return { kind: 'session-list', sessions: body.sessions };
}

export async function runSessionGet({ apiBase, fetchImpl, token, sessionId, workspaceId }) {
  const session = await requestJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
    apiBase, fetchImpl, token, headers: workspaceHeaders(workspaceId), preserveServerCodes: true,
  });
  return { kind: 'session', session };
}

export async function runSessionExport({ apiBase, fetchImpl, token, sessionId, options, workspaceId }) {
  const branchId = requireBranch(options);
  const markdown = await fetchMarkdown({
    apiBase, fetchImpl, token, workspaceId,
    path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/export?branchId=${encodeURIComponent(branchId)}`,
  });
  return { kind: 'session-export', sessionId, branchId, markdown };
}

export async function runChatCommand({ command, rest, env, fetchImpl, apiBase, promptSecret }) {
  const parsed = parseOptions(rest, ['--reason', '--feedback', '--email', '--workspace'], ['--attempts', '--trace']);
  const token = await login({ apiBase, fetchImpl, env, options: parsed.values['--email'] ? { '--email': parsed.values['--email'] } : {}, promptSecret });
  const workspaceId = parsed.values['--workspace']?.trim() || '';
  assertWorkspaceAgreement(workspaceId, env);
  let data;
  if (command === 'run') {
    const [runId] = requirePositionalCount(parsed, 1, 'Usage: xihe chat run <runId> [--attempts] [--trace].');
    data = await runChatRun({ apiBase, fetchImpl, token, runId, options: parsed.values, workspaceId });
  } else if (command === 'cancel') {
    const [runId] = requirePositionalCount(parsed, 1, 'Usage: xihe chat cancel <runId> [--reason <text>].');
    data = await runChatCancel({ apiBase, fetchImpl, token, runId, options: parsed.values, workspaceId });
  } else if (command === 'approvals') {
    requirePositionalCount(parsed, 0, 'chat approvals takes no positional arguments.');
    data = await runChatApprovals({ apiBase, fetchImpl, token, workspaceId });
  } else if (command === 'approve' || command === 'reject') {
    const [requestId] = requirePositionalCount(parsed, 1, `Usage: xihe chat ${command} <requestId> [--feedback <text>].`);
    data = await runChatApprovalDecision({
      apiBase, fetchImpl, token, requestId,
      decision: command === 'approve' ? 'once' : 'reject',
      options: parsed.values, workspaceId,
    });
  } else {
    throw usageError('Unknown chat command; use run/cancel/approvals/approve/reject.');
  }
  return { exitCode: 0, data };
}

export async function runSessionCommand({ command, rest, env, fetchImpl, apiBase, promptSecret }) {
  const parsed = parseOptions(rest, ['--branch', '--email', '--workspace'], []);
  const token = await login({ apiBase, fetchImpl, env, options: parsed.values['--email'] ? { '--email': parsed.values['--email'] } : {}, promptSecret });
  const workspaceId = parsed.values['--workspace']?.trim() || '';
  assertWorkspaceAgreement(workspaceId, env);
  let data;
  if (command === 'list') {
    requirePositionalCount(parsed, 0, 'session list takes no positional arguments.');
    data = await runSessionList({ apiBase, fetchImpl, token, workspaceId });
  } else if (command === 'get') {
    const [sessionId] = requirePositionalCount(parsed, 1, 'Usage: xihe session get <sessionId>.');
    data = await runSessionGet({ apiBase, fetchImpl, token, sessionId, workspaceId });
  } else if (command === 'export') {
    const [sessionId] = requirePositionalCount(parsed, 1, 'Usage: xihe session export <sessionId> --branch <branchId>.');
    data = await runSessionExport({ apiBase, fetchImpl, token, sessionId, options: parsed.values, workspaceId });
  } else {
    throw usageError('Unknown session command; use participants/list/get/export.');
  }
  return { exitCode: 0, data };
}
