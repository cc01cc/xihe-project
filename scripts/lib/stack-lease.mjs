/**
 * PLAN-0694 T1.1/T1.2 — host 栈租约（P0 真相层）：**意图层**的唯一载体 + 字段交叉校验。
 *
 * 背景（`plans/PLAN-0694-XH-host-stack-lease/design.md` §方案设计）：同机多 instance 的故障域只有
 * 一个，三个旧信号会互相打架——`dev-stack-pids.json` 的 pid（佐证）、`kill(pid,0)`（佐证）、
 * `Get-NetTCPConnection` 的监听（事实）。本模块只负责**读写租约**、**逐字段核对租约**、**把三层
 * 信号合成一个 verdict**，不采集、不探活、不执行任何动作：采集归调用方（`dev-stack.mjs` 复用
 * `stack-orphan.mjs`），动作归 `dev-stack.mjs`。
 *
 * 分层与判据（事实层覆盖意图层）：
 *   intent  租约 —— 有人打算跑什么、记录时看到的事实快照是什么
 *   fact    调用方传入的 listeners（画像匹配的归 `own`，其余归 `external`）+ isAlive + cpVersion
 *   subst   `dev-stack-pids.json`（佐证层，不在本模块）
 *
 * verdict 四值（+ null）：
 *   healthy  租约 fresh + 期望端口全部由 own 持有 + 记录进程 alive + **全部字段交叉校验通过**
 *   stale    租约形状可用但不自洽：缺端口 / 心跳过期 / 记录进程全死且无端口（半起、死栈、刷新链路坏）
 *   orphan   租约形状可用 + 记录进程全死 + 本栈端口仍在听（画像匹配）
 *   ghost    无租约（文件缺失或损坏）+ 本栈端口仍在听（画像匹配）
 *   null     无租约且无 own 监听 = 该栈未运行；四值都不描述「什么都没发生」，
 *            强塞会制造误报，故显式返回 null，渲染层负责显示 `-`。
 *
 * 划界说明（design 表的「心跳过期」同时出现在 stale 与 ghost 的括号里，本实现按**租约文件是否
 * 存在且形状可用**划界）：形状可用 ⇒ 意图层成立，过期只把 healthy 降级为 stale；**不升级成
 * ghost** —— 否则一台长跑栈的心跳链路一坏就被判成「幽灵」，正是本计划要消灭的那类误报。
 *
 * **字段可写不可自述**（PLAN-0694 P0 批 2 硬要求，来自批 1 结论「没人校验的字段等于注释」）：
 * - 写进租约的每个字段都必须在 `crossCheckLease()` 里被核对一次（pid↔alive、port↔bind+owner、
 *   heartbeatAt↔新鲜度、instanceId↔当前实例、cpVersion↔当前运行版本、releaseFailed↔残留端口）；
 * - 核对不了的字段**宁可不写**（`cpVersion` 未知时写 null，`pids` 只写观测到的服务）；
 * - 声明了但核不了 ⇒ `unverifiable`（拦 healthy）；根本没声明 ⇒ `skipped`（不拦）。
 *   「claims must be verifiable; absent claims are fine.」
 *
 * 契约（与 `stack-ports.mjs` 同款）：纯函数 + fs。不读环境变量、不探活、不起进程、不 kill、
 * 不 import `node:child_process`；坏数据一律**降级返回**，不抛给调用方（抛 = 让 status 整体崩）。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * 租约形状版本；字段增删必须同步 bump，读到别的版本按「不认识的租约」降级。
 *
 * v1 → v2（PLAN-0694 批 2）：`owner`/`pid` 两个自述字段换成可核对的 `instanceId`/`pids`
 * （每服务 `{launcher, listener}`），并补上 `projectRoot`/`cpVersion`。
 */
export const LEASE_VERSION = 2;

/** 心跳超过这个时长未刷即视为过期（design §待裁 3 的建议默认值，10 min）。 */
export const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;

const STACK_ID_RE = /^stack-(\d+)$/;

/** 核不了的核对项：不算 mismatch，但拦 healthy（声明了就得能验）。 */
const NON_BLOCKING_CODES = new Set(['ok', 'skipped', 'unverifiable']);

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

