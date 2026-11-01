/**
 * PLAN-0623 M2 — session participant command family (`xihe session participants ...`)
 * and `xihe chat send`.
 *
 * Domain note: participants live in the **session** domain, not the agent-principal
 * domain, so this module is intentionally separate from `agent.mjs`.
 *
 * Contract: `docs/api/openapi.yaml` PLAN-0623 M0 (`x-plan-0623.status=contract-only`).
 * CP codes are passed through verbatim (`PARTICIPANT_PRIMARY_IMMUTABLE`,
 * `PARTICIPANT_ALREADY_EXISTS`, `PARTICIPANT_PRIMARY_EXISTS`, ...).
 */
import { CliError, getApiBase, login, parseOptions } from './provider.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;

const PRINCIPAL_KINDS = new Set(['AGENT', 'HUMAN']);
const ROLES = new Set(['MEMBER', 'GUARD']);
const WAKE_POLICIES = new Set(['ALL_MESSAGES', 'MENTION']);
const RESPOND_POLICIES = new Set(['ALWAYS', 'WHEN_MENTIONED', 'JUDGE', 'MUTED']);

function usageError(message) {
  return new CliError('INVALID_ARGUMENT', message, {}, 2);
}

function requireSession(options) {
  const sessionId = String(options['--session'] ?? '').trim();
  if (!sessionId) throw usageError('This command requires --session <sessionId>.');
  return sessionId;
}

function requireParticipant(options) {
  const participantId = String(options['--participant'] ?? '').trim();
  if (!participantId) throw usageError('This command requires --participant <participantId>.');
  return participantId;
}

function normalizeEnum(value, allowed, flag, { optional = true } = {}) {
  if (value === undefined) {
    if (optional) return undefined;
    throw usageError(`${flag} is required.`);
  }
  const text = String(value).trim().toUpperCase();
  if (!allowed.has(text)) {
    throw usageError(`${flag} must be one of ${[...allowed].join(', ')}.`);
  }
  return text;
}

async function callApi({ apiBase, fetchImpl, token, method, path, body, workspaceId, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const headers = { Authorization: `Bearer ${token}` };
  if (workspaceId) headers['X-Workspace-Id'] = workspaceId;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    throw new CliError(aborted ? 'REQUEST_TIMEOUT' : 'CONNECTION_FAILED', `CP did not answer ${method} ${path}.`, {}, 1);
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
    code: typeof parsed?.code === 'string' && /^[A-Z0-9_]{1,90}$/.test(parsed.code) ? parsed.code : null,
    retryAfter: response.headers?.get?.('retry-after') ?? null,
  };
}

/** CP 4xx/5xx codes are business failures (exit 1) and always surface verbatim. */
function expectSuccess(response, action, accepted = [200, 201, 204]) {
  if (accepted.includes(response.status)) return response;
  const code = response.code ?? `HTTP_${response.status}`;
  throw new CliError(code, `CP rejected ${action} (HTTP ${response.status}${response.code ? ` ${response.code}` : ''}).`, {
    httpStatus: response.status,
    ...(response.retryAfter ? { retryAfter: response.retryAfter } : {}),
  }, 1);
}

export async function listParticipants({ apiBase, fetchImpl, token, options }) {
  const sessionId = requireSession(options);
  const response = await callApi({
    apiBase, fetchImpl, token, method: 'GET',
    path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/participants`,
    workspaceId: options['--workspace']?.trim() || '',
  });
  expectSuccess(response, 'session participant listing');
  if (!Array.isArray(response.body?.participants)) {
    throw new CliError('PARTICIPANT_LIST_ENVELOPE_INVALID', 'CP returned no {participants:[...]} envelope.', {}, 1);
  }
  return { kind: 'session-participants', sessionId, participants: response.body.participants };
}

export async function addParticipant({ apiBase, fetchImpl, token, options }) {
  const sessionId = requireSession(options);
  const principalId = String(options['--principal'] ?? '').trim();
  if (!principalId) throw usageError('This command requires --principal <principalId>.');
  const body = {
    principalKind: normalizeEnum(options['--kind'], PRINCIPAL_KINDS, '--kind', { optional: false }),
    principalId,
  };
  const role = normalizeEnum(options['--role'], ROLES, '--role');
  if (role) body.role = role;
  const wake = normalizeEnum(options['--wake'], WAKE_POLICIES, '--wake');
  if (wake) body.wakePolicy = wake;
  const respond = normalizeEnum(options['--respond'], RESPOND_POLICIES, '--respond');
  if (respond) body.respondPolicy = respond;
  const response = await callApi({
    apiBase, fetchImpl, token, method: 'POST',
    path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/participants`,
    body,
    workspaceId: options['--workspace']?.trim() || '',
  });
  // D23-13: second PRIMARY → PARTICIPANT_PRIMARY_EXISTS; duplicate → PARTICIPANT_ALREADY_EXISTS.
  expectSuccess(response, 'session participant add');
  return { kind: 'session-participant', action: 'add', sessionId, participant: response.body };
}

