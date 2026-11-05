/**
 * mock 车道的"会话侧投影"公共夹具（BL-318）。
 *
 * 为什么默认挂：`setupMockAuth` 的 `**\/api/v1/**` 兜底对未桩端点回 `200 {}`，而
 * `setupMockSessions` 对 `/sessions/{id}/{未知后缀}` 回 404 —— 聊天列一挂载就会请求
 * `derived-state` / `follow-ups` / `commands` / `participants` 四类投影，
 * 不桩就是真 404 + 「Failed to load …」console error。那是**夹具缺口**，不是产品缺陷；
 * 一旦把 "0 console error" 当门禁，它会伪装成产品回归（PLAN-0660 T5.6 实测）。
 *
 * 形状来源（**不手写"应该有"的字段**）：2026-11-05 对 stack-1 真实 CP 逐个拉取记录，
 * 原始响应留档见 `.local/evidence/bl-318-mock-gate.md` §附录：
 *   GET /api/v1/sessions/{id}/derived-state  → { sessionId, activeChildren[], terminalNotices[] }
 *   GET /api/v1/sessions/{id}/follow-ups     → { sessionId, queueState, outstandingCount,
 *                                                capacityLimit, pauseReason, items[] }
 *   GET /api/v1/sessions/{id}/commands       → { commands: [{ name, source, available, reason }] }
 *                                                真实栈回 2 条内置命令（/export、/compact），
 *                                                不是空数组 —— 空数组会让"命令菜单"用例永远测不到。
 *   GET /api/v1/sessions/{id}/participants   → { participants: SessionParticipantView[],
 *                                                capabilities: { view, manage, mention, speakAs } }
 *                                               条目字段照抄真实响应（含 TS 类型未声明的
 *                                               `source` / `wakeConfig` / `createdAt`，CP 确实返回它们）。
 *
 * 契约以 `src/types/participant.ts` + `docs/api/openapi.yaml` 为准；改契约时同步这里。
 */
import type { Page } from "@playwright/test";

/** 真实 CP 的 `commands` 投影：两条内置命令（`available` 均为 true）。 */
export const BUILTIN_COMMANDS = [
    { name: "/export", source: "builtin", available: true, reason: null },
    { name: "/compact", source: "builtin", available: true, reason: null },
] as const;

export interface MockParticipantSeed {
    participantId?: string;
    principalKind?: "HUMAN" | "AGENT";
    principalId: string;
    displayName?: string;
    role?: "PRIMARY" | "MEMBER" | "GUARD";
    orderIndex?: number;
    wakePolicy?: "ALL_MESSAGES" | "MENTION";
    respondPolicy?: "ALWAYS" | "WHEN_MENTIONED" | "MUTED";
    disabledAt?: string | null;
    selfOwned?: boolean;
    defaultModelProvider?: string | null;
    defaultModelName?: string | null;
}

export interface MockParticipantCapabilities {
    view?: boolean;
    manage?: boolean;
    mention?: boolean;
    speakAs?: boolean;
}

const MOCK_NOW = "2026-11-05T00:00:00.000Z";

/** 单条参与者，字段顺序与真实 CP 响应一致（便于逐字段对照留档）。 */
export function participantFixture(seed: MockParticipantSeed) {
    return {
        participantId: seed.participantId ?? `participant-${seed.principalId}`,
        principalKind: seed.principalKind ?? "AGENT",
        principalId: seed.principalId,
        role: seed.role ?? "PRIMARY",
        orderIndex: seed.orderIndex ?? 10,
        wakePolicy: seed.wakePolicy ?? "ALL_MESSAGES",
        respondPolicy: seed.respondPolicy ?? "ALWAYS",
        createdAt: MOCK_NOW,
        disabledAt: seed.disabledAt ?? null,
        displayName: seed.displayName ?? null,
        defaultModelProvider:
            (seed.principalKind ?? "AGENT") === "AGENT"
                ? (seed.defaultModelProvider ?? "openai")
                : null,
        defaultModelName:
            (seed.principalKind ?? "AGENT") === "AGENT"
                ? (seed.defaultModelName ?? "fake-openai")
                : null,
        source: (seed.principalKind ?? "AGENT") === "AGENT" ? "workspace" : null,
        selfOwned: seed.selfOwned ?? true,
        wakeConfig: null,
        readCursor: { lastReadEventSeq: 0, mentionCount: 0, updatedAt: MOCK_NOW },
    };
}

