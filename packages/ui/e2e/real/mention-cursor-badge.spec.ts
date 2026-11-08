// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
/**
 * PLAN-0660 T5.6 浏览器证据：@ 提及产生未读徽标 ⇒ 推进游标（PATCH cursor）后徽标消失。
 *
 * 门控：`XIHE_E2E_MENTION_CURSOR=1`（默认 skip）。真栈 stack-2；**发送 1 条真实消息**（@本人；
 * PLAN-0684/D-183 后参与者 echo displayName = 账号 username，@ 提及按 username 寻址）
 * 制造未读，产生 1 个 run —— 报告里如实计数；retries=0，避免重试多发。
 */
import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { LONG_TIMEOUT_MS } from "../timeouts";

const ENABLED = process.env.XIHE_E2E_MENTION_CURSOR === "1";
const OUT = process.env.XIHE_MENTION_CURSOR_DIR ?? "";
const STATE_FILE = process.env.XIHE_DEMO_STATE_FILE ?? "";
const CP = `http://127.0.0.1:${process.env.XIHE_CP_PORT ?? "12631"}`;

interface DemoState {
    token: string;
    email: string;
    password: string;
    username: string;
    workspaceId: string;
    sessionId: string;
}

test.describe.configure({ retries: 0 });

/** dock 可能因持久化状态已展开/已折叠：保证 members 页签可见（幂等点击）。 */
async function openMembers(page: import("@playwright/test").Page): Promise<void> {
    const tab = page.getByTestId("dock-tab-members");
    if ((await tab.count()) === 0) {
        await page.getByTestId("workspace-toolbar-members").click();
    }
    if (!(await tab.isVisible().catch(() => false))) {
        await page.getByTestId("workspace-toolbar-members").click();
    }
    await expect(tab).toBeVisible({ timeout: LONG_TIMEOUT_MS });
}

test.describe("PLAN-0660 T5.6 游标推进后徽标下降", () => {
    test.skip(!ENABLED, "只有 XIHE_E2E_MENTION_CURSOR=1 时执行");
    test.use({ viewport: { width: 1440, height: 900 } });

    let state: DemoState;
    test.beforeAll(async ({ request }) => {
        state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as DemoState;
        mkdirSync(OUT, { recursive: true });
        const login = await request.post(`${CP}/api/v1/auth/login`, {
            data: { identifier: state.email, password: state.password },
        });
        expect(login.status()).toBe(200);
        state.token = ((await login.json()) as { accessToken: string }).accessToken;
        // PLAN-0684/D-183：名册 echo displayName = 账号 username；/auth/me 是权威读面。
        const me = await request.get(`${CP}/api/v1/auth/me`, {
            headers: { Authorization: `Bearer ${state.token}` },
        });
        expect(me.status(), "GET /api/v1/auth/me").toBe(200);
        state.username = ((await me.json()) as { username?: string }).username ?? "";
        expect(state.username, "username resolved for the demo account").toBeTruthy();
    });

    test("推游标前本人徽标存在，推进后消失（DOM + 截图）", async ({ page }) => {
        await page.addInitScript((token) => localStorage.setItem("xihe-token", token), state.token);
        await page.addInitScript(
            (workspaceId) => localStorage.setItem("xihe-user", JSON.stringify({ workspaceId })),
            state.workspaceId,
        );
        await page.addInitScript(
            (workspace) => {
                localStorage.setItem("xihe-workspace", JSON.stringify(workspace));
                localStorage.setItem("xihe-theme", "light");
            },
            { id: state.workspaceId, name: "产品交付线" },
        );
        await page.goto(`/workspace/${state.workspaceId}/chat/${state.sessionId}`);
        await expect(page.locator("textarea").first(), "composer").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });

        // 1) 以 Reviewer 身份 @本人（按 echo displayName=username 寻址）→ 产生 notify，
        // 未读徽标 +1；本证据唯一一条真实消息。
        await page.locator("textarea").first().fill(`@${state.username} T5.6 游标证据，请忽略`);
        await page.getByTestId("chat-send-button").click();
        await expect(page.getByTestId("chat-send-button")).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await page.waitForTimeout(1500);

        // 2) 找到本人（HUMAN 参与者，echo displayName = 账号 username）并确认徽标存在
        const me = await page.evaluate(
            async ({ sessionId, username }) => {
                // read-only: 只读回读参与者 readCursor（GET），用于定位本人行与断言前状态。
                const headers = {
                    Authorization: `Bearer ${localStorage.getItem("xihe-token") ?? ""}`,
                };
                const participants = await fetch(`/api/v1/sessions/${sessionId}/participants`, {
                    headers,
                }).then((response) => response.json());
                return (participants.participants ?? []).find(
                    (item: { principalKind?: string; displayName?: string }) =>
                        item.principalKind === "HUMAN" && item.displayName === username,
                );
            },
            { sessionId: state.sessionId, username: state.username },
        );
        expect(me, "应能找到本人参与者").toBeTruthy();
        console.log(
            `[mention-cursor] me=${JSON.stringify({ id: me.participantId, mention: me.readCursor?.mentionCount })}`,
        );

        await openMembers(page);
        const badge = page.locator(`[data-testid="participant-mention-badge-${me.participantId}"]`);
        await expect(badge, "推游标前本人应有未读徽标").toBeVisible({ timeout: LONG_TIMEOUT_MS });
        const beforeText = await badge.textContent();
        await page.screenshot({ path: join(OUT, "mention-badge-before.png"), scale: "css" });
        console.log(`[mention-cursor] before text=${JSON.stringify(beforeText)}`);

        // 3) UI「标记已读」推进本人游标（PLAN-0687：原 in-page PATCH cursor 属 bypass，改走产品路径）
        const row = page.getByTestId(`participant-row-${me.participantId}`);
        const advance = row.getByTestId("participant-cursor-advance");
        if (!(await advance.isVisible().catch(() => false))) {
            const expand = row.getByTestId(`participant-expand-${me.participantId}`);
            if (await expand.isVisible().catch(() => false)) {
                await expand.click();
            }
        }
        await expect(advance, "本人行应有「标记已读」按钮").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await advance.click();
        console.log("[mention-cursor] advance clicked via UI");
        await expect(badge, "点击「标记已读」后本人徽标应立即消失").toHaveCount(0, {
            timeout: LONG_TIMEOUT_MS,
        });

        // 4) 刷新后徽标消失
        await page.reload();
        await expect(page.locator("textarea").first(), "composer").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await openMembers(page);
        await page.waitForTimeout(600);
        await expect(badge, "推进游标后本人徽标应消失").toHaveCount(0);
        await page.screenshot({ path: join(OUT, "mention-badge-after.png"), scale: "css" });
    });
});
