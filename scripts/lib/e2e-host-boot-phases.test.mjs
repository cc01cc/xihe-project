#!/usr/bin/env node
/**
 * 接线级测试（task-86 第五形态）：断言**真实 runner 的相位顺序**，而不是手工复刻的接线。
 *
 * 为什么需要这一份：`e2e-preflight-gate.test.mjs` 的 T1/T2/T6 用 `simulateRun()` 复刻
 * `e2e-host.mjs main()` 的接线，断言对象是「库函数 + 复刻逻辑」。2026-11-08 实测：把
 * `runPreflightGate()` 挪到 `resolveCpBootPlan()`（内含 mvn 重建）之前——也就是 PLAN-0680 缺陷 ①
 * 复发——`node --test "scripts/lib/*.test.mjs"` 仍然 **270/270 全绿**。复刻逻辑不会被真实接线的
 * 漂移带红。
 *
 * 这里换成两条真正的判据：
 *   T1–T4：顺序的**单源**（`bootPhasePlan()`）与运行时游标（`createBootPhaseCursor()`）——
 *          游标就是 `main()` 里那两个 `enter()` 调用的同一条实现；
 *   T5–T7：**行为级**——真的跑 `node scripts/e2e-host.mjs --plan-only`，由 runner 自己打印
 *          declared（计划）vs executed（实际进入顺序）。`--plan-only` 走的就是生产路径上那两条
 *          `enter()` 语句，所以把 gate 连同 `enter()` 一起搬走 ⇒ executed 变形 ⇒ 本文件红。
 *
 * 反面口径（task-86 明确不接受的糊法）：读源码正则匹配行号。这里一个字符都没读源码。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'

import {
  BOOT_PHASE,
  BootPhaseOrderError,
  bootPhasePlan,
  createBootPhaseCursor,
} from './e2e-host-boot-phases.mjs'

const projectRoot = join(import.meta.dirname, '..', '..')
const hostScript = join(projectRoot, 'scripts', 'e2e-host.mjs')

/**
 * 闸门（2026-11-08 05:29 事故后加，必须有）：本文件的用例会 spawn `e2e-host.mjs`，而 runner 对
 * **不认识的 flag 是透传给 Playwright 的** —— 于是"接缝没装好"时跑这套测试会**真起一整套隔离栈**
 * （当晚实测：pg→CP→agent→runtime→ui 全起，占了 host 端口带约 3 分钟，还把共享 jar 目录重建了一次）。
 * 所以先花一次 `--help`（纯打印、零副作用、立即退出）确认 `--plan-only` 真的存在；
 * 不存在就 **skip 掉三条行为级用例、绝不 spawn** —— 宁可红在"接缝没了"，也不能红在"又起了一套栈"。
 * （`runPlanOnly()` 内部再抛一次，属于纵深防御：任何漏掉 skip 的调用点都不会真跑。）
 */
const SEAM_MISSING = 'e2e-host.mjs 没有 --plan-only（接缝未装/被回退）：本用例拒绝 spawn —— '
  + '未知 flag 会被透传给 Playwright，那样这条用例会真起一套隔离栈。请先把 --plan-only 装回 scripts/e2e-host.mjs 再跑。'

let planOnlyProbe = null
function probePlanOnly() {
  if (!planOnlyProbe) {
    const help = spawnSync(process.execPath, [hostScript, '--help'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 30_000,
    })
    planOnlyProbe = { help, supported: help.status === 0 && /--plan-only/.test(help.stdout ?? '') }
  }
  return planOnlyProbe
}

function assertPlanOnlyAvailable() {
  const probe = probePlanOnly()
  if (!probe.supported) throw new Error(SEAM_MISSING)
  return probe.help
}

/** node:test 的 skip 值：接缝在 ⇒ false（照跑）；不在 ⇒ 一句说明（跳过且不 spawn）。 */
function skipUnlessSeamInstalled() {
  return probePlanOnly().supported ? false : SEAM_MISSING
}

