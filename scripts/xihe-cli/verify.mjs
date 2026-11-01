import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, confirmAction } from './provider.mjs';
import {
  bindingRequestBody,
  describeBinding,
  resolveSessionBinding,
} from './session-binding.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

const DEFAULT_WAIT_SECONDS = 120;
const MAX_WAIT_SECONDS = 3600;
const POLL_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 20_000;
const SSE_TIMEOUT_MS = 10_000;
const SSE_BUFFER_LIMIT = 64 * 1024;

// ChatRunRepository.ACTIVE_LEASE_STATUSES / terminal statuses (PLAN-0574 M0):
// active = accepted, queued, running, streaming, awaiting_approval, dispatching
// terminal = succeeded, failed, partial, ambiguous, cancelled
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'partial', 'ambiguous', 'cancelled']);
const TERMINAL_SUCCESS = 'succeeded';

class VerifyFailure extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VerifyFailure';
    this.code = code;
  }
}

function requireTargetOption(options, flag) {
  const value = options[flag];
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value.trim();
}

export function parseWaitSeconds(raw) {
  if (raw === undefined) return DEFAULT_WAIT_SECONDS;
  if (!/^\d{1,4}$/.test(String(raw))) {
    throw new CliError('INVALID_ARGUMENT', '--wait-seconds must be an integer between 1 and 3600.', {}, 1);
  }
  const value = Number(raw);
  if (value < 1 || value > MAX_WAIT_SECONDS) {
    throw new CliError('INVALID_ARGUMENT', '--wait-seconds must be an integer between 1 and 3600.', {}, 1);
  }
  return value;
}

function deriveStackEnv({ stack, root, spawnSyncImpl }) {
  let result;
  try {
    result = spawnSyncImpl(process.execPath, [path.join(root, 'scripts', 'stack-run.mjs'), 'env-json', '--stack', stack], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: REQUEST_TIMEOUT_MS,
    });
  } catch {
    result = null;
  }
  if (!result || result.error || result.status !== 0) {
    throw new CliError('VERIFY_STACK_DERIVATION_FAILED', `Could not derive the environment for stack ${stack}; check the stack ID.`, {}, 2);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new CliError('VERIFY_STACK_DERIVATION_FAILED', `stack-run returned invalid environment JSON for stack ${stack}.`, {}, 2);
  }
  const bag = parsed?.env ?? {};
  // PLAN-0574 A-class fix (real stack-2 acceptance): `stack-run env-json` fills the
  // env bag with gaps only, so an inherited XIHE_*_PORT (OS env or the CLI .env
  // chain) removes the key from the bag. Reading the bag alone then silently fell
  // back to the stack-1 defaults and pointed verify at another stack. The derived
  // `ports` object is the stack truth and must win; the bag stays as a fallback
  // for older/doubles fixtures.
  const derivedPorts = parsed?.ports && typeof parsed.ports === 'object' ? parsed.ports : {};
  const port = (derivedName, key, fallback) => {
    const raw = String(derivedPorts[derivedName] ?? bag[key] ?? fallback);
    if (!/^\d{1,5}$/.test(raw)) {
      throw new CliError('VERIFY_STACK_DERIVATION_FAILED', `stack ${stack} derived an invalid ${key}.`, {}, 2);
    }
    const value = Number(raw);
    if (value < 1 || value > 65535) {
      throw new CliError('VERIFY_STACK_DERIVATION_FAILED', `stack ${stack} derived an out-of-range ${key}.`, {}, 2);
    }
    return value;
  };
  return { cpPort: port('cp', 'XIHE_CP_PORT', '12631'), agentPort: port('agent', 'XIHE_AGENT_PORT', '12632') };
}

function createClient({ apiBase, fetchImpl, auth, workspaceId }) {
  async function call(method, pathname, { body, workspace = true, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const headers = {};
    if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
    if (workspace) headers['X-Workspace-Id'] = workspaceId;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const response = await fetchImpl(`${apiBase}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
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
        requestId: typeof parsed?.requestId === 'string' ? parsed.requestId : null,
        retryAfter: response.headers?.get?.('retry-after') ?? null,
      };
    } catch (error) {
      const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
      return { status: 0, body: null, code: aborted ? 'REQUEST_TIMEOUT' : 'CONNECTION_FAILED', requestId: null };
    }
  }
  return { call };
}

async function openSse({ apiBase, fetchImpl, token, workspaceId, sessionId, timeoutMs = SSE_TIMEOUT_MS }) {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), timeoutMs);
  const close = () => { try { controller.abort(); } catch { /* already closed */ } };
  try {
    const response = await fetchImpl(`${apiBase}/api/v1/events?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
        'X-Workspace-Id': workspaceId,
      },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      clearTimeout(timer);
      close();
      return { connected: false, close: () => {} };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('connected')) {
        clearTimeout(timer);
        timer = null;
        // The connection stays open until close() is called: CP rejects chat
        // without an active SSE subscription, and the design requires closing
        // SSE before polling the run.
        return { connected: true, close };
      }
      if (buffer.length > SSE_BUFFER_LIMIT) break;
    }
    clearTimeout(timer);
    close();
    return { connected: false, close: () => {} };
  } catch {
    if (timer !== null) clearTimeout(timer);
    close();
    return { connected: false, close: () => {} };
  }
}

