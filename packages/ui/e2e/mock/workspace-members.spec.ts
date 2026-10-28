import { test, expect } from "@playwright/test";
import { setupMockAuth } from "./helpers/auth";

// PLAN-0565：工作区设置页「成员」tab（裁定 #2/#3/#6/#7 的 UI 侧验收）。
const WORKSPACE_ID = "workspace-1";

interface MockMember {
    userId: string;
    username: string;
    email: string;
    name: string | null;
    role: string;
    createdAt: string;
}

let members: MockMember[];
let seq = 0;

function makeMember(username: string, role: string, userId: string): MockMember {
    return {
        userId,
        username,
        email: `${username}@test.com`,
        name: null,
        role,
        createdAt: "2026-10-28T00:00:00Z",
    };
}

test.describe("PLAN-0565 workspace members tab", () => {
    test.beforeEach(async ({ page }) => {
        seq = 0;
        members = [
            makeMember("owner", "OWNER", "u-owner"),
            makeMember("editor", "EDITOR", "u-editor"),
        ];
        await setupMockAuth(page);
        await page.route("**/api/v1/workspaces/workspace-1/members**", async (route) => {
            const method = route.request().method();
            const url = new URL(route.request().url());
            if (method === "GET") {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify(members),
                });
                return;
            }
            if (method === "POST") {
                const body = route.request().postDataJSON() as {
                    username?: string;
                    role?: string;
                };
                if (!body.username || !body.role) {
                    await route.fulfill({
                        status: 400,
                        contentType: "application/problem+json",
                        body: JSON.stringify({ code: "INVALID_REQUEST", detail: "bad body" }),
                    });
                    return;
                }
                if (body.username === "ghost") {
                    await route.fulfill({
                        status: 404,
                        contentType: "application/problem+json",
                        body: JSON.stringify({
                            code: "USER_NOT_FOUND",
                            detail: "No registered account for this username",
                        }),
                    });
                    return;
                }
                if (members.some((m) => m.username === body.username)) {
                    await route.fulfill({
                        status: 409,
                        contentType: "application/problem+json",
                        body: JSON.stringify({
                            code: "MEMBER_ALREADY_EXISTS",
                            detail: "already a member",
                        }),
                    });
                    return;
                }
                seq += 1;
                const created = makeMember(body.username, body.role, `u-new-${seq}`);
                members.push(created);
                await route.fulfill({
                    status: 201,
                    contentType: "application/json",
                    body: JSON.stringify(created),
                });
                return;
            }
            if (method === "PATCH") {
                const userId = url.pathname.split("/").pop() ?? "";
                const target = members.find((m) => m.userId === userId);
                if (!target) {
                    await route.fulfill({
                        status: 404,
                        contentType: "application/problem+json",
                        body: JSON.stringify({ code: "MEMBER_NOT_FOUND", detail: "not a member" }),
                    });
                    return;
                }
                const body = route.request().postDataJSON() as { role?: string };
                target.role = body.role ?? target.role;
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify(target),
                });
                return;
            }
            if (method === "DELETE") {
                const userId = url.pathname.split("/").pop() ?? "";
                const target = members.find((m) => m.userId === userId);
                if (!target) {
                    await route.fulfill({
                        status: 404,
                        contentType: "application/problem+json",
                        body: JSON.stringify({ code: "MEMBER_NOT_FOUND", detail: "not a member" }),
                    });
                    return;
                }
                if (
                    target.role === "OWNER" &&
                    members.filter((m) => m.role === "OWNER").length <= 1
                ) {
                    await route.fulfill({
                        status: 409,
                        contentType: "application/problem+json",
                        body: JSON.stringify({ code: "LAST_OWNER", detail: "last owner" }),
                    });
                    return;
                }
                members = members.filter((m) => m.userId !== userId);
                await route.fulfill({ status: 204 });
                return;
            }
            await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
        });
        await page.route("**/api/v1/config/**", (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ domain: "x", entries: {}, envOverridden: {} }),
            }),
        );
        await page.route("**/api/v1/events**", (route) =>
            route.fulfill({
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
                body: "retry: 5000\n\n",
            }),
        );
    });

    test("OWNER sees the tab, adds a member by username and removes one via confirm", async ({
        page,
    }) => {
        await page.goto(`/workspace/${WORKSPACE_ID}/settings`, { waitUntil: "load" });
        await expect(page.getByTestId("workspace-settings-page")).toBeVisible();
        await page.getByTestId("ws-settings-tab-members").click();
        await expect(page.getByTestId("ws-members-list")).toBeVisible();
        await expect(page.getByTestId("ws-members-row")).toHaveCount(2);

        // Add by username (ruling #7) — the list reloads with the new row.
        await page.getByTestId("ws-members-add-input").fill("newmember");
        await page.getByTestId("ws-members-add-role").selectOption("VIEWER");
        await page.getByTestId("ws-members-add-btn").click();
        await expect(page.getByTestId("ws-members-row")).toHaveCount(3);
        await expect(page.getByTestId("ws-members-panel")).toContainText("newmember");

        // Duplicate add surfaces the localized conflict copy (insert-only API).
        await page.getByTestId("ws-members-add-input").fill("editor");
        await page.getByTestId("ws-members-add-btn").click();
        await expect(page.getByTestId("ws-members-panel")).toContainText("该用户已是工作区成员");

        // Remove the editor through the confirm dialog.
        await page.getByTestId("ws-members-remove-u-editor").click();
        await expect(page.getByTestId("ws-members-remove-confirm")).toBeVisible();
        await page.getByTestId("ws-members-remove-btn").click();
        await expect(page.getByTestId("ws-members-row")).toHaveCount(2);
    });

    test("unknown username surfaces the ruling-6 copy without adding a row", async ({ page }) => {
        await page.goto(`/workspace/${WORKSPACE_ID}/settings`, { waitUntil: "load" });
        await page.getByTestId("ws-settings-tab-members").click();
        await expect(page.getByTestId("ws-members-list")).toBeVisible();

        await page.getByTestId("ws-members-add-input").fill("ghost");
        await page.getByTestId("ws-members-add-btn").click();
        await expect(page.getByTestId("ws-members-panel")).toContainText(
            "该用户不存在，请对方先注册",
        );
        await expect(page.getByTestId("ws-members-row")).toHaveCount(2);
    });

    test("EDITOR sees a read-only member list", async ({ page }) => {
        await page.addInitScript(() => {
            sessionStorage.setItem(
                "xihe-workspace",
                JSON.stringify({
                    id: "workspace-1",
                    name: "Mock Workspace",
                    workspaceRole: "EDITOR",
                    ownerId: "owner-1",
                }),
            );
        });
        await page.goto(`/workspace/${WORKSPACE_ID}/settings?tab=members`, { waitUntil: "load" });
        await expect(page.getByTestId("ws-settings-members")).toBeVisible();
        await expect(page.getByTestId("ws-members-panel")).toContainText(
            "仅工作区所有者可以管理成员。",
        );
        await expect(page.getByTestId("ws-members-add")).toHaveCount(0);
        await expect(page.locator('[data-testid^="ws-members-remove-"]')).toHaveCount(0);
        await expect(page.getByTestId("ws-members-row")).toHaveCount(2);
    });

    test("VIEWER has no members tab and ?tab=members falls back to general", async ({ page }) => {
        await page.addInitScript(() => {
            sessionStorage.setItem(
                "xihe-workspace",
                JSON.stringify({
                    id: "workspace-1",
                    name: "Mock Workspace",
                    workspaceRole: "VIEWER",
                    ownerId: "owner-1",
                }),
            );
        });
        await page.goto(`/workspace/${WORKSPACE_ID}/settings`, { waitUntil: "load" });
        await expect(page.getByTestId("ws-settings-tab-members")).toHaveCount(0);

        await page.goto(`/workspace/${WORKSPACE_ID}/settings?tab=members`, { waitUntil: "load" });
        await expect(page.getByTestId("ws-settings-general")).toBeVisible();
        await expect(page.getByTestId("ws-settings-members")).toHaveCount(0);
        await expect(page.getByTestId("ws-members-row")).toHaveCount(0);
    });
});
