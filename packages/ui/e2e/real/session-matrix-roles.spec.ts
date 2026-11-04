/**
 * PLAN-0658 R3 @host — 三角色会话可见性（OWNER / MEMBER(EDITOR) / VIEWER 各登录断言）。
 *
 * 权威定义（`evidence/r-matrix-source.md`）：R3 = 成员维度的三角色会话可见性，断言面 UI+wire。
 *
 * 真栈事实（与 BL-237 区分）：会话**本体**归 `session.user_id` 所有（`SessionService.requireCurrent`
 * 按 `id AND user_id AND workspace_id AND archived` 过滤），所以工作区成员（EDITOR/VIEWER）
 * **只要不是该会话的参与者**，就应当 fail-closed 到 404 `SESSION_NOT_FOUND` —— 这是**正确语义**
 * （隐私边界），不是 BL-237。BL-237 特指「已被邀进会话的人类参与者仍读不到」，本 spec 不涉及。
 *
 * 覆盖：
 *  1. OWNER：`GET /sessions/{id}` 与 `/messages` 200，能看到自己刚发的消息；
 *  2. MEMBER（工作区 EDITOR，非参与者）：会话读面 404 fail-closed，且 `GET /sessions` 列表不含该会话；
 *  3. VIEWER：同 2，另加**写面** fail-closed（发送被拒，不产生 run）；
 *  4. UI：三种角色各自登录后，只有 OWNER 能看到该消息文本；其他角色看不到且页面不崩。
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
import { workspaceChatPath } from "../../src/lib/routes";

const NONCE = Date.now().toString(36);
const PASSWORD = process.env.XIHE_E2E_PASSWORD ?? "XhE2e!matrix1";
const FAKE_LLM_PORT = process.env.XIHE_FAKE_LLM_PORT ?? "";
const FAKE_LLM_MODEL = "fake-openai";
const FAKE_LLM_API_KEY = "sk-fake-openai-key";

interface Account {
    token: string;
    username: string;
    workspaceId: string;
    headers: Record<string, string>;
}

let owner: Account;
let editor: Account;
let viewer: Account;
let ownerWorkspaceId = "";
let sessionId = "";
let rootBranchId = "";
let messageContent = "";
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

async function registerAccount(request: APIRequestContext, label: string): Promise<Account> {
    const email = `${label}-${NONCE}-${Math.floor(Math.random() * 10000)}@test.com`;
    const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: { email, password: PASSWORD, name: label },
    });
    expect(response.status(), `register ${label}: ${await response.text()}`).toBe(201);
    const auth = (await response.json()) as { accessToken: string };
    const workspaceId = await ensureWorkspace(request, auth.accessToken);
    const me = await request.get(`${CP_URL}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    expect(me.status()).toBe(200);
    const profile = (await me.json()) as { username?: string };
    expect(profile.username, `username for ${label}`).toBeTruthy();
    return {
        token: auth.accessToken,
        username: profile.username!,
        workspaceId,
        headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            "Content-Type": "application/json",
            "X-Workspace-Id": workspaceId,
        },
    };
}

/** 以某账户身份访问 owner 的 workspace（角色由 workspace 成员关系决定）。 */
function inWorkspace(account: Account): Record<string, string> {
    return {
        Authorization: `Bearer ${account.token}`,
        "Content-Type": "application/json",
        "X-Workspace-Id": ownerWorkspaceId,
    };
}

function messagesPath(): string {
    return `${CP_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/messages?branchId=${encodeURIComponent(rootBranchId)}`;
}

function sessionPath(): string {
    return `${CP_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}`;
}

/** 该账户的会话列表里是否出现这个会话（列表读面同样是 owner-scoped）。 */
async function sessionListed(request: APIRequestContext, account: Account): Promise<boolean> {
    const response = await request.get(`${CP_URL}/api/v1/sessions`, {
        headers: inWorkspace(account),
    });
    if (!response.ok()) return false;
    const body = (await response.json()) as
        | Array<{ id?: string }>
        | { sessions?: Array<{ id?: string }> };
    const rows = Array.isArray(body) ? body : (body.sessions ?? []);
    return rows.some((row) => row.id === sessionId);
}

