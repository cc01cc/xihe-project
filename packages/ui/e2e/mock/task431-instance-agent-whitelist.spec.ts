import { expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";

/**
 * task-431：编辑面 dirty-check 按**规范化白名单三态**比对的真指针链路。
 *
 * <p>真因（cp-1 task-423 / c7ace6f42 核实）：列表投影**本来就带** `allowedModels`（契约 required、
 * `array|null`、键恒在），而 UI 旧口径以为它不在投影里 ⇒ 「勾了白名单就算改动」，预填原样保存也会
 * 白写一次 PATCH（多一条审计）。现在比的是语义：null 与 [] 同义、条目排序去重后逐项比。</p>
 *
 * <p>为什么在浏览器里验：勾选框是 reka Checkbox、三段是 reka Select（jsdom 里程序化交互不可靠，
 * `packages/ui/AGENTS.md`：交互归 Playwright）。单测钉载荷与三态判据，这里钉「预填真的勾上了、
 * 原样保存真的点不动、取消勾选真的发出 allowedModels:null」。</p>
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
                providers: [{ id: "anthropic", displayName: "Anthropic" }],
            }),
        ),
    );
    await page.route("**/api/v1/provider-connections", (route) =>
        route.fulfill(json({ connections: [CHAT_CONNECTION] })),
    );
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
                        ],
                    },
                },
            }),
        ),
    );
}

const SONNET = { provider: "anthropic", model: "claude-sonnet-4-5" };

function seed(allowedModels: unknown) {
    return {
        principalId: "agent-seed",
        name: "存量助手",
        templateId: null,
        templateName: null,
        defaultModelProvider: "anthropic",
        defaultModelName: "claude-sonnet-4-5",
        allowedModels,
        createdAt: "2026-11-14T00:00:00.000Z",
        disabled: false,
    };
}

/** 智能体面：GET 列表（带存量白名单）/ PATCH 模型意图（照 cp-1 task-413 语义回 UpdateView）。 */
async function stubAgentFace(page: Page, allowedModels: unknown): Promise<void> {
    const rows: Array<Record<string, unknown>> = [seed(allowedModels)];
    await page.route(/\/api\/v1\/instance\/agent-principals(\?.*)?$/, (route) =>
        route.fulfill(json({ principals: rows, count: rows.length })),
    );
    await page.route(/\/api\/v1\/instance\/agent-principals\/[^/?]+(\?.*)?$/, async (route) => {
        if (route.request().method() !== "PATCH") {
            return route.fulfill(json({ code: "METHOD_NOT_ALLOWED" }, 405));
        }
        const body = route.request().postDataJSON() as Record<string, unknown>;
        const row = rows[0]!;
        for (const key of ["defaultModelProvider", "defaultModelName", "allowedModels"]) {
            if (key in body) row[key] = body[key];
        }
        return route.fulfill(
            json({
                principalId: row.principalId,
                defaultModelProvider: row.defaultModelProvider,
                defaultModelName: row.defaultModelName,
                allowedModels: row.allowedModels,
            }),
        );
    });
}

async function openEdit(page: Page): Promise<void> {
    await page.goto(PANEL_URL);
    await page.getByTestId("instance-agent-edit-agent-seed").click({ timeout: ACTION_TIMEOUT_MS });
    await expect(page.getByTestId("instance-agents-edit-dialog")).toBeVisible({
        timeout: EXPECT_TIMEOUT_MS,
    });
}

function capturePatch(page: Page) {
    return page.waitForRequest(
        (request) =>
            request.method() === "PATCH" &&
            new URL(request.url()).pathname === "/api/v1/instance/agent-principals/agent-seed",
        { timeout: EXPECT_TIMEOUT_MS },
    );
}

test.describe("instance agent whitelist dirty-check (task-431)", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await stubPermissions(page);
        await stubModelFaces(page);
    });

    test("存量白名单=同一模型一项：预填勾选 + 照实显示，原样保存点不动（不白写 PATCH）", async ({
        page,
    }) => {
        await stubAgentFace(page, [SONNET]);
        await openEdit(page);
        await expect(page.getByTestId("instance-agents-edit-form-restrict")).toBeChecked({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("instance-agents-edit-whitelist")).toContainText(
            "anthropic / claude-sonnet-4-5",
        );
        await expect(page.getByTestId("instance-agents-edit-submit")).toBeDisabled();
        await expect(page.getByTestId("instance-agents-edit-nochange")).toBeVisible();
    });

    test("取消勾选 ⇒ 真发 PATCH 且 allowedModels 为 null（模型没变也是真改动）", async ({
        page,
    }) => {
        await stubAgentFace(page, [SONNET]);
        await openEdit(page);
        await expect(page.getByTestId("instance-agents-edit-form-restrict")).toBeChecked({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await page
            .getByTestId("instance-agents-edit-form-restrict")
            .click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.getByTestId("instance-agents-edit-submit")).toBeEnabled();
        const patched = capturePatch(page);
        await page.getByTestId("instance-agents-edit-submit").click({ timeout: ACTION_TIMEOUT_MS });
        const request = await patched;
        expect(request.postDataJSON()).toEqual({
            defaultModelProvider: "anthropic",
            defaultModelName: "claude-sonnet-4-5",
            allowedModels: null,
        });
        await expect(page.getByTestId("instance-agents-edit-dialog")).toHaveCount(0, {
            timeout: EXPECT_TIMEOUT_MS,
        });
    });

    test("存量不限制：预填不勾选 + 显示「不限制」；勾选后真发白名单一项", async ({ page }) => {
        await stubAgentFace(page, null);
        await openEdit(page);
        await expect(page.getByTestId("instance-agents-edit-form-restrict")).not.toBeChecked({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("instance-agents-edit-whitelist")).toContainText("不限制");
        await expect(page.getByTestId("instance-agents-edit-submit")).toBeDisabled();

        await page
            .getByTestId("instance-agents-edit-form-restrict")
            .click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.getByTestId("instance-agents-edit-submit")).toBeEnabled();
        const patched = capturePatch(page);
        await page.getByTestId("instance-agents-edit-submit").click({ timeout: ACTION_TIMEOUT_MS });
        expect((await patched).postDataJSON()).toEqual({
            defaultModelProvider: "anthropic",
            defaultModelName: "claude-sonnet-4-5",
            allowedModels: [SONNET],
        });
    });

    test.describe("mobile viewport", () => {
        test.use({ viewport: { width: 390, height: 844 } });

        test("390×844：存量 [] 与 null 同义（预填不勾选、原样保存禁用）", async ({ page }) => {
            await stubAgentFace(page, []);
            await openEdit(page);
            await expect(page.getByTestId("instance-agents-edit-form-restrict")).not.toBeChecked({
                timeout: EXPECT_TIMEOUT_MS,
            });
            await expect(page.getByTestId("instance-agents-edit-whitelist")).toContainText(
                "不限制",
            );
            await expect(page.getByTestId("instance-agents-edit-submit")).toBeDisabled();
        });
    });
});
