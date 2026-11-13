/**
 * task-25 D（收窄重开，`D-1175`）：mock 车道的**会话与消息**夹具。
 *
 * <p>为什么必须有：此前 `GET /sessions` 硬回 `{sessions:[]}`（api-server 的「合法空集」口径），
 * 于是聊天面在预览/mock 车道**永远没有消息体与工具卡挂载** —— cp-2 `task-392` 的折行取证因此
 * 只能测到「短值 + 已渲染」的 16 行子集（`D-1146` 上界），真正会折行的高风险桶
 * （code / code-input / log-or-code / path）与 24 行聊天面一行都没测到。这里给出**长值样本**
 * （长代码行、长日志行、深路径、长 CJK 行、超长不可断 token）让那些桶真的渲染出来。</p>
 *
 * <p>形状来源（**不发明字段**）：`docs/api/openapi.yaml` 的 `Session`（required:
 * id / workspaceId / title / archived / agentPrincipalId）与 `SessionMessage`（required:
 * id / sessionId / role / content / createdAt / attachments；`toolCalls` 项 required:
 * id / name / arguments / status / startedAt / truncated）。投影形状照 `e2e/mock/helpers/session-projections.ts`
 * 里 2026-11-05 对真实 CP 的逐条留档。</p>
 *
 * <p>两条契约纪律：① `role` 的 enum 只有 **USER / ASSISTANT**，没有 TOOL 角色 —— 工具卡是
 * assistant 消息上的 `toolCalls`，造一个 TOOL 角色就是发明契约；② `toolCalls[].result` 是
 * **CP 消毒后的占位文本**（原始工具输出永不持久化），所以这里写占位而不是编造原始输出。</p>
 *
 * <p>独立会话（task-373 / `D-1228`）：`workspaceId` 是**显式 null**，不是缺字段。</p>
 */

/** 与 api-server 的 `MOCK_WORKSPACE.id` 同一个工作区（不是第二套 id）。 */
export const MOCK_SESSION_WORKSPACE_ID = "mock-ws-main";
/** 与 `data/agentSkillBindings.ts` 的种子主体同一个 principal（夹具之间不各造一个身份）。 */
export const MOCK_SESSION_PRINCIPAL_ID = "b1f0c4d2-7b3e-4c55-8f10-5d2c9b000001";
const SELF_USER_ID = "mock-user";
const T0 = "2026-11-13T09:00:00.000Z";

export interface MockSessionRow {
    id: string;
    workspaceId: string | null;
    title: string;
    archived: boolean;
    agentPrincipalId: string | null;
    createdAt: string;
    updatedAt: string;
    modelProvider: string | null;
    modelName: string | null;
    providerConnectionId: string | null;
    connectionRevision: number | null;
}

export interface MockToolCallRow {
    id: string;
    name: string;
    arguments: string;
    status: "running" | "completed" | "failed" | "pending" | "cancelled";
    startedAt: string;
    completedAt?: string;
    result?: string;
    truncated: boolean;
    refusalCode?: string;
}

export interface MockSessionMessageRow {
    id: string;
    sessionId: string;
    role: "USER" | "ASSISTANT";
    content: string;
    createdAt: string;
    /** 契约 required（不是可选）：没有附件就是空数组。 */
    attachments: Array<{ fileId: string; name: string; type: string; size: number }>;
    participantId?: string;
    runId?: string;
    runStatus?: string;
    terminalOutcome?: string;
    errorCode?: string;
    errorDetail?: string;
    partial?: boolean;
    reasoning?: string;
    toolCalls?: MockToolCallRow[];
}

const DEEP_JAVA_PATH =
    "mock/main/packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/chat/service/AgentPrincipalSkillBindingService.java";
const DEEP_TS_PATH =
    "mock/main/packages/ui/src/features/workspace/chat/components/message/MessageToolCallCard.vue";
const DEEP_LOG_PATH =
    "mock/main/.xihe-stacks/stack-1/logs/control-plane-2026-11-13T09-14-22.481Z-ingestion-pipeline.log";

