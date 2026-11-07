/**
 * PLAN-0694 T1.1/T1.2 — `stack-lease.mjs` 单测。
 *
 * 纪律（这是「纯函数库」的守卫）：
 * - **不绑端口、不起进程、不 kill**：所有事实（listeners / isAlive / cpVersion）都是入参，
 *   verdict 与交叉校验都是纯计算；
 * - **不写真实 `.xihe-stacks/`**：一律 `mkdtempSync(join(tmpdir(), 'xihe-lease-'))`，测完删除；
 * - 每个 test 独立 root，互不共享状态（可并行跑）。
 *
 * 批 2 新增的重点：**字段可写不可自述** —— 每类声明字段各有一组「不符」负例，
 * 达到 `healthy` 的前提是全部核对项通过（`checks` 全绿）。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_STALE_AFTER_MS,
  LEASE_VERSION,
  acquireLease,
  computeVerdict,
  crossCheckLease,
  isShapedLease,
  leasePath,
  markReleaseFailed,
  readLease,
  releaseLease,
  renewLease,
  stackSlotOf,
} from './stack-lease.mjs';

const PORTS = { ui: 12650, cp: 12651, agent: 12652, runtime: 12653, postgres: 12654 };
const OWN_ALL = [
  { port: 12650, pid: 111, service: 'ui' },
  { port: 12651, pid: 222, service: 'cp' },
  { port: 12652, pid: 333, service: 'agent' },
  { port: 12653, pid: 444, service: 'runtime' },
  { port: 12654, pid: 555, service: 'postgres' },
];
/** 每服务两个 pid：`launcher`（cmd.exe/stack-run 包装）与 `listener`（真正持有端口的进程）。 */
const PIDS_ALL = {
  cp: { launcher: 2220, listener: 222 },
  runtime: { launcher: 4440, listener: 444 },
  agent: { launcher: 3330, listener: 333 },
  ui: { launcher: 1110, listener: 111 },
  postgres: { launcher: null, listener: 555 },
};

