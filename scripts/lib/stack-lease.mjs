/**
 * PLAN-0694 T1.1 — host 栈租约（P0 真相层第 1 步）：**意图层**的唯一载体。
 *
 * 背景（`plans/PLAN-0694-XH-host-stack-lease/design.md` §方案设计）：同机多 instance 的故障域只有
 * 一个，三个旧信号会互相打架——`dev-stack-pids.json` 的 pid（佐证）、`kill(pid,0)`（佐证）、
 * `Get-NetTCPConnection` 的监听（事实）。本模块只负责**读写租约**与**把三者合成一个 verdict**，
 * 不采集、不探活、不执行任何动作：采集归 `stack-orphan.mjs`，动作归 `dev-stack.mjs`（T1.2）。
 *
 * 分层与判据（事实层覆盖意图层）：
 *   intent  租约 `{stackId,pid,startedAt,owner,ports,heartbeatAt,version}` —— 有人打算跑什么
 *   fact    调用方传入的 listeners（画像匹配的归 `own`，其余归 `external`）—— 谁真的持有端口
 *   subst   `pidAlive`（租约 pid 是否还在）—— 记录是否过期
 *
 * verdict 四值（+ null）：
 *   healthy  租约 fresh + 期望端口全部由 own 持有 + 租约 pid alive
 *   stale    租约形状可用但不自洽：缺端口 / 心跳过期 / pid 已死且无端口（半起、死栈、刷新链路坏）
 *   orphan   租约形状可用 + 租约 pid 已死 + 本栈端口仍在听（画像匹配）
 *   ghost    无租约（文件缺失或损坏）+ 本栈端口仍在听（画像匹配）
 *   null     无租约且无 own 监听 = 该栈未运行；四值都不描述「什么都没发生」，
 *            强塞会制造误报，故显式返回 null，渲染层负责显示 `-`。
 *
 * 划界说明（design 表的「心跳过期」同时出现在 stale 与 ghost 的括号里，本实现按**租约文件是否
 * 存在且形状可用**划界）：形状可用 ⇒ 意图层成立，过期只把 healthy 降级为 stale；**不升级成
 * ghost** —— 否则一台长跑栈的心跳链路一坏就被判成「幽灵」，正是本计划要消灭的那类误报。
 *
 * 契约（与 `stack-ports.mjs` 同款）：纯函数 + fs。不读环境变量、不探活、不起进程、不 kill、
 * 不 import `node:child_process`；坏数据一律**降级返回**，不抛给调用方（抛 = 让 status 整体崩）。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** 租约形状版本；字段增删必须同步 bump，读到别的版本按「不认识的租约」降级。 */
export const LEASE_VERSION = 1;

/** 心跳超过这个时长未刷即视为过期（design §待裁 3 的建议默认值，10 min）。 */
export const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;

const STACK_ID_RE = /^stack-(\d+)$/;

/**
 * `stack-3` → `3`。目录名用槽位号而非 stackId，保证 `stack-1` 也是 `.xihe-stacks/1/`。
 * @param {string} stackId
 * @returns {number}
 */
export function stackSlotOf(stackId) {
  const match = STACK_ID_RE.exec(String(stackId ?? ''));
  if (!match) throw new TypeError(`stack-lease: 非法 stackId: ${JSON.stringify(stackId)}（期望 stack-<n>）`);
  return Number(match[1]);
}

/**
 * 租约路径：`<projectRoot>/.xihe-stacks/<n>/lease.json`。
 *
 * 有意**不复用** `deriveStack().logDir`：租约是状态不是日志，`stack-1` 的 logDir 是 `<root>/logs`
 * 而其它栈是 `<root>/.xihe-stacks/<n>/logs`，复用会让 stack-1 的租约落进日志目录、并与其余栈
 * 形成两套路径规则（design 决策 3）。
 *
 * @param {string} projectRoot 仓库根（调用方传入，本模块不猜 cwd）
 * @param {string} stackId 形如 `stack-2`
 * @returns {string} 绝对路径
 */
