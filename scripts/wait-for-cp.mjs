#!/usr/bin/env node
/**
 * PLAN-0632 T4.4（方案 C，2026-11-05）：起 Agent 之前先等 CP readiness。
 *
 * 为什么需要：`dev:host` 把 cp/agent/runtime/ui 放在**同一个并行 group**，Agent 的启动
 * config sync 会跑在 CP 就绪之前（D32-22/D32-27 的"重试阶梯"来源）。实测（隔离探针
 * 2026-11-05）：CP 不可达时该 sync 白跑 2.81 s（0.98+0.83，budget 0.80/域），并把 Agent
 * 置为 degraded 直到周期刷新（30 s）或首个请求触发懒加载。
 *
 * 本脚本只做一件事：**轮询 CP `/actuator/health` 到 200**，有界（默认 60 s），命中即
 * exit 0；超时 **exit 1** 并把最后状态 + CP 日志路径打到 stderr —— 由 mise 的 depends
 * 语义中止 `dev:host:start:agent`，绝不"等不到也继续起"。
 *
 * 环境变量：XIHE_CP_PORT（默认 12631）｜XIHE_WAIT_FOR_CP_TIMEOUT（秒，默认 60）
 *          XIHE_WAIT_FOR_CP_HOST（默认 127.0.0.1）｜XIHE_CP_LOG（stderr 里提示的日志路径）
 * 用法：node scripts/wait-for-cp.mjs（零依赖，Node 24）
 */
import { request } from "node:http";

const host = process.env.XIHE_WAIT_FOR_CP_HOST ?? "127.0.0.1";
const port = Number(process.env.XIHE_CP_PORT ?? 12631);
const timeoutMs = Math.max(1, Number(process.env.XIHE_WAIT_FOR_CP_TIMEOUT ?? 60)) * 1000;
const pollMs = 250;
const cpLog = process.env.XIHE_CP_LOG ?? "logs/cp.out.log";
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
        console.log(`[wait-for-cp] CP ready on ${host}:${port} after ${elapsed.toFixed(2)}s`);
        process.exit(0);
    }
    await sleep(pollMs);
}

console.error(
    `[wait-for-cp] CP NOT ready on ${host}:${port} after ${(timeoutMs / 1000).toFixed(1)}s ` +
        `(last observed: ${lastObserved}).`,
);
console.error(
    "[wait-for-cp] Agent 未启动（依赖失败即中止）。先看 CP 日志：" +
        `${cpLog}；端口/栈可用 \`mise run dev:host:status\` 核对。`,
);
process.exit(1);
