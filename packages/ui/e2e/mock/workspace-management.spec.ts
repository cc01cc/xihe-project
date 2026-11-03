import { test, expect } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";

let createPayload: Record<string, unknown> | null = null;

test.describe("Workspace management dialogs (PLAN-262 M2)", () => {
    test.beforeEach(async ({ page }) => {
        createPayload = null;
        await setupMockAuth(page);
        await setupMockSessions(page, {
            sessions: [{ id: "session-1", title: "Session 1" }],
            messages: { "session-1": [] },
        });
        // Mock workspace CRUD contract (CP canonical shape per openapi.yaml)
        await page.route("**/api/v1/workspaces", async (route) => {
            if (route.request().method() === "POST") {
                const body = route.request().postDataJSON() as Record<string, unknown>;
                createPayload = body;
                await route.fulfill({
                    status: 201,
                    contentType: "application/json",
                    body: JSON.stringify({
                        id: "ws-new",
                        name: body.name ?? "Untitled",
                        description: body.description ?? null,
                        ownerId: "user-1",
                        storageBackend: "host_directory",
                        storageRef: "ws-new",
                        generation: 1,
                    }),
                });
                return;
            }
            await route.fallback();
        });
        await page.route("**/api/v1/workspaces/*", async (route) => {
            const method = route.request().method(),
                url = new URL(route.request().url());
            const wsId = url.pathname.split("/").filter(Boolean).at(-1) ?? "workspace-1";
            if (method === "PATCH") {
                const body = route.request().postDataJSON() as Record<string, unknown>;
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        id: wsId,
                        name: body.name ?? "Mock Workspace",
                        description: body.description ?? null,
                        ownerId: "user-1",
                        storageBackend: "host_directory",
                        storageRef: wsId,
                        generation: 1,
                    }),
                });
                return;
            }
            if (method === "DELETE") {
                await route.fulfill({ status: 204, body: "" });
                return;
            }
            await route.fallback();
        });
    });

    test("empty picker offers creation; direct-attach create posts the host binding and execution mode", async ({
        page,
    }) => {
        // PLAN-0608 C′: `/workspace` with no tab context renders `WorkspacePicker` (not the old
        // 「暂无工作区」panel), and its empty branch is the current creation entry (PLAN-0614 T2.1).
        // setupMockAuth seeds the per-tab context too (PLAN-0560), so clear both storages.
        await page.addInitScript(() => {
            localStorage.removeItem("xihe-workspace");
            sessionStorage.removeItem("xihe-workspace");
        });

        // Current creation flow is direct-attach only: Runtime-visible source browser, then a real
        // capability preflight for both Windows execution modes (PLAN-0384 T1.1/T1.3).
        await page.route("**/api/v1/workspaces/import-sources**", (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    path: "H:/src/demo",
                    entries: [{ name: "demo", kind: "directory", readable: true, size: 0 }],
                }),
            }),
        );
        await page.route("**/api/v1/workspaces/capabilities/preflight", async (route) => {
            const body = route.request().postDataJSON() as { executionMode?: string };
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    storageMode: "direct_attach",
                    executionMode: body.executionMode ?? "windows-mxc",
                    available: true,
                    maturity: "stable",
                    reason: null,
                }),
            });
        });

        await page.goto("/workspace");
        await expect(page.getByTestId("workspace-picker")).toBeVisible({ timeout: 15000 });
        await expect(page.getByTestId("workspace-picker-empty")).toContainText("你还没有工作区");
        await page.getByTestId("workspace-picker-create").click();

        const dialog = page.getByTestId("workspace-create-dialog");
        await expect(dialog).toBeVisible();
        // `managed_import` is frozen (PLAN-0618 complete freeze): the card is gone and only the
        // explanatory frozen note remains, so `direct_attach` is the one selectable storage mode.
        await expect(dialog.getByTestId("workspace-storage-managed")).toHaveCount(0);
        await expect(dialog.getByTestId("workspace-storage-managed-frozen")).toContainText(
            "执行后端已冻结",
        );
        await dialog.getByTestId("workspace-storage-direct").click();

        await dialog.getByTestId("workspace-source-path").fill("H:/src/demo");
        await dialog.getByTestId("workspace-source-read").click();
        await expect(dialog.getByTestId("workspace-source-browser")).toContainText("demo");
        await dialog.getByTestId("workspace-source-use").click();

        // Preflight reports both modes available; MXC stays the recommended default.
        await expect(dialog.getByTestId("workspace-execution-mxc-status")).toContainText("可用");
        await dialog.getByTestId("workspace-execution-next").click();

        await dialog.getByTestId("workspace-create-name").fill("E2E Workspace");
        await dialog.getByTestId("workspace-create-submit").click();

        await expect(page).toHaveURL(/\/workspace\/ws-new/);
        // The direct-attach request must carry the root binding and the execution mode; the
        // retired `profile` field and the frozen `managed_import` mode must not appear.
        // PLAN-0639 M1: root binding is roots=[{path}] (root[0] = primary).
        expect(createPayload).toMatchObject({
            name: "E2E Workspace",
            storageMode: "direct_attach",
            executionMode: "windows-mxc",
            roots: [{ path: "H:/src/demo" }],
        });
        expect(createPayload?.profile).toBeUndefined();
    });

    test("workspace settings page saves rename and enforces exact-name delete guard", async ({
        page,
    }) => {
        await page.goto("/workspace/workspace-1");
        // PLAN-0560: toolbar settings entry routes to the workspace settings page.
        await page.getByTestId("workspace-toolbar-settings").click();
        await expect(page).toHaveURL(/\/workspace\/workspace-1\/settings/);
        await expect(page.getByTestId("workspace-settings-page")).toBeVisible();

        await page.getByTestId("ws-settings-name-input").fill("Renamed Workspace");
        await page.getByTestId("ws-settings-save").click();
        await expect(page.getByText("工作区已更新")).toBeVisible();

        // Delete flow: wrong name first, then exact name
        await page.getByTestId("ws-settings-delete").click();
        const confirm = page.getByTestId("workspace-delete-confirm");
        await expect(confirm).toBeVisible();
        await confirm.locator("#ws-delete-confirm-input").fill("Wrong Name");
        await confirm.getByTestId("ws-delete-confirm-btn").click();
        await expect(confirm.getByText("请输入完整的工作区名称以确认")).toBeVisible();

        await confirm.locator("#ws-delete-confirm-input").fill("Renamed Workspace");
        await confirm.getByTestId("ws-delete-confirm-btn").click();
        await expect(page).toHaveURL(/\/workspace$/);
    });
});
