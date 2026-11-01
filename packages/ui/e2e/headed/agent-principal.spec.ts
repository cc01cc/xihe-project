/**
 * PLAN-0622 M4（T4.1）—— 有头走查：PERSONAL agent 建/绑/禁用 + 429 提示（S1–S4）。
 *
 * 与无头批次的关系：
 * - 本文件在 `e2e/headed/` 下，只有 `--batch=headed`（或显式传 `e2e/headed`）才会收集；
 * - 需要 `XIHE_E2E_HEADED=1` + `XIHE_E2E_BROWSER_CHANNEL=chrome-beta`（全机单窗口串行）；
 * - **当前预期红**：UI 改动在 `plan-0622-ui`、CP M1 在 `plan-0622-cp`，均未合入 develop；
 *   本文件先按 `evidence/m3-ui.md` 的 testid 清单写，未合入前断言必然失败（属预期，不是回归）。
 *
 * 证据（**不提交**）：`.tmp/xh-headed-0622/runs/<XIHE_E2E_RUN_ID>/`
 *   shots/NN-*.png      每步截图（成功断言之后才截）
 *   report.json         每步 step/URL/断言/截图；含 notCovered（无法覆盖 + 原因）与 testid 待核清单
 *   console-errors.log  console.error + pageerror + requestfailed
 *
 * 纪律：不许 `waitForTimeout`、不许 skip、不许伪装通过；无法覆盖的场景写 `notCovered` + 原因。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createWorkspaceSessionWithPrincipal } from "../real/helpers/agent-principal";
import { ensureWorkspace } from "../real/helpers/workspace";

const RUN_ID = process.env.XIHE_E2E_RUN_ID || `headed-0622-${Date.now()}`;
const RUN_DIR = path.resolve(process.cwd(), "../../.tmp/xh-headed-0622/runs", RUN_ID);
const SHOTS_DIR = path.join(RUN_DIR, "shots");
const GOLDPATH_EMAIL = process.env.XIHE_E2E_GOLDPATH_EMAIL ?? "";
const GOLDPATH_PASSWORD = process.env.XIHE_E2E_GOLDPATH_PASSWORD ?? "";
const FAKE_LLM_MODEL = "fake-openai";

/**
 * M3 新增 testid 清单（来源 `plans/PLAN-0622-.../evidence/m3-ui.md`）。
 * `verifiedInDevelop: false` = 当前 develop UI 尚未落该 testid（待 UI 合并后复核），
 * 走查报告据此给出"待核数"，不把未落盘的 testid 当成已验证事实。
 */
const EXPECTED_TESTIDS: Array<{ id: string; scene: string; verifiedInDevelop: boolean }> = [
    { id: "agent-principal-scope", scene: "S1", verifiedInDevelop: false },
    { id: "agent-scope-unavailable", scene: "S1", verifiedInDevelop: false },
    { id: "agent-default-model-provider", scene: "S1", verifiedInDevelop: false },
    { id: "agent-default-model-name", scene: "S1", verifiedInDevelop: false },
    { id: "agent-default-model-error", scene: "S1", verifiedInDevelop: false },
    { id: "agent-allowed-model-add", scene: "S1", verifiedInDevelop: false },
    { id: "agent-scope-badge-", scene: "S1/S2", verifiedInDevelop: false },
    { id: "agent-default-model-", scene: "S1", verifiedInDevelop: false },
    { id: "agent-disabled-badge-", scene: "S3", verifiedInDevelop: false },
    { id: "workspace-agent-disable-", scene: "S3", verifiedInDevelop: false },
    { id: "agent-bind-forbidden-hint", scene: "S2", verifiedInDevelop: false },
    { id: "message-resource-exhausted", scene: "S4", verifiedInDevelop: false },
    { id: "message-resource-exhausted-hint", scene: "S4", verifiedInDevelop: false },
    { id: "agent-principal-name", scene: "S1", verifiedInDevelop: true },
    { id: "agent-principal-create", scene: "S1", verifiedInDevelop: true },
    { id: "agent-principal-bind", scene: "S2", verifiedInDevelop: true },
    { id: "workspace-agent-management-dialog", scene: "S1–S3", verifiedInDevelop: true },
    { id: "workspace-create-session", scene: "S2/S3", verifiedInDevelop: true },
    { id: "workspace-agent-principal-select", scene: "S2/S3", verifiedInDevelop: true },
    { id: "workspace-create-agent-session", scene: "S2", verifiedInDevelop: true },
    { id: "chat-input", scene: "S4", verifiedInDevelop: true },
    { id: "chat-send-button", scene: "S4", verifiedInDevelop: true },
    { id: "message-retry-button", scene: "S4", verifiedInDevelop: true },
];

