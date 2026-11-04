/**
 * PLAN-0658 R2 @host — TO（发送 / speak-as）wire 面矩阵。
 *
 * mock 侧（`e2e/mock/session-matrix-to.spec.ts`，M3）只验**候选面**：候选 = 本人拥有的、未停用
 * 的参与者（selfOwned 且 disabledAt 为空），默认预选 PRIMARY、单选取而代之。它们明确把
 * **wire 面留给 real-lane R2**，也就是本 spec：
 *
 *  1. selfOwned / capabilities.speakAs 在真栈的取值（owner 视角）；
 *  2. 默认发送（不带 as）⇒ run 归属 PRIMARY agent（durable：`chat_runs.agent_principal_id`）；
 *  3. 显式 `asParticipantId` = 工作区 agent ⇒ 202 且 run 归属**该 agent**（D23-08 授权通过）；
 *  4. 越权 as：owner 冒充另一个**人类**参与者 ⇒ 403 `PARTICIPANT_CAP_DENIED`（不是 500、不是静默降级）；
 *  5. 停用主体：AGENT 参与者被 soft-disable 后，名册 `disabledAt` 非空（UI 候选据此过滤），
 *     且 as 它发送 ⇒ 403 `PARTICIPANT_DISABLED`。
 *
 * 断言只认产品权威读面（`GET /sessions/{id}/participants`、`GET /chat/runs/{runId}`）与
 * wire 稳定码；不改产品、不放宽断言。
 *
 * SSE 门：`POST /api/v1/chat` 先校验会话已有活跃订阅（DEV-014），本次窗内保活一条。
 */
import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { CP_URL, getRootBranchId } from "./helpers/journey";
import { ensureWorkspace } from "./helpers/workspace";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";
import { agentName } from "./helpers/agent-name";
import { openSessionSse } from "./helpers/sse";

const NONCE = Date.now().toString(36);
const PASSWORD = process.env.XIHE_E2E_PASSWORD ?? "XhE2e!matrix1";
const FAKE_LLM_PORT = process.env.XIHE_FAKE_LLM_PORT ?? "";
const FAKE_LLM_MODEL = "fake-openai";
const FAKE_LLM_API_KEY = "sk-fake-openai-key";

interface ParticipantView {
    participantId: string;
    principalKind: "HUMAN" | "AGENT";
    principalId: string;
    role: string;
    displayName?: string;
    disabledAt?: string | null;
    selfOwned: boolean;
}

interface ParticipantsResponse {
    participants?: ParticipantView[];
    capabilities?: { view?: boolean; manage?: boolean; mention?: boolean; speakAs?: boolean };
}

interface RunView {
    runId?: string;
    sessionId?: string;
    status?: string;
    triggerSource?: string;
    origin?: string;
    agentPrincipalId?: string | null;
    messageId?: string;
}

let token = "";
let userId = "";
let workspaceId = "";
let sessionId = "";
let rootBranchId = "";
let primaryPrincipalId = "";
let extraPrincipalId = "";
let memberUserId = "";
let memberParticipantId = "";
let extraAgentParticipantId = "";
let ownerHeaders: Record<string, string> = {};
let closeSse: (() => void) | null = null;

test.describe.configure({ mode: "serial", retries: 0 });

async function problemCode(response: APIResponse): Promise<string> {
    try {
        const body = JSON.parse(await response.text()) as { code?: string };
        return body.code ?? "";
    } catch {
        return "";
    }
}

function participantsPath(): string {
    return `${CP_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/participants`;
}

async function participants(request: APIRequestContext): Promise<ParticipantsResponse> {
    const response = await request.get(participantsPath(), { headers: ownerHeaders });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()) as ParticipantsResponse;
}

async function postChat(
    request: APIRequestContext,
    body: Record<string, unknown>,
): Promise<APIResponse> {
    return request.post(`${CP_URL}/api/v1/chat`, {
        headers: ownerHeaders,
        data: { sessionId, branchId: rootBranchId, ...body },
    });
}

async function runView(request: APIRequestContext, runId: string): Promise<RunView> {
    const response = await request.get(`${CP_URL}/api/v1/chat/runs/${runId}`, {
        headers: ownerHeaders,
    });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()) as RunView;
}

