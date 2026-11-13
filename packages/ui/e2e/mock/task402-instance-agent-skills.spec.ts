import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";

/**
 * task-402 / `D-1243 G2`：实例智能体**技能面**（列 / 绑 / 解绑）的真指针链路。
 *
 * <p>为什么必须在浏览器里验：候选是 reka `Select`（选项只在打开时渲染），弹窗是 reka `Dialog`
 * （焦点陷阱 / Teleport / Esc）—— 这些 jsdom 都不覆盖（`packages/ui/AGENTS.md`：交互归 Playwright）。
 * 单测钉载荷与降级，这里钉「真点得动、真发得出去、真回显到列表」。</p>
 *
 * <p>**本卡的核心判据是 wire 上的 scope**：绑定/解绑请求**不带 workspaceId**（⇒ CP 派生实例档），
 * body 只有 `skillId`。真 HTTP 已在 stack-1 验过同一口径（2026-11-14 02:35：POST 201
 * `scopeType=instance`/`scopeId=null`、DELETE 204、多带一键 400），这里验的是 UI 真按它发。</p>
 *
 * <p>faces 在 spec 内桩的理由同 task-401：mock 车道 `XIHE_UI_MOCK_API=0`，预览 mock API 中间件没挂，
 * 通配兜底对未登记路径回 `200 {}` ⇒ 不桩就是「零原子 + 空列表」，入口永久禁用。</p>
 */
const PANEL_URL = "/resources/agents?layer=INSTANCE";
const PRINCIPAL_ID = "agent-seed";

type Page = import("@playwright/test").Page;

function json(body: unknown, status = 200) {
    return { status, contentType: "application/json", body: JSON.stringify(body) };
}

const SEED_AGENT = {
    principalId: PRINCIPAL_ID,
    name: "存量助手",
    description: null,
    templateId: null,
    templateName: null,
    defaultModelProvider: "anthropic",
    defaultModelName: "claude-sonnet-4-5",
    allowedModels: null,
    createdAt: "2026-11-14T00:00:00.000Z",
    disabled: false,
};

const INSTANCE_BOUND = "skill-instance-commit-msg";
const INSTANCE_FREE = "skill-instance-ui-review";
const WORKSPACE_PRIVATE = "skill-ws-repo-conventions";

function bindingRow(overrides: Record<string, unknown> = {}) {
    return {
        bindingId: "binding-seed-instance",
        principalId: PRINCIPAL_ID,
        skillId: INSTANCE_BOUND,
        name: "commit-msg",
        description: null,
        sourceType: "instance",
        sourceName: "实例技能库",
        scopeType: "instance",
        scopeId: null,
        scopeName: null,
        tokenEstimate: 180,
        createdAt: "2026-11-13T09:00:00Z",
        ...overrides,
    };
}

const SEED_BINDINGS = [
    bindingRow(),
    bindingRow({
        bindingId: "binding-seed-workspace",
        skillId: WORKSPACE_PRIVATE,
        name: "repo-conventions",
        sourceType: "workspace",
        sourceName: "Ws 一号",
        scopeType: "workspace",
        scopeId: "ws-1",
        scopeName: "Ws 一号",
        tokenEstimate: 260,
    }),
];

async function stubPermissions(page: Page): Promise<void> {
    await page.route("**/api/v1/me/permissions", (route) =>
        route.fulfill(
            json({
                userId: "user-1",
                instanceCapabilities: ["config:instance:admin"],
                instancePermissions: [{ actionClass: "MANAGE_AGENT_PRINCIPALS", resource: "*" }],
            }),
        ),
    );
}

async function stubAgentList(page: Page): Promise<void> {
    await page.route(/\/api\/v1\/instance\/agent-principals(\?.*)?$/, (route) =>
        route.fulfill(json({ principals: [SEED_AGENT], count: 1 })),
    );
}

/** 技能定义库：两条实例定义（一条已绑）+ 一条工作区私有定义（实例档不该列出）。 */
async function stubSkillCatalog(page: Page): Promise<void> {
    await page.route(/\/api\/v1\/skills(\?.*)?$/, (route) =>
        route.fulfill(
            json({
                items: [
                    {
                        skillId: INSTANCE_BOUND,
                        name: "commit-msg",
                        definitionScope: { type: "instance" },
                        description: "提交信息规范",
                        bodyTokensEst: 180,
                    },
                    {
                        skillId: INSTANCE_FREE,
                        name: "ui-review",
                        definitionScope: { type: "instance" },
                        description: "界面审阅",
                        bodyTokensEst: 240,
                    },
                    {
                        skillId: WORKSPACE_PRIVATE,
                        name: "repo-conventions",
                        definitionScope: { type: "workspace", workspaceId: "ws-1" },
                        description: "工作区私有",
                        bodyTokensEst: 260,
                    },
                ],
            }),
        ),
    );
}