/** 每个用例一个临时 projectRoot，结束必删（Windows 上文件被占用会抛，so force:true + 兜底）。 */
function withRoot(run) {
  const root = mkdtempSync(join(tmpdir(), 'xihe-lease-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function freshLease(now, overrides = {}) {
  return {
    version: LEASE_VERSION,
    instanceId: 'host-a@h:/repo',
    projectRoot: 'H:/repo',
    stackId: 'stack-3',
    ports: { ...PORTS },
    pids: structuredClone(PIDS_ALL),
    cpVersion: 'abc1234',
    startedAt: new Date(now - 60_000).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
    ...overrides,
  };
}

/** 交叉校验的事实面（默认全绿）；故意用反斜杠 + 不同大小写写 projectRoot，验证归一化比较。 */
function factsFor(now, overrides = {}) {
  return {
    stackId: 'stack-3',
    instanceId: 'host-a@h:/repo',
    projectRoot: 'H:\\REPO\\',
    expectedPorts: PORTS,
    listeners: { own: OWN_ALL.map((entry) => ({ ...entry })) },
    isAlive: () => true,
    cpVersion: 'abc1234',
    now,
    ...overrides,
  };
}

function mismatchFields(result) {
  return result.mismatches.map((entry) => `${entry.field}:${entry.code}`);
}

// ── 路径与槽位 ───────────────────────────────────────────────────────────────

test('stackSlotOf 解析 stack-<n>，非法输入抛 TypeError', () => {
  assert.equal(stackSlotOf('stack-1'), 1);
  assert.equal(stackSlotOf('stack-12'), 12);
  assert.throws(() => stackSlotOf('stack-x'), TypeError);
  assert.throws(() => stackSlotOf(''), TypeError);
  assert.throws(() => stackSlotOf(undefined), TypeError);
});

test('leasePath 统一落 .xihe-stacks/<n>/lease.json，stack-1 也是 <1>（不复用 logDir）', () => {
  const path = leasePath('C:/repo/xihe', 'stack-1');
  assert.match(path.replaceAll('\\', '/'), /\/\.xihe-stacks\/1\/lease\.json$/);
  assert.match(leasePath('C:/repo/xihe', 'stack-3').replaceAll('\\', '/'), /\/\.xihe-stacks\/3\/lease\.json$/);
  // logDir 语义不同：stack-1 的日志在 <root>/logs，租约**不得**跟着去那儿。
  assert.equal(path.replaceAll('\\', '/').includes('/logs/'), false);
});

// ── acquire ─────────────────────────────────────────────────────────────────

test('acquireLease 写出九字段形状（v2：instanceId/pids/cpVersion 取代 owner/pid）', () => {
  withRoot((root) => {
    const now = Date.parse('2026-11-08T02:00:00.000Z');
    const lease = acquireLease({
      projectRoot: root,
      stackId: 'stack-3',
      ports: PORTS,
      pids: PIDS_ALL,
      instanceId: 'host-a@h:/repo',
      cpVersion: 'abc1234',
      now,
    });
    assert.deepEqual(Object.keys(lease).sort(), [
      'cpVersion',
      'heartbeatAt',
      'instanceId',
      'pids',
      'ports',
      'projectRoot',
      'stackId',
      'startedAt',
      'version',
    ]);
    assert.equal(lease.version, LEASE_VERSION);
    assert.equal(lease.instanceId, 'host-a@h:/repo');
    assert.equal(lease.stackId, 'stack-3');
    assert.equal(lease.startedAt, new Date(now).toISOString());
    assert.deepEqual(lease.ports, PORTS);
    assert.deepEqual(lease.pids, PIDS_ALL);
    const onDisk = JSON.parse(readFileSync(leasePath(root, 'stack-3'), 'utf8'));
    assert.deepEqual(onDisk, lease);
    assert.equal(isShapedLease(onDisk), true);
  });
});

test('acquireLease：cpVersion 未知就写 null（不假装知道），pids 缺省为空表', () => {
  withRoot((root) => {
    const lease = acquireLease({ projectRoot: root, stackId: 'stack-3', ports: PORTS, instanceId: 'i' });
    assert.equal(lease.cpVersion, null);
    assert.deepEqual(lease.pids, {});
    assert.equal(isShapedLease(lease), true);
  });
});

test('重复 acquire 保留首启 startedAt，只刷新 heartbeatAt（幂等，不洗掉栈年龄）', () => {
  withRoot((root) => {
    const t0 = Date.parse('2026-11-08T02:00:00.000Z');
    const first = acquireLease({
      projectRoot: root,
      stackId: 'stack-3',
      ports: PORTS,
      pids: PIDS_ALL,
      instanceId: 'lane/a',
      now: t0,
    });
    const second = acquireLease({
      projectRoot: root,
      stackId: 'stack-3',
      ports: PORTS,
      pids: { ...PIDS_ALL, cp: { launcher: 2, listener: 3 } },
      instanceId: 'lane/b',
      now: t0 + 60_000,
    });
    assert.equal(second.startedAt, first.startedAt);
    assert.equal(second.heartbeatAt, new Date(t0 + 60_000).toISOString());
    assert.equal(second.instanceId, 'lane/b', 'instanceId 与 pids 应被最新一次 acquire 覆盖');
    assert.deepEqual(second.pids.cp, { launcher: 2, listener: 3 });
  });
});

test('过期租约上的 acquire 重置 startedAt（旧租约不再代表同一次生命周期）', () => {
  withRoot((root) => {
    const t0 = Date.parse('2026-11-08T02:00:00.000Z');
    const staleAfterMs = 1_000;
    const first = acquireLease({
      projectRoot: root,
      stackId: 'stack-3',
      ports: PORTS,
      instanceId: 'lane/a',
      now: t0,
      staleAfterMs,
    });
    const later = t0 + 5_000;
    const second = acquireLease({
      projectRoot: root,
      stackId: 'stack-3',
      ports: PORTS,
      instanceId: 'lane/a',
      now: later,
      staleAfterMs,
    });
    assert.notEqual(second.startedAt, first.startedAt);
    assert.equal(second.startedAt, new Date(later).toISOString());
  });
});

test('acquireLease 拒绝空 ports / 非法端口值 / 缺 instanceId（租约必须能证明是谁写的）', () => {
  withRoot((root) => {
    assert.throws(() => acquireLease({ projectRoot: root, stackId: 'stack-1', ports: {}, instanceId: 'x' }), TypeError);
    assert.throws(
      () => acquireLease({ projectRoot: root, stackId: 'stack-1', ports: { cp: -1 }, instanceId: 'x' }),
      TypeError,
    );
    assert.throws(() => acquireLease({ projectRoot: root, stackId: 'stack-1', ports: PORTS }), TypeError);
    assert.throws(
      () => acquireLease({ projectRoot: root, stackId: 'stack-1', ports: PORTS, instanceId: '' }),
      TypeError,
    );
  });
});

// ── read ────────────────────────────────────────────────────────────────────

test('readLease：文件不存在 → {lease:null, corrupt:false}（正常「没起过」）', () => {
  withRoot((root) => {
    assert.deepEqual(readLease(leasePath(root, 'stack-4')), { lease: null, corrupt: false });
  });
});

test('readLease：坏 JSON 不抛，降级为 corrupt（交调用方判 stale）', () => {
  withRoot((root) => {
    const path = leasePath(root, 'stack-3');
    mkdirSync(join(root, '.xihe-stacks', '3'), { recursive: true });
    writeFileSync(path, '{ not json', 'utf8');
    assert.deepEqual(readLease(path), { lease: null, corrupt: true });
  });
});

test('readLease：未知 version 视为不可用（corrupt），不猜语义', () => {
  withRoot((root) => {
    const path = leasePath(root, 'stack-3');
    mkdirSync(join(root, '.xihe-stacks', '3'), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...freshLease(Date.now()), version: 99 }), 'utf8');
    assert.deepEqual(readLease(path), { lease: null, corrupt: true });
  });
});

