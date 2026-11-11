#!/usr/bin/env node
/**
 * PLAN-0632 T4.4（方案 C，2026-11-05；task-180 分层预算 2026-11-11）：起 Agent 之前先等 CP readiness。
 *
 * 为什么需要：`dev:host` 把 cp/agent/runtime/ui 放在**同一个并行 group**，Agent 的启动
 * config sync 会跑在 CP 就绪之前（D32-22/D32-27 的"重试阶梯"来源）。实测（隔离探针
 * 2026-11-05）：CP 不可达时该 sync 白跑 2.81 s（0.98+0.83，budget 0.80/域），并把 Agent
 * 置为 degraded 直到周期刷新（30 s）或首个请求触发懒加载。
 *
 * 本脚本只做一件事：**轮询 CP `/actuator/health` 到 200**，命中即 exit 0；超时 **exit 1** 并把
 * 最后状态 + CP 日志路径打到 stderr —— 由 mise 的 depends 语义中止 `dev:host:start:agent`，
 * 绝不"等不到也继续起"。
 *
 * task-180：预算按**起栈路径**分层（判据 = stack-run.mjs cp 的**前置状态**，用同一套
 * `cp-build-info`/`cp-build-dir` 读 build-info 戳 vs HEAD）：
 *   - 复用已构建（stamp == HEAD 且不 dirty）→ 60 s（热重启，和以前一样快）
 *   - 重建路径（stale/missing/dirty ⇒ 本次起栈会先 `clean compile`，且并发 cargo 可能在编译）
 *     → DEFAULT_REBUILD_BUDGET_SECONDS（240 s；本机实测 clean test-compile 22.5 s，端到端
 *       重建+启动实测见 task-180 证据）
 *   - 探针失败/未知 → 保守取重建预算（等太久可恢复，等太短就是 task-178 那次首启失败）
 * 预算选择的纯函数在 `scripts/lib/wait-for-cp-budget.mjs`（单测 `wait-for-cp-budget.test.mjs`）。
 *
 * 环境变量：XIHE_CP_PORT（默认取本栈 deriveStack().ports.cp）｜XIHE_CP_LOG（stderr 里提示的日志路径）
 *   XIHE_WAIT_FOR_CP_TIMEOUT（秒；**两路径统一覆盖**，语义/名字不变）
 *   XIHE_WAIT_FOR_CP_REBUILD_TIMEOUT（秒；**仅重建路径**覆盖）
 *   XIHE_WAIT_FOR_CP_HOST（默认 127.0.0.1）
 * 非法覆盖值 ⇒ exit 2（显式失败，不再像旧实现那样把 NaN 变成"一轮就超时"）。
 * 用法：node scripts/wait-for-cp.mjs（零依赖，Node 24）
 */
import { request } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cpTargetDir, evaluateCpFreshness, gitHead } from "./lib/cp-build-info.mjs";
import { resolveCpTargetDir } from "./lib/cp-build-dir.mjs";
import {
    DEFAULT_STACK_ID,
    deriveStack,
    normalizeStackArg,
} from "./lib/stack-ports.mjs";
import { describeBudget, selectWaitBudget } from "./lib/wait-for-cp-budget.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const derived = deriveStack(normalizeStackArg(process.env.XIHE_STACK_ID ?? DEFAULT_STACK_ID));

const host = process.env.XIHE_WAIT_FOR_CP_HOST ?? "127.0.0.1";
const port = Number(process.env.XIHE_CP_PORT ?? derived.ports.cp);
const cpLog = process.env.XIHE_CP_LOG ?? "logs/cp.out.log";
const pollMs = 250;

/**
 * Pre-start build verdict = the same question `stack-run.mjs cp` answers before it boots, read
 * through the same modules. Never throws: a probe failure is reported as `unknown` and the budget
 * selector treats it as a rebuild.
 *
 * @returns {{freshness: {status: string, reason: string}, targetDir: string|null}}
 */
function probeFreshness() {
    try {
        const head = gitHead({ cwd: projectRoot });
        const layout = resolveCpTargetDir({
            stackId: derived.stackId,
            env: process.env,
            commit: head.commit,
            dirty: head.dirty,
        });
        const targetDir = layout.targetDir ?? cpTargetDir({ projectRoot, env: process.env });
        return { freshness: evaluateCpFreshness({ targetDir, headCommit: head.commit }), targetDir };
    } catch (error) {
        return {
            freshness: { status: "unknown", reason: `freshness probe failed: ${error?.message ?? error}` },
            targetDir: null,
        };
    }
}

const { freshness } = probeFreshness();
let budget;
try {
    budget = selectWaitBudget({ env: process.env, freshness });
} catch (error) {
    console.error(`[wait-for-cp] ERROR: ${error.message}`);
    console.error(
        "[wait-for-cp] 拒绝用非法预算等待；修正环境变量后重跑 `mise run dev:host`（"
            + "两路径覆盖 = XIHE_WAIT_FOR_CP_TIMEOUT，仅重建路径 = XIHE_WAIT_FOR_CP_REBUILD_TIMEOUT）。",
    );
    process.exit(2);
}
const timeoutMs = budget.timeoutMs;
console.error(`[wait-for-cp] ${describeBudget(budget, freshness)}`);

const startedAt = Date.now();
let lastObserved = "no-answer";

function probe() {
    return new Promise((resolve) => {
        const req = request(
            { host, port, path: "/actuator/health", timeout: 2_000 },
            (res) => {
                res.resume(); // 只要状态码，正文丢弃
                lastObserved = `HTTP ${res.statusCode}`;
                resolve(res.statusCode === 200);
            },
        );
        req.on("timeout", () => {
            lastObserved = "timeout";
            req.destroy();
            resolve(false);
        });
        req.on("error", (error) => {
            lastObserved = error.code ?? error.message;
            resolve(false);
        });
        req.end();
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

while (Date.now() - startedAt < timeoutMs) {
    if (await probe()) {
        const elapsed = (Date.now() - startedAt) / 1000;
        console.log(
            `[wait-for-cp] CP ready on ${host}:${port} after ${elapsed.toFixed(2)}s`
                + ` (budget ${budget.seconds.toFixed(1)}s, ${budget.path} path)`,
        );
        process.exit(0);
    }
    await sleep(pollMs);
}

console.error(
    `[wait-for-cp] CP NOT ready on ${host}:${port} after ${(timeoutMs / 1000).toFixed(1)}s `
        + `(last observed: ${lastObserved}; budget = ${budget.seconds.toFixed(1)}s, `
        + `${budget.path} path, source = ${budget.source}).`,
);
console.error(
    "[wait-for-cp] Agent 未启动（依赖失败即中止）。先看 CP 日志：" +
        `${cpLog}` + `；栈/端口可用 \`mise run dev:host:status\` 核对` +
        `（budget 覆盖：XIHE_WAIT_FOR_CP_TIMEOUT 或 XIHE_WAIT_FOR_CP_REBUILD_TIMEOUT，单位秒）。`,
);
process.exit(1);
