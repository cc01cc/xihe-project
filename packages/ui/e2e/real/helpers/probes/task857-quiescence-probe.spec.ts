// lane: 未收集的一次性常驻探针（T-2318 同形态）—— playwright.config.ts testMatch 只收
// e2e/real/*.spec.ts 顶层，probes/ 子目录不进任何车道；要跑就按下面 run 说明临时拷到顶层，
// 跑完移出（拷贝件不提交，源文件提交）。
//
// task-857 回归守卫：`ui-stability.ts` 的 LONG_LIVED_URL 必须把 `/api/v1/user-events`
// 排除出「未静默」判据，同时**不得**把普通在途请求一起放过。
// 根因（确定性，非概率抖动）：旧正则 `\/(events|sse)(\?|$)` 结构上匹配不到 `-events`，
// 而 user channel 用 fetch 开（`useUserChannelSSE.ts:110-111`）⇒ resourceType=fetch，
// eventsource 分支也接不住 ⇒ 空闲页面上的长轮询让 waitForQuiescence 随机超时。
// 判据：有人把正则改回去，本探针第 1 条必须红。
//
// Run (from packages/ui; **no XH stack needed**, both cases route-mock inline):
//   (Get-Content e2e/real/helpers/probes/task857-quiescence-probe.spec.ts -Raw).
//     Replace('../ui-stability','./helpers/ui-stability') |
//     Set-Content e2e/real/_task857-quiescence-probe.spec.ts -NoNewline
//   $env:XIHE_E2E_EXTERNAL_SERVER='1'
//   $env:XIHE_E2E_BROWSER_CHANNEL='chrome-beta'
//   pnpm exec playwright test e2e/real/_task857-quiescence-probe.spec.ts `
//     --config e2e/playwright.config.ts --workers=1 --retries=0 --reporter=line
//   # expected: 2 passed
//   #   line 1 ⇒ TASK857_PROBE outcome=QUIESCENT          (user-events 被排除)
//   #   line 2 ⇒ TASK857_NEG outcome=TIMEOUT ... /api/v1/slow (普通请求仍必须红)
//   # afterwards move _task857-quiescence-probe.spec.ts out of testDir (do not commit it)
//
// This file is NOT collected by the suite: playwright.config.ts testMatch is
// `e2e/real/*.spec.ts` (top level only), so the probes/ sub-directory stays out.
import { expect, test } from "@playwright/test";
import { startRequestTracker } from "../ui-stability";

const PAGE = `<!doctype html><meta charset="utf-8"><title>probe</title>
<script>
  fetch('/api/v1/fast').then((r) => r.text());
  fetch('/api/v1/user-events', { headers: { accept: 'text/event-stream' } });
</script>`;

test("@probe fetch-SSE /api/v1/user-events must not block quiescence", async ({ page }) => {
    await page.route("**/*", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/v1/user-events") return; // hold open: long-lived SSE
        if (path === "/api/v1/fast") return route.fulfill({ status: 200, body: "ok" });
        return route.fulfill({ status: 200, contentType: "text/html", body: PAGE });
    });
    const tracker = startRequestTracker(page);
    try {
        await page.goto("http://localhost/");
        const outcome = await tracker.waitForQuiescence(1500).then(
            () => null,
            (error: unknown) => error as Error,
        );
        console.log("TASK857_PROBE outcome=" + (outcome ? "TIMEOUT" : "QUIESCENT"));
        if (outcome) console.log("TASK857_PROBE message=" + outcome.message.replace(/\n/g, " | "));
        expect(outcome, "user-events long poll should be excluded").toBeNull();
    } finally {
        tracker.dispose();
    }
});

test("@probe ordinary in-flight request still blocks quiescence (negative proof)", async ({
    page,
}) => {
    await page.route("**/*", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/v1/slow") return; // hold open: an ordinary request
        return route.fulfill({
            status: 200,
            contentType: "text/html",
            body: `<script>fetch('/api/v1/slow')</script>`,
        });
    });
    const tracker = startRequestTracker(page);
    try {
        await page.goto("http://localhost/");
        const outcome = await tracker.waitForQuiescence(800).then(
            () => null,
            (error: unknown) => error as Error,
        );
        console.log("TASK857_NEG outcome=" + (outcome ? "TIMEOUT" : "QUIESCENT"));
        if (outcome) console.log("TASK857_NEG message=" + outcome.message.replace(/\n/g, " | "));
        expect(outcome, "ordinary pending request must still time out").not.toBeNull();
        expect(outcome?.message).toContain("/api/v1/slow");
    } finally {
        tracker.dispose();
    }
});