/** 绑定面：GET 列表 / POST 绑定（201）/ DELETE 解绑（204），内存集合真的变。 */
async function stubBindingFace(
    page: Page,
    seed: Array<Record<string, unknown>> = SEED_BINDINGS,
): Promise<void> {
    const rows: Array<Record<string, unknown>> = seed.map((row) => ({ ...row }));
    let counter = 0;
    const base = "/api/v1/agent-principals/" + PRINCIPAL_ID + "/skills";
    await page.route(
        (url) => url.pathname.startsWith(base + "/"),
        async (route) => {
            if (route.request().method() !== "DELETE") {
                return route.fulfill(json({ code: "METHOD_NOT_ALLOWED" }, 405));
            }
            const bindingId = decodeURIComponent(
                route
                    .request()
                    .url()
                    .slice(route.request().url().indexOf(base) + base.length + 1)
                    .split("?")[0]!,
            );
            const index = rows.findIndex((row) => row.bindingId === bindingId);
            if (index < 0) return route.fulfill(json({ code: "SKILL_BINDING_NOT_FOUND" }, 404));
            rows.splice(index, 1);
            return route.fulfill({ status: 204, body: "" });
        },
    );
    await page.route(
        (url) => url.pathname === base,
        async (route) => {
            const method = route.request().method();
            if (method === "GET") return route.fulfill(json({ items: rows }));
            if (method === "POST") {
                const body = route.request().postDataJSON() as Record<string, unknown>;
                counter += 1;
                const row = bindingRow({
                    bindingId: "binding-new-" + counter,
                    skillId: body.skillId,
                    name: body.skillId === INSTANCE_FREE ? "ui-review" : String(body.skillId),
                    tokenEstimate: 240,
                    createdAt: new Date().toISOString(),
                });
                rows.push(row);
                return route.fulfill(json(row, 201));
            }
            return route.fulfill(json({ code: "METHOD_NOT_ALLOWED" }, 405));
        },
    );
}

async function openSkills(page: Page): Promise<void> {
    await page.goto(PANEL_URL);
    await page
        .getByTestId("instance-agent-skills-" + PRINCIPAL_ID)
        .click({ timeout: ACTION_TIMEOUT_MS });
    await expect(page.getByTestId("instance-agent-skills-dialog")).toBeVisible({
        timeout: EXPECT_TIMEOUT_MS,
    });
}

function captureBind(page: Page) {
    return page.waitForRequest(
        (request) =>
            request.method() === "POST" &&
            new URL(request.url()).pathname ===
                "/api/v1/agent-principals/" + PRINCIPAL_ID + "/skills",
        { timeout: EXPECT_TIMEOUT_MS },
    );
}

function captureUnbind(page: Page) {
    return page.waitForRequest(
        (request) =>
            request.method() === "DELETE" &&
            new URL(request.url()).pathname.startsWith(
                "/api/v1/agent-principals/" + PRINCIPAL_ID + "/skills/",
            ),
        { timeout: EXPECT_TIMEOUT_MS },
    );
}

async function bindFreeSkill(page: Page): Promise<void> {
    await page.getByTestId("instance-agent-skills-select").click({ timeout: ACTION_TIMEOUT_MS });
    await page
        .getByRole("option", { name: "ui-review", exact: true })
        .click({ timeout: ACTION_TIMEOUT_MS });
    const posted = captureBind(page);
    await page.getByTestId("instance-agent-skills-bind").click({ timeout: ACTION_TIMEOUT_MS });
    const request = await posted;
    // 实例档判据：**不带 workspaceId**，body 只有 skillId（scope 由服务端派生）。
    expect(new URL(request.url()).searchParams.has("workspaceId")).toBe(false);
    expect(Object.keys(request.postDataJSON() as Record<string, unknown>)).toEqual(["skillId"]);
}

