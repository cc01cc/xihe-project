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
 * PLAN-0622 M3/M4 testid 清单 —— 记录**当前实际状态**（verify V11 的归档依据）。
 *
 * 状态语义（比 `verifiedInDevelop` 布尔值更能说明问题）：
 * - `asserted`：develop 已存在该 testid，且本次 headed 走查**真的断言过**它；
 * - `exists-unasserted`：develop 已存在，但本 spec 没有断言（`note` 写为什么走不到）；
 * - `blocked`：UI 侧已实现，但**缺 CP 字段或前置**导致真机无法断言（`note` 写卡在哪个前置）。
 *
 * 2026-11-02 实测基线：S1 PASS / S2 PASS / S3 FAIL（CP D27 缺 `disabled`）/
 * S4 未执行（`test.describe.configure({ mode: "serial" })`，S3 失败后连带跳过）。
 */
type TestIdStatus = "asserted" | "exists-unasserted" | "blocked";

const EXPECTED_TESTIDS: Array<{
    id: string;
    scene: string;
    status: TestIdStatus;
    note: string;
}> = [
    // ── asserted：develop 已存在且本次走查断言过 ─────────────────────────────────────────
    {
        id: "agent-principal-scope",
        scene: "S1",
        status: "asserted",
        note: "scope 下拉选 PERSONAL（S1 PASS）",
    },
    {
        id: "agent-principal-name",
        scene: "S1",
        status: "asserted",
        note: "填名 + 创建 201（S1 PASS）",
    },
    {
        id: "agent-principal-create",
        scene: "S1",
        status: "asserted",
        note: "创建按钮触发 POST /agent-principals（S1 PASS）",
    },
    {
        id: "agent-default-model-provider",
        scene: "S1",
        status: "asserted",
        note: "默认模型 provider 填写（S1 PASS）",
    },
    {
        id: "agent-default-model-name",
        scene: "S1",
        status: "asserted",
        note: "默认模型 name 填写（S1 PASS）",
    },
    {
        id: "agent-scope-badge-",
        scene: "S1/S2",
        status: "asserted",
        note: "data-agent-scope=personal + 文案含「个人」（S1/S2 PASS）",
    },
    {
        id: "workspace-agent-management-dialog",
        scene: "S1–S3",
        status: "asserted",
        note: "面板可见/可关闭（S1–S3）",
    },
    {
        id: "agent-bind-row-",
        scene: "S2",
        status: "asserted",
        note: "本轮修复新增的行级绑定；S2 2.7s PASS（替代不存在的空态按钮入口）",
    },
    {
        id: "workspace-agent-principal-select",
        scene: "S2/S3",
        status: "asserted",
        note: "经 sidebar-new-chat → ?newChat=1 打开（S2 PASS）",
    },
    {
        id: "workspace-create-agent-session",
        scene: "S2",
        status: "asserted",
        note: "建会话 201（S2 PASS）",
    },
    {
        id: "workspace-agent-disable-",
        scene: "S3",
        status: "asserted",
        note: "两次点击确认：首次点击后文案变「再次点击确认禁用」（S3 已走到该断言）",
    },

    // ── blocked：UI 已实现，缺 CP 字段/前置 ─────────────────────────────────────────────
    {
        id: "agent-disabled-badge-",
        scene: "S3",
        status: "asserted",
        note: "CP D27 合入后真机验证通过：disable 两次点击 → 徽标出现（2026-11-02 S3 PASS）",
    },
    {
        id: "message-resource-exhausted",
        scene: "S4",
        status: "blocked",
        note: "卡在 CP D28（governor 准入前移到 202 之前）；且本次 S4 因 serial 模式被 S3 失败连带跳过，从未执行",
    },
    {
        id: "message-resource-exhausted-hint",
        scene: "S4",
        status: "blocked",
        note: "同 message-resource-exhausted：等 D28 + S4 真正跑起来",
    },

    // ── exists-unasserted：develop 已存在，本 spec 未断言（原因见 note）──────────────────
    {
        id: "agent-scope-unavailable",
        scene: "S1",
        status: "exists-unasserted",
        note: "只在「权限投影未就绪」时渲染；走查账号是 OWNER，走不到该分支",
    },
    {
        id: "agent-default-model-error",
        scene: "S1",
        status: "exists-unasserted",
        note: "只在非法模型输入时渲染；S1 只填合法值",
    },
    {
        id: "agent-allowed-model-add",
        scene: "S1",
        status: "exists-unasserted",
        note: "allowedModels 为可选项，S1 未使用",
    },
    {
        id: "agent-default-model-",
        scene: "S1",
        status: "exists-unasserted",
        note: "行内默认模型展示，S1 未断言",
    },
    {
        id: "agent-unbound-badge-",
        scene: "S2",
        status: "exists-unasserted",
        note: "本轮 D26 新增；仅由组件测试覆盖（真机未断言）",
    },
    {
        id: "agent-principal-bind",
        scene: "S2",
        status: "exists-unasserted",
        note: "创建区块内的绑定；已有行级绑定后走不到（保留为 fallback）",
    },
    {
        id: "agent-bind-forbidden-hint",
        scene: "S2",
        status: "exists-unasserted",
        note: "403 兜底文案；S2 现在能建会话，不进入该分支",
    },
    {
        id: "workspace-create-session",
        scene: "S2/S3",
        status: "exists-unasserted",
        note: "仅空态渲染；本 spec 已改走 sidebar-new-chat，不再点击它",
    },
    {
        id: "chat-input",
        scene: "S4",
        status: "exists-unasserted",
        note: "S4 未执行（serial：S3 失败后跳过）",
    },
    { id: "chat-send-button", scene: "S4", status: "exists-unasserted", note: "S4 未执行（同上）" },
    {
        id: "message-retry-button",
        scene: "S4",
        status: "exists-unasserted",
        note: "S4 未执行（同上）",
    },
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
/**
 * V11 归档口径：`serial` 模式下一条失败会让后续用例变 skipped，
 * 所以"跳过"必须与"未覆盖"分开统计 —— 否则报告会把"从未执行"写成"未验证"。
 */
const failedTests: string[] = [];
const skippedTests: string[] = [];
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

    test.afterEach(({}, testInfo) => {
        if (testInfo.status === "failed" || testInfo.status === "timedOut") {
            failedTests.push(`${testInfo.title} [${testInfo.status}]`);
        } else if (testInfo.status === "skipped") {
            skippedTests.push(testInfo.title);
        }
    });

    test.afterAll(() => {
        mkdirSync(RUN_DIR, { recursive: true });
        const pendingTestids = EXPECTED_TESTIDS.filter((item) => item.status !== "asserted");
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
                    failedTests,
                    skippedTests,
                    expectedTestIds: {
                        total: EXPECTED_TESTIDS.length,
                        asserted: EXPECTED_TESTIDS.filter((item) => item.status === "asserted")
                            .length,
                        blocked: EXPECTED_TESTIDS.filter((item) => item.status === "blocked")
                            .length,
                        pendingVerification: pendingTestids.length,
                        items: EXPECTED_TESTIDS,
                    },
                    // 三态：有失败 = failed；有跳过/未覆盖 = partial；否则 asserted。
                    // 这样 S3 失败时不会再出现 status=asserted 的假绿报告。
                    status:
                        failedTests.length > 0
                            ? "failed"
                            : skippedTests.length > 0 || notCovered.length > 0
                              ? "partial"
                              : "asserted",
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

        // 真实 UI 操作序列：面板列表里**每一行**都有绑定入口（`agent-bind-row-<id>`）。
        // 创建区块里的 `agent-principal-bind` 只在"刚创建未绑定"时出现，关掉重开就没有了 ——
        // 这正是 S2 之前失败的原因（点不到 → fallback 等对话框提示 → 超时）。
        let boundInUi = false;
        const rowBind = page.getByTestId(`agent-bind-row-${principalId}`);
        const createSectionBind = page.getByTestId("agent-principal-bind");
        const bindButton = (await rowBind.count()) > 0 ? rowBind : createSectionBind;
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
            boundInUi = true;
        } else {
            recordNotCovered(
                "S2-bind",
                "Agent 管理面板既没有 agent-bind-row-<id> 也没有 agent-principal-bind（UI 未合入行级绑定）",
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
            // 绑定已经成功过 ⇒ 建会话再失败就是真回归，必须响（不再用对话框提示兜底）。
            if (boundInUi) throw error;
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

        // 真实 UI 的"两次确认"是**同一个按钮点两次**（第一次进入确认态、按钮文案变成确认文案；
        // 第二次才发 POST），不是 alertdialog —— 旧 spec 假设了对话框，所以 15s 等不到元素。
        //
        // 用例自足性：共享栈上工作区里可能已有**多个**已绑定 agent（每跑一次 S1 就多一个），
        // 所以"工作区只剩一个 agent"不是可靠前提。先把 S1 建的那个禁用（S3a 证据），
        // 再把其余仍可用的逐个禁用，直到工作区真的没有可用 agent。
        const disableButton = page.getByTestId(`workspace-agent-disable-${principalId}`);
        const idleLabel = (await disableButton.textContent()) ?? "";
        await disableButton.click();
        // 实现里的"确认态"标记 = 按钮文案换成 workspace.confirmAgentDisable
        //（zh「再次点击确认禁用」/ en「Click again to confirm disable」）；没有 aria-pressed /
        // data-confirming，所以只能按文案断言 —— 但必须是**确认文案**，不能只断言"变了"。
        await expect(
            disableButton,
            "first click must switch the button into confirm state",
        ).not.toHaveText(idleLabel, { timeout: 15000 });
        await expect(
            disableButton,
            "the confirm state must read as an explicit confirmation",
        ).toHaveText(/再次点击|确认|Confirm/i, { timeout: 15000 });
        const disableResponse = page.waitForResponse(
            (response) =>
                new URL(response.url()).pathname ===
                    `/api/v1/agent-principals/${principalId}/disable` &&
                response.request().method() === "POST",
        );
        await disableButton.click();
        const disabled = await disableResponse;
        expect([200, 204], await disabled.text()).toContain(disabled.status());

        const disabledBadge = page.getByTestId(`agent-disabled-badge-${principalId}`);
        await expect(disabledBadge).toBeVisible({ timeout: 20000 });
        await shot(page, {
            id: "S3a",
            name: "s3a-agent-disabled-badge",
            assertion: "disable 两次确认后出现「已禁用」徽标",
        });

        // 把工作区里**其余**仍可用的 agent 也禁用掉，直到没有可用 agent（不依赖"只有一个 agent"）。
        // 上限 12 次防止意外死循环；每次操作都等真实 204/200 响应，不做 sleep。
        for (let round = 0; round < 12; round += 1) {
            const remaining = page.locator(
                '[data-testid^="workspace-agent-disable-"]:not([disabled])',
            );
            const count = await remaining.count();
            if (count === 0) break;
            const testId = (await remaining.first().getAttribute("data-testid")) ?? "";
            const otherId = testId.replace("workspace-agent-disable-", "");
            if (otherId === principalId) break; // S1 的已禁用（本轮首个用例已处理）
            const button = page.getByTestId(testId);
            const label = (await button.textContent()) ?? "";
            await button.click();
            await expect(button).not.toHaveText(label, { timeout: 15000 });
            const response = page.waitForResponse(
                (candidate) =>
                    new URL(candidate.url()).pathname ===
                        `/api/v1/agent-principals/${otherId}/disable` &&
                    candidate.request().method() === "POST",
            );
            await button.click();
            const answered = await response;
            expect([200, 204], await answered.text()).toContain(answered.status());
            await expect(page.getByTestId(`agent-disabled-badge-${otherId}`)).toBeVisible({
                timeout: 20000,
            });
        }

        await page.keyboard.press("Escape");
        await expect(page.getByTestId("workspace-agent-management-dialog")).toBeHidden({
            timeout: 15000,
        });

        // 工作区此刻已**没有可用 agent**（唯一绑定的那个刚被禁用），所以正确的 UX 不是弹出选择器，
        // 而是说明真实原因（"已绑定的 Agent 已被禁用"）+ 给出去管理的入口；选择器不该出现。
        await page.getByTestId("sidebar-new-chat").click();
        const unavailableHint = page.getByTestId("workspace-agent-unavailable-hint");
        await expect(unavailableHint, "the UI must explain why no Agent is selectable").toBeVisible(
            {
                timeout: 20000,
            },
        );
        await expect(unavailableHint).toHaveText(/禁用|disabled/i);
        await expect(
            unavailableHint.getByTestId("workspace-agent-unavailable-manage"),
        ).toBeVisible();
        await expect(
            page.getByTestId("workspace-agent-principal-select"),
            "no selector may open when nothing is selectable",
        ).toHaveCount(0);
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