test('readLease：acquire 后能原样读回', () => {
  withRoot((root) => {
    const now = Date.parse('2026-11-08T02:00:00.000Z');
    const written = acquireLease({
      projectRoot: root,
      stackId: 'stack-3',
      ports: PORTS,
      pids: PIDS_ALL,
      instanceId: 'lane/a',
      now,
    });
    assert.deepEqual(readLease(leasePath(root, 'stack-3')), { lease: written, corrupt: false });
  });
});

// ── renew / release / releaseFailed ─────────────────────────────────────────

test('renewLease 刷心跳但保留 startedAt 与所有声明字段；无租约时 renewed=false', () => {
  withRoot((root) => {
    const t0 = Date.parse('2026-11-08T02:00:00.000Z');
    const first = acquireLease({
      projectRoot: root,
      stackId: 'stack-3',
      ports: PORTS,
      pids: PIDS_ALL,
      instanceId: 'lane/a',
      cpVersion: 'abc1234',
      now: t0,
    });
    const { lease, renewed } = renewLease({ projectRoot: root, stackId: 'stack-3', now: t0 + 30_000 });
    assert.equal(renewed, true);
    assert.equal(lease.startedAt, first.startedAt);
    assert.equal(lease.heartbeatAt, new Date(t0 + 30_000).toISOString());
    assert.deepEqual(lease.pids, first.pids, 'renew 不得悄悄改事实快照');
    assert.equal(lease.cpVersion, 'abc1234');
    assert.deepEqual(renewLease({ projectRoot: root, stackId: 'stack-5' }), { lease: null, renewed: false });
  });
});

test('releaseLease 只删 lease.json，不删同目录其它文件、不删目录', () => {
  withRoot((root) => {
    acquireLease({ projectRoot: root, stackId: 'stack-3', ports: PORTS, instanceId: 'lane/a' });
    const sibling = join(root, '.xihe-stacks', '3', 'keep.txt');
    writeFileSync(sibling, 'logs stay\n', 'utf8');
    assert.deepEqual(releaseLease({ projectRoot: root, stackId: 'stack-3' }), { removed: true });
    assert.equal(existsSync(leasePath(root, 'stack-3')), false);
    assert.equal(existsSync(sibling), true);
    assert.equal(existsSync(join(root, '.xihe-stacks', '3')), true);
    assert.deepEqual(releaseLease({ projectRoot: root, stackId: 'stack-3' }), { removed: false });
  });
});

test('releaseLease 对损坏租约也清得掉（corrupt 不等于「没有」）', () => {
  withRoot((root) => {
    const path = leasePath(root, 'stack-3');
    mkdirSync(join(root, '.xihe-stacks', '3'), { recursive: true });
    writeFileSync(path, 'garbage', 'utf8');
    assert.deepEqual(releaseLease({ projectRoot: root, stackId: 'stack-3' }), { removed: true });
    assert.equal(existsSync(path), false);
  });
});

