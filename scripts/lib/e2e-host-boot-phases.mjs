#!/usr/bin/env node
/**
 * 真实 runner 的「开窗相位顺序」——顺序变成数据，main() 只是执行器（task-86 第五形态）。
 *
 * 缺陷形状（一手事实，2026-11-08）：`e2e-preflight-gate.test.mjs` 的 T1/T2/T6 用 `simulateRun()`
 * **手工复刻** runner 接线，断言对象是「库函数 + 复刻逻辑」。把 `e2e-host.mjs` 的
 * `runPreflightGate()` 挪回 `resolveCpBootPlan()`（内含 `mvn -q -DskipTests package` 重建）之前
 * ——也就是 `ed1f3dab` 修掉的死锁复发——单测**仍然全绿**：实测漂移 9 行后
 * `node --test "scripts/lib/*.test.mjs"` 依旧 270/270 通过。断言复刻逻辑 ≠ 断言真实接线。
 *
 * 本模块给两件东西，缺一不可：
 *
 * 1. `bootPhasePlan()`：顺序的**唯一来源**（纯数据）。`main()` 不许自己排这两步。
 * 2. `createBootPhaseCursor()`：运行时游标。`main()` 每进入一个相位必须先 `enter(name)`，
 *    与实际计划不符**立即抛 `BootPhaseOrderError`** ⇒ 顺序漂移从"静默回归"变成"第一轮就炸"，
 *    而且错误信息直接点名"gate 必须晚于 CP 重建"。
 *
 * 观测点（行为级，不靠读源码）：`node scripts/e2e-host.mjs --plan-only` 干跑**同一批 `enter()`
 * 语句**（重活短路：不重建、不跑 preflight、不起栈），打印 declared（计划）与 executed（实际进入
 * 顺序）。因为干跑走的就是生产路径上那两条语句，把 gate 连同 `enter()` 一起搬走 ⇒ executed 变形
 * ⇒ `--plan-only` exit 1 ⇒ 单测真的红。`scripts/lib/e2e-host-boot-phases.test.mjs` 的 T5 就是这么
 * 断言的（正例贴输出、负例见 task-86 回报里的漂移实测）。
 */

/** 本轮开窗前必须按序完成的相位（名字是契约，改名字等于改接线，别随手改）。 */
export const BOOT_PHASE = Object.freeze({
  /** 决定本轮启动哪个 CP 产物，并在需要时**先重建**（`resolveCpBootPlan()`）。 */
  CP_BOOT_PLAN: 'cp-boot-plan',
  /** 只读开窗门（`runPreflightGate()`）：必须在重建之后，否则可自愈的陈旧 jar 会把门锁死。 */
  PREFLIGHT_GATE: 'preflight-gate',
})

/**
 * 本轮应跑哪些相位、按什么顺序。
 *
 * reuse run（`XIHE_E2E_EXTERNAL_SERVER=1`）本轮不启动自己的产物、也不重建任何东西
 * （栈属于更早的 runId），所以没有 `cp-boot-plan` 相位——这正是 `ed1f3dab` 之前 2026-11-07
 * 夜里真实锁死的那一格：门去要求一个本轮根本不会启动的 jar。
 *
 * @param {{externalServer?: boolean}} [input]
 * @returns {string[]} 相位名有序数组（新数组，调用方可以放心持有）
 */
export function bootPhasePlan({ externalServer = false } = {}) {
  return externalServer
    ? [BOOT_PHASE.PREFLIGHT_GATE]
    : [BOOT_PHASE.CP_BOOT_PLAN, BOOT_PHASE.PREFLIGHT_GATE]
}

/** 顺序被违反时抛这个（`instanceof` 可判，别指望 message 匹配）。 */
export class BootPhaseOrderError extends Error {
  constructor({ plan, trail, attempted, expected, problem }) {
    const detail = problem === 'duplicate'
      ? `phase "${attempted}" was entered twice`
      : problem === 'overflow'
        ? `phase "${attempted}" was entered after the plan was already complete`
        : `main() entered "${attempted}" where the plan expects "${expected}"`
    super(
      `e2e-host boot phase order violated: ${detail}; the preflight gate must run AFTER the CP boot plan`
      + ' (resolveCpBootPlan() rebuilds a stale jar first — a gate-first order re-locks the defect that'
      + ' PLAN-0375 R2 / PLAN-0680 fixed)'
      + ` plan=[${plan.join(' -> ')}] executed=[${trail.join(' -> ')}]`,
    )
    this.name = 'BootPhaseOrderError'
    this.plan = [...plan]
    this.trail = [...trail]
    this.attempted = attempted
    this.expected = expected
    this.problem = problem ?? 'order'
  }
}

/**
 * 相位游标：`enter()` 按计划顺序放行，其它一律抛。
 *
 * @param {{plan?: string[]}} [input]
 */
export function createBootPhaseCursor({ plan = bootPhasePlan() } = {}) {
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new TypeError('createBootPhaseCursor: plan must be a non-empty array of phase names')
  }
  if (new Set(plan).size !== plan.length) {
    throw new TypeError(`createBootPhaseCursor: plan has duplicate phases [${plan.join(',')}]`)
  }
  const trail = []
  return {
    /** 计划的有序副本。 */
    get plan() {
      return [...plan]
    },
    /** 已进入的相位（有序）。 */
    trail() {
      return [...trail]
    },
    /** 还没进入的相位。 */
    remaining() {
      return plan.slice(trail.length)
    },
    /**
     * 标记"main() 现在进入这个相位"。
     * @param {string} name
     * @returns {string} 同一个名字（便于 `bootPhases.enter(X)` 直接串进表达式）
     */
    enter(name) {
      if (trail.includes(name)) {
        throw new BootPhaseOrderError({ plan, trail, attempted: name, expected: plan[trail.length], problem: 'duplicate' })
      }
      if (trail.length >= plan.length) {
        throw new BootPhaseOrderError({ plan, trail, attempted: name, expected: undefined, problem: 'overflow' })
      }
      const expected = plan[trail.length]
      if (name !== expected) {
        throw new BootPhaseOrderError({ plan, trail, attempted: name, expected })
      }
      trail.push(name)
      return name
    },
    /**
     * declared vs executed 的对照（`--plan-only` 打印的就是它，测试断言也是它）。
     * `ok` 只表示"已进入的每一个都符合计划且计划已走完"——**没走完不算 ok**，
     * 因为那正是"某个相位被跳过/搬走"的形状。
     */
    describe() {
      const ok = trail.length === plan.length && trail.every((name, index) => name === plan[index])
      return {
        declared: [...plan],
        executed: [...trail],
        ok,
        missing: plan.slice(trail.length),
      }
    },
  }
}
