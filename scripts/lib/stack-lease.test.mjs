/**
 * PLAN-0694 T1.1 — `stack-lease.mjs` 单测。
 *
 * 纪律（这是「纯函数库」的守卫）：
 * - **不绑端口、不起进程、不 kill**：所有事实（listeners / pidAlive）都是入参，verdict 是纯计算；
 * - **不写真实 `.xihe-stacks/`**：一律 `mkdtempSync(join(tmpdir(), 'xihe-lease-'))`，测完删除；
 * - 每个 test 独立 root，互不共享状态（可并行跑）。
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
  leasePath,
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
    stackId: 'stack-3',
    pid: 4242,
    startedAt: new Date(now - 60_000).toISOString(),
    owner: 'lane/test',
    ports: { ...PORTS },
    heartbeatAt: new Date(now).toISOString(),
    version: LEASE_VERSION,
    ...overrides,
  };
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

test('acquireLease 写出七字段形状（version 固定 LEASE_VERSION）', () => {
  withRoot((root) => {
    const now = Date.parse('2026-11-08T02:00:00.000Z');
    const lease = acquireLease({ projectRoot: root, stackId: 'stack-3', ports: PORTS, owner: 'lane/test', pid: 4242, now });
    assert.deepEqual(Object.keys(lease).sort(), [
      'heartbeatAt',
      'owner',
      'pid',
      'ports',
      'stackId',
      'startedAt',
      'version',
    ]);
    assert.equal(lease.version, LEASE_VERSION);
    assert.equal(lease.pid, 4242);
    assert.equal(lease.stackId, 'stack-3');
    assert.equal(lease.startedAt, new Date(now).toISOString());
    assert.deepEqual(lease.ports, PORTS);
    const onDisk = JSON.parse(readFileSync(leasePath(root, 'stack-3'), 'utf8'));
    assert.deepEqual(onDisk, lease);
  });
});

test('重复 acquire 保留首启 startedAt，只刷新 heartbeatAt（幂等，不洗掉栈年龄）', () => {
  withRoot((root) => {
    const t0 = Date.parse('2026-11-08T02:00:00.000Z');
    const first = acquireLease({ projectRoot: root, stackId: 'stack-3', ports: PORTS, owner: 'lane/a', pid: 1, now: t0 });
    const second = acquireLease({
      projectRoot: root,
      stackId: 'stack-3',
      ports: PORTS,
      owner: 'lane/b',
      pid: 2,
      now: t0 + 60_000,
    });
    assert.equal(second.startedAt, first.startedAt);
    assert.equal(second.heartbeatAt, new Date(t0 + 60_000).toISOString());
    assert.equal(second.pid, 2, 'pid 与 owner 应被最新一次 acquire 覆盖');
    assert.equal(second.owner, 'lane/b');
  });
});

test('过期租约上的 acquire 重置 startedAt（旧租约不再代表同一次生命周期）', () => {
  withRoot((root) => {
    const t0 = Date.parse('2026-11-08T02:00:00.000Z');
    const staleAfterMs = 1_000;
    const first = acquireLease({ projectRoot: root, stackId: 'stack-3', ports: PORTS, owner: 'lane/a', pid: 1, now: t0, staleAfterMs });
    const later = t0 + 5_000;
    const second = acquireLease({ projectRoot: root, stackId: 'stack-3', ports: PORTS, owner: 'lane/a', pid: 9, now: later, staleAfterMs });
    assert.notEqual(second.startedAt, first.startedAt);
    assert.equal(second.startedAt, new Date(later).toISOString());
  });
});

test('acquireLease 拒绝空 ports / 非数值 pid', () => {
  withRoot((root) => {
    assert.throws(() => acquireLease({ projectRoot: root, stackId: 'stack-1', ports: {}, owner: 'x', pid: 1 }), TypeError);
    assert.throws(
      () => acquireLease({ projectRoot: root, stackId: 'stack-1', ports: PORTS, owner: 'x', pid: Number.NaN }),
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
    const written = acquireLease({ projectRoot: root, stackId: 'stack-3', ports: PORTS, owner: 'lane/a', pid: 7, now });
    assert.deepEqual(readLease(leasePath(root, 'stack-3')), { lease: written, corrupt: false });
  });
});

// ── renew / release ─────────────────────────────────────────────────────────

test('renewLease 刷心跳但保留 startedAt；无租约时 renewed=false', () => {
  withRoot((root) => {
    const t0 = Date.parse('2026-11-08T02:00:00.000Z');
    const first = acquireLease({ projectRoot: root, stackId: 'stack-3', ports: PORTS, owner: 'lane/a', pid: 5, now: t0 });
    const { lease, renewed } = renewLease({ projectRoot: root, stackId: 'stack-3', now: t0 + 30_000 });
    assert.equal(renewed, true);
    assert.equal(lease.startedAt, first.startedAt);
    assert.equal(lease.heartbeatAt, new Date(t0 + 30_000).toISOString());
    assert.deepEqual(renewLease({ projectRoot: root, stackId: 'stack-5' }), { lease: null, renewed: false });
  });
});

test('releaseLease 只删 lease.json，不删同目录其它文件、不删目录', () => {
  withRoot((root) => {
    acquireLease({ projectRoot: root, stackId: 'stack-3', ports: PORTS, owner: 'lane/a', pid: 8 });
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

// ── computeVerdict：四值正反例 ───────────────────────────────────────────────

test('healthy：租约 fresh + 期望端口全由 own 持有 + pid alive', () => {
  withRoot(() => {
    const now = Date.parse('2026-11-08T02:00:00.000Z');
    const result = computeVerdict({ lease: freshLease(now), listeners: { own: OWN_ALL }, pidAlive: true, now });
    assert.equal(result.verdict, 'healthy');
    assert.equal(result.leaseFresh, true);
    assert.deepEqual(result.missingPorts, []);
    assert.ok(result.reasons.includes('ports-own:12650,12651,12652,12653,12654'));
  });
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

test('orphan：租约有效 + 租约 pid 已死 + 本栈端口仍在听（案例②）', () => {
  const now = Date.parse('2026-11-08T02:00:00.000Z');
  const result = computeVerdict({ lease: freshLease(now), listeners: { own: OWN_ALL }, pidAlive: false, now });
  assert.equal(result.verdict, 'orphan');
  assert.ok(result.reasons.includes('lease-pid-dead'));
  assert.ok(result.reasons.includes('own-listener-alive:12650,12651,12652,12653,12654'));
});

test('stale：租约有效 + pid 已死 + 无 own 监听（死栈，租约是过期意图）', () => {
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
