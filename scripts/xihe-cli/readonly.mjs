import { CliError, requestJson } from './provider.mjs';

// PLAN-0574 M2 read-only surface. Every command is passthrough-first: the CLI
// validates only what the design fixes (enum/integer arguments) and forwards
// server bodies and error codes unchanged (I7/I8).

const JOB_OUTPUT_DEFAULT_LIMIT = 65_536;
const JOB_OUTPUT_MAX_LIMIT = 1_048_576;
// The server clamps limit to 1..1048576 bytes of raw output; the JSON envelope
// adds overhead, so allow headroom above the wire maximum.
const JOB_OUTPUT_MAX_BYTES = 4_000_000;

function requirePositional(positionals, index, label) {
  const value = positionals[index];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CliError('INVALID_ARGUMENT', `A ${label} is required.`, {}, 1);
  }
  return value.trim();
}

function optionalInteger(values, flag, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  const raw = values[flag];
  if (raw === undefined) return fallback;
  if (!/^\d{1,9}$/.test(String(raw))) {
    throw new CliError('INVALID_ARGUMENT', `${flag} must be a non-negative integer.`, {}, 1);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new CliError('INVALID_ARGUMENT', `${flag} must be between ${min} and ${max}.`, {}, 1);
  }
  return value;
}

function buildQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return query === '' ? '' : `?${query}`;
}

