#!/usr/bin/env node
/**
 * PLAN-0694 T2.1 — 租约三案例回归（可重跑序列）
 *
 * 一条命令跑完：`node --test scripts/lib/stack-lease-three-cases.test.mjs`
 *
 * 案例 A（ghost）：伪造「租约不存在」+ 注入 listener 表（本栈端口仍被画像匹配进程持有）
 *                 ⇒ 期望 `verdict=ghost` + `own-listener-without-valid-lease:*`
 * 案例 B（orphan）：伪造「租约形状可用但进程全死」+ 注入 listener 表（端口仍在听）
 *                 ⇒ 期望 `verdict=orphan` + `lease-pid-dead` + `own-listener-alive:*`
 * 案例 C（真栈只读）：`node scripts/dev-stack.mjs status --all --json`
 *                 ⇒ 期望每栈 `verdict=healthy` / `lease.mismatch=[]` / `cpBuild.verdict=fresh`
 * 附加案例 A2：伪造租约字段（把 cp 端口改错）⇒ `crossCheckLease` 必须指名
 *                 `ports.cp:port-declared-mismatch`，且 verdict 不得 healthy（字段可写不可自述）
 *
 * 纪律：案例 A/A2/B 全部靠**入参**（注入 listener 表 / 伪造租约），不依赖 1263x 真端口、
 * 不起/不停/不重启任何栈、不写 `.xihe-stacks/`；只有案例 C 读真栈，且是**只读** status。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_LEASE_PHASE, LEASE_VERSION, computeVerdict, crossCheckLease } from './stack-lease.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 案例 C 必须在**主检出**跑：租约在 gitignored 的 `.xihe-stacks/` 里，每个 worktree 各一套；
 * 在 lane 里跑会看到"无租约 + 端口在听"⇒ ghost（那是 lane 自己的空租约面，不是真栈结论）。
 * 主检出路径由 `git worktree list --porcelain` 的第一条解析，避免写死机器路径。
 */
function resolveMainCheckout() {
  const run = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  if (run.status !== 0) return null;
  const first = run.stdout.split(/\r?\n/).find((line) => line.startsWith('worktree '));
  return first ? first.slice('worktree '.length).trim() : null;
}

// 注入用的「虚构栈」：端口取 12650–12654（与真栈同形状但不落任何真端口，避免依赖 1263x）。
const PORTS = { ui: 12650, cp: 12651, agent: 12652, runtime: 12653, postgres: 12654 };
const OWN_ALL = [
  { port: 12650, pid: 111, service: 'ui' },
  { port: 12651, pid: 222, service: 'cp' },
  { port: 12652, pid: 333, service: 'agent' },
  { port: 12653, pid: 444, service: 'runtime' },
  { port: 12654, pid: 555, service: 'postgres' },
];
const PIDS_ALL = {
  cp: { launcher: 2220, listener: 222 },
  runtime: { launcher: 4440, listener: 444 },
  agent: { launcher: 3330, listener: 333 },
  ui: { launcher: 1110, listener: 111 },
  postgres: { launcher: null, listener: 555 },
};

function fakeLease(now, overrides = {}) {
  return {
    version: LEASE_VERSION,
    instanceId: 'host-a@h:/repo',
    projectRoot: 'H:/repo',
    stackId: 'stack-3',
    phase: DEFAULT_LEASE_PHASE,
    ports: { ...PORTS },
    pids: structuredClone(PIDS_ALL),
    cpVersion: 'abc1234',
    startedAt: new Date(now - 60_000).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
    ...overrides,
  };
}

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

/** 一条「命令 → 期望 → 实测」的可读证据行（T2.1 验收表就靠它）。 */
function reportRow(id, name, expected, actual) {
  const ok = expected === actual ? '一致' : '不一致';
  console.log(`CASE ${id} ${name} | 期望=${expected} | 实测=${actual} | ${ok}`);
}