test.describe("@host PLAN-0658 R2 TO（发送）wire 面", () => {
    test.beforeAll(async ({ request }) => {
        expect(FAKE_LLM_PORT, "needs XIHE_FAKE_LLM_PORT (runner fake LLM)").not.toBe("");
        // owner 注册 + 工作区
        const email = `r2-owner-${NONCE}-${Math.floor(Math.random() * 10000)}@test.com`;
        const registered = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: { email, password: PASSWORD, name: "r2-owner" },
        });
        expect(registered.status(), await registered.text()).toBe(201);
        const auth = (await registered.json()) as { accessToken: string; user: { id: string } };
        token = auth.accessToken;
        userId = auth.user.id;
        workspaceId = await ensureWorkspace(request, token);
        ownerHeaders = {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Workspace-Id": workspaceId,
        };

        // 另一个人类账户：先注册，再作为 HUMAN 参与者入会话（用来验 selfOwned=false / 越权 as）。
        const memberEmail = `r2-member-${NONCE}-${Math.floor(Math.random() * 10000)}@test.com`;
        const memberReg = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: { email: memberEmail, password: PASSWORD, name: "r2-member" },
        });
        expect(memberReg.status(), await memberReg.text()).toBe(201);
        const memberAuth = (await memberReg.json()) as {
            accessToken: string;
            user: { id: string };
        };
        memberUserId = memberAuth.user.id;
        const memberMe = await request.get(`${CP_URL}/api/v1/auth/me`, {
            headers: { Authorization: `Bearer ${memberAuth.accessToken}` },
        });
        expect(memberMe.status()).toBe(200);
        const memberProfile = (await memberMe.json()) as { username?: string };
        expect(memberProfile.username, "member username").toBeTruthy();
        const added = await request.post(`${CP_URL}/api/v1/workspaces/${workspaceId}/members`, {
            headers: ownerHeaders,
            data: { username: memberProfile.username, role: "EDITOR" },
        });
        expect(added.status(), await added.text()).toBe(201);

        // fake provider 连接（会话默认绑定解析 + 真跑 run 都需要）。
        const connection = await request.post(`${CP_URL}/api/v1/provider-connections`, {
            headers: ownerHeaders,
            data: {
                providerId: "openai",
                apiTypeId: "openai-chat-completions",
                apiTypeVersion: 1,
                apiKey: FAKE_LLM_API_KEY,
                connectionKey: `r2-${NONCE}`,
                label: `R2 fake LLM (${NONCE})`,
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
            { headers: ownerHeaders },
        );
        expect(verified.ok(), await verified.text()).toBe(true);

        // 两个工作区 agent 主体：PRIMARY（会话绑定）+ 一个 MEMBER 参与者（用于 as / 停用）。
        primaryPrincipalId = await provisionWorkspaceAgentPrincipal(
            request,
            { accessToken: token, workspaceId },
            {
                name: agentName("R2Primary", NONCE),
                actions: [],
                defaultModelProvider: "openai",
                defaultModelName: FAKE_LLM_MODEL,
            },
        );
        extraPrincipalId = await provisionWorkspaceAgentPrincipal(
            request,
            { accessToken: token, workspaceId },
            {
                name: agentName("R2Extra", NONCE),
                actions: [],
                defaultModelProvider: "openai",
                defaultModelName: FAKE_LLM_MODEL,
            },
        );
        sessionId = await createSessionWithPrincipal(
            request,
            { accessToken: token, workspaceId },
            { principalId: primaryPrincipalId, title: `r2-to-${NONCE}`, workspaceId },
        );
        rootBranchId = await getRootBranchId(request, sessionId, ownerHeaders);

        // HUMAN 参与者（他人）
        const humanParticipant = await request.post(participantsPath(), {
            headers: ownerHeaders,
            data: {
                principalKind: "HUMAN",
                principalId: memberUserId,
                role: "MEMBER",
                wakePolicy: "MENTION",
                respondPolicy: "WHEN_MENTIONED",
            },
        });
        expect(humanParticipant.status(), await humanParticipant.text()).toBe(201);
        memberParticipantId = ((await humanParticipant.json()) as { participantId: string })
            .participantId;

        // AGENT 参与者（MEMBER 角色，可被 owner 以 as 发送）
        const agentParticipant = await request.post(participantsPath(), {
            headers: ownerHeaders,
            data: { principalKind: "AGENT", principalId: extraPrincipalId, role: "MEMBER" },
        });
        expect(agentParticipant.status(), await agentParticipant.text()).toBe(201);
        extraAgentParticipantId = ((await agentParticipant.json()) as { participantId: string })
            .participantId;

        closeSse = await openSessionSse(sessionId, token, { "X-Workspace-Id": workspaceId });
    });

    test.afterAll(() => {
        closeSse?.();
        closeSse = null;
    });

    test("R2-1 selfOwned / speakAs：自有 agent 可发送，他人人类行不可", async ({ request }) => {
        const roster = await participants(request);
        const rows = roster.participants ?? [];
        // 会话由 agent 绑定时 PRIMARY 就是那个 agent —— owner 本人**不是**参与者行
        // （D23-27 的 HUMAN 分支是"principalId = 调用者"，只有被显式加进会话时才成立）。
        expect(
            rows.some((row) => row.principalKind === "HUMAN" && row.principalId === userId),
            "owner 未被加成 HUMAN 参与者",
        ).toBe(false);
        const primaryAgent = rows.find(
            (row) => row.principalKind === "AGENT" && row.principalId === primaryPrincipalId,
        );
        const extraAgent = rows.find(
            (row) => row.principalKind === "AGENT" && row.principalId === extraPrincipalId,
        );
        const otherHuman = rows.find(
            (row) => row.principalKind === "HUMAN" && row.principalId === memberUserId,
        );

        expect(primaryAgent, "会话 PRIMARY agent 行").toBeTruthy();
        expect(primaryAgent!.selfOwned, "PRIMARY agent selfOwned=true").toBe(true);
        expect(extraAgent, "额外工作区 agent 参与者行").toBeTruthy();
        expect(extraAgent!.selfOwned, "工作区 agent selfOwned=true（会话 owner 可代其发言）").toBe(
            true,
        );
        expect(otherHuman, "另一人类参与者行").toBeTruthy();
        expect(otherHuman!.selfOwned, "他人人类行 selfOwned=false（不可代发言）").toBe(false);
        expect(roster.capabilities?.speakAs, "capabilities.speakAs").toBe(true);
        // 停用态由 R2-5 断言（此时间点全员可用）。
        expect(
            rows.every((row) => !row.disabledAt),
            "名册此时无停用主体",
        ).toBe(true);
    });

    // 归属判据说明：`POST /chat` 的 202 体是 `ChatRunResponse`（同一事务写下的 `chat_runs`
    // 行），**带 `agentPrincipalId`**；而状态读面 `GET /chat/runs/{runId}` 是
    // `ChatRunStatusResponse`（不含该字段），`GET /sessions/{id}/runs` 的 `SessionRunSummary`
    // 也缺它（BL-197 ①/②）。所以"谁代表这一轮说话"以 202 体为 wire 判据，再用状态读面确认
    // 这轮真的跑起来并落到终态。
    const TERMINAL = new Set(["succeeded", "failed", "partial", "ambiguous", "cancelled"]);

    test("R2-2 默认发送：run 归属 PRIMARY agent", async ({ request }) => {
        const sent = await postChat(request, { content: `R2 default ${NONCE}` });
        expect(sent.status(), await sent.text()).toBe(202);
        const accepted = (await sent.json()) as RunView;
        expect(accepted.runId, "runId").toBeTruthy();
        expect(accepted.agentPrincipalId, "默认应答身份 = 会话 PRIMARY agent").toBe(
            primaryPrincipalId,
        );
        expect(accepted.origin ?? "user_submission").toBe("user_submission");

        await expect
            .poll(
                async () => {
                    const view = await runView(request, accepted.runId!);
                    return TERMINAL.has(String(view.status ?? ""));
                },
                { timeout: 60_000, intervals: [500, 1_000] },
            )
            .toBe(true);
    });

    test("R2-3 显式 as=工作区 agent：run 归属该 agent", async ({ request }) => {
        const sent = await postChat(request, {
            content: `R2 as-agent ${NONCE}`,
            asParticipantId: extraAgentParticipantId,
        });
        expect(sent.status(), await sent.text()).toBe(202);
        const accepted = (await sent.json()) as RunView;
        expect(accepted.runId, "runId").toBeTruthy();
        expect(accepted.agentPrincipalId, "as= 指定身份成为应答归属").toBe(extraPrincipalId);

        await expect
            .poll(
                async () => {
                    const view = await runView(request, accepted.runId!);
                    return TERMINAL.has(String(view.status ?? ""));
                },
                { timeout: 60_000, intervals: [500, 1_000] },
            )
            .toBe(true);
    });

    test("R2-4 越权 as：owner 不能以他人人类参与者身份发言", async ({ request }) => {
        const denied = await postChat(request, {
            content: `R2 impersonate ${NONCE}`,
            asParticipantId: memberParticipantId,
        });
        expect(denied.status(), "impersonation must be refused").toBe(403);
        expect(await problemCode(denied), "稳定错误码").toBe("PARTICIPANT_CAP_DENIED");
    });

    test("R2-5 停用主体：名册 disabledAt 非空且 as 它被拒", async ({ request }) => {
        const disabled = await request.patch(
            `${participantsPath()}/${encodeURIComponent(extraAgentParticipantId)}`,
            { headers: ownerHeaders, data: { disabled: true } },
        );
        expect(disabled.status(), await disabled.text()).toBe(200);

        const roster = await participants(request);
        const disabledRow = (roster.participants ?? []).find(
            (row) => row.participantId === extraAgentParticipantId,
        );
        expect(disabledRow, "停用行仍在名册里（软停用保留审计）").toBeTruthy();
        expect(disabledRow!.disabledAt, "disabledAt 非空 ⇒ UI 候选过滤依据").toBeTruthy();

        const sent = await postChat(request, {
            content: `R2 as-disabled ${NONCE}`,
            asParticipantId: extraAgentParticipantId,
        });
        expect(sent.status(), "无法以停用主体发送").toBe(403);
        expect(await problemCode(sent)).toBe("PARTICIPANT_DISABLED");
    });
});