/** 长日志行（log-or-code 桶）：时间戳 + 级别 + logger + 长消息，单行 200+ 字符。 */
const LONG_LOG = [
    "2026-11-13T09:14:22.481Z ERROR 18422 --- [xihe-cp] [nio-12631-exec-7] c.c.p.x.c.chat.service.IngestionPipelineService : Failed to persist chunk batch for sessionId=c1f0c4d2-7b3e-4c55-8f10-5d2c9b000101 runId=e1f0c4d2-7b3e-4c55-8f10-5d2c9b000301 after 3 attempts; rolling back transaction and marking the Run partial",
    "2026-11-13T09:14:22.483Z  WARN 18422 --- [xihe-cp] [nio-12631-exec-7] c.c.p.x.cp.chat.store.DurableMessageStore : appendMessage rejected: context_events.sequence gap detected (expected=4182, actual=4185) for participantId=d1f0c4d2-7b3e-4c55-8f10-5d2c9b000402",
    '2026-11-13T09:14:22.490Z ERROR 18422 --- [xihe-cp] [nio-12631-exec-7] o.h.engine.jdbc.spi.SqlExceptionHelper : ERROR: duplicate key value violates unique constraint "uk_context_events_session_sequence" Detail: Key (session_id, sequence)=(c1f0c4d2-7b3e-4c55-8f10-5d2c9b000101, 4185) already exists.',
    "2026-11-13T09:14:22.512Z  INFO 18422 --- [xihe-cp] [nio-12631-exec-7] c.c.p.x.c.chat.service.ChatRunService : Run e1f0c4d2-7b3e-4c55-8f10-5d2c9b000301 transitioned RUNNING -> PARTIAL (terminalOutcome=partial, retryable=true); notifying 2 subscribers over SSE",
].join("\n");

/** 长代码行（code 桶）：单行 180+ 字符的 TypeScript。 */
const LONG_CODE = [
    "export async function persistChunkBatch(sessionId: string, runId: string, chunks: ReadonlyArray<IngestionChunk>, options: PersistOptions = {}): Promise<PersistOutcome> {",
    "    const outcome = await durableMessageStore.appendWithinTransaction(sessionId, runId, chunks.map((chunk) => ({ sequence: chunk.sequence, payload: chunk.payload, participantId: options.participantId ?? PRIMARY_PARTICIPANT })), { retry: options.retry ?? 3, backoffMs: options.backoffMs ?? 250 });",
    '    if (outcome.kind === "sequence-gap") return { kind: "partial", retryable: true, detail: outcome.detail };',
    '    return { kind: "committed", written: outcome.written, lastSequence: outcome.lastSequence };',
    "}",
].join("\n");

/** 超长不可断 token（path/URL 桶）：没有空格，必须靠容器折行。 */
const UNBREAKABLE =
    "https://xihe.internal.example.com/workspaces/mock-ws-main/sessions/c1f0c4d2-7b3e-4c55-8f10-5d2c9b000101/runs/e1f0c4d2-7b3e-4c55-8f10-5d2c9b000301/events?branchId=d1f0c4d2-7b3e-4c55-8f10-5d2c9b000201&sinceSequence=4182&includeToolCalls=true&format=jsonl";

const LONG_CJK =
    "这一批改动把持久化路径从事务外挪进了事务内，因此序号缺口不会再被当成成功写入；但回滚之后运行态仍然停在部分完成，前端需要把这条消息渲染成中断态而不是失败态，否则用户会以为整轮对话都丢了，实际上前面已经落库的消息仍然可见，只是最后一段没有写完。";

function message(
    sessionId: string,
    index: number,
    role: "USER" | "ASSISTANT",
    content: string,
    extra: Partial<MockSessionMessageRow> = {},
): MockSessionMessageRow {
    return {
        id: `f1f0c4d2-7b3e-4c55-8f10-5d2c9b0${String(index).padStart(5, "0")}`,
        sessionId,
        role,
        content,
        createdAt: `2026-11-13T09:${String(10 + index).padStart(2, "0")}:00.000Z`,
        attachments: [],
        participantId:
            role === "USER"
                ? "d1f0c4d2-7b3e-4c55-8f10-5d2c9b000401"
                : "d1f0c4d2-7b3e-4c55-8f10-5d2c9b000402",
        ...extra,
    };
}

