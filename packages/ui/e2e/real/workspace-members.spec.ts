import { generateE2EPassword } from "./helpers/password";
import { expectPlatformScreenshot } from "../helpers/visual";

import { test, expect, type Page } from "@playwright/test";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();

interface RegisteredUser {
    token: string;
    userId: string;
    username: string;
    email: string;
    workspaceId: string;
}

async function registerUser(
    request: import("@playwright/test").APIRequestContext,
    label: string,
    username?: string,
): Promise<RegisteredUser> {
    const email = `${label}-${Date.now()}-${Math.floor(Math.random() * 10000)}@test.com`;
    const r = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: {
            email,
            password: SHARED_PASSWORD,
            name: label,
            ...(username ? { username } : {}),
        },
    });
    expect(r.status(), `register failed for ${label}: ${r.status()} ${await r.text()}`).toBe(201);
    const auth = (await r.json()) as {
        accessToken: string;
        workspaceId: string;
        user: { id: string; username?: string };
    };
    // PLAN-0565 ruling #7: blank usernames derive from the email local part.
    const derived = auth.user.username ?? email.split("@")[0].replace(/[^a-z0-9]/g, "");
    return {
        token: auth.accessToken,
        userId: auth.user.id,
        username: derived,
        email,
        workspaceId: auth.workspaceId,
    };
}

function seedWorkspaceContext(page: Page, user: RegisteredUser, role: string): void {
    // Local-storage legacy shape + sessionStorage post-login shape (PLAN-0560);
    // role fields must live in sessionStorage (migrateLegacyWorkspace drops them).
    page.addInitScript(
        ({ token, ws, role: r }) => {
            localStorage.setItem("xihe-token", token);
            localStorage.setItem(
                "xihe-user",
                JSON.stringify({ id: "bootstrap", email: "bootstrap@test.com", name: "B" }),
            );
            localStorage.setItem(
                "xihe-workspace",
                JSON.stringify({ id: ws, name: "Default Workspace" }),
            );
            sessionStorage.setItem(
                "xihe-workspace",
                JSON.stringify({
                    id: ws,
                    name: "Default Workspace",
                    workspaceRole: r,
                    ownerId: "x",
                }),
            );
        },
        { token: user.token, ws: user.workspaceId, role },
    );
}

