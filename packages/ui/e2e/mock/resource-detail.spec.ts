import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";

/**
 * PLAN-0772 M2 / task-228：资源**详情单页**（`/resources/<id>/:pk?layer=<LAYER>`）。
 *
 * <p>为什么这必须是浏览器证据（单测替代不了）：</p>
 * <ul>
 *   <li>**层进 URL**：`beforeEnter` 的 `replace` 真的改了地址栏吗（而不是只改内存里的层）—— 单测只能
 *       证明"函数返回了 replace 对象"；</li>
 *   <li>**列表点进**：行尾的 `<ResourceDetailLink>` 真的带着 (资源, 层, pk) 跳到详情、并且**没有把
 *       行本身的点击抢走**；</li>
 *   <li>**返回栈**：浏览器后退与"无历史回落列表页"两条路径各自落到哪个 URL；</li>
 *   <li>**knowledge 不放行**：深链进缺口资源时画面是"没有详情面"，而不是一屏错误。</li>
 * </ul>
 *
 * <p>夹具口径：每条读面都按 openapi 的**信封**回（`{credentials}` / `{references}` / `{events}` /
 * `{items}` / `{agents}` / `{bindings}`），不塞 UI 自己需要但契约没有的字段；404 用例走"列表成功但
 * 没有该 pk"，**不是**故意回 4xx —— 后者会触发 mock 车道的 page-failure 门（那是另一条判据）。</p>
 */

const WORKSPACE_ID = "workspace-1";

const CREDENTIAL = {
    id: "cred-0001",
    label: "部署令牌",
    kind: "token",
    deliveryTier: "reveal",
    ownerType: "USER",
    ownerId: "user-1",
    status: "active",
    fingerprint: "fp:9c1d",
    revision: 2,
    createdAt: "2026-11-01T09:00:00Z",
    replacedAt: null,
    referenceCount: 1,
};

const SKILL = {
    skillId: "skill-0001-instance-commit-msg",
    name: "commit-msg-review",
    definitionScope: { type: "instance", workspaceId: null },
    description: "按仓库提交规范检查 commit message。",
    bodyTokensEst: 412,
    oversize: false,
    trusted: false,
    sourcePath: "skills/commit-msg-review/SKILL.md",
    contentHash: "a3f1c9d2b47e8065b0c4e7f2139d5a86".repeat(2),
    version: 3,
    attachments: [],
    createdAt: "2026-11-01T09:00:00Z",
    updatedAt: "2026-11-12T07:41:00Z",
};

const AGENT_BINDING = {
    principalId: "principal-0001",
    name: "评审主体",
    templateId: null,
    templateName: "评审模板",
    createdAt: "2026-11-01T09:00:00Z",
    permissionsSnapshot: [],
    bound: true,
    disabled: false,
    defaultModelProvider: null,
    defaultModelName: null,
};

/**
 * 能力/原子投影：夹具用户默认**零原子**（见 `MockAuthOptions.capabilities` 的注释）——
 * 凭据面板的 atom 门（`credential_manage`）不授予就只渲染 403 卡片、主体不挂载，
 * 列表行根本不会出现。本 spec 验的是"列表→详情"这条路，所以按真实授予组给原子。
 * 必须注册在 `setupMockAuth` **之后**（Playwright 后注册优先）。
 */
async function stubPermissions(page: Page, atoms: string[]): Promise<void> {
    await page.route("**/api/v1/me/permissions", (route) =>
        route.fulfill(
            json({
                userId: "user-1",
                instanceCapabilities: ["config:instance:admin"],
                instancePermissions: atoms.map((actionClass) => ({ actionClass, resource: "*" })),
            }),
        ),
    );
}

