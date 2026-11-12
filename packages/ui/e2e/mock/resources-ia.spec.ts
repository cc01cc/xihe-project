import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";

/**
 * PLAN-0772 M2：资源面搬出 `/settings`、成为**第三个顶层入口**（`/resources/*`）。
 *
 * <p>本 spec 只钉 M2 的**可判定**部分（信息架构与布线，不重测各面板的读写链路 —— 那些由
 * `skills-import` / `agent-principals` / `credential-manager` 等既有 spec 继续覆盖）：</p>
 * <ul>
 *   <li>全局条三个入口，`/resources` 上「资源」是当前项；设置区左栏**一个资源条目都没有**
 *       （负数判据：两个入口 = 双入口）。</li>
 *   <li>层 tab 的**存在性**必须等于后端真实层（凭据 3 / MCP 2 / 技能 3）：多画一层就是编造能力，
 *       少画一层就是藏能力。</li>
 *   <li>层 tab **写回 `?layer=`**（决策 9 的新能力：每个层都是可分享深链）。</li>
 *   <li>实例层 tab 的门槛是**能力位**（CP 守卫原文 `instance:admin`），没有能力时置灰并给理由，
 *       **不是隐藏**、也不是拿角色名特判。</li>
 *   <li>旧路径**直接删除、无 redirect**（决策 10）：渲染设置区 404 视图，URL 不跳走。</li>
 * </ul>
 *
 * <p>为什么这些要在浏览器里验：它们全都是**布线**（路由 meta、布局装配、query 解析）。单测只覆盖
 * `settingsIa` 的纯函数，证明不了「装到页面上还成立」。</p>
 */
