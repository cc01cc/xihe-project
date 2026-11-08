// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
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

import { agentName } from "./helpers/agent-name";
import { EXPECT_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";
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
                name: agentName("DshWf1", NONCE),
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
                    { timeout: LONG_TIMEOUT_MS, intervals: [500, 1_000] },
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
            timeout: LONG_TIMEOUT_MS,
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
        await expect(input, "chat input (first load)").toBeVisible({ timeout: LONG_TIMEOUT_MS });
    } catch {
        await page.goto(chatUrl, { waitUntil: "load" });
        await expect(input, "chat input (after vite re-optimization reload)").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
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
    // 每段入口等待带 label + 计时（上轮 10.2m 用例超时且无自定义错误 ⇒ 卡在某段
    // 无界等待里；这轮先把"卡在哪段"打出来再修）。
    const logged = async (label: string, fn: () => Promise<void>): Promise<void> => {
        const started = Date.now();
        console.log(`[t1.1] enter ${label}`);
        try {
            await fn();
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            throw new Error(
                `startRun step "${label}" failed after ${Date.now() - started}ms: ${message}`,
                { cause },
            );
        }
        console.log(`[t1.1] exit ${label} in ${Date.now() - started}ms`);
    };

    if (agentBindingWorkspaceId) {
        await logged("agent-workspace-binding", () =>
            ensureAgentWorkspaceBinding(agentBindingWorkspaceId),
        );
    }
    await logged("cp-agent-ready", () => waitForControlPlaneAgentReady(request, headers));

    // watcher 必须在 ensureChatBinding **之前**挂（窗口 4 时间线：页面加载后 1s 就有
    // 一次 POST /chat 202，早于我的 click ⇒ 发送方是产品自身路径（inline-send 嫌疑），
    // 而 waitForResponse 只在 click 前 armed，抓不到"我点击之前"的响应）。
    // 用途双合一：① 捕获**任何** chat POST（我的或产品自动发的），先到的 runId 直接复用
    // （Lead 裁定：inline-send 自发 ⇒ 等它并复用——那本来就是 turn1 的 run）；
    // ② 全量 chatLog 进失败信息，一跑定性。
    let runId = "";
    const chatLog: string[] = [];
    const onResponse = (response: {
        url: () => string;
        request: () => { method: () => string };
        status: () => number;
        text: () => Promise<string>;
    }) => {
        if (!response.url().endsWith("/api/v1/chat") || response.request().method() !== "POST") {
            return;
        }
        chatLog.push(`status=${response.status()} @${new Date().toISOString()}`);
        void response
            .text()
            .then((raw) => {
                try {
                    const body = JSON.parse(raw) as { runId?: string };
                    if (body.runId && !runId) runId = body.runId;
                } catch {
                    /* 非 JSON 体：只留 chatLog */
                }
            })
            .catch(() => {});
    };
    page.on("response", onResponse);

    try {
        if (sessionId) {
            await logged("chat-binding", () => ensureChatBinding(page, sessionId));
        }
        // pre-loop：产品自发的 turn1 run（若有）——6s 内等到即复用
        try {
            // 显式 truthy 语义（不依赖 bare poll 的隐式断言）：等到 runId 非空即停。
            await expect
                .poll(() => runId, { timeout: EXPECT_TIMEOUT_MS, intervals: [250] })
                .not.toBe("");
        } catch {
            /* 没有自发 run：走自己的发送循环 */
        }
        console.log(
            `[t1.1] pre-loop settled runId=${runId ? "<set>" : "<empty>"} chatLog=[${chatLog.join(" | ") || "empty"}]`,
        );
        // run 终态轮询（产品权威状态，非绕 UI）：上一轮 run 未 terminal 时产品自身的
        // run 守卫会锁 composer（窗口 6/7 实测 turn2 锁 62s+，4 次 enable 全超时）。
        // 终态口径复用 checkpoint-slices 的 TERMINAL_RUN_PATTERN，不自造状态词。
        const waitRunTerminal = async (id: string): Promise<void> => {
            await expect
                .poll(
                    async () => {
                        const res = await request.get(`${CP_URL}/api/v1/chat/runs/${id}`, {
                            headers,
                        });
                        if (!res.ok()) return `http-${res.status()}`;
                        const body = (await res.json()) as { status?: string };
                        return body.status ?? "";
                    },
                    {
                        timeout: LONG_TIMEOUT_MS,
                        intervals: [500, 1_000],
                        message: `run ${id} must reach a terminal state`,
                    },
                )
                .toMatch(/^(succeeded|failed|partial|ambiguous|cancelled)$/);
            console.log(`[t1.1] run ${id} terminal`);
        };
        if (runId) {
            console.log(
                `[t1.1] pre-loop chat POST reused runId=${runId} chatLog=${chatLog.join(" | ")}`,
            );
            await waitRunTerminal(runId);
            return runId;
        }

        const input = page.locator('[data-testid="chat-input"]');
        const send = page.locator('[data-testid="chat-send-button"]');
        await expect(input, "chat input").toBeVisible({ timeout: LONG_TIMEOUT_MS });
        // 窗口 6 定性：turn2 的发送按钮 32s 始终不亮、全程无 chat POST ⇒ 上一轮 run 尚未
        // 真正 terminal 时，产品自身的 run 守卫锁着 composer。先带 label 等真终态（30s，
        // 失败信息直接指名这一段）；循环里的 8s 只兜"点完又锁回去"的抖动。
        try {
            await logged("send-enabled-after-turn1", async () => {
                await expect(send).toBeEnabled({ timeout: LONG_TIMEOUT_MS });
            });
        } catch {
            /* 进循环继续尝试；循环内每轮失败会打 attempt 日志 */
        }
        for (let attempt = 0; attempt < 4; attempt += 1) {
            await input.click().catch(() => {});
            await input.fill(text).catch(() => {});
            try {
                await expect(send).toBeEnabled({ timeout: EXPECT_TIMEOUT_MS });
            } catch {
                console.log(`[t1.1] attempt ${attempt + 1} send not enabled`);
                continue;
            }
            await send.click().catch(() => {});
            // 用 watcher+poll 取代 waitForResponse：无论响应何时到都能收，且不与
            // 已被消费的 body 抢（窗口 4 "no response captured" 的根治）。
            try {
                await expect
                    .poll(() => runId, { timeout: LONG_TIMEOUT_MS, intervals: [250] })
                    .not.toBe("");
            } catch {
                /* 本轮没等到：下一次重试 */
            }
            console.log(
                `[t1.1] attempt ${attempt + 1} settled runId=${runId ? "<set>" : "<empty>"} chatLog=[${chatLog.join(" | ") || "empty"}]`,
            );
            await waitRunTerminal(runId);
            if (runId) return runId;
        }
        throw new Error(
            `chat send never returned a runId (POST /api/v1/chat); chatLog=[${chatLog.join(" | ") || "empty"}]`,
        );
    } finally {
        page.off("response", onResponse);
    }
}

/** 审批卡片出现并点掉（只认审批面 testid）。 */
async function approveCard(page: Page): Promise<void> {
    const card = page
        .locator('[data-testid="approval-approve"], [data-testid="approval-allow-session"]')
        .first();
    await expect(card, "写文件必须弹审批卡片").toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await card.click();
    await expect(card).toBeHidden({ timeout: LONG_TIMEOUT_MS });
}

/** 工作区文件树里出现该文件（先点刷新，避免等 watcher）。 */
async function expectFileInTree(page: Page, fileName: string): Promise<void> {
    const refresh = page.getByTestId("workspace-file-refresh");
    if (await refresh.isVisible().catch(() => false)) await refresh.click().catch(() => {});
    const tree = page.getByTestId("workspace-file-tree");
    await expect(tree, "workspace file tree").toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await expect(
        tree.getByText(fileName, { exact: false }).first(),
        `文件 ${fileName}`,
    ).toBeVisible({ timeout: LONG_TIMEOUT_MS });
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
            { message: label, timeout: LONG_TIMEOUT_MS, intervals: [500, 1_000] },
        )
        .toMatch(/\S/);
}
