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
        if (url.pathname !== "/api/v1/events") return;
        if (url.searchParams.get("workspaceId") === workspaceId) upstream.push(req.url());
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

test("@host BL-335 订阅者上限提示（skipped：触发需 ≥9 个独立 context）", async () => {
    test.skip(
        true,
        "真栈触发 USER_CHANNEL_FULL 需要把同一用户并发订阅推过 8（CP UserChannelSseManager.java:103/136），" +
            "而共享 leader 让同 context 内不会撞限 ⇒ 需 ≥9 个独立 context（各自 storage/leader）；" +
            "本轮盒内不做，标 skipped 而非降级为 mock。",
    );
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
