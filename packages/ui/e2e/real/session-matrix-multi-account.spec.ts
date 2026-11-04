/**
 * PLAN-0658 R1 @host — 多人类账户矩阵（**从未真栈验过**的最高价值场景）。
 *
 * 覆盖：
 *  1. 双账户互见：A 发消息 → B 通过 API 与 UI 都能看到（wire + durable + UI 三段）；
 *  2. @ 对方：A @B 发送 → B 的参与者读游标 mentionCount ≥ 1（durable 投递）；
 *  3. 抄送对方：A 带 cc=[B] 发送 → 202 且 B 可见（旁听，不额外起 run）；
 *  4. 未参与者不可见：C（同实例、不同工作区）读会话/消息/参与者全部被拒。
 *
 * 硬约束（xh-host-e2e-pitfalls）：serial + retries 0；无固定 sleep；断言只认
 * 用户可感知结果与产品权威读面（messages/participants API），不做 in-page 绕过。
 */
import { expect, test, type APIRequestContext } from "@playwright/test";
import { CP_URL, getRootBranchId } from "./helpers/journey";
import { ensureWorkspace } from "./helpers/workspace";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";
import { workspaceChatPath } from "../../src/lib/routes";

const NONCE = Date.now().toString(36);
const PASSWORD = process.env.XIHE_E2E_PASSWORD ?? "XhE2e!matrix1";
const FAKE_LLM_PORT = process.env.XIHE_FAKE_LLM_PORT ?? "";
const FAKE_LLM_MODEL = "fake-openai";
const FAKE_LLM_API_KEY = "sk-fake-openai-key";

interface Account {
    token: string;
    userId: string;
    username: string;
    workspaceId: string;
    headers: Record<string, string>;
}

let owner: Account;
let member: Account;
let outsider: Account;
let sessionId = "";
let principalId = "";
let rootBranchId = "";
let memberParticipantId = "";

test.describe.configure({ mode: "serial", retries: 0 });

async function registerAccount(
    request: APIRequestContext,
    label: string,
): Promise<Account> {
    const email = `${label}-${NONCE}-${Math.floor(Math.random() * 10000)}@test.com`;
    const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: { email, password: PASSWORD, name: label },
    });
    expect(response.status(), `register ${label}: ${await response.text()}`).toBe(201);
    const auth = (await response.json()) as {
        accessToken: string;
        user: { id: string; username?: string };
    };
    const workspaceId = await ensureWorkspace(request, auth.accessToken);
    const username = auth.user.username ?? email.split("@")[0]!.replace(/[^a-z0-9]/g, "");
    return {
        token: auth.accessToken,
        userId: auth.user.id,
        username,
        workspaceId,
        headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            "Content-Type": "application/json",
            "X-Workspace-Id": workspaceId,
        },
    };
}

/** 以某账户身份访问 owner 的 workspace（跨工作区成员需要显式上下文头）。 */
function inWorkspace(account: Account, workspaceId: string): Record<string, string> {
    return {
        Authorization: `Bearer ${account.token}`,
        "Content-Type": "application/json",
        "X-Workspace-Id": workspaceId,
    };
}

