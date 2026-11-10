import { type Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setupMockAuth } from "./helpers/auth";
import { ACTION_TIMEOUT_MS } from "../timeouts";

/**
 * PLAN-0750 M3（verify.md V8 / V12）：用户层「我的智能体」关键路径冒烟。
 *
 * <p>这条冒烟证的**不是"页面能开"**，而是两个判据在真实浏览器 + 真实请求头上成立：</p>
 *
 * <ol>
 *   <li><b>V12</b>——入口在「用户配置 → 我的资源 → 我的智能体」一级（左栏资源组），
 *       直接进入 `/settings/my-agents` 就是一个能用的页面，不是缺口占位。</li>
 *   <li><b>V8 / 矩阵 U1</b>——创建请求**不带工作区上下文**。这条必须有对照，否则断言是空的：
 *       `setupMockAuth` 会往 sessionStorage 里种 `xihe-workspace`，所以本页每一条请求默认
 *       都会被 `apiAuthHeaders` 自动加上 `X-Workspace-Id`。因此本用例同时抓
 *       `GET /me/permissions` 的 header 作为**对照**（必须等于 workspace-1），
 *       再抓 `POST /agent-principals` 的 header（必须没有工作区 id）。两个一起才说明
 *       "抑制生效"而不是"这个浏览器根本没发过这个头"。</li>
 *   <li><b>T3.2</b>——没有任何可管理工作区时，绑定动作给**显式提示**而不是一个点了才 403 的按钮。</li>
 * </ol>
 *
 * <p>跑法：`pnpm exec playwright test --config e2e/playwright.config.ts e2e/mock/my-agents.spec.ts`。</p>
 */

const WORKSPACE_ID = "workspace-1";
const CREATED_PRINCIPAL_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

/** Screenshots are evidence, not fixtures: they go to the git-ignored evidence root. */
const SHOT_DIR = process.env.XIHE_SHOT_DIR
    ? resolve(process.env.XIHE_SHOT_DIR)
    : resolve(process.cwd(), "../../.local/xh-d28/shots");

async function capture(page: Page, name: string): Promise<string> {
    mkdirSync(SHOT_DIR, { recursive: true });
    const path = resolve(SHOT_DIR, `${name}.png`);
    await page.screenshot({ path, fullPage: true });
    return path;
}

type Captured = { headers: Record<string, string>; body: unknown };

async function setupMyAgentsLane(page: Page): Promise<{
    creates: Captured[];
    permissionCalls: Array<Record<string, string>>;
}> {
    await setupMockAuth(page);

    const creates: Captured[] = [];
    const permissionCalls: Array<Record<string, string>> = [];
    let created = false;

    // 普通账号：有 CREATE_OWN_AGENT，但**在任何工作区都没有** MANAGE_WORKSPACE_AGENTS。
    // 这正是矩阵 U1 最吃紧的那类账号 —— 走错门就是 403。
    await page.route("**/api/v1/me/permissions", async (route) => {
        permissionCalls.push(route.request().headers());
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                userId: "user-1",
                instanceCapabilities: [],
                instancePermissions: [{ actionClass: "CREATE_OWN_AGENT", resource: "*" }],
                workspaces: [
                    {
                        workspaceId: WORKSPACE_ID,
                        workspaceRole: "VIEWER",
                        workspaceAdmin: false,
                        permissions: [],
                    },
                ],
            }),
        });
    });

    await page.route("**/api/v1/workspaces", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([
                {
                    id: WORKSPACE_ID,
                    name: "Mock Workspace",
                    workspaceRole: "VIEWER",
                    canWrite: false,
                },
            ]),
        });
    });

    await page.route("**/api/v1/agent-principals", async (route) => {
        const request = route.request();
        if (request.method() === "POST") {
            creates.push({
                headers: request.headers(),
                body: JSON.parse(request.postData() ?? "{}"),
            });
            created = true;
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    principalId: CREATED_PRINCIPAL_ID,
                    templateId: null,
                    templateName: null,
                    createdAt: "2026-11-10T00:00:00Z",
                }),
            });
            return;
        }
        // R3：个人视图 —— 不带 workspaceId 的 GET。
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                principals: created
                    ? [
                          {
                              principalId: CREATED_PRINCIPAL_ID,
                              name: "MyAgent",
                              templateId: null,
                              templateName: null,
                              createdAt: "2026-11-10T00:00:00Z",
                              disabledAt: null,
                          },
                      ]
                    : [],
            }),
        });
    });

    return { creates, permissionCalls };
}

test.describe("PLAN-0750 M3: user-level my-agents surface", () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test("creates from the user layer without a workspace context (matrix U1)", async ({ page }) => {
        const { creates, permissionCalls } = await setupMyAgentsLane(page);

        await page.goto("/settings/my-agents");

        // V12：用户配置区的真入口，不是缺口缺省行。
        await expect(page.getByTestId("my-agents-panel")).toBeVisible({
            timeout: ACTION_TIMEOUT_MS,
        });
        await expect(
            page.locator('[data-testid="settings-nav-resource-my-agents"]'),
        ).toBeVisible();
        await expect(page.getByTestId("my-agents-empty")).toBeVisible();

        // T3.2：这类账号没有可管理工作区 ⇒ 显式提示，且不渲染绑定按钮。
        await expect(page.getByTestId("my-agents-bind-denied")).toBeVisible();
        await capture(page, "plan0750-m3-my-agents-empty");

        // U1：创建表单里**没有**工作区选择器。
        await page.getByTestId("my-agents-create-button").click();
        await expect(page.getByTestId("my-agents-create-form")).toBeVisible();
        await expect(page.getByTestId("my-agents-create-workspace")).toHaveCount(0);

        await page.getByTestId("my-agents-create-name").fill("MyAgent");
        await capture(page, "plan0750-m3-my-agents-create-form");
        await page.getByTestId("my-agents-create-submit").click();

        await expect(page.getByTestId(`my-agents-row-${CREATED_PRINCIPAL_ID}`)).toBeVisible({
            timeout: ACTION_TIMEOUT_MS,
        });
        await capture(page, "plan0750-m3-my-agents-created");

        // ---- 网络层证据（判据本体） ----
        expect(creates).toHaveLength(1);
        // 对照：本页的普通请求**确实**带着 tab 工作区 —— 证明自动注入在这个浏览器里是活的。
        expect(permissionCalls.length).toBeGreaterThan(0);
        expect(permissionCalls[0]?.["x-workspace-id"]).toBe(WORKSPACE_ID);
        // U1：创建请求必须完全没有工作区 id（空串或缺失都算"没带"）。
        expect(creates[0]!.headers["x-workspace-id"] ?? "").toBe("");
        // R4 / G3=(b)：body 只有 name，没有 workspaceId。
        expect(creates[0]!.body).toEqual({ name: "MyAgent" });
    });
});
