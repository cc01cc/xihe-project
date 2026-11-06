import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// PLAN-0643 T1.2–T1.5 (design D11–D18, spec/cli-contract.md §5): the CLI token cache.
// Access token only (never a refresh token), one entry per CP base URL, written
// tmp+rename with the ACL tightened *before* the file becomes visible, and every
// failure returned as an explicit code instead of a silent degrade.

export const TOKEN_CACHE_DISABLED_ENV = 'XIHE_CLI_TOKEN_CACHE';
export const TOKEN_FILE_ENV = 'XIHE_CLI_TOKEN_FILE';
export const TOKEN_ENV = 'XIHE_TOKEN';
const FILE_VERSION = 1;
const EXPIRY_SKEW_MS = 30_000;
const ACL_ENTRY_ALLOWLIST = /^(BUILTIN\\Users|Everyone|NT AUTHORITY\\Authenticated Users)$/i;

export function cacheDisabled(env = {}) {
  return String(env[TOKEN_CACHE_DISABLED_ENV] ?? '').trim().toLowerCase() === 'off';
}

/** Windows `%LOCALAPPDATA%\Xihe\cli-token.json` (same root the launcher uses); `~/.xihe/cli-token.json` elsewhere. */
export function resolveTokenPath(env = {}, platform = process.platform) {
  const override = typeof env[TOKEN_FILE_ENV] === 'string' ? env[TOKEN_FILE_ENV].trim() : '';
  if (override !== '') return path.resolve(override);
  if (platform === 'win32') {
    const localAppData = String(env.LOCALAPPDATA ?? '').trim() || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Xihe', 'cli-token.json');
  }
  return path.join(os.homedir(), '.xihe', 'cli-token.json');
}

export function normalizeBaseUrl(baseUrl) {
  return String(baseUrl ?? '').trim().replace(/\/+$/, '');
}

const TEMP_FILE_PATTERN = /^\.cli-token\.(\d+)\.(\d+)\.tmp$/;
// A temp file older than this is garbage even if its pid was reused by an unrelated
// process: persist() keeps the temp alive for milliseconds, never for an hour.
const STALE_TEMP_MS = 60 * 60 * 1000;

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user: still alive, keep its temp.
    if (error?.code === 'EPERM') return true;
    return false;
  }
}

/**
 * Remove `.cli-token.<pid>.<ts>.tmp` files that can never become the store: their writer
 * was SIGKILLed mid-write (`persist` renames or removes it on every handled path, only a
 * hard kill leaks one) or their pid was recycled. A live writer's temp is never touched —
 * deleting it would race the rename — and only this exact pattern in the store directory
 * is considered (PLAN-0643 V24).
 */
export function sweepStaleTemps(env = {}, { fsImpl = fs, platform = process.platform, now = Date.now(), staleMs = STALE_TEMP_MS, alive = pidIsAlive } = {}) {
  const directory = path.dirname(resolveTokenPath(env, platform));
  if (typeof fsImpl?.readdirSync !== 'function') return { swept: [], directory };
  let names;
  try {
    names = fsImpl.readdirSync(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return { swept: [], directory };
    return { swept: [], directory, reason: `cannot list (${error?.code ?? 'unknown'})` };
  }
  const swept = [];
  for (const name of names) {
    const match = TEMP_FILE_PATTERN.exec(name);
    if (!match) continue;
    const filePath = path.join(directory, name);
    let ageMs = 0;
    if (alive(Number(match[1]))) {
      let stats;
      try {
        stats = fsImpl.statSync(filePath);
      } catch {
        continue; // vanished between readdir and stat: someone else cleaned it
      }
      ageMs = now - stats.mtimeMs;
      if (ageMs <= staleMs) continue;
    }
    try {
      fsImpl.rmSync(filePath, { force: true });
      swept.push({ name, ageMs });
    } catch {
      // best effort: another process may have renamed/removed it first
    }
  }
  return { swept, directory };
}

export function expiresAtFromToken(token, now = Date.now()) {
  const parts = String(token ?? '').split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (Number.isFinite(payload?.exp)) return new Date(payload.exp * 1000).toISOString();
    } catch {
      // Not a JWT (or an opaque token): fall back to the documented access-token lifetime.
    }
  }
  return new Date(now + 900_000).toISOString();
}

function emptyStore() {
  return { version: FILE_VERSION, tokens: {} };
}