/** 跑一次 `e2e-host.mjs --plan-only`，返回结构化结果（不抛：退出码要能断言）。 */
function runPlanOnly({ externalServer = false } = {}) {
  assertPlanOnlyAvailable()
  const env = { ...process.env }
  if (externalServer) env.XIHE_E2E_EXTERNAL_SERVER = '1'
  else delete env.XIHE_E2E_EXTERNAL_SERVER
  const result = spawnSync(process.execPath, [hostScript, '--plan-only'], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
    // 干跑实测 0.1s；上限收紧到 30s，万一接缝退化也别让一次误跑占满一整分钟。
    timeout: 30_000,
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const jsonLine = stdout.split(/\r?\n/).find((line) => line.includes('plan-only json:'))
  const trace = jsonLine ? JSON.parse(jsonLine.slice(jsonLine.indexOf('plan-only json:') + 'plan-only json:'.length)) : null
  return { status: result.status, signal: result.signal, stdout, stderr, trace }
}

test('T1 计划顺序：owned run 必须"先 CP 重建、后开窗门"；reuse run 没有重建相位', () => {
  assert.deepEqual(bootPhasePlan(), [BOOT_PHASE.CP_BOOT_PLAN, BOOT_PHASE.PREFLIGHT_GATE])
  assert.deepEqual(bootPhasePlan({ externalServer: false }), [BOOT_PHASE.CP_BOOT_PLAN, BOOT_PHASE.PREFLIGHT_GATE])
  // reuse run 本轮不启动自己的产物（栈属于更早的 runId）⇒ 没有重建相位，也就没有"门先锁死"的格。
  assert.deepEqual(bootPhasePlan({ externalServer: true }), [BOOT_PHASE.PREFLIGHT_GATE])
  // 相位名是契约（e2e-host.mjs 的 enter() 与 --plan-only 的输出都靠它）。
  assert.deepEqual(Object.values(BOOT_PHASE), ['cp-boot-plan', 'preflight-gate'])
});

test('T2 正例：按计划进入 ⇒ 游标放行，describe() 的 declared 与 executed 一致', () => {
  const cursor = createBootPhaseCursor()
  assert.deepEqual(cursor.remaining(), [BOOT_PHASE.CP_BOOT_PLAN, BOOT_PHASE.PREFLIGHT_GATE])
  cursor.enter(BOOT_PHASE.CP_BOOT_PLAN)
  assert.deepEqual(cursor.trail(), [BOOT_PHASE.CP_BOOT_PLAN])
  assert.deepEqual(cursor.remaining(), [BOOT_PHASE.PREFLIGHT_GATE])
  assert.equal(cursor.describe().ok, false, '只进了一半不算 ok（那正是某个相位被搬走的形状）')
  cursor.enter(BOOT_PHASE.PREFLIGHT_GATE)
  assert.deepEqual(cursor.describe(), {
    declared: [BOOT_PHASE.CP_BOOT_PLAN, BOOT_PHASE.PREFLIGHT_GATE],
    executed: [BOOT_PHASE.CP_BOOT_PLAN, BOOT_PHASE.PREFLIGHT_GATE],
    ok: true,
    missing: [],
  })
})

test('T3 负例（缺陷 ① 的形状）：门先于重建 ⇒ BootPhaseOrderError，且信息点名"门必须晚于重建"', () => {
  const cursor = createBootPhaseCursor()
  let error = null
  try {
    cursor.enter(BOOT_PHASE.PREFLIGHT_GATE)
  } catch (caught) {
    error = caught
  }
  assert.ok(error instanceof BootPhaseOrderError, `必须是 BootPhaseOrderError，实际 ${error?.name}`)
  assert.equal(error.name, 'BootPhaseOrderError')
  assert.equal(error.attempted, BOOT_PHASE.PREFLIGHT_GATE)
  assert.equal(error.expected, BOOT_PHASE.CP_BOOT_PLAN)
  assert.deepEqual(error.plan, [BOOT_PHASE.CP_BOOT_PLAN, BOOT_PHASE.PREFLIGHT_GATE])
  assert.deepEqual(error.trail, [], '抛错时不能先把违反顺序的相位记进 trail')
  assert.match(error.message, /AFTER the CP boot plan/)
  assert.match(error.message, /plan=\[cp-boot-plan -> preflight-gate\]/)
  assert.match(error.message, /executed=\[\]/)
});

test('T4 负例：同一相位进两次、计划走完后再进 ⇒ 都抛（不许静默忽略）', () => {
  const duplicate = createBootPhaseCursor()
  duplicate.enter(BOOT_PHASE.CP_BOOT_PLAN)
  assert.throws(() => duplicate.enter(BOOT_PHASE.CP_BOOT_PLAN), (error) => {
    assert.ok(error instanceof BootPhaseOrderError)
    assert.equal(error.problem, 'duplicate')
    assert.match(error.message, /entered twice/)
    return true
  })

  const overflow = createBootPhaseCursor()
  overflow.enter(BOOT_PHASE.CP_BOOT_PLAN)
  overflow.enter(BOOT_PHASE.PREFLIGHT_GATE)
  assert.throws(() => overflow.enter(BOOT_PHASE.PREFLIGHT_GATE), (error) => {
    assert.ok(error instanceof BootPhaseOrderError)
    assert.equal(error.problem, 'duplicate')
    return true
  })

  // 计划本身不合法时也不许悄悄放过。
  assert.throws(() => createBootPhaseCursor({ plan: [] }), TypeError)
  assert.throws(() => createBootPhaseCursor({ plan: ['a', 'a'] }), TypeError)
});

test('T5 行为级正例：真跑 --plan-only ⇒ exit 0，declared == executed == 计划，且没跑重活', { skip: skipUnlessSeamInstalled() }, () => {
  const run = runPlanOnly()
  assert.equal(run.signal, null, '不允许被信号杀掉（超时/崩溃）')
  assert.equal(run.status, 0, `--plan-only 必须 exit 0，实际 ${run.status}\n${run.stderr}`)
  assert.ok(run.trace, `必须打印 plan-only json 行：\n${run.stdout}`)
  assert.deepEqual(run.trace, {
    declared: [BOOT_PHASE.CP_BOOT_PLAN, BOOT_PHASE.PREFLIGHT_GATE],
    executed: [BOOT_PHASE.CP_BOOT_PLAN, BOOT_PHASE.PREFLIGHT_GATE],
    ok: true,
    missing: [],
  })
  // 干跑不构建：CP boot 行必须自述是预览（真跑这条会写 "(rebuilt)" / "(stale vs sources; rebuilding …)"）。
  assert.match(run.stdout, /CP boot: .*--plan-only preview \(no rebuild ran\)/)
  assert.doesNotMatch(run.stdout, /mvn -q -DskipTests package/)
  // 干跑不开窗：门的判定没有任何一行输出（`describePreflightGate` / `diskGate` 都不会出现）。
  assert.doesNotMatch(run.stdout, /preflight gate (proceed|refuse)/i)
  assert.doesNotMatch(run.stdout, /diskGate/)
  // 干跑不打印"开始起栈"的分段标记。
  assert.doesNotMatch(run.stdout, /\[e2e-host\] starting isolated postgres/)
});

test('T6 行为级负例（守住 plan-only 自己）：reuse run 用 --plan-only ⇒ 拒绝，不许给出"两相位都绿"的假象', { skip: skipUnlessSeamInstalled() }, () => {
  const run = runPlanOnly({ externalServer: true })
  assert.equal(run.status, 1, '--plan-only 与 reuse 组合必须 exit 1')
  assert.equal(run.trace, null, '拒绝时不许打印 plan-only json（否则调用方会读到假通过）')
  assert.match(run.stderr, /--plan-only dry-runs the owned boot sequence/)
  assert.match(run.stderr, /XIHE_E2E_EXTERNAL_SERVER=1/)
});

test('T7 行为级：--plan-only 出现在 runner 自己的 flag 表里（不会被当成 Playwright 透传参数）', { skip: skipUnlessSeamInstalled() }, () => {
  // 若 --plan-only 未被 runner 消费，它会被透传给 Playwright（本进程根本没走到那步），
  // 但更直接的判据是：help 文本必须写明它，避免下一个人以为没有这个入口。
  const help = assertPlanOnlyAvailable()
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--plan-only\s+dry-run the boot-phase ORDER only/)
  const run = runPlanOnly()
  assert.equal(run.status, 0)
});
