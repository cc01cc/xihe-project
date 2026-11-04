/**
 * PLAN-0658 R7 @host — 失败终态（durable）矩阵。
 *
 * mock 侧（`e2e/mock/session-matrix-failures.spec.ts`，M6）只验**渲染**：可重试错误出现
 * `message-error` 横幅 + 重试入口，非可重试错误不诱导重试；它把 **durable 终态留给
 * real-lane R7**（mock 注释原话：`durable 终态由 real-lane R7 覆盖`）。
 *
 * 本 spec 验真栈的 durable 面：
 *  1. 一次 provider 流错误（fake LLM 的 `XIHE-E2E-DROP` 标记：preamble 后直接断流、无内容）
 *     必须落到 **terminal failed**，而不是挂着 `running` 或静默成功；
 *  2. 失败原因在 durable 读面可诊断：`GET /chat/runs/{runId}` 给出 terminal 状态 +
 *     `terminalOutcome`，`GET /chat/sessions/{id}/runs` 给出稳定 `errorCode`，
 *     `GET /chat/runs/{runId}/attempts` 留下传输尝试行（含 `errorCode`），不依赖 UI toast；
 *  3. 失败**不产出 assistant 正文**（消息投影里没有该 run 的成功回答）——避免"错误被吞成空回复"。
 *
 * 断言只认产品权威读面 + 稳定错误码集合（`ChatController` 的 safe-code 白名单），不改产品。
 *
 * SSE 门：`POST /api/v1/chat` 先校验会话已有活跃订阅（DEV-014），本次窗内保活一条。
 */
import { expect, test, type APIRequestContext } from "@playwright/test";
import { CP_URL, getRootBranchId } from "./helpers/journey";
import { ensureWorkspace } from "./helpers/workspace";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";
import { openSessionSse } from "./helpers/sse";

const NONCE = Date.now().toString(36);
const PASSWORD = process.env.XIHE_E2E_PASSWORD ?? "XhE2e!matrix1";
const FAKE_LLM_PORT = process.env.XIHE_FAKE_LLM_PORT ?? "";
const FAKE_LLM_MODEL = "fake-openai";
const FAKE_LLM_API_KEY = "sk-fake-openai-key";

/** CP 侧稳定错误码白名单（`ChatController` safe-code switch；default 会塌缩成 AGENT_UNAVAILABLE）。 */
const SAFE_CODES = new Set([
    "LLM_NOT_CONFIGURED",
    "LLM_CREDENTIALS_INVALID",
    "LLM_PROVIDER_UNREACHABLE",
    "LLM_MODEL_UNAVAILABLE",
    "LLM_REQUEST_REJECTED",
    "LLM_TOOL_ROUTE_UNSUPPORTED",
    "AGENT_UNAVAILABLE",
    "AGENT_TIMEOUT",
    "AGENT_CIRCUIT_OPEN",
    "AGENT_STREAM_FAILED",
    "CONTEXT_OVERFLOW",
    "RUN_BUDGET_EXHAUSTED",
    "RUN_NO_PROGRESS",
]);

const TERMINAL = new Set(["succeeded", "failed", "partial", "ambiguous", "cancelled"]);

interface RunStatus {
    runId?: string;
    sessionId?: string;
    status?: string;
    terminalOutcome?: string | null;
    origin?: string;
}

interface RunSummary {
    runId?: string;
    status?: string;
    terminalOutcome?: string | null;
    errorCode?: string | null;
}

interface AttemptView {
    seq?: number;
    errorCode?: string | null;
    errorMessage?: string | null;
}

let headers: Record<string, string> = {};
let sessionId = "";
let rootBranchId = "";
let closeSse: (() => void) | null = null;
/** R7-1 产生的失败 run，供 R7-2/R7-3 复用（serial）。 */
let failedRunId = "";

test.describe.configure({ mode: "serial", retries: 0 });

async function runStatus(request: APIRequestContext, runId: string): Promise<RunStatus> {
    const response = await request.get(`${CP_URL}/api/v1/chat/runs/${runId}`, { headers });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()) as RunStatus;
}

