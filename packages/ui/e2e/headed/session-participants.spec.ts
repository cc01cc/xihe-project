import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "../real/helpers/agent-principal";
import { createDirectAttachWorkspace } from "../real/helpers/workspace";
import { CP_URL } from "../real/helpers/journey";

const RUN_ID = process.env.XIHE_E2E_RUN_ID || `headed-0623-${Date.now()}`;
const RUN_DIR = path.resolve(process.cwd(), "../../.tmp/xh-headed-0623/runs", RUN_ID);
const SHOTS_DIR = path.join(RUN_DIR, "shots");
const GOLDPATH_EMAIL = process.env.XIHE_E2E_GOLDPATH_EMAIL ?? "";
const GOLDPATH_PASSWORD = process.env.XIHE_E2E_GOLDPATH_PASSWORD ?? "";

/**
 * PLAN-0623 走查 testid 清单（verify V12 归档依据）。状态与 0622 同构：
 * - `asserted`：本 spec 真的断言过，`file:line` 指向源码里确实存在的那一行；
 * - `exists-unasserted`：源码存在但本 spec 未断言（写清为什么走不到）；
 * - `blocked`：依赖的能力/数据尚未具备，真机无法稳定造出。
 */
type TestIdStatus = "asserted" | "exists-unasserted" | "blocked";