export async function removeParticipant({ apiBase, fetchImpl, token, options }) {
  const sessionId = requireSession(options);
  const participantId = requireParticipant(options);
  const response = await callApi({
    apiBase, fetchImpl, token, method: 'DELETE',
    path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/participants/${encodeURIComponent(participantId)}`,
    workspaceId: options['--workspace']?.trim() || '',
  });
  // PRIMARY removal → 409 PARTICIPANT_PRIMARY_IMMUTABLE; pass the code through unchanged.
  expectSuccess(response, 'session participant remove');
  return { kind: 'session-participant', action: 'remove', sessionId, participantId };
}

export async function updateParticipantPolicy({ apiBase, fetchImpl, token, options }) {
  const sessionId = requireSession(options);
  const participantId = requireParticipant(options);
  const body = {};
  const wake = normalizeEnum(options['--wake'], WAKE_POLICIES, '--wake');
  if (wake) body.wakePolicy = wake;
  const respond = normalizeEnum(options['--respond'], RESPOND_POLICIES, '--respond');
  if (respond) body.respondPolicy = respond;
  if (Object.keys(body).length === 0) {
    throw usageError('Provide at least one of --wake / --respond.');
  }
  const response = await callApi({
    apiBase, fetchImpl, token, method: 'PATCH',
    path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/participants/${encodeURIComponent(participantId)}`,
    body,
    workspaceId: options['--workspace']?.trim() || '',
  });
  expectSuccess(response, 'session participant policy update');
  return { kind: 'session-participant', action: 'policy', sessionId, participantId, participant: response.body };
}

/**
 * `chat send --session --branch --content [--as <participantId>]`.
 *
 * D23-08: `--as` means "speak as a participant I am authorised for" — the CLI never
 * grants an administrator an implicit `--as`; CP returns 403 with a concrete code when
 * the caller may not act for that participant.
 *
 * Contract gap (reported to Lead): the M0 `ChatRequest` schema has no `asParticipantId`
 * field yet, so we send it only when the flag is used and surface CP 400 verbatim.
 */
export async function sendChat({ apiBase, fetchImpl, token, options }) {
  const sessionId = requireSession(options);
  const branchId = String(options['--branch'] ?? '').trim();
  if (!branchId) throw usageError('This command requires --branch <branchId>.');
  const content = String(options['--content'] ?? '');
  if (content.trim() === '') throw usageError('This command requires a non-empty --content.');
  const body = { sessionId, branchId, content };
  const asParticipantId = String(options['--as'] ?? '').trim();
  if (asParticipantId) body.asParticipantId = asParticipantId;
  const response = await callApi({
    apiBase, fetchImpl, token, method: 'POST', path: '/api/v1/chat', body,
    workspaceId: options['--workspace']?.trim() || '',
  });
  // 409 SSE_SUBSCRIPTION_REQUIRED / 403 PARTICIPANT_CAP_DENIED etc. stay verbatim.
  expectSuccess(response, 'chat send', [200, 202]);
  return {
    kind: 'chat-sent',
    sessionId,
    branchId,
    asParticipantId: asParticipantId || null,
    runId: response.body?.runId ?? null,
    status: response.body?.status ?? null,
  };
}

export function parseParticipantOptions(args, valueOptions) {
  try {
    return parseOptions(args, valueOptions, []);
  } catch (error) {
    // 用法错误统一 exit 2（provider.parseOptions 默认 1）。
    if (error instanceof CliError && error.code === 'INVALID_ARGUMENT') error.exitCode = 2;
    throw error;
  }
}

export { getApiBase, login };
