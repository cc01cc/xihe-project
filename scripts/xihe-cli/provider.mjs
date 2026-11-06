import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { withLoginLock } from './login-lock.mjs';
import { cacheDisabled, persistToken, tokenEntryFor } from './token-store.mjs';

const DEFAULT_CP_PORT = '12631';
const CP_REQUEST_TIMEOUT_MS = 10_000;
const CP_VERIFY_TIMEOUT_MS = 15_000;

// BL-396: `Retry-After` is honoured but bounded. A hostile/oversized value must not
// turn one CLI command into a several-minute wait; the login retry loop caps what
// it sleeps anyway, this cap keeps the surfaced `retryAfterMs` honest.
const MAX_RETRY_AFTER_MS = 5_000;

/** `Retry-After` is either delta-seconds (CP's shape) or an HTTP date; anything else is unknown. */
export function parseRetryAfterMs(value, nowMs = Date.now()) {
  const text = String(value ?? '').trim();
  if (text === '') return undefined;
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    if (!Number.isFinite(seconds)) return undefined;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return undefined;
  const delta = at - nowMs;
  return Math.min(delta > 0 ? delta : 0, MAX_RETRY_AFTER_MS);
}

export class CliError extends Error {
  constructor(code, message, details = {}, exitCode) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.details = details;
    if (Number.isInteger(exitCode)) this.exitCode = exitCode;
  }
}

// PLAN-0643 T3.6 (design D7/D8, spec/cli-contract.md §3): one exit-code source.
// 0 = success, 1 = business/runtime failure, 2 = usage error. Before this mapping the
// same class of failure answered 1 or 2 depending on which call site threw it.
const USAGE_ERROR_CODES = new Set([
  'INVALID_ARGUMENT',
  'INVALID_CP_PORT',
  'INVALID_CP_URL',
  'INVALID_BASE_URL',
  'API_TARGET_INVALID',
  'API_METHOD_REQUIRES_YES',
  'API_DANGEROUS_REQUIRES_ALLOW',
  'API_BODY_INVALID',
  'API_RESPONSE_NOT_JSON',
  'API_RESPONSE_UNSUPPORTED',
  'API_ESCAPE_DISABLED',
  'EXIT_USAGE',
]);

export const LEGACY_EXIT_CODES_ENV = 'XIHE_CLI_LEGACY_EXIT_CODES';

