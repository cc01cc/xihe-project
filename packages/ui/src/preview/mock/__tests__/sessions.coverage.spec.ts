import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { mockApiPlugin } from "../api-server";
import {
    MOCK_SESSION_WORKSPACE_ID,
    mockSessionBranches,
    mockSessionMessages,
    mockSessionParticipants,
    mockSessions,
    mockSessionMonitor,
    mockSessionRuns,
    sessionsOfWorkspace,
    workspacelessSessions,
} from "../data/sessions";

/**
 * task-25 D（`D-1175` 收窄重开）的机器判据：**新夹具真的被路由消费**，且形状照契约。
 *
 * <p>两条判据缺一不可：①「造了数据没人用」——每个导出夹具都必须能从至少一条路由拿到；
 * ②「用了但形状是发明的」——required 字段、role enum、裸数组 vs 信封、四类投影形状逐条钉。
 * cp-2 `task-392` 依赖这里的高风险桶样本（长代码行 / 长日志行 / 深路径 / 长 CJK / 超长不可断 token）
 * 真的出现在消息体里，所以样本存在性也是判据，不是装饰。</p>
 */

interface Captured {
    status: number;
    body: unknown;
}

type ApiHandler = (req: unknown, res: unknown) => void;

/** 与 mcpDispatch.spec.ts 同口径：直接拿 vite 插件注册的中间件，用假 req/res 打真实 HTTP 面。 */
function mountApiHandler(): ApiHandler {
    let handler: ApiHandler | null = null;
    const plugin = mockApiPlugin();
    const server = {
        middlewares: {
            use: (first: unknown, second?: unknown) => {
                if (first === "/api/v1" && typeof second === "function") {
                    handler = second as ApiHandler;
                }
            },
        },
    };
    (plugin as unknown as { configureServer: (s: unknown) => void }).configureServer(server);
    if (!handler) throw new Error("mock api middleware 未注册");
    return handler;
}

function call(handler: ApiHandler, url: string): Promise<Captured> {
    return new Promise((resolve, reject) => {
        const req = Readable.from([]);
        const reqAny = req as unknown as Record<string, unknown>;
        reqAny.method = "GET";
        reqAny.url = url;
        reqAny.headers = {};
        const res = {
            statusCode: 200,
            headers: {} as Record<string, string>,
            setHeader(key: string, value: string) {
                this.headers[key] = value;
            },
            end(text?: string) {
                try {
                    resolve({
                        status: (this as unknown as { statusCode: number }).statusCode,
                        body: text ? JSON.parse(text) : null,
                    });
                } catch (cause) {
                    reject(cause);
                }
            },
        };
        handler(req, res);
    });
}

const handler = mountApiHandler();
const SESSION_ID = mockSessions[0]!.id;
const rows = (body: unknown) => (body as { sessions: Array<Record<string, unknown>> }).sessions;

