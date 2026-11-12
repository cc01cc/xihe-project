import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";

/**
 * task-167 · 实例层「导入技能」写面（mock 车道）。
 *
 * <p>只验**一条真链路**：持有 `MANAGE_SKILL_LIBRARY` → 入口可点 → 填 JSON 批 → 提交 → 夹具返回
 * `SkillImportResponse`（`created:1`）→ 列表从 1 行变 2 行。之所以要 e2e 而不只单测：单测里
 * `submit` 是注入的假函数，这条路证明不了「面板真的把 `api.importSkillDefinitions` 接到了
 * `POST /api/v1/skills/import`，且成功后真的重取列表」。</p>
 *
 * <p>第二条用例验**无权时的入口形态**：置灰 + 理由在，对话框打不开。这是 Lead 的硬口径
 * 「不得隐藏」（隐藏 = 让人以为产品没有导入能力）。</p>
 *
 * <p>夹具口径：`GET /skills` 回 `{ items }`（`SkillListResponse`，列表不带 body）；
 * `POST /skills/import` 回 `{ results, rejected, summary }`。形状照 `docs/api/openapi.yaml`
 * 的 `SkillImportResponse`，不额外塞 UI 自己需要但契约没有的字段。</p>
 */

/** 64 位 hex：openapi 用 `^[0-9a-f]{64}$` 校验，夹具不许糊弄成短串（同 preview/mock/data/skills.ts）。 */
const HASH = "a3f1c9d2b47e8065b0c4e7f2139d5a86".repeat(2);

function skillRow(overrides: Record<string, unknown> = {}) {
    return {
        skillId: "skill-0001-instance-commit-msg",
        name: "commit-msg-review",
        definitionScope: { type: "instance", workspaceId: null },
        description: "按仓库提交规范检查 commit message。",
        bodyTokensEst: 412,
        oversize: false,
        trusted: false,
        sourcePath: "skills/commit-msg-review/SKILL.md",
        contentHash: HASH,
        version: 3,
        attachments: [],
        createdAt: "2026-11-01T09:00:00Z",
        updatedAt: "2026-11-12T07:41:00Z",
        ...overrides,
    };
}

function permissionsBody(includeSkillLibrary: boolean) {
    return {
        userId: "mock-user",
        instanceCapabilities: ["config:instance:admin"],
        instancePermissions: [
            { actionClass: "MANAGE_ROLES", resource: "*" },
            { actionClass: "MANAGE_INSTANCE_CONFIG", resource: "*" },
            ...(includeSkillLibrary
                ? [{ actionClass: "MANAGE_SKILL_LIBRARY", resource: "*" }]
                : []),
        ],
    };
}

const IMPORT_BODY = JSON.stringify(
    {
        definitionScope: { type: "instance" },
        skills: [
            {
                name: "release-notes-check",
                description: "按发布清单核对版本号、CHANGELOG 与截图证据",
                body: "## 步骤\n\n1. 读 CHANGELOG 的最新一节\n2. 核对 package.json 版本",
                sourcePath: "skills/release-notes-check/SKILL.md",
            },
        ],
    },
    null,
    2,
);

test.describe("实例层技能导入（task-167）", () => {
    // 第二条用例故意让 `/me/permissions` 少一个原子——这不是错误响应，不触达 allow 清单。
    test.use({ mockAllow: [...DEFAULT_MOCK_ALLOW] });

    test("有写权限：点导入 → 填批 → POST 200 → 列表多一行", async ({ page }) => {
        const items = [skillRow()];

        await setupMockAuth(page);
        await page.route("**/api/v1/me/permissions", (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(permissionsBody(true)),
            }),
        );
        // 只接列表：`/skills/{id}?includeBody=true` 的正文路径本用例不展开，交给兜底也无妨，
        // 但为了不让"展开正文"的 200 {} 噪声进 grep，这里显式给列表。
        await page.route(/\/api\/v1\/skills$/, (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ items }),
            }),
        );
        await page.route("**/api/v1/skills/import", (route) => {
            expect(route.request().method()).toBe("POST");
            const body = route.request().postDataJSON() as {
                definitionScope: { type: string };
                skills: Array<Record<string, unknown>>;
            };
            // 契约同形：作用域是实例、批里每条含 name/description/body/sourcePath。
            expect(body.definitionScope.type).toBe("instance");
            const created = body.skills[0];
            items.push(
                skillRow({
                    skillId: "skill-9001-release-notes-check",
                    name: created.name,
                    description: created.description,
                    sourcePath: created.sourcePath,
                    version: 1,
                }),
            );
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    results: [
                        {
                            skillId: "skill-9001-release-notes-check",
                            name: created.name,
                            action: "created",
                            version: 1,
                            bodyTokensEst: 18,
                            oversize: false,
                        },
                    ],
                    rejected: [],
                    summary: { created: 1, updated: 0, unchanged: 0, rejected: 0, oversize: 0 },
                }),
            });
        });

        await page.goto("/settings/skills");

        const entry = page.getByTestId("settings-skills-import");
        await expect(entry).toBeVisible();
        await expect(entry).toBeEnabled();
        await expect(page.getByTestId("settings-skills-import-disabled-reason")).toHaveCount(0);
        await expect(page.locator('[data-testid^="skill-item-"]')).toHaveCount(1);

        await entry.click();
        await expect(page.getByTestId("skills-import-dialog")).toBeVisible();
        await page.getByTestId("skills-import-json").fill(IMPORT_BODY);
        await page.getByTestId("skills-import-submit").click();

        // 提交成功后：对话框给"这批发生了什么"（新建 1），面板重取列表 ⇒ 2 行。
        await expect(page.getByTestId("skills-import-result")).toBeVisible();
        await expect(page.getByTestId("skills-import-result-summary")).toContainText("新建 1");
        await expect(page.locator('[data-testid^="skill-item-"]')).toHaveCount(2);
        await expect(page.getByTestId("skill-item-skill-9001-release-notes-check")).toBeVisible();
    });

    test("无写权限：入口仍在但置灰 + 理由点名原子，对话框打不开", async ({ page }) => {
        await setupMockAuth(page);
        await page.route("**/api/v1/me/permissions", (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(permissionsBody(false)),
            }),
        );
        await page.route(/\/api\/v1\/skills$/, (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ items: [skillRow()] }),
            }),
        );

        await page.goto("/settings/skills");

        const entry = page.getByTestId("settings-skills-import");
        // 隐藏 = 让人以为产品没有导入能力 ⇒ 入口必须还在。
        await expect(entry).toBeVisible();
        await expect(entry).toBeDisabled();
        const reason = page.getByTestId("settings-skills-import-disabled-reason");
        await expect(reason).toBeVisible();
        await expect(reason).toContainText("MANAGE_SKILL_LIBRARY");

        // 置灰按钮点不出对话框（Playwright 的 click 会因 disabled 超时，所以用 force 验一下没有副作用）。
        await entry.click({ force: true });
        await expect(page.getByTestId("skills-import-dialog")).toHaveCount(0);
    });
});
