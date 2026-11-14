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
 *
 * 为什么 `>=400` 条目还要带「为什么」（task-118 ②）：像「工作区详情 404」这类失败，
 * 浏览器只给你 `404 (Not Found)`，真正的含义（这个 id 不在 `KNOWN_WORKSPACE_IDS`、spec 未自补桩）
 * 由夹具登记（`helpers/fixture-hints.ts`）。另外三条通道**合并成一次断言**，避免第一条红就把
 * 后面两条的信息吞掉。
 */
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { fixtureHintFor } from "./fixture-hints";

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
        if (response.status() < 400) return;
        const url = response.url();
        // task-118 ②：`>=400` 条目必须带「为什么」。浏览器 console 那条文案是 Chrome 生成的
        // （`Failed to load resource: … 404 (Not Found)`，拿不到响应体），所以原因改由夹具在 fulfill
        // 之前登记（`helpers/fixture-hints.ts`），这里按同一 URL **同步**取回 —— 不读 `response.body()`，
        // 因为读 body 是异步的而门禁在 teardown 里同步断言，会造成「有时有说明、有时没有」的竞态。
        const hint = fixtureHintFor(url);
        failures.failedResponses.push(`${response.status()} ${url}${hint ? " — " + hint : ""}`);
    });
    return failures;
}

/** 断言这一条用例期间没有任何"非预期"的失败信号。`allow` 里命中的条目逐条放行。 */
export function expectNoPageFailures(failures: PageFailures, allow: RegExp[] = []): void {
    const allowed = (value: string) => allow.some((pattern) => pattern.test(value));
    const unexpected: PageFailures = {
        pageErrors: failures.pageErrors,
        consoleErrors: failures.consoleErrors.filter((value) => !allowed(value)),
        failedResponses: failures.failedResponses.filter((value) => !allowed(value)),
    };
    const count =
        unexpected.pageErrors.length +
        unexpected.consoleErrors.length +
        unexpected.failedResponses.length;
    if (count === 0) return;
    // task-118 ②：**一次断言、三种通道全列**。修前是三条独立 `expect`，第一条失败就 throw
    // ⇒ 后面的通道在输出里**一行都不出现**（`task-75` 实测：23 条红里 `no unexpected >=400
    // responses` 从未被打印过，而那些失败的真正原因是 404 响应）。合并的验收标准是
    // 「**合并不减少输出**」：这条断言失败时，console 原文、pageerror 原文、
    // `status/url/夹具原因` 三者会一起出现在 diff 里。allow 的逐条过滤语义不变。
    expect(
        unexpected,
        `unexpected browser-side failures（${count} 条：console / pageerror / >=400 三通道全列）`,
    ).toEqual({ pageErrors: [], consoleErrors: [], failedResponses: [] });
}