function json(body: unknown) {
    return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

/** credentials 的三条读面（列表 / 引用 / 审计）。 */
async function stubCredentials(page: Page, rows: unknown[]): Promise<void> {
    await page.route(/\/api\/v1\/credentials(\?.*)?$/, (route) =>
        route.fulfill(json({ credentials: rows, count: rows.length })),
    );
    await page.route(/\/api\/v1\/credentials\/[^/]+\/references$/, (route) =>
        route.fulfill(
            json({
                references: [
                    {
                        source: "grant",
                        subjectType: "agent",
                        subjectId: "principal-0001",
                        actionClass: "credential_use",
                        resource: "*",
                    },
                ],
            }),
        ),
    );
    await page.route(/\/api\/v1\/credentials\/[^/]+\/events(\?.*)?$/, (route) =>
        route.fulfill(
            json({
                events: [
                    {
                        id: "ev-0001",
                        eventType: "REVEALED",
                        actor: "user-1",
                        createdAt: "2026-11-02T10:00:00Z",
                    },
                ],
            }),
        ),
    );
}

async function stubSkills(page: Page): Promise<void> {
    await page.route(/\/api\/v1\/skills(\?.*)?$/, (route) =>
        route.fulfill(json({ items: [SKILL], total: 1 })),
    );
    await page.route(/\/api\/v1\/skills\/[^/]+(\?.*)?$/, (route) =>
        route.fulfill(json({ ...SKILL, body: "# commit-msg-review\n\n检查提交信息规范。" })),
    );
}

async function stubWorkspaceAgent(page: Page): Promise<void> {
    await page.route(/\/api\/v1\/workspaces\/[^/]+\/agents(\?.*)?$/, (route) =>
        route.fulfill(json({ agents: [AGENT_BINDING] })),
    );
    await page.route(/\/api\/v1\/agent-principals\/[^/]+\/roles(\?.*)?$/, (route) =>
        route.fulfill(
            json({
                items: [
                    {
                        bindingId: "role-binding-0001",
                        roleId: "role-0001",
                        name: "审查员",
                        displayName: "审查员",
                        scopeType: "workspace",
                        scopeId: WORKSPACE_ID,
                        scopeName: "工作区",
                        isSystem: false,
                        grantedBy: null,
                        atomSummary: [],
                        atomCount: 2,
                        atomsTruncated: false,
                    },
                ],
            }),
        ),
    );
    await page.route(/\/api\/v1\/agent-principals\/[^/]+\/skills(\?.*)?$/, (route) =>
        route.fulfill(
            json({
                items: [
                    {
                        bindingId: "skill-binding-0001",
                        skillId: SKILL.skillId,
                        name: SKILL.name,
                        description: null,
                        sourceType: "instance",
                        sourceName: null,
                        scopeType: "workspace",
                        scopeId: WORKSPACE_ID,
                        activatedAt: null,
                        boundAt: null,
                    },
                ],
            }),
        ),
    );
}

test.describe("PLAN-0772 task-228: 资源详情单页", () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test("凭据：列表点进 → 详情 → 浏览器后退回到同层列表", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await stubPermissions(page, ["credential_manage"]);
        await stubCredentials(page, [CREDENTIAL]);

        await page.goto("/resources/credentials?layer=USER");
        const row = page.getByTestId(`credentials-row-${CREDENTIAL.id}`);
        await expect(row).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        // 行尾详情入口带着 pk 跳转（`@click.stop` 不抢行本身的点击）。
        await page.getByTestId(`resource-detail-link-${CREDENTIAL.id}`).click();
        await expect(page).toHaveURL(`/resources/credentials/${CREDENTIAL.id}?layer=USER`, {
            timeout: ACTION_TIMEOUT_MS,
        });

        await expect(page.getByTestId("resource-detail-title")).toHaveText(CREDENTIAL.label);
        // 两条独立读面（引用 / 审计）在详情页都真的渲染出来了。
        await expect(page.getByTestId("resource-detail-section-references")).toBeVisible();
        await expect(page.getByTestId("resource-detail-section-references")).toContainText(
            "principal-0001",
        );
        await expect(page.getByTestId("resource-detail-section-events")).toContainText("REVEALED");
        await expect(page.getByTestId("resource-detail-fields")).toContainText("fp:9c1d");

        // 返回栈路径①：浏览器后退 ⇒ 回到进入时的层 tab（同一层次）。
        await page.goBack();
        await expect(page).toHaveURL("/resources/credentials?layer=USER", {
            timeout: ACTION_TIMEOUT_MS,
        });
        await expect(row).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
    });

    test("凭据：无应用内历史（直接粘详情 URL）时「返回列表」回落到同层列表", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await stubPermissions(page, ["credential_manage"]);
        await stubCredentials(page, [CREDENTIAL]);

        // 直接打开详情页：history.state.back 为空 ⇒ 后退不可用，必须回落到列表。
        await page.goto(`/resources/credentials/${CREDENTIAL.id}?layer=USER`);
        await expect(page.getByTestId("resource-detail-title")).toHaveText(CREDENTIAL.label);
        await page.getByTestId("resource-detail-back").click();
        await expect(page).toHaveURL("/resources/credentials?layer=USER", {
            timeout: ACTION_TIMEOUT_MS,
        });
        await expect(page.getByTestId(`credentials-row-${CREDENTIAL.id}`)).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
    });

    test("技能：列表点进 → 详情（含正文）→ 后退回同层列表", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await stubSkills(page);

        await page.goto("/resources/skills?layer=INSTANCE");
        const row = page.getByTestId(`skill-item-${SKILL.skillId}`);
        await expect(row).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await page.getByTestId(`resource-detail-link-${SKILL.skillId}`).click();
        await expect(page).toHaveURL(`/resources/skills/${SKILL.skillId}?layer=INSTANCE`, {
            timeout: ACTION_TIMEOUT_MS,
        });

        await expect(page.getByTestId("resource-detail-title")).toHaveText(SKILL.name);
        await expect(page.getByTestId("resource-detail-block")).toContainText("检查提交信息规范");

        await page.goBack();
        await expect(page).toHaveURL("/resources/skills?layer=INSTANCE", {
            timeout: ACTION_TIMEOUT_MS,
        });
    });

    test("?layer= 强制：缺省补默认层、非法值回落默认层，都写回地址栏", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await stubCredentials(page, [CREDENTIAL]);

        // 缺省 layer：credentials 默认层 = USER。
        await page.goto(`/resources/credentials/${CREDENTIAL.id}`);
        await expect(page).toHaveURL(`/resources/credentials/${CREDENTIAL.id}?layer=USER`, {
            timeout: ACTION_TIMEOUT_MS,
        });

        // 非法 layer：不给 404，回落到默认层并改 URL（不是只改内存里的层）。
        await page.goto(`/resources/credentials/${CREDENTIAL.id}?layer=SESSION`);
        await expect(page).toHaveURL(`/resources/credentials/${CREDENTIAL.id}?layer=USER`, {
            timeout: ACTION_TIMEOUT_MS,
        });
        await expect(page.getByTestId("resource-detail-title")).toHaveText(CREDENTIAL.label);
    });

    test("pk 不存在 ⇒ 404 诚实态（不是未接线、不是错误页）", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await stubCredentials(page, [CREDENTIAL]);

        await page.goto("/resources/credentials/does-not-exist?layer=USER");
        await expect(page.getByTestId("resource-detail-not-found")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("resource-detail-not-found")).toContainText("找不到这条资源");
        await expect(page.getByTestId("resource-detail-unwired")).toHaveCount(0);
    });

    test("knowledge 不放行详情（0 层 + G3）：画面是「没有详情面」，且层规范化为 WORKSPACE", async ({
        page,
    }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });

        await page.goto("/resources/knowledge/any-kb?layer=INSTANCE");
        await expect(page).toHaveURL("/resources/knowledge/any-kb?layer=WORKSPACE", {
            timeout: ACTION_TIMEOUT_MS,
        });
        await expect(page.getByTestId("resource-detail-unwired")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("resource-detail-unwired")).toContainText("知识库没有实体");
        await expect(page.getByTestId("resource-detail-body")).toHaveCount(0);
    });

    test("agents 的 ?layer=WORKSPACE 能进（三层资源不止个人层）", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await stubWorkspaceAgent(page);

        await page.goto(`/resources/agents/${AGENT_BINDING.principalId}?layer=WORKSPACE`);
        await expect(page.getByTestId("resource-detail-title")).toHaveText(AGENT_BINDING.name, {
            timeout: EXPECT_TIMEOUT_MS,
        });
        // 徽标文案与层 tab 同源（agents 的工作区层 = 「本工作区智能体」，不是裸层名）。
        await expect(page.getByTestId("resource-detail-layer")).toHaveText("本工作区智能体");
        await expect(page.getByTestId("resource-detail-section-roles")).toContainText("审查员");
        await expect(page.getByTestId("resource-detail-section-skills")).toContainText(SKILL.name);
    });
});