const S1 = "c1f0c4d2-7b3e-4c55-8f10-5d2c9b000101";
const S2 = "c1f0c4d2-7b3e-4c55-8f10-5d2c9b000102";
const S3 = "c1f0c4d2-7b3e-4c55-8f10-5d2c9b000103";

export const mockSessions: MockSessionRow[] = [
    {
        id: S1,
        workspaceId: MOCK_SESSION_WORKSPACE_ID,
        title: "流水线失败日志排查",
        archived: false,
        agentPrincipalId: MOCK_SESSION_PRINCIPAL_ID,
        createdAt: T0,
        updatedAt: "2026-11-13T09:16:00.000Z",
        modelProvider: "anthropic",
        modelName: "claude-sonnet-4-5",
        providerConnectionId: "conn-mock-default",
        connectionRevision: 1,
    },
    {
        id: S2,
        workspaceId: MOCK_SESSION_WORKSPACE_ID,
        title: "Refactor the ingestion pipeline",
        archived: false,
        agentPrincipalId: MOCK_SESSION_PRINCIPAL_ID,
        createdAt: "2026-11-13T08:20:00.000Z",
        updatedAt: "2026-11-13T08:41:00.000Z",
        modelProvider: "anthropic",
        modelName: "claude-sonnet-4-5",
        providerConnectionId: "conn-mock-default",
        connectionRevision: 1,
    },
    {
        // 独立会话：workspaceId 显式 null（task-373 / D-1228），不是缺字段。
        id: S3,
        workspaceId: null,
        title: "独立会话：契约核对",
        archived: false,
        agentPrincipalId: MOCK_SESSION_PRINCIPAL_ID,
        createdAt: "2026-11-13T07:05:00.000Z",
        updatedAt: "2026-11-13T07:12:00.000Z",
        modelProvider: null,
        modelName: null,
        providerConnectionId: null,
        connectionRevision: null,
    },
];

