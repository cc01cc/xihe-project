import { expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";

/**
 * task-401 / `D-1248`：实例智能体**创建面**的模型意图（provider＞连接＞模型）真指针链路。
 *
 * <p>为什么必须在浏览器里验：三段是 reka `Select`（选项只在打开时渲染、程序化选择在 jsdom 不可靠，
 * `packages/ui/AGENTS.md` 明写交互归 Playwright）。单测钉载荷与阻塞态，这里钉「真点得动、真发得出去、
 * 真回显到列表」。</p>
 *
 * <p>**为什么 faces 要在 spec 内桩**：mock e2e 车道 `XIHE_UI_MOCK_API=0`，预览用的 mock API 中间件
 * 没挂（`helpers/auth.ts:632` 注释），通配兜底对未登记路径回 `200 {}` ⇒ 不桩就是「0 个智能体 + 零原子」，
 * 创建按钮永久禁用。桩的形态照契约给：列表信封 `{principals,count}`、创建回 201 且**按 body 承载模型三字段**
 * （与 `src/preview/mock/data/instanceResources.ts` 同口径）、`/models` 按 connectionId 聚合。</p>
 */
const PANEL_URL = "/resources/agents?layer=INSTANCE";

type Page = import("@playwright/test").Page;

function json(body: unknown, status = 200) {
    return { status, contentType: "application/json", body: JSON.stringify(body) };
}

const CHAT_CONNECTION = {
    id: "conn-claude-primary",
    providerId: "anthropic",
    connectionKey: "conn-claude-primary",
    apiTypeId: "anthropic-messages",
    apiTypeVersion: 1,
    operation: "chat",
    label: "Claude 主连接",
    scope: "INSTANCE",
    modelDiscovery: "curated",
    manualModels: [],
    hasKey: true,
    enabled: true,
    status: "READY",
    revision: 1,
};

const EMBEDDING_CONNECTION = {
    ...CHAT_CONNECTION,
    id: "conn-embed-primary",
    providerId: "openai",
    connectionKey: "conn-embed-primary",
    apiTypeId: "openai-embeddings",
    operation: "embedding",
    label: "嵌入连接",
};

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

async function stubModelFaces(page: Page): Promise<void> {
    await page.route("**/api/v1/provider-catalog", (route) =>
        route.fulfill(
            json({
                catalogRevision: "mock-1",
                providers: [
                    { id: "anthropic", displayName: "Anthropic" },
                    { id: "openai", displayName: "OpenAI" },
                ],
            }),
        ),
    );
    await page.route("**/api/v1/provider-connections", (route) =>
        route.fulfill(json({ connections: [CHAT_CONNECTION, EMBEDDING_CONNECTION] })),
    );
    // 必须注册在 setupMockAuth **之后**：helper 给 `/models` 挂了 `{models:{}}`（后注册优先）。
    await page.route("**/api/v1/models", (route) =>
        route.fulfill(
            json({
                providers: {
                    "conn-claude-primary": {
                        providerId: "anthropic",
                        connectionId: "conn-claude-primary",
                        status: "ready",
                        models: [
                            { name: "claude-sonnet-4-5", capabilities: { chat: true } },
                            { name: "claude-haiku-4-5", capabilities: { chat: true } },
                            { name: "voyage-3", capabilities: { chat: false } },
                        ],
                    },
                },
            }),
        ),
    );
}

const SEED_AGENT = {
    principalId: "agent-seed",
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

/**
 * 智能体面：GET 列表 / POST 创建（201，按 body 承载模型三字段）/ PATCH 模型意图。
 * PATCH 照 cp-1 `task-413`（dedd832a5）语义：present 替换、absent 保留、显式 null 清除；
 * 回 `AgentPrincipalUpdateView`（不是整行）。名称/说明/disabled 不在写面上 ⇒ 400。
 */
async function stubAgentFace(page: Page, seed: Array<Record<string, unknown>> = []): Promise<void> {
    const rows: Array<Record<string, unknown>> = [...seed];
    await page.route(/\/api\/v1\/instance\/agent-principals\/[^/?]+(\?.*)?$/, async (route) => {
        if (route.request().method() !== "PATCH") {
            return route.fulfill(json({ code: "METHOD_NOT_ALLOWED" }, 405));
        }
        const id = new URL(route.request().url()).pathname.split("/").pop();
        const index = rows.findIndex((row) => row.principalId === id);
        if (index < 0) return route.fulfill(json({ code: "NOT_FOUND" }, 404));
        const body = route.request().postDataJSON() as Record<string, unknown>;
        const allowed = new Set([
            "defaultModelProvider",
            "defaultModelName",
            "allowedModels",
            "hooks",
            "contextPolicy",
            "delegationPolicy",
        ]);
        const keys = Object.keys(body);
        const foreign = keys.filter((key) => !allowed.has(key));
        if (keys.length === 0 || foreign.length > 0) {
            return route.fulfill(
                json({ code: "INVALID_REQUEST", detail: foreign.join(",") || "empty" }, 400),
            );
        }
        const current = rows[index] as Record<string, unknown>;
        const updated = { ...current, ...body };
        rows.splice(index, 1, updated);
        return route.fulfill(
            json({
                principalId: id,
                defaultModelProvider: updated.defaultModelProvider ?? null,
                defaultModelName: updated.defaultModelName ?? null,
                allowedModels: updated.allowedModels ?? null,
                hooks: null,
                contextPolicy: null,
                delegationPolicy: null,
            }),
        );
    });
    await page.route(/\/api\/v1\/instance\/agent-principals(\?.*)?$/, async (route) => {
        const method = route.request().method();
        if (method === "GET") {
            return route.fulfill(json({ principals: rows, count: rows.length }));
        }
        if (method === "POST") {
            const body = route.request().postDataJSON() as Record<string, unknown>;
            const row = {
                principalId: `agent-${rows.length + 1}`,
                name: body.name,
                description: body.description ?? null,
                templateId: null,
                templateName: null,
                defaultModelProvider: body.defaultModelProvider ?? null,
                defaultModelName: body.defaultModelName ?? null,
                allowedModels: body.allowedModels ?? null,
                createdAt: new Date().toISOString(),
                disabled: false,
            };
            rows.push(row);
            return route.fulfill(json(row, 201));
        }
        return route.fulfill(json({ code: "METHOD_NOT_ALLOWED" }, 405));
    });
}

async function openCreateDialog(page: Page, name: string): Promise<void> {
    await page.goto(PANEL_URL);
    await page.getByTestId("instance-agents-create").click({ timeout: ACTION_TIMEOUT_MS });
    await expect(page.getByTestId("instance-agents-create-dialog")).toBeVisible({
        timeout: EXPECT_TIMEOUT_MS,
    });
    await page.getByTestId("instance-agents-form-name").fill(name);
}

async function pickProvider(page: Page, label = "Anthropic"): Promise<void> {
    await page.getByTestId("instance-agents-form-provider").click({ timeout: ACTION_TIMEOUT_MS });
    await page
        .getByRole("option", { name: label, exact: true })
        .click({ timeout: ACTION_TIMEOUT_MS });
}

async function pickConnection(page: Page, label = "Claude 主连接"): Promise<void> {
    await page.getByTestId("instance-agents-form-connection").click({ timeout: ACTION_TIMEOUT_MS });
    await page
        .getByRole("option", { name: label, exact: true })
        .click({ timeout: ACTION_TIMEOUT_MS });
}

async function pickModel(page: Page, name = "claude-sonnet-4-5"): Promise<void> {
    await page.getByTestId("instance-agents-form-model-name").click({ timeout: ACTION_TIMEOUT_MS });
    await page.getByRole("option", { name, exact: true }).click({ timeout: ACTION_TIMEOUT_MS });
}

function captureCreate(page: Page) {
    return page.waitForRequest(
        (request) =>
            request.method() === "POST" &&
            new URL(request.url()).pathname === "/api/v1/instance/agent-principals",
        { timeout: EXPECT_TIMEOUT_MS },
    );
}

async function pickIn(page: Page, triggerTestId: string, option: string): Promise<void> {
    await page.getByTestId(triggerTestId).click({ timeout: ACTION_TIMEOUT_MS });
    await page
        .getByRole("option", { name: option, exact: true })
        .click({ timeout: ACTION_TIMEOUT_MS });
}

function capturePatch(page: Page, id: string) {
    return page.waitForRequest(
        (request) =>
            request.method() === "PATCH" &&
            new URL(request.url()).pathname === `/api/v1/instance/agent-principals/${id}`,
        { timeout: EXPECT_TIMEOUT_MS },
    );
}

function rowOf(page: Page, name: string) {
    return page.locator('[data-testid^="instance-agent-row-"]').filter({ hasText: name });
}

test.describe("instance agent model intent on create (task-401)", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await stubPermissions(page);
        await stubModelFaces(page);
        await stubAgentFace(page);
    });

    test("真指针选满三段：请求带模型意图，列表行回显它", async ({ page }) => {
        await openCreateDialog(page, "E2E 模型甲");
        await pickProvider(page);
        await pickConnection(page);
        await pickModel(page);

        const created = captureCreate(page);
        await page
            .getByTestId("instance-agents-create-submit")
            .click({ timeout: ACTION_TIMEOUT_MS });
        const body = (await created).postDataJSON() as Record<string, unknown>;
        // 连接**不上 wire**（契约：principal 不持有连接）；未勾选就不带 allowedModels。
        expect(body).toEqual({
            name: "E2E 模型甲",
            defaultModelProvider: "anthropic",
            defaultModelName: "claude-sonnet-4-5",
        });
        await expect(rowOf(page, "E2E 模型甲")).toContainText("anthropic / claude-sonnet-4-5", {
            timeout: EXPECT_TIMEOUT_MS,
        });
    });

    test("勾「只允许这个模型」：allowedModels 白名单进载荷", async ({ page }) => {
        await openCreateDialog(page, "E2E 模型乙");
        await pickProvider(page);
        await pickConnection(page);
        await pickModel(page);
        await page
            .getByTestId("instance-agents-form-restrict")
            .click({ timeout: ACTION_TIMEOUT_MS });

        const created = captureCreate(page);
        await page
            .getByTestId("instance-agents-create-submit")
            .click({ timeout: ACTION_TIMEOUT_MS });
        const body = (await created).postDataJSON() as Record<string, unknown>;
        expect(body.allowedModels).toEqual([{ provider: "anthropic", model: "claude-sonnet-4-5" }]);
    });

    test("半组选择：提交禁用且点名判据，补全后放行", async ({ page }) => {
        await openCreateDialog(page, "E2E 半组");
        await pickProvider(page);

        await expect(page.getByTestId("instance-agents-model-incomplete")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("instance-agents-create-submit")).toBeDisabled();

        await pickConnection(page);
        await pickModel(page);
        await expect(page.getByTestId("instance-agents-model-incomplete")).toHaveCount(0);
        await expect(page.getByTestId("instance-agents-create-submit")).toBeEnabled();
    });

    test("三段留空：载荷一个模型键都不带，行模型列是 —（沿用平台默认）", async ({ page }) => {
        await openCreateDialog(page, "E2E 无模型");
        const created = captureCreate(page);
        await page
            .getByTestId("instance-agents-create-submit")
            .click({ timeout: ACTION_TIMEOUT_MS });
        const body = (await created).postDataJSON() as Record<string, unknown>;
        expect(body).toEqual({ name: "E2E 无模型" });
        await expect(rowOf(page, "E2E 无模型")).toContainText("—", { timeout: EXPECT_TIMEOUT_MS });
    });
});