test('markReleaseFailed：保留租约并打标（不许静默删），再次 release 才清掉', () => {
  withRoot((root) => {
    const t0 = Date.parse('2026-11-08T02:00:00.000Z');
    acquireLease({ projectRoot: root, stackId: 'stack-3', ports: PORTS, pids: PIDS_ALL, instanceId: 'lane/a', now: t0 });
    const { lease, marked } = markReleaseFailed({
      projectRoot: root,
      stackId: 'stack-3',
      services: ['runtime'],
      reason: 'residual listener',
      now: t0 + 1_000,
    });
    assert.equal(marked, true);
    assert.deepEqual(lease.releaseFailed.services, ['runtime']);
    assert.equal(existsSync(leasePath(root, 'stack-3')), true, '租约必须还在');
    assert.deepEqual(readLease(leasePath(root, 'stack-3')).lease.releaseFailed, lease.releaseFailed);
    assert.equal(isShapedLease(readLease(leasePath(root, 'stack-3')).lease), true, '带标记的租约仍是合法形状');
    assert.deepEqual(markReleaseFailed({ projectRoot: root, stackId: 'stack-9' }), { lease: null, marked: false });
    releaseLease({ projectRoot: root, stackId: 'stack-3' });
    assert.equal(existsSync(leasePath(root, 'stack-3')), false);
  });
});

// ── computeVerdict：四值正反例 ───────────────────────────────────────────────

test('healthy：租约 fresh + 期望端口全由 own 持有 + 进程 alive', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const result = computeVerdict({ lease: freshLease(now), listeners: { own: OWN_ALL }, pidAlive: true, now });
  assert.equal(result.verdict, 'healthy');
  assert.equal(result.leaseFresh, true);
  assert.deepEqual(result.missingPorts, []);
  assert.ok(result.reasons.includes('ports-own:12650,12651,12652,12653,12654'));
});

test('healthy 反例：缺一个端口 → stale（半起），missingPorts 指名道姓', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const own = OWN_ALL.filter((entry) => entry.port !== 12653);
  const result = computeVerdict({ lease: freshLease(now), listeners: { own }, pidAlive: true, now });
  assert.equal(result.verdict, 'stale');
  assert.deepEqual(result.missingPorts, [12653]);
  assert.ok(result.reasons.includes('ports-missing:12653'));
});

test('healthy 反例：心跳过期 → stale（即使端口全在听也不得判 healthy）', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const lease = freshLease(now - DEFAULT_STALE_AFTER_MS - 1_000);
  const result = computeVerdict({ lease, listeners: { own: OWN_ALL }, pidAlive: true, now });
  assert.equal(result.verdict, 'stale');
  assert.equal(result.leaseFresh, false);
  assert.ok(result.reasons.includes('lease-expired'));
});

test('orphan：租约有效 + 记录进程全死 + 本栈端口仍在听（案例②）', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const result = computeVerdict({ lease: freshLease(now), listeners: { own: OWN_ALL }, pidAlive: false, now });
  assert.equal(result.verdict, 'orphan');
  assert.ok(result.reasons.includes('lease-pid-dead'));
  assert.ok(result.reasons.includes('own-listener-alive:12650,12651,12652,12653,12654'));
});

test('stale：租约有效 + 进程全死 + 无 own 监听（死栈，租约是过期意图）', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const result = computeVerdict({ lease: freshLease(now), listeners: { own: [] }, pidAlive: false, now });
  assert.equal(result.verdict, 'stale');
  assert.ok(result.reasons.includes('lease-pid-dead'));
  assert.ok(result.reasons.includes('no-own-listener'));
});

test('ghost：无租约 + 本栈端口被画像匹配进程占用（案例①）', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const result = computeVerdict({
    lease: null,
    listeners: { own: [{ port: 12651, pid: 9001, service: 'cp' }] },
    pidAlive: false,
    now,
  });
  assert.equal(result.verdict, 'ghost');
  assert.ok(result.reasons.includes('lease-missing'));
  assert.ok(result.reasons.includes('own-listener-without-valid-lease:12651'));
});

test('ghost：租约文件损坏 + own 监听仍在 → ghost（形状不可用 = 意图层不存在）', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const byCorrupt = computeVerdict({ lease: null, corrupt: true, listeners: { own: OWN_ALL }, pidAlive: false, now });
  assert.equal(byCorrupt.verdict, 'ghost');
  assert.ok(byCorrupt.reasons.includes('lease-corrupt'));
});

