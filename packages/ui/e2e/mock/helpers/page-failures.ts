/**
 * mock 车道的"浏览器侧失败信号"收集器（PLAN-0660 T5.6 / BL-311 复核用）。
 *
 * mock 车道里所有出网请求都被 `page.route` 桩住，因此**任何** console error、未捕获 pageerror
 * 或 `>= 400` 响应都由我们自己的夹具产生 —— 出现即说明夹具或产品路径有问题，不该被静默放过。
 *
 * 有意为之的错误响应（例如验的正是 `403 CURSOR_SELF_ONLY`）用 `allow` 正则逐条放行，
 * 而不是整体跳过这条判据。
 *
 * 为什么 console 记录里拼上 `location.url`：403/404 的浏览器 console 文案只有
 * `Failed to load resource: the server responded with a status of 403 (Forbidden)`，
 * 不带 URL，单看 text 无法区分"预期的那条"和"别的地方坏了"。
 */
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

export interface PageFailures {
    consoleErrors: string[];
    pageErrors: string[];
    failedResponses: string[];
}

export function collectPageFailures(page: Page): PageFailures {
    const failures: PageFailures = { consoleErrors: [], pageErrors: [], failedResponses: [] };
    page.on("console", (message) => {
        if (message.type() !== "error") return;
        failures.consoleErrors.push(`${message.text()} @ ${message.location().url ?? ""}`);
    });
    page.on("pageerror", (error) => failures.pageErrors.push(error.message));
    page.on("response", (response) => {
        if (response.status() >= 400) {
            failures.failedResponses.push(`${response.status()} ${response.url()}`);
        }
    });
    return failures;
}

/** 断言这一条用例期间没有任何"非预期"的失败信号。`allow` 里命中的条目逐条放行。 */
export function expectNoPageFailures(failures: PageFailures, allow: RegExp[] = []): void {
    const allowed = (value: string) => allow.some((pattern) => pattern.test(value));
    expect(failures.pageErrors, "no uncaught page errors").toEqual([]);
    expect(
        failures.consoleErrors.filter((value) => !allowed(value)),
        "no unexpected console errors",
    ).toEqual([]);
    expect(
        failures.failedResponses.filter((value) => !allowed(value)),
        "no unexpected >=400 responses",
    ).toEqual([]);
}
