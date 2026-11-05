/**
 * BL-328 / BL-332 / BL-333 / BL-335 真栈复核（`@host`）。
 *
 * 四条都是"产品已修 + 单测绿，但没有端到端证据"。本文件按可行性分档，**不伪绿**：
 *
 * | BL | 本文件覆盖 | 说明 |
 * |---|---|---|
 * | **BL-332** | ✅ | 同 context 两页 ⇒ workspace 上游 `/api/v1/events?workspaceId=…` **恰好 1 条**；依据 `useWorkspaceSSE.ts:190` 的 `useSharedEventLeader(channelKey, upstreamConnect, …)` |
 * | **BL-335** | ⏭ skipped | 需把**同一用户**的并发订阅推过 8（CP `UserChannelSseManager.java:103/136` 第 9 条回 `429 USER_CHANNEL_FULL`）⇒ 需要 ≥9 个**独立 context**（共享 leader 让同 context 不撞限）；单跑次成本超出本轮盒，**标 skipped 并写明原因**，不降级为 mock |
 * | **BL-328** | ⏭ skipped | 依赖真审批卡（agent 工具调用需审批）⇒ 需要 approval 场景夹具；本轮盒内不做，不伪造 |
 * | **BL-333** | ⏭ skipped | 同上 + 双标签页审批同步；依赖 approval 场景 |
 *
 * 必须经 `scripts/e2e-host.mjs` 运行。
 */
import { expect, test } from "@playwright/test";

import { CP_URL } from "./helpers/journey";
import { ensureWorkspace } from "./helpers/workspace";

test.describe.configure({ retries: 0 });

test("@host BL-332 同 context 两页共享一条 workspace 上游 SSE", async ({ browser, request }) => {
    const nonce = Date.now().toString(36);
    const registered = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: {
            email: `bl332-${nonce}@test.com`,
            password: process.env.XIHE_E2E_PASSWORD ?? "XhE2e!bl332leader1",
            name: `bl332${nonce}`,
        },
    });
    expect([200, 201], `注册应 2xx：${registered.status()} ${await registered.text()}`).toContain(
        registered.status(),
    );
    const { accessToken } = (await registered.json()) as { accessToken: string };
    const workspaceId = await ensureWorkspace(request, accessToken);

    // 同一 context（`navigator.locks` / `BroadcastChannel` / `localStorage` 才共享）
    const context = await browser.newContext();
    // 应用从 localStorage 的 `xihe-token` 恢复登录态（stores/auth.ts:50）
    await context.addInitScript((token) => {
        window.localStorage.setItem("xihe-token", token as string);
    }, accessToken);

    const upstream: string[] = [];
    context.on("request", (req) => {
        let url: URL;
        try {
            url = new URL(req.url());
        } catch {
            return;
        }
        // workspace 通道是路径形式：/api/v1/workspaces/{id}/events（useWorkspaceSSE.ts:111）
        if (url.pathname !== `/api/v1/workspaces/${workspaceId}/events`) return;
        upstream.push(req.url());
    });

    const pageA = await context.newPage();
    await pageA.goto(`/workspace/${workspaceId}`, { waitUntil: "load" });
    await expect(pageA.locator("body")).toBeVisible();
    await expect
        .poll(() => upstream.length, { timeout: 30_000, intervals: [250, 500, 1_000] })
        .toBeGreaterThan(0);

    const pageB = await context.newPage();
    await pageB.goto(`/workspace/${workspaceId}`, { waitUntil: "load" });
    await expect(pageB.locator("body")).toBeVisible();

    // 两页都在线后，给 leader 选举 + 可能的多余连接留观察窗：只允许 1 条上游
    await expect
        .poll(() => upstream.length, { timeout: 10_000, intervals: [500, 1_000, 2_000] })
        .toBe(1);

    // 判据：#api 上游恰好 1 条，且两页都存在（不是只开了一页）
    expect(context.pages().length, "同 context 应有两个页面").toBe(2);
    console.log(
        `[bl332] OK workspace=${workspaceId} pages=${context.pages().length} ` +
            `workspaceUpstream=${upstream.length} urls=${JSON.stringify(upstream)}`,
    );
    await context.close();
});