test.describe("@host PLAN-0658 R1 多人类账户", () => {
    test.beforeAll(async ({ request }) => {
        expect(FAKE_LLM_PORT, "needs XIHE_FAKE_LLM_PORT (runner fake LLM)").not.toBe("");
        owner = await registerAccount(request, "r1-owner");
        member = await registerAccount(request, "r1-member");
        outsider = await registerAccount(request, "r1-outsider");

        // 成员加入 owner 的工作区（MEMBER 角色）。
        const add = await request.post(
            `${CP_URL}/api/v1/workspaces/${owner.workspaceId}/members`,
            {
                headers: owner.headers,
                data: { username: member.username, role: "EDITOR" }, // PLAN-0565: 规范角色 OWNER/EDITOR/VIEWER（legacy MEMBER 已废）
            },
        );
        expect(add.status(), `add member: ${add.status()} ${await add.text()}`).toBe(201);

        // owner 的 fake provider 连接（会话创建解析用；T1.1 同款配方）。
        const created = await request.post(`${CP_URL}/api/v1/provider-connections`, {
            headers: owner.headers,
            data: {
                providerId: "openai",
                apiTypeId: "openai-chat-completions",
                apiTypeVersion: 1,
                apiKey: FAKE_LLM_API_KEY,
                connectionKey: `r1-${NONCE}`,
                label: `R1 fake LLM (${NONCE})`,
                scope: "USER",
                modelDiscovery: "manual",
                manualModels: [FAKE_LLM_MODEL],
                baseUrl: `http://127.0.0.1:${FAKE_LLM_PORT}/openai/v1`,
            },
        });
        expect(created.status(), await created.text()).toBe(201);
        const connectionId = ((await created.json()) as { id: string }).id;
        const verified = await request.post(
            `${CP_URL}/api/v1/provider-connections/${connectionId}/verify`,
            { headers: owner.headers },
        );
        expect(verified.ok(), await verified.text()).toBe(true);

        principalId = await provisionWorkspaceAgentPrincipal(
            request,
            { accessToken: owner.token, workspaceId: owner.workspaceId },
            {
                name: `r1-agent-${NONCE}`,
                actions: [],
                defaultModelProvider: "openai",
                defaultModelName: FAKE_LLM_MODEL,
            },
        );
        sessionId = await createSessionWithPrincipal(
            request,
            { accessToken: owner.token, workspaceId: owner.workspaceId },
            { principalId, title: `r1-matrix-${NONCE}` },
        );
        rootBranchId = await getRootBranchId(request, sessionId, owner.headers);

        // B 作为 HUMAN 参与人入会话（被 @ 才应答）。
        const participant = await request.post(
            `${CP_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/participants`,
            {
                headers: owner.headers,
                data: {
                    principalKind: "HUMAN",
                    principalId: member.userId,
                    role: "MEMBER",
                    wakePolicy: "MENTION",
                    respondPolicy: "WHEN_MENTIONED",
                },
            },
        );
        expect(
            participant.status(),
            `add participant: ${participant.status()} ${await participant.text()}`,
        ).toBe(201);
        memberParticipantId = ((await participant.json()) as { participantId: string })
            .participantId;
    });

    test("R1-a 双账户互见：A 发送后 B 在 API 读面可见（durable）", async ({ request }) => {
        const content = `R1 互见 ${NONCE}`;
        const sent = await request.post(`${CP_URL}/api/v1/chat`, {
            headers: owner.headers,
            data: {
                sessionId,
                branchId: rootBranchId,
                content,
                agentPrincipalId: principalId,
                cc: [memberParticipantId],
            },
        });
        expect(sent.status(), await sent.text()).toBe(202);
        const body = (await sent.json()) as { runId?: string };
        expect(body.runId ?? "", "run accepted").not.toBe("");

        // B 视角读消息（workspace 上下文 + 本会话可见性由参与者决定）。
        await expect
            .poll(
                async () => {
                    const response = await request.get(
                        `${CP_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/messages?branchId=${rootBranchId}`,
                        { headers: inWorkspace(member, owner.workspaceId) },
                    );
                    if (!response.ok()) return `http-${response.status()}`;
                    const payload = (await response.json()) as
                        | Array<{ content?: string }>
                        | { messages?: Array<{ content?: string }> };
                    const rows = Array.isArray(payload) ? payload : (payload.messages ?? []);
                    return rows.some((row) => row.content?.includes(content))
                        ? "visible"
                        : "not-yet";
                },
                { timeout: 30_000, intervals: [500, 1_000] },
            )
            .toBe("visible");
    });

    test("R1-b @ 对方：B 的提及游标累计（durable）", async ({ request }) => {
        const sent = await request.post(`${CP_URL}/api/v1/chat`, {
            headers: owner.headers,
            data: {
                sessionId,
                branchId: rootBranchId,
                content: `@${member.username} 请看这条 ${NONCE}`,
                agentPrincipalId: principalId,
            },
        });
        expect(sent.status(), await sent.text()).toBe(202);
        await expect
            .poll(
                async () => {
                    const response = await request.get(
                        `${CP_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/participants`,
                        { headers: inWorkspace(member, owner.workspaceId) },
                    );
                    if (!response.ok()) return `http-${response.status()}`;
                    const payload = (await response.json()) as {
                        participants?: Array<{
                            participantId: string;
                            readCursor?: { mentionCount?: number } | null;
                        }>;
                    };
                    const mine = (payload.participants ?? []).find(
                        (row) => row.participantId === memberParticipantId,
                    );
                    return String(mine?.readCursor?.mentionCount ?? 0);
                },
                { timeout: 30_000, intervals: [500, 1_000] },
            )
            .not.toBe("0");
    });

    test("R1-c 抄送对方：cc 受理且 B 可见会话", async ({ request }) => {
        const content = `R1 CC ${NONCE}`;
        const sent = await request.post(`${CP_URL}/api/v1/chat`, {
            headers: owner.headers,
            data: {
                sessionId,
                branchId: rootBranchId,
                content,
                agentPrincipalId: principalId,
                cc: [memberParticipantId],
            },
        });
        expect(sent.status(), await sent.text()).toBe(202);
        const session = await request.get(
            `${CP_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}`,
            { headers: inWorkspace(member, owner.workspaceId) },
        );
        expect(session.ok(), await session.text()).toBe(true);
        const detail = (await session.json()) as { id?: string };
        expect(detail.id).toBe(sessionId);
    });

    test("R1-d 未参与者不可见：C 读会话/消息/参与者全部被拒", async ({ request }) => {
        const outsiderHeaders = inWorkspace(outsider, owner.workspaceId);
        const session = await request.get(
            `${CP_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}`,
            { headers: outsiderHeaders },
        );
        expect([403, 404], `outsider session: ${session.status()}`).toContain(session.status());
        const messages = await request.get(
            `${CP_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/messages?branchId=${rootBranchId}`,
            { headers: outsiderHeaders },
        );
        expect([403, 404], `outsider messages: ${messages.status()}`).toContain(messages.status());
        const participants = await request.get(
            `${CP_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/participants`,
            { headers: outsiderHeaders },
        );
        expect([403, 404], `outsider participants: ${participants.status()}`).toContain(
            participants.status(),
        );
    });

    test("R1-e B 登录后 UI 可见消息气泡", async ({ page }) => {

        await page.addInitScript(
            ({ token, workspaceId }) => {
                localStorage.setItem("xihe-token", token);
                sessionStorage.setItem(
                    "xihe-workspace",
                    JSON.stringify({ id: workspaceId, workspaceRole: "MEMBER" }),
                );
            },
            { token: member.token, workspaceId: owner.workspaceId },
        );
        await page.goto(workspaceChatPath(owner.workspaceId, sessionId));
        await expect(page.getByTestId("chat-input"), "member composer mounts").toBeVisible({
            timeout: 30_000,
        });
        await expect(
            page.getByText(`R1 互见 ${NONCE}`, { exact: false }),
            "message bubble visible to the second human",
        ).toBeVisible({ timeout: 30_000 });

    });
});
