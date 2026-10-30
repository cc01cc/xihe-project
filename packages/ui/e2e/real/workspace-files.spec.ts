import { generateE2EPassword } from "./helpers/password";

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
import { test, expect, type APIRequestContext } from "@playwright/test";
import { expectPlatformScreenshot } from "../helpers/visual";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;

type McpHeaders = Record<string, string>;

function findEntries(node: unknown, depth = 0): unknown[] | null {
    if (depth > 6) return null;
    if (typeof node === "string") {
        try {
            return findEntries(JSON.parse(node), depth + 1);
        } catch {
            return null;
        }
    }
    if (Array.isArray(node)) return null;
    if (node && typeof node === "object") {
        const record = node as Record<string, unknown>;
        if (Array.isArray(record.entries)) return record.entries;
        for (const value of Object.values(record)) {
            const found = findEntries(value, depth + 1);
            if (found) return found;
        }
    }
    return null;
}

/**
 * PLAN-0586 round-2 fixture (Lead ruling A, test-infra): create an extra workspace owned
 * by the same registered user, prove same-user membership, then materialize its storage
 * over MCP so the UI renders a real empty file tree. The membership check is a
 * precondition: a 403 here is a product/membership regression, not a fixture problem.
 */
async function createMaterializedEmptyWorkspace(
    request: APIRequestContext,
    token: string,
): Promise<{ workspaceId: string; headers: McpHeaders }> {
    const created = await request.post(`${CP_URL}/api/v1/workspaces`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { name: `E2E Empty ${Date.now()}` },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const workspaceId = ((await created.json()) as { id: string }).id;
    expect(workspaceId, "workspace create must return an id").toBeTruthy();

    const membership = await request.get(`${CP_URL}/api/v1/workspaces/${workspaceId}`, {
        headers: { Authorization: `Bearer ${token}`, "X-Workspace-Id": workspaceId },
    });
    expect(
        membership.status(),
        `same-user membership precondition failed: ${await membership.text()}`,
    ).toBe(200);

    const baseHeaders: McpHeaders = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "X-Workspace-Id": workspaceId,
    };
    const init = await request.post(`${CP_URL}/api/v1/mcp`, {
        headers: baseHeaders,
        data: {
            jsonrpc: "2.0",
            method: "initialize",
            id: 1,
            params: {
                protocolVersion: "2026-07-28",
                capabilities: {},
                clientInfo: { name: "xihe-e2e", version: "0.1.0" },
            },
        },
    });
    expect(init.status(), `mcp initialize failed: ${await init.text()}`).toBe(200);
    const sessionId = init.headers()["mcp-session-id"];
    const headers: McpHeaders = sessionId
        ? { ...baseHeaders, "mcp-session-id": sessionId }
        : baseHeaders;
    if (sessionId) {
        await request.post(`${CP_URL}/api/v1/mcp`, {
            headers,
            data: { jsonrpc: "2.0", method: "notifications/initialized" },
        });
    }

    // Materialize on demand: a successful list_directory creates the storage root, so the
    // workspace is reachable-but-empty without writing a file (tool delete policy denies
    // delete_directory for a fresh USER). The caller re-uses the same session to assert
    // 200 + zero entries before the UI step.
    return { workspaceId, headers };
}

