import fs from 'node:fs';
import path from 'node:path';

// task-43: 从 `scripts/xihe-cli/login-lock.mjs`（BL-396）抽出的**通用文件锁原语**。
//
// 为什么抽：登录锁那套 `wx` 独占 + staleness（pid 死 / 超龄）+ **pid 守卫的 release** 已被
// `scripts/xihe-cli.test.mjs` 钉住；测试锁（`cp-test-run.mjs`）需要同一套语义但生命周期不同
// （fail-fast、不排队、锁在 target 目录内）。复制一份等于允许两套锁语义各自漂移。
//
// 边界：这里只放**与业务无关的原语**。登录锁的等待/backoff/reuse 逻辑留在 login-lock.mjs
// 自己手里（`acquireLoginLock` 的对外语义一点不改）。
//
// 抽取条件（Lead 裁定）：login-lock 侧 diff 必须是纯委托 —— 落盘格式、字段名、stale 判据
// 都逐字保持，不许出现新的语义分支。

/**
 * 读锁持有者。ENOENT = 无人持有；其它读取错误 = 持有者不可读（**不能**当成「没人」）。
 * @returns {{kind:'absent'} | {kind:'holder', pid:number|null, acquiredAt:string|null, ageMs:number, unreadable:boolean, payload:object|null}}
 */
export function readLockHolder(lockAbs, { fsImpl = fs, now = Date.now } = {}) {
  let raw;
  try {
    raw = fsImpl.readFileSync(lockAbs, 'utf8');
  } catch (error) {
    // ENOENT：在「创建失败」与「读」之间已被释放；其它错误不可读，不能当成「无持有者」。
    if (error?.code === 'ENOENT') return { kind: 'absent' };
    return {
      kind: 'holder',
      unreadable: true,
      pid: null,
      acquiredAt: null,
      ageMs: 0,
      payload: null,
    };
  }
  let stats = null;
  try {
    stats = fsImpl.statSync(lockAbs);
  } catch {
    // 读与 stat 之间消失：如实返回可用视图，调用方重试 create 时看到的是真相。
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 半写或外来锁体没有 pid；mtime 年龄是唯一还剩的 staleness 信号，保留在记录里。
  }
  const ageMs = stats ? now() - stats.mtimeMs : 0;
  return {
    kind: 'holder',
    pid: Number.isInteger(parsed?.pid) ? parsed.pid : null,
    acquiredAt: typeof parsed?.acquiredAt === 'string' ? parsed.acquiredAt : null,
    ageMs,
    unreadable: false,
    payload: parsed && typeof parsed === 'object' ? parsed : null,
  };
}

/**
 * 独占创建锁文件（`wx`，无平台文件锁 API，零依赖）。
 * @returns {{kind:'acquired', path:string} | {kind:'held', path:string} | {kind:'unusable', path:string, reason:string}}
 */
export function tryCreateLock(lockAbs, { fsImpl = fs, payload = {} } = {}) {
  // 冷启动时目录可能还不存在（target/ 要等 mvn 第一次构建），先建目录；recursive 让并发创建幂等。
  if (typeof fsImpl.mkdirSync === 'function') {
    try {
      fsImpl.mkdirSync(path.dirname(lockAbs), { recursive: true });
    } catch (error) {
      return { kind: 'unusable', path: lockAbs, reason: error?.code ?? 'unknown' };
    }
  }
  try {
    fsImpl.writeFileSync(lockAbs, `${JSON.stringify(payload)}\n`, { flag: 'wx', mode: 0o600 });
    return { kind: 'acquired', path: lockAbs };
  } catch (error) {
    if (error?.code === 'EEXIST') return { kind: 'held', path: lockAbs };
    // 目录缺失/不可写：锁在这里无法仲裁，交给调用方决定降级还是显式失败（本模块不猜）。
    return { kind: 'unusable', path: lockAbs, reason: error?.code ?? 'unknown' };
  }
}

/** 持有者是否过期：pid 已死 / 不可读或无比时超龄 / 活但超龄（覆盖 pid 复用与硬杀）。 */
export function isLockStale(holder, { staleMs, alive }) {
  if (!holder || holder.kind !== 'holder') return false;
  if (holder.unreadable) return holder.ageMs > staleMs;
  if (holder.pid === null) return holder.ageMs > staleMs;
  if (!alive(holder.pid)) return true;
  return holder.ageMs > staleMs;
}

/** 只删**属于自己**的那份锁（绝不偷活持有者的锁）。 */
export function releaseLock(lockAbs, { fsImpl = fs, pid = process.pid } = {}) {
  let holder;
  try {
    holder = JSON.parse(fsImpl.readFileSync(lockAbs, 'utf8'));
  } catch (error) {
    // ENOENT：已释放或被别的进程扫掉；解析失败：不是我们的，交给 stale 判据退役。
    if (error?.code === 'ENOENT') return false;
    return false;
  }
  if (holder?.pid !== pid) return false;
  try {
    fsImpl.rmSync(lockAbs, { force: true });
    return true;
  } catch {
    // 活持有者扫死锁时可能与本 remove 竞争（Windows）；调用方正在退出，stale 判据兜底。
    return false;
  }
}

/**
 * 扫掉过期锁（改名保留现场，便于事后确认是谁留下的），供 fail-fast 调用方用。
 * @returns {{swept:boolean, holder:object|null, parkedTo:string|null, error:string|null}}
 */
export function sweepStaleLock(lockAbs, { fsImpl = fs, staleMs, alive, now = Date.now } = {}) {
  const holder = readLockHolder(lockAbs, { fsImpl, now });
  if (holder.kind !== 'holder' || !isLockStale(holder, { staleMs, alive })) {
    return {
      swept: false,
      holder: holder.kind === 'holder' ? holder : null,
      parkedTo: null,
      error: null,
    };
  }
  const parkedTo = `${lockAbs}.stale-${now()}`;
  try {
    fsImpl.renameSync(lockAbs, parkedTo);
    return { swept: true, holder, parkedTo, error: null };
  } catch (error) {
    // Windows 上目标存在/占用时会失败：退回删除（仍只删我们判过期的这份）。
    try {
      fsImpl.rmSync(lockAbs, { force: true });
      return { swept: true, holder, parkedTo: null, error: null };
    } catch (removeError) {
      return {
        swept: false,
        holder,
        parkedTo: null,
        error: removeError?.code ?? error?.code ?? 'unknown',
      };
    }
  }
}