/** 路径比较键：Windows 大小写/分隔符不敏感，先归一化再比，避免 `H:\x` vs `h:/x` 假 mismatch。 */
export function pathKey(value) {
  return String(value ?? '')
    .replaceAll('\\', '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPidOrNull(value) {
  return value === null || (Number.isInteger(value) && value > 0);
}

function isTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * 租约形状是否可用（版本 + 必需字段 + 端口/进程表类型）。
 * 形状不可用 ⇒ 意图层不存在 ⇒ 调用方降级为 `ghost`（端口在听）或 `null`（没在听）。
 * @param {unknown} lease
 * @returns {boolean}
 */
export function isShapedLease(lease) {
  if (!isPlainObject(lease)) return false;
  if (lease.version !== LEASE_VERSION) return false;
  if (typeof lease.instanceId !== 'string' || lease.instanceId === '') return false;
  if (typeof lease.projectRoot !== 'string' || lease.projectRoot === '') return false;
  if (typeof lease.stackId !== 'string' || lease.stackId === '') return false;
  if (!isTimestamp(lease.startedAt) || !isTimestamp(lease.heartbeatAt)) return false;
  if (lease.cpVersion !== null && typeof lease.cpVersion !== 'string') return false;
  if (!isPlainObject(lease.ports) || Object.keys(lease.ports).length === 0) return false;
  if (!Object.values(lease.ports).every((port) => Number.isInteger(port) && port > 0)) return false;
  if (!isPlainObject(lease.pids)) return false;
  for (const entry of Object.values(lease.pids)) {
    if (!isPlainObject(entry)) return false;
    if (!isPidOrNull(entry.launcher ?? null) || !isPidOrNull(entry.listener ?? null)) return false;
  }
  if (lease.releaseFailed !== undefined) {
    const failed = lease.releaseFailed;
    if (!isPlainObject(failed) || !isTimestamp(failed.at) || !Array.isArray(failed.services)) return false;
  }
  return true;
}

/**
 * 读租约。**永不抛**：
 *   - 文件不存在 → `{lease: null, corrupt: false}`（正常的「没起过」）
 *   - JSON 坏了 / 形状不对 / 版本不认识 → `{lease: null, corrupt: true}`（交调用方降级）
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
  if (!isShapedLease(parsed)) return { lease: null, corrupt: true };
  return { lease: parsed, corrupt: false };
}

function writeLeaseAtomic(filePath, lease) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(lease, null, 2)}\n`, 'utf8');
  renameSync(temp, filePath);
}

/** 归一化 `pids` 入参：只保留服务→`{launcher, listener}`，值为 null 表示「没观测到」。 */
function normalizePids(pids) {
  if (!isPlainObject(pids)) return {};
  const out = {};
  for (const [service, entry] of Object.entries(pids)) {
    if (!isPlainObject(entry)) continue;
    out[service] = { launcher: entry.launcher ?? null, listener: entry.listener ?? null };
  }
  return out;
}

/**
 * 取得（或刷新）租约。幂等：已有**未过期**租约时保留首启 `startedAt`——重复 `start` 不得把
 * 「这栈起于何时」洗掉，否则租约年龄与回收判定全失真。
 *
 * 写进去的字段都是**声明**，`status` 会逐条核对（见 `crossCheckLease`）：
 *   `ports`  期望端口（声明）；`pids` 当时观测到的进程（声明）；`cpVersion` 当时的 CP 版本，
 *   **未知就不写 null**（不写 null 是因为 null 表示「没有声明」，比假装知道更安全）。
 *
 * @param {{projectRoot: string, stackId: string, ports: Record<string, number>,
 *          pids?: Record<string, {launcher?: number|null, listener?: number|null}>,
 *          instanceId: string, cpVersion?: string|null, now?: number,
 *          staleAfterMs?: number}} input
 * @returns {object} 写入的租约对象
 */
export function acquireLease({
  projectRoot,
  stackId,
  ports,
  pids = {},
  instanceId,
  cpVersion = null,
  now = Date.now(),
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
} = {}) {
  if (!isPlainObject(ports) || Object.keys(ports).length === 0) {
    throw new TypeError('stack-lease: acquireLease 需要非空 ports');
  }
  if (!Object.values(ports).every((port) => Number.isInteger(port) && port > 0)) {
    throw new TypeError('stack-lease: acquireLease 的 ports 值必须是正整数端口');
  }
  if (typeof instanceId !== 'string' || instanceId === '') {
    throw new TypeError('stack-lease: acquireLease 需要非空 instanceId（租约必须能证明是谁写的）');
  }
  const filePath = leasePath(projectRoot, stackId);
  const { lease: previous } = readLease(filePath);
  const previousFresh = previous !== null && now - Date.parse(previous.heartbeatAt) <= staleAfterMs;
  const lease = {
    version: LEASE_VERSION,
    instanceId,
    projectRoot: resolve(projectRoot),
    stackId,
    ports: { ...ports },
    pids: normalizePids(pids),
    cpVersion: typeof cpVersion === 'string' && cpVersion !== '' ? cpVersion : null,
    startedAt: previousFresh ? previous.startedAt : new Date(now).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
  };
  writeLeaseAtomic(filePath, lease);
  return lease;
}

/**
 * 刷新心跳（只动 `heartbeatAt`，不动任何声明字段——否则「刷新」会悄悄改事实快照）。
 * 没有租约或租约形状坏 → 不写、返回 `{lease: null, renewed: false}`。
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
 * 标「释放失败」：`stop` 没能把端口全清掉时**保留**租约并打标，绝不静默删。
 *
 * 这个标记本身也是可核对的：`crossCheckLease` 会把 `releaseFailed` 记为 mismatch，
 * 并在 `status` 里提示「哪个服务还残留」。修好之后再 `release` 一次即恢复干净。
 *
 * @param {{projectRoot: string, stackId: string, services?: string[], reason?: string,
 *          now?: number}} input
 * @returns {{lease: object|null, marked: boolean}}
 */
export function markReleaseFailed({ projectRoot, stackId, services = [], reason = '', now = Date.now() } = {}) {
  const filePath = leasePath(projectRoot, stackId);
  const { lease } = readLease(filePath);
  if (lease === null) return { lease: null, marked: false };
  const next = {
    ...lease,
    releaseFailed: { at: new Date(now).toISOString(), services: [...services], reason: String(reason) },
  };
  writeLeaseAtomic(filePath, next);
  return { lease: next, marked: true };
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
 * **逐字段核对租约**（PLAN-0694 批 2 的核心：不许字段自述）。
 *
 * 每个核对项都是「声明 vs 独立事实」，事实只来自 `facts`（由调用方采集，本函数不碰系统）：
 *   - `version` / `stackId` / `projectRoot` / `instanceId` —— 这份租约是不是**这个栈、这棵
 *     checkout、这个实例**写的（`instanceId` 即「owner」的可核对形态）；
 *   - `heartbeatAt` / `startedAt` —— 心跳新鲜度与时间顺序（自洽 + 不未来）；
 *   - `ports.<svc>` —— 声明端口是否等于当前 `deriveStack()` 的端口；
 *   - `ports.<svc>.bind` —— 该端口是否真的在听（bind 事实）；
 *   - `pids.<svc>.launcher|listener` —— 记录的进程是否还活着；
 *   - `pids.<svc>.owns-port` —— 监听该端口的进程是否就是租约记录的那个（**案例②：launcher 会
 *     fork，pid 变了就是漂移**）；
 *   - `cpVersion` —— 记录的 CP 版本是否等于当前构建戳（声明了核不了 ⇒ `unverifiable`，拦 healthy）；
 *   - `releaseFailed` —— 上一次 stop 是否留了尾巴。
 *
 * @param {{lease: object|null, facts?: object}} input
 * @param {object} [input.facts]
 * @param {string} [input.facts.stackId]
 * @param {string} [input.facts.instanceId]
 * @param {string} [input.facts.projectRoot]
 * @param {Record<string, number>} [input.facts.expectedPorts]  当前 checkout 的 deriveStack().ports
 * @param {{own?: object[], external?: object[]}} [input.facts.listeners]
 * @param {(pid: number) => boolean} [input.facts.isAlive]  进程存活判定（调用方传 `processAlive`）
 * @param {string|null} [input.facts.cpVersion]  当前 CP 构建戳 commit
 * @param {number} [input.facts.now]
 * @param {number} [input.facts.staleAfterMs]
 * @returns {{checks: Array<{field: string, code: string, blocking: boolean, expected: any, actual: any}>,
 *           mismatches: Array<{field: string, code: string, expected: any, actual: any}>,
 *           unverifiable: string[], skipped: string[], allOk: boolean}}
 */
export function crossCheckLease({ lease = null, facts = {} } = {}) {
  const now = Number.isFinite(facts.now) ? facts.now : Date.now();
  const staleAfterMs = Number.isFinite(facts.staleAfterMs) ? facts.staleAfterMs : DEFAULT_STALE_AFTER_MS;
  const isAlive = typeof facts.isAlive === 'function' ? facts.isAlive : null;
  const listeners = normalizeListeners(facts.listeners);
  const listenerByPort = new Map();
  for (const entry of listeners.own) {
    if (Number.isFinite(entry?.port)) listenerByPort.set(entry.port, entry);
  }
  const checks = [];

  const record = (field, code, expected, actual) => {
    checks.push({ field, code, blocking: !NON_BLOCKING_CODES.has(code), expected, actual });
  };
  const expectEqual = (field, code, expected, actual) => record(field, expected === actual ? 'ok' : code, expected, actual);

  if (!isShapedLease(lease)) {
    record('shape', lease === null ? 'lease-missing' : 'lease-unusable', 'shaped-lease', lease === null ? null : 'unshaped');
    return finish();
  }

  expectEqual('version', 'version-mismatch', LEASE_VERSION, lease.version);
  expectEqual('stackId', 'stack-id-mismatch', facts.stackId ?? null, lease.stackId);
  expectEqual('projectRoot', 'project-root-mismatch', pathKey(facts.projectRoot ?? ''), pathKey(lease.projectRoot));
  expectEqual('instanceId', 'instance-mismatch', facts.instanceId ?? null, lease.instanceId);

  const heartbeatMs = Date.parse(lease.heartbeatAt);
  const ageMs = now - heartbeatMs;
  record('heartbeatAt', ageMs <= staleAfterMs ? 'ok' : 'lease-expired', `age<=${staleAfterMs}ms`, `${ageMs}ms`);
  record('startedAt', Date.parse(lease.startedAt) <= heartbeatMs ? 'ok' : 'started-at-order', `<=${lease.heartbeatAt}`, lease.startedAt);

  const expectedPorts = isPlainObject(facts.expectedPorts) ? facts.expectedPorts : null;
  for (const [service, port] of Object.entries(lease.ports)) {
    if (expectedPorts === null) record(`ports.${service}`, 'unverifiable', 'deriveStack()', port);
    else expectEqual(`ports.${service}`, 'port-declared-mismatch', expectedPorts[service] ?? null, port);

    const holder = listenerByPort.get(port);
    record(`ports.${service}.bind`, holder ? 'ok' : 'port-not-listening', `listen:${port}`, holder ? `pid:${holder.pid}` : 'silent');

    const declared = lease.pids?.[service];
    if (!declared) {
      // 没声明该服务的进程：不伪造一个 pass，也不当成不符（absent claims are fine）。
      record(`pids.${service}`, 'skipped', 'no-claim', null);
      continue;
    }
    for (const kind of ['launcher', 'listener']) {
      const pid = declared[kind] ?? null;
      if (pid === null) record(`pids.${service}.${kind}`, 'skipped', 'no-claim', null);
      else if (isAlive === null) record(`pids.${service}.${kind}`, 'unverifiable', `alive:${pid}`, 'no-liveness-probe');
      else record(`pids.${service}.${kind}`, isAlive(pid) ? 'ok' : `${kind}-dead`, `alive:${pid}`, isAlive(pid) ? 'alive' : 'dead');
    }
    const listenerPid = declared.listener ?? null;
    if (listenerPid === null || !holder) record(`pids.${service}.owns-port`, 'skipped', 'no-claim', null);
    else expectEqual(`pids.${service}.owns-port`, 'pid-drift', listenerPid, holder.pid);
  }

  if (lease.cpVersion === null) record('cpVersion', 'skipped', 'no-claim', null);
  else if (typeof facts.cpVersion !== 'string' || facts.cpVersion === '') record('cpVersion', 'unverifiable', lease.cpVersion, null);
  else expectEqual('cpVersion', 'cp-version-mismatch', lease.cpVersion, facts.cpVersion);

  if (lease.releaseFailed === undefined) record('releaseFailed', 'skipped', 'no-claim', null);
  else record('releaseFailed', 'release-failed', 'absent', `${lease.releaseFailed.at} ${lease.releaseFailed.services.join(',')}`);

  return finish();

  function finish() {
    const mismatches = checks
      .filter((check) => check.blocking)
      .map(({ field, code, expected, actual }) => ({ field, code, expected, actual }));
    return {
      checks,
      mismatches,
      unverifiable: checks.filter((check) => check.code === 'unverifiable').map((check) => check.field),
      skipped: checks.filter((check) => check.code === 'skipped').map((check) => check.field),
      // 全绿才算通过：`unverifiable`（声明了核不了）拦 healthy，`skipped`（压根没声明）不拦。
      allOk: checks.every((check) => check.code === 'ok' || check.code === 'skipped'),
    };
  }
}

/**
 * 把三层信号合成一个 verdict。**纯函数**：不读文件、不探活，所有事实由调用方传入。
 *
 * `listeners` 由调用方（`dev-stack.mjs`，画像沿用 `stack-orphan.mjs` 的 `SERVICE_OWNER`）先分类：
 *   `{ own: [{port, pid, service}], external: [{port, pid, cmdline}] }`
 * 只有 `own` 参与四值判定；`external` 只作附注（别人家的端口不归我们处置，也不该被 gc 建议清理）。
 *
 * `checks` 来自 `crossCheckLease()`：给了就必须全绿才可能 healthy —— 这是「字段可写不可自述」
 * 的落点（`unverifiable` 拦 healthy：声明了却核不了，等于没说）。
 *
 * @param {{lease: object|null, listeners?: {own?: object[], external?: object[]},
 *          pidAlive?: boolean, now?: number, staleAfterMs?: number, corrupt?: boolean,
 *          checks?: Array<{blocking: boolean}>}} input
 * @returns {{verdict: 'healthy'|'stale'|'orphan'|'ghost'|null, reasons: string[],
 *           ownPorts: number[], missingPorts: number[], externalPorts: number[],
 *           leaseFresh: boolean, leaseAgeMs: number|null, fieldMismatches: string[]}}
 */
export function computeVerdict({
  lease = null,
  listeners = {},
  pidAlive = false,
  now = Date.now(),
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  corrupt = false,
  checks = null,
} = {}) {
  const { ownPorts, externalPorts } = normalizeListeners(listeners);
  const reasons = [];
  const leaseValid = isShapedLease(lease);
  const heartbeatMs = leaseValid ? Date.parse(lease.heartbeatAt) : null;
  const leaseAgeMs = heartbeatMs === null ? null : Math.max(0, now - heartbeatMs);
  const leaseFresh = leaseValid && leaseAgeMs <= staleAfterMs;
  const fieldMismatches = Array.isArray(checks)
    ? checks
        .filter((check) => check && check.code !== 'ok' && check.code !== 'skipped')
        .map((check) => check.code ?? 'mismatch')
    : [];
  const fieldsOk = fieldMismatches.length === 0;

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
    // 租约在、进程活、心跳停了：栈可能仍在跑，坏的是刷新链路 ⇒ stale（不是 ghost）。
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
  if (!fieldsOk) {
    // 端口齐、进程活、心跳新，但某个声明字段核不上 ⇒ 不是 healthy（差哪条由 checks 指名）。
    reasons.push(`fields-mismatch:${[...new Set(fieldMismatches)].join(',')}`);
    return finish('stale');
  }
  reasons.push(`ports-own:${ownPorts.join(',')}`);
  if (Array.isArray(checks)) reasons.push('fields-verified');
  return finish('healthy');

  /** @param {'healthy'|'stale'|'orphan'|'ghost'|null} verdict */
  function finish(verdict) {
    if (externalPorts.length > 0) reasons.push(`external-ports:${externalPorts.join(',')}`);
    return { verdict, reasons, ownPorts, missingPorts, externalPorts, leaseFresh, leaseAgeMs, fieldMismatches };
  }
}

/** 目录级便利函数：读 `<projectRoot>/.xihe-stacks/<n>/lease.json`。 */
export function readStackLease(projectRoot, stackId) {
  return readLease(leasePath(projectRoot, stackId));
}

/** 租约目录（供 `gc` 列举用，不创建）。 */
export function leaseDir(projectRoot) {
  return resolve(projectRoot, '.xihe-stacks');
}
