import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";

/**
 * task-430：实例智能体**创建面照契约收紧**的真指针链路。
 *
 * <p>两笔都由真 HTTP 照出（stack-1，CP e06c55fe6044，2026-11-14 02:35，
 * `.tmp/xh/task-402/probe-report.json`）：① 契约 `AgentPrincipalCreateRequest` 没有 description，
 * UI 却发它 ⇒ 填说明必 400；② 名字格式 `^[A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff]*$`，
 * 带连字符即 400 `INVALID_NAME_FORMAT`，而 UI 既无提示也把该码显示成通用「操作失败」。</p>
 *
 * <p>这里钉「真浏览器里」的三件事：说明框真的不在了、发出去的 body 真的没有 description 键、
 * 格式提示与禁用态真的按输入变化（含服务端码的本地化）。单测钉载荷与判据，交互归 Playwright。</p>
 */
const PANEL_URL = "/resources/agents?layer=INSTANCE";

type Page = import("@playwright/test").Page;

function json(body: unknown, status = 200) {
    return { status, contentType: "application/json", body: JSON.stringify(body) };
}

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

/** 创建面：GET 列表 + POST 创建（可按用例改成回 400）。 */
async function stubAgentFace(
    page: Page,
    onCreate?: (body: Record<string, unknown>) => { status: number; body: unknown },
): Promise<void> {
    const rows: Array<Record<string, unknown>> = [];
    await page.route(/\/api\/v1\/instance\/agent-principals(\?.*)?$/, async (route) => {
        const method = route.request().method();
        if (method === "GET") return route.fulfill(json({ principals: rows, count: rows.length }));
        if (method === "POST") {
            const body = route.request().postDataJSON() as Record<string, unknown>;
            if (onCreate) {
                const answer = onCreate(body);
                return route.fulfill(json(answer.body, answer.status));
            }
            const row = {
                principalId: "agent-" + (rows.length + 1),
                name: body.name,
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

async function openCreate(page: Page): Promise<void> {
    await page.goto(PANEL_URL);
    await page.getByTestId("instance-agents-create").click({ timeout: ACTION_TIMEOUT_MS });
    await expect(page.getByTestId("instance-agents-create-dialog")).toBeVisible({
        timeout: EXPECT_TIMEOUT_MS,
    });
}

function captureCreate(page: Page) {
    return page.waitForRequest(
        (request) =>
            request.method() === "POST" &&
            new URL(request.url()).pathname === "/api/v1/instance/agent-principals",
        { timeout: EXPECT_TIMEOUT_MS },
    );
}

test.describe("instance agent create contract (task-430)", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await stubPermissions(page);
        await stubAgentFace(page);
    });

    test("说明框已撤；合法名字创建 ⇒ body 只有 name（没有 description 键）", async ({ page }) => {
        await openCreate(page);
        await expect(page.getByTestId("instance-agents-form-description")).toHaveCount(0);
        await page.getByTestId("instance-agents-form-name").fill("评审助手");
        const posted = captureCreate(page);
        await page
            .getByTestId("instance-agents-create-submit")
            .click({ timeout: ACTION_TIMEOUT_MS });
        const request = await posted;
        expect(Object.keys(request.postDataJSON() as Record<string, unknown>)).toEqual(["name"]);
        await expect(page.getByTestId("instance-agents-create-dialog")).toHaveCount(0, {
            timeout: EXPECT_TIMEOUT_MS,
        });
    });

    test("名字带连字符/空格/数字开头：提交禁用 + 提示变红；改合法即恢复", async ({ page }) => {
        await openCreate(page);
        const hint = page.getByTestId("instance-agents-form-name-hint");
        const submit = page.getByTestId("instance-agents-create-submit");
        await expect(hint).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await expect(submit).toBeDisabled();

        for (const bad of ["task-402-probe", "评审 助手", "1号助手"]) {
            await page.getByTestId("instance-agents-form-name").fill(bad);
            await expect(submit).toBeDisabled();
            await expect(hint).toHaveClass(/text-destructive/);
            await expect(hint).toContainText("不能以数字开头");
        }

        await page.getByTestId("instance-agents-form-name").fill("评审助手2");
        await expect(submit).toBeEnabled();
        await expect(hint).toHaveClass(/text-muted-foreground/);
    });

    test("空名字只算必填：提示不冒充格式错", async ({ page }) => {
        await openCreate(page);
        await expect(page.getByTestId("instance-agents-create-submit")).toBeDisabled();
        await expect(page.getByTestId("instance-agents-form-name-hint")).toHaveClass(
            /text-muted-foreground/,
        );
    });

    test.describe("server-side name rejection", () => {
        // 故意桩 400：逐条放行该路径的 400（来源 = 本用例夹具），不整体跳过失败信号门禁。
        test.use({
            mockAllow: [...DEFAULT_MOCK_ALLOW, String.raw`400.*instance/agent-principals`],
        });

        test("服务端 400 INVALID_NAME_FORMAT ⇒ 本地化点名，不直显英文 detail，弹窗保窗", async ({
            page,
        }) => {
            await stubAgentFace(page, () => ({
                status: 400,
                body: { code: "INVALID_NAME_FORMAT", detail: "name format rejected by server" },
            }));
            await openCreate(page);
            await page.getByTestId("instance-agents-form-name").fill("评审助手");
            await page
                .getByTestId("instance-agents-create-submit")
                .click({ timeout: ACTION_TIMEOUT_MS });
            const error = page.getByTestId("instance-agents-action-error");
            await expect(error).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
            await expect(error).toContainText("名字格式不合契约");
            await expect(error).not.toContainText("name format rejected by server");
            await expect(page.getByTestId("instance-agents-create-dialog")).toBeVisible();
        });
    });

    test.describe("mobile viewport", () => {
        test.use({ viewport: { width: 390, height: 844 } });

        test("移动端：格式提示与禁用态同样成立，合法名字真发得出去", async ({ page }) => {
            await openCreate(page);
            await page.getByTestId("instance-agents-form-name").fill("bad-name");
            await expect(page.getByTestId("instance-agents-create-submit")).toBeDisabled();
            await expect(page.getByTestId("instance-agents-form-name-hint")).toHaveClass(
                /text-destructive/,
            );
            await page.getByTestId("instance-agents-form-name").fill("移动端助手");
            const posted = captureCreate(page);
            await page
                .getByTestId("instance-agents-create-submit")
                .click({ timeout: ACTION_TIMEOUT_MS });
            const request = await posted;
            expect(Object.keys(request.postDataJSON() as Record<string, unknown>)).toEqual([
                "name",
            ]);
        });
    });
});
