// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
/**
 * PLAN-0658 R6 @host — 并发/排队（durable queue）矩阵。
 *
 * mock 侧（`e2e/mock/session-matrix-concurrency.spec.ts`，M5）只验 UI affordance 与 wire：
 * 第一个 run 还在流式时 composer 切成"排队"形态，第二条消息只发 `POST /sessions/{id}/follow-ups`
 * （**不是**第二个 `POST /chat`），排队的转录形态留给 real-lane R6。本 spec 验 durable 面：
 *
 *  1. 运行中排队：run A 在跑（fake LLM 的 `XIHE-E2E-SLOW <ms>` 标记拉长窗口）时，follow-up 落到
 *     durable 队列（`FollowUpQueueSnapshot`：queueState=queued、outstandingCount、item 的
 *     content/branchId/status）；同一时刻会话里**只有 run A**（不产生第二个 run）；
 *  2. 幂等重放：同一 `Idempotency-Key` 再 POST ⇒ 200 且队列不重复入队；
 *  3. 排水：队列项最终变成真实的第二个 run / USER 消息（durable `childRunId` 链 + 消息投影）。
 *
 * 事件驱动：只用显式 timeout + 轮询，无固定 sleep。SSE 门同 DEV-014，窗内保活一条订阅。
 */
import { expect, test, type APIRequestContext } from "@playwright/test";
import { CP_URL, getRootBranchId } from "./helpers/journey";
import { ensureWorkspace } from "./helpers/workspace";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";
import { agentName } from "./helpers/agent-name";
import { openSessionSse } from "./helpers/sse";
import { LONG_TIMEOUT_MS } from "../timeouts";

const NONCE = Date.now().toString(36);
const PASSWORD = process.env.XIHE_E2E_PASSWORD ?? "XhE2e!matrix1";
const FAKE_LLM_PORT = process.env.XIHE_FAKE_LLM_PORT ?? "";
const FAKE_LLM_MODEL = "fake-openai";
const FAKE_LLM_API_KEY = "sk-fake-openai-key";
const SLOW_MS = 8_000;

const TERMINAL = new Set(["succeeded", "failed", "partial", "ambiguous", "cancelled"]);

interface FollowUpItem {
    queueItemId: string;
    queueSequence: number;
    status: "queued" | "paused" | "admitted" | "completed" | "withdrawn";
    content?: string | null;
    branchId: string;
    childRunId?: string | null;
}

interface FollowUpQueueSnapshot {
    sessionId: string;
    queueState: "empty" | "queued" | "paused";
    outstandingCount: number;
    capacityLimit: number;
    pauseReason?: string | null;
    items: FollowUpItem[];
}

interface RunSummary {
    runId?: string;
    status?: string;
}

let headers: Record<string, string> = {};
let sessionId = "";
let rootBranchId = "";
let slowRunId = "";
let queueItemId = "";
let followUpContent = "";
let followUpKey = "";
let closeSse: (() => void) | null = null;

test.describe.configure({ mode: "serial", retries: 0 });

function followUpsPath(): string {
    return `${CP_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/follow-ups`;
}

async function queueSnapshot(request: APIRequestContext): Promise<FollowUpQueueSnapshot> {
    const response = await request.get(followUpsPath(), { headers });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()) as FollowUpQueueSnapshot;
}

async function runStatus(request: APIRequestContext, runId: string): Promise<string> {
    const response = await request.get(`${CP_URL}/api/v1/chat/runs/${runId}`, { headers });
    if (!response.ok()) return `http-${response.status()}`;
    return String(((await response.json()) as { status?: string }).status ?? "");
}

async function sessionRuns(request: APIRequestContext): Promise<RunSummary[]> {
    const response = await request.get(
        `${CP_URL}/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/runs`,
        { headers },
    );
    if (!response.ok()) return [];
    const body = (await response.json()) as { runs?: RunSummary[] } | RunSummary[];
    return Array.isArray(body) ? body : (body.runs ?? []);
}