test.describe("PLAN-0772 M2: 资源模块（/resources）信息架构", () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test("全局条第三入口 + 设置区左栏不再有资源条目（计数变 17 / 9）", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });

        await page.goto("/workspace/workspace-1/chat/session-1");
        const rail = page.getByTestId("global-rail-module-resources");
        await expect(rail).toBeVisible();
        await expect(page.locator('[data-testid^="global-rail-module-"]')).toHaveCount(3);

        await rail.click();
        await expect(page).toHaveURL(/\/resources\/credentials($|\?)/);
        await expect(rail).toHaveAttribute("aria-current", "page");
        // 资源页自带标题与层 tab（设置区的 layer header 不再负责它）。
        // 布局**不渲染 h1**（Lead 裁定：面板自带标题已够，两个同级标题读屏会念两遍）；
        // 页名由面包屑末级承担。
        await expect(page.getByTestId("resources-breadcrumb")).toContainText("凭据");
        await expect(page.getByTestId("resource-layer-tabs")).toBeVisible();

        await page.getByTestId("global-rail-module-settings").click();
        await expect(page).toHaveURL(/\/settings/);
        // 判据是**负数**：搬家后设置区左栏一个资源条目都不该有。
        await expect(page.locator('[data-testid^="settings-nav-resource-"]')).toHaveCount(0);
        // 计数也随之变（入口数徽标）：用户层 12 → **9**（只剩 9 个配置域，无权限过滤，稳定值）。
        await expect(page.getByTestId("settings-nav-count-user")).toContainText("9");
        // 实例层 22 → 16/17：12 域 + 2 运维 + 3 安全 = 17 是**满配**口径；徽标本身按权限过滤
        // （`config-locks` 要能力位、`roles` 要 MANAGE_ROLES 原子，见 `SettingsSidebar.vue` 的 opsGroups），
        // 所以 mock 身份只给能力位时是 16。断言这两值之一，避免把权限口径写死进 IA 用例。
        await expect(page.getByTestId("settings-nav-count-instance")).toHaveText(/1[67] 个入口/);
    });

    test("凭据：三层 tab、默认「我的凭据」、点全平台层写回 ?layer=INSTANCE", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await page.goto("/resources/credentials");

        await expect(page.locator('[data-testid^="resource-layer-tab-"]')).toHaveCount(3);
        await expect(page.getByTestId("resource-layer-tab-USER")).toHaveAttribute(
            "aria-selected",
            "true",
        );

        // 本用例的夹具**带工作区上下文**（`setupMockAuth` 往 sessionStorage 写 workspace-1）
        // ⇒ 「本工作区凭据」可用，点它应当写回 `?layer=WORKSPACE`。
        await page.getByTestId("resource-layer-tab-WORKSPACE").click();
        await expect(page).toHaveURL(/\/resources\/credentials\?layer=WORKSPACE/);

        await page.getByTestId("resource-layer-tab-INSTANCE").click();
        await expect(page).toHaveURL(/\/resources\/credentials\?layer=INSTANCE/);
        await expect(page.getByTestId("resource-layer-tab-INSTANCE")).toHaveAttribute(
            "aria-selected",
            "true",
        );

        // 深链可分享：直接带 query 进来也落在同一层。
        await page.goto("/resources/credentials?layer=INSTANCE");
        await expect(page.getByTestId("resource-layer-tab-INSTANCE")).toHaveAttribute(
            "aria-selected",
            "true",
        );
        // 回切也有 URL 证据（写回不是单向的）。
        await page.getByTestId("resource-layer-tab-USER").click();
        await expect(page).toHaveURL(/\/resources\/credentials\?layer=USER/);
    });

    test("没有工作区上下文时：本工作区层置灰 + 理由（不隐藏、不猜数据）", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        // 清掉工作区上下文：`workspaceContext` 的存储是 sessionStorage（唯一 SSOT），但老式 localStorage
        // 键 `xihe-workspace` 会被 `migrateLegacyWorkspace` 回填 ⇒ 两个都要清，否则上下文又"活"回来
        // （实测：只清 sessionStorage 时层 tab 仍 enabled）。
        await page.addInitScript(() => {
            localStorage.removeItem("xihe-workspace");
            sessionStorage.clear();
        });
        await page.goto("/resources/credentials");

        const workspaceTab = page.getByTestId("resource-layer-tab-WORKSPACE");
        await expect(workspaceTab).toBeVisible();
        await expect(workspaceTab).toBeDisabled();
        await expect(page.getByTestId("resource-layer-disabled-reasons")).toContainText(
            "本工作区凭据",
        );
        await expect(page.getByTestId("resource-layer-disabled-reasons")).toContainText("工作区");
    });
    test("MCP：只有两层（后端没有个人层）", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await page.goto("/resources/mcp");

        // G1：`mcp_remote_servers.workspace_id NOT NULL` ⇒ 不存在「我的 MCP」。
        await expect(page.locator('[data-testid^="resource-layer-tab-"]')).toHaveCount(2);
        await expect(page.getByTestId("resource-layer-tab-USER")).toHaveCount(0);
        // 默认层是本工作区（实体归属），而不是实例层。
        await expect(page.getByTestId("resource-layer-tab-WORKSPACE")).toHaveAttribute(
            "aria-selected",
            "true",
        );
    });

    test("实例层门槛是能力位：没有 instance:admin 时置灰 + 理由，不是隐藏", async ({ page }) => {
        await setupMockAuth(page);
        await page.goto("/resources/credentials");

        const instanceTab = page.getByTestId("resource-layer-tab-INSTANCE");
        await expect(instanceTab).toBeVisible();
        await expect(instanceTab).toBeDisabled();
        await expect(page.getByTestId("resource-layer-disabled-reasons")).toContainText(
            "实例管理员",
        );
        // 视线上仍留着（D7 留位不隐藏）。
        await expect(page.locator('[data-testid^="resource-layer-tab-"]')).toHaveCount(3);
    });

    test("技能：三层 tab 都在，个人层**不因原子置灰**（读面不挂原子）", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await page.goto("/resources/skills");

        await expect(page.locator('[data-testid^="resource-layer-tab-"]')).toHaveCount(3);
        // `T2b.3`：个人层读面不挂 `MANAGE_PERSONAL_SKILLS`（P-189-3）⇒ tab 照常可点；
        // 置灰整页会让无原子用户看不到自己已存的技能。写面才置灰（见下一条用例）。
        await expect(page.getByTestId("resource-layer-tab-USER")).toBeEnabled();
        // 技能页现在没有任何"真进不去"的层 ⇒ 页头理由列表不该出现（不是把理由功能关掉，见下一条反例）。
        await expect(page.getByTestId("resource-layer-disabled-reasons")).toHaveCount(0);

        // 全平台层是现成读面：切过去有 URL 证据（列表行数由 `skills-import` 那组 spec 钉）。
        await page.getByTestId("resource-layer-tab-INSTANCE").click();
        await expect(page).toHaveURL(/\/resources\/skills\?layer=INSTANCE/);
    });

    test("技能：本工作区层有只读面板（不是空白页）", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        // `setupMockAuth` 在 `/api/v1/**` 上挂了**兜底桩**（未匹配的端点一律回 `{}`），它会抢在 mock
        // 中间件前面把本层读面也回成空对象（实测：不挡就拿到 `{}`）⇒ 本用例自己给这条读面一个显式
        // 响应，形状照 `preview/mock/data/skills.ts` 的 `WORKSPACE_BASE`，只留列表要用的三个字段。
        await page.route(/\/api\/v1\/skills\?definitionScope=workspace/, (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    items: [
                        {
                            skillId: "skill-ws01-repo-conventions",
                            name: "repo-conventions",
                            definitionScope: { type: "workspace", workspaceId: "workspace-1" },
                        },
                        {
                            skillId: "skill-ws02-release-checklist",
                            name: "release-checklist",
                            definitionScope: { type: "workspace", workspaceId: "workspace-1" },
                        },
                        // 故意混进一条 instance 行：本层页面上绝不许它显示成「本工作区技能」。
                        {
                            skillId: "skill-x-instance-leak",
                            name: "instance-leak",
                            definitionScope: { type: "instance", workspaceId: null },
                        },
                    ],
                }),
            }),
        );

        await page.goto("/resources/skills?layer=WORKSPACE");
        await expect(page.getByTestId("workspace-skills-panel")).toBeVisible();
        // 写面未接线必须**写在页面上**：入口不隐藏、也不假装可用。
        await expect(page.getByTestId("workspace-skills-write-unavailable")).toBeVisible();
        // 读面正常时只会是「列表」或「空态」，**不许**落到错误态。
        await expect(page.getByTestId("workspace-skills-error")).toHaveCount(0);
        // 本层只显示**本工作区**的行：两条 workspace 行上屏，混进来的 instance 行被挡住并计数说出来。
        await expect(page.locator('[data-testid^="workspace-skill-item-"]')).toHaveCount(2);
        await expect(page.getByTestId("workspace-skills-foreign-ignored")).toContainText("1 条");
        await expect(
            page.locator('[data-testid="workspace-skill-item-skill-x-instance-leak"]'),
        ).toHaveCount(0);
    });
    test("技能：个人层已接线（读面不挂原子，行只来自个人库）", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        // `setupMockAuth` 在 `/api/v1/**` 上挂了兜底桩（未匹配端点一律 `{}`），会抢在 mock 中间件前面
        // 把 `/me/permissions` 也回成 `{}` ⇒ 原子投影为空、写面按钮恒 disabled。本用例要断言"有写权"的
        // 形态，所以按真实授予组显式给原子（必须注册在 `setupMockAuth` **之后**：Playwright 后注册优先）。
        await page.route("**/api/v1/me/permissions", (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    userId: "user-1",
                    instanceCapabilities: ["config:instance:admin"],
                    instancePermissions: [{ actionClass: "MANAGE_PERSONAL_SKILLS", resource: "*" }],
                }),
            }),
        );
        // 个人层读面 = `GET /skills?definitionScope=user`（**只带 scope、不带 workspaceId**）。
        await page.route(/\/api\/v1\/skills(\?|$)/, (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    items: [
                        {
                            skillId: "skill-user-1",
                            name: "my-snippets",
                            definitionScope: { type: "user", workspaceId: null },
                            description: "只属于我",
                            bodyTokensEst: 120,
                            oversize: false,
                            trusted: false,
                            sourcePath: "skills/my-snippets/SKILL.md",
                            contentHash: "a".repeat(64),
                            version: 2,
                            attachments: [],
                            updatedAt: "2026-11-12T08:00:00.000Z",
                        },
                        // 故意混进一条 instance 行：个人页面上绝不许它出现（隐私口径，比工作区面板更硬）。
                        {
                            skillId: "skill-instance-leak",
                            name: "instance-leak",
                            definitionScope: { type: "instance", workspaceId: null },
                            description: "平台定义",
                            bodyTokensEst: 10,
                            oversize: false,
                            trusted: false,
                            sourcePath: "skills/instance-leak/SKILL.md",
                            contentHash: "b".repeat(64),
                            version: 1,
                            attachments: [],
                            updatedAt: "2026-11-12T08:00:00.000Z",
                        },
                    ],
                }),
            }),
        );

        await page.goto("/resources/skills?layer=USER");
        await expect(page.getByTestId("personal-skills-panel")).toBeVisible();
        // 只显示个人库的行：混进来的 instance 行被挡住并计数说出来。
        await expect(page.locator('[data-testid^="personal-skill-item-"]')).toHaveCount(1);
        await expect(page.getByTestId("personal-skills-foreign-ignored")).toContainText("1 条");
        await expect(
            page.locator('[data-testid="personal-skill-item-skill-instance-leak"]'),
        ).toHaveCount(0);
        // 读面不挂原子 ⇒ 个人层页头**不该**有置灰理由（置灰整页会让无原子用户看不到自己已存的技能）。
        await expect(page.getByTestId("resource-layer-disabled-reasons")).toHaveCount(0);
        // 写面按原子判：夹具默认授予 `MANAGE_PERSONAL_SKILLS`（CP 默认授予每个账号，D-1019）⇒ 按钮可点。
        await expect(page.getByTestId("personal-skills-import")).toBeEnabled();
        await expect(page.getByTestId("personal-skills-import-disabled-reason")).toHaveCount(0);
    });
    test("技能：页头置灰理由仍对真进不去的层生效（不是把理由功能整体关掉）", async ({ page }) => {
        // 反例口径换成凭据：非实例管理员看 `/resources/credentials?layer=USER` 时，实例层 tab 真进不去
        // ⇒ 页头必须给出理由（技能页现在**没有**任何置灰层，用它做反例已不成立）。
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: false } });
        await page.goto("/resources/credentials?layer=USER");
        await expect(page.getByTestId("resource-layer-disabled-reasons")).toContainText(
            "全平台凭据",
        );
    });
    test("智能体：三层 tab（个人主体 / 本工作区成员 / 平台智能体）", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        // 工作区层的绑定面读 `GET /workspaces/{id}/agents`：`setupMockAuth` 的默认桩回 `{agents:[]}`，
        // 本用例自己给一条真实绑定 —— 否则"面板可见"只能证明壳在，证明不了它读到了工作区数据。
        await page.route(/\/api\/v1\/workspaces\/[^/]+\/agents/, (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    agents: [
                        {
                            principalId: "principal-ws-1",
                            name: "ws-reviewer",
                            templateId: "tpl-1",
                            templateName: "代码评审助手",
                            createdAt: "2026-11-12T00:00:00.000Z",
                            permissionsSnapshot: [],
                            bound: true,
                            hooks: [],
                            contextPolicy: null,
                            disabled: false,
                        },
                    ],
                }),
            }),
        );

        await page.goto("/resources/agents");
        // task-203：三层（USER → WORKSPACE → INSTANCE），默认层仍是个人主体。
        await expect(page.locator('[data-testid^="resource-layer-tab-"]')).toHaveCount(3);
        await expect(page.getByTestId("resource-layer-tab-USER")).toHaveAttribute(
            "aria-selected",
            "true",
        );
        await expect(page.getByTestId("resource-layer-tab-WORKSPACE")).toHaveAttribute(
            "aria-selected",
            "false",
        );

        // 工作区层 = **成员 / 绑定面**（复用既有 `WorkspaceAgentsPanel`，不是新写的空壳）。
        await page.getByTestId("resource-layer-tab-WORKSPACE").click();
        await expect(page).toHaveURL(/\/resources\/agents\?layer=WORKSPACE/);
        await expect(page.getByTestId("workspace-agent-management-dialog")).toBeVisible();
        await expect(page.getByTestId("workspace-agent-management-dialog")).toContainText(
            "ws-reviewer",
        );

        // 深链可分享：刷新后层保持（URL 是唯一口径）。
        await page.reload();
        await expect(page).toHaveURL(/\/resources\/agents\?layer=WORKSPACE/);
        await expect(page.getByTestId("resource-layer-tab-WORKSPACE")).toHaveAttribute(
            "aria-selected",
            "true",
        );
    });

    test("智能体：工作区层没有工作区上下文时给诚实态（不是空白列表）", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        // 「没有工作区上下文」要**两件事一起做**才成立（实测 task-203）：
        // ① 清掉两个存储键（只清 localStorage 会被 `migrateLegacyWorkspace` 迁回）；
        // ② `/me/permissions` 回**零工作区**——否则 auth store 启动时会按权限列表把默认工作区
        //    重新写回 sessionStorage（`stores/auth.ts` 的 `writeTabWorkspace`），tab 又变成可用。
        await page.addInitScript(() => {
            sessionStorage.removeItem("xihe-workspace");
            localStorage.removeItem("xihe-workspace");
        });
        await page.route("**/api/v1/me/permissions", (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    userId: "user-1",
                    instanceCapabilities: ["isInstanceAdmin"],
                    instancePermissions: [],
                    workspaces: [],
                }),
            }),
        );
        await page.goto("/resources/agents?layer=WORKSPACE");

        // 层 tab 仍有三枚（留位不隐藏）。深链进来时工作区层是**当前层** ⇒ 按裁定 c 不置灰
        // （否则"选中的 tab 点不动"），但正文必须是诚实态而不是空列表。
        await expect(page.locator('[data-testid^="resource-layer-tab-"]')).toHaveCount(3);
        await expect(page.getByTestId("resource-layer-tab-WORKSPACE")).toHaveAttribute(
            "aria-selected",
            "true",
        );
        await expect(page.getByTestId("resources-workspace-required")).toBeVisible();
        await expect(page.getByTestId("workspace-agent-management-dialog")).toHaveCount(0);

        // 反向护栏：不在这一层时它必须**置灰 + 给理由**（不是隐藏、也不是可点）。
        await page.goto("/resources/agents?layer=USER");
        await expect(page.getByTestId("resource-layer-tab-WORKSPACE")).toBeDisabled();
        await expect(page.getByTestId("resource-layer-disabled-reasons")).toContainText(
            "本工作区智能体",
        );
    });

    test("智能体：无 instance:admin 时实例层置灰 + 理由（不是隐藏）", async ({ page }) => {
        await setupMockAuth(page);
        await page.goto("/resources/agents");
        const instanceTab = page.getByTestId("resource-layer-tab-INSTANCE");
        await expect(page.locator('[data-testid^="resource-layer-tab-"]')).toHaveCount(3);
        await expect(instanceTab).toBeDisabled();
        await expect(page.getByTestId("resource-layer-disabled-reasons")).toContainText(
            "实例管理员",
        );
    });
    test("旧资源路径直接删除（无 redirect）：渲染 404，URL 不跳走", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        const legacy = [
            "/settings/instance/credentials",
            "/settings/instance/agents",
            "/settings/instance/mcp",
            "/settings/skills",
            "/settings/credentials",
            "/settings/agent-principals",
            "/settings/knowledge",
        ];
        for (const path of legacy) {
            await page.goto(path);
            // 决策 10：用户 2026-11-12 裁定「不用考虑旧的兼容性，要改就全改」⇒ 不留 redirect。
            await expect(page).toHaveURL(new RegExp(`${path}$`));
            await expect(page.getByTestId("settings-not-found")).toBeVisible();
        }
    });

    test("知识库是后端缺口（G3）：资源区给缺口说明页，左栏那一行不可点", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await page.goto("/resources/knowledge");
        await expect(page.getByTestId("resources-knowledge-gap")).toBeVisible();
        // 缺口资源没有层 tab（一层都不存在，画 tab 就是编造能力）。
        await expect(page.locator('[data-testid^="resource-layer-tab-"]')).toHaveCount(0);

        const gapRow = page.getByTestId("settings-nav-resource-gap-knowledge");
        await expect(gapRow).toBeVisible();
        await expect(gapRow).toHaveAttribute("aria-disabled", "true");
        await expect(page.getByTestId("settings-nav-resource-knowledge")).toHaveCount(0);
    });
});

