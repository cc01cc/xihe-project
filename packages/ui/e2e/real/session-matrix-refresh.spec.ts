/**
 * PLAN-0658 R8 @host — 刷新恢复（BL-228 守护）· 多账户 / CC 语境。
 *
 * 权威定义（`evidence/r-matrix-source.md`）：R8 = 流维度「刷新恢复（BL-228 守护）多账户/CC
 * 语境：reload 后三段同值」，断言面 UI + durable。
 *
 * BL-228 的历史症状：刷新后流式态残留/回复丢失或重复（live SSE 与历史投影的竞态）。本 spec
 * 用真栈把它钉住：
 *  1. R8-1 OWNER 刷新：`POST /chat`（带 cc=[B]）→ 首屏看到气泡 → `reload()` 后**仍然恰好一条**
 *     （不重复、不丢），且该 run 在 durable 读面是终态；
 *  2. R8-2 CC 语境刷新：reload 后 composer 不残留 cc chips（草稿/抄送状态不复活），消息仍恰好一条；
 *  3. R8-3〔fixme · BL-237〕第二人类账户 B 刷新后应能看到同一条消息 —— 当前读面 owner-only，
 *     受阻于 BL-237，不用放宽断言换绿。
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
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
const TERMINAL = new Set(["succeeded", "failed", "partial", "ambiguous", "cancelled"]);

interface Account {
    token: string;
    username: string;
    userId: string;
    workspaceId: string;
    /** Real login credentials (BL-237 seed fix: product login path instead of fake storage). */
    email: string;
}

let owner: Account;
let member: Account;
let ownerHeaders: Record<string, string> = {};
let sessionId = "";
let rootBranchId = "";
let memberParticipantId = "";
let runId = "";
let messageContent = "";
let closeSse: (() => void) | null = null;

test.describe.configure({ mode: "serial", retries: 0 });

