/**
 * PLAN-0648 T1.1 @host — **DSH 工作流 1：Agent 编码会话**（读 → 写(审批) → 跑命令 → 收尾）。
 *
 * 为什么这条 spec 存在：`e2e/real/` 里 4/5 个 DSH 工作流已有覆盖，只有"编码会话"
 * 这条端到端链路是空的（详见 PLAN-0644 design §4.1 的覆盖矩阵）。
 *
 * 驱动方式：fake LLM 的 `mode=chain`（见 `e2e/fixtures/chain-scripts.mjs` 的 `wf1-coding`
 * = read_file → write_file → exec_command → text）。链由**首条 user 消息里的
 * `XIHE-E2E-CHAIN wf1-coding` 标记**按会话激活，所以本 spec 不需要 runner 换
 * `--llm-mode`，可以和其它 spec 共用同一个栈。
 *
 * 断言口径（BL-204 教训：不做 in-page 绕过，只认用户可感知结果）：
 *   1. 每轮 `POST /api/v1/chat` 都拿到 runId（链真的被驱动了）；
 *   2. 写文件那轮弹出**审批卡片**，点 `approval-approve` 后卡片消失；
 *   3. 审批通过后，文件出现在**工作区文件树**里（点刷新再断言）；
 *   4. 会话页出现 **checkpoint** 入口（本 RUN 的切片，说明捕获发生了）。
 *
 * 硬约束（xh-host-e2e-pitfalls）：
 *   - 一个进程只注册一个 user/workspace ⇒ serial + retries: 0；
 *   - 每次发送前必须等上一 Run 终止（409 CHAT_IN_PROGRESS），由 startRun 里的
 *     waitForControlPlaneAgentReady + ensureChatBinding 承担；
 *   - 无固定 sleep：只用 expect.poll / 显式 timeout；
 *   - **首次真栈运行尚未发生**（PLAN-0648 停栈窗口内首跑），若某条断言与产品实际
 *     标记不符，按 BL-204 的口径修 spec，不改产品去迁就测试。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
    CP_URL,
    ensureAgentWorkspaceBinding,
    ensureChatBinding,
    registerJourneyUser,
    seedPage,
    waitForControlPlaneAgentReady,
    type JourneyContext,
} from "./helpers/journey";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";

const NONCE = Date.now().toString(36);
const CHAIN = "wf1-coding";
const READ_TARGET = "README.md";
const WRITE_PATH = `notes/wf1-${NONCE}.md`;
const WRITE_CONTENT = `wf1-chain-${NONCE}`;
const HOST_ROOT = process.env.XIHE_E2E_WORKSPACE_ROOT ?? "";
const FAKE_LLM_PORT = process.env.XIHE_FAKE_LLM_PORT ?? "";
const FAKE_LLM_MODEL = "fake-openai";
const FAKE_LLM_API_KEY = "sk-fake-openai-key";

let ctx: JourneyContext;
let sessionId = "";
let agentBindingWorkspaceId = "";

test.describe.configure({ mode: "serial", retries: 0 });

test.describe("@host PLAN-0648 T1.1 DSH 工作流 1 — 编码会话", () => {
    test.beforeAll(async ({ request }) => {
        expect(FAKE_LLM_PORT, "needs XIHE_FAKE_LLM_PORT (runner-provided fake LLM)").not.toBe("");
        ctx = await registerJourneyUser(request, "dsh-wf1");
        agentBindingWorkspaceId = ctx.workspaceId;

        // 会话创建的连接解析（task-24, 2026-11-04）：三件套全空时 CP 按权威顺序补默认
        // （主体默认 → instance llm-provider profile），profile 走严格解析
        // （ConfigService:1199 → 消费用户自己的 USER 连接）；本 spec 的 journey user 没有
        // 连接 ⇒ 409 LLM_PROFILE_CONFLICT（首跑实测）。
        // 修法两步：① 给该用户建一条 fake 连接（request.post 夹具级准备，非产品路径），
        // 它同时是 bindProviderConnection 按 provider 挑唯一候选的目标；
        // ② 主体带 defaultModelProvider/Name ⇒ 取主体侧默认，**不碰 profile 严格解析**。
        const headers = ctx.headers;
        const created = await request.post(`${CP_URL}/api/v1/provider-connections`, {
            headers,
            data: {
                providerId: "openai",
                apiTypeId: "openai-chat-completions",
                apiTypeVersion: 1,
                apiKey: FAKE_LLM_API_KEY,
                connectionKey: `t11-${NONCE}`,
                label: `T1.1 fake LLM (${NONCE})`,
                scope: "USER",
                modelDiscovery: "manual",
                manualModels: [FAKE_LLM_MODEL],
                baseUrl: `http://127.0.0.1:${FAKE_LLM_PORT}/openai/v1`,
            },
        });
        expect(created.status(), await created.text()).toBe(201);
        const connectionId = ((await created.json()) as { id: string }).id;
        expect(connectionId).toMatch(/^[0-9a-f-]{36}$/i);
        const verified = await request.post(
            `${CP_URL}/api/v1/provider-connections/${connectionId}/verify`,
            { headers },
        );
        expect(verified.ok(), await verified.text()).toBe(true);
        expect(
            ((await verified.json()) as { connection?: { status?: string } }).connection?.status,
        ).toBe("READY");

        const principalId = await provisionWorkspaceAgentPrincipal(
            request,
            { accessToken: ctx.authToken, workspaceId: ctx.workspaceId },
            {
                name: `dsh-wf1-${NONCE}`,
                actions: ["read", "write"],
                // 主体默认模型 ⇒ SessionProviderDefaults 按权威顺序「主体默认 → profile」
                // 时取主体侧，**不碰 instance profile 的严格解析**（否则又回 409）。
                // 连接不写在主体上（主体从不持有连接）：会话创建时由 bindProviderConnection
                // 按 provider 自动挑唯一 READY 候选 —— 上面刚建的这条 fake 连接。
                defaultModelProvider: "openai",
                defaultModelName: FAKE_LLM_MODEL,
            },
        );
        sessionId = await createSessionWithPrincipal(
            request,
            { accessToken: ctx.authToken, workspaceId: ctx.workspaceId },
            { principalId, title: `dsh-wf1-${NONCE}` },
        );
    });

    test("读 → 写(审批通过) → 跑命令 → 收尾，全链用户可见", async ({ page, request }) => {
        test.setTimeout(600_000);
        await openChat(page);
        const headers = ctx.headers;

        // ── 第 1 轮：链激活 + read_file ─────────────────────────────────────
        const run1 = await startRun(
            page,
            request,
            headers,
            [
                `XIHE-E2E-CHAIN ${CHAIN}`,
                `请先读 ${READ_TARGET}，告诉我它讲了什么。`,
                `XIHE-E2E-READ ${READ_TARGET}`,
            ].join(" "),
        );
        expect(run1, "turn 1 runId").toMatch(/^[0-9a-f-]{36}$/i);
        await expectAssistantMessage(page, `turn 1 (read_file) 必须有回复`);

        // ── 第 2 轮：write_file（走审批面）────────────────────────────────
        const run2 = await startRun(
            page,
            request,
            headers,
            `把结论写到 ${WRITE_PATH}。 XIHE-E2E-WRITE ${WRITE_PATH} ${WRITE_CONTENT}`,
        );
        expect(run2, "turn 2 runId").toMatch(/^[0-9a-f-]{36}$/i);
        await approveCard(page);
        await expectFileInTree(page, path.basename(WRITE_PATH));
        // 直接落盘读回（host 根下按 workspaceId 分层；拿不到就只靠 UI 断言）
        if (HOST_ROOT && existsSync(path.join(HOST_ROOT, ctx.workspaceId))) {
            const written = path.join(HOST_ROOT, ctx.workspaceId, WRITE_PATH);
            await expect
                .poll(
                    () => {
                        try {
                            return readFileSync(written, "utf8");
                        } catch {
                            return "";
                        }
                    },
                    { timeout: 60_000, intervals: [500, 1_000] },
                )
                .toContain(WRITE_CONTENT);
        }

        // ── 第 3 轮：execute_command ───────────────────────────────────────
        const run3 = await startRun(
            page,
            request,
            headers,
            `现在在这个工作区里跑一条命令看看。 XIHE-E2E-EXEC dir`,
        );
        expect(run3, "turn 3 runId").toMatch(/^[0-9a-f-]{36}$/i);
        await expectAssistantMessage(page, `turn 3 (execute_command) 必须有回复`);

        // ── 第 4 轮：链耗尽 → 纯文本收尾 ───────────────────────────────────
        const run4 = await startRun(page, request, headers, `总结一下你刚才做的三件事。`);
        expect(run4, "turn 4 runId").toMatch(/^[0-9a-f-]{36}$/i);
        await expectAssistantMessage(page, `turn 4 (收尾) 必须有回复`);

        // ── checkpoint：本 RUN 之后捕获行为可见 ────────────────────────────
        const checkpointEntry = page
            .locator('[data-testid="checkpoint-dialog"], [data-testid^="checkpoint-"]')
            .first();
        await expect(checkpointEntry, "checkpoint 入口可见（捕获发生过）").toBeVisible({
            timeout: 60_000,
        });
    });
});

// ── helpers ────────────────────────────────────────────────────────────────

async function openChat(page: Page): Promise<void> {
    seedPage(page, ctx);
    const chatUrl = `/workspace/${ctx.workspaceId}/chat/${sessionId}`;
    // Vite dev 首次深路由会撞上依赖预打包窗口：pageError「Failed to fetch dynamically
    // imported module: …/AppLayout.vue」（2026-11-04 T1.1 首跑 trace 实测，network 同时
    // 在拉 /node_modules/.vite/deps/*）。预打包结束后要么 Vite 自动 full-reload、要么需要
    // 重新导航一次。两段式显式等待 + 一次重导航，无固定 sleep。
    await page.goto(chatUrl, { waitUntil: "load" });
    const input = page.locator('[data-testid="chat-input"]');
    try {
        await expect(input, "chat input (first load)").toBeVisible({ timeout: 60_000 });
    } catch {
        await page.goto(chatUrl, { waitUntil: "load" });
        await expect(input, "chat input (after vite re-optimization reload)").toBeVisible({
            timeout: 90_000,
        });
    }
}

/** 发送一条消息并返回 Run id（重试覆盖"输入被清空"与"点击早于 SSE 水合"）。 */
async function startRun(
    page: Page,
    request: APIRequestContext,
    headers: Record<string, string>,
    text: string,
): Promise<string> {
    if (agentBindingWorkspaceId) await ensureAgentWorkspaceBinding(agentBindingWorkspaceId);
    await waitForControlPlaneAgentReady(request, headers);
    if (sessionId) await ensureChatBinding(page, sessionId);
    const input = page.locator('[data-testid="chat-input"]');
    const send = page.locator('[data-testid="chat-send-button"]');
    await expect(input, "chat input").toBeVisible({ timeout: 30_000 });
    let lastResult = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
        await input.click().catch(() => {});
        await input.fill(text).catch(() => {});
        try {
            await expect(send).toBeEnabled({ timeout: 8_000 });
        } catch {
            continue;
        }
        const posted = page
            .waitForResponse(
                (response) =>
                    response.url().endsWith("/api/v1/chat") &&
                    response.request().method() === "POST",
                { timeout: 20_000 },
            )
            .catch(() => null);
        await send.click().catch(() => {});
        const response = await posted;
        if (!response) continue;
        // 取证优先（窗口 3 实测 202 却取不到 runId）：先留原文再 parse，
        // 失败时把最后一次 status+body 带进错误信息，不再只报"没拿到 runId"。
        const raw = await response.text().catch(() => "");
        lastResult = `status=${response.status()} body=${raw.slice(0, 600)}`;
        let body: { runId?: string } = {};
        try {
            body = raw ? (JSON.parse(raw) as { runId?: string }) : {};
        } catch {
            body = {};
        }
        if (body.runId) return body.runId;
    }
    throw new Error(
        `chat send never returned a runId (POST /api/v1/chat); last attempt: ${lastResult || "no response captured"}`,
    );
}

