// lane 说明（T-2318 逐测试标注，先例 ui-health.spec.ts:112）：「settings domain page renders」
// 纯行为（landmark 断言 + 裸截图到 outputPath，Windows 不 skip）带 profile 标记；「settings data /
// monitoring」两条内嵌视觉断言（helpers/visual.ts 非 linux 平台 skip）不标注。本文件历史上在注释里
// 提过 host 车道但标题无标记（卡面 grep 口径误计为已标记）—— 真正的第 19 个孤儿，被 T-2318 门禁
// 上线当天抓到。分类证据：internal/A03-xihe/evidence/2026-11-16-host-spec-lane/classification.md §7
import { generateE2EPassword } from "./helpers/password";
import { ACTION_TIMEOUT_MS } from "../timeouts";
import { test, expect } from "@playwright/test";
import { expectPlatformScreenshot } from "../helpers/visual";

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();

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

test("@host settings domain page renders", async ({ page }) => {
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
