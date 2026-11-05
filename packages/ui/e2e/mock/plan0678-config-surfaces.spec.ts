/**
 * PLAN-0678 · UI 配置面与"注入实证"的对应关系（只覆盖**当前已存在**的 UI 面）。
 *
 * 边界（重要，别在本文件里假装验到更多）：
 * - **记忆写入面（pin/取消 pin）属 PLAN-0629 M1-5/M2，未落地**（`i18n/index.ts:391-399` 文案
 *   自己写着"当前只有查看；记忆写入在后续版本开放"）⇒ 无法断言"点击发请求"；
 * - **技能目录展示属 PLAN-0628，未落地**；`maxEntries`/`maxSkills` 全仓 0 命中，
 *   `agent_memory`/`skill_catalog` 的参数目前只存在于 run 快照，没有 UI 展示面；
 * - 因此本 spec 只钉两件**现在能证伪**的事实：
 *   ① 配置面**读 API 而不是硬编码**（改响应 ⇒ 页面值跟着变）；
 *   ② **模板调色板含 `agent_memory` / `skill_catalog`** 两个 model-visible 块（`:46-57`）。
 * 两个面落地后在此文件补 #2/#3。
 *
 * 为什么 #1 用"改 mock + reload"而不是 `waitForRequest`：
 * `waitForRequest` 只能证明"发了请求"，**证不了"没有硬编码兜底"** —— 而本单要防的正是
 * "画了开关/写死值"这类假绿灯。reload 后展示值随响应变化，才是"值来自响应"的直接证据。
 */
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";
import type { Page } from "@playwright/test";

const TEMPLATES_PATH = "**/api/v1/config/api-request-templates*";

/** 元素形状见 `services/apiRequestTemplates.ts:9-18`；`status` 必须是 published，否则被过滤。 */
function templatesResponse(name: string): string {
    return JSON.stringify({
        entries: {
            templates: JSON.stringify([
                {
                    id: "tpl-blank",
                    version: 1,
                    name,
                    description: "PLAN-0678 UI 面用例",
                    apiTypeId: "openai",
                    apiTypeVersion: 1,
                    bodySource: "{{user_input}}",
                    status: "published",
                },
            ]),
        },
    });
}

/** 三层（instance/user/workspace）都返回同一份：避免为"选层"写额外交互（少一处易碎点）。 */
async function stubTemplates(page: Page, name: string): Promise<void> {
    await page.route(TEMPLATES_PATH, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: templatesResponse(name),
        });
    });
}

test.describe("PLAN-0678 UI 配置面", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
    });

    test("#1 模板名来自 API 响应：A ⇒ 显示 A；改响应 + reload ⇒ 显示 B", async ({ page }) => {
        await stubTemplates(page, "A 模板");
        await page.goto("/settings/config");

        const panel = page.locator('[data-testid="api-request-templates-panel"]');
        await expect(panel).toBeVisible({ timeout: 20_000 });
        await expect(panel.locator('[data-testid="api-request-name"]')).toHaveValue("A 模板", {
            timeout: 10_000,
        });

        // 换一份响应（B），卸载旧路由后重新注册，再 reload：若页面显示 B ⇒ 值来自响应。
        await page.unroute(TEMPLATES_PATH);
        await stubTemplates(page, "B 模板");
        await page.reload();
        await expect(page.locator('[data-testid="api-request-templates-panel"]')).toBeVisible({
            timeout: 20_000,
        });
        await expect(
            page.locator('[data-testid="api-request-name"]'),
            "reload 后模板名必须变成 B 模板（说明展示值来自 API，而不是硬编码/默认值）",
        ).toHaveValue("B 模板", { timeout: 10_000 });
    });

    test("#2 模板调色板含 agent_memory / skill_catalog（当前唯一与 0678 相关的 UI 事实）", async ({
        page,
    }) => {
        await stubTemplates(page, "A 模板");
        await page.goto("/settings/config");
        await expect(page.locator('[data-testid="api-request-templates-panel"]')).toBeVisible({
            timeout: 20_000,
        });

        for (const block of ["agent_memory", "skill_catalog"] as const) {
            await expect(
                page.getByRole("button", { name: block, exact: true }),
                `调色板缺少 ${block}（ContextTemplatesPanel.vue:46-57 的 palette 常量应含它）`,
            ).toBeVisible({ timeout: 10_000 });
        }
    });
});
