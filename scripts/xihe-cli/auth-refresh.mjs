import fs from 'node:fs';

import { CliError, getApiBase, requestJson } from './provider.mjs';
import { cacheDisabled, persistToken, resolveTokenPath, tokenEntryFor } from './token-store.mjs';

// PLAN-0643 R5 (2026-11-04 audit): ordinary commands used to fail forever once the
// cached access token was revoked/expired — nothing cleared it and nothing re-logged
// in, so a scripted burst hit the CP login limiter (5 failures / 900 s, concurrency 2)
// and locked the account. This module adds a 401-only, single-flight refresh:
//
//   * 401 from a cached token  → exactly one refresher (cross-process file lock),
//                               everybody else waits and reuses the new token.
//   * 403 / other statuses     → untouched: no cache mutation, no retry.
//   * no interactive credential→ the original 401 is returned (AUTHENTICATION_FAILED),
//                               never an automatic XIHE_DEV_ADMIN_PASSWORD login (B7).
//   * refresh attempted & failed → AUTH_REFRESH_FAILED, the old cache entry is kept.
//
// The wrapper only ever touches requests to the configured CP origin; a 401 from a
// provider/third-party host must never cause the CP token to be sent there.

const REFRESH_LOCK_SUFFIX = '.lock';
const REFRESH_ERROR_SUFFIX = '.error';
const DEFAULT_WAIT_MS = 20_000;
const DEFAULT_POLL_MS = 50;
const LOCK_STALE_MS = 60_000;
const LOGIN_PATH = '/api/v1/auth/login';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isLoginUrl(url) {
  try {
    return new URL(String(url)).pathname === LOGIN_PATH;
  } catch {
    return false;
  }
}

