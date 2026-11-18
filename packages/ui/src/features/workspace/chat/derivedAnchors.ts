import type {
    ChatRunResponse,
    Session,
    SessionDerivedActiveChild,
    SessionDerivedStateResponse,
    SessionDerivedTerminalNotice,
} from "../../../types";
import { runStatusOfDerivedChild } from "./runStateView";

/**
 * task-1 / D-1846：**派生态 anchor** 的纯投影（契约见 `spec/session/chat-session.md`
 * §派生态 anchor 消息投影）。
 *
 * 它回答一个问题：*主会话的对话流里，哪些「看不见的派生 run」应该以状态卡的形式出现在
 * 它**开始的那一刻**？* 答案是当前会话的 `kind=SPAWN` 子会话 —— 它们的 run 跑在另一个会话里，
 * 本线程只有终态回复（如果有）而没有过程。
 *
 * 数据来源刻意只用既有读面（不新增 wire，见契约 A1）：
 *  - 时间锚 + 标题 + 主体：`GET /sessions` 的 `Session`（`kind`/`spawnedFromSessionId`/`spawnedAt`）；
 *  - 状态 + terminalAt + runId：父会话 `GET /sessions/{id}/derived-state`；
 *  - 主体显示名：工作区主体名册（`agentPrincipalId → name`；不可得 ⇒ 由呈现层退化为 run 短码）。
 *
 * 三条不变式：
 *  - **位置只由 `startedAt` 决定**（durable），不随状态/消息变化而移动；
 *  - **身份 = runId ∨ childSessionId**，状态更新是同一 key 的重绘，不产生第二条 anchor；
 *  - 上限显式（默认 {@link MAX_DERIVED_RUN_ANCHORS}），保留最近 N 条并置 `truncated`，
 *    不静默丢弃。
 */
export interface DerivedRunAnchor {
    /** 行身份（就地更新键）：有 runId 用 runId，否则退回子会话 id。 */
    key: string;
    runId: string | null;
    /** 该 run 所在会话 = 点击导航目标（`Session.id`）。 */
    sessionId: string;
    /** 父会话（= 当前会话）；同会话 run 为 null（本投影不产出这一类）。 */
    spawnedFromSessionId: string | null;
    /** 时间锚：不可变，排序键。ISO 8601 UTC+Z。 */
    startedAt: string;
    agentPrincipalId: string | null;
    /** 主体显示名；不可得为 null（呈现层退化为短码，MUST NOT 上屏 UUID）。 */
    agentPrincipalName: string | null;
    /**
     * 任务名 = 子会话标题，**仅在它与父会话标题不同时**给出 —— 委派/spawn 的子会话默认继承父标题
     * （`ChatSubmissionService` 的 `new Session(…, parentSession.getTitle())`），
     * 重复同一个标题是纯噪音，此时返回 null。
     */
    subject: string | null;
    /** wire 状态（12 值之一，经 `runStateView#runStatusOfDerivedChild`）；未知 ⇒ null。 */
    status: ChatRunResponse["status"] | null;
    /** 终态时间（derived-state 给的 durable 值）；在途 ⇒ null。 */
    terminalAt: string | null;
}

/** 默认上限：`DelegationPolicyValidator` 的 8×3 预算最坏情况（契约 A4.5）。 */
export const MAX_DERIVED_RUN_ANCHORS = 24;

export interface BuildDerivedRunAnchorsInput {
    currentSessionId: string;
    /** 会话列表（`sessionStore.sessions`）；不要求按任何顺序。 */
    sessions: readonly Session[];
    /** 父会话的 derived-state；还没加载到 ⇒ null（此时 anchor 全部「无状态」，不是「已完成」）。 */
    derivedState: SessionDerivedStateResponse | null;
    /** `agentPrincipalId → 显示名`；缺省则该字段为 null。 */
    principalNames?: ReadonlyMap<string, string> | null;
    /** 覆盖默认上限（测试/嵌入方用）。 */
    maxAnchors?: number;
}

export interface DerivedRunAnchorsResult {
    /** 已按 `startedAt` 升序；长度 ≤ 上限。 */
    anchors: DerivedRunAnchor[];
    /** 命中上限而被折叠掉的条数（0 = 未截断）。 */
    hiddenCount: number;
}