test.describe("instance agent model intent · mobile (task-401)", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await stubPermissions(page);
        await stubModelFaces(page);
        await stubAgentFace(page);
    });

    test("390×844：三段单列不塌，仍能选满并创建", async ({ page }) => {
        await openCreateDialog(page, "E2E 移动模型");
        await expect(page.getByTestId("instance-agents-form-provider")).toBeVisible();
        await expect(page.getByTestId("instance-agents-form-connection")).toBeVisible();
        await expect(page.getByTestId("instance-agents-form-model-name")).toBeVisible();

        await pickProvider(page);
        await pickConnection(page);
        await pickModel(page);
        const created = captureCreate(page);
        await page
            .getByTestId("instance-agents-create-submit")
            .click({ timeout: ACTION_TIMEOUT_MS });
        const body = (await created).postDataJSON() as Record<string, unknown>;
        expect(body.defaultModelName).toBe("claude-sonnet-4-5");
        await expect(rowOf(page, "E2E 移动模型")).toContainText("anthropic / claude-sonnet-4-5", {
            timeout: EXPECT_TIMEOUT_MS,
        });
    });
});

test.describe("instance agent model intent on edit (task-401 · cp-1 task-413)", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await stubPermissions(page);
        await stubModelFaces(page);
        await stubAgentFace(page, [{ ...SEED_AGENT }]);
    });

    test("真指针换模型：预填后无改动禁用，改了才 PATCH，行回显新模型", async ({ page }) => {
        await page.goto(PANEL_URL);
        await page
            .getByTestId("instance-agent-edit-agent-seed")
            .click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.getByTestId("instance-agents-edit-dialog")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("instance-agents-edit-current")).toHaveText(
            "anthropic / claude-sonnet-4-5",
            { timeout: EXPECT_TIMEOUT_MS },
        );
        // 存量意图映射到可见连接 ⇒ 三段预填；原样保存没有可写的改动 ⇒ 不白写一次。
        await expect(page.getByTestId("instance-agents-edit-submit")).toBeDisabled();

        await pickIn(page, "instance-agents-edit-form-model-name", "claude-haiku-4-5");
        const patched = capturePatch(page, "agent-seed");
        await page.getByTestId("instance-agents-edit-submit").click({ timeout: ACTION_TIMEOUT_MS });
        // 名称/说明不在这个写面上；未勾白名单且换了模型 ⇒ 显式 null 清旧白名单。
        expect((await patched).postDataJSON()).toEqual({
            defaultModelProvider: "anthropic",
            defaultModelName: "claude-haiku-4-5",
            allowedModels: null,
        });
        await expect(rowOf(page, "存量助手")).toContainText("anthropic / claude-haiku-4-5", {
            timeout: EXPECT_TIMEOUT_MS,
        });
    });
});

test.describe("instance agent model intent · mobile edit (task-401)", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await stubPermissions(page);
        await stubModelFaces(page);
        await stubAgentFace(page, [{ ...SEED_AGENT }]);
    });

    test("390×844：勾清除 ⇒ 三键全 null，行模型列回 —（沿用平台默认）", async ({ page }) => {
        await page.goto(PANEL_URL);
        await page
            .getByTestId("instance-agent-edit-agent-seed")
            .click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.getByTestId("instance-agents-edit-dialog")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await page.getByTestId("instance-agents-edit-clear").click({ timeout: ACTION_TIMEOUT_MS });
        const patched = capturePatch(page, "agent-seed");
        await page.getByTestId("instance-agents-edit-submit").click({ timeout: ACTION_TIMEOUT_MS });
        expect((await patched).postDataJSON()).toEqual({
            defaultModelProvider: null,
            defaultModelName: null,
            allowedModels: null,
        });
        await expect(rowOf(page, "存量助手")).toContainText("—", { timeout: EXPECT_TIMEOUT_MS });
    });
});