test("@host BL-335 第 9 条并发订阅触发上限横幅（9 个独立 context）", async ({
    browser,
    request,
}) => {
    test.setTimeout(240_000);
    const nonce = Date.now().toString(36);
    const registered = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: {
            email: `bl335-${nonce}@test.com`,
            password: process.env.XIHE_E2E_PASSWORD ?? "XhE2e!bl335limit1",
            name: `bl335${nonce}`,
        },
    });
    expect([200, 201], `注册应 2xx：${registered.status()} ${await registered.text()}`).toContain(
        registered.status(),
    );
    const { accessToken } = (await registered.json()) as { accessToken: string };
    const workspaceId = await ensureWorkspace(request, accessToken);

    // 共享 leader 只在**同 context**内生效（navigator.locks + localStorage + BroadcastChannel）
    // ⇒ 要压过 CP 的订阅上限必须用**独立 context**（各自 storage ⇒ 各自 leader ⇒ 各自上游连接）。
    // CP 上限：第 9 条并发订阅回 429 USER_CHANNEL_FULL（UserChannelSseManager.java:103/136）。
    const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
    const upstreamPerContext: number[] = [];
    const limitResponses: string[] = [];
    const pages: Awaited<ReturnType<Awaited<ReturnType<typeof browser.newContext>>["newPage"]>>[] =
        [];

    for (let index = 0; index < 9; index += 1) {
        const context = await browser.newContext();
        await context.addInitScript((token) => {
            window.localStorage.setItem("xihe-token", token as string);
        }, accessToken);
        let upstream = 0;
        context.on("request", (req) => {
            let url: URL;
            try {
                url = new URL(req.url());
            } catch {
                return;
            }
            // workspace 通道：/api/v1/workspaces/{id}/events（useWorkspaceSSE.ts:111）
            if (url.pathname === `/api/v1/workspaces/${workspaceId}/events`) upstream += 1;
        });
        context.on("response", (res) => {
            if (res.status() === 429) limitResponses.push(`${res.status()} ${res.url()}`);
        });
        const page = await context.newPage();
        await page.goto(`/workspace/${workspaceId}`, { waitUntil: "load" });
        // 每一页都等到自己的上游请求出现再继续 —— 避免并发导航 ERR_ABORTED（上一轮失败形态）
        await expect
            .poll(() => upstream, { timeout: 45_000, intervals: [250, 500, 1_000] })
            .toBeGreaterThan(0);
        contexts.push(context);
        pages.push(page);
        upstreamPerContext.push(upstream);
    }

    // 判据（缺一不可）：
    //  ① 第 9 页的 UI 出现三态横幅的 limit 态（`data-testid` + `:data-state="limit"`）
    //  ② 至少有一条 429 被观测到（上限信号真的发出过）
    const last = pages[8];
    // 同屏可能同时挂两个横幅实例（壳级 AppLayout + 页面级 WorkspaceView，设计如此），
    // 因此用属性过滤 + count 判定，不用 `.first()` 掩盖 strict-mode。
    const limitNotice = last.locator(
        '[data-testid="sse-subscriber-limit-notice"][data-state="limit"]',
    );
    await expect
        .poll(() => limitNotice.count(), { timeout: 60_000, intervals: [500, 1_000, 2_000] })
        .toBeGreaterThan(0);
    expect(
        limitResponses.length,
        `应观测到至少一条 429 上限响应；实际 upstreamPerContext=${JSON.stringify(upstreamPerContext)}`,
    ).toBeGreaterThan(0);
    console.log(
        `[bl335] OK contexts=${contexts.length} upstreamPerContext=${JSON.stringify(upstreamPerContext)} ` +
            `limitResponses=${JSON.stringify(limitResponses.slice(0, 5))} ` +
            `noticeCount=${await limitNotice.count()} ` +
            `state=${await limitNotice.first().getAttribute("data-state")} ` +
            `reason=${await limitNotice.first().getAttribute("data-reason")}`,
    );
    for (const context of contexts) await context.close();
});
test("@host BL-328 Escape 关闭审批卡后焦点回 pill（skipped：需真审批卡夹具）", async () => {
    test.skip(
        true,
        "需要真审批卡出现在真栈（agent 工具调用触发审批），本轮盒内未构造 approval 场景；不伪造。" +
            "组件层证据见 packages/ui/src/features/workspace/chat/__tests__/ChatPanel.spec.ts（pending-approval-reopen-pill）。",
    );
});

test("@host BL-333 A 页审批 ⇒ B 页 1s 内卡片消失（skipped：需真审批卡 + 双页）", async () => {
    test.skip(
        true,
        "依赖与 BL-328 相同的 approval 场景夹具 + 双标签页同步；本轮盒内未构造，标 skipped。",
    );
});