test.describe("@host PLAN-0565 workspace members", () => {
    let owner: RegisteredUser;
    let editorTarget: RegisteredUser;
    let outsider: RegisteredUser;

    test.beforeAll(async ({ request }) => {
        // All accounts derive usernames from the email local part (ruling #7
        // default path) — the register response's user view does not carry the
        // username field, so explicit usernames would not be assertable here.
        owner = await registerUser(request, "member-owner");
        editorTarget = await registerUser(request, "member-editor");
        outsider = await registerUser(request, "member-outsider");
    });

    test("owner manages members through the settings UI over the real chain", async ({ page }) => {
        const consoleErrors: string[] = [];
        page.on("console", (msg) => {
            if (msg.type() === "error") consoleErrors.push(msg.text());
        });
        seedWorkspaceContext(page, owner, "OWNER");
        await page.goto(`/workspace/${owner.workspaceId}/settings?tab=members`, {
            waitUntil: "load",
        });

        await expect(page.getByTestId("ws-settings-members")).toBeVisible({ timeout: 15000 });
        await expect(page.getByTestId("ws-members-row").first()).toBeVisible({
            timeout: 15000,
        });
        await expect(page.getByTestId("ws-members-row")).toHaveCount(1);
        await expect(page.getByTestId("ws-members-panel")).toContainText(owner.username);

        // No horizontal collapse at mobile width (DEV-011 responsive rule).
        await page.setViewportSize({ width: 390, height: 844 });
        const overflow = await page.evaluate(() => {
            const doc = document.documentElement;
            return doc.scrollWidth > doc.clientWidth + 1;
        });
        expect(overflow).toBe(false);
        await page.setViewportSize({ width: 1920, height: 1080 });

        // Add the editor target by username (ruling #7) — real POST + reload.
        await page.getByTestId("ws-members-add-input").fill(editorTarget.username);
        await page.getByTestId("ws-members-add-btn").click();
        await expect(page.getByTestId("ws-members-row")).toHaveCount(2, { timeout: 15000 });
        await expect(page.getByTestId("ws-members-panel")).toContainText(editorTarget.username);

        // Ruling #6 copy over the real 404 USER_NOT_FOUND.
        await page.getByTestId("ws-members-add-input").fill(`ghost${Date.now()}`);
        await page.getByTestId("ws-members-add-btn").click();
        await expect(page.getByTestId("ws-members-panel")).toContainText(
            "该用户不存在，请对方先注册",
        );

        // Role select is locked for the OWNER row (ruling #4 defers ownership transfer).
        const ownerRow = page.getByTestId("ws-members-row").filter({ hasText: owner.username });
        await expect(ownerRow.locator("select")).toBeDisabled();

        await page.screenshot({ scale: "css",
            path: "test-results/members-owner-list.png",
            fullPage: true,
        });
        expectPlatformScreenshot(page, "plan-0565-members-owner.png");

        // Member removal through the confirm dialog (real DELETE + reload).
        const editorRow = page
            .getByTestId("ws-members-row")
            .filter({ hasText: editorTarget.username });
        await editorRow.locator('[data-testid^="ws-members-remove-"]').click();
        await expect(page.getByTestId("ws-members-remove-confirm")).toBeVisible();
        await page.getByTestId("ws-members-remove-btn").click();
        await expect(page.getByTestId("ws-members-row")).toHaveCount(1, { timeout: 15000 });

        // Browser consumer evidence: no JS errors across the whole journey.
        // "Failed to load resource" entries are the browser's automatic logs
        // for deliberately provoked 4xx responses (ruling-6 probe), not defects.
        const jsErrors = consoleErrors.filter((m) => !m.includes("Failed to load resource"));
        expect(jsErrors, `console errors: ${jsErrors.join(" || ")}`).toEqual([]);
    });

    test("member matrix holds on the real API chain", async ({ request }) => {
        // Owner adds editorTarget (EDITOR) and keeps outsider out.
        const add = await request.post(`${CP_URL}/api/v1/workspaces/${owner.workspaceId}/members`, {
            headers: {
                Authorization: `Bearer ${owner.token}`,
                "Content-Type": "application/json",
                "X-Workspace-Id": owner.workspaceId,
            },
            data: { username: editorTarget.username, role: "EDITOR" },
        });
        expect(add.status(), `add failed: ${add.status()} ${await add.text()}`).toBe(201);
        const added = (await add.json()) as { userId: string; username: string };
        expect(added.username).toBe(editorTarget.username);

        // EDITOR: list visible, write forbidden (ruling #2).
        const list = await request.get(`${CP_URL}/api/v1/workspaces/${owner.workspaceId}/members`, {
            headers: {
                Authorization: `Bearer ${editorTarget.token}`,
                "X-Workspace-Id": owner.workspaceId,
            },
        });
        expect(list.status()).toBe(200);
        const editorAdd = await request.post(
            `${CP_URL}/api/v1/workspaces/${owner.workspaceId}/members`,
            {
                headers: {
                    Authorization: `Bearer ${editorTarget.token}`,
                    "Content-Type": "application/json",
                    "X-Workspace-Id": owner.workspaceId,
                },
                data: { username: outsider.username, role: "VIEWER" },
            },
        );
        expect(editorAdd.status()).toBe(403);
        const editorProblem = (await editorAdd.json()) as { code: string };
        expect(editorProblem.code).toBe("WORKSPACE_FORBIDDEN");

        // Outsider (non-member): hidden on both header and headerless paths.
        const outsiderHeader = await request.get(
            `${CP_URL}/api/v1/workspaces/${owner.workspaceId}/members`,
            {
                headers: {
                    Authorization: `Bearer ${outsider.token}`,
                    "X-Workspace-Id": owner.workspaceId,
                },
            },
        );
        expect(outsiderHeader.status()).toBe(403);
        const outsiderHeaderless = await request.get(
            `${CP_URL}/api/v1/workspaces/${owner.workspaceId}/members`,
            { headers: { Authorization: `Bearer ${outsider.token}` } },
        );
        expect(outsiderHeaderless.status()).toBe(403);

        // Owner removes the editor again; the unique owner stays protected.
        const remove = await request.delete(
            `${CP_URL}/api/v1/workspaces/${owner.workspaceId}/members/${added.userId}`,
            {
                headers: {
                    Authorization: `Bearer ${owner.token}`,
                    "X-Workspace-Id": owner.workspaceId,
                },
            },
        );
        expect(remove.status()).toBe(204);
        const selfRemove = await request.delete(
            `${CP_URL}/api/v1/workspaces/${owner.workspaceId}/members/${owner.userId}`,
            {
                headers: {
                    Authorization: `Bearer ${owner.token}`,
                    "X-Workspace-Id": owner.workspaceId,
                },
            },
        );
        expect(selfRemove.status()).toBe(409);
        const selfProblem = (await selfRemove.json()) as { code: string };
        expect(selfProblem.code).toBe("LAST_OWNER");
    });
});