/** 审批卡片出现并点掉（只认审批面 testid）。 */
async function approveCard(page: Page): Promise<void> {
    const card = page
        .locator('[data-testid="approval-approve"], [data-testid="approval-allow-session"]')
        .first();
    await expect(card, "写文件必须弹审批卡片").toBeVisible({ timeout: 180_000 });
    await card.click();
    await expect(card).toBeHidden({ timeout: 60_000 });
}

/** 工作区文件树里出现该文件（先点刷新，避免等 watcher）。 */
async function expectFileInTree(page: Page, fileName: string): Promise<void> {
    const refresh = page.getByTestId("workspace-file-refresh");
    if (await refresh.isVisible().catch(() => false)) await refresh.click().catch(() => {});
    const tree = page.getByTestId("workspace-file-tree");
    await expect(tree, "workspace file tree").toBeVisible({ timeout: 30_000 });
    await expect(
        tree.getByText(fileName, { exact: false }).first(),
        `文件 ${fileName}`,
    ).toBeVisible({ timeout: 60_000 });
}

/** 第 N 轮之后必须有一条 assistant 气泡（用户可感知的"有回复"）。 */
async function expectAssistantMessage(page: Page, label: string): Promise<void> {
    await expect
        .poll(
            async () =>
                page
                    .locator('[data-slot="message"][data-align="start"]')
                    .last()
                    .innerText()
                    .catch(() => ""),
            { message: label, timeout: 120_000, intervals: [500, 1_000] },
        )
        .toMatch(/\S/);
}
