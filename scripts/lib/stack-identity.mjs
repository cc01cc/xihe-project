// task-36：**服务身份的唯一读法**。
//// 背景（BL-582 家族病根）：pid 记录里有 `{pid, launcherPid, listenerPid}`、lease 里有
// `{launcher, listener}`、而 `stack-run` 的 `recordedServiceAlive()` 又自己读一遍 `pid` ——
// 三处各读各的，任一处改语义就静默影响另两处。task-30 只治了「写入口」，没治「读法分散」。
//
// 本模块把「谁是这个服务的 launcher / listener、它还活着吗、这个结论有几成证据」收敛为一处：
//   - 纯函数：字段读法（launcherPidOf / listenerPidOf / recordAlive / launcherAlive）与记录构造；
//   - 判定函数：resolveServiceIdentity（记录快路径 → 端口监听者祖先前瞻）；
//   - 进程事实：processInfo / findLauncherAncestorPid（Windows；其它平台返回空，绝不猜）。
//
// 不变量（写进断言）：
//   1. `pid` 恒等于 launcher，旧读者不受影响；
//   2. 旧形态记录（只有单 pid）不要求先清状态就能读；
//   3. 「是不是我们的人」必须能追到证据来源（identitySource），不允许"看起来像"。

import { spawnSync } from 'node:child_process';

const isPid = (value) => Number.isInteger(value) && value > 0;

/** launcher 身份：新记录读 `launcherPid`，旧记录退回 `pid`（两者恒同值）。 */
export function launcherPidOf(entry) {
  if (!entry) return null;
  if (isPid(entry.launcherPid)) return entry.launcherPid;
  return isPid(entry.pid) ? entry.pid : null;
}

/** listener 身份：旧记录没有这个字段 ⇒ null（不猜）。 */
export function listenerPidOf(entry) {
  if (!entry) return null;
  return isPid(entry.listenerPid) ? entry.listenerPid : null;
}

/** 记录里的服务还活着吗：launcher 或 listener 任一在跑即算活着（status 用）。 */
export function recordAlive(entry, isAlive) {
  return [launcherPidOf(entry), listenerPidOf(entry)].some((pid) => pid !== null && isAlive(pid));
}

/**
 * launcher 进程是否还在 —— **`stack-run` 的 `recordedServiceAlive()` 专用口径**。
 *
 * 与 `recordAlive` 的差别是刻意的：`stack-run` 的守卫问的是「这套服务树是不是我们管着的」
 * （是就别抢端口），它必须与 task-30 之前的结论逐案相同，所以只看 launcher（wrapper）这一条。
 * 想判断"服务活没活着"用 `recordAlive`；想判断"这栈归我们管吗"用本函数。
 */
export function launcherAlive(entry, isAlive) {
  const pid = launcherPidOf(entry);
  return pid !== null && isAlive(pid);
}

/** 新形态记录条目（`pid` == `launcherPid`，保持旧读者可用）。 */
export function makeRecordEntry({ launcherPid, listenerPid = null, port, startedAt, now = new Date() }) {
  return {
    pid: launcherPid,
    launcherPid,
    listenerPid,
    port,
    startedAt: startedAt ?? now.toISOString(),
  };
}

/** 身份结论的证据来源（写进日志/断言，避免"看起来像"被当成"确认是"）。 */
export const IDENTITY_SOURCE = {
  record: 'record',
  ancestorOfListener: 'ancestor-of-listener',
  unverified: 'unverified',
};

/**
 * 判定某服务当前的身份与存活。**三处消费者共用这一个函数**。
 *
 * @param {object} input
 * @param {object|null} input.entry       pid 记录里的服务条目（可能来自旧版本）
 * @param {number|null} [input.listenerPid] 端口当前监听者（fresh fact，可选）
 * @param {(pid:number)=>boolean} input.isAlive
 * @param {(pid:number)=>boolean} input.isWrapper       pid 的命令行是否是我们的 wrapper
 * @param {(pid:number)=>number|null} [input.findLauncherAncestor] 从 listener 往上找 wrapper
 * @returns {{launcherPid:number|null, listenerPid:number|null, alive:boolean, identitySource:string}}
 */