function isUsableTimestamp(value: string | null | undefined): value is string {
    return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

/** anchor 的时间锚：`spawnedAt` 优先，缺失回落 `createdAt`；两者都不可用 ⇒ null（不猜）。 */
function startAnchorOf(session: Session): string | null {
    if (isUsableTimestamp(session.spawnedAt)) return session.spawnedAt;
    if (isUsableTimestamp(session.createdAt)) return session.createdAt;
    return null;
}

function indexActive(
    derivedState: SessionDerivedStateResponse | null,
): Map<string, SessionDerivedActiveChild> {
    const byChild = new Map<string, SessionDerivedActiveChild>();
    for (const child of derivedState?.activeChildren ?? []) {
        // 同一子会话可能同时出现在两个列表（终态写入与在途读的竞态）⇒ 在途优先、先到先得。
        if (!byChild.has(child.childSessionId)) byChild.set(child.childSessionId, child);
    }
    return byChild;
}

function indexTerminal(
    derivedState: SessionDerivedStateResponse | null,
): Map<string, SessionDerivedTerminalNotice> {
    const byChild = new Map<string, SessionDerivedTerminalNotice>();
    for (const notice of derivedState?.terminalNotices ?? []) {
        if (!byChild.has(notice.childSessionId)) byChild.set(notice.childSessionId, notice);
    }
    return byChild;
}

/**
 * 当前会话的**直接** `kind=SPAWN` 子会话（不含孙辈：父会话的 derived-state 只投影直接子会话，
 * 孙辈由各自父会话的 anchor 负责）。
 */
export function spawnChildrenOf(sessions: readonly Session[], currentSessionId: string): Session[] {
    if (!currentSessionId) return [];
    return sessions.filter(
        (session) =>
            session.kind === "SPAWN" &&
            session.spawnedFromSessionId === currentSessionId &&
            session.id !== currentSessionId,
    );
}

/** 父会话标题（用于判断子会话标题是否只是继承来的重复）。 */
function titleOf(sessions: readonly Session[], sessionId: string): string | null {
    const row = sessions.find((session) => session.id === sessionId);
    const title = row?.title?.trim();
    return title || null;
}

/**
 * 派生 anchor 投影（纯函数；不读 store、不发请求、不取当前时间）。
 *
 * 排序：`startedAt` 升序，同一时刻按 `sessionId` 升序（确定性 ⇒ 刷新后位置不变）。
 * 上限：超出时保留**最近** `maxAnchors` 条（老 anchor 被折叠并计入 `hiddenCount`）。
 */
export function buildDerivedRunAnchors(
    input: BuildDerivedRunAnchorsInput,
): DerivedRunAnchorsResult {
    const maxAnchors = Math.max(1, input.maxAnchors ?? MAX_DERIVED_RUN_ANCHORS);
    const activeByChild = indexActive(input.derivedState);
    const terminalByChild = indexTerminal(input.derivedState);
    const parentTitle = titleOf(input.sessions, input.currentSessionId);

    const anchors: DerivedRunAnchor[] = [];
    for (const child of spawnChildrenOf(input.sessions, input.currentSessionId)) {
        // 没有可用时间锚就不猜：不可排序的 anchor 会挂到流末尾，正是本卡要避免的行为。
        const startedAt = startAnchorOf(child);
        if (!startedAt) continue;

        const active = activeByChild.get(child.id);
        const terminal = terminalByChild.get(child.id);
        const runId = active?.runId ?? terminal?.runId ?? null;
        const principalId = child.agentPrincipalId ?? null;
        const subject = child.title?.trim();
        anchors.push({
            key: runId ?? child.id,
            runId,
            sessionId: child.id,
            spawnedFromSessionId: child.spawnedFromSessionId ?? null,
            startedAt,
            agentPrincipalId: principalId,
            agentPrincipalName:
                (principalId ? input.principalNames?.get(principalId) : null) ?? null,
            // 继承来的父标题不算任务名（契约 A1/呈现规则：不制造噪音，可区分性靠主体名/短码）。
            subject: subject && subject !== parentTitle ? subject : null,
            status: runStatusOfDerivedChild(active?.status, terminal?.state),
            terminalAt: isUsableTimestamp(terminal?.terminalAt) ? terminal.terminalAt : null,
        });
    }

    anchors.sort((left, right) => {
        const byTime = Date.parse(left.startedAt) - Date.parse(right.startedAt);
        return byTime === 0 ? left.sessionId.localeCompare(right.sessionId) : byTime;
    });

    const hiddenCount = Math.max(0, anchors.length - maxAnchors);
    return {
        // 保留**最近** N 条（用户在长会话里最关心刚发生的那几次派发）。
        anchors: hiddenCount > 0 ? anchors.slice(hiddenCount) : anchors,
        hiddenCount,
    };
}