/** 默认花名册：人类账户（自己）+ 绑定的 agent 主体（与真实会话同构）。 */
export function participantRoster(
    options: {
        selfUserId?: string;
        selfName?: string;
        agentPrincipalId?: string;
        agentName?: string;
    } = {},
): MockParticipantSeed[] {
    return [
        {
            participantId: "participant-self",
            principalKind: "HUMAN",
            principalId: options.selfUserId ?? "user-1",
            displayName: options.selfName ?? "Test User",
            role: "MEMBER",
            orderIndex: 1,
            wakePolicy: "ALL_MESSAGES",
            respondPolicy: "ALWAYS",
        },
        {
            participantId: "participant-agent",
            principalKind: "AGENT",
            principalId: options.agentPrincipalId ?? "00000000-0000-4000-8000-0000000000a1",
            displayName: options.agentName ?? "Mock Agent",
            role: "PRIMARY",
            orderIndex: 10,
        },
    ];
}

export interface SessionProjectionOptions {
    /** 覆盖参与者花名册；`[]` 可测"空花名册"降级。 */
    participants?: MockParticipantSeed[];
    capabilities?: MockParticipantCapabilities;
}

/**
 * 把四类投影挂到**同一个会话作用域**上。
 *
 * 注册时机要求：必须在 `setupMockSessions` 的 `**\/api/v1/sessions/**` 兜底路由**之后**
 * （Playwright 后注册者优先），否则 404/兜底 200 会吃掉这些请求。
 */
export async function stubSessionProjections(
    page: Page,
    sessionId: string,
    options: SessionProjectionOptions = {},
): Promise<void> {
    const base = `**/api/v1/sessions/${sessionId}`;
    await page.route(`${base}/derived-state`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessionId, activeChildren: [], terminalNotices: [] }),
        });
    });
    await page.route(`${base}/follow-ups`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                sessionId,
                queueState: "empty",
                outstandingCount: 0,
                capacityLimit: 5,
                pauseReason: null,
                items: [],
            }),
        });
    });
    await page.route(`${base}/commands`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ commands: BUILTIN_COMMANDS }),
        });
    });
    await page.route(`${base}/participants`, async (route) => {
        const participants = (options.participants ?? participantRoster()).map((seed) =>
            participantFixture(seed),
        );
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                participants,
                capabilities: {
                    view: true,
                    manage: true,
                    mention: true,
                    speakAs: true,
                    ...options.capabilities,
                },
            }),
        });
    });
}

/**
 * **按会话 id 通配**挂四类投影（任意 sessionId 都命中，含"直接按 URL 打开"的会话）。
 * `setupMockSessions` 默认调用它；单独的 spec 想覆盖某一条时，在它之后再 `page.route` 即可
 * （后注册者优先，且 `route.fallback()` 可回退到这里的桩）。
 */
export async function stubSessionProjectionsForAllSessions(
    page: Page,
    options: SessionProjectionOptions = {},
): Promise<void> {
    await page.route("**/api/v1/sessions/*/derived-state", async (route) => {
        const sessionId =
            new URL(route.request().url()).pathname.split("/").filter(Boolean).at(-2) ?? "";
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessionId, activeChildren: [], terminalNotices: [] }),
        });
    });
    await page.route("**/api/v1/sessions/*/follow-ups", async (route) => {
        const sessionId =
            new URL(route.request().url()).pathname.split("/").filter(Boolean).at(-2) ?? "";
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                sessionId,
                queueState: "empty",
                outstandingCount: 0,
                capacityLimit: 5,
                pauseReason: null,
                items: [],
            }),
        });
    });
    await page.route("**/api/v1/sessions/*/commands", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ commands: BUILTIN_COMMANDS }),
        });
    });
    await page.route("**/api/v1/sessions/*/participants", async (route) => {
        const participants = (options.participants ?? participantRoster()).map((seed) =>
            participantFixture(seed),
        );
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                participants,
                capabilities: {
                    view: true,
                    manage: true,
                    mention: true,
                    speakAs: true,
                    ...options.capabilities,
                },
            }),
        });
    });
}

/**
 * 外部字体请求的失败信号：`src/styles/main.css` 用 `@import` 拉 Google Fonts，离线/受限网络下
 * 浏览器会报 `net::ERR_CONNECTION_CLOSED`。既有的 "0 console error" 用法也用同一条放行
 * （`e2e/real/plan-0508-transport-telemetry.spec.ts:105`、`e2e/real/run-trace.spec.ts:348`）。
 * 它是**环境**信号，与本 lane 的判据无关；放行只针对这一个来源。
 */
export const FONT_ORIGIN_FAILURE = /fonts\.(googleapis|gstatic)\.com/;
