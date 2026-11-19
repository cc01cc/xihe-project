// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
// lane: 手动取证脚本 —— XIHE_E2E_AGENT_CONFIG=1 门控（默认 skip）+ XIHE_DEMO_STATE_FILE / OUT 出图目录；PLAN-0667 M3 真栈取证，不是车道回归（T-2318 分类表）。
/**
 * PLAN-0667 M3 联调取证：真实 stack-1 上渲染「记忆 / 角色 / 技能」三块，出 zh/en 两张截图。
 *
 * 门控：`XIHE_E2E_AGENT_CONFIG=1`（默认 skip）；需要 stack-1 四端口 + demo 账号 state 文件。
 * 零 run：只读列表，不发消息、不绑定（绑定/409 由 API 联调脚本单独取证）。
 */
import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { LONG_TIMEOUT_MS } from "../timeouts";
import { openAgentsPanel } from "../helpers/agents-panel";

const ENABLED = process.env.XIHE_E2E_AGENT_CONFIG === "1";
const OUT = process.env.XIHE_AGENT_CONFIG_DIR ?? "";
const STATE_FILE = process.env.XIHE_DEMO_STATE_FILE ?? "";
const CP = `http://127.0.0.1:${process.env.XIHE_CP_PORT ?? "12631"}`;

interface DemoState {
    token: string;
    email: string;
    password: string;
    workspaceId: string;
    sessionId: string;
}

test.describe("PLAN-0667 M3 真栈三块同屏", () => {
    test.skip(!ENABLED, "只有 XIHE_E2E_AGENT_CONFIG=1 时执行");
    test.use({ viewport: { width: 1440, height: 900 } });

    let state: DemoState;
    test.beforeAll(async ({ request }) => {
        state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as DemoState;
        mkdirSync(OUT, { recursive: true });
        const login = await request.post(`${CP}/api/v1/auth/login`, {
            data: { identifier: state.email, password: state.password },
        });
        expect(login.status(), `demo login: ${login.status()}`).toBe(200);
        state.token = ((await login.json()) as { accessToken: string }).accessToken;
    });

    async function openPanel(page: Page, language: "zh" | "en") {
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
        await page.addInitScript(
            (lang) => localStorage.setItem("xihe-language", lang),
            language === "en" ? "en-US" : "zh-CN",
        );
        // task-134：工具栏 agents 入口随 D-1538 退役；面板现在只在「成员页 -> 智能体页签」。
        await openAgentsPanel(page, { workspaceId: state.workspaceId, timeout: LONG_TIMEOUT_MS });
        const toggle = page.locator('[data-testid^="agent-roles-toggle-"]').first();
        await expect(toggle).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await toggle.click();
        await expect(page.locator('[data-testid="agent-roles-list"]').first()).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
    }

    test("zh/en 各一张（真实组件、真实数据）", async ({ page }) => {
        await openPanel(page, "zh");
        const zhRoles = page.locator('[data-testid^="agent-role-item-"]');
        const zhCount = await zhRoles.count();
        expect(zhCount, "至少两条真实角色绑定").toBeGreaterThanOrEqual(2);
        const systemBadges = await page.locator('[data-testid^="agent-role-system-"]').count();
        expect(systemBadges, "种子绑定带系统徽标").toBeGreaterThanOrEqual(2);
        await expect(page.locator('[data-testid^="agent-role-atoms-"]').first()).toContainText(
            "共",
        );
        await expect(page.getByTestId("agent-skills-section").first()).toBeVisible();
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(OUT, "agent-config-real-zh.png"), scale: "css" });
        console.log(`[agent-config] zh roles=${zhCount} system=${systemBadges}`);

        await page.addInitScript(() => localStorage.setItem("xihe-language", "en-US"));
        await page.reload();
        // 刷新后成员页默认落回「成员」页签（activeTab 不是 URL 状态），需重新选页签。
        await openAgentsPanel(page, { timeout: LONG_TIMEOUT_MS });
        const toggle = page.locator('[data-testid^="agent-roles-toggle-"]').first();
        await expect(toggle).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await toggle.click();
        await expect(page.locator('[data-testid="agent-roles-list"]').first()).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await expect(page.locator('[data-testid^="agent-role-atoms-"]').first()).toContainText(
            "total",
        );
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(OUT, "agent-config-real-en.png"), scale: "css" });
    });
});