test('案例 A（ghost）：无租约 + 注入 listener 表（端口仍在听）⇒ verdict=ghost', () => {
  const now = Date.parse('2026-11-08T07:00:00.000Z');
  // 伪造：租约文件不存在（lease=null, corrupt=false），但注入表声明本栈端口仍被持有。
  const verdict = computeVerdict({ lease: null, listeners: { own: OWN_ALL }, pidAlive: false, now });
  reportRow('A', '无租约+注入listener', 'ghost', verdict.verdict);
  assert.equal(verdict.verdict, 'ghost', `实测 ${verdict.verdict}，reasons=${verdict.reasons.join('|')}`);
  assert.ok(verdict.reasons.includes('lease-missing'), `reasons 缺 lease-missing: ${verdict.reasons.join('|')}`);
  assert.ok(
    verdict.reasons.some((reason) => reason.startsWith('own-listener-without-valid-lease:')),
    `reasons 缺 own-listener-without-valid-lease: ${verdict.reasons.join('|')}`,
  );
  assert.deepEqual(verdict.ownPorts, [12650, 12651, 12652, 12653, 12654]);
  assert.equal(verdict.leaseState, null);
});

test('案例 A′（ghost）：租约损坏（corrupt）同理降级 ⇒ reasons 带 lease-corrupt', () => {
  const now = Date.parse('2026-11-08T07:00:00.000Z');
  const verdict = computeVerdict({ lease: null, corrupt: true, listeners: { own: OWN_ALL }, now });
  reportRow('A′', '租约损坏+注入listener', 'ghost', verdict.verdict);
  assert.equal(verdict.verdict, 'ghost');
  assert.ok(verdict.reasons.includes('lease-corrupt'), `reasons=${verdict.reasons.join('|')}`);
});

test('案例 B（orphan）：租约形状可用但进程全死 + 注入 listener 表（端口仍在听）⇒ verdict=orphan', () => {
  const now = Date.parse('2026-11-08T07:00:00.000Z');
  // 伪造：租约「自述」本栈在跑，但 pidAlive=false（进程已死）；注入表证明端口仍被本栈画像进程持有。
  const verdict = computeVerdict({
    lease: fakeLease(now),
    listeners: { own: OWN_ALL },
    pidAlive: false,
    now,
  });
  reportRow('B', '租约可用+进程死+注入listener', 'orphan', verdict.verdict);
  assert.equal(verdict.verdict, 'orphan', `实测 ${verdict.verdict}，reasons=${verdict.reasons.join('|')}`);
  assert.ok(verdict.reasons.includes('lease-pid-dead'));
  assert.ok(verdict.reasons.some((reason) => reason.startsWith('own-listener-alive:')));
});

test('附加 A2（伪造租约字段）：把 cp 端口改错 ⇒ 必须指名 ports.cp:port-declared-mismatch，且不得 healthy', () => {
  const now = Date.parse('2026-11-08T07:00:00.000Z');
  const tampered = fakeLease(now, { ports: { ...PORTS, cp: 9_999 } });
  const checks = crossCheckLease({ lease: tampered, facts: factsFor(now) });
  const mismatchFields = checks.mismatches.map((entry) => `${entry.field}:${entry.code}`);
  reportRow('A2', '伪租约字段(port篡改)', 'ports.cp:port-declared-mismatch', mismatchFields.includes('ports.cp:port-declared-mismatch') ? 'ports.cp:port-declared-mismatch' : '(无)');
  assert.ok(
    mismatchFields.includes('ports.cp:port-declared-mismatch'),
    `mismatch 内容不对：${JSON.stringify(mismatchFields)}`,
  );
  // 语义钉死：`expected` = 事实面（facts.expectedPorts，真值），`actual` = 租约声明（伪造值）。
  const cpMismatch = checks.mismatches.find((entry) => entry.field === 'ports.cp');
  assert.equal(cpMismatch.expected, 12651, 'expected 应取自事实面（fact listener 表 12651）');
  assert.equal(cpMismatch.actual, 9_999, 'actual 应取自伪造租约声明（9999）');

  // 同一份伪造租约喂给 computeVerdict：声明端口 9999 不在 listener 表里 ⇒ 缺端口 ⇒ stale（绝不 healthy）。
  const verdict = computeVerdict({ lease: tampered, listeners: { own: OWN_ALL }, pidAlive: true, now, checks: checks.checks });
  reportRow('A2v', '伪租约字段(port篡改)', 'stale', verdict.verdict);
  assert.equal(verdict.verdict, 'stale', `实测 ${verdict.verdict}，reasons=${verdict.reasons.join('|')}`);
  assert.deepEqual(verdict.missingPorts, [9_999]);
  assert.ok(verdict.reasons.includes('ports-missing:9999'), `reasons=${verdict.reasons.join('|')}`);
});