type StepRecord = {
    id: string;
    step: string;
    url: string;
    assertion: string;
    screenshot: string;
    status: "asserted" | "not-covered";
};

const steps: StepRecord[] = [];
const notCovered: Array<{ id: string; reason: string }> = [];
const consoleLog: string[] = [];
let shotSeq = 0;
let workspaceId = "";
let principalId = "";
let sessionId = "";

function recordStep(
    entry: Omit<StepRecord, "screenshot" | "status">,
    shotName: string,
    status: StepRecord["status"] = "asserted",
): void {
    steps.push({ ...entry, screenshot: path.join("shots", shotName), status });
}

/** 截图只在**断言通过之后**调用：截图 = 已证实的事实。 */
async function shot(
    page: Page,
    { id, name, assertion }: { id: string; name: string; assertion: string },
): Promise<void> {
    shotSeq += 1;
    const fileName = `${String(shotSeq).padStart(2, "0")}-${name}.png`;
    await page.screenshot({ path: path.join(SHOTS_DIR, fileName), fullPage: true });
    recordStep({ id, step: name, url: page.url(), assertion }, fileName);
}

function recordNotCovered(id: string, reason: string): void {
    notCovered.push({ id, reason });
    recordStep({ id, step: id, url: "", assertion: `NOT COVERED: ${reason}` }, "", "not-covered");
    test.info().annotations.push({ type: "not-covered", description: `${id}: ${reason}` });
}

function attachPageDiagnostics(page: Page): void {
    page.on("console", (message) => {
        if (message.type() === "error") consoleLog.push(`[console.error] ${message.text()}`);
    });
    page.on("pageerror", (error) => consoleLog.push(`[pageerror] ${error.message}`));
    page.on("requestfailed", (request) => {
        const reason = request.failure()?.errorText ?? "unknown";
        if (reason !== "net::ERR_ABORTED") {
            consoleLog.push(`[requestfailed] ${request.method()} ${request.url()} :: ${reason}`);
        }
    });
}

async function tokenOf(page: Page): Promise<string> {
    const token = await page.evaluate(() => localStorage.getItem("xihe-token"));
    expect(token, "the UI must have persisted a token").toBeTruthy();
    return token!;
}

/** 走真实登录表单（headed 车道用 bootstrap 账号；与 0621 的 S8 同一做法）。 */
async function loginViaForm(page: Page, identifier: string, password: string): Promise<void> {
    await page.goto("/login", { waitUntil: "load" });
    await page.locator("#identifier").fill(identifier);
    await page.locator("#password").fill(password);
    const loginResponse = page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname === "/api/v1/auth/login" &&
            response.request().method() === "POST",
    );
    await page.locator("button[type=submit]").first().click();
    const response = await loginResponse;
    expect(response.status(), `login form must authenticate (${await response.text()})`).toBe(200);
    await expect
        .poll(() => page.evaluate(() => Boolean(localStorage.getItem("xihe-token"))), {
            timeout: 30000,
            intervals: [250, 500],
        })
        .toBe(true);
}

async function openAgentDialog(page: Page): Promise<void> {
    await page.getByTestId("workspace-toolbar-agents").click();
    await expect(page.getByTestId("workspace-agent-management-dialog")).toBeVisible({
        timeout: 20000,
    });
}

