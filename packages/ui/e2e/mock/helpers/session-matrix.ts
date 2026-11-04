/**
 * PLAN-0658 会话矩阵 mock 夹具（T1.2/T1.3 共用）。
 *
 * 只做两件事：
 *  1. 提供矩阵用的参与者花名册（人类账户 × 角色、agent 主体 × 停用态）——断言面是
 *     `SessionParticipantView` 的**完整 wire 形状**（`src/types/participant.ts`），
 *     缺字段会让组件静默降级（例如 `disabledAt` 缺失就测不到"停用主体不出现"）。
 *  2. 把 `GET /api/v1/sessions/{id}/participants` 装成严格信封 `{participants, capabilities}`
 *     ——UI 侧按失败关闭处理缺 capabilities 的响应（见 participant.ts 注释）。
 *
 * 与 `setupMockAuth` 的关系：它注册的 `**\/api/v1/**` 兜底返回 `200 {}`（空列表），
 * 本 helper 必须在 `setupMockAuth` **之后**注册，后注册的路由优先级更高。
 */
import type { Page } from "@playwright/test";

export type MatrixParticipant = {
    participantId: string;
    principalKind: "HUMAN" | "AGENT";
    principalId: string;
    displayName: string;
    role: "PRIMARY" | "MEMBER" | "GUARD";
    orderIndex: number;
    wakePolicy: "ALL_MESSAGES" | "MENTION";
    respondPolicy: "ALWAYS" | "WHEN_MENTIONED" | "JUDGE" | "MUTED";
    source?: "workspace" | "personal" | "instance" | null;
    disabledAt?: string | null;
    selfOwned?: boolean;
    defaultModelProvider?: string | null;
    defaultModelName?: string | null;
};

export type MatrixCapabilities = {
    view: boolean;
    manage: boolean;
    mention: boolean;
    speakAs: boolean;
};

/** 会话 owner（当前登录用户 user-1）——speakAs 候选来源。 */
export const MATRIX_OWNER: MatrixParticipant = {
    participantId: "part-owner",
    principalKind: "HUMAN",
    principalId: "user-1",
    displayName: "Owner One",
    role: "PRIMARY",
    orderIndex: 10,
    wakePolicy: "ALL_MESSAGES",
    respondPolicy: "ALWAYS",
    source: null,
    disabledAt: null,
    selfOwned: true,
};

/** 第二个人类账户（同工作区，非 owner）——M1/M2 的 @ 与 CC 目标。 */
export const MATRIX_MEMBER: MatrixParticipant = {
    participantId: "part-member",
    principalKind: "HUMAN",
    principalId: "user-2",
    displayName: "Member Two",
    role: "MEMBER",
    orderIndex: 20,
    wakePolicy: "MENTION",
    respondPolicy: "WHEN_MENTIONED",
    source: null,
    disabledAt: null,
    selfOwned: false,
};

/** 第三个人类账户（只读 GUARD）——旁观者/不可见的对照物。 */
export const MATRIX_VIEWER: MatrixParticipant = {
    participantId: "part-viewer",
    principalKind: "HUMAN",
    principalId: "user-3",
    displayName: "Viewer Three",
    role: "GUARD",
    orderIndex: 30,
    wakePolicy: "MENTION",
    respondPolicy: "WHEN_MENTIONED",
    source: null,
    disabledAt: null,
    selfOwned: false,
};

/** 工作区 agent 主体 A（respond=ALWAYS）——TO/CC 的 agent 目标。 */
export const MATRIX_AGENT_ALPHA: MatrixParticipant = {
    participantId: "part-agent-alpha",
    principalKind: "AGENT",
    principalId: "agent-alpha",
    displayName: "Agent Alpha",
    role: "MEMBER",
    orderIndex: 40,
    wakePolicy: "ALL_MESSAGES",
    respondPolicy: "ALWAYS",
    source: "workspace",
    disabledAt: null,
    selfOwned: true,
    defaultModelProvider: "openai",
    defaultModelName: "fake-openai",
};

/** 工作区 agent 主体 B（respond=WHEN_MENTIONED）——CC 多选第二个 agent。 */
export const MATRIX_AGENT_BETA: MatrixParticipant = {
    participantId: "part-agent-beta",
    principalKind: "AGENT",
    principalId: "agent-beta",
    displayName: "Agent Beta",
    role: "MEMBER",
    orderIndex: 50,
    wakePolicy: "MENTION",
    respondPolicy: "WHEN_MENTIONED",
    source: "workspace",
    disabledAt: null,
    selfOwned: true,
    defaultModelProvider: "openai",
    defaultModelName: "fake-openai",
};

/** 已停用主体——候选里必须不出现（RecipientField / 菜单都按 disabledAt 过滤）。 */
export const MATRIX_AGENT_RETIRED: MatrixParticipant = {
    participantId: "part-agent-retired",
    principalKind: "AGENT",
    principalId: "agent-retired",
    displayName: "Agent Retired",
    role: "MEMBER",
    orderIndex: 60,
    wakePolicy: "MENTION",
    respondPolicy: "WHEN_MENTIONED",
    source: "workspace",
    disabledAt: "2026-11-01T00:00:00.000Z",
    selfOwned: true,
    defaultModelProvider: "openai",
    defaultModelName: "fake-openai",
};

/** 默认花名册：2 人类可用 + 1 人类只读 + 2 agent 可用 + 1 agent 停用。 */
export function matrixRoster(): MatrixParticipant[] {
    return [
        MATRIX_OWNER,
        MATRIX_MEMBER,
        MATRIX_VIEWER,
        MATRIX_AGENT_ALPHA,
        MATRIX_AGENT_BETA,
        MATRIX_AGENT_RETIRED,
    ];
}

export interface SetupMockParticipantsOptions {
    participants?: MatrixParticipant[];
    capabilities?: Partial<MatrixCapabilities>;
}

/** 严格信封参与者列表 + capabilities（默认全 true，speakAs 需要 true 才渲染「发送」栏）。 */
export async function setupMockParticipants(
    page: Page,
    sessionId: string,
    options: SetupMockParticipantsOptions = {},
): Promise<void> {
    const participants = options.participants ?? matrixRoster();
    const capabilities: MatrixCapabilities = {
        view: true,
        manage: true,
        mention: true,
        speakAs: true,
        ...options.capabilities,
    };
    await page.route(`**/api/v1/sessions/${sessionId}/participants`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ participants, capabilities }),
        });
    });
}

/**
 * C1（2026-11-04 合入）后的发送前提：会话未绑定 provider 时，composer 会先 `POST
 * /sessions/{id}/bind-defaults`，端点回带 `providerConnectionId` 才真正发送；否则弹
 * 「绑定引导」并把消息挂起（ChatPanel.handleSend → guardProviderBinding）。
 *
 * 矩阵 spec 要测的是发送之后的过程渲染，所以这里把 bind-defaults 桩成「自动绑定成功」。
 * 这是夹具适配产品契约，不改产品行为。
 */
export async function setupMockProviderBinding(page: Page, sessionId: string): Promise<void> {
    const bound = {
        id: sessionId,
        title: "Matrix Session",
        workspaceId: "workspace-1",
        providerConnectionId: "conn-matrix-default",
        connectionRevision: 1,
        modelProvider: "openai",
        modelName: "fake-openai",
        agentPrincipalId: "00000000-0000-4000-8000-0000000000a1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archived: false,
    };
    await page.route(`**/api/v1/sessions/${sessionId}/bind-defaults`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(bound),
        });
    });
}