async function pollRun({ client, runId, waitMs, nowImpl, sleepImpl, pollIntervalMs = POLL_INTERVAL_MS }) {
  const started = nowImpl();
  for (;;) {
    const response = await client.call('GET', `/api/v1/chat/runs/${encodeURIComponent(runId)}`);
    if (response.status === 200 && response.body && typeof response.body.status === 'string') {
      const status = response.body.status;
      const snapshot = {
        status,
        terminalOutcome: typeof response.body.terminalOutcome === 'string' ? response.body.terminalOutcome : null,
        errorCode: typeof response.body.errorCode === 'string' ? response.body.errorCode : null,
        waitedMs: nowImpl() - started,
      };
      if (TERMINAL_STATUSES.has(status)) return { outcome: 'TERMINAL', ...snapshot };
      if (status === 'awaiting_approval') return { outcome: 'AWAITING_APPROVAL', ...snapshot };
    } else if (response.status === 404) {
      return { outcome: 'NOT_FOUND', status: null, errorCode: response.code, waitedMs: nowImpl() - started };
    } else {
      return {
        outcome: 'ERROR',
        status: null,
        httpStatus: response.status,
        errorCode: response.code,
        requestId: response.requestId,
        waitedMs: nowImpl() - started,
      };
    }
    if (nowImpl() - started >= waitMs) {
      return { outcome: 'TIMEOUT', status: response.body?.status ?? null, errorCode: null, waitedMs: nowImpl() - started };
    }
    await sleepImpl(pollIntervalMs);
  }
}

function countModels(models) {
  if (Array.isArray(models)) return models.length;
  if (models && typeof models === 'object') return Object.keys(models).length;
  return 0;
}

function whitelistedAgentHealth(body) {
  return {
    status: typeof body?.status === 'string' ? body.status : null,
    llmReady: typeof body?.llmReady === 'boolean' ? body.llmReady : null,
    configRevision: body?.configRevision ?? null,
    mcpInitialized: typeof body?.mcpInitialized === 'boolean' ? body.mcpInitialized : null,
  };
}

const PROVISIONAL_UNSUPPORTED_STATUS = new Set([400, 404, 405, 422]);
const PROVISIONAL_UNSUPPORTED_CODES = new Set([
  'INVALID_REQUEST', 'INVALID_ARGUMENT', 'NOT_FOUND', 'UNSUPPORTED', 'UNSUPPORTED_FEATURE', 'NOT_IMPLEMENTED',
]);

function provisionalProbe(code, detail) {
  return { status: 'SKIP_PROVISIONAL', code, detail };
}

function isProvisionalResponse(response) {
  return PROVISIONAL_UNSUPPORTED_STATUS.has(response.status)
    || (response.code !== null && PROVISIONAL_UNSUPPORTED_CODES.has(response.code));
}

async function listWorkspaceAgents(client, workspaceId) {
  const listed = await client.call('GET', `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agents`);
  const items = Array.isArray(listed.body?.agents) ? listed.body.agents
    : Array.isArray(listed.body) ? listed.body : [];
  return { status: listed.status, items };
}

async function createPrincipal(client, body, { workspace = false } = {}) {
  const created = await client.call('POST', '/api/v1/agent-principals', { body, workspace });
  if (![200, 201].includes(created.status)) {
    if (isProvisionalResponse(created)) {
      return {
        provisional: true,
        result: provisionalProbe('SCOPE_UNSUPPORTED', `CP 未交付 scope（HTTP ${created.status}${created.code ? ` ${created.code}` : ''}）`),
      };
    }
    return { provisional: false, result: { status: 'FAIL', code: created.code ?? 'PRINCIPAL_CREATE_FAILED', detail: `HTTP ${created.status}` } };
  }
  const principalId = created.body?.principalId ?? created.body?.id ?? null;
  if (typeof principalId !== 'string' || principalId === '') {
    return { provisional: false, result: { status: 'FAIL', code: 'PRINCIPAL_CREATE_INVALID', detail: 'CP returned no principalId' } };
  }
  return { provisional: false, result: { principalId, scope: created.body?.scope ?? null } };
}

/**
 * A5a — PERSONAL：可见性由「来源」决定，不依赖绑定（CP V4：三源合并）。
 *   建 → 未绑也可见 source=personal → bind → 仍可见且 source 不变 → unbind → **仍可见**。
 */