test.describe("@host PLAN-0658 R7 失败终态（durable）", () => {
    test.beforeAll(async ({ request }) => {
        expect(FAKE_LLM_PORT, "needs XIHE_FAKE_LLM_PORT (runner fake LLM)").not.toBe("");
        const email = `r7-owner-${NONCE}-${Math.floor(Math.random() * 10000)}@test.com`;
        const registered = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: { email, password: PASSWORD, name: "r7-owner" },
        });
        expect(registered.status(), await registered.text()).toBe(201);
        const auth = (await registered.json()) as { accessToken: string };
        const workspaceId = await ensureWorkspace(request, auth.accessToken);
        headers = {
            Authorization: `Bearer ${auth.accessToken}`,
            "Content-Type": "application/json",
            "X-Workspace-Id": workspaceId,
        };

        const connection = await request.post(`${CP_URL}/api/v1/provider-connections`, {
            headers,
            data: {
                providerId: "openai",
                apiTypeId: "openai-chat-completions",
                apiTypeVersion: 1,
                apiKey: FAKE_LLM_API_KEY,
                connectionKey: `r7-${NONCE}`,
                label: `R7 fake LLM (${NONCE})`,
                scope: "USER",
                modelDiscovery: "manual",
                manualModels: [FAKE_LLM_MODEL],
                baseUrl: `http://127.0.0.1:${FAKE_LLM_PORT}/openai/v1`,
            },
        });
        expect(connection.status(), await connection.text()).toBe(201);
        const connectionId = ((await connection.json()) as { id: string }).id;
        const verified = await request.post(
            `${CP_URL}/api/v1/provider-connections/${connectionId}/verify`,
            { headers },
        );
        expect(verified.ok(), await verified.text()).toBe(true);

        const principalId = await provisionWorkspaceAgentPrincipal(
            request,
            { accessToken: auth.accessToken, workspaceId },
            {
                name: `r7-agent-${NONCE}`,
                actions: [],
                defaultModelProvider: "openai",
                defaultModelName: FAKE_LLM_MODEL,
            },
        );
        sessionId = await createSessionWithPrincipal(
            request,
            { accessToken: auth.accessToken, workspaceId },
            { principalId, title: `r7-failures-${NONCE}`, workspaceId },
        );
        rootBranchId = await getRootBranchId(request, sessionId, headers);
        closeSse = await openSessionSse(sessionId, auth.accessToken, {
            "X-Workspace-Id": workspaceId,
        });
    });

    test.afterAll(() => {
        closeSse?.();
        closeSse = null;
    });

    // 终态语义（durable 实测，隔离栈 `chat_runs` 三列）：provider 传输层面断流（preamble 后
    // 直接断、零内容）⇒ `status=ambiguous` + `terminal_outcome=ambiguous` +
    // `error_code=LLM_PROVIDER_UNREACHABLE`。ambiguous 是**设计选择**而不是"没结论"：LLM 调用
    // 没有幂等凭证，provider 可能已经收下请求（Agent 侧报 outcome=ambiguous，CP
    // `ChatController.java:2137` 原样映射）。本 spec 就按这个契约钉死 —— 若产品改判成
    // failed/error，这条会响亮地失败，而不是被"宽松断言"糊过去。
    test("R7-1 provider 流错误 → durable terminal ambiguous + 稳定 errorCode", async ({
        request,
    }) => {
        const sent = await request.post(`${CP_URL}/api/v1/chat`, {
            headers,
            data: {
                sessionId,
                branchId: rootBranchId,
                content: `XIHE-E2E-DROP r7 ${NONCE}`,
            },
        });
        expect(sent.status(), await sent.text()).toBe(202);
        const accepted = (await sent.json()) as { runId?: string };
        expect(accepted.runId, "runId").toBeTruthy();
        failedRunId = accepted.runId!;

        // 先钉"会收敛"：不悬挂、不静默成功。
        await expect
            .poll(
                async () => {
                    const view = await runStatus(request, failedRunId);
                    return TERMINAL.has(String(view.status ?? "")) ? view.status : "pending";
                },
                { timeout: 90_000, intervals: [500, 1_000] },
            )
            .toBe("ambiguous");
    });

    test("R7-2 durable 读面带稳定 errorCode 与传输尝试行", async ({ request }) => {
        expect(failedRunId, "R7-1 必须已产生终态 run").not.toBe("");

        // 会话运行摘要：terminalOutcome + 稳定 errorCode（SessionRunSummary，BL-197 ② 之外的部分）。
        const runs = await request.get(
            `${CP_URL}/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/runs`,
            { headers },
        );
        expect(runs.status(), await runs.text()).toBe(200);
        const list = (await runs.json()) as { runs?: RunSummary[] } | RunSummary[];
        const rows = Array.isArray(list) ? list : (list.runs ?? []);
        const failed = rows.find((row) => row.runId === failedRunId);
        expect(failed, "终态 run 出现在会话运行摘要里").toBeTruthy();
        expect(failed!.status).toBe("ambiguous");
        expect(failed!.terminalOutcome, "终态归因").toBe("ambiguous");
        const code = String(failed!.errorCode ?? "");
        expect(code, "失败必须带稳定错误码（不是空、不是裸状态码）").toBe(
            "LLM_PROVIDER_UNREACHABLE",
        );
        expect(SAFE_CODES.has(code), `errorCode=${code} 必须属 CP 稳定码白名单`).toBe(true);

        // 传输尝试行：可诊断证据（PLAN-0508 的 durable transport attempts）。
        const attempts = await request.get(
            `${CP_URL}/api/v1/chat/runs/${encodeURIComponent(failedRunId)}/attempts`,
            { headers },
        );
        expect(attempts.status(), await attempts.text()).toBe(200);
        const attemptBody = (await attempts.json()) as { attempts?: AttemptView[] } | AttemptView[];
        const attemptRows = Array.isArray(attemptBody) ? attemptBody : (attemptBody.attempts ?? []);
        expect(attemptRows.length, "至少一条传输尝试").toBeGreaterThan(0);
        expect(
            attemptRows.some((attempt) => String(attempt.errorCode ?? "").length > 0),
            "至少一条尝试带 errorCode",
        ).toBe(true);
    });

    test("R7-3 失败 run 不产出 assistant 正文（错误不被吞成空回复）", async ({ request }) => {
        const response = await request.get(
            `${CP_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/messages?branchId=${encodeURIComponent(rootBranchId)}`,
            { headers },
        );
        expect(response.status(), await response.text()).toBe(200);
        const payload = (await response.json()) as
            | Array<{ role?: string; runId?: string; content?: string }>
            | { messages?: Array<{ role?: string; runId?: string; content?: string }> };
        const rows = Array.isArray(payload) ? payload : (payload.messages ?? []);
        const answered = rows.filter(
            (row) =>
                row.runId === failedRunId &&
                row.role === "ASSISTANT" &&
                typeof row.content === "string" &&
                row.content.trim().length > 0,
        );
        expect(answered.length, "失败 run 不应留下成功回答正文").toBe(0);
    });
});