const RECORDED_TESTIDS: Array<{ id: string; scene: string; status: TestIdStatus; note: string }> = [
    {
        id: "workspace-toolbar-members",
        scene: "S1",
        status: "asserted",
        note: "packages/ui/src/features/workspace/components/WorkspaceToolbar.vue:271（工具栏开关，点击前存在）",
    },
    {
        id: "dock-tab-members",
        scene: "S1",
        status: "asserted",
        note: "packages/ui/src/features/workspace/components/WorkspaceDock.vue:173（`dock-tab-${tab.id}` 通用规则）",
    },
    {
        id: "session-participants-panel",
        scene: "S1–S4",
        status: "asserted",
        note: "packages/ui/src/features/workspace/components/SessionParticipantsPanel.vue:136（面板根节点）",
    },
    {
        id: "participants-empty",
        scene: "S1",
        status: "asserted",
        note: "SessionParticipantsPanel.vue:137/168（无会话用 EmptyNoSession 文案）",
    },
    {
        id: "participant-row-*",
        scene: "S2",
        status: "asserted",
        note: "ParticipantRow.vue:141（`participant-row-${participantId}`）",
    },
    {
        id: "participant-initials-*",
        scene: "S2",
        status: "asserted",
        note: "ParticipantRow.vue:149（首字母头像）",
    },
    {
        id: "participant-kind-badge-*",
        scene: "S2",
        status: "asserted",
        note: "ParticipantRow.vue:166（`data-participant-kind`）",
    },
    {
        id: "participant-role-badge-*",
        scene: "S2",
        status: "asserted",
        note: "ParticipantRow.vue:173（`data-session-role`）",
    },
    {
        id: "participant-source-badge-*",
        scene: "S2",
        status: "asserted",
        note: "ParticipantRow.vue:181（仅 AGENT 有 source）",
    },
    {
        id: "participant-model-*",
        scene: "S2",
        status: "asserted",
        note: "ParticipantRow.vue:243（仅 AGENT 有 defaultModelProvider/Name）",
    },
    {
        id: "participant-mention-*",
        scene: "S3",
        status: "asserted",
        note: "ParticipantRow.vue:251（提及按钮）",
    },
    {
        id: "participant-remove-*",
        scene: "S4",
        status: "asserted",
        note: "ParticipantRow.vue:264（移除按钮，两次点击确认）",
    },
    {
        id: "participant-disabled-badge-*",
        scene: "S4",
        status: "asserted",
        note: "ParticipantRow.vue:196（D23-26 soft disable 后行仍在）",
    },
    {
        id: "participants-forbidden",
        scene: "—",
        status: "blocked",
        note: "SessionParticipantsPanel.vue:150。真机需要「无 view 权限的账号」，本 spec 只有一个 bootstrap 账号；不假造账号 ⇒ not covered",
    },
    {
        id: "participants-loading",
        scene: "—",
        status: "exists-unasserted",
        note: "SessionParticipantsPanel.vue:144。真机上请求极快，稳定捕获 loading 窗口不可靠（组件测试已覆盖）",
    },
    {
        id: "participants-empty-none",
        scene: "—",
        status: "blocked",
        note: "SessionParticipantsPanel.vue:168 的 EmptyNone 分支。会话一定带 PRIMARY（D23-13），无法造出「参与者为空」的会话 ⇒ not covered",
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
const consoleLog: string[] = [];
const failedTests: string[] = [];
const skippedTests: string[] = [];
let shotSeq = 0;
let workspaceId = "";
let sessionId = "";
let agentParticipantId = "";
let humanParticipantId = "";
let humanDisplayName = "";

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

/**
 * 读 token：**优先用 storageState**，不在页面上 `evaluate(localStorage)`。
 *
 * 原因：`page.evaluate` 访问 `localStorage` 要求当前文档是合法 origin；在 S2–S4 里
 * 新测试拿到的 `page` 还停在 `about:blank`（本测试尚未导航），直接 evaluate 会抛
 * `SecurityError: Access is denied for this document`（2026-11-02 真机实测）。
 * storageState 由浏览器侧导出，不依赖当前文档。
 */
async function tokenOf(page: Page): Promise<string> {
    const state = await page.context().storageState();
    for (const origin of state.origins ?? []) {
        const entry = origin.localStorage?.find((item) => item.name === "xihe-token");
        if (entry?.value) return entry.value;
    }
    // 兜底：只有在文档已经是 http(s) origin 时才 evaluate（否则同一 SecurityError）。
    const url = page.url();
    if (url.startsWith("http://") || url.startsWith("https://")) {
        const token = await page.evaluate(() => localStorage.getItem("xihe-token"));
        expect(token, "the UI must have persisted a token").toBeTruthy();
        return token!;
    }
    throw new Error(
        `no persisted xihe-token for this browser context (current url: ${url}); ` +
            "the login step must run before a scene on a fresh page",
    );
}

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

/** 诊断：面板没出现时，把"现在页面是什么状态"写进报错，而不是只报一句超时。 */
async function participantsDiagnostics(page: Page): Promise<string> {
    const count = async (testId: string) => page.getByTestId(testId).count();
    return (
        `url=${page.url()} ` +
        `membersTab=${await count("dock-tab-members")} ` +
        `panel=${await count("session-participants-panel")} ` +
        `rows=${await page.locator('[data-testid^="participant-row-"]').count()} ` +
        `empty=${await count("participants-empty")} ` +
        `forbidden=${await count("participants-forbidden")}`
    );
}

function rowOf(id: string) {
    return `[data-testid="participant-row-${id}"]`;
}

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.describe("PLAN-0623 有头走查：会话参与者 dock tab", () => {
    test.beforeAll(() => {
        mkdirSync(SHOTS_DIR, { recursive: true });
        expect(GOLDPATH_EMAIL, "the headed lane needs the bootstrap account").not.toBe("");
        expect(GOLDPATH_PASSWORD, "the headed lane needs the bootstrap password").not.toBe("");
    });

    test.beforeEach(({ page }) => {
        attachPageDiagnostics(page);
    });

    // Playwright 要求 afterEach 的第一个参数是**解构模式**（fixtures），不能是普通标识符；
    // oxlint 的 no-empty-pattern 不理解这个 API 契约，所以对下一行显式豁免。
    // eslint-disable-next-line no-empty-pattern
    test.afterEach(({}, testInfo) => {
        if (testInfo.status === "failed" || testInfo.status === "timedOut") {
            failedTests.push(`${testInfo.title} [${testInfo.status}]`);
        } else if (testInfo.status === "skipped") {
            skippedTests.push(testInfo.title);
        }
    });

    test.afterAll(() => {
        mkdirSync(RUN_DIR, { recursive: true });
        const pending = RECORDED_TESTIDS.filter((item) => item.status !== "asserted");
        writeFileSync(
            path.join(RUN_DIR, "report.json"),
            `${JSON.stringify(
                {
                    plan: "PLAN-0623",
                    milestone: "M1a 走查",
                    spec: "e2e/headed/session-participants.spec.ts",
                    runId: RUN_ID,
                    scenes: ["S1 dock tab", "S2 rows", "S3 mention", "S4 soft disable"],
                    steps,
                    notCovered,
                    failedTests,
                    skippedTests,
                    status:
                        failedTests.length > 0
                            ? "failed"
                            : skippedTests.length > 0 || notCovered.length > 0
                              ? "partial"
                              : "asserted",
                    expectedTestIds: {
                        total: RECORDED_TESTIDS.length,
                        asserted: RECORDED_TESTIDS.filter((item) => item.status === "asserted")
                            .length,
                        blocked: RECORDED_TESTIDS.filter((item) => item.status === "blocked")
                            .length,
                        pendingVerification: pending.length,
                        items: RECORDED_TESTIDS,
                    },
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

    test("S1@host 成员 tab 默认未选中；点工具栏开关后出现；无会话时空态文案是「选择会话」", async ({
        page,
        request,
    }) => {
        await loginViaForm(page, GOLDPATH_EMAIL, GOLDPATH_PASSWORD);
        const token = await tokenOf(page);
        // 用例**自建专属工作区**：不复用 workspaces[0]（共享栈上那里可能有别人留下的工作区
        // 和活动会话，会让"无会话空态"的前提不成立 —— 2026-11-02 真机实测过）。
        const before = await request.get(`${CP_URL}/api/v1/workspaces`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(before.status(), await before.text()).toBe(200);
        const beforeIds = ((await before.json()) as Array<{ id: string }>).map((item) => item.id);

        workspaceId = await createDirectAttachWorkspace(request, token);
        // 可验证的"确实自造"：新 id 不在创建前的列表里（声明与实现之间要有断言）。
        expect(
            beforeIds,
            "the spec must run in a workspace it created, not a leftover one",
        ).not.toContain(workspaceId);

        await page.goto(`/workspace/${workspaceId}`, { waitUntil: "load" });
        await expect(page.getByTestId("workspace-toolbar-members")).toBeVisible({ timeout: 45000 });

        // 前提：自建工作区里**没有会话**（否则面板走"有会话"分支，无会话空态断言不成立）。
        // `workspace-create-session` 只在空态渲染（WorkspaceView.vue 的 v-else 分支）。
        await expect(
            page.getByTestId("workspace-create-session"),
            "a freshly created workspace must start with no open session",
        ).toBeVisible({ timeout: 45000 });
        expect(
            await page.getByTestId("chat-input").count(),
            "a freshly created workspace must not render a chat composer",
        ).toBe(0);

        // 默认未选中：持久化里没有 members（SSOT = xihe-layout-ws:<id>.dockTabs）
        const stored = await page.evaluate(
            (ws) => localStorage.getItem(`xihe-layout-ws:${ws}`),
            workspaceId,
        );
        expect(stored ?? "").not.toContain("members");
        expect(
            await page.getByTestId("dock-tab-members").count(),
            "the members dock tab must not be open by default",
        ).toBe(0);

        await page.getByTestId("workspace-toolbar-members").click();
        await expect(
            page.getByTestId("session-participants-panel"),
            await participantsDiagnostics(page),
        ).toBeVisible({ timeout: 20000 });
        await expect(page.getByTestId("dock-tab-members")).toHaveAttribute("aria-selected", "true");

        // 无会话：空态必须是"先选择一个会话"（不是"这个会话还没有参与者"）。
        const empty = page.getByTestId("participants-empty");
        await expect(empty).toBeVisible({ timeout: 20000 });
        await expect(empty).toHaveText(/选择一个会话|Select a session/i);
        await shot(page, {
            id: "S1",
            name: "s1-members-tab-default-and-empty",
            assertion:
                "默认未选中 → 点工具栏开关后成员 tab 选中；无会话空态文案为「先选择一个会话」",
        });
    });

    test("S2@host 行渲染：AGENT 有来源+模型段，HUMAN 无模型段", async ({ page, request }) => {
        expect(workspaceId, "S2 depends on S1").not.toBe("");
        // 每个 test 有独立的 browser context（Playwright 默认隔离）⇒ 必须重新登录，
        // 否则 storageState 里没有 xihe-token（0622 的有头 spec 也是每场重新登录）。
        await loginViaForm(page, GOLDPATH_EMAIL, GOLDPATH_PASSWORD);
        const token = await tokenOf(page);

        // 专属工作区里现建 agent principal（S1 只验证 dock tab 与无会话空态）。
        // 模型意图必须**显式给**：参与者视图的 defaultModelProvider/Name 直接取自 principal，
        // 不给值 ⇒ UI 正确地不渲染模型段（那是"不伪造"语义，不是缺陷）。
        // 取值用 Lead 在干净栈(cp=27457)实测通过的一对：mock / gpt-5（principal → 视图 → UI 全链路已证）。
        // 名字**不带空格**：S3 会用 displayName 拼 `@name`，空格会让断言与真实输入都变脆。
        agentParticipantId = await provisionWorkspaceAgentPrincipal(
            request,
            { accessToken: token, workspaceId },
            {
                name: `Headed-Participants-${randomUUID().slice(0, 8)}`,
                actions: ["read"],
                defaultModelProvider: "mock",
                defaultModelName: "gpt-5",
            },
        );

        // 建会话**必须带工作区上下文**：本 spec 自建了工作区 ⇒ 账号变多工作区 ⇒ 无上下文的
        // `POST /api/v1/sessions` 会 409 `WORKSPACE_CONTEXT_REQUIRED`（产品拒绝歧义，不猜第一个）。
        // helper 收到 `workspaceId` 时走路径形式 + `X-Workspace-Id`（不传时行为不变，旧 spec 不受影响）。
        sessionId = await createSessionWithPrincipal(
            request,
            { accessToken: token, workspaceId },
            {
                principalId: agentParticipantId,
                title: "Participants walkthrough",
                workspaceId,
            },
        );

        // 归属断言：会话必须落在本次自建的工作区里，而不是别处。
        const createdSession = await request.get(`${CP_URL}/api/v1/sessions/${sessionId}`, {
            headers: { Authorization: `Bearer ${token}`, "X-Workspace-Id": workspaceId },
        });
        expect(createdSession.status(), await createdSession.text()).toBe(200);
        expect(
            ((await createdSession.json()) as { workspaceId?: string }).workspaceId,
            "the session must live in the workspace this run created",
        ).toBe(workspaceId);

        // CP 不变式（D23-13）：会话创建事务内必须播种**恰好一行** role=PRIMARY。
        // 这条断言先行，是为了让"CP 少播种 PRIMARY"在**这里**失败并说明原因，
        // 而不是让 S2 在后面渲染层莫名失败（2026-11-02 实测过这个缺口）。
        const seeded = await request.get(`${CP_URL}/api/v1/sessions/${sessionId}/participants`, {
            headers: { Authorization: `Bearer ${token}`, "X-Workspace-Id": workspaceId },
        });
        expect(seeded.status(), await seeded.text()).toBe(200);
        const seededBody = (await seeded.json()) as {
            participants: Array<{ role: string; principalKind: string }>;
        };
        const seededPrimary = seededBody.participants.filter((item) => item.role === "PRIMARY");
        expect(
            seededPrimary.length,
            `PRIMARY seeding missing: session ${sessionId} has ${seededBody.participants.length} participant(s) ` +
                `and ${seededPrimary.length} role=PRIMARY. CP must insert exactly one PRIMARY row inside the ` +
                `session-creation transaction (D23-13) — this is a control-plane defect, not a UI one.`,
        ).toBe(1);
        agentParticipantId = seededBody.participants[0]
            ? String(agentParticipantId)
            : agentParticipantId;

        // 用例自造状态：把当前用户作为 HUMAN MEMBER 加入会话（会话已有 AGENT PRIMARY）。
        const me = await request.get(`${CP_URL}/api/v1/auth/me`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(me.ok(), await me.text()).toBe(true);
        const { id: userId } = (await me.json()) as { id: string };
        const added = await request.post(`${CP_URL}/api/v1/sessions/${sessionId}/participants`, {
            headers: { Authorization: `Bearer ${token}`, "X-Workspace-Id": workspaceId },
            data: { principalKind: "HUMAN", principalId: userId, role: "MEMBER" },
        });
        expect(added.status(), await added.text()).toBe(201);

        const list = await request.get(`${CP_URL}/api/v1/sessions/${sessionId}/participants`, {
            headers: { Authorization: `Bearer ${token}`, "X-Workspace-Id": workspaceId },
        });
        expect(list.status(), await list.text()).toBe(200);
        const body = (await list.json()) as {
            participants: Array<{
                participantId: string;
                principalKind: string;
                displayName?: string;
            }>;
        };
        const human = body.participants.find((item) => item.principalKind === "HUMAN");
        const agent = body.participants.find((item) => item.principalKind === "AGENT");
        expect(human, "the session must contain the HUMAN member we just added").toBeTruthy();
        expect(agent, "the session must contain the AGENT primary").toBeTruthy();
        humanParticipantId = human!.participantId;
        humanDisplayName = human!.displayName ?? "";

        await page.goto(`/workspace/${workspaceId}/chat/${sessionId}`, { waitUntil: "load" });
        await expect(page.getByTestId("workspace-toolbar-members")).toBeVisible({ timeout: 45000 });
        if ((await page.getByTestId("dock-tab-members").count()) === 0) {
            await page.getByTestId("workspace-toolbar-members").click();
        }
        const panel = page.getByTestId("session-participants-panel");
        await expect(panel, await participantsDiagnostics(page)).toBeVisible({ timeout: 20000 });

        const agentRow = page.locator(rowOf(agent!.participantId));
        const humanRow = page.locator(rowOf(humanParticipantId));
        await expect(agentRow).toBeVisible({ timeout: 20000 });
        await expect(humanRow).toBeVisible({ timeout: 20000 });

        // 主体类型徽标 / 会话角色徽标（源码：ParticipantRow.vue 的 data-* 属性）
        await expect(
            agentRow.getByTestId(`participant-kind-badge-${agent!.participantId}`),
        ).toHaveAttribute("data-participant-kind", "AGENT");
        await expect(
            agentRow.getByTestId(`participant-role-badge-${agent!.participantId}`),
        ).toHaveAttribute("data-session-role", "PRIMARY");
        await expect(
            humanRow.getByTestId(`participant-kind-badge-${humanParticipantId}`),
        ).toHaveAttribute("data-participant-kind", "HUMAN");
        await expect(
            humanRow.getByTestId(`participant-role-badge-${humanParticipantId}`),
        ).toHaveAttribute("data-session-role", "MEMBER");

        // 首字母头像非空（ParticipantRow.vue 的 initials computed）
        await expect(
            agentRow.getByTestId(`participant-initials-${agent!.participantId}`),
        ).not.toBeEmpty();
        await expect(
            humanRow.getByTestId(`participant-initials-${humanParticipantId}`),
        ).not.toBeEmpty();

        // AGENT：来源徽标 + 模型段；HUMAN：两者都不该有。
        await expect(
            agentRow.getByTestId(`participant-source-badge-${agent!.participantId}`),
        ).toBeVisible();
        // 有值时**必须**渲染，且文本是"provider / model"（ParticipantRow.vue 的 modelIntent）：
        // 这条同时证明 ① 模型意图能存 ② 经 participants 视图传到 UI ③ 格式正确。
        await expect(agentRow.getByTestId(`participant-model-${agent!.participantId}`)).toHaveText(
            /mock\s*\/\s*gpt-5/,
        );
        expect(
            await humanRow.getByTestId(`participant-model-${humanParticipantId}`).count(),
            "a HUMAN participant has no model intent",
        ).toBe(0);
        expect(
            await humanRow.getByTestId(`participant-source-badge-${humanParticipantId}`).count(),
            "a HUMAN participant has no agent source",
        ).toBe(0);

        await shot(page, {
            id: "S2",
            name: "s2-participant-rows",
            assertion: "AGENT 行有来源徽标与模型段；HUMAN 行两者皆无；两行都有首字母与角色徽标",
        });
    });

    test("S3@host 提及：输入框出现 @displayName，且没有发出 chat", async ({ page }) => {
        expect(humanParticipantId, "S3 depends on S2").not.toBe("");
        await loginViaForm(page, GOLDPATH_EMAIL, GOLDPATH_PASSWORD);
        await page.goto(`/workspace/${workspaceId}/chat/${sessionId}`, { waitUntil: "load" });
        await expect(page.getByTestId("workspace-toolbar-members")).toBeVisible({ timeout: 45000 });
        if ((await page.getByTestId("dock-tab-members").count()) === 0) {
            await page.getByTestId("workspace-toolbar-members").click();
        }
        await expect(page.getByTestId("session-participants-panel")).toBeVisible({
            timeout: 20000,
        });

        const input = page.getByTestId("chat-input");
        await expect(input).toBeVisible({ timeout: 45000 });

        let chatPosts = 0;
        page.on("request", (request) => {
            if (new URL(request.url()).pathname === "/api/v1/chat" && request.method() === "POST") {
                chatPosts += 1;
            }
        });

        await page.getByTestId(`participant-mention-${humanParticipantId}`).click();
        await expect(input).toHaveValue(
            new RegExp(`@${humanDisplayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
        );
        // 提及只改草稿：不许发出任何 chat 请求（代发是 D23-27 明确不做的动作）。
        expect(chatPosts, "mentioning must not send a message").toBe(0);

        await shot(page, {
            id: "S3",
            name: "s3-mention-inserted-into-draft",
            assertion: "点「提及」→ 草稿含 @displayName，且没有 POST /api/v1/chat",
        });
    });

    test("S4@host 移除 = 两次点击 + soft disable：行仍在并带「已停用」", async ({ page }) => {
        expect(humanParticipantId, "S4 depends on S2").not.toBe("");
        await loginViaForm(page, GOLDPATH_EMAIL, GOLDPATH_PASSWORD);
        await page.goto(`/workspace/${workspaceId}/chat/${sessionId}`, { waitUntil: "load" });
        await expect(page.getByTestId("workspace-toolbar-members")).toBeVisible({ timeout: 45000 });
        if ((await page.getByTestId("dock-tab-members").count()) === 0) {
            await page.getByTestId("workspace-toolbar-members").click();
        }
        await expect(page.getByTestId("session-participants-panel")).toBeVisible({
            timeout: 20000,
        });

        const remove = page.getByTestId(`participant-remove-${humanParticipantId}`);
        await expect(remove).toBeVisible({ timeout: 20000 });
        await expect(remove).toBeEnabled({ timeout: 20000 });

        const idle = (await remove.textContent()) ?? "";
        await remove.click();
        await expect(remove, "first click must switch into the confirm state").not.toHaveText(idle);
        await expect(remove).toHaveText(/再次点击|Confirm/i);

        const removal = page.waitForResponse(
            (response) =>
                new URL(response.url()).pathname ===
                    `/api/v1/sessions/${sessionId}/participants/${humanParticipantId}` &&
                response.request().method() === "DELETE",
        );
        await remove.click();
        const answered = await removal;
        expect([200, 204], await answered.text()).toContain(answered.status());

        // D23-26：soft disable ⇒ 行不消失，出现「已停用」徽标。
        await expect(
            page.getByTestId(`participant-disabled-badge-${humanParticipantId}`),
            "a soft-disabled participant must stay visible with its badge",
        ).toBeVisible({ timeout: 20000 });

        await shot(page, {
            id: "S4",
            name: "s4-soft-disabled-row",
            assertion: "两次点击移除 → DELETE 204 → 行仍在且出现「已停用」徽标（D23-26）",
        });
    });

    test("not-covered 登记：403 态与「参与者为空」会话", () => {
        recordNotCovered(
            "participants-forbidden",
            "需要「无 view 权限」的第二个账号；headed 车道只有 bootstrap 账号，不假造账号 ⇒ 该态仅组件测试覆盖",
        );
        recordNotCovered(
            "participants-empty-none",
            "会话创建时必定带 PRIMARY（D23-13），无法造出「参与者为空」的会话 ⇒ 该态仅组件测试覆盖",
        );
    });
});