export async function runPersonalLifecycleProbe({ client, workspaceId }) {
  const name = `xihe-verify-personal-${Date.now()}`;
  const created = await createPrincipal(client, { name, scope: 'PERSONAL' });
  if (created.result.status) return { ...created.result, principalId: null };
  const { principalId } = created.result;
  if (created.result.scope !== 'PERSONAL') {
    return {
      ...provisionalProbe('SCOPE_NOT_ECHOED', `创建成功但未回显 scope（got ${created.result.scope ?? 'missing'}）`),
      principalId,
    };
  }

  const before = await listWorkspaceAgents(client, workspaceId);
  if (before.status !== 200) {
    return { status: 'FAIL', code: 'AGENT_LIST_FAILED', detail: `HTTP ${before.status}`, principalId };
  }
  const beforeRow = before.items.find((item) => item?.principalId === principalId);
  if (!beforeRow) {
    return { status: 'FAIL', code: 'PERSONAL_NOT_VISIBLE_UNBOUND', detail: '未绑定时列表应可见 PERSONAL（V4 三源合并）', principalId };
  }
  if (beforeRow.source !== 'personal') {
    return { status: 'FAIL', code: 'PERSONAL_SOURCE_MISMATCH', detail: `未绑定时 source=${beforeRow.source ?? 'missing'}`, principalId };
  }

  const bindPath = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(principalId)}`;
  const bind = await client.call('PUT', bindPath, { body: { permissions: [] } });
  if (bind.status === 403) {
    return { status: 'FAIL', code: bind.code ?? 'PERSONAL_BIND_FORBIDDEN', detail: '绑定本人 PERSONAL 被拒（HTTP 403）', principalId };
  }
  if (![200, 204].includes(bind.status)) {
    if (isProvisionalResponse(bind)) {
      return { ...provisionalProbe('BIND_UNSUPPORTED', `HTTP ${bind.status}${bind.code ? ` ${bind.code}` : ''}`), principalId };
    }
    return { status: 'FAIL', code: bind.code ?? 'PERSONAL_BIND_FAILED', detail: `HTTP ${bind.status}`, principalId };
  }
  const boundList = await listWorkspaceAgents(client, workspaceId);
  const boundRow = boundList.items.find((item) => item?.principalId === principalId);
  if (!boundRow || boundRow.source !== 'personal') {
    return { status: 'FAIL', code: 'PERSONAL_BOUND_SOURCE_CHANGED', detail: `绑定后 row=${boundRow ? boundRow.source : 'missing'}`, principalId };
  }

  const unbind = await client.call('DELETE', bindPath);
  if (![200, 204].includes(unbind.status)) {
    return { status: 'FAIL', code: unbind.code ?? 'PERSONAL_UNBIND_FAILED', detail: `HTTP ${unbind.status}`, principalId };
  }
  const afterList = await listWorkspaceAgents(client, workspaceId);
  const afterRow = afterList.items.find((item) => item?.principalId === principalId);
  if (!afterRow) {
    return { status: 'FAIL', code: 'PERSONAL_HIDDEN_AFTER_UNBIND', detail: 'V4：解绑后 PERSONAL 仍应可见（source=personal）', principalId };
  }
  if (afterRow.source !== 'personal') {
    return { status: 'FAIL', code: 'PERSONAL_SOURCE_MISMATCH_AFTER_UNBIND', detail: `解绑后 source=${afterRow.source ?? 'missing'}`, principalId };
  }
  return {
    status: 'PASS',
    detail: `A5a PERSONAL：未绑可见(source=personal) → bind 后仍 personal → unbind 后仍可见 principal=${principalId}`,
    principalId,
    evidence: { principalId, unboundVisible: true, boundSource: 'personal', unboundSource: 'personal' },
  };
}

/**
 * A5b — WORKSPACE：可见性由「绑定」决定。
 *   建 → 未绑定不可见 → bind → 可见 source=workspace → unbind → 不可见。
 */
export async function runWorkspaceLifecycleProbe({ client, workspaceId }) {
  const name = `xihe-verify-workspace-${Date.now()}`;
  const created = await createPrincipal(client, { name, scope: 'WORKSPACE' }, { workspace: true });
  if (created.result.status) return { ...created.result, principalId: null };
  const { principalId } = created.result;
  if (created.result.scope !== 'WORKSPACE') {
    return {
      ...provisionalProbe('SCOPE_NOT_ECHOED', `创建成功但未回显 scope（got ${created.result.scope ?? 'missing'}）`),
      principalId,
    };
  }

  const before = await listWorkspaceAgents(client, workspaceId);
  if (before.status !== 200) {
    return { status: 'FAIL', code: 'AGENT_LIST_FAILED', detail: `HTTP ${before.status}`, principalId };
  }
  if (before.items.some((item) => item?.principalId === principalId)) {
    return { status: 'FAIL', code: 'WORKSPACE_VISIBLE_UNBOUND', detail: '未绑定的 WORKSPACE principal 不应出现在列表', principalId };
  }

  const bindPath = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(principalId)}`;
  const bind = await client.call('PUT', bindPath, { body: { permissions: [] } });
  if (![200, 204].includes(bind.status)) {
    if (isProvisionalResponse(bind)) {
      return { ...provisionalProbe('BIND_UNSUPPORTED', `HTTP ${bind.status}${bind.code ? ` ${bind.code}` : ''}`), principalId };
    }
    return { status: 'FAIL', code: bind.code ?? 'WORKSPACE_BIND_FAILED', detail: `HTTP ${bind.status}`, principalId };
  }
  const boundList = await listWorkspaceAgents(client, workspaceId);
  const boundRow = boundList.items.find((item) => item?.principalId === principalId);
  if (!boundRow) {
    return { status: 'FAIL', code: 'WORKSPACE_NOT_VISIBLE_AFTER_BIND', detail: '绑定后列表未见该 principal', principalId };
  }
  if (boundRow.source !== 'workspace') {
    return { status: 'FAIL', code: 'WORKSPACE_SOURCE_MISMATCH', detail: `source=${boundRow.source ?? 'missing'}`, principalId };
  }

  const unbind = await client.call('DELETE', bindPath);
  if (![200, 204].includes(unbind.status)) {
    return { status: 'FAIL', code: unbind.code ?? 'WORKSPACE_UNBIND_FAILED', detail: `HTTP ${unbind.status}`, principalId };
  }
  const afterList = await listWorkspaceAgents(client, workspaceId);
  if (afterList.items.some((item) => item?.principalId === principalId)) {
    return { status: 'FAIL', code: 'WORKSPACE_STILL_VISIBLE', detail: '解绑后 WORKSPACE principal 仍出现在列表', principalId };
  }
  return {
    status: 'PASS',
    detail: `A5b WORKSPACE：未绑不可见 → bind 后 source=workspace → unbind 后不可见 principal=${principalId}`,
    principalId,
    evidence: { principalId, unboundVisible: false, boundSource: 'workspace', unboundVisibleAfter: false },
  };
}