export function resolveServiceIdentity({
  entry = null,
  listenerPid = null,
  isAlive,
  isWrapper,
  findLauncherAncestor = () => null,
} = {}) {
  const recordedLauncher = launcherPidOf(entry);
  const recordedListener = listenerPidOf(entry);
  const effectiveListener = isPid(listenerPid) ? listenerPid : recordedListener;

  // ① 记录里的 launcher 还活着，且命令行确认是我们的 wrapper：最快、证据也够。
  if (recordedLauncher !== null && isAlive(recordedLauncher) && isWrapper(recordedLauncher)) {
    return {
      launcherPid: recordedLauncher,
      listenerPid: effectiveListener,
      alive: true,
      identitySource: IDENTITY_SOURCE.record,
    };
  }

  // ② 记录不可信（acquire 写的是 listener / 旧记录 / pid 被复用）：只从**端口监听者**往上找，
  //    不从记录里的 pid 出发 —— 从被复用的 pid 往上爬会把别人的树认成自己的。
  if (isPid(listenerPid)) {
    const found = findLauncherAncestor(listenerPid);
    if (isPid(found)) {
      return {
        launcherPid: found,
        listenerPid,
        alive: true,
        identitySource: IDENTITY_SOURCE.ancestorOfListener,
      };
    }
  }

  // ③ 没有证据：如实返回"记录里写的 + 当前是否还活着"，但标记 unverified，调用方不得据此复用。
  return {
    launcherPid: recordedLauncher,
    listenerPid: effectiveListener,
    alive: recordAlive(entry, isAlive),
    identitySource: IDENTITY_SOURCE.unverified,
  };
}

/* ------------------------------------------------------- 进程事实（Windows） */

// 一次拉全表 + 3s TTL：逐 pid 起 PowerShell 实测把 `acquire` 拖到 32s（task-30 §3.5）。
const PROCESS_TABLE_TTL_MS = 3000;
let tableCache = { at: 0, table: null };
let processFacts = null;

/**
 * 注入进程事实读取器（仅测试用；正常路径走 powershell）。
 * @param {{table?: () => Map<number,{parentPid:number,commandLine:string}>}|null} facts
 */
export function __setProcessFacts(facts) {
  processFacts = facts;
  tableCache = { at: 0, table: null };
}

/** 清缓存（测试用；生产路径靠 TTL 自然过期）。 */
export function resetProcessTableCache() {
  tableCache = { at: 0, table: null };
}

function loadProcessTable() {
  if (processFacts?.table) return processFacts.table();
  if (process.platform !== 'win32') return new Map();
  if (tableCache.table && Date.now() - tableCache.at < PROCESS_TABLE_TTL_MS) return tableCache.table;
  const table = new Map();
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
    ],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.status === 0) {
    try {
      const parsed = JSON.parse(String(result.stdout || '').trim() || 'null');
      const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      for (const row of list) {
        const pid = Number(row?.ProcessId);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        table.set(pid, {
          parentPid: Number(row?.ParentProcessId) || 0,
          commandLine: String(row?.CommandLine ?? ''),
        });
      }
    } catch {
      // 解析失败返回空表 ⇒ 调用方得到 unverified，绝不猜。
    }
  }
  tableCache = { at: Date.now(), table };
  return table;
}

/** @returns {{parentPid:number, commandLine:string}|null} */
export function processInfo(pid) {
  if (processFacts?.info) return processFacts.info(pid);
  return loadProcessTable().get(Number(pid)) ?? null;
}

export function commandLineOf(pid) {
  return processInfo(pid)?.commandLine ?? '';
}

/** 这条 pid 的命令行是不是我们的 wrapper（`stack-run.mjs` 起的服务树）。 */
export function isOurWrapper(pid) {
  if (process.platform !== 'win32' && !processFacts?.info) return true; // 非 Windows 保持旧语义（无命令行可查）
  return /stack-run\.mjs/i.test(commandLineOf(pid));
}

/**
 * 从某个 pid 往上找 wrapper：返回**最高**一层（最高层才能一次 `taskkill /T` 收整棵树：
 * cmd → node → mvn → java）。找不到返回 null。
 */
export function findLauncherAncestorPid(startPid, maxDepth = 6) {
  let current = Number(startPid);
  let found = null;
  for (let depth = 0; depth < maxDepth && current > 0; depth += 1) {
    const info = processInfo(current);
    if (!info) break;
    if (/stack-run\.mjs/i.test(info.commandLine)) found = current;
    current = info.parentPid;
  }
  return found;
}