function parseStore(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'corrupt', reason: 'invalid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'corrupt', reason: 'not an object' };
  if (parsed.version !== FILE_VERSION) return { kind: 'corrupt', reason: `unsupported version ${String(parsed.version)}` };
  if (!parsed.tokens || typeof parsed.tokens !== 'object' || Array.isArray(parsed.tokens)) {
    return { kind: 'corrupt', reason: 'tokens is not an object' };
  }
  for (const [baseUrl, entry] of Object.entries(parsed.tokens)) {
    if (!entry || typeof entry !== 'object' || typeof entry.token !== 'string' || entry.token === '') {
      return { kind: 'corrupt', reason: `entry ${baseUrl} has no token` };
    }
  }
  return { kind: 'ok', store: parsed };
}

/** Inspect the cache without mutating it. `unsafe` means the path is a directory/symlink/junction. */
export function readStore(env = {}, { fsImpl = fs, platform = process.platform } = {}) {
  const filePath = resolveTokenPath(env, platform);
  // Leaked temps from a killed writer are removed on the next load; a live writer's temp
  // is protected by pidIsAlive, so this cannot race an in-flight persist (V24).
  sweepStaleTemps(env, { fsImpl, platform });
  let stats;
  try {
    stats = fsImpl.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'absent', path: filePath };
    return { kind: 'unsafe', path: filePath, reason: `cannot stat (${error?.code ?? 'unknown'})` };
  }
  if (stats.isSymbolicLink()) return { kind: 'unsafe', path: filePath, reason: 'path is a symlink' };
  if (stats.isDirectory()) return { kind: 'unsafe', path: filePath, reason: 'path is a directory' };
  let text;
  try {
    text = fsImpl.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { kind: 'unsafe', path: filePath, reason: `cannot read (${error?.code ?? 'unknown'})` };
  }
  const parsed = parseStore(text);
  if (parsed.kind === 'corrupt') return { kind: 'corrupt', path: filePath, reason: parsed.reason };
  return { kind: 'ok', path: filePath, store: parsed.store };
}

export function tokenEntryFor(env = {}, baseUrl, { fsImpl = fs, platform = process.platform, now = Date.now() } = {}) {
  if (cacheDisabled(env)) return { kind: 'disabled' };
  const state = readStore(env, { fsImpl, platform });
  if (state.kind !== 'ok') return state;
  const entry = state.store.tokens[normalizeBaseUrl(baseUrl)];
  if (!entry) return { kind: 'absent', path: state.path };
  const expiresAt = typeof entry.expiresAt === 'string' ? Date.parse(entry.expiresAt) : Number.NaN;
  if (Number.isFinite(expiresAt) && expiresAt - EXPIRY_SKEW_MS <= now) {
    return { kind: 'expired', path: state.path, expiresAt: entry.expiresAt };
  }
  return { kind: 'hit', path: state.path, token: entry.token, email: entry.email, expiresAt: entry.expiresAt };
}

