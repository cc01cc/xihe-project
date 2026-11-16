import { CliError, parseOptions } from './provider.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;

const AGENT_SCOPES = new Map([
  ['personal', 'PERSONAL'],
  ['workspace', 'WORKSPACE'],
  ['instance', 'INSTANCE'],
  ['PERSONAL', 'PERSONAL'],
  ['WORKSPACE', 'WORKSPACE'],
  ['INSTANCE', 'INSTANCE'],
]);

function usageError(message) {
  return new CliError('INVALID_ARGUMENT', message, {}, 2);
}

/**
 * D-174 / PLAN-0750 M1: `scope` is gone from the wire (create body AND list query).
 * `--scope` survives only as a **CLI-local filter** over the rows CP returns; this
 * normalizer validates that filter value and nothing else.
 */
export function normalizeAgentScope(value) {
  const scope = AGENT_SCOPES.get(String(value ?? '').trim());
  if (!scope) {
    throw usageError('Scope must be personal, workspace or instance.');
  }
  return scope;
}

/**
 * Derive the legacy scope view of one principal row from what the contract still
 * carries (AgentPrincipalView): ownership=INSTANCE ⇒ INSTANCE; otherwise the
 * presence of ownerUserId decides PERSONAL vs WORKSPACE (the same rule the CP
 * participant view uses: owner ⇒ personal, no owner ⇒ workspace). Rows without
 * either field yield null and never match a --scope filter.
 */
export function principalScopeView(row) {
  if (row?.ownership === 'INSTANCE') return 'INSTANCE';
  if (row?.ownerUserId) return 'PERSONAL';
  if (row && 'ownerUserId' in row && row.ownerUserId === null) return 'WORKSPACE';
  return null;
}

/** `provider:model` — the provider half may not contain a colon. */
export function parseModelRef(value, flag = '--model') {
  const text = String(value ?? '').trim();
  const separator = text.indexOf(':');
  if (separator <= 0 || separator === text.length - 1) {
    throw usageError(`${flag} must use the form <provider>:<model>.`);
  }
  return { provider: text.slice(0, separator).trim(), model: text.slice(separator + 1).trim() };
}

function modelRefOf(view) {
  const provider = view?.defaultModelProvider ?? view?.provider ?? null;
  const model = view?.defaultModelName ?? view?.model ?? null;
  return provider && model ? `${provider}:${model}` : null;
}

function allowedModelRefs(view) {
  const list = Array.isArray(view?.allowedModels) ? view.allowedModels : [];
  return list
    .map((item) => (typeof item === 'string' ? item : `${item?.provider ?? ''}:${item?.model ?? ''}`))
    .filter((item) => /^[^:]+:[^:]+$/.test(item))
    .sort();
}

function samePrincipal(left, right) {
  if ((left?.name ?? '') !== right.name) return false;
  // D-174: scope is no longer part of the wire row or the idempotency key.
  if ((left?.templateId ?? null) !== (right.templateId ?? null)) return false;
  if (modelRefOf(left) !== right.modelRef) return false;
  const leftAllowed = allowedModelRefs(left);
  const rightAllowed = [...right.allowedModelRefs].sort();
  return leftAllowed.length === rightAllowed.length
    && leftAllowed.every((item, index) => item === rightAllowed[index]);
}