test('案例 C（真栈只读）：status --all --json ⇒ 每栈 healthy / mismatch=[] / cpBuild=fresh', () => {
  const mainCheckout = resolveMainCheckout();
  assert.ok(mainCheckout, 'git worktree list 解析不到主检出路径');
  console.log(`CASE C cwd=${mainCheckout}（主检出；lane 的 .xihe-stacks 是独立空租约面）`);
  const run = spawnSync(process.execPath, ['scripts/dev-stack.mjs', 'status', '--all', '--json'], {
    cwd: mainCheckout,
    encoding: 'utf8',
    timeout: 120_000,
  });
  console.log(`CASE C cmd 期望=healthy/mismatch=[]/fresh 实测=(见下) exit=${run.status}`);
  assert.equal(run.error, undefined, `spawn 失败：${run.error?.message}`);
  assert.equal(run.status, 0, `exit=${run.status}，stdout=${(run.stdout || '').slice(0, 600)}，stderr=${(run.stderr || '').slice(0, 400)}`);

  let doc;
  try {
    doc = JSON.parse(run.stdout);
  } catch (error) {
    assert.fail(`stdout 不是 JSON：${error.message}；前 200 字=${run.stdout.slice(0, 200)}`);
  }
  assert.ok(Array.isArray(doc.stacks) && doc.stacks.length >= 2, `stacks 数=${doc.stacks?.length}`);

  for (const stack of doc.stacks) {
    const mismatch = stack?.lease?.mismatch ?? null;
    const core = `verdict=${stack?.verdict} / mismatch=${JSON.stringify(mismatch)} / cpBuild=${stack?.cpBuild?.verdict}`;
    reportRow('C', `${stack?.stackId} 真栈`, 'verdict=healthy / mismatch=[] / cpBuild=fresh', core);
    console.log(`  └ ${stack?.stackId} 附注：dirty=${stack?.cpBuild?.dirty} behind=${stack?.cpBuild?.behind} lease.state=${stack?.lease?.state} owner=${stack?.lease?.owner ?? '(none)'}`);
    assert.ok(
      stack && typeof stack.stackId === 'string',
      `缺失 stackId：${JSON.stringify(stack)?.slice(0, 200)}`,
    );
    assert.equal(stack.verdict, 'healthy', `${stack.stackId} verdict=${stack.verdict}（现场不满足 ⇒ T2.1 案例 C 不成立）`);
    assert.deepEqual(mismatch, [], `${stack.stackId} lease.mismatch=${JSON.stringify(mismatch)}`);
    assert.equal(stack.cpBuild?.verdict, 'fresh', `${stack.stackId} cpBuild.verdict=${stack.cpBuild?.verdict}`);
    assert.deepEqual(stack.cpBuild?.dirty, false, `${stack.stackId} cpBuild.dirty=${stack.cpBuild?.dirty}`);
  }
  console.log(`CASE C 真栈 ${doc.stacks.map((stack) => stack.stackId).join(' + ')} 全部 healthy/fresh（${doc.stacks.length}/${doc.stacks.length}）`);
});