async function registerAccount(request: APIRequestContext, label: string): Promise<Account> {
    const email = `${label}-${NONCE}-${Math.floor(Math.random() * 10000)}@test.com`;
    const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: { email, password: PASSWORD, name: label },
    });
    expect(response.status(), `register ${label}: ${await response.text()}`).toBe(201);
    const auth = (await response.json()) as { accessToken: string; user: { id: string } };
    const workspaceId = await ensureWorkspace(request, auth.accessToken);
    const me = await request.get(`${CP_URL}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    expect(me.status()).toBe(200);
    const profile = (await me.json()) as { username?: string };
    return {
        token: auth.accessToken,
        username: profile.username ?? "",
        userId: auth.user.id,
        workspaceId,
        email,
    };
}

function seedOwnerPage(page: import("@playwright/test").Page): void {
    page.addInitScript(
        ({ accessToken, ws }) => {
            localStorage.setItem("xihe-token", accessToken);
            localStorage.setItem(
                "xihe-user",
                JSON.stringify({ id: "e2e-owner", email: "e2e-owner@test.com", name: "E2E Owner" }),
            );
            localStorage.setItem(
                "xihe-workspace",
                JSON.stringify({ id: ws, name: "R8 workspace" }),
            );
            sessionStorage.setItem(
                "xihe-workspace",
                JSON.stringify({
                    id: ws,
                    name: "R8 workspace",
                    workspaceRole: "OWNER",
                    ownerId: "x",
                }),
            );
        },
        { accessToken: owner.token, ws: owner.workspaceId },
    );
}

/**
 * PLAN-0668 BL-299 前置（R8-3 seed 修复）：真实登录，和 UI 用户路径一致；假 storage seed
 * （假 user id、无 refresh token）与真实登录不等价，会让读面 spec 永远红。
 */
async function loginMemberInBrowser(page: Page): Promise<void> {
    await page.goto("/login");
    const boxes = page.getByRole("textbox");
    await boxes.nth(0).fill(member.email);
    await boxes.nth(1).fill(PASSWORD);
    // 某些浏览器/动画下 Enter 不触发提交（Playwright 实测），直接 requestSubmit。
    await page
        .locator("form")
        .first()
        .evaluate((form) => (form as HTMLFormElement).requestSubmit());
    await page.waitForURL(/\/workspace/, { timeout: 30_000 });
}
test.describe("@host PLAN-0658 R8 刷新恢复（BL-228 守护）", () => {
    test.beforeAll(async ({ request }) => {
        expect(FAKE_LLM_PORT, "needs XIHE_FAKE_LLM_PORT (runner fake LLM)").not.toBe("");
        owner = await registerAccount(request, "r8-owner");
        member = await registerAccount(request, "r8-member");
        ownerHeaders = {
            Authorization: `Bearer ${owner.token}`,
            "Content-Type": "application/json",
            "X-Workspace-Id": owner.workspaceId,
        };

        const added = await request.post(
            `${CP_URL}/api/v1/workspaces/${owner.workspaceId}/members`,
            { headers: ownerHeaders, data: { username: member.username, role: "EDITOR" } },
        );
        expect(added.status(), await added.text()).toBe(201);

        const connection = await request.post(`${CP_URL}/api/v1/provider-connections`, {
            headers: ownerHeaders,
            data: {
                providerId: "openai",
                apiTypeId: "openai-chat-completions",
                apiTypeVersion: 1,
                apiKey: FAKE_LLM_API_KEY,
                connectionKey: `r8-${NONCE}`,
                label: `R8 fake LLM (${NONCE})`,
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

        const principalId = await provisionWorkspaceAgentPrincipal(
            request,
            { accessToken: owner.token, workspaceId: owner.workspaceId },
            {
                name: agentName("R8", NONCE),
                actions: [],
                defaultModelProvider: "openai",
                defaultModelName: FAKE_LLM_MODEL,
            },
        );
        sessionId = await createSessionWithPrincipal(
            request,
            { accessToken: owner.token, workspaceId: owner.workspaceId },
            { principalId, title: `r8-refresh-${NONCE}`, workspaceId: owner.workspaceId },
        );
        rootBranchId = await getRootBranchId(request, sessionId, ownerHeaders);

        const participant = await request.post(
            `${CP_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/participants`,
            {
                headers: ownerHeaders,
                data: {
                    principalKind: "HUMAN",
                    principalId: member.userId,
                    role: "MEMBER",
                    wakePolicy: "MENTION",
                    respondPolicy: "WHEN_MENTIONED",
                },
            },
        );
        expect(participant.status(), await participant.text()).toBe(201);
        memberParticipantId = ((await participant.json()) as { participantId: string })
            .participantId;

        closeSse = await openSessionSse(sessionId, owner.token, {
            "X-Workspace-Id": owner.workspaceId,
        });

        messageContent = `R8 refresh ${NONCE}`;
        const sent = await request.post(`${CP_URL}/api/v1/chat`, {
            headers: ownerHeaders,
            data: {
                sessionId,
                branchId: rootBranchId,
                content: messageContent,
                cc: [memberParticipantId],
            },
        });
        expect(sent.status(), await sent.text()).toBe(202);
        runId = ((await sent.json()) as { runId?: string }).runId ?? "";
        expect(runId, "runId").toBeTruthy();
    });

    test.afterAll(() => {
        closeSse?.();
        closeSse = null;
    });

    test("R8-1 OWNER 刷新：消息恰好一条、run 在 durable 读面终态", async ({ page, request }) => {
        seedOwnerPage(page);
        await page.goto(workspaceChatPath(owner.workspaceId, sessionId));
        await expect(page.getByTestId("chat-input"), "composer mounts").toBeVisible({
            timeout: 30_000,
        });
        const bubble = page.getByText(messageContent, { exact: true });
        await expect(bubble, "首屏一条用户气泡").toHaveCount(1, { timeout: 30_000 });

        await page.reload();
        await expect(page.getByTestId("chat-input"), "reload 后 composer").toBeVisible({
            timeout: 30_000,
        });
        await expect(
            page.getByText(messageContent, { exact: true }),
            "刷新后仍**恰好一条**（BL-228：不重复不丢）",
        ).toHaveCount(1, { timeout: 30_000 });
        // 刷新后不得残留流式态（发送按钮仍在 = 不在跑）。
        await expect(
            page.getByTestId("chat-send-button"),
            "回复已收尾，composer 可发送",
        ).toBeVisible({ timeout: 30_000 });

        // durable 三段同值里的另一段：该 run 已终态。
        await expect
            .poll(
                async () => {
                    const response = await request.get(
                        `${CP_URL}/api/v1/chat/runs/${encodeURIComponent(runId)}`,
                        { headers: ownerHeaders },
                    );
                    if (!response.ok()) return false;
                    const status = String(
                        ((await response.json()) as { status?: string }).status ?? "",
                    );
                    return TERMINAL.has(status);
                },
                { timeout: 90_000, intervals: [500, 1_000] },
            )
            .toBe(true);
    });

    test("R8-2 CC 语境刷新：composer 不残留 cc chips，消息仍一条", async ({ page }) => {
        seedOwnerPage(page);
        await page.goto(workspaceChatPath(owner.workspaceId, sessionId));
        await expect(page.getByTestId("chat-input"), "composer mounts").toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByTestId("cc-chip"), "刷新后草稿里的 cc chips 不复活").toHaveCount(0);
        await page.reload();
        await expect(page.getByTestId("chat-input"), "reload 后 composer").toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByTestId("cc-chip"), "reload 后仍无 cc chips").toHaveCount(0);
        await expect(
            page.getByText(messageContent, { exact: true }),
            "CC 语境下消息仍恰好一条",
        ).toHaveCount(1, { timeout: 30_000 });
    });

    // BL-237：会话读面 owner-only（`SessionService.requireCurrent` 按 session.user_id 过滤）⇒
    // 受邀人类参与者刷新后读不到消息。本项记录**期望行为**：读面加参与者分支后自动转绿。
    test("R8-3 第二人类账户刷新后应能看到同一条消息（BL-237）", async ({ page }) => {
        await loginMemberInBrowser(page);
        await page.goto(workspaceChatPath(owner.workspaceId, sessionId));
        await expect(page.getByTestId("chat-input"), "composer mounts").toBeVisible({
            timeout: 30_000,
        });
        await page.reload();
        await expect(page.getByTestId("chat-input"), "reload 后 composer").toBeVisible({
            timeout: 30_000,
        });
        await expect(
            page.getByText(messageContent, { exact: true }),
            "参与者在刷新后仍能看到同一条消息",
        ).toHaveCount(1, { timeout: 30_000 });
    });
});