function legacyExitCodes(env = {}) {
  const value = String(env[LEGACY_EXIT_CODES_ENV] ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/** Map a CLI error code to the frozen exit-code table (design D7), with a one-batch legacy switch (D8). */
export function exitCodeFor(code, env = {}) {
  if (legacyExitCodes(env)) return 1;
  return typeof code === 'string' && USAGE_ERROR_CODES.has(code) ? 2 : 1;
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

// Interactive confirmation for destructive operations (PLAN-0574 T1.2/T1.3).
// Non-interactive callers must pass an explicit --yes/--force instead; the CLI
// never assumes consent.
export async function confirmAction({ message, stdin = process.stdin, output = process.stderr }) {
  if (!stdin?.isTTY) {
    throw new CliError(
      'CONFIRMATION_REQUIRED',
      'This operation needs confirmation; re-run with --yes (or --force where supported) in a non-interactive session.',
      {},
      1,
    );
  }
  const readline = createInterface({ input: stdin, output });
  try {
    const answer = await readline.question(`${message} [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      throw new CliError('CONFIRMATION_DECLINED', 'The operation was not confirmed; nothing was changed.', {}, 1);
    }
  } finally {
    readline.close();
  }
}

function loopbackFromPort(env) {
  const rawPort = env.XIHE_CP_PORT ?? DEFAULT_CP_PORT;
  if (!/^\d{1,5}$/.test(rawPort)) throw new CliError('INVALID_CP_PORT', 'XIHE_CP_PORT must be a valid local TCP port');
  const port = Number(rawPort);
  if (port < 1 || port > 65535) throw new CliError('INVALID_CP_PORT', 'XIHE_CP_PORT must be a valid local TCP port');
  return `http://127.0.0.1:${port}`;
}

function absoluteHttpUrl(value, code) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new CliError(code, 'The CP base URL must be an absolute http(s) URL.');
  }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.host) {
    throw new CliError(code, 'The CP base URL must be an absolute http(s) URL.');
  }
  return value.replace(/\/+$/, '');
}

/**
 * PLAN-0643 T1.7 (design D5): one precedence chain for the CP endpoint —
 * `--base-url` > `XIHE_CP_URL` > `XIHE_CP_PORT` (loopback) > default 12631.
 * The CLI used to hardcode loopback, so a parallel stack (stack-2..8) or a remote
 * CP was unreachable even though `scripts/lib/stack-ports.mjs` already exports
 * `XIHE_CP_URL`.
 */
export function resolveBaseUrl(env = {}, override) {
  const explicit = typeof override === 'string' ? override.trim() : '';
  if (explicit !== '') return absoluteHttpUrl(explicit, 'INVALID_BASE_URL');
  const fromEnv = typeof env.XIHE_CP_URL === 'string' ? env.XIHE_CP_URL.trim() : '';
  if (fromEnv !== '') return absoluteHttpUrl(fromEnv, 'INVALID_CP_URL');
  return loopbackFromPort(env);
}

export function getApiBase(env) {
  return resolveBaseUrl(env);
}

function isSafeConnectFailure(error) {
  const code = error?.cause?.code ?? error?.code;
  return [
    'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH',
    'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  ].includes(code);
}

function apiErrorCode(status, body, preserveServerCodes = false) {
  // PLAN-0575 T2.7: credential commands must keep the CP-provided code
  // (CREDENTIAL_REVEAL_STEP_UP_FAILED, CREDENTIAL_DISABLED, CREDENTIAL_TIER_MISMATCH,
  // CREDENTIAL_REVEAL_RATE_LIMITED, CREDENTIAL_IN_USE, CREDENTIAL_NOT_FOUND, ...)
  // distinguishable even on 401/403. Provider commands keep their frozen mapping.
  if (preserveServerCodes && typeof body?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(body.code)) {
    return body.code;
  }
  if (status === 401) return 'AUTHENTICATION_FAILED';
  if (status === 403) return 'ACCESS_DENIED';
  // PLAN-0574 I7: the server's own error code is passed through (e.g.
  // JOB_ARCHIVE_NOT_FOUND, WORKSPACE_NOT_FOUND) so idempotency and retry
  // semantics survive the CLI boundary. 401/403 keep their stable CLI codes.
  if (typeof body?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(body.code)) return body.code;
  if (status === 404) return 'NOT_FOUND';
  return `HTTP_${status}`;
}

// Only structural, non-free-text fields are ever copied out of a Problem Details
// body (PLAN-0574 I6): `detail` and any unknown keys are dropped.
export function safeProblemFields(body, fields = []) {
  const details = {};
  for (const field of fields) {
    const value = body?.[field];
    if (typeof value === 'number' && Number.isSafeInteger(value)) details[field] = value;
    else if (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)) details[field] = value;
  }
  return details;
}

async function fetchWithConnectRetry(url, { fetchImpl, method, headers, body, timeoutMs, path: pathLabel = url }) {
  let retriedBeforeSend = false;
  for (;;) {
    try {
      return await fetchImpl(url, {
        method,
        headers,
        body,
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
        { method, path: pathLabel },
      );
    }
  }
}

/**
 * PLAN-0643 R7: read a response body with a **byte** cap and stop the stream as soon
 * as the cap is crossed. An oversized or hostile response therefore never lands in
 * memory in full, and the truncation is reported instead of being silently sliced.
 * Returns `{ text, truncated }`; `truncated` means the CP body continued past the cap.
 */
export async function readResponseText(response, limitBytes) {
  const cap = Number.isFinite(limitBytes) && limitBytes > 0 ? Math.floor(limitBytes) : Number.MAX_SAFE_INTEGER;
  const body = response?.body;
  if (!body || typeof body.getReader !== 'function') {
    // Non-streaming implementation (or a Response stub in tests): bounded fallback.
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') <= cap) return { text, truncated: false };
    const sliced = Buffer.from(text, 'utf8').subarray(0, cap).toString('utf8').replace(/\uFFFD+$/u, '');
    return { text: sliced, truncated: true };
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buffer = Buffer.from(value);
      const remaining = cap - total;
      if (buffer.length > remaining) {
        if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(buffer);
      total += buffer.length;
      if (total === cap) {
        const next = await reader.read();
        truncated = !next.done;
        if (!next.done) await reader.cancel().catch(() => {});
        break;
      }
    }
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // the stream is already closed on the truncation path
    }
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  // A byte cap can split a multi-byte code point; drop the replacement character it
  // produces so the returned text never exceeds the cap in UTF-8 bytes.
  return { text: truncated ? raw.replace(/\uFFFD+$/u, '') : raw, truncated };
}

export async function requestJson(pathname, {
  apiBase,
  fetchImpl = fetch,
  method = 'GET',
  token,
  body,
  timeoutMs = CP_REQUEST_TIMEOUT_MS,
  problemFields = [],
  maxBytes = 1_000_000,
  headers: extraHeaders,
  preserveServerCodes = false,
}) {
  const headers = { Accept: 'application/json', ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetchWithConnectRetry(`${apiBase}${pathname}`, {
    fetchImpl,
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
    path: pathname,
  }).then(async (first) => {
    // PLAN-0643 R5: the 401-only refresh lives one level above fetch, so a refresh
    // failure surfaces as its own CLI error instead of being re-labelled CP_UNAVAILABLE
    // by the connect-retry classifier. 403/other statuses never reach this hook.
    if (first.status !== 401 || typeof fetchImpl?.authRefreshHook !== 'function') return first;
    const retried = await fetchImpl.authRefreshHook({
      url: `${apiBase}${pathname}`,
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
      fetchImpl,
    });
    return retried ?? first;
  });

  if (response.status === 204) return null;
  let text;
  let truncated = false;
  try {
    ({ text, truncated } = await readResponseText(response, maxBytes));
  } catch {
    if (method !== 'GET' && method !== 'HEAD') {
      throw new CliError('OPERATION_OUTCOME_UNKNOWN', 'CP accepted the request but its response could not be read.');
    }
    throw new CliError('CP_RESPONSE_INVALID', 'CP response could not be read.');
  }
  if (truncated) {
    throw new CliError(
      'CP_RESPONSE_TOO_LARGE',
      `CP response exceeded the CLI response limit (${maxBytes} bytes).`,
      { limitBytes: maxBytes, truncated: true, path: pathname },
    );
  }

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
    throw new CliError(apiErrorCode(response.status, parsed, preserveServerCodes), `CP request failed (HTTP ${response.status}).`, {
      status: response.status,
      requestId: typeof parsed?.requestId === 'string' ? parsed.requestId : undefined,
      // BL-396: only the rate-limit path needs the server's own pacing hint; every
      // other failure keeps the exact extra shape it had before.
      ...(response.status === 429
        ? { retryAfterMs: parseRetryAfterMs(response.headers?.get?.('retry-after')) }
        : {}),
      ...safeProblemFields(parsed, problemFields),
    });
  }
  return parsed;
}

// Text response variant for `GET /api/v1/config/export`, whose body is JSONC
// text (not guaranteed to be JSON.parse-able) and must never be parsed as JSON.
export async function requestText(pathname, {
  apiBase,
  fetchImpl = fetch,
  method = 'GET',
  token,
  timeoutMs = CP_REQUEST_TIMEOUT_MS,
  maxBytes = 8_000_000,
  problemFields = [],
}) {
  const headers = { Accept: 'application/json, text/plain' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetchWithConnectRetry(`${apiBase}${pathname}`, {
    fetchImpl,
    method,
    headers,
    timeoutMs,
    path: pathname,
  });

  let text;
  let truncated = false;
  try {
    ({ text, truncated } = await readResponseText(response, maxBytes));
  } catch {
    throw new CliError('CP_RESPONSE_INVALID', 'CP response could not be read.');
  }
  if (truncated) {
    throw new CliError(
      'CP_RESPONSE_TOO_LARGE',
      `CP response exceeded the CLI response limit (${maxBytes} bytes).`,
      { limitBytes: maxBytes, truncated: true, path: pathname },
    );
  }
  if (!response.ok) {
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* problem body is best-effort */ }
    throw new CliError(apiErrorCode(response.status, parsed), `CP request failed (HTTP ${response.status}).`, {
      status: response.status,
      requestId: typeof parsed?.requestId === 'string' ? parsed.requestId : undefined,
      ...safeProblemFields(parsed, problemFields),
    });
  }
  return {
    text,
    contentType: response.headers?.get?.('content-type') ?? null,
    cacheControl: response.headers?.get?.('cache-control') ?? null,
  };
}

// PLAN-0643 V23 (first-login contention): concurrent commands against the same
// CP identity share one in-flight login instead of racing N POSTs into the
// rate limiter. Keyed by apiBase + identifier so different accounts never
// converge; the entry clears on settle so a failed attempt is retryable.
// BL-396 adds the *cross-process* half: the in-process map only covers callers
// inside one CLI process, so five independent `xihe status` processes still sent
// five logins and CP's `login.account.max-concurrent:2` answered 429 to the
// overflow. `withLoginLock` (login-lock.mjs) serialises the POST across
// processes; waiters re-read the token store and reuse the winner's token.
const inflightLogins = new Map();

// BL-396: a login that actually lands on CP's rate limiter is retried a bounded
// number of times (server `Retry-After` when present, else a short backoff) before
// AUTH_RATE_LIMITED is reported as-is. Two retries keeps the worst case short
// (3 x 300 ms) while covering the normal "two winners arrived together" race.
const LOGIN_RATE_LIMIT_RETRIES = 2;
const LOGIN_RATE_LIMIT_BACKOFF_MS = 300;

function tokenCacheFailure(cached) {
  if (cached.kind === 'unsafe') {
    return new CliError(
      'TOKEN_FILE_UNSAFE',
      `${cached.path} is unsafe (${cached.reason}); fix the path or run \`xihe auth logout --force\`, then log in again.`,
    );
  }
  if (cached.kind === 'corrupt') {
    return new CliError(
      'TOKEN_FILE_CORRUPT',
      `${cached.path} is corrupt (${cached.reason}); run \`xihe auth logout --force\` to rebuild it, or set XIHE_TOKEN.`,
    );
  }
  return undefined;
}

/**
 * PLAN-0643 T1.2/T1.3 (design D16/D17, spec §5): credential precedence is
 * `XIHE_TOKEN` → cached access token for this base URL → TTY/env password login.
 * `forcePassword: true` skips both the cache read and the cache write, so
 * `xihe auth login` can own persistence and report ACL/write failures explicitly.
 * A corrupt or unsafe cache file is an explicit error — never a silent degrade.
 *
 * BL-396: the actual POST runs under a cross-process lock and is retried on 429;
 * `dependencies` injects fs/clock/sleep/liveness for tests (see login-lock.mjs).
 */
export async function login({ apiBase, fetchImpl, env, options = {}, promptSecret, forcePassword = false, dependencies = {} }) {
  const envToken = typeof env?.XIHE_TOKEN === 'string' ? env.XIHE_TOKEN.trim() : '';
  if (envToken !== '') return envToken;
  if (!forcePassword) {
    const cached = tokenEntryFor(env, apiBase);
    if (cached.kind === 'hit') return cached.token;
    const failure = tokenCacheFailure(cached);
    if (failure) throw failure;
  }
  const email = options['--email'] ?? 'admin@xihe.local';
  const key = `${apiBase}\u0000${email}`;
  const inflight = inflightLogins.get(key);
  if (inflight) return inflight;

  const sleep = typeof dependencies.sleep === 'function'
    ? dependencies.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const resolvePassword = async () => env.XIHE_DEV_ADMIN_PASSWORD || promptSecret('XH local admin password');

  const performLogin = async (password) => {
    const response = await requestLoginWithRetry({
      apiBase,
      fetchImpl,
      body: { identifier: email, password },
      sleep,
    });
    if (typeof response?.accessToken !== 'string' || response.accessToken.length === 0) {
      throw new CliError('AUTH_RESPONSE_INVALID', 'CP login response did not contain an access token.');
    }
    if (!forcePassword) {
      // Best effort: a cache that cannot be written must not break the command itself
      // (fail-closed = the token is simply not persisted). `xihe auth login` is strict.
      persistToken(env, { baseUrl: apiBase, token: response.accessToken, email: options['--email'] });
    }
    return response.accessToken;
  };

  // A fresh cache read taken while waiting for the lock: another process may have
  // finished its login and persisted the token, which is exactly the case where
  // this process must NOT log in a second time.
  const readFreshToken = () => {
    if (forcePassword || cacheDisabled(env)) return undefined;
    const fresh = tokenEntryFor(env, apiBase);
    if (fresh.kind === 'hit') return fresh.token;
    const failure = tokenCacheFailure(fresh);
    if (failure) throw failure;
    return undefined;
  };

  const attempt = (async () => {
    const password = await resolvePassword();
    // With the cache disabled there is no shared artifact to converge on, so the
    // lock would only serialise logins without saving any; keep the pre-BL-396 path.
    if (cacheDisabled(env)) return performLogin(password);
    const outcome = await withLoginLock({ env, ...dependencies, onWait: () => readFreshToken() }, async () => {
      const fresh = readFreshToken();
      if (fresh !== undefined) return fresh;
      return performLogin(password);
    });
    if (outcome.kind === 'reuse') return outcome.token;
    if (outcome.kind === 'run') return outcome.value;
    if (outcome.kind === 'unusable') {
      // The lock file cannot be created (missing/unwritable cache directory): fall
      // back to the single-process behaviour instead of failing the command.
      return performLogin(password);
    }
    throw new CliError(
      'AUTH_LOGIN_CONTENTION',
      `Waited ${outcome.waitedMs} ms for the cross-process login lock (${outcome.path}) without a usable token appearing; retry the command.`,
      { waitedMs: outcome.waitedMs, path: outcome.path },
      1,
    );
  })().finally(() => inflightLogins.delete(key));
  inflightLogins.set(key, attempt);
  return attempt;
}

/**
 * POST /api/v1/auth/login with a bounded 429 retry (BL-396). CP's throttle is a
 * concurrency cap (`login.account.max-concurrent:2`), so the honest failure mode
 * of a racing login is a 429 + `Retry-After`; retrying once the other login has
 * settled usually succeeds. A sustained 429 still surfaces as AUTH_RATE_LIMITED
 * (the original CliError, unchanged) — the CLI never swallows it.
 */
async function requestLoginWithRetry({ apiBase, fetchImpl, body, sleep }) {
  for (let attemptIndex = 0; ; attemptIndex += 1) {
    try {
      return await requestJson('/api/v1/auth/login', { apiBase, fetchImpl, method: 'POST', body });
    } catch (error) {
      const rateLimited = error instanceof CliError && error.code === 'AUTH_RATE_LIMITED';
      if (!rateLimited || attemptIndex >= LOGIN_RATE_LIMIT_RETRIES) throw error;
      const hint = Number(error.details?.retryAfterMs);
      // `Retry-After: 0` means "retry now"; a missing/unparseable hint uses the backoff.
      const delayMs = Number.isFinite(hint) ? Math.max(0, hint) : LOGIN_RATE_LIMIT_BACKOFF_MS;
      if (delayMs > 0) await sleep(Math.min(delayMs, MAX_RETRY_AFTER_MS));
    }
  }
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
    if (error.code === 'PROVIDER_CONNECTION_LABEL_CONFLICT') {
      throw new CliError(
        'PROVIDER_CONNECTION_LABEL_CONFLICT',
        'Another connection for this provider already uses this label; choose a different --label.',
        { field: 'label' },
      );
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
    if (error.code === 'PROVIDER_CONNECTION_LABEL_CONFLICT') {
      throw new CliError(
        'PROVIDER_CONNECTION_LABEL_CONFLICT',
        'Another connection for this provider already uses this label; choose a different --label.',
        { field: 'label' },
      );
    }
    // PLAN-0555: a 400 here is a rejected request (for example an invalid
    // label), not "CP accepted the update but returned an invalid view".
    if (error.status === 400 || error.code === 'PROVIDER_CONNECTION_INVALID') {
      throw new CliError(
        'PROVIDER_CONNECTION_UPDATE_REJECTED',
        'CP rejected the connection update; no change was applied. Check the field values and retry.',
      );
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

// PLAN-0574 T1.3: delete-impact first, explicit confirmation, then DELETE.
// Only structural fields are projected from the impact view so arbitrary CP
// internals never reach the terminal.
export function deleteImpactView(impact) {
  const view = {};
  for (const field of ['connectionId', 'providerId', 'connectionKey', 'bindingCount', 'profileCount', 'sessionCount', 'blocked']) {
    const value = impact?.[field];
    if (typeof value === 'string' && value.length <= 128) view[field] = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) view[field] = value;
    else if (typeof value === 'boolean') view[field] = value;
  }
  if (Array.isArray(impact?.bindingUserScopes)) view.bindingUserScopeCount = impact.bindingUserScopes.length;
  if (Array.isArray(impact?.profileScopes)) view.profileScopeCount = impact.profileScopes.length;
  return view;
}

export async function deleteProvider({
  apiBase,
  fetchImpl,
  token,
  id,
  yes = false,
  confirm = confirmAction,
  stdin,
  stderr = process.stderr,
  stdout = process.stdout,
  json = false,
}) {
  const impact = await requestJson(`/api/v1/provider-connections/${encodeURIComponent(id)}/delete-impact`, {
    apiBase,
    fetchImpl,
    token,
  });
  const view = deleteImpactView(impact);
  if (!json) {
    stdout.write(`Delete impact ${view.connectionId ?? id}: provider=${view.providerId ?? 'unknown'} `
      + `bindings=${view.bindingCount ?? 0} profiles=${view.profileCount ?? 0} `
      + `sessions=${view.sessionCount ?? 0} blocked=${view.blocked === true}\n`);
  }
  if (!yes) {
    await confirm({
      message: `Delete provider connection ${view.connectionId ?? id} `
        + `(bindings=${view.bindingCount ?? 0}, sessions=${view.sessionCount ?? 0})?`,
      stdin,
      output: stderr,
    });
  }
  try {
    await requestJson(`/api/v1/provider-connections/${encodeURIComponent(id)}`, {
      apiBase,
      fetchImpl,
      token,
      method: 'DELETE',
      problemFields: ['sessionCount', 'connectionId'],
    });
  } catch (error) {
    if (error.code === 'CONNECTION_IN_USE') {
      throw new CliError('CONNECTION_IN_USE', 'The provider connection is still referenced; nothing was deleted.', {
        status: error.details?.status,
        requestId: error.details?.requestId,
        sessionCount: error.details?.sessionCount,
        connectionId: error.details?.connectionId,
      });
    }
    throw error;
  }
  return { action: 'deleted', connectionId: id, impact: view };
}