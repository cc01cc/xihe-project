import { generateE2EPassword } from "./helpers/password";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";
import { test, expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;

async function registerAndLogin(page: Page, request: APIRequestContext, name: string) {
    const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: { email: `${name}-${Date.now()}@test.com`, password: SHARED_PASSWORD, name },
    });
    const auth = await reg.json();
    await page.addInitScript(
        ({ token, user, workspaceId }) => {
            localStorage.setItem("xihe-token", token);
            localStorage.setItem("xihe-user", JSON.stringify({ ...user, workspaceId }));
            localStorage.setItem(
                "xihe-workspace",
                JSON.stringify({ id: workspaceId, name: "Default Workspace" }),
            );
        },
        { token: auth.accessToken, user: auth.user, workspaceId: auth.workspaceId },
    );
    return auth;
}

test.describe("@host Settings — Tier Tabs & Interactions", () => {
    test("saving a config value triggers success toast that does not cover the save button", async ({
        page,
        request,
    }) => {
        await registerAndLogin(page, request, "save-toast");
        // task-769：`/settings/user/agent-profile` 已 302 到 org-members（router/index.ts:347-349），
        // 不再是可编辑域页。改用仍在用户层矩阵内、带可写字段的 context-policy（settingsIa.ts:190）。
        await page.goto("/settings/user/context-policy", { waitUntil: "load" });
        await expect(page.locator('[data-testid="settings-domain-title"]')).toBeVisible({
            timeout: ACTION_TIMEOUT_MS,
        });

        const profilePanel = page.getByTestId("config-domain-context-policy");
        await expect(profilePanel).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await profilePanel.getByTestId("config-domain-toggle-context-policy").click();

        // context-policy 首字段是数字输入（ConfigDomainPanel.vue:940/977 的 config-text/config-number）；
        // 只取面板内第一个 input，语义仍是「改一个值 → 保存」。
        const editInput = profilePanel.locator("input").first();
        await expect(editInput).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await editInput.fill(String(Date.now()).slice(-6));

        const saveBtn = profilePanel.getByRole("button", { name: "保存", exact: true });
        await expect(saveBtn).toBeVisible();
        await saveBtn.click();

        const toast = page.locator("[data-sonner-toast]").first();
        await expect(toast).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });

        const saveBox = await saveBtn.boundingBox(),
            toastBox = await toast.boundingBox();
        if (saveBox && toastBox) {
            const overlap = !(
                toastBox.x + toastBox.width < saveBox.x ||
                toastBox.x > saveBox.x + saveBox.width ||
                toastBox.y + toastBox.height < saveBox.y ||
                toastBox.y > saveBox.y + saveBox.height
            );
            expect(overlap).toBe(false);
        }
        // Evidence screenshot (dynamic content — no pixel baseline).
        await page.screenshot({
            scale: "css",
            path: test.info().outputPath("settings-save-toast.png"),
            fullPage: true,
        });
    });
});
