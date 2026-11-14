// timeout-exempt: 独立会话首帧要等 SSE/分支/参与者多个读面，发送后再等 202（task-62 判据）
/**
 * task-62：mock 车道里**独立会话（workspaceless）发不出消息**。
 *
 * <p><b>真凶不是缺路由</b>（`bind-defaults` 早就有桩、实测 200）。实测 wire 是：</p>
 * ```
 * POST /api/v1/sessions/<sid>/bind-defaults   → 200  ← 有路由，"已自动绑定" toast 是真的
 * (SSE) /api/v1/events?sessionId=<sid>        → 200 但**有限体**，立即 clean_close + 恒速重连
 * POST /api/v1/chat                           → 一次都没有
 * console.warn "SSE connection not established"  ← 唯一痕迹
 * ```
 * 链条：`auth.ts` 默认桩回 `"retry: 5000\n\n"` 有限体（`route.fulfill` 必定结束响应体）⇒
 * `isConnected=false` ⇒ `SSEStream.vue:310-314` 只 `console.warn` 就 return ⇒ **消息根本没发**。
 *
 * <p>所以本 spec 判据是「**wire 上真有一条 `POST /api/v1/chat`**」，而不是「界面上看起来发了」。
 * 第二条与第三条构成正负对照：默认（长连接）能发；显式 `sse: false`（旧有限体口径）不能发 ——
 * 后者正是"忘了传 sse 就静默变成一个空测试"这个陷阱的**可执行描述**，别让它再无声无息地回来。</p>
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const STANDALONE_ID = "task62-standalone-1111-4111-8111-111111111111";

type Wire = { method: string; path: string; status: number; body: unknown };

/** 记录所有 `/api/` 写请求的 wire（路径 + 状态 + 请求体）。 */
function recordWrites(page: Page): Wire[] {
    const writes: Wire[] = [];
    page.on("response", (response) => {
        const request = response.request();
        if (request.method() === "GET") return;
        const url = new URL(response.url());
        if (!url.pathname.startsWith("/api/")) return;
        let body: unknown = null;
        try {
            body = request.postDataJSON();
        } catch {
            body = request.postData();
        }
        writes.push({
            method: request.method(),
            path: url.pathname,
            status: response.status(),
            body,
        });
    });
    return writes;
}

async function openStandalone(page: Page, options: Parameters<typeof setupMockAuth>[1] = {}) {
    await setupMockAuth(page, options);
    await setupMockSessions(page, {
        workspacelessSessions: [{ id: STANDALONE_ID, title: "独立会话甲" }],
    });
    await page.goto("/chat/" + STANDALONE_ID);
    await expect(page.getByTestId("standalone-chat-title")).toHaveText("独立会话甲", {
        timeout: LONG_TIMEOUT_MS,
    });
    await expect(page.locator("textarea"), "composer mounts").toBeVisible({
        timeout: LONG_TIMEOUT_MS,
    });
}

test.describe("task-62 独立会话发送：默认必须是长连接", () => {
    test("默认夹具 ⇒ bind-defaults 200，且真的打出 POST /api/v1/chat", async ({ page }) => {
        const writes = recordWrites(page);
        await openStandalone(page);

        await page.locator("textarea").fill("独立会话里的第一句话");
        await page.getByTestId("chat-send-button").click({ timeout: ACTION_TIMEOUT_MS });

        // 判据顺序刻意「因果在前」：bind-defaults 是发送的**前置**，它 404 就轮不到 /chat。
        // 先钉它，红时直接落在真因上（变异验证：把桩摘掉 ⇒ 红在下面这条 status 断言，
        // 而不是笼统地红在「没发 /chat」——后者会把人引去查 SSE）。
        await expect
            .poll(() => writes.filter((row) => row.path.endsWith("/bind-defaults")).length, {
                timeout: EXPECT_TIMEOUT_MS,
                message: "workspaceless 投影未带 providerConnectionId ⇒ 应打一次 bind-defaults",
            })
            .toBe(1);
        const bind = writes.filter((row) => row.path.endsWith("/bind-defaults"));
        expect(
            bind[0]!.status,
            "bind-defaults 不得 404（缺路由会在这里红，而不是在 /chat 上）",
        ).toBe(200);

        // 判据 2：真的发了 /api/v1/chat（不是只动了本地状态）。
        await expect
            .poll(() => writes.filter((row) => row.path === "/api/v1/chat").length, {
                timeout: EXPECT_TIMEOUT_MS,
                message:
                    "默认夹具下必须真的打出 POST /api/v1/chat —— 若上一条 bind-defaults 断言已红，真因在绑定回带；" +
                    "这里绿而此条红，才轮到查 SSE isConnected",
            })
            .toBe(1);

        // 判据 3：/chat 的 body 是真实发送体。
        const chat = writes.find((row) => row.path === "/api/v1/chat")!;
        const body = chat.body as Record<string, unknown>;
        expect(body.sessionId).toBe(STANDALONE_ID);
        expect(typeof body.branchId).toBe("string");
        expect(body.stream).toBe(true);
    });

    /**
     * 负例（可执行的「陷阱说明书」）：`sse: false` = 退回 task-62 之前的有限体默认值。
     * 那时发送**静默不发生** —— 界面没反应、输入框内容还在、wire 上零 `POST /api/v1/chat`。
     * 这条用例的存在意义：若有人把默认值改回有限体，第一条用例会红；而这条会一直绿着提醒
     * 「有限体口径下发送是不可能成功的」，而不是让下一个人重新踩一遍。
     */
    test("显式 sse:false（旧有限体口径）⇒ 发送静默不发生（负例，钉住旧默认的危害）", async ({
        page,
    }) => {
        const writes = recordWrites(page);
        await openStandalone(page, { sse: false });

        await page.locator("textarea").fill("这条不会发出去");
        await page.getByTestId("chat-send-button").click({ timeout: ACTION_TIMEOUT_MS });

        // 给足时间也不该出现 /chat（不是"还没到"，是"根本不会"）。
        await expect
            .poll(() => writes.filter((row) => row.path === "/api/v1/chat").length, {
                timeout: EXPECT_TIMEOUT_MS,
            })
            .toBe(0);
        // 用户看到的是：草稿还在、没有任何错误提示 —— 正是 task-63 要修的产品面症状。
        await expect(page.locator("textarea")).toHaveValue("这条不会发出去");
    });
});