test.describe("instance agent skills face (task-402)", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await stubPermissions(page);
        await stubAgentList(page);
        await stubSkillCatalog(page);
        await stubBindingFace(page);
    });

    test("列出存量绑定：两种 scope 都照实显示，候选只给实例库未绑的", async ({ page }) => {
        await openSkills(page);
        await expect(
            page.getByTestId("instance-agent-skill-item-binding-seed-instance"),
        ).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("instance-agent-skill-scope-instance")).toContainText(
            "实例级",
        );
        await expect(page.getByTestId("instance-agent-skill-scope-workspace")).toContainText(
            "工作区级",
        );

        await page
            .getByTestId("instance-agent-skills-select")
            .click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.getByRole("option", { name: "ui-review", exact: true })).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        // 已绑的与实例档绑不到的都不该出现在候选里。
        await expect(page.getByRole("option", { name: "commit-msg", exact: true })).toHaveCount(0);
        await expect(
            page.getByRole("option", { name: "repo-conventions", exact: true }),
        ).toHaveCount(0);
        await page.keyboard.press("Escape");
    });

    test("绑定：真发不带 workspaceId 的 POST，新行回显到列表", async ({ page }) => {
        await openSkills(page);
        await bindFreeSkill(page);
        await expect(page.getByTestId("instance-agent-skill-item-binding-new-1")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("instance-agent-skill-item-binding-new-1")).toContainText(
            "ui-review",
        );
    });

    test("解绑：真发不带 workspaceId 的 DELETE，行从列表消失（实例档可删工作区档行）", async ({
        page,
    }) => {
        await openSkills(page);
        const deleted = captureUnbind(page);
        await page
            .getByTestId("instance-agent-skill-unbind-binding-seed-workspace")
            .click({ timeout: ACTION_TIMEOUT_MS });
        const request = await deleted;
        expect(new URL(request.url()).searchParams.has("workspaceId")).toBe(false);
        await expect(
            page.getByTestId("instance-agent-skill-item-binding-seed-workspace"),
        ).toHaveCount(0, {
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(
            page.getByTestId("instance-agent-skill-item-binding-seed-instance"),
        ).toBeVisible();
    });

    // 这条用例**故意**桩一个 500：公共门禁默认把任何 >=400 / console error 判红，
    // 所以逐条放行「该路径的 500」（来源 = 本用例自己的夹具），不整体跳过判据。
    test.describe("degraded read", () => {
        test.use({
            mockAllow: [...DEFAULT_MOCK_ALLOW, String.raw`500.*agent-principals/agent-seed/skills`],
        });

        test("列表读失败：给失败态与重试，重试后列表回来（不静默装空）", async ({ page }) => {
            let fail = true;
            await page.route(
                (url) => url.pathname === "/api/v1/agent-principals/" + PRINCIPAL_ID + "/skills",
                async (route) => {
                    if (route.request().method() !== "GET") return route.fallback();
                    if (fail) {
                        fail = false;
                        return route.fulfill(json({ code: "INTERNAL", detail: "boom" }, 500));
                    }
                    return route.fulfill(json({ items: SEED_BINDINGS }));
                },
            );
            await openSkills(page);
            await expect(page.getByTestId("instance-agent-skills-load-failed")).toBeVisible({
                timeout: EXPECT_TIMEOUT_MS,
            });
            await expect(page.getByTestId("instance-agent-skills-empty")).toHaveCount(0);
            await page
                .getByTestId("instance-agent-skills-retry")
                .click({ timeout: ACTION_TIMEOUT_MS });
            await expect(
                page.getByTestId("instance-agent-skill-item-binding-seed-instance"),
            ).toBeVisible({
                timeout: EXPECT_TIMEOUT_MS,
            });
        });
    });

    test.describe("mobile viewport", () => {
        test.use({ viewport: { width: 390, height: 844 } });

        test("移动端同样能开面、绑、解（代表性移动 viewport）", async ({ page }) => {
            await openSkills(page);
            await bindFreeSkill(page);
            await expect(page.getByTestId("instance-agent-skill-item-binding-new-1")).toBeVisible({
                timeout: EXPECT_TIMEOUT_MS,
            });
            const deleted = captureUnbind(page);
            await page
                .getByTestId("instance-agent-skill-unbind-binding-new-1")
                .click({ timeout: ACTION_TIMEOUT_MS });
            await deleted;
            await expect(page.getByTestId("instance-agent-skill-item-binding-new-1")).toHaveCount(
                0,
                {
                    timeout: EXPECT_TIMEOUT_MS,
                },
            );
        });
    });
});