describe("mock 会话夹具被路由消费（task-25 D）", () => {
    it("GET /sessions 回本工作区的会话（不是空集），required 字段齐全", async () => {
        const answer = await call(handler, "/sessions");
        expect(answer.status).toBe(200);
        expect(rows(answer.body)).toEqual(sessionsOfWorkspace(MOCK_SESSION_WORKSPACE_ID));
        expect(rows(answer.body).length).toBeGreaterThanOrEqual(2);
        for (const row of rows(answer.body)) {
            for (const key of ["id", "workspaceId", "title", "archived", "agentPrincipalId"]) {
                expect(row, key).toHaveProperty(key);
            }
        }
    });

    it("GET /sessions?scope=workspaceless 回独立会话（workspaceId 显式 null）", async () => {
        const answer = await call(handler, "/sessions?scope=workspaceless");
        expect(answer.status).toBe(200);
        expect(rows(answer.body)).toEqual(workspacelessSessions());
        expect(rows(answer.body).length).toBeGreaterThanOrEqual(1);
        expect(rows(answer.body)[0]!.workspaceId).toBeNull();
    });

    it("未知 scope 仍 fail-closed 400（夹具不替契约放宽）", async () => {
        const answer = await call(handler, "/sessions?scope=bogus");
        expect(answer.status).toBe(400);
        expect((answer.body as { code: string }).code).toBe("INVALID_REQUEST");
    });

    it("GET /workspaces/{id}/sessions 与 /sessions 同源（工作区地址读面）", async () => {
        const answer = await call(handler, `/workspaces/${MOCK_SESSION_WORKSPACE_ID}/sessions`);
        expect(answer.status).toBe(200);
        expect(rows(answer.body)).toEqual(sessionsOfWorkspace(MOCK_SESSION_WORKSPACE_ID));
    });

    it("GET /sessions/{id} 回单条会话；未知 id 404", async () => {
        const answer = await call(handler, `/sessions/${SESSION_ID}`);
        expect(answer.status).toBe(200);
        expect(answer.body).toEqual(mockSessions[0]);
        expect((await call(handler, "/sessions/nope")).status).toBe(404);
    });

    it("GET /sessions/{id}/messages 是**裸数组**（契约 legacy 全量），且消费了消息夹具", async () => {
        const answer = await call(
            handler,
            `/sessions/${SESSION_ID}/messages?branchId=${mockSessionBranches[SESSION_ID]![0]!.branchId}`,
        );
        expect(answer.status).toBe(200);
        expect(Array.isArray(answer.body)).toBe(true);
        expect(answer.body).toEqual(mockSessionMessages[SESSION_ID]);
    });

    it("消息形状照契约：role 只有 USER/ASSISTANT，attachments 恒在，工具卡 required 齐全", async () => {
        const all = Object.values(mockSessionMessages).flat();
        expect(all.length).toBeGreaterThanOrEqual(12);
        for (const message of all) {
            expect(["USER", "ASSISTANT"]).toContain(message.role);
            expect(Array.isArray(message.attachments)).toBe(true);
            for (const key of ["id", "sessionId", "role", "content", "createdAt"]) {
                expect(message, key).toHaveProperty(key);
            }
            for (const tool of message.toolCalls ?? []) {
                for (const key of ["id", "name", "arguments", "status", "startedAt", "truncated"]) {
                    expect(tool, key).toHaveProperty(key);
                }
            }
        }
        const tools = all.flatMap((message) => message.toolCalls ?? []);
        expect(tools.some((tool) => tool.status === "completed")).toBe(true);
        expect(tools.some((tool) => tool.status === "failed")).toBe(true);
        // 审批待确认态 = pending 工具卡（durable 表示）；不发明 TOOL 角色。
        expect(tools.some((tool) => tool.status === "pending")).toBe(true);
        // 流式中断态：partial + terminalOutcome=partial。
        expect(
            all.some(
                (message) => message.partial === true && message.terminalOutcome === "partial",
            ),
        ).toBe(true);
    });

    it("高风险折行桶样本真的在消息体里（cp-2 task-392 的前提）", async () => {
        const all = Object.values(mockSessionMessages).flat();
        const lines = all.flatMap((message) => message.content.split("\n"));
        // 长代码行 / 长日志行：单行 ≥160 字符。
        expect(lines.filter((line) => line.length >= 160).length).toBeGreaterThanOrEqual(4);
        // 超长不可断 token：行内存在 ≥150 字符的**无空白片段**（URL/hash）。
        // 判据落在片段而不是整行 —— 真实消息里长 URL 常嵌在句子中，整行判据会假红。
        expect(lines.some((line) => line.split(/\s+/).some((token) => token.length >= 150))).toBe(
            true,
        );
        // 长 CJK 行：≥60 个汉字。
        expect(lines.some((line) => (line.match(/[\u4e00-\u9fff]/g) ?? []).length >= 60)).toBe(
            true,
        );
        // 深路径：≥5 层。
        expect(
            lines.some((line) =>
                (line.match(/mock\/main\/[^\s]+/g) ?? []).some((p) => p.split("/").length >= 6),
            ),
        ).toBe(true);
        // 工具入参也是长值样本（code-input 桶）。
        const args = all
            .flatMap((message) => message.toolCalls ?? [])
            .map((tool) => tool.arguments);
        expect(args.some((value) => value.length >= 160)).toBe(true);
    });

    it("四类投影 + 分支都被路由消费，形状照真实 CP 留档", async () => {
        const branches = await call(handler, `/sessions/${SESSION_ID}/branches`);
        expect(branches.status).toBe(200);
        expect(branches.body).toEqual({
            sessionId: SESSION_ID,
            items: mockSessionBranches[SESSION_ID],
        });

        const participants = await call(handler, `/sessions/${SESSION_ID}/participants`);
        expect(participants.status).toBe(200);
        expect((participants.body as { participants: unknown }).participants).toEqual(
            mockSessionParticipants,
        );
        expect(
            (participants.body as { capabilities: Record<string, boolean> }).capabilities,
        ).toEqual({
            view: true,
            manage: true,
            mention: true,
            speakAs: true,
        });

        const derived = await call(handler, `/sessions/${SESSION_ID}/derived-state`);
        expect(derived.body).toEqual({
            sessionId: SESSION_ID,
            activeChildren: [],
            terminalNotices: [],
        });

        const followUps = await call(handler, `/sessions/${SESSION_ID}/follow-ups`);
        expect(followUps.body).toEqual({
            sessionId: SESSION_ID,
            queueState: "empty",
            outstandingCount: 0,
            capacityLimit: 5,
            pauseReason: null,
            items: [],
        });

        const commands = await call(handler, `/sessions/${SESSION_ID}/commands`);
        expect(
            (commands.body as { commands: Array<{ name: string }> }).commands.map((c) => c.name),
        ).toEqual(["/export", "/compact"]);
    });

    it("未知会话子资源仍 404 MOCK_ENDPOINT_MISSING（不做通配 200 掩盖缺口）", async () => {
        const answer = await call(handler, `/sessions/${SESSION_ID}/not-a-face`);
        expect(answer.status).toBe(404);
        expect((answer.body as { code: string }).code).toBe("MOCK_ENDPOINT_MISSING");
    });

    it("每个会话都有消息与分支（不许造了会话没有内容）", async () => {
        for (const session of mockSessions) {
            expect(mockSessionMessages[session.id]?.length ?? 0, session.id).toBeGreaterThanOrEqual(
                4,
            );
            expect(mockSessionBranches[session.id]?.length ?? 0, session.id).toBeGreaterThanOrEqual(
                1,
            );
        }
    });

    it("runs 投影从消息派生，status/origin 落在契约 enum 内（不是消息级词表）", async () => {
        const runsAnswer = await call(handler, `/chat/sessions/${SESSION_ID}/runs?page=0&size=50`);
        expect(runsAnswer.status).toBe(200);
        const body = runsAnswer.body as {
            sessionId: string;
            page: number;
            size: number;
            runs: Array<{
                runId: string;
                origin: string;
                status: string;
                terminalOutcome: string | null;
            }>;
        };
        expect(body.sessionId).toBe(SESSION_ID);
        expect(body.page).toBe(0);
        expect(body.size).toBe(50);
        expect(body.runs).toEqual(mockSessionRuns(SESSION_ID));
        expect(body.runs.length).toBeGreaterThanOrEqual(3);
        const statusEnum = [
            "accepted",
            "queued",
            "running",
            "streaming",
            "awaiting_approval",
            "cancelling",
            "dispatching",
            "succeeded",
            "failed",
            "partial",
            "ambiguous",
            "cancelled",
        ];
        for (const run of body.runs) {
            expect(statusEnum).toContain(run.status);
            expect(["user_submission", "spawn"]).toContain(run.origin);
        }
        // 审批待确认与流式中断两种态都要能在 runs 里看见（不是只有 succeeded）。
        const allRuns = mockSessions.flatMap((session) => mockSessionRuns(session.id));
        expect(allRuns.some((run) => run.status === "awaiting_approval")).toBe(true);
        expect(allRuns.some((run) => run.status === "partial")).toBe(true);
    });

    it("monitor 聚合投影的是**本会话**（不是写死的 test-session），计数从 runs 派生", async () => {
        const answer = await call(handler, `/chat/sessions/${SESSION_ID}/monitor`);
        expect(answer.status).toBe(200);
        // generatedAt 是**请求时刻**（两次调用必然不同）⇒ 归一后再逐字段比，其余字段必须全等。
        const expected = mockSessionMonitor(SESSION_ID);
        const actual = answer.body as typeof expected;
        expect(new Date(actual.generatedAt).toISOString()).toBe(actual.generatedAt);
        expect({ ...actual, generatedAt: expected.generatedAt }).toEqual(expected);
        const body = answer.body as {
            session: { id: string; title: string };
            history: { windowSize: number; counts: Record<string, number> };
            readiness: {
                lastObservedRun: { runId: string; terminalOutcome: string | null } | null;
            };
            transport: { attemptCount: number };
        };
        expect(body.session.id).toBe(SESSION_ID);
        expect(body.session.title).toBe(mockSessions[0]!.title);
        expect(body.history.windowSize).toBe(20);
        expect(
            Object.values(body.history.counts).reduce((a, b) => a + b, 0),
        ).toBeGreaterThanOrEqual(3);
        expect(body.readiness.lastObservedRun?.runId).toBeTruthy();
        expect(body.transport.attemptCount).toBe(0);
    });

    it("policy/mode 回显请求的 sessionId 且 mode 在 enum 内（严格校验面）", async () => {
        const answer = await call(handler, `/policy/mode?sessionId=${SESSION_ID}`);
        expect(answer.status).toBe(200);
        expect(answer.body).toEqual({ sessionId: SESSION_ID, mode: "manual", sessionRules: 0 });
    });

    it("工作区检查点是**裸数组**（api.listWorkspaceCheckpoints 不接受信封）", async () => {
        const answer = await call(handler, `/workspaces/${MOCK_SESSION_WORKSPACE_ID}/checkpoints`);
        expect(answer.status).toBe(200);
        expect(Array.isArray(answer.body)).toBe(true);
        expect(answer.body).toEqual([]);
    });

    it("上下文来源只给 U1 元数据（sourceKey/status/hashPrefix），**永不带正文**", async () => {
        const answer = await call(handler, `/context/${SESSION_ID}/sources`);
        expect(answer.status).toBe(200);
        expect(answer.body).toEqual({
            sourceKey: "AGENTS.md",
            status: "unknown",
            hashPrefix: "",
        });
        // 契约明写 never body：多给一个 content/body/rendered 键就是越界。
        for (const key of ["content", "body", "rendered", "text"]) {
            expect(answer.body).not.toHaveProperty(key);
        }
    });
    // 会话级 SSE（`/events?sessionId=`）不在这里断言：它**永不 end**，本文件的假 res 以 end 为解析时机，
    // 挂上来会把用例吊死。它的判据在浏览器侧（task25-preview-sessions.spec.ts 的失败门禁：
    // 404 会让 fetch-event-source 无限重连并刷 console error）。
});