test.describe("@host PLAN-0658 R6 并发排队（durable queue）", () => {
    test.beforeAll(async ({ request }) => {
        expect(FAKE_LLM_PORT, "needs XIHE_FAKE_LLM_PORT (runner fake LLM)").not.toBe("");
        const email = `r6-owner-${NONCE}-${Math.floor(Math.random() * 10000)}@test.com`;
        const registered = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: { email, password: PASSWORD, name: "r6-owner" },
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
                connectionKey: `r6-${NONCE}`,
                label: `R6 fake LLM (${NONCE})`,
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
                name: agentName("R6", NONCE),
                actions: [],
                defaultModelProvider: "openai",
                defaultModelName: FAKE_LLM_MODEL,
            },
        );
        sessionId = await createSessionWithPrincipal(
            request,
            { accessToken: auth.accessToken, workspaceId },
            { principalId, title: `r6-queue-${NONCE}`, workspaceId },
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

    test("R6-1 运行中排队：follow-up 落 durable 队列，且不产生第二个 run", async ({ request }) => {
        const sent = await request.post(`${CP_URL}/api/v1/chat`, {
            headers,
            data: {
                sessionId,
                branchId: rootBranchId,
                content: `XIHE-E2E-SLOW ${SLOW_MS} r6 slow ${NONCE}`,
            },
        });
        expect(sent.status(), await sent.text()).toBe(202);
        slowRunId = ((await sent.json()) as { runId?: string }).runId ?? "";
        expect(slowRunId, "slow run accepted").not.toBe("");

        // 先确认它真的在跑（不是已经终态），否则"运行中排队"就没被验到。
        await expect
            .poll(
                async () => {
                    const status = await runStatus(request, slowRunId);
                    return status !== "" && !TERMINAL.has(status);
                },
                { timeout: LONG_TIMEOUT_MS, intervals: [200, 400] },
            )
            .toBe(true);

        followUpContent = `R6 queued ${NONCE}`;
        followUpKey = `r6-followup-${NONCE}`;
        const queued = await request.post(followUpsPath(), {
            headers: { ...headers, "Idempotency-Key": followUpKey },
            data: { content: followUpContent, branchId: rootBranchId },
        });
        expect([200, 202], `enqueue follow-up: ${queued.status()}`).toContain(queued.status());
        const snapshot = (await queued.json()) as FollowUpQueueSnapshot;
        expect(snapshot.queueState, "队列进入 queued 态").toBe("queued");
        expect(snapshot.outstandingCount, "待办数 ≥ 1").toBeGreaterThanOrEqual(1);
        const item = snapshot.items.find((row) => row.content === followUpContent);
        expect(item, "队列里有这条 follow-up").toBeTruthy();
        expect(item!.branchId, "队列项绑定提交时的分支").toBe(rootBranchId);
        expect(item!.status, "尚未被受理").toBe("queued");
        queueItemId = item!.queueItemId;

        // 同一刻会话里只有 run A：排队**不**额外起 run（mock M5 的 wire 口径在 durable 面成立）。
        const runs = await sessionRuns(request);
        expect(runs.length, "运行中排队不产生第二个 run").toBe(1);
        expect(runs[0]!.runId).toBe(slowRunId);

        // 幂等重放：同 key 再 POST ⇒ 200 且不重复入队。
        const replay = await request.post(followUpsPath(), {
            headers: { ...headers, "Idempotency-Key": followUpKey },
            data: { content: followUpContent, branchId: rootBranchId },
        });
        expect(replay.status(), "幂等重放").toBe(200);
        const replayed = (await replay.json()) as FollowUpQueueSnapshot;
        expect(replayed.outstandingCount, "重放不重复入队").toBe(snapshot.outstandingCount);
    });

    test("R6-2 run 终态后队列排水：队列项变成真实的第二个 run / USER 消息", async ({ request }) => {
        expect(queueItemId, "R6-1 必须已入队").not.toBe("");

        // 排水（产品语义：anchor run 终态后自动受理；若未自动排水则显式 continue 并记录路径）。
        const waitDrained = async (timeoutMs: number): Promise<boolean> => {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
                const snapshot = await queueSnapshot(request);
                if (snapshot.outstandingCount === 0) return true;
                if (Date.now() > deadline) return false;
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
        };

        const autoDrained = await waitDrained(20_000);
        if (!autoDrained) {
            // 自动排水没出现：显式走产品自身的 continue 入口，再等一次。
            const resumed = await request.post(`${followUpsPath()}/continue`, { headers });
            expect([200, 202], `continue: ${resumed.status()}`).toContain(resumed.status());
            expect(await waitDrained(30_000), "continue 之后队列排水").toBe(true);
        }
        console.log(`[R6] autoDrained=${String(autoDrained)}`);

        await expect
            .poll(
                async () => {
                    const runs = await sessionRuns(request);
                    return runs.length;
                },
                { timeout: LONG_TIMEOUT_MS, intervals: [500, 1_000] },
            )
            .toBe(2);

        // durable 链：排队项记录它被受理后的 childRunId；且队列内容进了消息投影（USER 消息）。
        const finalSnapshot = await queueSnapshot(request);
        const finished = finalSnapshot.items.find((row) => row.queueItemId === queueItemId);
        if (finished) {
            expect(["admitted", "completed"], `队列项终态=${finished.status}`).toContain(
                finished.status,
            );
            expect(finished.childRunId, "队列项带 childRunId（durable 链）").toBeTruthy();
        }
        const messages = await request.get(
            `${CP_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/messages?branchId=${encodeURIComponent(rootBranchId)}`,
            { headers },
        );
        expect(messages.status(), await messages.text()).toBe(200);
        const payload = (await messages.json()) as
            | Array<{ role?: string; content?: string }>
            | { messages?: Array<{ role?: string; content?: string }> };
        const rows = Array.isArray(payload) ? payload : (payload.messages ?? []);
        expect(
            rows.some((row) => row.role === "USER" && row.content?.includes(followUpContent)),
            "排队内容最终作为 USER 消息落库",
        ).toBe(true);
    });
});
