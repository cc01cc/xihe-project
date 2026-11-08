// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
/**
 * PLAN-0658 R5 @host — 停用主体后的候选 / 成员行过滤（UI）。
 *
 * 权威定义（`evidence/r-matrix-source.md`）：R5 = 主体维度「停用主体后候选/成员行过滤」，
 * 断言面 **UI**。
 *
 * 产品语义（源码依据）：
 *  - composer「发送」栏候选 = `useSessionParticipantsStore().speakAsCandidates`
 *    = `selfOwned === true && !disabledAt`（`stores/sessionParticipants.ts:44`）——
 *    停用主体**不渲染成可点入口**（服务端会 403 `PARTICIPANT_DISABLED`，那是"根本不接受"）；
 *  - 成员行（`SessionParticipantsPanel` → `ParticipantRow`）**保留**停用行（软停用留审计），
 *    但打 `participant-disabled-badge-<id>` 并降透明度（`ParticipantRow.vue:142,148,196`）。
 *
 * 覆盖：
 *  1. R5-1 API 前置：AGENT 参与者 soft-disable 后名册 `disabledAt` 非空、`capabilities.speakAs` 仍真；
 *  2. R5-2 UI 候选：候选面里**没有**停用主体，也没有可点 chip（enabled 的 PRIMARY 在候选里）；
 *  3. R5-3 UI 成员行：成员面板仍有该行，但带停用徽标；PRIMARY 行无徽标。
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
import { workspaceChatPath } from "../../src/lib/routes";
import { ACTION_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const NONCE = Date.now().toString(36);
const PASSWORD = process.env.XIHE_E2E_PASSWORD ?? "XhE2e!matrix1";
const FAKE_LLM_PORT = process.env.XIHE_FAKE_LLM_PORT ?? "";
const FAKE_LLM_MODEL = "fake-openai";
const FAKE_LLM_API_KEY = "sk-fake-openai-key";

let token = "";
let workspaceId = "";
let sessionId = "";
let primaryPrincipalId = "";
let primaryParticipantId = "";
let disabledPrincipalId = "";
let disabledParticipantId = "";
let primaryDisplayName = "";
let disabledDisplayName = "";
let headers: Record<string, string> = {};
let closeSse: (() => void) | null = null;

test.describe.configure({ mode: "serial", retries: 0 });

interface ParticipantView {
    participantId: string;
    principalKind: string;
    principalId: string;
    displayName?: string;
    disabledAt?: string | null;
    selfOwned: boolean;
}

function participantsPath(): string {
    return `${CP_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/participants`;
}

async function roster(request: APIRequestContext): Promise<{
    participants?: ParticipantView[];
    capabilities?: { speakAs?: boolean };
}> {
    const response = await request.get(participantsPath(), { headers });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()) as {
        participants?: ParticipantView[];
        capabilities?: { speakAs?: boolean };
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
                JSON.stringify({ id: ws, name: "R5 workspace" }),
            );
            sessionStorage.setItem(
                "xihe-workspace",
                JSON.stringify({
                    id: ws,
                    name: "R5 workspace",
                    workspaceRole: "OWNER",
                    ownerId: "x",
                }),
            );
        },
        { accessToken: token, ws: workspaceId },
    );
}

test.describe("@host PLAN-0658 R5 停用主体过滤", () => {
    test.beforeAll(async ({ request }) => {
        expect(FAKE_LLM_PORT, "needs XIHE_FAKE_LLM_PORT (runner fake LLM)").not.toBe("");
        const email = `r5-owner-${NONCE}-${Math.floor(Math.random() * 10000)}@test.com`;
        const registered = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: { email, password: PASSWORD, name: "r5-owner" },
        });
        expect(registered.status(), await registered.text()).toBe(201);
        const auth = (await registered.json()) as { accessToken: string };
        token = auth.accessToken;
        workspaceId = await ensureWorkspace(request, token);
        headers = {
            Authorization: `Bearer ${token}`,
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
                connectionKey: `r5-${NONCE}`,
                label: `R5 fake LLM (${NONCE})`,
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

        primaryDisplayName = agentName("R5Primary", NONCE);
        disabledDisplayName = agentName("R5Retired", NONCE);
        primaryPrincipalId = await provisionWorkspaceAgentPrincipal(
            request,
            { accessToken: token, workspaceId },
            {
                name: primaryDisplayName,
                actions: [],
                defaultModelProvider: "openai",
                defaultModelName: FAKE_LLM_MODEL,
            },
        );
        disabledPrincipalId = await provisionWorkspaceAgentPrincipal(
            request,
            { accessToken: token, workspaceId },
            {
                name: disabledDisplayName,
                actions: [],
                defaultModelProvider: "openai",
                defaultModelName: FAKE_LLM_MODEL,
            },
        );
        sessionId = await createSessionWithPrincipal(
            request,
            { accessToken: token, workspaceId },
            { principalId: primaryPrincipalId, title: `r5-disabled-${NONCE}`, workspaceId },
        );
        const rootBranchId = await getRootBranchId(request, sessionId, headers);
        expect(rootBranchId).toBeTruthy();

        const added = await request.post(participantsPath(), {
            headers,
            data: { principalKind: "AGENT", principalId: disabledPrincipalId, role: "MEMBER" },
        });
        expect(added.status(), await added.text()).toBe(201);
        disabledParticipantId = ((await added.json()) as { participantId: string }).participantId;

        const before = await roster(request);
        const primary = (before.participants ?? []).find(
            (row) => row.principalKind === "AGENT" && row.principalId === primaryPrincipalId,
        );
        expect(primary, "PRIMARY agent 参与者行").toBeTruthy();
        primaryParticipantId = primary!.participantId;

        // soft-disable：行保留、disabledAt 落库（成员行据此打徽标，候选据此过滤）。
        const patched = await request.patch(
            `${participantsPath()}/${encodeURIComponent(disabledParticipantId)}`,
            { headers, data: { disabled: true } },
        );
        expect(patched.status(), await patched.text()).toBe(200);

        closeSse = await openSessionSse(sessionId, token, { "X-Workspace-Id": workspaceId });
    });

    test.afterAll(() => {
        closeSse?.();
        closeSse = null;
    });

    test("R5-1 API：停用主体 disabledAt 非空、selfOwned 已落 false", async ({ request }) => {
        const view = await roster(request);
        const rows = view.participants ?? [];
        const disabledRow = rows.find((row) => row.participantId === disabledParticipantId);
        expect(disabledRow, "停用行仍在名册（软停用留审计）").toBeTruthy();
        expect(disabledRow!.disabledAt, "disabledAt 非空").toBeTruthy();
        // 实测（2026-11-04 真栈）：停用行的 `selfOwned` 本身就是 **false** —— 服务端
        // `isSelfOwned` 已经把停用排除在外，所以 UI 的 `selfOwned && !disabledAt`
        // 是**两层各自独立**的过滤，不是"selfOwned 仍真、只靠 disabledAt 兜底"。
        expect(disabledRow!.selfOwned, "停用行 selfOwned=false（服务端第一层过滤）").toBe(false);
        const primaryRow = rows.find((row) => row.participantId === primaryParticipantId);
        expect(primaryRow, "PRIMARY 行").toBeTruthy();
        expect(primaryRow!.disabledAt ?? null, "PRIMARY 未停用").toBeNull();
        expect(primaryRow!.selfOwned, "enabled 的 PRIMARY selfOwned=true").toBe(true);
        expect(view.capabilities?.speakAs, "仍可 speak-as（有 enabled 候选）").toBe(true);
    });

    test("R5-2 UI 候选：停用主体不出现在「发送」候选中", async ({ page }) => {
        seedOwnerPage(page);
        await page.goto(workspaceChatPath(workspaceId, sessionId));
        await expect(page.getByTestId("chat-input"), "composer mounts").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });

        const field = page.getByTestId("speak-as-input");
        await expect(field, "「发送」栏渲染（capabilities.speakAs=true）").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        // 候选面语义（`RecipientField.vue:50-74`）：`filtered` 会同时排除**已选中**和停用的项，
        // `open` 由 query 变化驱动。默认预选 PRIMARY ⇒ 先把它的 chip 移除，否则候选只剩空集
        // （这会让人误判成"过滤掉了"）。移除后再输入两个 agent 共有的前缀 `AgentR5`：
        // 只有 enabled 的那个出现在候选里，才证明停用主体被过滤。
        const sharedPrefix = "AgentR5";
        expect(primaryDisplayName.startsWith(sharedPrefix)).toBe(true);
        expect(disabledDisplayName.startsWith(sharedPrefix)).toBe(true);
        const chipRemove = page.getByTestId("speak-as-chip-remove");
        if ((await chipRemove.count()) > 0) {
            await chipRemove.first().click();
            await expect(page.getByTestId("speak-as-chip"), "chip 已移除").toHaveCount(0);
        }
        await field.click();
        await field.pressSequentially(sharedPrefix);
        await expect(
            page.getByTestId("speak-as-menu"),
            "候选面打开（有 enabled 候选）",
        ).toBeVisible({
            timeout: ACTION_TIMEOUT_MS,
        });
        // 选项的**每项唯一标识是 DOM `id`**（`RecipientField` 的 `optionId()`），
        // `data-testid` 对所有选项都是同一个 `speak-as-option`。
        await expect(
            page.locator(`#speak-as-option-${disabledParticipantId}`),
            "停用主体不得成为可点候选",
        ).toHaveCount(0);
        await expect(
            page.locator(`#speak-as-option-${primaryParticipantId}`),
            "同一前缀下 enabled 主体在候选里（证明过滤而非空集）",
        ).toHaveCount(1);
    });

    test("R5-3 UI 成员行：停用行保留但带停用徽标", async ({ page }) => {
        seedOwnerPage(page);
        await page.goto(workspaceChatPath(workspaceId, sessionId));
        await expect(page.getByTestId("chat-input"), "composer mounts").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });

        // 打开 dock 的「成员」页签（WorkspaceToolbar → dock tab）。
        await page.getByTestId("workspace-toolbar-members").click();
        await page.getByTestId("dock-tab-members").click();
        await expect(page.getByTestId("session-participants-panel"), "成员面板").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });

        const disabledRow = page.getByTestId(`participant-row-${disabledParticipantId}`);
        await expect(disabledRow, "停用行仍在成员列表（不隐藏）").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await expect(
            page.getByTestId(`participant-disabled-badge-${disabledParticipantId}`),
            "停用徽标可见（过滤依据可见）",
        ).toBeVisible();
        const primaryRow = page.getByTestId(`participant-row-${primaryParticipantId}`);
        await expect(primaryRow, "PRIMARY 行").toBeVisible();
        await expect(
            page.getByTestId(`participant-disabled-badge-${primaryParticipantId}`),
            "PRIMARY 无停用徽标",
        ).toHaveCount(0);
    });
});
