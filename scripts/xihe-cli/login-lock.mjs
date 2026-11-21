import fs from 'node:fs';
import path from 'node:path';
import { pidIsAlive, resolveTokenPath } from './token-store.mjs';
// task-43：锁原语抽到 lib/file-lock.mjs（wx 独占 / staleness / pid 守卫 release），本文件只保留
// 「等待 + backoff + reuse」这层登录特有语义。落盘格式与 stale 判据逐字不变。
import {
  isLockStale,
  readLockHolder,
  releaseLock as releaseFileLock,
  tryCreateLock,
} from '../lib/file-lock.mjs';

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
  // 委托 lib/file-lock.mjs（task-43）：ENOENT⇒absent、不可读≠无人、ageMs 取 mtime 的语义不变。
  return readLockHolder(lockAbs, { fsImpl, now });
}

function tryCreate(lockAbs, { fsImpl, now }) {
  // 委托 lib/file-lock.mjs（task-43）：先 recursive 建目录（冷启动首登时缓存目录还不存在），
  // 再 `wx` 独占写 `{pid, acquiredAt}\n`（0o600）；EEXIST⇒held、其它⇒unusable 的分支不变。
  return tryCreateLock(lockAbs, {
    fsImpl,
    payload: { pid: process.pid, acquiredAt: new Date(now()).toISOString() },
  });
}

function isStale(holder, { staleMs, alive }) {
  // 委托 lib/file-lock.mjs（task-43）：不可读 / 无 pid ⇒ 看龄期，pid 已死 ⇒ 立即可接管。
  return isLockStale(holder, { staleMs, alive });
}

/** Remove the lock only when it still belongs to this process (never steal a live holder's). */
function releaseLock(lockAbs, { fsImpl }) {
  return releaseFileLock(lockAbs, { fsImpl, pid: process.pid });
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