function scopeBadge(page: Page, id: string) {
    return page.getByTestId(`agent-scope-badge-${id}`);
}

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.describe("PLAN-0622 M4 有头走查：PERSONAL agent 生命周期 + 429 提示", () => {
    test.beforeAll(() => {
        mkdirSync(SHOTS_DIR, { recursive: true });
        expect(GOLDPATH_EMAIL, "the headed lane needs the bootstrap account").not.toBe("");
        expect(GOLDPATH_PASSWORD, "the headed lane needs the bootstrap password").not.toBe("");
    });

    test.afterAll(() => {
        mkdirSync(RUN_DIR, { recursive: true });
        const pendingTestids = EXPECTED_TESTIDS.filter((item) => !item.verifiedInDevelop);
        writeFileSync(
            path.join(RUN_DIR, "report.json"),
            `${JSON.stringify(
                {
                    plan: "PLAN-0622",
                    milestone: "M4 (T4.1)",
                    spec: "e2e/headed/agent-principal.spec.ts",
                    runId: RUN_ID,
                    scenes: [
                        "S1 personal-agent-create",
                        "S2 bind-and-session",
                        "S3 disable",
                        "S4 429",
                    ],
                    steps,
                    notCovered,
                    expectedTestIds: {
                        total: EXPECTED_TESTIDS.length,
                        pendingVerification: pendingTestids.length,
                        items: EXPECTED_TESTIDS,
                    },
                    status: notCovered.length === 0 ? "asserted" : "partial",
                },
                null,
                2,
            )}\n`,
            "utf8",
        );
        writeFileSync(
            path.join(RUN_DIR, "console-errors.log"),
            `${consoleLog.join("\n")}\n`,
            "utf8",
        );
    });

    test("S1@host 建 PERSONAL agent：scope 选个人 → 填名 + 默认模型 → 列表出现且 data-agent-scope=personal", async ({
        page,
        request,
    }) => {
        attachPageDiagnostics(page);
        await loginViaForm(page, GOLDPATH_EMAIL, GOLDPATH_PASSWORD);
        const token = await tokenOf(page);
        workspaceId = await ensureWorkspace(request, token);
        await page.goto(`/workspace/${workspaceId}`, { waitUntil: "load" });
        await expect(page.getByTestId("workspace-toolbar-agents")).toBeVisible({ timeout: 45000 });
        await openAgentDialog(page);

        // scope 下拉只列有权限的档；PERSONAL 是 S1 的目标档（无权限时 UI fail-closed，直接失败）。
        const scopeSelect = page.getByTestId("agent-principal-scope");
        await expect(scopeSelect).toBeVisible({ timeout: 20000 });
        await scopeSelect.selectOption("PERSONAL");

        const name = `Headed Personal ${randomUUID().slice(0, 8)}`;
        await page.getByTestId("agent-principal-name").fill(name);
        await page.getByTestId("agent-default-model-provider").fill("openai");
        await page.getByTestId("agent-default-model-name").fill(FAKE_LLM_MODEL);

        const createResponse = page.waitForResponse(
            (response) =>
                new URL(response.url()).pathname === "/api/v1/agent-principals" &&
                response.request().method() === "POST",
        );
        await page.getByTestId("agent-principal-create").click();
        const created = await createResponse;
        expect(created.status(), await created.text()).toBe(201);
        const createdBody = (await created.json()) as { principalId?: string; scope?: string };
        principalId = createdBody.principalId ?? "";
        expect(principalId).toMatch(/^[0-9a-f-]{36}$/i);
        expect(createdBody.scope, "CP must echo scope=PERSONAL").toBe("PERSONAL");

        const badge = scopeBadge(page, principalId);
        await expect(badge).toBeVisible({ timeout: 20000 });
        await expect(badge).toHaveAttribute("data-agent-scope", "personal");
        await expect(badge).toHaveText(/个人|Personal/i);
        await shot(page, {
            id: "S1",
            name: "s1-personal-agent-row",
            assertion: `PERSONAL agent 创建 201；行徽标 data-agent-scope=personal；principal=${principalId}`,
        });
    });

    test("S2@host 绑到工作区：source 徽标=个人 agent → 会话空态可选它建会话（或 403 且有可操作文案）", async ({
        page,
    }) => {
        attachPageDiagnostics(page);
        expect(principalId, "S2 depends on S1").not.toBe("");
        await loginViaForm(page, GOLDPATH_EMAIL, GOLDPATH_PASSWORD);
        await page.goto(`/workspace/${workspaceId}`, { waitUntil: "load" });
        await expect(page.getByTestId("workspace-toolbar-agents")).toBeVisible({ timeout: 45000 });
        await openAgentDialog(page);

        const bindButton = page.getByTestId("agent-principal-bind");
        if ((await bindButton.count()) > 0) {
            const bindResponse = page.waitForResponse(
                (response) =>
                    /\/api\/v1\/workspaces\/[^/]+\/agents\/[^/]+$/.test(
                        new URL(response.url()).pathname,
                    ) && response.request().method() === "PUT",
            );
            await bindButton.first().click();
            const bound = await bindResponse;
            expect([200, 201, 204], await bound.text()).toContain(bound.status());
        } else {
            recordNotCovered(
                "S2-bind",
                "Agent 管理面板未渲染 agent-principal-bind（该行可能已绑定或 UI 尚未合入 0622 M3）",
            );
        }

        const badge = scopeBadge(page, principalId);
        await expect(badge).toBeVisible({ timeout: 20000 });
        await expect(badge).toHaveAttribute("data-agent-scope", "personal");
        await expect(badge).toHaveText(/个人|Personal/i);
        await shot(page, {
            id: "S2a",
            name: "s2a-source-badge-personal",
            assertion: "绑定后来源徽标显示「个人 agent」",
        });

        await page.keyboard.press("Escape");
        await expect(page.getByTestId("workspace-agent-management-dialog")).toBeHidden({
            timeout: 15000,
        });

        try {
            sessionId = await createWorkspaceSessionWithPrincipal(page, principalId);
            await shot(page, {
                id: "S2b",
                name: "s2b-session-created-with-personal-agent",
                assertion: `会话空态可选 PERSONAL agent 并建会话成功 session=${sessionId}`,
            });
        } catch (error) {
            // 无 MANAGE_WORKSPACE_AGENTS 时必须给可操作文案（fail-closed），而不是静默失败。
            const forbiddenHint = page.getByTestId("agent-bind-forbidden-hint");
            await expect(
                forbiddenHint,
                `session creation with PERSONAL agent failed: ${String(error)}`,
            ).toBeVisible({ timeout: 20000 });
            recordNotCovered(
                "S2-session",
                "无 MANAGE_WORKSPACE_AGENTS：会话创建被拒，但 UI 显示 agent-bind-forbidden-hint（可操作文案）",
            );
            await shot(page, {
                id: "S2b",
                name: "s2b-bind-forbidden-hint",
                assertion: "403 场景下显示可操作提示",
            });
        }
    });

    test("S3@host disable：两次确认 → agent-disabled-badge 出现 → 新会话不可选该 agent", async ({
        page,
    }) => {
        attachPageDiagnostics(page);
        expect(principalId, "S3 depends on S1").not.toBe("");
        await loginViaForm(page, GOLDPATH_EMAIL, GOLDPATH_PASSWORD);
        await page.goto(`/workspace/${workspaceId}`, { waitUntil: "load" });
        await expect(page.getByTestId("workspace-toolbar-agents")).toBeVisible({ timeout: 45000 });
        await openAgentDialog(page);

        // 两次确认：第一次点 disable 按钮，第二次在确认对话框里确认（与 M3 的二次确认一致）。
        await page.getByTestId(`workspace-agent-disable-${principalId}`).click();
        const confirmDialog = page.getByRole("alertdialog");
        await expect(confirmDialog).toBeVisible({ timeout: 15000 });
        const disableResponse = page.waitForResponse(
            (response) =>
                new URL(response.url()).pathname ===
                    `/api/v1/agent-principals/${principalId}/disable` &&
                response.request().method() === "POST",
        );
        await confirmDialog
            .getByRole("button", { name: /禁用|Disable/i })
            .last()
            .click();
        const disabled = await disableResponse;
        expect([200, 204], await disabled.text()).toContain(disabled.status());

        const disabledBadge = page.getByTestId(`agent-disabled-badge-${principalId}`);
        await expect(disabledBadge).toBeVisible({ timeout: 20000 });
        await shot(page, {
            id: "S3a",
            name: "s3a-agent-disabled-badge",
            assertion: "disable 两次确认后出现「已禁用」徽标",
        });

        await page.keyboard.press("Escape");
        await expect(page.getByTestId("workspace-agent-management-dialog")).toBeHidden({
            timeout: 15000,
        });

        await page.getByTestId("workspace-create-session").click();
        const principalSelect = page.getByTestId("workspace-agent-principal-select");
        await expect(principalSelect).toBeVisible({ timeout: 20000 });
        const option = principalSelect.locator(`option[value="${principalId}"]`);
        if ((await option.count()) === 0) {
            // 直接不可选（从选项里移除）也是合法实现；两种都算"新会话不可选"。
            await expect(
                option,
                "disabled agent must not be selectable in a new session",
            ).toHaveCount(0);
        } else {
            await expect(option, "disabled agent must be greyed out").toBeDisabled();
        }
        await shot(page, {
            id: "S3b",
            name: "s3b-disabled-agent-not-selectable",
            assertion: "新会话选择器中该 agent 不可选/已灰化",
        });
        await page.keyboard.press("Escape");
    });

    test("S4@host 429 提示：message-resource-exhausted 可见、文案本地化、不显示原文、有换连接/重试指引", async ({
        page,
    }) => {
        attachPageDiagnostics(page);
        expect(sessionId, "S4 depends on S2's session").not.toBe("");
        await loginViaForm(page, GOLDPATH_EMAIL, GOLDPATH_PASSWORD);

        // mock 版：不依赖 CP M1.5 governor；真机版在 M1.5 合入后按同一断言跑（见 evidence/m4-headed.md）。
        await page.route("**/api/v1/chat", async (route) => {
            if (route.request().method() !== "POST") {
                await route.continue();
                return;
            }
            await route.fulfill({
                status: 429,
                headers: { "content-type": "application/json", "retry-after": "2" },
                body: JSON.stringify({
                    type: "https://xihe.dev/problems/resource-exhausted",
                    title: "Too Many Requests",
                    status: 429,
                    code: "RESOURCE_EXHAUSTED",
                    detail: "connection concurrency limit reached",
                    retryAfterSeconds: 2,
                    resourceKind: "CONNECTION",
                    scope: workspaceId,
                }),
            });
        });

        await page.goto(`/workspace/${workspaceId}/chat/${sessionId}`, { waitUntil: "load" });
        if (
            await page
                .getByTestId("workspace-agent-principal-select")
                .isVisible()
                .catch(() => false)
        ) {
            await page.keyboard.press("Escape");
        }
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 45000 });

        const chatResponse = page.waitForResponse(
            (response) =>
                new URL(response.url()).pathname === "/api/v1/chat" &&
                response.request().method() === "POST",
        );
        await page.getByTestId("chat-input").fill("429 walkthrough probe");
        await page.getByTestId("chat-send-button").click();
        expect((await chatResponse).status()).toBe(429);

        const exhausted = page.getByTestId("message-resource-exhausted"),
            hint = page.getByTestId("message-resource-exhausted-hint"),
            bubbleText = await page
                .locator('[data-slot="message"]')
                .last()
                .textContent()
                .catch(() => "");
        await expect(exhausted).toBeVisible({ timeout: 30000 });
        await expect(hint).toBeVisible({ timeout: 20000 });
        await expect(hint).toHaveText(/换连接|稍后重试|another connection|retry later/i);

        // 本地化：不得把 CP 的英文 code 原文展示给用户。
        expect(bubbleText, "raw RESOURCE_EXHAUSTED must not be shown").not.toContain(
            "RESOURCE_EXHAUSTED",
        );
        await expect(exhausted).toHaveText(/并发已满|concurrent|重试/i);
        await expect(page.getByTestId("message-retry-button")).toBeVisible({ timeout: 20000 });
        await shot(page, {
            id: "S4",
            name: "s4-resource-exhausted-localized",
            assertion: "429 → 本地化话术 + 换连接/稍后重试指引；不显示 RESOURCE_EXHAUSTED 原文",
        });
    });
});