export const mockSessionMessages: Record<string, MockSessionMessageRow[]> = {
    [S1]: [
        message(
            S1,
            1,
            "USER",
            `帮我看这条流水线为什么失败，日志在 \`${DEEP_LOG_PATH}\`，服务实现是 \`${DEEP_JAVA_PATH}\`。`,
        ),
        message(
            S1,
            2,
            "ASSISTANT",
            `日志里三条关键行如下（完整文件 \`${DEEP_LOG_PATH}\`）：\n\n\`\`\`log\n${LONG_LOG}\n\`\`\`\n\n结论：序号缺口导致整批回滚，运行态停在 partial。`,
            {
                runId: "e1f0c4d2-7b3e-4c55-8f10-5d2c9b000301",
                runStatus: "success",
                terminalOutcome: "success",
                reasoning:
                    "先定位唯一约束冲突，再判断是并发写还是重试放大；日志里 sequence gap 与 duplicate key 同时出现，指向重试没有幂等保护。",
            },
        ),
        message(S1, 3, "USER", LONG_CJK),
        message(
            S1,
            4,
            "ASSISTANT",
            `把写入挪进事务并显式处理序号缺口，\`${DEEP_TS_PATH}\` 侧不用改：\n\n\`\`\`ts\n${LONG_CODE}\n\`\`\``,
            {
                runId: "e1f0c4d2-7b3e-4c55-8f10-5d2c9b000302",
                runStatus: "success",
                terminalOutcome: "success",
            },
        ),
        message(
            S1,
            5,
            "ASSISTANT",
            "我读了实现并试跑了一次构建，结果如下（工具输出按 CP 消毒口径只留占位摘要）。",
            {
                runId: "e1f0c4d2-7b3e-4c55-8f10-5d2c9b000303",
                runStatus: "success",
                terminalOutcome: "success",
                toolCalls: [
                    {
                        id: "tool-call-0001",
                        name: "read_file",
                        arguments: JSON.stringify({
                            path: DEEP_JAVA_PATH,
                            rootId: "mock-root-main",
                        }),
                        status: "completed",
                        startedAt: "2026-11-13T09:14:00.000Z",
                        completedAt: "2026-11-13T09:14:01.000Z",
                        result: "[CP 消毒占位] 工具输出不持久化；此处仅保留摘要（read_file 成功，读取 1 个文件）。",
                        truncated: false,
                    },
                    {
                        id: "tool-call-0002",
                        name: "run_command",
                        arguments: JSON.stringify({
                            command:
                                "mvn -q -pl packages/control-plane test -Dtest=IngestionPipelineServiceTest",
                            cwd: DEEP_LOG_PATH,
                        }),
                        status: "failed",
                        startedAt: "2026-11-13T09:14:30.000Z",
                        completedAt: "2026-11-13T09:15:10.000Z",
                        result: "[CP 消毒占位] 命令失败摘要：1 个测试失败（序号缺口用例）。",
                        truncated: false,
                    },
                ],
            },
        ),
        message(
            S1,
            6,
            "ASSISTANT",
            "接着我把重试改成幂等：以 (sessionId, sequence) 作为唯一键做 upsert，而不是先查后写。这样即使",
            {
                runId: "e1f0c4d2-7b3e-4c55-8f10-5d2c9b000304",
                runStatus: "partial",
                terminalOutcome: "partial",
                partial: true,
                errorCode: "STREAM_INTERRUPTED",
                errorDetail: "流式输出在中途断开（客户端取消或连接中断），已落库部分保留。",
            },
        ),
    ],
    [S2]: [
        message(
            S2,
            11,
            "USER",
            `Please refactor the ingestion pipeline so that chunk persistence is idempotent. The relevant sources are \`${DEEP_JAVA_PATH}\` and the durable store under mock/main/packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/chat/store/DurableMessageStore.java.`,
        ),
        message(
            S2,
            12,
            "ASSISTANT",
            "I need to write the refactored file. Waiting for your approval before touching the workspace.",
            {
                runId: "e1f0c4d2-7b3e-4c55-8f10-5d2c9b000311",
                runStatus: "running",
                toolCalls: [
                    {
                        id: "tool-call-0011",
                        name: "write_file",
                        // 长入参（code-input 桶）：单行 JSON，含深路径与长内容。
                        arguments: JSON.stringify({
                            path: DEEP_JAVA_PATH,
                            rootId: "mock-root-main",
                            content: LONG_CODE,
                            createParents: true,
                            overwriteStrategy: "replace-if-hash-matches",
                            expectedContentHash:
                                "9f2c41d7a6b8e05c3f1d2a9b7c4e6081d3f5a7b9c1e3052749618badcfe01234",
                        }),
                        status: "pending",
                        startedAt: "2026-11-13T08:31:00.000Z",
                        truncated: false,
                    },
                ],
            },
        ),
        message(S2, 13, "USER", "Approved, go ahead."),
        message(
            S2,
            14,
            "ASSISTANT",
            `Done. The event stream for this run is available at ${UNBREAKABLE} and the changed card renderer lives at \`${DEEP_TS_PATH}\`.`,
            {
                runId: "e1f0c4d2-7b3e-4c55-8f10-5d2c9b000312",
                runStatus: "success",
                terminalOutcome: "success",
            },
        ),
        message(
            S2,
            15,
            "ASSISTANT",
            `Verification summary (single long line, no break opportunities): ${UNBREAKABLE}&repeat=${UNBREAKABLE}`,
            {
                runId: "e1f0c4d2-7b3e-4c55-8f10-5d2c9b000313",
                runStatus: "success",
                terminalOutcome: "success",
            },
        ),
    ],
    [S3]: [
        message(S3, 21, "USER", "独立会话里核对一下：实例智能体的技能绑定到底带不带 workspaceId？"),
        message(
            S3,
            22,
            "ASSISTANT",
            `不带。实例档走 \`/agent-principals/{id}/skills\`，查询串里没有 workspaceId；工作区档才带。契约见 docs/api/openapi.yaml 的 AgentPrincipalSkillBindingView，实现见 \`${DEEP_JAVA_PATH}\`。`,
            { runStatus: "success", terminalOutcome: "success" },
        ),
        message(S3, 23, "USER", "那读面有没有 description 字段？"),
        message(
            S3,
            24,
            "ASSISTANT",
            `没有。AgentPrincipalView 的 properties 里没有 description，所以实例智能体列表与详情都不该渲染说明；创建面也不收它（多带一键就是 400 INVALID_REQUEST）。${LONG_CJK}`,
            { runStatus: "success", terminalOutcome: "success" },
        ),
    ],
};

