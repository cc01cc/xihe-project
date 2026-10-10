import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { generateE2EPassword } from "./helpers/password";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const HOST_ROOT = path.resolve(
    process.cwd(),
    "../../.tmp/e2e-host",
    process.env.XIHE_E2E_RUN_ID ?? "unknown-run",
);

test.describe("@host PLAN-0470 MCP configuration UI consumer", () => {
    test.setTimeout(90000);

    test("workspace MCP config saves and reloads through the settings UI", async ({
        page,
        request,
    }) => {
        const registration = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `plan0470-mcp-${Date.now()}@test.com`,
                password: process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword(),
                name: "PLAN0470 MCP Config",
            },
        });
        expect(registration.ok()).toBeTruthy();
        const auth = (await registration.json()) as {
            accessToken: string;
            refreshToken: string;
            workspaceId: string;
        };
        const deleteDefault = await request.delete(
            `${CP_URL}/api/v1/workspaces/${auth.workspaceId}`,
            { headers: { Authorization: `Bearer ${auth.accessToken}` } },
        );
        expect(deleteDefault.ok()).toBeTruthy();

        const hostPath = path.join(HOST_ROOT, `plan0470-mcp-config-${Date.now()}`);
        mkdirSync(hostPath, { recursive: true });
        const created = await request.post(`${CP_URL}/api/v1/workspaces`, {
            headers: {
                Authorization: `Bearer ${auth.accessToken}`,
                "Content-Type": "application/json",
                "Idempotency-Key": `plan0470-mcp-config-${Date.now()}`,
            },
            data: {
                name: "PLAN-0470 MCP Config",
                storageMode: "direct_attach",
                hostPath,
                executionMode: "windows-mxc",
            },
        });
        expect(created.status()).toBe(201);
        const workspace = (await created.json()) as { id: string };
        const refreshed = await request.post(`${CP_URL}/api/v1/auth/refresh`, {
            data: { refreshToken: auth.refreshToken },
        });
        expect(refreshed.ok()).toBeTruthy();
        const refreshedAuth = (await refreshed.json()) as {
            accessToken: string;
            workspaceId: string;
        };
        expect(refreshedAuth.workspaceId).toBe(workspace.id);
        await page.addInitScript(
            ({ token, workspaceId }) => {
                localStorage.setItem("xihe-token", token);
                localStorage.setItem("xihe-user", JSON.stringify({ workspaceId }));
                localStorage.setItem(
                    "xihe-workspace",
                    JSON.stringify({ id: workspaceId, name: "Default Workspace" }),
                );
            },
            { token: refreshedAuth.accessToken, workspaceId: refreshedAuth.workspaceId },
        );

        await page.goto("/settings/config", { waitUntil: "load" });
        await expect(page.getByTestId("settings-config-heading")).toBeVisible({ timeout: 15000 });
        const loadConfigResponse = page.waitForResponse(
            (response) =>
                response.url().includes(`/api/v1/workspaces/${workspace.id}/mcp-config`) &&
                response.request().method() === "GET",
        );
        await page.getByTestId("config-tab-workspace").click();
        expect((await loadConfigResponse).status()).toBe(200);
        const editor = page.getByTestId("mcp-config-textarea");
        await expect(editor).toBeVisible({ timeout: 15000 });
        await expect.poll(() => editor.inputValue(), { timeout: 15000 }).not.toBe("");

        const config = JSON.parse(await editor.inputValue()) as {
            mcpServers: Record<string, unknown>;
        };
        const serverName = `plan0470-${Date.now()}`;
        config.mcpServers[serverName] = {
            command: "node",
            args: ["--version"],
        };
        await editor.fill(JSON.stringify(config, null, 2));
        const mcpPanel = editor.locator("xpath=../..");
        const [saveResponse] = await Promise.all([
            page.waitForResponse(
                (response) =>
                    response.url().includes(`/api/v1/workspaces/${workspace.id}/mcp-config`) &&
                    response.request().method() === "PUT",
            ),
            mcpPanel.getByRole("button", { name: "保存", exact: true }).click(),
        ]);
        expect(saveResponse.status()).toBe(200);

        const persisted = await request.get(
            `${CP_URL}/api/v1/workspaces/${workspace.id}/mcp-config`,
            {
                headers: {
                    Authorization: `Bearer ${refreshedAuth.accessToken}`,
                    "X-Workspace-Id": workspace.id,
                },
            },
        );
        expect(persisted.ok()).toBeTruthy();
        const body = (await persisted.json()) as {
            mcpServers: Record<string, { command?: string; args?: string[] }>;
        };
        expect(body.mcpServers[serverName]).toEqual({ command: "node", args: ["--version"] });

        await page.reload({ waitUntil: "load" });
        await expect(page.getByTestId("settings-config-heading")).toBeVisible();
        const reloadedConfigResponse = page.waitForResponse(
            (response) =>
                response.url().includes(`/api/v1/workspaces/${workspace.id}/mcp-config`) &&
                response.request().method() === "GET",
        );
        await page.getByTestId("config-tab-workspace").click();
        expect((await reloadedConfigResponse).status()).toBe(200);
        const reloadedEditor = page.getByTestId("mcp-config-textarea");
        await expect(reloadedEditor).toBeVisible();
        const reloaded = JSON.parse(await reloadedEditor.inputValue()) as {
            mcpServers: Record<string, { command?: string; args?: string[] }>;
        };
        expect(reloaded.mcpServers[serverName]).toEqual({ command: "node", args: ["--version"] });
        await page.screenshot({
            path: test.info().outputPath("plan0470-mcp-config-reloaded.png"),
            fullPage: true,
        });
    });
});
