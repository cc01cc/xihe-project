/**
 * PLAN-0660 T5.6 浏览器证据：@ 提及产生未读徽标 ⇒ 推进游标（PATCH cursor）后徽标消失。
 *
 * 门控：`XIHE_E2E_MENTION_CURSOR=1`（默认 skip）。真栈 stack-1；**发送 1 条真实消息**（@陆星）
 * 制造未读，产生 1 个 run —— 报告里如实计数；retries=0，避免重试多发。
 */
import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";

const ENABLED = process.env.XIHE_E2E_MENTION_CURSOR === "1";
const OUT = process.env.XIHE_MENTION_CURSOR_DIR ?? "";
const STATE_FILE = process.env.XIHE_DEMO_STATE_FILE ?? "";
const CP = `http://127.0.0.1:${process.env.XIHE_CP_PORT ?? "12631"}`;

interface DemoState {
    token: string;
    email: string;
    password: string;
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
    await expect(tab).toBeVisible({ timeout: 15_000 });
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
        await expect(page.locator("textarea").first(), "composer").toBeVisible({ timeout: 60_000 });

        // 1) 以 Reviewer 身份 @陆星（本人）→ 产生 notify，未读徽标 +1；本证据唯一一条真实消息。
        await page.locator("textarea").first().fill("@陆星 T5.6 游标证据，请忽略");
        await page.getByTestId("chat-send-button").click();
        await expect(page.getByTestId("chat-send-button")).toBeVisible({ timeout: 180_000 });
        await page.waitForTimeout(1500);

        // 2) 找到本人（HUMAN 陆星）并确认徽标存在
        const me = await page.evaluate(async (sessionId) => {
            const headers = {
                Authorization: `Bearer ${localStorage.getItem("xihe-token") ?? ""}`,
            };
            const participants = await fetch(`/api/v1/sessions/${sessionId}/participants`, {
                headers,
            }).then((response) => response.json());
            return (participants.participants ?? []).find(
                (item: { principalKind?: string; displayName?: string }) =>
                    item.principalKind === "HUMAN" && item.displayName === "陆星",
            );
        }, state.sessionId);
        expect(me, "应能找到本人参与者").toBeTruthy();
        console.log(
            `[mention-cursor] me=${JSON.stringify({ id: me.participantId, mention: me.readCursor?.mentionCount })}`,
        );

        await openMembers(page);
        const badge = page.locator(`[data-testid="participant-mention-badge-${me.participantId}"]`);
        await expect(badge, "推游标前本人应有未读徽标").toBeVisible({ timeout: 30_000 });
        const beforeText = await badge.textContent();
        await page.screenshot({ path: join(OUT, "mention-badge-before.png"), scale: "css" });
        console.log(`[mention-cursor] before text=${JSON.stringify(beforeText)}`);

        // 3) 推进本人游标（advance-only；派生 mentionCount 归零）
        const patched = await page.evaluate(
            async ({ sessionId, participantId }) => {
                const headers = {
                    Authorization: `Bearer ${localStorage.getItem("xihe-token") ?? ""}`,
                    "Content-Type": "application/json",
                };
                const response = await fetch(
                    `/api/v1/sessions/${sessionId}/participants/${participantId}/cursor`,
                    {
                        method: "PATCH",
                        headers,
                        body: JSON.stringify({ lastReadEventSeq: 999999 }),
                    },
                );
                return { ok: response.ok, status: response.status };
            },
            { sessionId: state.sessionId, participantId: me.participantId },
        );
        console.log(`[mention-cursor] patch=${JSON.stringify(patched)}`);
        expect(patched.ok, JSON.stringify(patched)).toBe(true);

        // 4) 刷新后徽标消失
        await page.reload();
        await expect(page.locator("textarea").first(), "composer").toBeVisible({ timeout: 60_000 });
        await openMembers(page);
        await page.waitForTimeout(600);
        await expect(badge, "推进游标后本人徽标应消失").toHaveCount(0);
        await page.screenshot({ path: join(OUT, "mention-badge-after.png"), scale: "css" });
    });
});