async function callApi({
  apiBase,
  fetchImpl,
  token,
  method,
  path,
  body,
  workspaceId,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
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
    throw new CliError(aborted ? 'REQUEST_TIMEOUT' : 'CONNECTION_FAILED', aborted
      ? `CP did not answer ${method} ${path} in ${timeoutMs}ms.`
      : `Could not reach CP at ${apiBase}.`, {}, 1);
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
}

function expectStatus(response, action, accepted = [200, 201, 204]) {
  if (accepted.includes(response.status)) return response;
  const code = response.code ?? `HTTP_${response.status}`;
  throw new CliError(code, `CP rejected ${action} (HTTP ${response.status}${code === `HTTP_${response.status}` ? '' : ` ${code}`}).`, {
    httpStatus: response.status,
    ...response.body,
    ...(response.retryAfter ? { retryAfter: response.retryAfter } : {}),
  }, 1);
}

function listPrincipals({ apiBase, fetchImpl, token, workspaceId = '' }) {
  // D-174: the only contract query parameter is workspaceId; `?scope=` is gone.
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
  return callApi({ apiBase, fetchImpl, token, method: 'GET', path: `/api/v1/agent-principals${query}` });
}

/**
 * `agent create` — idempotent by (name, template, default model, allowed models).
 *
 * D-174 / PLAN-0750 M1: the create body carries **no scope** (CP CREATE_KEYS is
 * additionalProperties:false without it — sending it answers 400 INVALID_REQUEST).
 * The door is chosen by context, not by a field: no --workspace ⇒ user-level create
 * (CREATE_OWN_AGENT); --workspace ⇒ workspace-tier create via X-Workspace-Id
 * (MANAGE_WORKSPACE_AGENTS). `--scope` remains an optional **CLI-local filter**
 * applied to the idempotency lookup only; it never reaches the wire.
 */
export async function createAgent({ apiBase, fetchImpl, token, options }) {
  const name = String(options['--name'] ?? '').trim();
  if (!name) throw usageError('agent create requires --name.');
  const localScope = options['--scope'] ? normalizeAgentScope(options['--scope']) : null;
  const workspaceId = options['--workspace']?.trim() || '';
  const templateId = options['--template']?.trim() || null;
  const defaultModel = options['--default-model'] ? parseModelRef(options['--default-model'], '--default-model') : null;
  const allowedModels = Array.isArray(options['--allow-model']) ? options['--allow-model'] : [];
  const allowed = allowedModels.map((value) => parseModelRef(value, '--allow-model'));

  const desired = {
    name,
    templateId,
    modelRef: defaultModel ? `${defaultModel.provider}:${defaultModel.model}` : null,
    allowedModelRefs: allowed.map((item) => `${item.provider}:${item.model}`),
  };
  const matches = (row) => samePrincipal(row, desired)
    && (localScope === null || principalScopeView(row) === localScope);

  const existing = await listPrincipals({ apiBase, fetchImpl, token, workspaceId });
  if ([200].includes(existing.status) && Array.isArray(existing.body?.principals)) {
    const match = existing.body.principals.find(matches);
    if (match) {
      return {
        kind: 'agent-created',
        created: false,
        idempotent: true,
        principal: match,
        principalId: match.principalId ?? match.id ?? null,
        ...(localScope ? { localFilter: { scope: localScope } } : {}),
      };
    }
  } else if (![200, 404, 405].includes(existing.status)) {
    expectStatus(existing, 'agent principal listing');
  }

  const body = {
    name,
    ...(templateId ? { templateId } : {}),
    ...(defaultModel ? {
      defaultModelProvider: defaultModel.provider,
      defaultModelName: defaultModel.model,
    } : {}),
    ...(allowed.length > 0 ? { allowedModels: allowed } : {}),
  };
  const created = await callApi({ apiBase, fetchImpl, token, method: 'POST', path: '/api/v1/agent-principals', body, workspaceId: workspaceId || undefined });
  if (created.status === 409) {
    // Race: another invocation created the same principal between our list and create.
    const retry = await listPrincipals({ apiBase, fetchImpl, token, workspaceId });
    const match = [200].includes(retry.status) && Array.isArray(retry.body?.principals)
      ? retry.body.principals.find(matches)
      : null;
    if (match) {
      return {
        kind: 'agent-created', created: false, idempotent: true, principal: match,
        principalId: match.principalId ?? match.id ?? null,
        ...(localScope ? { localFilter: { scope: localScope } } : {}),
      };
    }
  }
  expectStatus(created, 'agent principal creation');
  const principalId = created.body?.principalId ?? created.body?.id ?? null;
  if (!principalId) {
    throw new CliError('AGENT_PRINCIPAL_CREATE_INVALID', 'CP accepted the create but returned no principalId.', {}, 1);
  }
  return {
    kind: 'agent-created', created: true, idempotent: false, principal: created.body, principalId,
    ...(localScope ? { localFilter: { scope: localScope } } : {}),
  };
}

/**
 * `agent list [--workspace ws] [--scope s]`.
 *
 * D-174 / PLAN-0750 M2: the principal listing's only query parameter is
 * `workspaceId`; `?scope=` is gone from the contract (CP ignores unknown query
 * params, so sending it was a silently-ignored filter — fake green). `--scope`
 * survives as a **CLI-local filter** over the returned rows, derived from
 * ownership/ownerUserId (see principalScopeView); the output marks it explicitly
 * as `localFilter` so nobody reads it as a server-side filter again.
 *
 * Envelopes stay verbatim: `{agents:[...]}` for the workspace view (no --scope),
 * `{principals:[...]}` for the principal view — no flattening, no array fallback.
 */
export async function listAgents({ apiBase, fetchImpl, token, options }) {
  const workspaceId = options['--workspace']?.trim() || '';
  const scope = options['--scope'] ? normalizeAgentScope(options['--scope']) : null;
  if (workspaceId && !scope) {
    const response = await callApi({
      apiBase, fetchImpl, token, method: 'GET', path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agents`, workspaceId,
    });
    expectStatus(response, 'workspace agent listing');
    if (!Array.isArray(response.body?.agents)) {
      throw new CliError('AGENT_LIST_ENVELOPE_INVALID', 'CP returned no {agents:[...]} envelope for the workspace agent listing.', {}, 1);
    }
    return { kind: 'agent-list', scope: null, workspaceId, agents: response.body.agents };
  }
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
  const response = await callApi({ apiBase, fetchImpl, token, method: 'GET', path: `/api/v1/agent-principals${query}` });
  expectStatus(response, 'agent principal listing');
  if (!Array.isArray(response.body?.principals)) {
    throw new CliError('AGENT_LIST_ENVELOPE_INVALID', 'CP returned no {principals:[...]} envelope for the agent principal listing.', {}, 1);
  }
  const principals = scope === null
    ? response.body.principals
    : response.body.principals.filter((row) => principalScopeView(row) === scope);
  return {
    kind: 'agent-list',
    scope,
    workspaceId: workspaceId || null,
    principals,
    ...(scope !== null ? { localFilter: { scope, basis: 'ownership/ownerUserId (CLI-local; CP has no scope query)' } } : {}),
  };
}

function requireWorkspace(options) {
  const workspaceId = String(options['--workspace'] ?? '').trim();
  if (!workspaceId) throw usageError('This command requires --workspace <wsId>.');
  return workspaceId;
}

function requirePrincipal(options) {
  const principalId = String(options['--principal'] ?? '').trim();
  if (!principalId) throw usageError('This command requires --principal <principalId>.');
  return principalId;
}

/** `agent bind` — repeated bind is an idempotent success. */
export async function bindAgent({ apiBase, fetchImpl, token, options }) {
  const workspaceId = requireWorkspace(options);
  const principalId = requirePrincipal(options);
  const response = await callApi({
    apiBase, fetchImpl, token, method: 'PUT',
    path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(principalId)}`,
    body: { permissions: [] },
    workspaceId,
  });
  const alreadyBound = response.status === 409;
  if (alreadyBound) {
    return { kind: 'agent-binding', action: 'bind', workspaceId, principalId, alreadyBound: true };
  }
  expectStatus(response, 'workspace agent binding');
  return { kind: 'agent-binding', action: 'bind', workspaceId, principalId, alreadyBound: false };
}

/** `agent unbind` — a missing binding is an idempotent success. */
export async function unbindAgent({ apiBase, fetchImpl, token, options }) {
  const workspaceId = requireWorkspace(options);
  const principalId = requirePrincipal(options);
  const response = await callApi({
    apiBase, fetchImpl, token, method: 'DELETE',
    path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(principalId)}`,
    workspaceId,
  });
  if (response.status === 404) {
    return { kind: 'agent-binding', action: 'unbind', workspaceId, principalId, alreadyUnbound: true };
  }
  expectStatus(response, 'workspace agent unbind');
  return { kind: 'agent-binding', action: 'unbind', workspaceId, principalId, alreadyUnbound: false };
}

/** `agent disable` — repeated disable is an idempotent success. */
export async function disableAgent({ apiBase, fetchImpl, token, options }) {
  const principalId = requirePrincipal(options);
  const response = await callApi({
    apiBase, fetchImpl, token, method: 'POST',
    path: `/api/v1/agent-principals/${encodeURIComponent(principalId)}/disable`,
  });
  if (response.status === 409) {
    return { kind: 'agent-disabled', principalId, alreadyDisabled: true };
  }
  expectStatus(response, 'agent principal disable');
  return { kind: 'agent-disabled', principalId, alreadyDisabled: false };
}

function parsePositiveInt(raw, flag) {
  const text = String(raw ?? '').trim();
  if (/^(none|null)$/i.test(text)) return null;
  if (!/^\d+$/.test(text) || Number(text) <= 0) {
    throw usageError(`${flag} must be a positive integer or "none".`);
  }
  return Number(text);
}

/**
 * Walk `provider limit set` args in order so `--model p:m` starts a per-model limit
 * block: the following `--max-inflight/--max-queue/--tokens/--window` apply to it.
 * PLAN-0622 contract v1: `modelLimits` is a full replacement — `--clear-model-limits`
 * sends `[]` (clear all), omitting it inherits the connection-level limits, and a
 * `none` value sends `null` (clear that one limit).
 */
export function parseLimitArgs(args) {
  const values = { modelLimits: [], clearModelLimits: false };
  let currentModel = null;
  const setGlobalOrModel = (key, flag, value) => {
    if (currentModel) {
      currentModel[key] = parsePositiveInt(value, flag);
    } else {
      if (Object.hasOwn(values, key)) throw usageError(`${flag} was provided more than once.`);
      values[key] = parsePositiveInt(value, flag);
    }
  };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) throw usageError(`Unexpected argument ${token}.`);
    const separator = token.indexOf('=');
    const flag = separator === -1 ? token : token.slice(0, separator);
    let value = separator === -1 ? undefined : token.slice(separator + 1);
    if (!['--connection', '--max-inflight', '--max-queue', '--tokens', '--window', '--model', '--clear-model-limits', '--email'].includes(flag)) {
      throw usageError(`Unknown option ${flag}.`);
    }
    if (flag === '--clear-model-limits') {
      if (value !== undefined) throw usageError('--clear-model-limits does not take a value.');
      values.clearModelLimits = true;
      currentModel = null;
      continue;
    }
    if (value === undefined) {
      value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw usageError(`Option ${flag} requires a value.`);
      index += 1;
    }
    if (flag === '--connection') {
      if (values.connection) throw usageError('--connection was provided more than once.');
      values.connection = value.trim();
    } else if (flag === '--email') {
      values.email = value;
    } else if (flag === '--model') {
      const ref = parseModelRef(value, '--model');
      if (values.modelLimits.some((item) => item.provider === ref.provider && item.model === ref.model)) {
        throw usageError(`--model ${value} was provided more than once.`);
      }
      currentModel = { provider: ref.provider, model: ref.model };
      values.modelLimits.push(currentModel);
    } else if (flag === '--max-inflight') {
      setGlobalOrModel('maxInflight', flag, value);
    } else if (flag === '--max-queue') {
      setGlobalOrModel('maxQueue', flag, value);
    } else if (flag === '--tokens') {
      setGlobalOrModel('windowTokenBudget', flag, value);
    } else if (flag === '--window') {
      setGlobalOrModel('windowSeconds', flag, value);
    }
  }
  delete values.email;
  if (values.windowTokenBudget !== undefined && values.windowSeconds === undefined) {
    throw usageError('--tokens requires --window (both are a single quota pair).');
  }
  if (values.windowSeconds !== undefined && values.windowTokenBudget === undefined) {
    throw usageError('--window requires --tokens (both are a single quota pair).');
  }
  for (const item of values.modelLimits) {
    if ((item.windowTokenBudget === undefined) !== (item.windowSeconds === undefined)) {
      throw usageError('Per-model --tokens and --window must be provided together.');
    }
  }
  return values;
}

/** `provider limit set --connection C [...]`. */
export async function setProviderLimits({ apiBase, fetchImpl, token, options }) {
  const connectionId = String(options.connection ?? '').trim();
  if (!connectionId) throw usageError('provider limit set requires --connection <connectionId>.');
  const body = {};
  for (const key of ['maxInflight', 'maxQueue', 'windowTokenBudget', 'windowSeconds']) {
    if (options[key] !== undefined) body[key] = options[key];
  }
  if (options.clearModelLimits === true) {
    body.modelLimits = [];
  } else if (Array.isArray(options.modelLimits) && options.modelLimits.length > 0) {
    body.modelLimits = options.modelLimits;
  }
  if (Object.keys(body).length === 0) {
    throw usageError('Provide at least one limit (--max-inflight/--max-queue/--tokens --window/--model .../--clear-model-limits).');
  }
  const response = await callApi({
    apiBase, fetchImpl, token, method: 'PATCH',
    path: `/api/v1/provider-connections/${encodeURIComponent(connectionId)}`, body,
  });
  expectStatus(response, 'provider connection limit update');
  return { kind: 'provider-limits', action: 'set', connectionId, limits: body };
}

function limitsOf(view) {
  const limits = {};
  if (view?.maxInflight !== undefined) limits.maxInflight = view.maxInflight;
  if (view?.maxQueue !== undefined) limits.maxQueue = view.maxQueue;
  if (view?.windowTokenBudget !== undefined) limits.windowTokenBudget = view.windowTokenBudget;
  if (view?.windowSeconds !== undefined) limits.windowSeconds = view.windowSeconds;
  if (Array.isArray(view?.modelLimits)) limits.modelLimits = view.modelLimits;
  return limits;
}

/** `provider limit show --connection C` (CP has no GET-by-id; read the list view). */
export async function showProviderLimits({ apiBase, fetchImpl, token, options }) {
  const connectionId = String(options.connection ?? '').trim();
  if (!connectionId) throw usageError('provider limit show requires --connection <connectionId>.');
  const response = await callApi({ apiBase, fetchImpl, token, method: 'GET', path: '/api/v1/provider-connections' });
  expectStatus(response, 'provider connection listing');
  const connections = Array.isArray(response.body?.connections) ? response.body.connections
    : Array.isArray(response.body) ? response.body : [];
  const connection = connections.find((item) => item?.id === connectionId);
  if (!connection) {
    throw new CliError('CONNECTION_NOT_FOUND', `No provider connection ${connectionId} is visible to this account.`, {}, 1);
  }
  return { kind: 'provider-limits', action: 'show', connectionId, connection, limits: limitsOf(connection) };
}

/** Repeatable `--allow-model` support on top of the shared option parser. */
export function parseAgentOptions(args, valueOptions, booleanOptions = []) {
  const repeatable = new Set(['--allow-model']);
  const values = {};
  const positionals = [];
  const knownValues = new Set(valueOptions);
  const knownBooleans = new Set(booleanOptions);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const separator = token.indexOf('=');
    const flag = separator === -1 ? token : token.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : token.slice(separator + 1);
    if (!knownValues.has(flag) && !knownBooleans.has(flag)) throw usageError(`Unknown option ${flag}.`);
    if (knownBooleans.has(flag)) {
      if (inlineValue !== undefined) throw usageError(`Option ${flag} does not take a value.`);
      values[flag] = true;
      continue;
    }
    const value = inlineValue ?? args[index + 1];
    if (value === undefined || (inlineValue === undefined && value.startsWith('--'))) {
      throw usageError(`Option ${flag} requires a value.`);
    }
    if (repeatable.has(flag)) {
      values[flag] = Array.isArray(values[flag]) ? [...values[flag], value] : [value];
    } else {
      if (Object.hasOwn(values, flag)) throw usageError(`Option ${flag} was provided more than once.`);
      values[flag] = value;
    }
    if (inlineValue === undefined) index += 1;
  }
  return { values, positionals };
}

export { parseOptions };