function runIcacls(filePath) {
  const grantee = currentUserGrantee();
  if (grantee === null) {
    return { ok: false, code: 'TOKEN_ACL_UNAVAILABLE', message: 'Cannot resolve the current Windows user; the token was not written (set XIHE_TOKEN instead).' };
  }
  const result = spawnSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${grantee}:(F)`], { windowsHide: true });
  if (result.error) {
    return { ok: false, code: 'TOKEN_ACL_UNAVAILABLE', message: 'icacls is unavailable; the token was not written (set XIHE_TOKEN instead).' };
  }
  if (result.status !== 0) {
    return { ok: false, code: 'TOKEN_ACL_FAILED', message: 'icacls could not tighten the token file ACL; the token was not written.' };
  }
  return { ok: true };
}

let cachedGrantee;
/**
 * Windows ACL grantee. A bare `%USERNAME%:F` silently produces a malformed ACE
 * (`ZEONEO\:(F)`) on some hosts, which then makes the tmp→final rename fail with
 * EPERM — so resolve the account SID (`*S-1-5-21-…`) and fall back to DOMAIN\user.
 */
function currentUserGrantee() {
  if (cachedGrantee !== undefined) return cachedGrantee;
  const whoami = spawnSync('whoami', ['/user'], { windowsHide: true, encoding: 'utf8' });
  if (!whoami.error && whoami.status === 0) {
    const match = String(whoami.stdout ?? '').match(/(S-1-[\d-]+)\s*$/m);
    if (match) {
      cachedGrantee = `*${match[1]}`;
      return cachedGrantee;
    }
  }
  const user = String(process.env.USERNAME ?? '').trim();
  const domain = String(process.env.USERDOMAIN ?? '').trim();
  if (user === '') {
    cachedGrantee = null;
  } else {
    cachedGrantee = domain === '' ? user : `${domain}\\${user}`;
  }
  return cachedGrantee;
}

function defaultAclRunner(filePath, platform) {
  if (platform === 'win32') return runIcacls(filePath);
  try {
    fs.chmodSync(filePath, 0o600);
    return { ok: true };
  } catch {
    return { ok: false, code: 'TOKEN_ACL_FAILED', message: 'Could not set 0600 on the token file; the token was not written.' };
  }
}

function writeStoreAtomic({ env, store, fsImpl, platform, aclRunner }) {
  const filePath = resolveTokenPath(env, platform);
  const directory = path.dirname(filePath);
  try {
    fsImpl.mkdirSync(directory, { recursive: true });
  } catch (error) {
    return { ok: false, code: 'TOKEN_FILE_UNWRITABLE', message: `Cannot create ${directory} (${error?.code ?? 'unknown'}).` };
  }
  try {
    const stats = fsImpl.lstatSync(filePath);
    if (stats.isDirectory()) return { ok: false, code: 'TOKEN_FILE_UNSAFE', message: `${filePath} is a directory; refusing to write the token cache.` };
    if (stats.isSymbolicLink()) return { ok: false, code: 'TOKEN_FILE_UNSAFE', message: `${filePath} is a symlink; refusing to write the token cache.` };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { ok: false, code: 'TOKEN_FILE_UNSAFE', message: `Cannot inspect ${filePath} (${error?.code ?? 'unknown'}).` };
    }
  }
  const tempPath = path.join(directory, `.cli-token.${process.pid}.${Date.now()}.tmp`);
  try {
    fsImpl.writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    return { ok: false, code: 'TOKEN_FILE_UNWRITABLE', message: `Cannot write ${tempPath} (${error?.code ?? 'unknown'}).` };
  }
  const acl = (aclRunner ?? ((file) => defaultAclRunner(file, platform)))(tempPath);
  if (!acl.ok) {
    try {
      fsImpl.rmSync?.(tempPath, { force: true });
    } catch {
      // best effort: the temp file is never the canonical path
    }
    return acl;
  }
  try {
    const handle = fsImpl.openSync(tempPath, 'r+');
    try {
      fsImpl.fsyncSync(handle);
    } finally {
      fsImpl.closeSync(handle);
    }
  } catch {
    // fsync is a durability nicety; the rename below is the atomicity guarantee
  }
  try {
    fsImpl.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fsImpl.rmSync?.(tempPath, { force: true });
    } catch {
      // best effort
    }
    return { ok: false, code: 'TOKEN_FILE_UNWRITABLE', message: `Cannot replace ${filePath} (${error?.code ?? 'unknown'}).` };
  }
  return { ok: true, path: filePath };
}

/**
 * Upsert one base-URL entry. Last writer wins (tmp+rename is atomic, so concurrent
 * writers never leave a half-written file; the surviving entry is the last rename).
 */
export function persistToken(env = {}, { baseUrl, token, email, expiresAt, obtainedAt, fsImpl = fs, platform = process.platform, aclRunner, now = Date.now() } = {}) {
  if (cacheDisabled(env)) return { ok: false, code: 'TOKEN_CACHE_DISABLED', message: 'The token cache is disabled by XIHE_CLI_TOKEN_CACHE=off.' };
  if (typeof token !== 'string' || token === '') {
    return { ok: false, code: 'TOKEN_FILE_UNWRITABLE', message: 'Refusing to cache an empty token.' };
  }
  const current = readStore(env, { fsImpl, platform });
  if (current.kind === 'unsafe' || current.kind === 'corrupt') {
    return {
      ok: false,
      code: current.kind === 'unsafe' ? 'TOKEN_FILE_UNSAFE' : 'TOKEN_FILE_CORRUPT',
      message: current.kind === 'unsafe'
        ? `${current.path} is unsafe (${current.reason}); fix the path or run \`xihe auth logout --force\`.`
        : `${current.path} is corrupt (${current.reason}); run \`xihe auth logout --force\` to rebuild it.`,
    };
  }
  const store = current.kind === 'ok' ? current.store : emptyStore();
  store.tokens[normalizeBaseUrl(baseUrl)] = {
    token,
    email: email ?? null,
    expiresAt: expiresAt ?? expiresAtFromToken(token, now),
    obtainedAt: obtainedAt ?? new Date(now).toISOString(),
  };
  return writeStoreAtomic({ env, store, fsImpl, platform, aclRunner });
}

