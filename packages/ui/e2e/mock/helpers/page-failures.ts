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
import { pickStaleDepsFailures } from "./vite-deps";

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

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** 把路径里的具体 id 归一成 `:id`，让「同一条路由的多次失败」聚成一类（task-192 ③）。 */
function normalizePath(pathname: string): string {
    return pathname.replace(UUID_RE, ":id").replace(/\/\d{2,}(?=\/|$)/g, "/:n");
}

export interface FailureReport {
    /** allow 命中的条数（跳过的失败）。 */
    skippedCount: number;
    /** allow 命中的原文（便于复核「跳过的是不是真那一类」）。 */
    skipped: string[];
    unexpected: PageFailures;
    /** 按 `host + 归一路径` 归类，含状态码集合与计数。 */
    groups: Array<{ key: string; count: number; statuses: string[]; sample: string }>;
    /**
     * `task-220` ①：命中「Vite 依赖预打包陈旧」的条目。
     *
     * <p>这些条目**仍然是失败**（不从 unexpected 里剔除）：`504 (Outdated Optimize Dep)` 会让动态
     * import 直接失败、页面半初始化，此时业务断言的红与产品无关。单独列出来的用途是**归因**，
     * 让报告能一眼区分「环境陈旧」与「产品/夹具缺陷」两类红 —— 此前这个面没有任何门在看（族 A）。</p>
     */
    staleDeps: string[];
    /** 一行总结 + 每类一行。断言失败时整段进 diff，成功时也打印（读数可复核）。 */
    summary: string;
}

/**
 * 失败信号分诊（task-192 ③）。
 *
 * <p>为什么需要：门禁只有「有失败」没有「哪一类」时，红点读不出结论 —— 三条 A→B 红点全被重复的
 * `404 /api/v1/__ab_instrument_probe` 与 `502 /api/v1/mcp` 盖住，看不出「A 头断言到底怎样」。
 * 这里按 host + 归一路径（UUID / 长数字 → `:id`）归类，并把 allow 跳过的条数**显式**打出来 ——
 * 跳过必须可见，不许静默吞。</p>
 */
export function classifyFailures(failures: PageFailures, allow: RegExp[] = []): FailureReport {
    const allowed = (value: string) => allow.some((pattern) => pattern.test(value));
    const skipped = [
        ...failures.consoleErrors.filter(allowed),
        ...failures.failedResponses.filter(allowed),
    ];
    const unexpected: PageFailures = {
        pageErrors: failures.pageErrors,
        consoleErrors: failures.consoleErrors.filter((value) => !allowed(value)),
        failedResponses: failures.failedResponses.filter((value) => !allowed(value)),
    };
    const byKey = new Map<string, { count: number; statuses: Set<string>; sample: string }>();
    for (const entry of unexpected.failedResponses) {
        // 形如 `404 http://host/path — 夹具原因`
        const match = /^(\d{3}) (\S+)/.exec(entry);
        if (!match) continue;
        const status = match[1]!;
        let key = match[2]!;
        try {
            const url = new URL(key);
            key = url.host + normalizePath(url.pathname);
        } catch {
            // 非 URL（不该出现）：原样归类。
        }
        const bucket = byKey.get(key) ?? { count: 0, statuses: new Set<string>(), sample: entry };
        bucket.count += 1;
        bucket.statuses.add(status);
        byKey.set(key, bucket);
    }
    const groups = [...byKey.entries()]
        .map(([key, bucket]) => ({
            key,
            count: bucket.count,
            statuses: [...bucket.statuses].sort(),
            sample: bucket.sample,
        }))
        .sort((a, b) => b.count - a.count);
    const total =
        unexpected.pageErrors.length +
        unexpected.consoleErrors.length +
        unexpected.failedResponses.length;
    // task-220 ①：环境类红单独归因（不移出 unexpected，只让读数分得清）。
    const staleDeps = pickStaleDepsFailures([
        ...unexpected.failedResponses,
        ...unexpected.consoleErrors,
    ]);
    const lines = [
        `unexpected=${total}（console=${unexpected.consoleErrors.length} pageerror=${unexpected.pageErrors.length} >=400=${unexpected.failedResponses.length}）| skipped(allow)=${skipped.length} | env(stale-deps)=${staleDeps.length}`,
        ...groups.map(
            (group) =>
                `  [${group.statuses.join("/")}] ${group.key} × ${group.count}  例: ${group.sample.slice(0, 160)}`,
        ),
        ...(staleDeps.length > 0
            ? [
                  `  [env] 依赖预打包陈旧 × ${staleDeps.length} —— 这属于环境失败，先预热/重建 deps 再判产品：${staleDeps[0]!.slice(0, 160)}`,
              ]
            : []),
    ];
    return {
        skippedCount: skipped.length,
        skipped,
        unexpected,
        groups,
        staleDeps,
        summary: lines.join("\n"),
    };
}
/** 断言这一条用例期间没有任何"非预期"的失败信号。`allow` 里命中的条目逐条放行。 */
export function expectNoPageFailures(failures: PageFailures, allow: RegExp[] = []): void {
    const report = classifyFailures(failures, allow);
    const unexpected = report.unexpected;
    // 读数可复核：成功时也打印「跳过条数 + 归类清单」，失败时同一段进断言 diff。
    console.log("[page-failures] " + report.summary);
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
    // task-192 ③：消息里直接带**归类清单**（host+归一路径 × 计数 + 跳过的条数），
    // 否则读报告的人只能看到「有 N 条失败」，看不出哪一类是基础设施噪声、哪一类是断言要看的。
    expect(
        unexpected,
        `unexpected browser-side failures（${count} 条：console / pageerror / >=400 三通道全列）\n分类：\n${report.summary}`,
    ).toEqual({ pageErrors: [], consoleErrors: [], failedResponses: [] });
}