/** 每个会话一条根分支（形状照真实 CP：`{sessionId, items}` 由路由组装）。 */
export const mockSessionBranches: Record<
    string,
    Array<{
        branchId: string;
        parentBranchId: string | null;
        forkPointMessageId: string | null;
        forkPointRunId: string | null;
        createdAt: string;
    }>
> = {
    [S1]: [
        {
            branchId: "d1f0c4d2-7b3e-4c55-8f10-5d2c9b000201",
            parentBranchId: null,
            forkPointMessageId: null,
            forkPointRunId: null,
            createdAt: T0,
        },
    ],
    [S2]: [
        {
            branchId: "d1f0c4d2-7b3e-4c55-8f10-5d2c9b000202",
            parentBranchId: null,
            forkPointMessageId: null,
            forkPointRunId: null,
            createdAt: "2026-11-13T08:20:00.000Z",
        },
    ],
    [S3]: [
        {
            branchId: "d1f0c4d2-7b3e-4c55-8f10-5d2c9b000203",
            parentBranchId: null,
            forkPointMessageId: null,
            forkPointRunId: null,
            createdAt: "2026-11-13T07:05:00.000Z",
        },
    ],
};

/**
 * 花名册：人类账户（自己）+ 绑定的 agent 主体。字段照 `session-projections.ts` 的真实 CP 留档
 * （含 TS 类型未声明但 CP 确实返回的 source / wakeConfig / createdAt）。
 */
export const mockSessionParticipants = [
    {
        participantId: "d1f0c4d2-7b3e-4c55-8f10-5d2c9b000401",
        principalKind: "HUMAN",
        principalId: SELF_USER_ID,
        role: "MEMBER",
        orderIndex: 1,
        wakePolicy: "ALL_MESSAGES",
        respondPolicy: "ALWAYS",
        createdAt: T0,
        disabledAt: null,
        displayName: "Mock 用户",
        defaultModelProvider: null,
        defaultModelName: null,
        source: null,
        selfOwned: true,
        wakeConfig: null,
        readCursor: { lastReadEventSeq: 0, mentionCount: 0, updatedAt: T0 },
    },
    {
        participantId: "d1f0c4d2-7b3e-4c55-8f10-5d2c9b000402",
        principalKind: "AGENT",
        principalId: MOCK_SESSION_PRINCIPAL_ID,
        role: "PRIMARY",
        orderIndex: 10,
        wakePolicy: "ALL_MESSAGES",
        respondPolicy: "ALWAYS",
        createdAt: T0,
        disabledAt: null,
        displayName: "代码评审助手",
        defaultModelProvider: "anthropic",
        defaultModelName: "claude-sonnet-4-5",
        source: "workspace",
        selfOwned: true,
        wakeConfig: null,
        readCursor: { lastReadEventSeq: 0, mentionCount: 0, updatedAt: T0 },
    },
];

/** 按工作区取会话（`GET /workspaces/{id}/sessions`）；独立会话只从 `scope=workspaceless` 出。 */
export function sessionsOfWorkspace(workspaceId: string): MockSessionRow[] {
    return mockSessions.filter((session) => session.workspaceId === workspaceId);
}

export function workspacelessSessions(): MockSessionRow[] {
    return mockSessions.filter((session) => session.workspaceId === null);
}

/** ChatRun 投影行（契约 `SessionRunSummary`，required: runId / sessionId / origin / status）。 */
export interface MockSessionRunRow {
    runId: string;
    sessionId: string;
    origin: "user_submission" | "spawn";
    status: string;
    terminalOutcome: string | null;
    errorCode: string | null;
    createdAt: string | null;
    terminalAt: string | null;
    waitingOnRunId: string | null;
    waitingToolCallId: string | null;
}

