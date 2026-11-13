/**
 * R17（`task-40`）：VIEWER 只读 —— **资源区四个写面**的权限断言。
 *
 * 背景：已关闭的 C1（工作区 MCP 面板 `readonly` 在搬家时丢失 ⇒ VIEWER 可保存）是 P0 级回归。
 * 搬一次家就丢一次门，靠人记得是不够的 —— 本文件给四个资源页各钉一条**机器可判**的断言。
 *
 * ## 为什么不是「一个断言顶四页」
 *
 * 四页的写面**东西不一样**（读源码后写死，别把它们画成一个样子）：
 *
 * | 页 | 写面 | 只读时的形态 | 出处 |
 * | --- | --- | --- | --- |
 * | `/resources/mcp` | JSON 配置 textarea（+ 保存按钮、远程 OAuth 授权按钮） | textarea **在 DOM 且 disabled**；保存/授权按钮 **不渲染** | `McpResourceView.vue:42` 传 `:readonly`；`WorkspaceMcpPanel.vue:240` `disabled`、`:245`/`:279` `v-if="!readonly"` |
 * | `/resources/credentials` | 新建 / 删除凭据 | 没有原子 `credential_manage` ⇒ 403 说明卡**在 DOM**、新建按钮**不渲染** | `CredentialsPanel.vue:43` `canManage`、`:185`/`:196` |
 * | `/resources/skills?layer=WORKSPACE` | **本层没有写面**（未接线，与角色无关） | 「写面未接线」提示在 DOM，无任何写控件 | `WorkspaceSkillsPanel.vue:137` |
 * | `/resources/knowledge` | **没有实体**（后端缺口 G3，D-1019） | 缺口说明在 DOM，写入口已撤 | `KnowledgeResourceView.vue:26/35` |
 *
 * ⇒ 判据必须**逐页取本页的真形态**。硬套「控件 disabled 且在 DOM」会得到两种假绿：
 * ① 在「本来就没有写面」的两页上恒真（空转断言）；② 在「按产品口径不渲染」的两页上必红，
 * 红了以后被 `skip` 掉，最后还是没人看。
 *
 * ## 三条防假绿
 *
 * 1. **阳性锚点**：每页先断言「页面渲染出来了、而且读到了内容」（标题 / 列表行 / 缺口说明），
 *    否则「看不见写按钮」可能只是因为整页没渲染（路由 404、权限整页 deny）。
 * 2. **阳性对照**：MCP 与凭据各有一条 EDITOR / 有原子的用例 —— 同一条断言在可写身份下**必须为假**。
 *    没有对照的负断言分不清「门是活的」与「门一直关着（页面根本没渲染）」。
 * 3. **可写控件扫描**：`enabledWriteControls()` 扫正文里所有 enabled 且 testid 像写动作的控件，
 *    必须为空 —— 这条抓的是「新增了一个写按钮而没人加断言」。
 *
 * 判据承重性（改坏它必须红）见 `evidence/2026-11-13-r17-viewer-readonly/README.md`：
 * 把 `McpResourceView.vue:42` 的 `:readonly` 去掉 ⇒ 本文件 MCP 两条 must fail（已实测）。
 */
import { expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { setupMockAuth } from "./helpers/auth";

const WORKSPACE_ID = "workspace-1";

type WorkspaceRole = "VIEWER" | "EDITOR";

interface BootOptions {
    role: WorkspaceRole;
    /** 显式覆盖 CP 的可写投影。省略 = 让前端按角色回落（`canWriteWorkspace` 的第二种来源）。 */
    canWrite?: boolean;
    /** `/me/permissions` 的实例原子投影。省略 = 空投影（夹具默认零能力）。 */
    instancePermissions?: string[];
}

/**
 * 装好资源页需要的最小面：登录态 + 页签工作区（含角色）+ 兜底 API。
 *
 * 注意 `workspaces/workspace-1` 这条桩：**不要**顺手塞 `canWrite: true`。
 * `auth.canWriteWorkspace` 的取值是 `workspace.canWrite ?? workspaceRole !== "VIEWER"`
 * （`stores/auth.ts:203-205`）⇒ 桩里带 `canWrite` 就会盖掉角色投影，VIEWER 也被判成可写，
 * 这条用例会以**假绿**的方式通过（面板真的可编辑，而断言只看到了"页面在"）。
 */
async function bootResourcePage(page: Page, options: BootOptions): Promise<void> {
    await setupMockAuth(page, {
        workspace: { workspaceRole: options.role },
        ...(options.instancePermissions ? { capabilities: { isInstanceAdmin: false } } : undefined),
    });

    // 兜底：未桩的端点一律 200 `{}`（与 `plan-0560-settings.spec.ts` 同形；mock 车道没有真后端）。
    await page.route("**/api/v1/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );

    // 工作区外壳会拉会话列表；兜底的 `{}` 会让它报 "missing sessions" 并整页加载失败。
    await page.route(/\/api\/v1\/(?:workspaces\/[^/]+\/)?sessions(?:\?.*)?$/, (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessions: [] }),
        });
    });

    await page.route(`**/api/v1/workspaces/${WORKSPACE_ID}`, (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                id: WORKSPACE_ID,
                name: "Mock Workspace",
                ownerId: "user-1",
                workspaceRole: options.role,
                ...(options.canWrite === undefined ? {} : { canWrite: options.canWrite }),
            }),
        }),
    );

    // MCP 配置读面：给一个**真实形状**的配置（不是 `{}`），否则 textarea 里没有可读内容，
    // "禁用的框里有没有东西"就验不出来了。
    await page.route(`**/api/v1/workspaces/${WORKSPACE_ID}/mcp-config`, (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                mcpServers: { "r17-demo": { command: "node", args: ["server.js"] } },
            }),
        }),
    );

    // 本工作区技能读面：两行，用来证明"读面可用"（写面未接线不等于整页没内容）。
    await page.route(/\/api\/v1\/skills\?definitionScope=workspace/, (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                items: [
                    {
                        skillId: "skill-r17-a",
                        name: "repo-conventions",
                        definitionScope: { type: "workspace", workspaceId: WORKSPACE_ID },
                    },
                    {
                        skillId: "skill-r17-b",
                        name: "release-checklist",
                        definitionScope: { type: "workspace", workspaceId: WORKSPACE_ID },
                    },
                ],
            }),
        }),
    );

    const permissions = options.instancePermissions;
    if (permissions) {
        await page.route("**/api/v1/me/permissions", (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    userId: "user-1",
                    instanceCapabilities: [],
                    instancePermissions: permissions.map((actionClass) => ({
                        actionClass,
                        resource: "*",
                    })),
                    workspaces: [],
                }),
            }),
        );
    }
}

/**
 * 正文里所有**可用**的写动作控件（testid 词面命中 `WRITE_VERB`）。
 *
 * 为什么限定在 `main`：左栏导航里也有"新建"类入口（工作区/会话），它们不是资源页的写面。
 * 为什么排除 disabled：本函数的语义就是「能点的写动作」。
 */
async function enabledWriteControls(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const scope = document.querySelector("main") ?? document.body,
            nodes = [
                ...scope.querySelectorAll<HTMLElement>(
                    'button, input, textarea, select, [role="button"], [role="switch"]',
                ),
            ];
        return nodes
            .filter((node) => {
                const testid = node.getAttribute("data-testid") ?? "",
                    blocked =
                        (node as HTMLButtonElement).disabled ||
                        (node as HTMLInputElement).readOnly === true ||
                        node.getAttribute("aria-disabled") === "true";
                if (!testid) return false;
                if (
                    !/save|create|delete|remove|import|apply|update|submit|write|revoke|upload|append|rename|reset|clear/i.test(
                        testid,
                    )
                ) {
                    return false;
                }
                return !blocked;
            })
            .map((node) => node.getAttribute("data-testid") ?? "(no-testid)");
    });
}

