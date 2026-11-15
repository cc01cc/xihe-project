import type { Page } from "@playwright/test";

/**
 * task-161：审批「待决摘要」的**派生表**。
 *
 * ## 为什么需要它（根因，不是补一个空数组）
 * 客户端 `GET /api/v1/approvals/pending` 的返回值是**对账依据**：`src/stores/agent.ts:306-323`
 * `reconcilePendingApprovals` 会把「本会话不在摘要里 / count=0」的本地审批卡**直接撤掉**
 * （`removeApprovalRequest(..., "dispatch_unknown")`）。所以这个端点恒回 `[]` 不是"空数据"，
 * 而是一句**断言**：「CP 认为没有任何待决审批」—— 于是 SSE 刚推进来的卡在一个轮询周期内就被撤掉，
 * 后续点击必然撞上 `element is not detached from the DOM`。实测症状与证据见 `task-151`。
 *
 * ## 派生源（唯一）：`pushMockApproval` 推进 SSE 的那一刻
 * 审批事件是 spec 在**页面内**用自建 `ReadableStream` 推的（`addInitScript` 覆盖 `window.fetch`），
 * `page.route` 层根本看不到它们 —— 所以本表**不能**靠监听网络，只能由"谁推谁登记"来喂：
 * `pushMockApproval(page, event)` = 登记到本表 + 页面内 `__pushApprovalEvent(payload)` 两件事一起做。
 * 这样"CP 说有几条待决"与"客户端收到过几条"来自**同一个动作**，不是两份清单。
 *
 * ## 什么会让一条记录不再是 pending
 * 决定请求成功（`POST /api/v1/chat/approvals/{requestId}/decision` 的响应 `status < 400`）。
 * 失败（如 410 已过期）**保留**记录 —— 卡还在界面上要给用户看错误，这是产品行为（`approval.spec:608`）。
 */

/** 与 `src/types/index.ts:597-602` 的 `PendingApprovalSummary` 同形；wire 侧以该类型为准。 */
export interface MockPendingApprovalSummary {
    sessionId: string;
    workspaceId: string;
    count: number;
    oldestRequestedAt: string;
}

/** SSE `approval_request` 事件里本表关心的字段（其余字段原样透传给页面）。 */
export interface MockApprovalEvent {
    requestId: string;
    sessionId: string;
    workspaceId: string;
    /** 事件里的接收时刻；缺省取登记时刻。真实 CP 报的是「最早一条待决的接收时间」。 */
    requestedAt?: string;
}

export interface MockApprovalRecord {
    requestId: string;
    sessionId: string;
    workspaceId: string;
    requestedAt: string;
    state: "pending" | "decided";
}

export interface MockApprovalRegistry {
    record(event: MockApprovalEvent): void;
    decide(requestId: string): void;
    summaries(): MockPendingApprovalSummary[];
    size(): number;
    pendingIds(): string[];
}

/** 决定请求路径：`/api/v1/chat/approvals/{requestId}/decision`（`src/composables/api.ts:4565`）。 */
const DECISION_PATH = /^\/api\/v1\/chat\/approvals\/([^/]+)\/decision$/;

export function parseApprovalDecisionPath(pathname: string): string | null {
    const match = DECISION_PATH.exec(pathname);
    return match ? decodeURIComponent(match[1]!) : null;
}

export function createApprovalRegistry(): MockApprovalRegistry {
    const records = new Map<string, MockApprovalRecord>();
    return {
        record(event) {
            // 同一 requestId 重复推送（重连重放）用**首次**接收时间：真实 CP 的
            // `oldestRequestedAt` 也不会因为重放而变新。
            const existing = records.get(event.requestId);
            records.set(event.requestId, {
                requestId: event.requestId,
                sessionId: event.sessionId,
                workspaceId: event.workspaceId,
                requestedAt: existing?.requestedAt ?? event.requestedAt ?? new Date().toISOString(),
                state: existing?.state === "decided" ? "decided" : "pending",
            });
        },
        decide(requestId) {
            const record = records.get(requestId);
            if (record) record.state = "decided";
        },
        summaries() {
            const grouped = new Map<string, MockPendingApprovalSummary>();
            for (const record of records.values()) {
                if (record.state !== "pending") continue;
                const key = `${record.workspaceId}\u0000${record.sessionId}`;
                const existing = grouped.get(key);
                if (!existing) {
                    grouped.set(key, {
                        sessionId: record.sessionId,
                        workspaceId: record.workspaceId,
                        count: 1,
                        oldestRequestedAt: record.requestedAt,
                    });
                    continue;
                }
                existing.count += 1;
                if (record.requestedAt < existing.oldestRequestedAt) {
                    existing.oldestRequestedAt = record.requestedAt;
                }
            }
            return [...grouped.values()];
        },
        size() {
            return records.size;
        },
        pendingIds() {
            return [...records.values()]
                .filter((record) => record.state === "pending")
                .map((record) => record.requestId);
        },
    };
}

const registryByPage = new WeakMap<Page, MockApprovalRegistry>();

/**
 * 每页一张表（同一 Page 上重复 `setupMockAuth` 不重置 —— 与 `mockRunsFor` 同一取舍：
 * 表记录的是"这个页面见过什么"，不是"这次 setup 的新表"）。
 */
export function mockApprovalsFor(page: Page): MockApprovalRegistry {
    const existing = registryByPage.get(page);
    if (existing) return existing;
    const registry = createApprovalRegistry();
    registryByPage.set(page, registry);
    return registry;
}

/**
 * 在**网络层**观察决定请求的成败（不拦截：spec 自己的 route 决定响应）。
 * 成功才把记录标成 decided；410/500 等失败保留 pending —— 那是"卡还在、要给错误"的产品形态。
 */
export async function installApprovalRegistry(page: Page): Promise<void> {
    const registry = mockApprovalsFor(page);
    page.on("response", (response) => {
        const request = response.request();
        if (request.method() !== "POST") return;
        const requestId = parseApprovalDecisionPath(new URL(response.url()).pathname);
        if (!requestId) return;
        if (response.status() < 400) registry.decide(requestId);
    });
}

/**
 * 推一条审批事件：**先登记、再推给页面**。
 * @param event 事件里必须带 `requestId/sessionId/workspaceId`（SSE `approval_request` 三者都是必填）；
 *              其余字段（tool/action/policy/expiresAt/state…）原样透传。
 */
export async function pushMockApproval(
    page: Page,
    event: Record<string, unknown> & MockApprovalEvent,
): Promise<void> {
    mockApprovalsFor(page).record(event);
    await page.evaluate((payload) => {
        const push = (window as unknown as Record<string, unknown>).__pushApprovalEvent as
            | ((data: unknown) => void)
            | undefined;
        if (!push) {
            throw new Error(
                "[mock-approval] 页面内没有 __pushApprovalEvent —— 该 spec 没有安装审批 SSE 通道" +
                    "（见 approval.spec / plan-0631-color.spec / policy-management.spec 的 installApprovalSSE）。",
            );
        }
        push(payload);
    }, event);
}