/**
 * 消息级 `runStatus` 与 ChatRun 的 `status` **不是同一套词表**，所以这里显式映射一次：
 * - 消息级（`SessionMessage.runStatus`，契约是自由 string）：UI 的 `runStateView` 认
 *   success / partial / cancelled / error / ambiguous；
 * - ChatRun（`SessionRunSummary.status`，契约 **enum**）：accepted / queued / running / streaming /
 *   awaiting_approval / cancelling / dispatching / succeeded / failed / partial / ambiguous / cancelled。
 * 把消息级的 "success" 直接塞进 runs 会是契约外的值 —— 那种「看起来绿」正是要避免的。
 */
const RUN_STATUS_OF_MESSAGE: Record<string, string> = {
    success: "succeeded",
    error: "failed",
    partial: "partial",
    cancelled: "cancelled",
    ambiguous: "ambiguous",
    running: "running",
};

/** 从消息夹具投影出 runs（不是另造一份互相对不上的 run 列表）。 */
export function mockSessionRuns(sessionId: string): MockSessionRunRow[] {
    const seen = new Set<string>();
    const rows: MockSessionRunRow[] = [];
    for (const message of mockSessionMessages[sessionId] ?? []) {
        const runId = message.runId;
        if (!runId || seen.has(runId)) continue;
        seen.add(runId);
        const tools = message.toolCalls ?? [];
        // 有 pending 工具卡 ⇒ 这一轮停在审批待确认（契约 enum 的 awaiting_approval）。
        const status = tools.some((tool) => tool.status === "pending")
            ? "awaiting_approval"
            : (RUN_STATUS_OF_MESSAGE[message.runStatus ?? ""] ?? "succeeded");
        const terminal = status !== "awaiting_approval" && status !== "running";
        rows.push({
            runId,
            sessionId,
            origin: "user_submission",
            status,
            terminalOutcome: message.terminalOutcome ?? null,
            errorCode: message.errorCode ?? null,
            createdAt: message.createdAt,
            terminalAt: terminal ? message.createdAt : null,
            waitingOnRunId: null,
            waitingToolCallId: null,
        });
    }
    return rows;
}

/**
 * 会话监控聚合（契约 `SessionMonitorResponse`；形状照 `e2e/mock/helpers/auth.ts:140` 对真实 CP 的留档）。
 * 静态预览没有活的传输尝试 ⇒ activity / recent / transport 计数给 0，但 **session 与 lastObservedRun
 * 从夹具投影**，不写死 "test-session"（那会让监控面板显示另一个会话）。
 */
export function mockSessionMonitor(sessionId: string) {
    const session = mockSessions.find((item) => item.id === sessionId);
    const runs = mockSessionRuns(sessionId);
    const counts: Record<string, number> = {};
    for (const run of runs) {
        if (run.terminalOutcome)
            counts[run.terminalOutcome] = (counts[run.terminalOutcome] ?? 0) + 1;
    }
    const lastTerminal = [...runs].reverse().find((run) => run.terminalAt !== null) ?? null;
    return {
        generatedAt: new Date().toISOString(),
        session: {
            id: session?.id ?? sessionId,
            title: session?.title ?? "",
            agentPrincipalId: session?.agentPrincipalId ?? null,
            modelProvider: session?.modelProvider ?? null,
            modelName: session?.modelName ?? null,
            providerConnectionId: session?.providerConnectionId ?? null,
            connectionRevision: session?.connectionRevision ?? null,
            createdAt: session?.createdAt ?? new Date().toISOString(),
            updatedAt: session?.updatedAt ?? new Date().toISOString(),
        },
        activity: [],
        history: { windowSize: 20, counts, recent: [] },
        readiness: {
            connection: null,
            agent: {
                status: "unknown",
                llmReady: "unknown",
                verifiedAt: null,
                configRevision: "0",
            },
            lastObservedRun: lastTerminal
                ? {
                      runId: lastTerminal.runId,
                      terminalOutcome: lastTerminal.terminalOutcome,
                      errorCode: lastTerminal.errorCode,
                      terminalAt: lastTerminal.terminalAt,
                  }
                : null,
        },
        transport: { attemptCount: 0, failedCount: 0, partialCount: 0 },
    };
}
