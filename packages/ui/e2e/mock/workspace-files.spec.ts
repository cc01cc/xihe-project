// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { LONG_TIMEOUT_MS } from "../timeouts";

const TREE_ENTRIES = [
    { name: "src", type: "directory" },
    { name: "notes.md", type: "file", size: 12 },
    { name: "Makefile", type: "file", size: 40 },
];

test.describe("Workspace file operations (PLAN-262 M3)", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, {
            sessions: [{ id: "session-1", title: "Session 1" }],
            messages: { "session-1": [] },
        });
        await page.route("**/mcp", async (route) => {
            const body = route.request().postDataJSON() as {
                method?: string;
                params?: { name?: string; arguments?: Record<string, unknown> };
            };
            const tool = body?.params?.name ?? "";
            if (body?.method !== "tools/call") {
                await route.fallback();
                return;
            }
            if (tool === "list_directory") {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        jsonrpc: "2.0",
                        id: 1,
                        result: { entries: TREE_ENTRIES },
                    }),
                });
                return;
            }
            if (tool === "read_file") {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: "hello" } }),
                });
                return;
            }
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { message: "ok" } }),
            });
        });
        // Environment endpoint for the five-state view
        await page.route("**/api/v1/workspaces/*/environment", async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    workspaceId: "workspace-1",
                    status: "ready",
                    storageBackend: "host_directory",
                    storageRef: "workspace-1",
                    executionSpec: { status: "assigned", generation: 1, sandboxSpecHash: "abc" },
                    runtime: { status: "observed", deviceId: "dev-1", lastHeartbeatAt: "now" },
                }),
            });
        });
    });

    test("tree search filters and highlights (mock tree entries)", async ({ page }) => {
        // Seed the file tree directly: the real list_directory chain goes through
        // CP+MCP and is covered by host E2E; here we verify search/filter/highlight.
        await page.addInitScript(() => {
            const tree = [
                { name: "src", path: "src", type: "directory", children: [] },
                { name: "notes.md", path: "notes.md", type: "file", size: 12 },
                { name: "Makefile", path: "Makefile", type: "file", size: 40 },
            ];
            localStorage.setItem("xihe-mock-filetree", JSON.stringify(tree));
        });
        await page.goto("/workspace/workspace-1");
        await expect(page.getByText("notes.md")).toBeVisible({ timeout: LONG_TIMEOUT_MS });

        const search = page.getByPlaceholder("过滤文件树");
        await search.fill("note");
        await expect(page.getByText("notes.md")).toBeVisible();
        await expect(page.getByText("Makefile")).not.toBeVisible();

        await search.fill("");
        await expect(page.getByText("Makefile")).toBeVisible();
    });

    test("delete confirmation keeps the destructive action visible and clickable", async ({
        page,
    }) => {
        await page.addInitScript(() => {
            localStorage.setItem(
                "xihe-mock-filetree",
                JSON.stringify([{ name: "notes.md", path: "notes.md", type: "file", size: 12 }]),
            );
        });
        await page.goto("/workspace/workspace-1");
        const fileEntry = page.getByRole("button", { name: "notes.md", exact: true });
        await expect(fileEntry).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await fileEntry.click({ button: "right" });
        const deleteItem = page
            .getByRole("menuitem", { name: /^Delete…$|^Delete$|^删除…$|^删除$/ })
            .first();
        await expect(deleteItem).toBeVisible();
        await deleteItem.click();
        const dialog = page.locator('[data-testid="modal-backdrop"]').first();
        await expect(dialog).toBeVisible();
        const destructive = dialog
            .locator("button")
            .filter({ hasText: /delete|删除|confirm|确认/i })
            .first();
        await expect(destructive).toBeVisible();
        await expect(destructive).toHaveCSS("pointer-events", "auto");
    });

    test("empty file tree renders an explicit empty state", async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem("xihe-mock-filetree", JSON.stringify([]));
        });
        await page.goto("/workspace/workspace-1");
        await expect(page.getByText(/暂无|empty|no files/i).first()).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
    });

    test("environment page shows the ready pill, the direct-attach storage binding and refresh", async ({
        page,
    }) => {
        // The retired copy「系统文件操作直访」no longer exists in `src/`: the page now renders the
        // execution-configuration projection (`storageMode` / `executionMode` / disclosed host
        // path). Fixture carries that projection so the assertions below describe what a user
        // actually sees on a direct-attach workspace.
        let environmentCalls = 0;
        await page.route("**/api/v1/workspaces/*/environment", async (route) => {
            environmentCalls += 1;
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    workspaceId: "workspace-1",
                    status: "ready",
                    storageBackend: "host_directory",
                    storageMode: "direct_attach",
                    storageRef: "workspace-1",
                    hostPath: "H:/mock/workspace-1",
                    executionMode: "windows-mxc",
                    executionSpec: { status: "assigned", generation: 1, sandboxSpecHash: "abc" },
                    runtime: { status: "observed", deviceId: "dev-1", lastHeartbeatAt: "now" },
                }),
            });
        });

        await page.goto("/workspace/workspace-1/environment");
        await expect(page.getByTestId("workspace-environment-heading")).toBeVisible();
        await expect(page.getByTestId("workspace-environment-status")).toContainText("ready");
        await expect(page.getByTestId("workspace-environment-recovery")).not.toBeEmpty();
        // Storage access, as the current page expresses it: the disclosed host directory.
        await expect(page.getByTestId("workspace-host-path")).toContainText("/mock/workspace-1");
        // Execution configuration is switchable for direct-attach and explains what the switch does.
        await expect(page.getByTestId("workspace-execution-mode")).toHaveValue("windows-mxc");
        await expect(page.getByTestId("workspace-execution-mode-hint")).not.toBeEmpty();

        // Refresh re-reads the projection (user-visible: same pill, one more request).
        const before = environmentCalls;
        await page.getByRole("button", { name: "刷新" }).click();
        await expect.poll(() => environmentCalls).toBeGreaterThan(before);
        await expect(page.getByTestId("workspace-environment-status")).toContainText("ready");
    });

    test("blocked environment shows recovery guidance and prepare card states", async ({
        page,
    }) => {
        // First load reports blocked; every later read reports materializing, so the post-POST poll
        // can observe progress instead of re-reading `blocked` forever.
        let environmentCalls = 0;
        await page.route("**/api/v1/workspaces/*/environment", async (route) => {
            environmentCalls += 1;
            const status = environmentCalls === 1 ? "blocked" : "materializing";
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    workspaceId: "workspace-1",
                    status,
                    storageBackend: "host_directory",
                    storageRef: "workspace-1",
                    executionSpec: { status: "assigned", generation: 1, sandboxSpecHash: "abc" },
                    runtime: { status: "blocked", deviceId: "dev-1", lastHeartbeatAt: "now" },
                }),
            });
        });
        // The in-flight label (`Preparing…`) lives exactly as long as the POST is in flight:
        // `handlePrepare` clears `preparing` through `startPolling() → stopPolling()` the moment the
        // 202 lands. Asserting the label after a plain click therefore races the response — the
        // flake was the assertion losing that race, not a missing UI state. Hold the response,
        // observe the in-flight state, then release and let the poll move the pill.
        const materializeGate: { release: (() => void) | null } = { release: null };
        await page.route("**/api/v1/workspaces/*/materialize", async (route) => {
            await new Promise<void>((resolve) => {
                materializeGate.release = resolve;
            });
            await route.fulfill({
                status: 202,
                contentType: "application/json",
                body: JSON.stringify({ status: "materializing" }),
            });
        });

        await page.goto("/workspace/workspace-1/environment");
        await expect(page.getByTestId("workspace-environment-status")).toContainText("blocked");
        await expect(page.getByTestId("workspace-prepare-card")).toBeVisible();
        const prepareButton = page.getByTestId("workspace-prepare-button");
        await prepareButton.click();
        await expect(prepareButton).toContainText("Preparing");
        await expect(prepareButton).toBeDisabled();

        await expect.poll(() => typeof materializeGate.release).toBe("function");
        materializeGate.release?.();

        // Readiness by poll, not by clock: the 3 s poll re-reads the projection and the pill leaves
        // `blocked` on its own (the prepare card disappears with it).
        await expect(page.getByTestId("workspace-environment-status")).toContainText(
            "materializing",
            { timeout: LONG_TIMEOUT_MS },
        );
        expect(environmentCalls).toBeGreaterThan(1);
    });
});
