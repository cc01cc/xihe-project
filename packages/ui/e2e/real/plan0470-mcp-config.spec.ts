// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { expect, test } from "@playwright/test";
import { ensureWorkspace } from "./helpers/workspace";
import { LONG_TIMEOUT_MS, TEST_TIMEOUT_MS } from "../timeouts";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const ADMIN_IDENTIFIER = process.env.XIHE_E2E_ADMIN_IDENTIFIER ?? "admin@xihe.local";

test.describe("@host PLAN-0470 MCP instance registry consumer", () => {
    test.setTimeout(TEST_TIMEOUT_MS);

    test("workspace MCP deep link falls back to the instance registry", async ({
        page,
        request,
    }) => {
        const adminPassword = process.env.XIHE_E2E_ADMIN_PASSWORD ?? "";
        expect(adminPassword, "XIHE_E2E_ADMIN_PASSWORD must be provided by e2e-host").not.toBe("");
        const login = await request.post(`${CP_URL}/api/v1/auth/login`, {
            data: { identifier: ADMIN_IDENTIFIER, password: adminPassword },
        });
        expect(login.ok(), await login.text()).toBe(true);
        const auth = (await login.json()) as { accessToken: string };
        const workspaceId = await ensureWorkspace(request, auth.accessToken);
        await page.addInitScript(
            ({ token, wsId }) => {
                localStorage.setItem("xihe-token", token);
                localStorage.setItem("xihe-user", JSON.stringify({ workspaceId: wsId }));
                localStorage.setItem(
                    "xihe-workspace",
                    JSON.stringify({ id: wsId, name: "Default Workspace" }),
                );
            },
            { token: auth.accessToken, wsId: workspaceId },
        );

        // task-145 / DSD-1511：MCP 的 WORKSPACE 层已迁到工作区设置，资源区只剩实例层。
        // 深链 `?layer=WORKSPACE` 必须静默回落到实例注册表，且不再发工作区 mcp-config 请求。
        const workspaceConfigRequests: string[] = [];
        page.on("request", (req) => {
            if (req.url().includes(`/api/v1/workspaces/${workspaceId}/mcp-config`)) {
                workspaceConfigRequests.push(req.url());
            }
        });

        await page.goto("/resources/mcp?layer=WORKSPACE", { waitUntil: "load" });

        const registry = page.getByTestId("instance-mcp-panel");
        await expect(registry).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await expect(
            page.getByRole("heading", { name: "实例 MCP 注册表", exact: true }),
        ).toBeVisible();

        // 可注册：实例管理员能看到稳定入口；打开表单证明注册面真的可达。
        const createButton = page.getByTestId("instance-mcp-create");
        await expect(createButton).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await expect(createButton).toHaveAccessibleName("注册 MCP 服务");
        await createButton.click();
        const createDialog = page.getByTestId("instance-mcp-create-dialog");
        await expect(createDialog).toBeVisible();
        await expect(
            createDialog.getByRole("heading", { name: "注册实例级 MCP 服务", exact: true }),
        ).toBeVisible();
        await expect(createDialog.getByTestId("instance-mcp-form-name")).toBeVisible();
        await expect(createDialog.getByTestId("instance-mcp-form-transport")).toBeVisible();
        await expect(createDialog.getByTestId("instance-mcp-form-url")).toBeVisible();
        await createDialog.getByTestId("instance-mcp-create-cancel").click();
        await expect(createDialog).toHaveCount(0);

        // workspace 层入口不存在：无工作区配置编辑面、无 WORKSPACE 页签、无设置页 MCP 面板。
        await expect(page.getByTestId("mcp-config-textarea")).toHaveCount(0);
        await expect(page.getByTestId("resource-layer-tab-WORKSPACE")).toHaveCount(0);
        await expect(page.getByTestId("resource-layer-tabs")).toHaveCount(0);
        await expect(page.getByTestId("ws-settings-mcp")).toHaveCount(0);
        expect(workspaceConfigRequests).toEqual([]);
    });
});