/**
 * PLAN-0622 T2.3 / A6: connection concurrency limit returns 429 RESOURCE_EXHAUSTED
 * with Retry-After, and the connection recovers after the limit is restored.
 * Provisional until the CP Resource Governor is delivered (T1.6).
 */
export async function runResourceLimitProbe({ client, connectionId, sessionId, branchId, chatTargets, openSubscription }) {
  if (!sessionId || !branchId) {
    return provisionalProbe('NO_SESSION', '没有可用于限额探测的 session/branch');
  }
  const connections = await client.call('GET', '/api/v1/provider-connections');
  if (connections.status !== 200) {
    return provisionalProbe('CONNECTIONS_UNAVAILABLE', `provider-connections HTTP ${connections.status}`);
  }
  const list = Array.isArray(connections.body?.connections) ? connections.body.connections : [];
  const target = list.find((item) => item?.id === connectionId) ?? list[0];
  if (!target) {
    return provisionalProbe('NO_CONNECTION', '没有可用的 provider connection');
  }
  const originalLimit = target.maxInflight ?? 0;
  const patchPath = `/api/v1/provider-connections/${encodeURIComponent(target.id)}`;
  const patched = await client.call('PATCH', patchPath, { body: { maxInflight: 1 } });
  if (patched.status !== 200) {
    if (isProvisionalResponse(patched)) {
      return provisionalProbe('LIMIT_UNSUPPORTED', `限额字段未交付（HTTP ${patched.status}${patched.code ? ` ${patched.code}` : ''}）`);
    }
    return { status: 'FAIL', code: patched.code ?? 'LIMIT_PATCH_FAILED', detail: `HTTP ${patched.status}` };
  }

  // CP 修复前：PATCH 返回 200 但连接读面不投影限额 ⇒ 限额没有持久化，governor 恒为 UNLIMITED。
  // 这是"配置写不进去"的精确阻塞原因，不是"没观测到 429"（后者会把 CP bug 归因到用例）。
  const reRead = await client.call('GET', '/api/v1/provider-connections');
  const reReadList = Array.isArray(reRead.body?.connections) ? reRead.body.connections : [];
  const reReadTarget = reReadList.find((item) => item?.id === target.id);
  const limitEchoed = reRead.status === 200 && reReadTarget?.maxInflight === 1;
  if (!limitEchoed) {
    await client.call('PATCH', patchPath, { body: { maxInflight: originalLimit } });
    return provisionalProbe(
      'LIMIT_NOT_PERSISTED',
      'PATCH 限额未持久化，governor 恒为 UNLIMITED（CP 修复中）',
    );
  }

  // 跨 session 并发（同一 connection）：会话级互斥是既有两层设计，不应由 governor 取代。
  const targets = Array.isArray(chatTargets) && chatTargets.length > 0
    ? chatTargets
    : Array.from({ length: 4 }, () => ({ sessionId, branchId }));
  const chat = (label, chatTarget = targets[0]) => client.call('POST', '/api/v1/chat', {
    body: { sessionId: chatTarget.sessionId, branchId: chatTarget.branchId, content: `xihe verify limit probe ${label}` },
    timeoutMs: 5_000,
  });
  // CP 要求每个 session 先有活跃 SSE 订阅才允许 POST /chat（ChatController.java:463-465
  // `SSE_SUBSCRIPTION_REQUIRED`）——这是会话级传输前置，不是 governor；A6 必须先订阅。
  const subscriptions = [];
  let results;
  try {
    for (const chatTarget of targets) {
      if (typeof openSubscription === 'function') {
        subscriptions.push(await openSubscription(chatTarget));
      }
    }
    results = await Promise.all(targets.map((chatTarget, index) => chat(`p${index}`, chatTarget)));
  } finally {
    // Restore in every outcome: a leaked maxInflight would break the stack for later runs.
    await client.call('PATCH', patchPath, { body: { maxInflight: originalLimit } });
    for (const subscription of subscriptions) {
      try { subscription?.close?.(); } catch { /* already closed */ }
    }
  }
  for (const result of results) {
    const runId = result.body?.runId;
    if (typeof runId === 'string') {
      await client.call('POST', `/api/v1/chat/runs/${encodeURIComponent(runId)}/cancel`, { body: {} });
    }
  }
  const RESOURCE_KINDS = new Set(['CONNECTION', 'MODEL', 'FILE_WRITE', 'PROCESS', 'JOB', 'MCP']);
  const throttled = results.find((result) => result.status === 429
    && result.code === 'RESOURCE_EXHAUSTED'
    && (typeof result.body?.retryAfterSeconds === 'number'
      || /^\d+$/.test(String(result.body?.retryAfterSeconds ?? '')))
    && RESOURCE_KINDS.has(result.body?.resourceKind)
    && typeof result.body?.scope === 'string' && result.body.scope !== ''
    && typeof result.retryAfter === 'string' && result.retryAfter !== '');
  if (!throttled) {
    const detail429 = results.find((result) => result.status === 429);
    const sessionCount = new Set(targets.map((item) => item.sessionId)).size;
    // 诊断：chat 202 后 run 可能异步失败（governor 在 credential lease 处触发，不在 HTTP 响应里）。
    const runOutcomes = [];
    for (const result of results) {
      const runId = result.body?.runId;
      if (typeof runId !== 'string') continue;
      let outcome = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const statusResponse = await client.call('GET', `/api/v1/chat/runs/${encodeURIComponent(runId)}`);
        const body = statusResponse.body ?? {};
        const status = body.status ?? body.run?.status ?? null;
        const errorCode = body.errorCode ?? body.run?.errorCode ?? null;
        if (status && ['succeeded', 'failed', 'cancelled', 'timed_out', 'terminal'].includes(String(status))) {
          outcome = { runId, status, errorCode };
          break;
        }
        if (errorCode) { outcome = { runId, status, errorCode }; break; }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (outcome) runOutcomes.push(outcome);
    }
    return {
      status: 'FAIL',
      code: 'LIMIT_NOT_ENFORCED',
      detail: detail429
        ? `429 缺契约字段（code=${detail429.code ?? 'none'}`
          + ` retryAfterSeconds=${JSON.stringify(detail429.body?.retryAfterSeconds ?? null)}`
          + ` resourceKind=${detail429.body?.resourceKind ?? 'none'} scope=${detail429.body?.scope ?? 'none'}`
          + ` headerRetryAfter=${detail429.retryAfter ?? 'none'}）`
        : `跨 ${sessionCount} 个 session 并发 ${targets.length} 条 chat 未命中 429 RESOURCE_EXHAUSTED`
          + `（statuses=[${results.map((item) => `${item.status}${item.code ? `:${item.code}` : ''}`).join(',')}]`
          + `，runs=${JSON.stringify(runOutcomes)}）`,
    };
  }
  const recovered = await chat('after-restore');
  if (![200, 202].includes(recovered.status)) {
    return {
      status: 'FAIL',
      code: 'LIMIT_RESTORE_NOT_EFFECTIVE',
      detail: `恢复限额后 chat HTTP ${recovered.status}${recovered.code ? ` ${recovered.code}` : ''}`,
    };
  }
  const recoveredRunId = recovered.body?.runId;
  if (typeof recoveredRunId === 'string') {
    await client.call('POST', `/api/v1/chat/runs/${encodeURIComponent(recoveredRunId)}/cancel`, { body: {} });
  }
  return {
    status: 'PASS',
    detail: `429 RESOURCE_EXHAUSTED kind=${throttled.body.resourceKind} scope=${throttled.body.scope}`
      + ` retryAfterSeconds=${throttled.body.retryAfterSeconds} header=${throttled.retryAfter}；恢复限额后 chat 已受理`,
    evidence: {
      httpStatus: 429,
      code: 'RESOURCE_EXHAUSTED',
      retryAfterSeconds: throttled.body.retryAfterSeconds,
      resourceKind: throttled.body.resourceKind,
      scope: throttled.body.scope,
      headerRetryAfter: throttled.retryAfter,
      restored: true,
      restoredChatStatus: recovered.status,
      limitEchoed,
    },
  };
}

