import fs from 'node:fs';
import path from 'node:path';
import { pidIsAlive, resolveTokenPath } from './token-store.mjs';

// BL-396 / PLAN-0643 V23: cross-process first-login single-flight.
//
// Five independent `xihe status` processes against a cold token cache used to send
// five POST /api/v1/auth/login requests at once; CP's
// `cp.auth.login.account.max-concurrent:2` (application.properties:55) answered
// 429 AUTH_RATE_LIMITED to the overflow (measured 3/5 exit 0). The lock turns
// "N racing logins" into "one login + N-1 cache re-reads": whoever wins logs in
// and persists the token, every other process polls the store and reuses it.
//
// Design (Lead-reviewed shape):
//   * The lock file lives next to the token store (same resolved directory, so it
//     inherits the same per-user boundary and there is exactly one lock per CP base
//     URL cache). The directory is created on demand — a cold first login has no
//     cache directory yet — and `persistToken` keeps owning the token-file ACL.
//   * Acquisition is an exclusive `wx` create — no platform file-lock API, still
//     zero dependencies.
//   * A stale lock is removed and retried: the holder pid is dead, or the file is
//     older than `staleMs` (covers pid reuse and a hard-killed holder).
//   * Waiting prefers re-reading the token store over sleeping: a peer that has
//     already persisted wins immediately, so a cold start costs one login per store
//     no matter how many processes wait.
//   * Every primitive is injectable (fs, clock, sleep, liveness) so tests never
//     gamble on real wall-clock timing.

export const LOGIN_LOCK_FILENAME = '.cli-token.login.lock';
export const DEFAULT_LOCK_BUDGET_MS = 30_000;
export const DEFAULT_LOCK_BACKOFF_MS = [50, 100, 200, 400];
export const DEFAULT_LOCK_STALE_MS = 60_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `<token-store-dir>/.cli-token.login.lock` — one lock per token-cache directory. */
export function loginLockPath(env = {}, platform = process.platform) {
  return path.join(path.dirname(resolveTokenPath(env, platform)), LOGIN_LOCK_FILENAME);
}

function readHolder(lockAbs, { fsImpl, now }) {
  let raw;
  try {
    raw = fsImpl.readFileSync(lockAbs, 'utf8');
  } catch (error) {
    // ENOENT = released between the failed create and this read; anything else is
    // unreadable and must not be treated as "no holder".
    if (error?.code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'holder', unreadable: true, pid: null, acquiredAt: null, ageMs: 0 };
  }
  let stats = null;
  try {
    stats = fsImpl.statSync(lockAbs);
  } catch {
    // Vanished between read and stat: report the best available view; the caller
    // retries the create immediately and will observe the truth then.
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A half-written or foreign lock body carries no pid; the mtime age is the
    // only staleness signal left, so keep it in the record.
  }
  const ageMs = stats ? now() - stats.mtimeMs : 0;
  return {
    kind: 'holder',
    pid: Number.isInteger(parsed?.pid) ? parsed.pid : null,
    acquiredAt: typeof parsed?.acquiredAt === 'string' ? parsed.acquiredAt : null,
    ageMs,
    unreadable: false,
  };
}

function tryCreate(lockAbs, { fsImpl, now }) {
  // Cold first login: the cache directory does not exist yet (persistToken only
  // creates it after a successful login), so the lock create would ENOENT and
  // every process would silently degrade to an unlocked login. Create the
  // directory first — `recursive` keeps concurrent creators idempotent.
  if (typeof fsImpl.mkdirSync === 'function') {
    try {
      fsImpl.mkdirSync(path.dirname(lockAbs), { recursive: true });
    } catch (error) {
      return { kind: 'unusable', path: lockAbs, reason: error?.code ?? 'unknown' };
    }
  }
  try {
    fsImpl.writeFileSync(lockAbs, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date(now()).toISOString() })}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    return { kind: 'acquired', path: lockAbs };
  } catch (error) {
    if (error?.code === 'EEXIST') return { kind: 'held', path: lockAbs };
    // The directory is missing/unwritable: the lock cannot arbitrate here, so the
    // caller degrades to the pre-BL-396 single-process path instead of failing.
    return { kind: 'unusable', path: lockAbs, reason: error?.code ?? 'unknown' };
  }
}