test.describe("R17 VIEWER 只读 · 资源页写面", () => {
    test("MCP（VIEWER）：配置框在 DOM 且 disabled，保存按钮不出现", async ({ page }) => {
        await bootResourcePage(page, { role: "VIEWER" });
        await page.goto("/resources/mcp?layer=WORKSPACE", { waitUntil: "load" });

        // 阳性锚点：资源页外壳在。
        await expect(page.getByTestId("resources-header")).toBeVisible();

        const textarea = page.getByTestId("mcp-config-textarea");
        // ① 写面**在 DOM**（不是"整块没渲染"）——这是「没权限」与「没渲染」的分水岭。
        await expect(textarea).toBeVisible();
        // ② 而且它带着读面内容（配置真被渲染了，不是空壳占位）。
        await expect(textarea).toHaveValue(/"r17-demo"/);
        // ③ 不可编辑。
        await expect(textarea).toBeDisabled();

        // ④ 保存 / 授权按钮按产品口径**不渲染**（`WorkspaceMcpPanel.vue:245/279` 的 `v-if="!readonly"`）;
        //    这条与 `plan-0560-settings.spec.ts:139` 同源，本文件不另立相反口径。
        await expect(page.getByTestId("mcp-config-save")).toHaveCount(0);
        await expect(page.locator('[data-testid^="remote-mcp-"] button')).toHaveCount(0);

        // ⑤ 兜底：正文里没有别的可用写控件。
        expect(await enabledWriteControls(page)).toEqual([]);
    });

    test("MCP（EDITOR，阳性对照）：同一屏可写 —— 证明上面的断言不是「页面没渲染」", async ({
        page,
    }) => {
        await bootResourcePage(page, { role: "EDITOR", canWrite: true });
        await page.goto("/resources/mcp?layer=WORKSPACE", { waitUntil: "load" });

        const textarea = page.getByTestId("mcp-config-textarea");
        await expect(textarea).toBeVisible();
        await expect(textarea).toBeEnabled();
        await expect(page.getByTestId("mcp-config-save")).toBeVisible();
    });

    test("凭据（VIEWER）：没有 credential_manage ⇒ 403 说明在 DOM、新建按钮不渲染", async ({
        page,
    }) => {
        await bootResourcePage(page, { role: "VIEWER" });
        await page.goto("/resources/credentials?layer=WORKSPACE", { waitUntil: "load" });

        // 阳性锚点：页面标题在（不是整页 404 / 整页 deny）。
        await expect(page.getByTestId("settings-page-title")).toBeVisible();
        // 写面被**说清楚**：403 说明卡在 DOM。
        await expect(page.getByTestId("credentials-manage-denied")).toBeVisible();
        // 新建按钮不渲染（`v-if="canManage"`），刷新按钮仍可用（读面不受影响）。
        await expect(page.getByTestId("credentials-create-button")).toHaveCount(0);
        await expect(page.getByTestId("credentials-refresh")).toBeEnabled();

        expect(await enabledWriteControls(page)).toEqual([]);
    });

    test("凭据（有 credential_manage，阳性对照）：新建按钮出现", async ({ page }) => {
        await bootResourcePage(page, {
            role: "EDITOR",
            canWrite: true,
            instancePermissions: ["credential_manage"],
        });
        await page.goto("/resources/credentials?layer=WORKSPACE", { waitUntil: "load" });

        await expect(page.getByTestId("credentials-create-button")).toBeVisible();
        await expect(page.getByTestId("credentials-manage-denied")).toHaveCount(0);
    });

    test("技能（VIEWER，本工作区层）：写面未接线写在页面上，读面照常可用", async ({ page }) => {
        await bootResourcePage(page, { role: "VIEWER" });
        await page.goto("/resources/skills?layer=WORKSPACE", { waitUntil: "load" });

        await expect(page.getByTestId("workspace-skills-panel")).toBeVisible();
        // **本层写面不存在是设计态，不是权限态** —— 断言它必须写在页面上（否则读者会以为是自己没权限）。
        await expect(page.getByTestId("workspace-skills-write-unavailable")).toBeVisible();
        // 读面可用：两行上屏。
        await expect(page.locator('[data-testid^="workspace-skill-item-"]')).toHaveCount(2);
        // 也没有任何可用写控件（有就是新加的面，需要另立判据）。
        expect(await enabledWriteControls(page)).toEqual([]);
    });

    test("知识库（VIEWER）：后端缺口页 —— 无层 tab、无写控件、缺口原因在 DOM", async ({ page }) => {
        await bootResourcePage(page, { role: "VIEWER" });
        await page.goto("/resources/knowledge", { waitUntil: "load" });

        await expect(page.getByTestId("resources-knowledge-gap")).toBeVisible();
        // D-1019：撤掉的是入口不是能力；这句必须还在，否则读者会来问"哪里能建库"。
        await expect(page.getByTestId("resources-knowledge-write-gone")).toBeVisible();
        // 一层都不存在 ⇒ 不画层 tab（画了就是编造能力）。
        await expect(page.locator('[data-testid^="resource-layer-tab-"]')).toHaveCount(0);

        expect(await enabledWriteControls(page)).toEqual([]);
    });
});