test('心跳过期但形状可用：不升级为 ghost（pid 活 → stale；pid 死 + 端口在听 → orphan）', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const expired = freshLease(now - DEFAULT_STALE_AFTER_MS - 1_000);
  const pidAlive = computeVerdict({ lease: expired, listeners: { own: OWN_ALL }, pidAlive: true, now });
  assert.equal(pidAlive.verdict, 'stale', '长跑栈心跳链路坏 ≠ 幽灵栈');
  assert.ok(pidAlive.reasons.includes('lease-expired'));
  const pidDead = computeVerdict({ lease: expired, listeners: { own: OWN_ALL }, pidAlive: false, now });
  assert.equal(pidDead.verdict, 'orphan', 'pid 死 + 端口活仍是 orphan，租约过期只影响 healthy 门槛');
});

test('null：无租约且无 own 监听 = 该栈未运行（四值不描述「什么都没发生」）', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const result = computeVerdict({ lease: null, listeners: { own: [], external: [] }, pidAlive: false, now });
  assert.equal(result.verdict, null);
  assert.ok(result.reasons.includes('no-own-listener'));
});

// ── computeVerdict：外部占用不参与四值 ──────────────────────────────────────

test('外部进程占本栈端口不参与四值：只有 external 时判 null 并作附注', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const result = computeVerdict({
    lease: null,
    listeners: { own: [], external: [{ port: 12723, pid: 71336, cmdline: 'node FB02 vite' }] },
    pidAlive: false,
    now,
  });
  assert.equal(result.verdict, null, '别人家的占用不得让本栈变成 ghost');
  assert.deepEqual(result.externalPorts, [12723]);
  assert.ok(result.reasons.includes('external-ports:12723'));
});

test('healthy 与 external 并存：verdict 不变，external 只作附注', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const result = computeVerdict({
    lease: freshLease(now),
    listeners: { own: OWN_ALL, external: [{ port: 12655, pid: 1 }] },
    pidAlive: true,
    now,
  });
  assert.equal(result.verdict, 'healthy');
  assert.deepEqual(result.externalPorts, [12655]);
  assert.deepEqual(result.ownPorts, [12650, 12651, 12652, 12653, 12654]);
});

// ── crossCheckLease：逐字段核对（批 2 硬要求）─────────────────────────────────

test('cross-check 正例：全部声明字段核对通过 → allOk（含反斜杠/大小写归一化）', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const result = crossCheckLease({ lease: freshLease(now), facts: factsFor(now) });
  assert.equal(result.allOk, true);
  assert.deepEqual(result.mismatches, []);
  assert.ok(result.checks.some((check) => check.field === 'instanceId' && check.code === 'ok'));
  assert.ok(result.checks.some((check) => check.field === 'ports.cp.bind' && check.code === 'ok'));
  assert.ok(result.checks.some((check) => check.field === 'pids.cp.owns-port' && check.code === 'ok'));
  assert.ok(result.checks.some((check) => check.field === 'cpVersion' && check.code === 'ok'));
});

test('cross-check 负例①：pid 死（launcher/listener 记录都已不存在）→ launcher-dead + listener-dead', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const facts = factsFor(now, { isAlive: (pid) => pid === 222 || pid === 444 });
  const result = crossCheckLease({ lease: freshLease(now), facts });
  assert.equal(result.allOk, false);
  assert.ok(mismatchFields(result).includes('pids.cp.launcher:launcher-dead'));
  assert.ok(mismatchFields(result).includes('pids.agent.launcher:launcher-dead'));
  assert.ok(!mismatchFields(result).some((entry) => entry.startsWith('pids.cp.listener')));
});

test('cross-check 负例②：端口没听 → port-not-listening（declare 的端口无 own 监听）', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const facts = factsFor(now, { listeners: { own: OWN_ALL.filter((entry) => entry.port !== 12652) } });
  const result = crossCheckLease({ lease: freshLease(now), facts });
  assert.equal(result.allOk, false);
  assert.ok(mismatchFields(result).includes('ports.agent.bind:port-not-listening'));
});

test('cross-check 负例③：心跳旧 → lease-expired（端口全在听也不算通过）', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const lease = freshLease(now - DEFAULT_STALE_AFTER_MS - 1_000);
  const result = crossCheckLease({ lease, facts: factsFor(now) });
  assert.equal(result.allOk, false);
  assert.ok(mismatchFields(result).includes('heartbeatAt:lease-expired'));
});