function isStale(holder, { staleMs, alive, now: _now }) {
  if (!holder || holder.kind !== 'holder') return false;
  if (holder.unreadable) return holder.ageMs > staleMs;
  if (holder.pid === null) return holder.ageMs > staleMs;
  if (!alive(holder.pid)) return true;
  return holder.ageMs > staleMs;
}

/** Remove the lock only when it still belongs to this process (never steal a live holder's). */
function releaseLock(lockAbs, { fsImpl }) {
  let holder;
  try {
    holder = JSON.parse(fsImpl.readFileSync(lockAbs, 'utf8'));
  } catch (error) {
    // ENOENT: already released or swept by another process — nothing to do.
    // Unparseable: it is not ours to delete; the stale check retires it.
    if (error?.code === 'ENOENT') return false;
    return false;
  }
  if (holder?.pid !== process.pid) return false;
  try {
    fsImpl.rmSync(lockAbs, { force: true });
    return true;
  } catch {
    // A live holder sweeping a dead lock can race this remove on Windows; the
    // caller is exiting and the stale check covers the leftover.
    return false;
  }
}

/**
 * Acquire the cross-process login lock.
 *
 * Returns:
 *   `{kind:'acquired', path, waitCount, clearedStale, release()}` — caller must
 *   `release()` in a `finally` (hard kills are covered by the stale check).
 *   `{kind:'reuse', token, waitCount, clearedStale}` — a peer persisted a valid
 *   token while we waited; never logs in.
 *   `{kind:'timeout', waitCount, clearedStale, holder}` — budget exhausted with no
 *   token; the caller must fail explicitly instead of racing a login.
 *   `{kind:'unusable', reason}` — lock file cannot be created here (missing or
 *   unwritable cache directory); degrade to the single-process path.
 */
export async function acquireLoginLock({
  env = {},
  platform = process.platform,
  fsImpl = fs,
  now = Date.now,
  sleep = defaultSleep,
  alive = pidIsAlive,
  budgetMs = DEFAULT_LOCK_BUDGET_MS,
  backoffMs = DEFAULT_LOCK_BACKOFF_MS,
  staleMs = DEFAULT_LOCK_STALE_MS,
  onWait,
} = {}) {
  const lockAbs = loginLockPath(env, platform);
  const startedAt = now();
  const deadline = startedAt + budgetMs;
  let waitCount = 0;
  let clearedStale = 0;
  for (;;) {
    const attempt = tryCreate(lockAbs, { fsImpl, now });
    if (attempt.kind === 'acquired') {
      return {
        kind: 'acquired',
        path: lockAbs,
        waitCount,
        clearedStale,
        waitedMs: now() - startedAt,
        release: () => releaseLock(lockAbs, { fsImpl }),
      };
    }
    if (attempt.kind === 'unusable') return { ...attempt, waitedMs: now() - startedAt };

    const holder = readHolder(lockAbs, { fsImpl, now });
    if (isStale(holder, { staleMs, alive })) {
      try {
        fsImpl.rmSync(lockAbs, { force: true });
      } catch {
        // Another waiter swept it first; the next create attempt tells the truth.
      }
      clearedStale += 1;
      continue;
    }
    if (typeof onWait === 'function') {
      const token = await onWait({ waitCount, clearedStale, waitedMs: now() - startedAt });
      if (token !== undefined) {
        return { kind: 'reuse', token, waitCount, clearedStale, waitedMs: now() - startedAt };
      }
    }
    const elapsed = now() - startedAt;
    if (elapsed >= budgetMs) {
      return { kind: 'timeout', path: lockAbs, waitCount, clearedStale, waitedMs: elapsed, holder };
    }
    const step = backoffMs[Math.min(waitCount, backoffMs.length - 1)];
    await sleep(Math.min(step, Math.max(1, deadline - now())));
    waitCount += 1;
  }
}

/**
 * Run `fn` under the cross-process login lock.
 *
 * The caller gets `{kind:'run', value}` when `fn` ran while holding the lock,
 * `{kind:'reuse'|'timeout'|'unusable', ...}` otherwise. `release()` always runs on
 * the acquired path, including when `fn` throws.
 */
export async function withLoginLock(deps, fn) {
  const lock = await acquireLoginLock(deps);
  if (lock.kind !== 'acquired') return lock;
  try {
    const value = await fn();
    return { kind: 'run', value, waitCount: lock.waitCount, clearedStale: lock.clearedStale, waitedMs: lock.waitedMs };
  } finally {
    lock.release();
  }
}