function bearerOf(headers) {
  if (!headers) return null;
  let value;
  if (typeof headers.get === 'function') value = headers.get('authorization');
  else value = headers.Authorization ?? headers.authorization;
  if (typeof value !== 'string') return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function withBearer(headers, token) {
  const next = {};
  if (typeof headers?.forEach === 'function') {
    headers.forEach((value, key) => {
      next[key] = value;
    });
  } else if (headers) {
    Object.assign(next, headers);
  }
  next.Authorization = `Bearer ${token}`;
  return next;
}

function lockPaths(env, fsImpl, platform) {
  const base = resolveTokenPath(env, platform);
  return {
    lock: `${base}${REFRESH_LOCK_SUFFIX}`,
    error: `${base}${REFRESH_LOCK_SUFFIX}${REFRESH_ERROR_SUFFIX}`,
  };
}

function tryAcquire(file, fsImpl) {
  try {
    fsImpl.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}

function removeQuietly(file, fsImpl) {
  try {
    fsImpl.rmSync?.(file, { force: true });
  } catch {
    // best effort: a stale lock is reclaimed by age below
  }
}

function lockIsStale(file, fsImpl) {
  try {
    return Date.now() - fsImpl.statSync(file).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function readRefreshError(file, fsImpl) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    if (Date.now() - Date.parse(parsed?.at ?? '') > LOCK_STALE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function freshToken(env, baseUrl, staleToken, opts) {
  const entry = tokenEntryFor(env, baseUrl, opts);
  if (entry.kind !== 'hit') return null;
  return entry.token !== staleToken ? entry.token : null;
}

/**
 * Ask the user for the admin password and log in again (refresh path only).
 * It never consults XIHE_DEV_ADMIN_PASSWORD: an unattended process must not silently
 * replay a credential that came from the repo's `.env` chain (B7 ruling direction).
 */
async function loginAgain({ baseUrl, env, fetchImpl, promptSecret, fsImpl, platform, now }) {
  let password;
  try {
    password = await promptSecret('XH local admin password');
  } catch {
    return { status: 'required' };
  }
  if (typeof password !== 'string' || password === '') return { status: 'required' };
  const entry = tokenEntryFor(env, baseUrl, { fsImpl, platform, now });
  const identifier = entry?.email ?? 'admin@xihe.local';
  let response;
  try {
    response = await requestJson(LOGIN_PATH, {
      apiBase: baseUrl,
      fetchImpl,
      method: 'POST',
      body: { identifier, password },
    });
  } catch (error) {
    throw new CliError(
      'AUTH_REFRESH_FAILED',
      `The cached token was rejected and re-login failed: ${error?.message ?? 'unknown error'}. The cache was left untouched.`,
      { status: 401, cause: error?.code ?? null, refresh: 'failed' },
    );
  }
  if (typeof response?.accessToken !== 'string' || response.accessToken === '') {
    throw new CliError('AUTH_REFRESH_FAILED', 'CP login response did not contain an access token; the cache was left untouched.', {
      status: 401,
      refresh: 'failed',
    });
  }
  const persisted = persistToken(env, { baseUrl, token: response.accessToken, email: entry?.email ?? null, fsImpl, platform, now });
  if (!persisted.ok) throw new CliError(persisted.code, persisted.message, { status: 401, refresh: 'failed' });
  return { status: 'refreshed', token: response.accessToken };
}

/**
 * Single-flight refresh for one base URL. Cross-process: the first caller takes a
 * file lock, logs in and rewrites the cache; the others poll the cache and reuse the
 * result instead of each triggering a login (the CP login limiter is the real limit).
 */
export async function refreshTokenOnce({
  baseUrl,
  env,
  fetchImpl,
  promptSecret,
  staleToken,
  fsImpl = fs,
  platform = process.platform,
  now = Date.now,
  waitMs = DEFAULT_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
}) {
  const nowMs = typeof now === 'function' ? now() : now;
  const opts = { fsImpl, platform, now: nowMs };
  // No cache means there is nothing to refresh and no place to coordinate through;
  // hand the original 401 back to the caller (it still maps to AUTHENTICATION_FAILED).
  if (cacheDisabled(env)) return { status: 'required' };
  const immediate = freshToken(env, baseUrl, staleToken, opts);
  if (immediate) return { status: 'refreshed', token: immediate };
  const paths = lockPaths(env, fsImpl, platform);
  removeQuietly(paths.error, fsImpl);
  const deadline = Date.now() + waitMs;
  let sawLock = false;
  while (Date.now() <= deadline) {
    if (tryAcquire(paths.lock, fsImpl)) {
      try {
        const raced = freshToken(env, baseUrl, staleToken, opts);
        if (raced) return { status: 'refreshed', token: raced };
        const result = await loginAgain({ baseUrl, env, fetchImpl, promptSecret, fsImpl, platform, now: nowMs });
        if (result.status === 'required') return result;
        removeQuietly(paths.error, fsImpl);
        return result;
      } catch (error) {
        try {
          fsImpl.writeFileSync(paths.error, JSON.stringify({ code: error?.code ?? 'AUTH_REFRESH_FAILED', message: error?.message ?? '', at: new Date().toISOString() }), { mode: 0o600 });
        } catch {
          // the marker is an optimisation for the waiters; the error itself still propagates
        }
        throw error;
      } finally {
        removeQuietly(paths.lock, fsImpl);
      }
    }
    sawLock = true;
    if (lockIsStale(paths.lock, fsImpl)) {
      removeQuietly(paths.lock, fsImpl);
      continue;
    }
    const refreshed = freshToken(env, baseUrl, staleToken, opts);
    if (refreshed) return { status: 'refreshed', token: refreshed };
    await sleep(pollMs);
  }
  if (sawLock) {
    const failure = readRefreshError(paths.error, fsImpl);
    if (failure) {
      throw new CliError('AUTH_REFRESH_FAILED', failure.message || 'Another CLI process failed to refresh the token.', {
        status: 401,
        refresh: 'failed',
        cause: failure.code,
      });
    }
    return { status: 'required' };
  }
  throw new CliError('AUTH_REFRESH_TIMEOUT', 'Timed out waiting for another CLI process to refresh the cached token; run `xihe auth login`.', {
    status: 401,
    refresh: 'timeout',
  });
}

/**
 * Attach the 401 refresh hook to the fetch implementation handed to requestJson.
 * `requestJson` calls it after a 401 (above the connect-retry classifier), so a
 * refresh failure keeps its own AUTH_REFRESH_* code instead of becoming CP_UNAVAILABLE.
 * 403 and non-CP origins are never retried, and the CP token is never replayed to a
 * provider/third-party host.
 */
export function attachAuthRefresh({
  fetchImpl = fetch,
  env = {},
  promptSecret,
  fsImpl = fs,
  platform = process.platform,
  now = Date.now,
  waitMs = DEFAULT_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  let cpOrigin;
  const resolveCpOrigin = () => {
    if (cpOrigin !== undefined) return cpOrigin;
    try {
      cpOrigin = new URL(getApiBase(env)).origin;
    } catch {
      cpOrigin = null;
    }
    return cpOrigin;
  };
  const wrapped = (url, init = {}) => fetchImpl(url, init);
  wrapped.authRefreshHook = async ({ url, method, headers, body, timeoutMs }) => {
    const origin = resolveCpOrigin();
    if (!origin || isLoginUrl(url)) return null;
    let requestOrigin;
    try {
      requestOrigin = new URL(String(url)).origin;
    } catch {
      return null;
    }
    if (requestOrigin !== origin) return null;
    const staleToken = bearerOf(headers);
    if (!staleToken) return null;
    const refreshed = await refreshTokenOnce({
      baseUrl: origin,
      env,
      fetchImpl,
      promptSecret,
      staleToken,
      fsImpl,
      platform,
      now,
      waitMs,
      pollMs,
    });
    if (refreshed.status !== 'refreshed') return null;
    return fetchImpl(url, {
      method,
      headers: withBearer(headers, refreshed.token),
      body,
      signal: AbortSignal.timeout(timeoutMs ?? 10_000),
    });
  };
  return wrapped;
}

export { DEFAULT_POLL_MS, DEFAULT_WAIT_MS, LOGIN_PATH };