test('cross-check 负例④：owner（instanceId）不符 → instance-mismatch（别人的租约不得当自己的）', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const facts = factsFor(now, { instanceId: 'another-host@h:/other' });
  const result = crossCheckLease({ lease: freshLease(now), facts });
  assert.equal(result.allOk, false);
  assert.deepEqual(mismatchFields(result), ['instanceId:instance-mismatch']);
});

test('cross-check 负例⑤：cpVersion 不符 → cp-version-mismatch（跑的不是租约声明的版本）', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const facts = factsFor(now, { cpVersion: 'deadbee' });
  const result = crossCheckLease({ lease: freshLease(now), facts });
  assert.equal(result.allOk, false);
  assert.deepEqual(mismatchFields(result), ['cpVersion:cp-version-mismatch']);
});

test('cross-check 负例⑥：pid 漂移（端口换了持有者）→ pid-drift（案例②：launcher fork 换了 pid）', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const drifted = OWN_ALL.map((entry) => (entry.port === 12651 ? { ...entry, pid: 9999 } : entry));
  const facts = factsFor(now, { listeners: { own: drifted } });
  const result = crossCheckLease({ lease: freshLease(now), facts });
  assert.equal(result.allOk, false);
  assert.deepEqual(mismatchFields(result), ['pids.cp.owns-port:pid-drift']);
});

test('cross-check：声明了 cpVersion 但当前核不了 → unverifiable（拦 healthy，不是 skipped）', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const facts = factsFor(now, { cpVersion: null });
  const result = crossCheckLease({ lease: freshLease(now), facts });
  assert.equal(result.allOk, false, '声明了却核不了 ≠ 通过');
  assert.deepEqual(result.unverifiable, ['cpVersion']);
  assert.deepEqual(result.mismatches, []);
});

test('cross-check：没声明 cpVersion/pids 的字段 → skipped（absent claims are fine，不拦 healthy）', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const result = crossCheckLease({ lease: freshLease(now, { pids: {}, cpVersion: null }), facts: factsFor(now) });
  assert.equal(result.allOk, true);
  assert.ok(result.skipped.includes('cpVersion'));
  assert.ok(result.skipped.includes('pids.cp'));
  assert.equal(result.checks.some((check) => check.field === 'cpVersion' && check.code === 'ok'), false);
});

test('cross-check 负例⑦：releaseFailed 标记存在 → release-failed（上次 stop 留了尾巴）', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const lease = freshLease(now, {
    releaseFailed: { at: new Date(now).toISOString(), services: ['runtime'], reason: 'residual listener' },
  });
  const result = crossCheckLease({ lease, facts: factsFor(now) });
  assert.equal(result.allOk, false);
  assert.ok(mismatchFields(result).includes('releaseFailed:release-failed'));
});

test('cross-check：租约缺失/形状坏时不给假 pass（shape 一条 blocking）', () => {
  const result = crossCheckLease({ lease: null, facts: factsFor(Date.now()) });
  assert.equal(result.allOk, false);
  assert.deepEqual(mismatchFields(result), ['shape:lease-missing']);
  const unshaped = crossCheckLease({ lease: { ...freshLease(Date.now()), version: 1 }, facts: factsFor(Date.now()) });
  assert.deepEqual(mismatchFields(unshaped), ['shape:lease-unusable']);
});

// ── healthy 的必要条件：checks 全绿 ─────────────────────────────────────────

test('checks 全绿 + 端口齐 + 进程活 + 心跳新 → healthy（并打 fields-verified）', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const checks = crossCheckLease({ lease: freshLease(now), facts: factsFor(now) }).checks;
  const result = computeVerdict({ lease: freshLease(now), listeners: { own: OWN_ALL }, pidAlive: true, now, checks });
  assert.equal(result.verdict, 'healthy');
  assert.ok(result.reasons.includes('fields-verified'));
});

test('checks 有 blocking mismatch + 其余全绿 → 不是 healthy（降 stale，reasons 指名）', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const checks = crossCheckLease({ lease: freshLease(now), facts: factsFor(now, { cpVersion: 'deadbee' }) }).checks;
  const result = computeVerdict({ lease: freshLease(now), listeners: { own: OWN_ALL }, pidAlive: true, now, checks });
  assert.equal(result.verdict, 'stale');
  assert.ok(result.reasons.includes('fields-mismatch:cp-version-mismatch'));
  assert.deepEqual(result.fieldMismatches, ['cp-version-mismatch']);
});
