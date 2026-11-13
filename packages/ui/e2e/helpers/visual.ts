import {
    expect,
    test,
    type Locator,
    type Page,
    type PageAssertionsToHaveScreenshotOptions,
} from "@playwright/test";

type ScreenshotOptions = PageAssertionsToHaveScreenshotOptions;

export async function expectPlatformScreenshot(
    actual: Locator | Page,
    name: string | string[],
    options?: ScreenshotOptions,
): Promise<void> {
    if (process.platform !== "linux") {
        // task-174（2026-11-13）：**不许再以 passed 的身份静默返回**。
        //
        // 旧写法只 push 一条 annotation 就 return ⇒ 用例报 passed，而 matcher 一次都没执行。
        // BL-601 证据包 §0 把这个现象量化过（Windows 9 passed / matcher 执行 0 次，
        // 且 skip 数两侧都是 0 ⇒ 从输出上完全分不出「比过了」和「没比」）。
        // 规则出处：**跳过与通过必须在输出上可区分**（task-87）；同一份证据是
        // internal/A03-xihe/evidence/2026-11-12-bl601-linux-baseline/README.md §0。
        //
        // 现在改成 skip：报告里记 skipped + 原因，`check:mock-baseline` 的 skipped 计数
        // 会把「Windows 上这批视觉断言根本没跑」显式计入基线（基线因此上调，见
        // mock-baseline.json 的 platformVisualSkips 说明与 mock-baseline-provenance.md）。
        test.skip(
            true,
            `视觉基线只在 linux 平台比较（e2e/helpers/visual.ts）；当前平台 ` +
                process.platform +
                `，matcher 未执行 ⇒ 记 skipped 而不是 passed`,
        );
        return;
    }

    await expect(actual).toHaveScreenshot(name, options);
}
