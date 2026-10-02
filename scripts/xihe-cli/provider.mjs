import { spawnSync } from 'node:child_process';

const DEFAULT_CP_PORT = '12631';
const CP_REQUEST_TIMEOUT_MS = 10_000;
const CP_VERIFY_TIMEOUT_MS = 15_000;

export class CliError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.details = details;
  }
}

export function parseOptions(args, valueOptions, booleanOptions = []) {
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
    if (!knownValues.has(flag) && !knownBooleans.has(flag)) {
      throw new CliError('INVALID_ARGUMENT', `Unknown option ${flag}`);
    }
    if (Object.hasOwn(values, flag)) {
      throw new CliError('INVALID_ARGUMENT', `Option ${flag} was provided more than once`);
    }
    if (knownBooleans.has(flag)) {
      if (inlineValue !== undefined) throw new CliError('INVALID_ARGUMENT', `Option ${flag} does not take a value`);
      values[flag] = true;
      continue;
    }
    const value = inlineValue ?? args[index + 1];
    if (value === undefined || (inlineValue === undefined && value.startsWith('--'))) {
      throw new CliError('INVALID_ARGUMENT', `Option ${flag} requires a value`);
    }
    values[flag] = value;
    if (inlineValue === undefined) index += 1;
  }
  return { values, positionals };
}

export function requireOption(values, flag) {
  const value = values[flag];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CliError('INVALID_ARGUMENT', `Missing required option ${flag}`);
  }
  return value.trim();
}

export function normalizeScope(value) {
  const scope = value?.toUpperCase();
  if (scope !== 'USER' && scope !== 'WORKSPACE') {
    throw new CliError('INVALID_ARGUMENT', 'Scope must be USER or WORKSPACE');
  }
  return scope;
}

export function getApiBase(env) {
  const rawPort = env.XIHE_CP_PORT ?? DEFAULT_CP_PORT;
  if (!/^\d{1,5}$/.test(rawPort)) throw new CliError('INVALID_CP_PORT', 'XIHE_CP_PORT must be a valid local TCP port');
  const port = Number(rawPort);
  if (port < 1 || port > 65535) throw new CliError('INVALID_CP_PORT', 'XIHE_CP_PORT must be a valid local TCP port');
  return `http://127.0.0.1:${port}`;
}