async function fetchEndpoint(apiBase, pathname, { fetchImpl, token, timeoutMs = 15_000 }) {
  try {
    const response = await fetchImpl(`${apiBase}${pathname}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    let text = '';
    try { text = await response.text(); } catch { /* status carries the result */ }
    let body = null;
    if (text.trim() !== '') {
      try { body = JSON.parse(text); } catch { body = null; }
    }
    return { httpStatus: response.status, ok: response.ok, body };
  } catch (error) {
    const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    return { httpStatus: 0, ok: false, body: null, code: aborted ? 'REQUEST_TIMEOUT' : 'CONNECTION_FAILED' };
  }
}

function endpointView(result, { pickBody = true } = {}) {
  if (result.ok) {
    return { status: 'ok', httpStatus: result.httpStatus, ...(pickBody ? { body: result.body } : {}) };
  }
  return {
    status: 'failed',
    httpStatus: result.httpStatus || null,
    code: result.code ?? (typeof result.body?.code === 'string' ? result.body.code : `HTTP_${result.httpStatus}`),
  };
}

// T2.1: aggregate /status, /health and /version, keeping each failure separate.
// A partial success is reported as degraded and never as fully healthy, and
// /health (permitAll) never overrides /status's own verdict.
export async function collectStatus({ apiBase, fetchImpl, token }) {
  const [status, health, version] = await Promise.all([
    fetchEndpoint(apiBase, '/api/v1/status', { fetchImpl, token }),
    fetchEndpoint(apiBase, '/api/v1/health', { fetchImpl, token: null }),
    fetchEndpoint(apiBase, '/api/v1/version', { fetchImpl, token }),
  ]);
  const endpoints = {
    status: endpointView(status),
    health: endpointView(health),
    version: endpointView(version),
  };
  const overall = endpoints.status.status === 'ok'
    && endpoints.health.status === 'ok'
    && endpoints.version.status === 'ok' ? 'healthy' : 'degraded';
  return {
    kind: 'status',
    overall,
    endpoints: {
      status: endpoints.status,
      health: endpoints.health,
      version: endpoints.version,
    },
  };
}

export async function runWorkspaceList({ apiBase, fetchImpl, token }) {
  const body = await requestJson('/api/v1/workspaces', { apiBase, fetchImpl, token });
  if (!Array.isArray(body)) throw new CliError('CP_RESPONSE_INVALID', 'CP returned an unexpected workspace list shape.', {}, 1);
  return { kind: 'workspace-list', items: body };
}

export async function runWorkspaceGet({ apiBase, fetchImpl, token, workspaceId }) {
  const workspace = await requestJson(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}`, {
    apiBase,
    fetchImpl,
    token,
    headers: { 'X-Workspace-Id': workspaceId },
  });
  let environment;
  let environmentFailed = false;
  try {
    const env = await requestJson(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/environment`, {
      apiBase,
      fetchImpl,
      token,
      headers: { 'X-Workspace-Id': workspaceId },
    });
    environment = { retrieved: true, ...(env ?? {}) };
  } catch (error) {
    environmentFailed = true;
    environment = {
      retrieved: false,
      httpStatus: error.details?.status ?? null,
      code: error.code,
      requestId: error.details?.requestId ?? null,
    };
  }
  return {
    kind: 'workspace',
    workspace,
    environment,
    ...(environmentFailed ? { partial: 'environment' } : {}),
  };
}

export async function runJobList({ apiBase, fetchImpl, token, workspaceId }) {
  const body = await requestJson(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/jobs`, {
    apiBase,
    fetchImpl,
    token,
    headers: { 'X-Workspace-Id': workspaceId },
  });
  if (!Array.isArray(body)) throw new CliError('CP_RESPONSE_INVALID', 'CP returned an unexpected job list shape.', {}, 1);
  return { kind: 'job-list', items: body };
}

export async function runJobOutput({
  apiBase,
  fetchImpl,
  token,
  workspaceId,
  jobId,
  options,
}) {
  const stream = options['--stream'] ?? 'stdout';
  if (stream !== 'stdout' && stream !== 'stderr') {
    throw new CliError('INVALID_ARGUMENT', '--stream must be stdout or stderr.', {}, 1);
  }
  const offset = optionalInteger(options, '--offset', { min: 0, fallback: 0 });
  const limit = optionalInteger(options, '--limit', { min: 1, max: JOB_OUTPUT_MAX_LIMIT, fallback: JOB_OUTPUT_DEFAULT_LIMIT });
  const body = await requestJson(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/jobs/${encodeURIComponent(jobId)}/output`
      + buildQuery({ stream, offset, limit }),
    {
      apiBase,
      fetchImpl,
      token,
      maxBytes: JOB_OUTPUT_MAX_BYTES,
      headers: { 'X-Workspace-Id': workspaceId },
    },
  );
  const text = typeof body?.data === 'string' ? body.data : '';
  return {
    kind: 'job-output',
    jobId: body?.jobId ?? null,
    runtimeJobId: body?.runtimeJobId ?? null,
    stream: body?.stream ?? stream,
    offset: body?.offset ?? offset,
    nextOffset: body?.nextOffset ?? null,
    sizeBytes: body?.sizeBytes ?? null,
    truncated: body?.truncated === true,
    jobStatus: body?.jobStatus ?? null,
    text,
  };
}

export async function runCheckpointList({ apiBase, fetchImpl, token, workspaceId }) {
  const body = await requestJson(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/checkpoints`, {
    apiBase,
    fetchImpl,
    token,
    headers: { 'X-Workspace-Id': workspaceId },
  });
  if (!Array.isArray(body)) throw new CliError('CP_RESPONSE_INVALID', 'CP returned an unexpected checkpoint list shape.', {}, 1);
  let retention;
  let retentionFailed = false;
  try {
    retention = { retrieved: true, ...(await requestJson(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/checkpoints/retention`, {
      apiBase,
      fetchImpl,
      token,
      headers: { 'X-Workspace-Id': workspaceId },
    }) ?? {}) };
  } catch (error) {
    retentionFailed = true;
    retention = {
      retrieved: false,
      httpStatus: error.details?.status ?? null,
      code: error.code,
      requestId: error.details?.requestId ?? null,
    };
  }
  return {
    kind: 'checkpoint-list',
    items: body,
    retention,
    ...(retentionFailed ? { partial: 'retention' } : {}),
  };
}

export async function runScheduledTaskList({ apiBase, fetchImpl, token, workspaceId, options }) {
  const page = optionalInteger(options, '--page', { min: 0, fallback: 0 });
  const size = optionalInteger(options, '--size', { min: 1, max: 200, fallback: 100 });
  const body = await requestJson(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/scheduled-tasks${buildQuery({ page, size })}`,
    { apiBase, fetchImpl, token, headers: { 'X-Workspace-Id': workspaceId } },
  );
  return {
    kind: 'scheduled-task-list',
    workspaceId: body?.workspaceId ?? workspaceId,
    page: body?.page ?? page,
    size: body?.size ?? size,
    items: Array.isArray(body?.tasks) ? body.tasks : [],
  };
}

// T3.1: POST with no body; the server's idempotency (`changed:false` for an
// already-terminal job) is passed through untouched (I7). A lost connection or
// a post-write 5xx surfaces as OPERATION_OUTCOME_UNKNOWN and is never replayed.
// The contract requires jobId/status/changed on 2xx; anything else is a broken
// response and must fail explicitly instead of synthesizing `changed:false`.
export async function runJobCancel({ apiBase, fetchImpl, token, workspaceId, jobId }) {
  const body = await requestJson(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/jobs/${encodeURIComponent(jobId)}/cancel`,
    {
      apiBase,
      fetchImpl,
      token,
      method: 'POST',
      headers: { 'X-Workspace-Id': workspaceId },
    },
  );
  if (!body
    || typeof body.jobId !== 'string' || body.jobId === ''
    || typeof body.status !== 'string' || body.status === ''
    || typeof body.changed !== 'boolean') {
    throw new CliError('CP_RESPONSE_INVALID', 'CP returned an unexpected job cancel response shape.', {}, 1);
  }
  return {
    kind: 'job-cancel',
    jobId: body.jobId,
    status: body.status,
    changed: body.changed,
  };
}

// T3.2: preview only. The request body is strictly {"sliceRef": "..."} (extra
// keys are rejected by CP with 400) and nothing is reverted by this command.
// The contract requires sliceRef/counts/entries/truncated on 2xx; anything else
// (204, null, empty object) fails explicitly instead of synthesizing a preview.
export async function runCheckpointPreviewRevert({ apiBase, fetchImpl, token, workspaceId, sliceRef }) {
  if (typeof sliceRef !== 'string' || sliceRef.trim() === '') {
    throw new CliError('INVALID_ARGUMENT', 'A sliceRef is required.', {}, 1);
  }
  const body = await requestJson(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/checkpoints/revert/preview`,
    {
      apiBase,
      fetchImpl,
      token,
      method: 'POST',
      body: { sliceRef: sliceRef.trim() },
      headers: { 'X-Workspace-Id': workspaceId },
    },
  );
  if (!body
    || typeof body.sliceRef !== 'string' || body.sliceRef === ''
    || body.counts === null || typeof body.counts !== 'object'
    || !Array.isArray(body.entries)
    || typeof body.truncated !== 'boolean') {
    throw new CliError('CP_RESPONSE_INVALID', 'CP returned an unexpected checkpoint preview response shape.', {}, 1);
  }
  return {
    kind: 'checkpoint-preview',
    sliceRef: body.sliceRef,
    counts: body.counts,
    entries: body.entries,
    truncated: body.truncated,
    opaqueNestedRepos: typeof body.opaqueNestedRepos === 'number' ? body.opaqueNestedRepos : null,
  };
}

export async function runAuditList({ apiBase, fetchImpl, token, options }) {
  const page = optionalInteger(options, '--page', { min: 0, fallback: 0 });
  const size = optionalInteger(options, '--size', { min: 1, max: 100, fallback: 20 });
  const type = options['--type'];
  const body = await requestJson(
    `/api/v1/audit/entries${buildQuery({ type, page, size })}`,
    { apiBase, fetchImpl, token },
  );
  return {
    kind: 'audit-list',
    page: body?.page ?? page,
    size: body?.size ?? size,
    totalElements: body?.totalElements ?? null,
    totalPages: body?.totalPages ?? null,
    entries: Array.isArray(body?.entries) ? body.entries : [],
  };
}