function seedPage(page: import("@playwright/test").Page, account: Account, role: string): void {
    page.addInitScript(
        ({ accessToken, ws, workspaceRole }) => {
            localStorage.setItem("xihe-token", accessToken);
            localStorage.setItem(
                "xihe-user",
                JSON.stringify({ id: "e2e-role", email: "e2e-role@test.com", name: "E2E Role" }),
            );
            localStorage.setItem(
                "xihe-workspace",
                JSON.stringify({ id: ws, name: "R3 workspace" }),
            );
            sessionStorage.setItem(
                "xihe-workspace",
                JSON.stringify({ id: ws, name: "R3 workspace", workspaceRole, ownerId: "x" }),
            );
        },
        { accessToken: account.token, ws: ownerWorkspaceId, workspaceRole: role },
    );
}

test.describe("@host PLAN-0658 R3 三角色会话可见性", () => {
    test.beforeAll(async ({ request }) => {
        expect(FAKE_LLM_PORT, "needs XIHE_FAKE_LLM_PORT (runner fake LLM)").not.toBe("");
        owner = await registerAccount(request, "r3-owner");
        editor = await registerAccount(request, "r3-editor");
        viewer = await registerAccount(request, "r3-viewer");
        ownerWorkspaceId = owner.workspaceId;

        for (const [account, role] of [
            [editor, "EDITOR"],
            [viewer, "VIEWER"],
        ] as const) {
            const added = await request.post(
                `${CP_URL}/api/v1/workspaces/${ownerWorkspaceId}/members`,
                { headers: owner.headers, data: { username: account.username, role } },
            );
            expect(added.status(), `add ${role}: ${added.status()} ${await added.text()}`).toBe(
                201,
            );
        }

        const connection = await request.post(`${CP_URL}/api/v1/provider-connections`, {
            headers: owner.headers,
            data: {
                providerId: "openai",
                apiTypeId: "openai-chat-completions",
                apiTypeVersion: 1,
                apiKey: FAKE_LLM_API_KEY,
                connectionKey: `r3-${NONCE}`,
                label: `R3 fake LLM (${NONCE})`,
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
            { headers: owner.headers },
        );
        expect(verified.ok(), await verified.text()).toBe(true);

        const principalId = await provisionWorkspaceAgentPrincipal(
            request,
            { accessToken: owner.token, workspaceId: ownerWorkspaceId },
            {
                name: agentName("R3", NONCE),
                actions: [],
                defaultModelProvider: "openai",
                defaultModelName: FAKE_LLM_MODEL,
            },
        );
        sessionId = await createSessionWithPrincipal(
            request,
            { accessToken: owner.token, workspaceId: ownerWorkspaceId },
            { principalId, title: `r3-roles-${NONCE}`, workspaceId: ownerWorkspaceId },
        );
        rootBranchId = await getRootBranchId(request, sessionId, owner.headers);
        closeSse = await openSessionSse(sessionId, owner.token, {
            "X-Workspace-Id": ownerWorkspaceId,
        });

        messageContent = `R3 owner-only ${NONCE}`;
        const sent = await request.post(`${CP_URL}/api/v1/chat`, {
            headers: owner.headers,
            data: { sessionId, branchId: rootBranchId, content: messageContent },
        });
        expect(sent.status(), await sent.text()).toBe(202);
    });

    test.afterAll(() => {
        closeSse?.();
        closeSse = null;
    });

    test("R3-1 OWNER：会话与消息读面 200，能看到自己发的消息", async ({ request }) => {
        const session = await request.get(sessionPath(), { headers: owner.headers });
        expect(session.status(), await session.text()).toBe(200);
        const messages = await request.get(messagesPath(), { headers: owner.headers });
        expect(messages.status(), await messages.text()).toBe(200);
        const payload = (await messages.json()) as
            | Array<{ content?: string }>
            | { messages?: Array<{ content?: string }> };
        const rows = Array.isArray(payload) ? payload : (payload.messages ?? []);
        expect(
            rows.some((row) => row.content?.includes(messageContent)),
            "OWNER 读面可见",
        ).toBe(true);
    });

    test("R3-2 MEMBER(EDITOR，非参与者)：会话读面 404 fail-closed，会话列表不含它", async ({
        request,
    }) => {
        const session = await request.get(sessionPath(), { headers: inWorkspace(editor) });
        expect(session.status(), "EDITOR 不是会话参与者 ⇒ 404").toBe(404);
        expect(await problemCode(session)).toBe("SESSION_NOT_FOUND");
        const messages = await request.get(messagesPath(), { headers: inWorkspace(editor) });
        expect(messages.status(), "EDITOR 消息读面 404").toBe(404);
        expect(await problemCode(messages)).toBe("SESSION_NOT_FOUND");
        expect(await sessionListed(request, editor), "EDITOR 的会话列表不含他人会话").toBe(false);
    });

    test("R3-3 VIEWER：读面 404 fail-closed + 写面被拒（不产生 run）", async ({ request }) => {
        const session = await request.get(sessionPath(), { headers: inWorkspace(viewer) });
        expect(session.status(), "VIEWER 会话读面 404").toBe(404);
        const messages = await request.get(messagesPath(), { headers: inWorkspace(viewer) });
        expect(messages.status(), "VIEWER 消息读面 404").toBe(404);
        expect(await sessionListed(request, viewer), "VIEWER 的会话列表不含他人会话").toBe(false);

        // 写面：VIEWER 发送必须被拒（fail-closed），且不落 run/消息。
        // 实测（2026-11-04 真栈）：403 `WORKSPACE_READ_ONLY` —— 由租户层的
        // `WorkspaceWriteGuard` 在进入会话控制器之前拦下，所以 VIEWER 连"会话不存在"的
        // 404 都不会看到。这里钉死该契约（角色写面先于会话读面）。
        const sent = await request.post(`${CP_URL}/api/v1/chat`, {
            headers: inWorkspace(viewer),
            data: { sessionId, branchId: rootBranchId, content: `R3 viewer send ${NONCE}` },
        });
        const code = await problemCode(sent);
        expect(sent.status(), `viewer chat status=${sent.status()} code=${code}`).toBe(403);
        expect(code, "VIEWER 写面稳定码").toBe("WORKSPACE_READ_ONLY");

        // OWNER 读面仍然只有自己那条 R3 消息（VIEWER 的尝试没有落库）。
        const ownerMessages = await request.get(messagesPath(), { headers: owner.headers });
        expect(ownerMessages.status()).toBe(200);
        const payload = (await ownerMessages.json()) as
            | Array<{ content?: string }>
            | { messages?: Array<{ content?: string }> };
        const rows = Array.isArray(payload) ? payload : (payload.messages ?? []);
        expect(
            rows.some((row) => row.content?.includes(`R3 viewer send ${NONCE}`)),
            "被拒的发送不得落库",
        ).toBe(false);
    });

    test("R3-4 UI：三角色登录后只有 OWNER 看到该消息", async ({ browser }) => {
        // 三个独立 browser context 串行登录 + 各自首次加载 SPA：冷栈上默认 30s 预算不够用
        // （实测 30.3s 打满在第一个 `page.goto(..., waitUntil: "load")`）。这里只放宽**用例超时**，
        // 不是放宽断言：下面所有可见性断言一字未改。
        test.setTimeout(180_000);
        const cases: Array<{ account: Account; role: string; label: string; visible: boolean }> = [
            { account: owner, role: "OWNER", label: "owner", visible: true },
            { account: editor, role: "EDITOR", label: "editor", visible: false },
            { account: viewer, role: "VIEWER", label: "viewer", visible: false },
        ];
        for (const item of cases) {
            const context = await browser.newContext();
            const page = await context.newPage();
            await seedPage(page, item.account, item.role);
            await page.goto(workspaceChatPath(ownerWorkspaceId, sessionId));
            // 页面必须挂载（不崩）——用路由视口做判据。
            await expect(
                page.getByTestId("workspace-route-viewport"),
                `${item.label} workspace route mounts`,
            ).toBeVisible({ timeout: 30_000 });
            const bubble = page.getByText(messageContent, { exact: false });
            if (item.visible) {
                await expect(bubble.first(), "OWNER 看到消息气泡").toBeVisible({
                    timeout: 30_000,
                });
            } else {
                await expect(bubble, `${item.label} 不得看到他人会话内容`).toHaveCount(0);
            }
            await context.close();
        }
    });
});