export function leasePath(projectRoot, stackId) {
  return resolve(projectRoot, '.xihe-stacks', String(stackSlotOf(stackId)), 'lease.json');
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isShapecorrect(lease) {
  if (!isPlainObject(lease)) return false;
  if (lease.version !== LEASE_VERSION) return false;
  if (typeof lease.stackId !== 'string' || lease.stackId === '') return false;
  if (!Number.isFinite(lease.pid)) return false;
  if (typeof lease.startedAt !== 'string' || Number.isNaN(Date.parse(lease.startedAt))) return false;
  if (typeof lease.heartbeatAt !== 'string' || Number.isNaN(Date.parse(lease.heartbeatAt))) return false;
  if (!isPlainObject(lease.ports)) return false;
  // 空端口集是合法形状（将来的 profile 可能只挂部分服务），但值必须是正整数端口。
  return Object.values(lease.ports).every((port) => Number.isInteger(port) && port > 0);
}

/**
 * 读租约。**永不抛**：
 *   - 文件不存在 → `{lease: null, corrupt: false}`（正常的「没起过」）
 *   - JSON 坏了 / 形状不对 / 版本不认识 → `{lease: null, corrupt: true}`（交调用方降级 stale）
 *
 * @param {string} filePath `leasePath()` 的返回值
 * @returns {{lease: object|null, corrupt: boolean}}
 */
export function readLease(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { lease: null, corrupt: false };
    if (error && error.code === 'EISDIR') return { lease: null, corrupt: true };
    return { lease: null, corrupt: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { lease: null, corrupt: true };
  }
  if (!isShapecorrect(parsed)) return { lease: null, corrupt: true };
  return { lease: parsed, corrupt: false };
}

function writeLeaseAtomic(filePath, lease) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(lease, null, 2)}\n`, 'utf8');
  renameSync(temp, filePath);
}

/**
 * 取得（或刷新）租约。幂等：已有**未过期**租约时保留首启 `startedAt`，只刷 `heartbeatAt`/`pid`/
 * `ports`/`owner`——重复 `start` 不得把「这栈起于何时」洗掉，否则租约年龄与回收判定全失真。
 *
 * @param {{projectRoot: string, stackId: string, ports: Record<string, number>, owner: string,
 *          pid: number, now?: number, staleAfterMs?: number}} input
 * @returns {object} 写入的租约对象
 */
export function acquireLease({
  projectRoot,
  stackId,
  ports,
  owner,
  pid,
  now = Date.now(),
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
} = {}) {
  if (!isPlainObject(ports) || Object.keys(ports).length === 0) {
    throw new TypeError('stack-lease: acquireLease 需要非空 ports');
  }
  if (!Number.isFinite(pid)) throw new TypeError('stack-lease: acquireLease 需要数值 pid');
  const filePath = leasePath(projectRoot, stackId);
  const existing = readLease(filePath);
  const previous = existing.lease;
  const previousFresh = previous !== null && now - Date.parse(previous.heartbeatAt) <= staleAfterMs;
  const lease = {
    stackId,
    pid,
    startedAt: previousFresh ? previous.startedAt : new Date(now).toISOString(),
    owner,
    ports: { ...ports },
    heartbeatAt: new Date(now).toISOString(),
    version: LEASE_VERSION,
  };
  writeLeaseAtomic(filePath, lease);
  return lease;
}

/**
 * 刷新心跳。没有租约或租约形状坏 → 不写、返回 `{lease: null, renewed: false}`（由调用方决定
 * 是否重新 acquire，本模块不替它做决定）。
 *
 * @param {{projectRoot: string, stackId: string, now?: number}} input
 * @returns {{lease: object|null, renewed: boolean}}
 */
export function renewLease({ projectRoot, stackId, now = Date.now() } = {}) {
  const filePath = leasePath(projectRoot, stackId);
  const { lease } = readLease(filePath);
  if (lease === null) return { lease: null, renewed: false };
  const next = { ...lease, heartbeatAt: new Date(now).toISOString() };
  writeLeaseAtomic(filePath, next);
  return { lease: next, renewed: true };
}

/**
 * 释放：只删 `lease.json`，不删目录、不删同目录其它文件（`stop` 之后 `gc` 仍要能看见残留日志）。
 *
 * @param {{projectRoot: string, stackId: string}} input
 * @returns {{removed: boolean}}
 */
export function releaseLease({ projectRoot, stackId } = {}) {
  const filePath = leasePath(projectRoot, stackId);
  const { lease, corrupt } = readLease(filePath);
  if (lease === null && !corrupt) return { removed: false };
  rmSync(filePath, { force: true });
  return { removed: true };
}

function normalizeListeners(listeners) {
  const source = isPlainObject(listeners) ? listeners : {};
  const own = Array.isArray(source.own) ? source.own : [];
  const external = Array.isArray(source.external) ? source.external : [];
  const portsOf = (entries) =>
    [...new Set(entries.map((entry) => (Number.isFinite(entry?.port) ? entry.port : null)).filter((port) => port !== null))];
  return { own, external, ownPorts: portsOf(own).sort((a, b) => a - b), externalPorts: portsOf(external).sort((a, b) => a - b) };
}

/**
 * 把三层信号合成一个 verdict。**纯函数**：不读文件、不探活，所有事实由调用方传入。
 *
 * `listeners` 由调用方（`dev-stack.mjs`，画像沿用 `stack-orphan.mjs` 的 `SERVICE_OWNER`）先分类：
 *   `{ own: [{port, pid, service}], external: [{port, pid, cmdline}] }`
 * 只有 `own` 参与四值判定；`external` 只作附注（别人家的端口不归我们处置，也不该被 gc 建议清理）。
 *
 * @param {{lease: object|null, listeners?: {own?: object[], external?: object[]},
 *          pidAlive?: boolean, now?: number, staleAfterMs?: number, corrupt?: boolean}} input
 * @returns {{verdict: 'healthy'|'stale'|'orphan'|'ghost'|null, reasons: string[],
 *           ownPorts: number[], missingPorts: number[], externalPorts: number[],
 *           leaseFresh: boolean, leaseAgeMs: number|null}}
 */
export function computeVerdict({
  lease = null,
  listeners = {},
  pidAlive = false,
  now = Date.now(),
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  corrupt = false,
} = {}) {
  const { ownPorts, externalPorts } = normalizeListeners(listeners);
  const reasons = [];
  const leaseValid = isShapecorrect(lease);
  const heartbeatMs = leaseValid ? Date.parse(lease.heartbeatAt) : null;
  const leaseAgeMs = heartbeatMs === null ? null : Math.max(0, now - heartbeatMs);
  const leaseFresh = leaseValid && leaseAgeMs <= staleAfterMs;

  if (!leaseValid) reasons.push(corrupt ? 'lease-corrupt' : lease === null ? 'lease-missing' : 'lease-unusable');
  else if (!leaseFresh) reasons.push('lease-expired');

  const expectedPorts = leaseValid ? [...new Set(Object.values(lease.ports))].sort((a, b) => a - b) : [];
  const missingPorts = expectedPorts.filter((port) => !ownPorts.includes(port));

  if (!leaseValid) {
    // 租约缺失/损坏：没有意图层可依据，端口仍被画像匹配进程持有 = 本栈遗留物。
    if (ownPorts.length > 0) {
      reasons.push(`own-listener-without-valid-lease:${ownPorts.join(',')}`);
      return finish('ghost');
    }
    reasons.push('no-own-listener');
    return finish(null);
  }

  if (!pidAlive) {
    reasons.push('lease-pid-dead');
    if (ownPorts.length > 0) {
      reasons.push(`own-listener-alive:${ownPorts.join(',')}`);
      return finish('orphan');
    }
    reasons.push('no-own-listener');
    return finish('stale');
  }

  if (!leaseFresh) {
    // 租约在、pid 活、心跳停了：栈可能仍在跑，坏的是刷新链路 ⇒ stale（不是 ghost）。
    return finish('stale');
  }
  if (ownPorts.length === 0) {
    reasons.push('no-own-listener');
    return finish('stale');
  }
  if (missingPorts.length > 0) {
    reasons.push(`ports-missing:${missingPorts.join(',')}`);
    return finish('stale');
  }
  reasons.push(`ports-own:${ownPorts.join(',')}`);
  return finish('healthy');

  /** @param {'healthy'|'stale'|'orphan'|'ghost'|null} verdict */
  function finish(verdict) {
    if (externalPorts.length > 0) reasons.push(`external-ports:${externalPorts.join(',')}`);
    return { verdict, reasons, ownPorts, missingPorts, externalPorts, leaseFresh, leaseAgeMs };
  }
}

/** 目录级便利函数：读 `<projectRoot>/.xihe-stacks/<n>/lease.json`。 */
export function readStackLease(projectRoot, stackId) {
  return readLease(leasePath(projectRoot, stackId));
}

/** 租约目录（供 T1.2 的 `gc` 列举用，不创建）。 */
export function leaseDir(projectRoot) {
  return resolve(projectRoot, '.xihe-stacks');
}
