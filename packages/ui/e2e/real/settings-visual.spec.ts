import { generateE2EPassword } from "./helpers/password";
import { ACTION_TIMEOUT_MS } from "../timeouts";

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
import { test, expect } from "@playwright/test";
import { expectPlatformScreenshot } from "../helpers/visual";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
let authToken = "";

test.beforeAll(async () => {
    const r = await fetch(`${CP_URL}/api/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            email: `vis-${Date.now()}@test.com`,
            password: SHARED_PASSWORD,
            name: "Visual",
        }),
    });
    if (r.ok) {
        const body = await r.json();
        authToken = body.accessToken;
    }
});

test.beforeEach(async ({ page }) => {
    await page.addInitScript((t) => {
        localStorage.setItem("xihe-token", t);
        localStorage.setItem("xihe-user", JSON.stringify({ id: "vis", name: "Visual" }));
    }, authToken);
    // PLAN-0752：设置面按「层×域」拆页，选用户层 llm-provider 域页作为视觉基线入口。
    await page.goto("/settings/user/llm-provider", { waitUntil: "load" });
});

test("settings domain page renders", async ({ page }) => {
    await expect(page.locator('[data-testid="settings-domain-title"]')).toBeVisible({
        timeout: ACTION_TIMEOUT_MS,
    });
    // PLAN-0307 T2.17: the three-layer settings page is verified with
    // action screenshots in the @host specs; mock `config-settings.spec.ts`
    // keeps the pixel baseline for this route.
    await page.screenshot({
        scale: "css",
        path: test.info().outputPath("settings-config.png"),
        fullPage: true,
    });
});

test("settings knowledge page with tab nav", async () => {
    // PLAN-0752 迁移：知识库已不是设置页（`/settings/knowledge` 重定向到工作区 tab），
    // 旧 `settings-nav-settings-knowledge` 左栏项与 `settings-knowledge.png` 基线一起退役；
    // 新的知识库视觉基线应由工作区设置页承担（已报 Lead，不在此处顺手造基线）。
    test.fixme(true, "PLAN-0752: knowledge moved out of the settings surface");
});

test("settings data page with tab nav", async ({ page }) => {
    await page.goto("/settings/data", { waitUntil: "load" });
    await expect(page.locator('[data-testid="settings-data-heading"]')).toBeVisible();
    await expectPlatformScreenshot(page, "settings-data.png");
});

test("settings monitoring page with tab nav", async ({ page }) => {
    await page.goto("/settings/monitoring", { waitUntil: "load" });
    await expect(page.locator('[data-testid="settings-monitoring-heading"]')).toBeVisible();
    await expectPlatformScreenshot(page, "settings-monitoring.png");
});