/**
 * Lead 裁定一的判据：「只读面板必须有 API 不可用时显示什么的显式状态（不是空列表静默）」。
 *
 * <p>这条只能靠**真的让接口失败**来证明：500 时页面上必须出现错误态 + 原因 + 重试，且**不能**
 * 退化成"本工作区还没有技能"（那会把"读不到"说成"没有"）。</p>
 */
test.describe("本工作区技能 · 读失败必须显式", () => {
    // 桩出来的 500 是**有意为之**的失败面，按 mock 门禁的规矩逐条 allow。
    test.use({
        mockAllow: [...DEFAULT_MOCK_ALLOW, String.raw`\/skills\?definitionScope=workspace`],
    });

    test("500 时给错误态 + 原因（不静默成空列表）", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await page.route(/\/api\/v1\/skills\?definitionScope=workspace/, (route) =>
            route.fulfill({
                status: 500,
                contentType: "application/json",
                body: JSON.stringify({ code: "INTERNAL_ERROR", detail: "boom" }),
            }),
        );

        await page.goto("/resources/skills?layer=WORKSPACE");
        await expect(page.getByTestId("workspace-skills-error")).toBeVisible();
        await expect(page.getByTestId("workspace-skills-retry")).toBeVisible();
        await expect(page.getByTestId("workspace-skills-empty")).toHaveCount(0);
    });
});