export function clearToken(env = {}, { baseUrl, fsImpl = fs, platform = process.platform, aclRunner } = {}) {
  if (cacheDisabled(env)) return { ok: true, removed: false, path: resolveTokenPath(env, platform) };
  const current = readStore(env, { fsImpl, platform });
  if (current.kind === 'absent') return { ok: true, removed: false, path: current.path };
  if (current.kind !== 'ok') {
    // Explicit logout must still succeed on a corrupt/unsafe path: remove what we own.
    try {
      fsImpl.rmSync?.(current.path, { force: true, recursive: false });
      return { ok: true, removed: true, path: current.path, repaired: true };
    } catch (error) {
      return { ok: false, code: 'TOKEN_FILE_UNWRITABLE', message: `Cannot remove ${current.path} (${error?.code ?? 'unknown'}).` };
    }
  }
  delete current.store.tokens[normalizeBaseUrl(baseUrl)];
  if (Object.keys(current.store.tokens).length === 0) {
    try {
      fsImpl.rmSync?.(current.path, { force: true });
      return { ok: true, removed: true, path: current.path, fileDeleted: true };
    } catch (error) {
      return { ok: false, code: 'TOKEN_FILE_UNWRITABLE', message: `Cannot remove ${current.path} (${error?.code ?? 'unknown'}).` };
    }
  }
  // R2 (PLAN-0643 audit 2026-11-04): a partial logout rewrites the file for the
  // *remaining* base URLs, so it must tighten the new file exactly like a login does.
  // Passing a no-op ACL runner here silently downgraded the file to the inherited
  // directory ACL — the token of every other stack then became readable by any
  // account that inherits it.
  const written = writeStoreAtomic({ env, store: current.store, fsImpl, platform, aclRunner });
  return written.ok ? { ok: true, removed: true, path: written.path } : written;
}

function aclDescription(filePath, platform = process.platform) {
  if (platform !== 'win32') return { checked: true, tightened: true, detail: 'posix mode 0600 is enforced by the writer' };
  const result = spawnSync('icacls', [filePath], { windowsHide: true });
  if (result.error || result.status !== 0) {
    return { checked: false, tightened: null, detail: 'icacls is unavailable; the ACL could not be verified' };
  }
  const entries = String(result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /:\(/.test(line))
    .map((line) => line.split(':')[0].trim());
  const loose = entries.filter((entry) => ACL_ENTRY_ALLOWLIST.test(entry));
  return loose.length === 0
    ? { checked: true, tightened: true, detail: `only explicit principals (${entries.length})` }
    : { checked: true, tightened: false, detail: `inherited/broad entries present: ${loose.join(', ')}` };
}

/** Metadata-only view for `xihe auth status`; the token value never leaves this module. */
export function describeToken(env = {}, baseUrl, { fsImpl = fs, platform = process.platform, now = Date.now() } = {}) {
  const envToken = typeof env[TOKEN_ENV] === 'string' ? env[TOKEN_ENV].trim() : '';
  const state = readStore(env, { fsImpl, platform });
  const entry = state.kind === 'ok' ? state.store.tokens[normalizeBaseUrl(baseUrl)] : undefined;
  const expiresAtMs = entry ? Date.parse(entry.expiresAt) : Number.NaN;
  return {
    source: envToken !== '' ? 'env' : entry ? 'cache' : 'none',
    cacheDisabled: cacheDisabled(env),
    path: state.path,
    fileState: state.kind === 'ok' ? 'ok' : state.kind,
    reason: state.reason,
    hasToken: envToken !== '' || Boolean(entry),
    charCount: entry ? entry.token.length : (envToken.length || 0),
    email: entry?.email ?? null,
    expiresAt: entry?.expiresAt ?? null,
    obtainedAt: entry?.obtainedAt ?? null,
    expired: Number.isFinite(expiresAtMs) ? expiresAtMs - EXPIRY_SKEW_MS <= now : null,
    acl: state.kind === 'ok' ? aclDescription(state.path, platform) : { checked: false, tightened: null, detail: 'no token file' },
  };
}