export async function runVerify({
  env,
  fetchImpl = fetch,
  options,
  json = false,
  stdout = process.stdout,
  stderr = process.stderr,
  promptSecret,
  confirm = confirmAction,
  spawnSyncImpl,
  stdin = process.stdin,
  nowImpl = Date.now,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  root = projectRoot,
}) {
  const missing = ['--stack', '--email', '--workspace']
    .map((flag) => [flag, requireTargetOption(options, flag)])
    .filter(([, value]) => value === null)
    .map(([flag]) => flag);
  if (missing.length > 0) {
    throw new CliError(
      'VERIFY_TARGET_REQUIRED',
      `xihe verify requires an explicit target: ${missing.join(', ')}. The CLI never falls back to a default workspace.`,
      { missing },
      2,
    );
  }
  const stack = requireTargetOption(options, '--stack');
  const email = requireTargetOption(options, '--email');
  const workspaceId = requireTargetOption(options, '--workspace');
  const waitSeconds = parseWaitSeconds(options['--wait-seconds']);

  let password = env.XIHE_VERIFY_PASSWORD || env.XIHE_DEV_ADMIN_PASSWORD || '';
  if (!password) {
    if (stdin?.isTTY && typeof promptSecret === 'function') {
      password = await promptSecret('XH local admin password');
    }
  }
  if (!password) {
    throw new CliError(
      'VERIFY_CREDENTIALS_REQUIRED',
      'A password is required: set XIHE_VERIFY_PASSWORD (or XIHE_DEV_ADMIN_PASSWORD), or run in a TTY.',
      {},
      2,
    );
  }

  const { cpPort, agentPort } = deriveStackEnv({ stack, root, spawnSyncImpl });
  const apiBase = `http://127.0.0.1:${cpPort}`;
  const agentHealthUrl = `http://127.0.0.1:${agentPort}/internal/v1/agent/health`;
  const report = (line) => (json ? stderr : stdout).write(`${line}\n`);

  stderr.write(`verify target: stack=${stack} cp=${apiBase} agent=127.0.0.1:${agentPort} email=${email} workspace=${workspaceId}\n`);
  stderr.write('verify creates an agent principal (when none exists), a session and a chat run; it calls the configured model provider and may incur cost.\n');
  if (!options['--yes']) {
    await confirm({
      message: `Run verification against stack ${stack} workspace ${workspaceId}?`,
      stdin,
      output: stderr,
    });
  }

  const auth = { token: '' };
  const client = createClient({ apiBase, fetchImpl, auth, workspaceId });
  const state = {
    principalId: env.XIHE_VERIFY_AGENT_PRINCIPAL_ID || null,
    principalSource: env.XIHE_VERIFY_AGENT_PRINCIPAL_ID ? 'pre_existing' : 'unresolved',
    principalOutcome: 'not_created',
    bindingCreated: false,
    bindingOutcome: null,
    sessionId: null,
    sessionOutcome: 'not_created',
    runId: null,
  };
  const steps = [];
  const data = {
    stack,
    cpBase: apiBase,
    agentPort,
    email,
    workspaceId,
    steps,
    personal: { status: 'NOT_RUN' },
    limit: { status: 'NOT_RUN' },
    a: { status: 'NOT_RUN' },
    b: { status: 'NOT_RUN', detail: null, runId: null },
    run: { status: 'NOT_RUN', terminalStatus: null, errorCode: null, waitedMs: 0 },
    cleanup: {
      sse: 'not_opened',
      runCancel: null,
      session: { status: 'not_created' },
      principal: { status: 'not_created' },
    },
    result: 'FAIL',
  };

  const step = (name, status, detail = null) => {
    steps.push({ name, status, ...(detail ? { detail } : {}) });
    report(`${name}: ${status}${detail ? ` (${detail})` : ''}`);
  };
  const failA = (name, code, message) => {
    step(name, 'FAIL', code);
    throw new VerifyFailure(code, message);
  };

  let sse = null;
  let failure = null;
  let bStatus = 'NOT_RUN';
  let timedOut = false;

  try {
    const health = await client.call('GET', '/api/v1/health', { workspace: false });
    if (health.status !== 200) failA('A1 CP health', 'CP_HEALTH_FAILED', 'CP /api/v1/health did not return 200.');
    step('A1 CP health', 'PASS');

    const loginResponse = await client.call('POST', '/api/v1/auth/login', {
      body: { identifier: email, password },
      workspace: false,
    });
    if (loginResponse.status !== 200 || typeof loginResponse.body?.accessToken !== 'string') {
      failA('A2 login', 'LOGIN_FAILED', `Login failed (HTTP ${loginResponse.status}${loginResponse.code ? ` ${loginResponse.code}` : ''}).`);
    }
    auth.token = loginResponse.body.accessToken;
    step('A2 login', 'PASS');

    const workspace = await client.call('GET', `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`);
    if (workspace.status !== 200) {
      failA('A3 workspace access', 'WORKSPACE_NOT_ACCESSIBLE', `The account cannot access workspace ${workspaceId} (HTTP ${workspace.status}).`);
    }
    // PLAN-0612 M4 preflight: verification creates sessions/chat runs (execution) — a
    // docker-backend workspace cannot run while the backend is frozen. Fail before any
    // principal/session/provider work, with the same code CP would return later.
    const workspaceExecutionMode = String(workspace.body?.executionMode ?? 'docker').trim().toLowerCase();
    const dockerBackendEnabled = String(env.XIHE_WORKSPACE_DOCKER_BACKEND ?? '').trim().toLowerCase() === 'enabled';
    if (workspaceExecutionMode === 'docker' && !dockerBackendEnabled) {
      failA(
        'A3 workspace access',
        'BACKEND_DISABLED',
        `Workspace ${workspaceId} runs on the frozen docker execution backend; verification would execute in it. `
          + 'Use a direct_attach workspace (windows-host/windows-mxc). The docker backend is frozen together with '
          + 'its product surface (UI/CLI) and the E2E docker-frozen markers; thaw them together with '
          + 'XIHE_WORKSPACE_DOCKER_BACKEND=enabled (E2E additionally needs --include-docker-frozen).',
      );
    }
    step('A3 workspace access', 'PASS');

    if (!state.principalId) {
      const bound = await client.call('GET', `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agents`);
      if (bound.status === 200 && Array.isArray(bound.body) && bound.body.length > 0
        && typeof bound.body[0]?.principalId === 'string') {
        state.principalId = bound.body[0].principalId;
        state.principalSource = 'pre_existing';
      }
    }
    if (!state.principalId) {
      // D21: an omitted scope is WORKSPACE; make it explicit and send the workspace context
      // (client.call defaults workspace:true → X-Workspace-Id).
      const created = await client.call('POST', '/api/v1/agent-principals', {
        body: { name: 'xihe-verify', scope: 'WORKSPACE' },
      });
      if (![200, 201].includes(created.status) || typeof created.body?.principalId !== 'string') {
        state.principalOutcome = created.status === 0 || created.status >= 500 || [200, 201].includes(created.status)
          ? 'unknown'
          : 'failed';
        failA('A4 agent principal', 'AGENT_PRINCIPAL_CREATE_FAILED', `Creating an agent principal failed (HTTP ${created.status}${created.code ? ` ${created.code}` : ''}).`);
      }
      state.principalId = created.body.principalId;
      state.principalSource = 'created_this_run';
      state.principalOutcome = 'created';
      const bind = await client.call(
        'PUT',
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(state.principalId)}`,
        { body: { permissions: [] } },
      );
      if (bind.status !== 200) {
        state.bindingOutcome = bind.status === 0 || bind.status >= 500 ? 'unknown' : 'failed';
        failA('A4 agent principal', 'AGENT_PRINCIPAL_BIND_FAILED', `Binding the new principal failed (HTTP ${bind.status}${bind.code ? ` ${bind.code}` : ''}).`);
      }
      state.bindingCreated = true;
      state.bindingOutcome = 'created';
      step('A4 agent principal', 'PASS', 'created and bound by this run');
    } else {
      step('A4 agent principal', 'PASS', 'pre-existing principal reused unchanged');
    }

    // PLAN-0601: CP rejects chat on Sessions without an explicit template + connection binding
    // (409 API_TYPE_REBIND_REQUIRED), so resolve that binding before creating the Session.
    const resolved = await resolveSessionBinding({ client, stack });
    if (resolved.error) {
      step('A5 session binding', 'FAIL', resolved.error.code);
      throw new CliError(resolved.error.code, resolved.error.message, { stack }, 2);
    }
    state.binding = resolved.binding;
    data.binding = {
      connectionId: resolved.binding.connectionId,
      providerId: resolved.binding.providerId,
      modelName: resolved.binding.modelName,
      template: {
        layer: resolved.binding.templateLayer,
        id: resolved.binding.templateId,
        version: resolved.binding.templateVersion,
      },
    };
    step('A5 session binding', 'PASS', describeBinding(resolved.binding));

    const session = await client.call('POST', '/api/v1/sessions', {
      body: bindingRequestBody(resolved.binding, {
        title: 'xihe-verify',
        agentPrincipalId: state.principalId,
      }),
    });
    state.sessionId = typeof session.body?.id === 'string'
      ? session.body.id
      : typeof session.body?.sessionId === 'string' ? session.body.sessionId : null;
    if (![200, 201].includes(session.status) || !state.sessionId) {
      state.sessionOutcome = session.status === 0 || session.status >= 500 || [200, 201].includes(session.status)
        ? 'unknown'
        : 'failed';
      failA('A5 session', 'SESSION_CREATE_FAILED', `Creating the verification session failed (HTTP ${session.status}${session.code ? ` ${session.code}` : ''}).`);
    }
    state.sessionOutcome = 'created';
    step('A5 session', 'PASS', `session=${state.sessionId}`);

    const branches = await client.call('GET', `/api/v1/sessions/${encodeURIComponent(state.sessionId)}/branches`);
    const branchId = Array.isArray(branches.body?.items) ? branches.body.items[0]?.branchId : null;
    if (branches.status !== 200 || typeof branchId !== 'string') {
      failA('A6 branches', 'SESSION_BRANCH_MISSING', 'The verification session has no root branch.');
    }
    step('A6 branches', 'PASS', `branch=${branchId}`);

    const messages = await client.call(
      'GET',
      `/api/v1/sessions/${encodeURIComponent(state.sessionId)}/messages?branchId=${encodeURIComponent(branchId)}`,
    );
    if (messages.status !== 200) {
      failA('A7 messages', 'SESSION_MESSAGES_UNREADABLE', `Reading the branch messages failed (HTTP ${messages.status}${messages.code ? ` ${messages.code}` : ''}).`);
    }
    step('A7 messages', 'PASS');

    sse = await openSse({
      apiBase,
      fetchImpl,
      token: auth.token,
      workspaceId,
      sessionId: state.sessionId,
    });
    data.cleanup.sse = sse.connected ? 'open' : 'not_connected';
    if (!sse.connected) failA('A8 SSE', 'SSE_NOT_CONNECTED', 'SSE did not report connected within 10 seconds.');
    step('A8 SSE', 'PASS');

    const models = await client.call('GET', '/api/v1/models');
    const modelCount = models.status === 200 ? countModels(models.body?.models) : 0;
    if (models.status !== 200 || modelCount === 0) {
      failA('A9 models', 'MODELS_UNAVAILABLE', `The workspace has no available models (HTTP ${models.status}).`);
    }
    step('A9 models', 'PASS', `models=${modelCount}`);

    let agentHealth = { status: 0, body: null };
    try {
      const response = await fetchImpl(agentHealthUrl, { signal: AbortSignal.timeout(SSE_TIMEOUT_MS) });
      let text = '';
      try { text = await response.text(); } catch { /* status carries the result */ }
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      agentHealth = { status: response.status, body };
    } catch {
      agentHealth = { status: 0, body: null };
    }
    if (agentHealth.status !== 200) {
      failA('A10 agent health', 'AGENT_HEALTH_FAILED', `The loopback Agent health check failed (${agentHealth.status || 'unreachable'}).`);
    }
    data.agent = whitelistedAgentHealth(agentHealth.body);
    step('A10 agent health', 'PASS', `status=${data.agent.status ?? 'unknown'} llmReady=${data.agent.llmReady ?? 'unknown'}`);

    // PLAN-0622 T2.3: A5 = PERSONAL agent lifecycle, A6 = connection limit 429.
    // While the CP track has not delivered scope/governor (M0/M1), these steps are
    // SKIP_PROVISIONAL with an actionable reason — never a fabricated PASS.
    // PLAN-0622 T2.3：A5 拆两条（CP V4 三源合并后的语义）
    // A5a PERSONAL：来源决定可见性（未绑也可见；unbind 后仍可见）
    // A5b WORKSPACE：绑定决定可见性（未绑不可见；unbind 后不可见）
    const personal = await runPersonalLifecycleProbe({ client, workspaceId });
    data.personal = personal;
    step('A5a PERSONAL lifecycle', personal.status, personal.detail);
    if (personal.status === 'FAIL') {
      failA('A5a PERSONAL lifecycle', personal.code, personal.detail);
    }
    const workspacePrincipal = await runWorkspaceLifecycleProbe({ client, workspaceId });
    data.workspacePrincipal = workspacePrincipal;
    step('A5b WORKSPACE lifecycle', workspacePrincipal.status, workspacePrincipal.detail);
    if (workspacePrincipal.status === 'FAIL') {
      failA('A5b WORKSPACE lifecycle', workspacePrincipal.code, workspacePrincipal.detail);
    }

    const limit = await runResourceLimitProbe({
      client,
      connectionId: data.binding?.connectionId ?? null,
      sessionId: state.sessionId,
      branchId,
    });
    data.limit = limit;
    step('A6 RESOURCE_EXHAUSTED 429', limit.status, limit.detail);
    if (limit.status === 'FAIL') {
      failA('A6 RESOURCE_EXHAUSTED 429', limit.code, limit.detail);
    }

    data.a.status = 'PASS';

    const chat = await client.call('POST', '/api/v1/chat', {
      body: { sessionId: state.sessionId, branchId, content: 'xihe verify ping' },
    });
    const runId = typeof chat.body?.runId === 'string' ? chat.body.runId : null;
    data.b.runId = runId;
    if ([200, 202].includes(chat.status) && runId) {
      state.runId = runId;
      bStatus = 'PASS';
      data.b = { status: 'PASS', detail: `accepted (HTTP ${chat.status})`, runId };
      step('B chat accepted', 'PASS', `run=${runId}`);
    } else if ([403, 409, 503].includes(chat.status)) {
      bStatus = 'NOT_AVAILABLE';
      data.b = { status: 'NOT_AVAILABLE', detail: `HTTP ${chat.status}${chat.code ? ` ${chat.code}` : ''}`, runId: null };
      step('B chat accepted', 'NOT_AVAILABLE', data.b.detail);
    } else {
      bStatus = 'FAIL';
      data.b = { status: 'FAIL', detail: `HTTP ${chat.status}${chat.code ? ` ${chat.code}` : ''}`, runId: null };
      step('B chat accepted', 'FAIL', data.b.detail);
    }
  } catch (error) {
    if (!(error instanceof VerifyFailure)) throw error;
    failure = error;
    data.a = { status: 'FAIL', code: error.code, message: error.message };
  } finally {
    if (sse) {
      sse.close();
      data.cleanup.sse = sse.connected ? 'closed' : 'not_connected';
    }
    if (state.runId && bStatus === 'PASS') {
      const runOutcome = await pollRun({
        client,
        runId: state.runId,
        waitMs: waitSeconds * 1000,
        nowImpl,
        sleepImpl,
      });
      data.run = {
        status: runOutcome.outcome === 'TERMINAL'
          ? (runOutcome.status === TERMINAL_SUCCESS ? 'SUCCEEDED' : 'TERMINAL_FAILURE')
          : runOutcome.outcome,
        terminalStatus: runOutcome.status ?? null,
        errorCode: runOutcome.errorCode ?? null,
        waitedMs: runOutcome.waitedMs ?? 0,
      };
      if (runOutcome.outcome === 'TERMINAL') {
        step('B run terminal', runOutcome.status === TERMINAL_SUCCESS ? 'PASS' : 'FAIL', runOutcome.status);
      } else {
        timedOut = runOutcome.outcome === 'TIMEOUT';
        step('B run terminal', runOutcome.outcome, runOutcome.errorCode ?? undefined);
      }
    }
    if (timedOut && state.runId) {
      const cancel = await client.call('POST', `/api/v1/chat/runs/${encodeURIComponent(state.runId)}/cancel`, {
        body: { reason: 'verify_timeout' },
      });
      data.cleanup.runCancel = {
        status: cancel.status === 200 ? 'cancelled' : cancel.status === 409 ? 'not_cancellable' : 'failed',
        httpStatus: cancel.status || null,
        code: cancel.code,
        requestId: cancel.requestId,
      };
    }
    if (state.sessionId) {
      const deleted = await client.call('DELETE', `/api/v1/sessions/${encodeURIComponent(state.sessionId)}`);
      data.cleanup.session = deleted.status === 204
        ? { status: 'deleted' }
        : deleted.status === 404
          ? { status: 'already_absent' }
          : { status: 'failed', httpStatus: deleted.status || null, code: deleted.code, requestId: deleted.requestId };
    } else if (state.sessionOutcome === 'unknown') {
      data.cleanup.session = { status: 'unknown', reason: 'CREATE_OUTCOME_UNKNOWN' };
    }
    data.cleanup.principal = state.principalSource === 'created_this_run'
      ? {
        status: 'retained',
        principalId: state.principalId,
        bindingCreated: state.bindingCreated,
        bindingOutcome: state.bindingOutcome,
        reason: 'NO_PRINCIPAL_DELETE_API',
      }
      : state.principalSource === 'pre_existing'
        ? { status: 'pre_existing', principalId: state.principalId, modified: false }
        : state.principalOutcome === 'unknown'
          ? { status: 'unknown', reason: 'CREATE_OUTCOME_UNKNOWN' }
          : { status: 'not_created' };
  }

  if (failure) {
    data.b = { status: bStatus, detail: null, runId: null };
    data.result = 'FAIL';
    return { exitCode: 1, data };
  }
  if (bStatus === 'NOT_AVAILABLE') {
    data.result = 'NOT_AVAILABLE';
    return { exitCode: 4, data };
  }
  if (bStatus !== 'PASS') {
    data.result = 'FAIL';
    return { exitCode: 1, data };
  }
  if (data.run.status === 'SUCCEEDED') {
    data.result = 'PASS';
    return { exitCode: 0, data };
  }
  if (data.run.status === 'TIMEOUT') {
    data.result = 'TIMEOUT';
    return { exitCode: 5, data };
  }
  data.result = 'FAIL';
  return { exitCode: 1, data };
}
