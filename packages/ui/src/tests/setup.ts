import { config } from "@vue/test-utils";
import { beforeEach, afterEach } from "vitest";

// PLAN-0755 M6：@git-diff-view 的 TextMeasure 用 canvas 2d context 量文字宽度
// （`instance.font = ...`）。jsdom 未实现 getContext（缺 canvas 包）⇒ 挂载即抛
// "Cannot set properties of null"。这里给最小 stub：jsdom 无布局引擎，量宽恒为
// 文本长度 × 8px（仅影响视觉，不影响 diff 行序列/结构断言）。
if (typeof HTMLCanvasElement !== "undefined") {
    const stub = {
        font: "",
        measureText: (text: string) => ({ width: (text ?? "").length * 8 }),
    };
    HTMLCanvasElement.prototype.getContext = (() =>
        stub) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

config.global.stubs = {
    Teleport: { template: "<div><slot /></div>" },
};

// Diagnostic: log test timing to diagnose timeouts
let testStartTime = 0;

beforeEach(() => {
    testStartTime = Date.now();
});

afterEach(() => {
    const elapsed = Date.now() - testStartTime;
    // Only log if test is slow (>2s) to avoid noise
    if (elapsed > 2000) {
        // oxlint-disable-next-line no-console
        console.warn(`[SLOW TEST] ${elapsed}ms`);
    }

    // BL-477 回归隔离兜底：同一个 spec 文件内的 document 是复用的，弹窗类用例会
    // `attachTo: document.body` 并直接改 body 内联样式（滚动锁）。用例抛错或提前 return
    // 时这些残留会带进同文件后续用例（BaseModal.spec 的滚动锁/回焦断言首当其冲）。
    // 这里只做状态复位，不动任何断言：清空 body 子节点、复位 body 与 html 的内联样式。
    document.body.innerHTML = "";
    document.body.removeAttribute("style");
    document.documentElement.removeAttribute("style");
});
