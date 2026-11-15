/**
 * task-139 判据 ①：**形态判据**（不是行为判据）—— `installGlobalErrorTelemetry()` 的调用必须出现在
 * `app.mount("#app")` **之前**。
 *
 * <p>**为什么必须标注性质**：这条只证明源码里的**顺序**，不证明「挂载期抛的未捕获错误真的被捕获」。
 * 它挡的是「有人把接线行挪回 mount 之后」这一类回归（本卡修的就是这个），但它**不能**代替行为证据 ——
 * 行为证据在 `e2e/mock/task139-unhandled-telemetry.spec.ts`（真实 `Promise.reject` / 异步 `throw`
 * ⇒ 断言 CP 遥测端点收到的批次里出现结构化事件）。</p>
 *
 * <p>判据 ②（挂载期错误的**真**行为断言）本卡**未覆盖**，原因写在 `task-139` 卡面：
 * 造「挂载期 window 级未捕获错误」需要一个能在 `app.mount` 同步栈里抛到 window 的注入点 ——
 * Vue 会先把组件 `setup` 的异常交给 `app.config.errorHandler` / `console.error`，**不会**冒到
 * `window.onerror`，所以「在某个 fixture 组件里 throw」造不出这条；当前没有别的可控注入点。
 * 缺的夹具 = 「能在启动同步栈里抛到 window 的注入钩子」，属产品面改动，不在本卡范围内。</p>
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// 为什么用 cwd 而不是 `new URL(..., import.meta.url)`：vitest 的模块运行器里 `import.meta.url` 不是
// `file:` 协议（实测 `TypeError: The URL must be of scheme file`）。vitest 的 cwd 就是包根
// （`packages/ui`，`pnpm exec vitest` 的默认行为），所以按 cwd 解析最稳。
const SOURCE = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");

describe("task-139 遥测接线顺序（形态判据）", () => {
    it("installGlobalErrorTelemetry() 在 app.mount 之前调用", () => {
        const installAt = SOURCE.indexOf("installGlobalErrorTelemetry();");
        const mountAt = SOURCE.indexOf('app.mount("#app")');
        expect(
            installAt,
            "main.ts 必须真的调用 installGlobalErrorTelemetry()（不是只 import）",
        ).toBeGreaterThan(-1);
        expect(mountAt, "main.ts 必须真的挂载 #app").toBeGreaterThan(-1);
        expect(
            installAt,
            "监听必须在挂载前装好：装在 mount 之后会让首屏挂载期成为未捕获错误盲区",
        ).toBeLessThan(mountAt);
    });
});