function isSafeConnectFailure(error) {
  const code = error?.cause?.code ?? error?.code;
  return [
    'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH',
    'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  ].includes(code);
}

function apiErrorCode(status, body) {
  if (status === 401) return 'AUTHENTICATION_FAILED';
  if (status === 403) return 'ACCESS_DENIED';
  if (status === 404) return 'NOT_FOUND';
  if (typeof body?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(body.code)) return body.code;
  return `HTTP_${status}`;
}

export async function requestJson(pathname, {
  apiBase,
  fetchImpl = fetch,
  method = 'GET',
  token,
  body,
  timeoutMs = CP_REQUEST_TIMEOUT_MS,
}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let retriedBeforeSend = false;

  for (;;) {
    let response;
    try {
      response = await fetchImpl(`${apiBase}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (!retriedBeforeSend && isSafeConnectFailure(error)) {
        retriedBeforeSend = true;
        continue;
      }
      const writing = method !== 'GET' && method !== 'HEAD';
      throw new CliError(
        writing ? 'OPERATION_OUTCOME_UNKNOWN' : 'CP_UNAVAILABLE',
        writing
          ? 'The request may have reached CP; the operation outcome is unknown and was not replayed.'
          : 'Cannot connect to the local Control Plane.',
        { method, path: pathname },
      );
    }

    if (response.status === 204) return null;
    let text;
    try {
      text = await response.text();
    } catch {
      if (method !== 'GET' && method !== 'HEAD') {
        throw new CliError('OPERATION_OUTCOME_UNKNOWN', 'CP accepted the request but its response could not be read.');
      }
      throw new CliError('CP_RESPONSE_INVALID', 'CP response could not be read.');
    }
    if (text.length > 1_000_000) throw new CliError('CP_RESPONSE_TOO_LARGE', 'CP response exceeded the CLI response limit.');

    let parsed = null;
    if (text.trim() !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (response.ok && method !== 'GET' && method !== 'HEAD') {
          throw new CliError('OPERATION_OUTCOME_UNKNOWN', 'CP accepted the write but returned invalid JSON; reconcile before retrying.', {
            method,
            path: pathname,
          });
        }
        if (response.ok) throw new CliError('CP_RESPONSE_INVALID', 'CP returned invalid JSON.');
      }
    } else if (response.ok && method !== 'GET' && method !== 'HEAD' && response.status !== 204) {
      throw new CliError('OPERATION_OUTCOME_UNKNOWN', 'CP accepted the write but returned an empty response; reconcile before retrying.', {
        method,
        path: pathname,
      });
    }
    if (!response.ok) {
      if (response.status >= 500 && method !== 'GET' && method !== 'HEAD') {
        throw new CliError('OPERATION_OUTCOME_UNKNOWN', 'CP returned a server error after the write; reconcile the operation before retrying.', {
          status: response.status,
          method,
          path: pathname,
        });
      }
      throw new CliError(apiErrorCode(response.status, parsed), `CP request failed (HTTP ${response.status}).`, {
        status: response.status,
        requestId: typeof parsed?.requestId === 'string' ? parsed.requestId : undefined,
      });
    }
    return parsed;
  }
}

export async function login({ apiBase, fetchImpl, env, options, promptSecret }) {
  const email = options['--email'] ?? 'admin@xihe.local';
  const password = env.XIHE_DEV_ADMIN_PASSWORD || await promptSecret('XH local admin password');
  const response = await requestJson('/api/v1/auth/login', {
    apiBase,
    fetchImpl,
    method: 'POST',
    body: { email, password },
  });
  if (typeof response?.accessToken !== 'string' || response.accessToken.length === 0) {
    throw new CliError('AUTH_RESPONSE_INVALID', 'CP login response did not contain an access token.');
  }
  return response.accessToken;
}

export async function getProviderCatalog({ apiBase, fetchImpl, token }) {
  const response = await requestJson('/api/v1/provider-catalog', { apiBase, fetchImpl, token });
  if (!Array.isArray(response?.providers)) throw new CliError('PROVIDER_CATALOG_INVALID', 'CP provider catalog response is invalid.');
  return response.providers;
}

function defaultApiKeyEnv(providerId) {
  return `XIHE_${providerId.replace(/-/g, '_').toUpperCase()}_API_KEY`;
}

export async function readApiKey(providerId, options, env, promptSecret) {
  const envName = options['--api-key-env'] ?? defaultApiKeyEnv(providerId);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(envName)) {
    throw new CliError('INVALID_ARGUMENT', '--api-key-env must be an environment variable name.');
  }
  const value = env[envName];
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (options['--api-key-env'] && !process.stdin.isTTY) {
    throw new CliError('API_KEY_REQUIRED', `Set ${envName} in the process environment or run interactively.`);
  }
  return promptSecret(`${providerId} API key`);
}

export async function promptSecret(label, streams = { stdin: process.stdin, stdout: process.stdout }) {
  const { stdin, stdout } = streams;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new CliError('SECRET_REQUIRED', 'A secret is required; provide it through an environment variable.');
  }
  stdout.write(`${label}: `);
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = Boolean(stdin.isRaw);
    const cleanup = () => {
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(wasRaw); } catch { /* stdin may already be closed */ }
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (buffer) => {
      for (const char of buffer.toString('utf8')) {
        if (char === '\u0003') {
          cleanup();
          reject(new CliError('PROMPT_CANCELLED', 'Secret prompt cancelled.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    try {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
    } catch {
      cleanup();
      reject(new CliError('SECRET_PROMPT_UNAVAILABLE', 'Secure secret prompt is unavailable; provide an environment variable.'));
    }
  });
}

export function safeConnection(view) {
  if (!view || typeof view !== 'object' || typeof view.id !== 'string' || typeof view.providerId !== 'string') {
    throw new CliError('PROVIDER_CONNECTION_INVALID', 'CP returned an invalid provider connection view.');
  }
  return {
    id: view.id,
    providerId: view.providerId,
    label: view.label,
    scope: view.scope,
    hasKey: Boolean(view.hasKey),
    enabled: Boolean(view.enabled),
    status: view.status,
    lastVerifiedAt: view.lastVerifiedAt ?? null,
    lastErrorCode: view.lastErrorCode ?? null,
    revision: view.revision,
  };
}

export async function listConnections({ apiBase, fetchImpl, token }) {
  const response = await requestJson('/api/v1/provider-connections', { apiBase, fetchImpl, token });
  if (!Array.isArray(response?.connections)) throw new CliError('PROVIDER_CONNECTIONS_INVALID', 'CP provider connection list is invalid.');
  return response.connections.map(safeConnection);
}

export async function verifyConnection({ apiBase, fetchImpl, token, id }) {
  let response;
  let connection;
  try {
    response = await requestJson(`/api/v1/provider-connections/${encodeURIComponent(id)}/verify`, {
      apiBase,
      fetchImpl,
      token,
      method: 'POST',
      timeoutMs: CP_VERIFY_TIMEOUT_MS,
    });
    connection = safeConnection(response?.connection);
  } catch (error) {
    if (error.code !== 'OPERATION_OUTCOME_UNKNOWN' && error.code !== 'PROVIDER_CONNECTION_INVALID') throw error;
    let current;
    try { current = (await listConnections({ apiBase, fetchImpl, token })).find((item) => item.id === id); } catch { /* preserve unknown outcome */ }
    throw new CliError('OPERATION_OUTCOME_UNKNOWN', 'Verification outcome is unknown; it was not replayed.', {
      connection: current ?? { id },
    });
  }
  if (connection.status !== 'ready') {
    throw new CliError('PROVIDER_VERIFY_FAILED', 'Provider verification did not reach ready state.', {
      connection,
      providerErrorCode: connection.lastErrorCode,
    });
  }
  return connection;
}

export function findMatchingConnections(connections, providerId, scope) {
  return connections.filter((connection) => connection.providerId === providerId && connection.scope === scope);
}

export function validateBaseUrl(value) {
  if (value === undefined) return;
  let url;
  try { url = new URL(value); } catch { throw new CliError('INVALID_ARGUMENT', '--base-url must be an absolute HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new CliError('INVALID_ARGUMENT', '--base-url must use HTTP(S) and contain no credentials, query, or fragment.');
  }
}

export function parseManualModels(value) {
  if (value === undefined) return undefined;
  const models = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (models.length === 0 || new Set(models).size !== models.length) {
    throw new CliError('INVALID_ARGUMENT', '--models must contain unique, comma-separated model IDs.');
  }
  return models;
}

function resolveModelSettings(catalog, options) {
  const manualModels = parseManualModels(options['--models']);
  const discovery = catalog.modelDiscovery ?? 'remote-models';
  if (discovery !== 'manual' && manualModels) {
    throw new CliError('INVALID_ARGUMENT', `Provider ${catalog.id} uses Catalog remote model discovery; --models is not accepted.`);
  }
  if (discovery === 'manual' && !manualModels?.length) {
    throw new CliError('MANUAL_MODELS_REQUIRED', `Provider ${catalog.id} uses Catalog manual model discovery; --models with at least one model ID is required.`);
  }
  return { manualModels: manualModels ?? [] };
}

function validateProviderBaseUrl(catalog, value) {
  validateBaseUrl(value);
  if (value !== undefined && catalog.supports?.customBaseUrl !== true) {
    throw new CliError('CUSTOM_BASE_URL_UNSUPPORTED', 'This provider does not allow a custom base URL.');
  }
}

export async function createConnection({ apiBase, fetchImpl, token, providerId, scope, label, apiKey, baseUrl, catalog, manualModels }) {
  const required = catalog.credential?.required !== false;
  if (required && (typeof apiKey !== 'string' || apiKey.trim() === '')) {
    throw new CliError('API_KEY_REQUIRED', 'This provider requires an API key.');
  }
  const discovery = catalog.modelDiscovery ?? 'remote-models';
  const models = Array.isArray(manualModels) ? manualModels : [];
  if (discovery === 'manual' && models.length === 0) {
    throw new CliError('MANUAL_MODELS_REQUIRED', 'Manual discovery requires at least one model ID.');
  }
  if (discovery !== 'manual' && models.length > 0) {
    throw new CliError('INVALID_ARGUMENT', 'Manual model IDs require manual model discovery.');
  }
  validateProviderBaseUrl(catalog, baseUrl);
  const body = {
    providerId,
    label,
    scope,
    manualModels: models,
    enabled: true,
  };
  if (required) body.apiKey = apiKey;
  if (baseUrl !== undefined) body.baseUrl = baseUrl;
  const response = await requestJson('/api/v1/provider-connections', {
    apiBase,
    fetchImpl,
    token,
    method: 'POST',
    body,
  });
  try {
    return safeConnection(response);
  } catch {
    throw new CliError('OPERATION_OUTCOME_UNKNOWN', 'CP accepted the create but returned an invalid connection view; reconcile provider list before retrying.');
  }
}

export function connectionResult(connection, action, warnings = []) {
  return { action, connection, warnings };
}

export async function addProvider({ apiBase, fetchImpl, env, options, positionals, token, promptSecret }) {
  if (positionals.length !== 1) throw new CliError('INVALID_ARGUMENT', 'provider add requires one provider ID.');
  const providerId = positionals[0];
  const scope = normalizeScope(options['--scope']);
  const label = requireOption(options, '--label');
  const catalogEntries = await getProviderCatalog({ apiBase, fetchImpl, token });
  const catalog = catalogEntries.find((entry) => entry?.id === providerId);
  if (!catalog) throw new CliError('UNSUPPORTED_PROVIDER', 'Provider ID is not present in the CP catalog.');
  const modelSettings = resolveModelSettings(catalog, options);
  validateProviderBaseUrl(catalog, options['--base-url']);
  const apiKey = catalog.credential?.required === false
    ? undefined
    : await readApiKey(providerId, options, env, promptSecret);

  let created;
  try {
    created = await createConnection({ apiBase, fetchImpl, token, providerId, scope, label, apiKey, baseUrl: options['--base-url'], catalog, ...modelSettings });
  } catch (error) {
    if (error.code === 'OPERATION_OUTCOME_UNKNOWN') {
      let matches = [];
      try { matches = findMatchingConnections(await listConnections({ apiBase, fetchImpl, token }), providerId, scope); } catch { /* preserve unknown outcome */ }
      throw new CliError('OPERATION_OUTCOME_UNKNOWN', 'Create response was lost; inspect provider list before retrying.', { matches: matches.map((item) => item.id) });
    }
    if (error.status === 400 || error.code === 'PROVIDER_CONNECTION_INVALID') {
      throw new CliError('PROVIDER_CONNECTION_CREATE_REJECTED', 'CP rejected connection creation; check provider list and use provider update only with its explicit ID.');
    }
    throw error;
  }

  try {
    return connectionResult(await verifyConnection({ apiBase, fetchImpl, token, id: created.id }), 'created-and-verified');
  } catch (error) {
    throw new CliError('PROVIDER_VERIFY_FAILED', 'Connection was created but did not verify; it was kept for explicit recovery.', {
      connection: created,
      providerErrorCode: error.details?.providerErrorCode ?? error.code,
    });
  }
}

export async function updateProvider({ apiBase, fetchImpl, env, options, positionals, token, promptSecret }) {
  if (positionals.length !== 1) throw new CliError('INVALID_ARGUMENT', 'provider update requires one connection ID.');
  const id = positionals[0];
  const current = (await listConnections({ apiBase, fetchImpl, token })).find((item) => item.id === id);
  if (!current) throw new CliError('NOT_FOUND', 'Provider connection is not visible to the authenticated user.');
  const catalog = (await getProviderCatalog({ apiBase, fetchImpl, token })).find((entry) => entry?.id === current.providerId);
  if (!catalog) throw new CliError('UNSUPPORTED_PROVIDER', 'Connection provider is not present in the CP catalog.');
  validateProviderBaseUrl(catalog, options['--base-url']);
  const fields = {};
  if (options['--label']) fields.label = options['--label'];
  if (options['--base-url']) fields.baseUrl = options['--base-url'];
  if (options['--models'] !== undefined) {
    const settings = resolveModelSettings(catalog, options);
    fields.manualModels = settings.manualModels;
  }
  if (Object.hasOwn(options, '--api-key-env')) {
    fields.apiKey = await readApiKey(current.providerId, options, env, promptSecret);
  }
  if (typeof fields.apiKey === 'string' && fields.apiKey.trim() === '') {
    throw new CliError('API_KEY_REQUIRED', 'Provider API key must not be empty.');
  }
  if (Object.keys(fields).length === 0) {
    throw new CliError('INVALID_ARGUMENT', 'Provide --label, --base-url, --models, or --api-key-env to update the connection.');
  }

  let updated;
  try {
    const response = await requestJson(`/api/v1/provider-connections/${encodeURIComponent(id)}`, {
      apiBase, fetchImpl, token, method: 'PATCH', body: fields,
    });
    updated = safeConnection(response);
  } catch (error) {
    if (error.code === 'PROVIDER_CONNECTION_INVALID') {
      let current;
      try { current = (await listConnections({ apiBase, fetchImpl, token })).find((item) => item.id === id); } catch { /* preserve unknown outcome */ }
      throw new CliError('OPERATION_OUTCOME_UNKNOWN', 'CP accepted the update but returned an invalid connection view; inspect the connection before retrying.', { connection: current ?? { id } });
    }
    if (error.code === 'OPERATION_OUTCOME_UNKNOWN') {
      let current;
      try { current = (await listConnections({ apiBase, fetchImpl, token })).find((item) => item.id === id); } catch { /* preserve unknown outcome */ }
      throw new CliError('OPERATION_OUTCOME_UNKNOWN', 'Update response was lost; inspect the listed connection and verify it explicitly. The update was not replayed.', { connection: current ?? { id } });
    }
    throw error;
  }

  try {
    return connectionResult(await verifyConnection({ apiBase, fetchImpl, token, id }), 'updated-and-verified');
  } catch (error) {
    throw new CliError('PROVIDER_VERIFY_FAILED', 'Connection was updated but did not verify; it was kept for explicit recovery.', {
      connection: updated,
      providerErrorCode: error.details?.providerErrorCode ?? error.code,
    });
  }
}

export async function listProviderConnections({ apiBase, fetchImpl, options, token }) {
  let connections = await listConnections({ apiBase, fetchImpl, token });
  if (options['--scope']) {
    const scope = normalizeScope(options['--scope']);
    connections = connections.filter((connection) => connection.scope === scope);
  }
  return { connections };
}

export async function initProvider({ apiBase, fetchImpl, env, options, positionals, token, promptSecret }) {
  if (positionals.length !== 0) throw new CliError('INVALID_ARGUMENT', 'Use --provider and --scope with dev init.');
  const providerId = requireOption(options, '--provider');
  const scope = normalizeScope(options['--scope']);
  const matches = findMatchingConnections(await listConnections({ apiBase, fetchImpl, token }), providerId, scope);
  if (matches.length > 1) throw new CliError('CONNECTION_MATCH_AMBIGUOUS', 'More than one visible connection matched provider and scope.');
  if (matches.length === 1) {
    const warnings = options['--api-key-env'] || options['--label'] || options['--base-url'] || options['--models']
      ? ['Existing connection was reused unchanged; use provider update <id> to change it.']
      : [];
    return connectionResult(await verifyConnection({ apiBase, fetchImpl, token, id: matches[0].id }), 'reused-and-verified', warnings);
  }

  const label = requireOption(options, '--label');
  const catalogEntries = await getProviderCatalog({ apiBase, fetchImpl, token });
  const catalog = catalogEntries.find((entry) => entry?.id === providerId);
  if (!catalog) throw new CliError('UNSUPPORTED_PROVIDER', 'Provider ID is not present in the CP catalog.');
  const modelSettings = resolveModelSettings(catalog, options);
  validateProviderBaseUrl(catalog, options['--base-url']);
  const apiKey = catalog.credential?.required === false
    ? undefined
    : await readApiKey(providerId, options, env, promptSecret);

  let created;
  try {
    created = await createConnection({ apiBase, fetchImpl, token, providerId, scope, label, apiKey, baseUrl: options['--base-url'], catalog, ...modelSettings });
  } catch (error) {
    if (error.code === 'OPERATION_OUTCOME_UNKNOWN' || error.status === 400 || error.code === 'PROVIDER_CONNECTION_INVALID') {
      let concurrent = [];
      try { concurrent = findMatchingConnections(await listConnections({ apiBase, fetchImpl, token }), providerId, scope); } catch { /* preserve create failure */ }
      if (concurrent.length === 1) {
        return connectionResult(await verifyConnection({ apiBase, fetchImpl, token, id: concurrent[0].id }), 'reused-after-create-conflict', [
          'A matching connection appeared during create; it was reused and not updated.',
        ]);
      }
      if (error.code === 'OPERATION_OUTCOME_UNKNOWN') {
        throw new CliError('OPERATION_OUTCOME_UNKNOWN', 'Create response was lost and no matching connection could be confirmed; inspect provider list before retrying.', { matches: concurrent.map((item) => item.id) });
      }
    }
    throw error;
  }
  try {
    return connectionResult(await verifyConnection({ apiBase, fetchImpl, token, id: created.id }), 'created-and-verified');
  } catch (error) {
    throw new CliError('PROVIDER_VERIFY_FAILED', 'Connection was created but did not verify; rerun dev init or use provider verify.', {
      connection: created,
      providerErrorCode: error.details?.providerErrorCode ?? error.code,
    });
  }
}
