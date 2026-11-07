import { config } from "@vue/test-utils";
import { beforeEach, afterEach } from "vitest";

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