test.describe("@host Workspace — File Panel & Delete Flow", () => {
    let authToken = "",
        wsId = "";

    test.beforeAll(async ({ request }) => {
        const r = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `ws-ui-${Date.now()}@test.com`,
                password: SHARED_PASSWORD,
                name: "WsUI",
            },
        });
        const auth = await r.json();
        authToken = auth.accessToken;
        wsId = auth.workspaceId;

        const mcpHeaders = {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2026-07-28",
            "X-Workspace-Id": wsId,
        };
        const init = await request.post(`${CP_URL}/api/v1/mcp`, {
            headers: mcpHeaders,
            data: {
                jsonrpc: "2.0",
                method: "initialize",
                id: 1,
                params: {
                    protocolVersion: "2026-07-28",
                    capabilities: {},
                    clientInfo: { name: "xihe-e2e", version: "0.1.0" },
                },
            },
        });
        expect(init.status(), `initialize failed: ${init.status()} ${await init.text()}`).toBe(200);
        const sessionId = init.headers()["mcp-session-id"];

        const sessionHeaders = sessionId
            ? { ...mcpHeaders, "mcp-session-id": sessionId }
            : mcpHeaders;
        if (sessionId) {
            await request.post(`${CP_URL}/api/v1/mcp`, {
                headers: sessionHeaders,
                data: { jsonrpc: "2.0", method: "notifications/initialized" },
            });
        }

        const list = await request.post(`${CP_URL}/api/v1/mcp`, {
            headers: sessionHeaders,
            data: { jsonrpc: "2.0", method: "tools/list", id: 2, params: {} },
        });
        const listText = await list.text();
        expect(list.status(), `tools/list failed: ${list.status()} ${listText}`).toBe(200);
        expect(listText, `runtime__write_file missing from tools/list: ${listText}`).toContain(
            "write_file",
        );

        const write = await request.post(`${CP_URL}/api/v1/mcp`, {
            headers: sessionHeaders,
            data: {
                jsonrpc: "2.0",
                method: "tools/call",
                id: 3,
                params: {
                    name: "write_file",
                    arguments: {
                        path: "e2e-note.md",
                        content: "# E2E Note\n\nSeeded by workspace-files spec.",
                    },
                },
            },
        });
        const writeText = await write.text();
        expect(write.status(), `seed write_file failed: ${write.status()} ${writeText}`).toBe(200);
        expect(writeText, `write_file returned error: ${writeText}`).not.toContain('"error"');

        const mutationWrite = await request.post(`${CP_URL}/api/v1/mcp`, {
            headers: sessionHeaders,
            data: {
                jsonrpc: "2.0",
                method: "tools/call",
                id: 4,
                params: {
                    name: "write_file",
                    arguments: { path: "mutation.md", content: "# Mutation fixture" },
                },
            },
        });
        const mutationWriteText = await mutationWrite.text();
        expect(
            mutationWrite.status(),
            `mutation fixture write failed: ${mutationWrite.status()} ${mutationWriteText}`,
        ).toBe(200);
        expect(
            mutationWriteText,
            `mutation fixture write returned error: ${mutationWriteText}`,
        ).not.toContain('"error"');

        const nestedWrite = await request.post(`${CP_URL}/api/v1/mcp`, {
            headers: sessionHeaders,
            data: {
                jsonrpc: "2.0",
                method: "tools/call",
                id: 5,
                params: {
                    name: "write_file",
                    arguments: { path: "archive/seed.md", content: "# Archive fixture" },
                },
            },
        });
        const nestedWriteText = await nestedWrite.text();
        expect(
            nestedWrite.status(),
            `nested fixture write failed: ${nestedWrite.status()} ${nestedWriteText}`,
        ).toBe(200);
        expect(
            nestedWriteText,
            `nested fixture write returned error: ${nestedWriteText}`,
        ).not.toContain('"error"');
    });

    test.beforeEach(async ({ page }) => {
        await page.addInitScript((t) => localStorage.setItem("xihe-token", t), authToken);
        await page.addInitScript(
            (raw) => localStorage.setItem("xihe-user", raw),
            JSON.stringify({ workspaceId: wsId }),
        );
        await page.addInitScript(
            (ws) => localStorage.setItem("xihe-workspace", JSON.stringify(ws)),
            { id: wsId, name: "Default Workspace" },
        );
    });

    test("seeded file appears in panel and opens in editor without layout collapse", async ({
        page,
    }) => {
        const mcpBodies: string[] = [];
        page.on("response", (res) => {
            if (res.url().includes("/api/v1/mcp")) {
                res.text()
                    .then((t) => mcpBodies.push(`${res.status()} ${t.slice(0, 300)}`))
                    .catch(() => {});
            }
        });
        await page.goto("/workspace/" + wsId, { waitUntil: "load" });

        const fileEntry = page.locator("text=e2e-note.md").first();
        try {
            await expect(fileEntry).toBeVisible({ timeout: 15000 });
        } catch {
            throw new Error(`seeded file not visible; mcp responses: ${mcpBodies.join(" || ")}`);
        }
        await fileEntry.click();

        await expect(page.locator("text=E2E Note").first()).toBeVisible({ timeout: 10000 });
        const overflow = await page.evaluate(() => {
            const doc = document.scrollingElement;
            return doc ? doc.scrollWidth - doc.clientWidth : 0;
        });
        expect(overflow).toBeLessThanOrEqual(2);
        await expectPlatformScreenshot(page, "workspace-file-selected.png");
    });

    test("file delete confirm dialog renders destructive action with correct layering", async ({
        page,
    }) => {
        await page.goto("/workspace/" + wsId, { waitUntil: "load" });
        const fileEntry = page.locator("text=e2e-note.md").first();
        await expect(fileEntry).toBeVisible({ timeout: 15000 });

        await fileEntry.click({ button: "right" });
        const deleteItem = page
            .getByRole("menuitem", { name: /^Delete…$|^Delete$|^删除…$|^删除$/ })
            .first();
        await expect(deleteItem).toBeVisible({ timeout: 8000 });
        await deleteItem.click();

        const dialog = page.locator('[data-testid="modal-backdrop"]').first();
        await expect(dialog).toBeVisible({ timeout: 8000 });
        const destructiveBtn = dialog
            .locator("button")
            .filter({ hasText: /delete|删除|confirm|确认/i })
            .first();
        await expect(destructiveBtn).toBeVisible();

        const color = await destructiveBtn.evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(color).not.toBe("rgba(0, 0, 0, 0)");
        const hit = await destructiveBtn.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return top === el || el.contains(top);
        });
        expect(hit).toBe(true);
        await expectPlatformScreenshot(page, "workspace-delete-dialog.png");
    });

    test("renames, duplicates, moves and deletes a file through the UI", async ({ page }) => {
        await page.goto("/workspace/" + wsId, { waitUntil: "load" });
        const original = page.getByRole("button", { name: "mutation.md", exact: true });
        await expect(original).toBeVisible({ timeout: 15000 });

        await original.click({ button: "right" });
        await page.getByRole("menuitem", { name: /^Rename$/ }).click();
        const renameModal = page.getByTestId("modal-content");
        await expect(renameModal).toBeVisible();
        await renameModal.getByRole("textbox").fill("renamed.md");
        await renameModal.getByRole("button", { name: "Rename", exact: true }).click();
        await expect(page.getByRole("button", { name: "renamed.md", exact: true })).toBeVisible({
            timeout: 15000,
        });
        await expect(original).not.toBeVisible();

        const renamed = page.getByRole("button", { name: "renamed.md", exact: true });
        await renamed.click({ button: "right" });
        await page.getByRole("menuitem", { name: /^Duplicate$/ }).click();
        const duplicate = page.getByRole("button", { name: "renamed-copy.md", exact: true });
        await expect(duplicate).toBeVisible({ timeout: 15000 });

        await duplicate.click({ button: "right" });
        await page.getByRole("menuitem", { name: /^Move to/ }).click();
        const moveModal = page.getByTestId("modal-content");
        await expect(moveModal).toBeVisible();
        await moveModal.getByRole("textbox").fill("archive");
        await moveModal.getByRole("button", { name: "Move", exact: true }).click();
        await expect(duplicate).not.toBeVisible({ timeout: 15000 });

        const archive = page.getByRole("button", { name: /archive$/ });
        const moved = page.getByRole("button", { name: "renamed-copy.md", exact: true });
        await expect(moved).toBeVisible({ timeout: 15000 });
        await archive.click();
        await expect(moved).not.toBeVisible();
        await archive.click();
        await expect(moved).toBeVisible();

        await moved.click({ button: "right" });
        await page.getByRole("menuitem", { name: /^Delete/ }).click();
        const deleteModal = page.getByTestId("modal-content");
        await expect(deleteModal).toContainText("archive/renamed-copy.md");
        await deleteModal.getByRole("button", { name: "Delete", exact: true }).click();
        await expect(moved).not.toBeVisible({ timeout: 15000 });

        await page.reload({ waitUntil: "load" });
        await expect(page.getByRole("button", { name: "renamed.md", exact: true })).toBeVisible({
            timeout: 15000,
        });
        await page.getByRole("button", { name: /archive$/ }).click();
        await expect(
            page.getByRole("button", { name: "renamed-copy.md", exact: true }),
        ).not.toBeVisible();
        await expectPlatformScreenshot(page, "workspace-file-mutations.png");
    });

    test("workspace empty state is centered and styled", async ({ page, request }) => {
        const r = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `ws-empty-${Date.now()}@test.com`,
                password: SHARED_PASSWORD,
                name: "WsEmpty",
            },
        });
        const registered = (await r.json()) as { accessToken: string; workspaceId: string };
        expect(registered.workspaceId, "register must return a workspaceId").toBeTruthy();
        // PLAN-0586 round-2 fixture (Lead ruling A): same registered user owns an extra,
        // materialized, empty workspace; membership is a hard precondition above.
        const { workspaceId, headers } = await createMaterializedEmptyWorkspace(
            request,
            registered.accessToken,
        );

        // File-list API for the same user must be 200 with zero entries before the UI step.
        const list = await request.post(`${CP_URL}/api/v1/mcp`, {
            headers,
            data: {
                jsonrpc: "2.0",
                method: "tools/call",
                id: 5,
                params: { name: "list_directory", arguments: { path: "." } },
            },
        });
        expect(list.status(), await list.text()).toBe(200);
        const listBody = await list.json();
        const entries = findEntries(listBody);
        expect(
            entries,
            `list_directory entries missing: ${JSON.stringify(listBody).slice(0, 300)}`,
        ).not.toBeNull();
        // Runtime materialization always creates the hidden `.xihe-sentinel` marker; the
        // user-visible entry set is what the UI tree renders, so exclude that one system
        // artifact and require zero user files (Lead ruling A: 200 + empty, sentinel is
        // runtime-managed and never shown in the tree).
        const userEntries = entries!.filter(
            (entry) =>
                typeof entry !== "object" ||
                entry === null ||
                !("name" in entry) ||
                (entry as { name?: string }).name !== ".xihe-sentinel",
        );
        expect(
            userEntries,
            `workspace must have zero user-visible entries: ${JSON.stringify(entries)}`,
        ).toHaveLength(0);
        expect(JSON.stringify(listBody)).not.toContain("empty-probe.md");

        await page.addInitScript(
            ({ token, wsId }) => {
                localStorage.setItem("xihe-token", token);
                // Without an explicit workspace the UI falls back to the token-claim
                // (registration default) workspace; the fixture workspace must be the one
                // the page uses, so seed the same keys as helpers/journey.ts seedPage().
                localStorage.setItem("xihe-user", JSON.stringify({ workspaceId: wsId }));
                localStorage.setItem(
                    "xihe-workspace",
                    JSON.stringify({ id: wsId, name: "E2E Empty" }),
                );
            },
            { token: registered.accessToken, wsId: workspaceId },
        );
        await page.goto("/workspace/" + workspaceId, { waitUntil: "load" });
        // Toolbar is only a *ready* signal; the pass condition is the real empty-state
        // marker rendered by FileTreePanel.vue ("工作区暂无文件").
        await expect(page.getByTestId("workspace-toolbar-settings")).toBeVisible({
            timeout: 10000,
        });
        await expect(page.getByText("工作区暂无文件")).toBeVisible({ timeout: 10000 });
        await expectPlatformScreenshot(page, "workspace-empty-state.png");
    });
});
