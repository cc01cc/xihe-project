import type {
    Session,
    SessionDerivedActiveStatus,
    SessionDerivedTerminalState,
} from "../../../types";
import type { DelegationUsageView } from "../../../composables/api";

/**
 * PLAN-0659 T1.4：**委派 DAG** 的纯投影（父→子会话有向图）。
 *
 * 数据来源刻意只用现有投影，不新造 wire：
 *  - 边/深度：sessions 列表的 `kind === "SPAWN"` + `spawnedFromSessionId`（PLAN-0655 的树同源）；
 *  - 状态：父会话的 derived-state（`activeChildren` / `terminalNotices`，PLAN-0408 契约）；
 *  - 预算：根会话的 `delegation-usage`（受该主体委派策略约束）。
 *
 * 不变式：
 *  - 只从**当前会话的祖先链顶端**建图（当前会话自己是 SPAWN 子会话时，图从它的 root 开始）；
 *  - 子节点必须同时「kind=SPAWN」且「parent 在本列表里」——脱离列表的孤儿不硬挂；
 *  - 节点上限（默认 50）显式截断并置 `truncated`，不静默丢节点（DAG 不能假装完整）。
 */
export interface DelegationNodeStatus {
    /** 该节点自身 run 的 id（来自父会话 derived-state 投影）。 */
    runId?: string;
    /** 在途状态（derived-state `activeChildren[].status`）。 */
    active?: SessionDerivedActiveStatus;
    /** 终态（derived-state `terminalNotices[].state`）。 */
    terminal?: SessionDerivedTerminalState;
    /** derived-state 给的任务名（`spawn task`），没有就退回 Session.title。 */
    name?: string | null;
}

export interface DelegationNode {
    sessionId: string;
    title: string;
    /** 从图根起算的深度（根 = 0）。 */
    depth: number;
    parentSessionId: string | null;
    spawnedAt: string | null;
    status?: DelegationNodeStatus;
}

export interface DelegationEdge {
    from: string;
    to: string;
}

export interface DelegationGraph {
    /** 图根：当前会话祖先链的顶端（没有祖先时就是当前会话）。 */
    rootSessionId: string;
    /** DFS 序（父在子前）；`depth` 从 0 起。 */
    nodes: DelegationNode[];
    edges: DelegationEdge[];
    maxDepth: number;
    /** 命中节点上限而截断（UI 必须显式告知）。 */
    truncated: boolean;
}

export interface BuildDelegationGraphInput {
    sessions: readonly Session[];
    currentSessionId: string;
    statusBySessionId?: ReadonlyMap<string, DelegationNodeStatus>;
    maxNodes?: number;
}

const DEFAULT_MAX_NODES = 50;

/** 当前会话在委派树里的根：沿 `spawnedFromSessionId` 向上走到不在列表里的那一层。 */
export function delegationRootOf(sessions: readonly Session[], currentSessionId: string): string {
    const byId = new Map(sessions.map((session) => [session.id, session]));
    let cursor = byId.get(currentSessionId);
    if (!cursor) return currentSessionId;
    const visited = new Set<string>([cursor.id]);
    while (cursor.spawnedFromSessionId) {
        const parent = byId.get(cursor.spawnedFromSessionId);
        // 父不在列表里（跨页/已删）⇒ 当前节点就是可见根。
        if (!parent) break;
        // 成环（数据坏了）⇒ 没有真正的根，按「当前会话就是根」处理（不在环上任意取舍）。
        if (visited.has(parent.id)) return currentSessionId;
        visited.add(parent.id);
        cursor = parent;
    }
    return cursor.id;
}

/** 委派图投影（纯函数；不读 store、不发请求）。 */
export function buildDelegationGraph(input: BuildDelegationGraphInput): DelegationGraph {
    const maxNodes = input.maxNodes ?? DEFAULT_MAX_NODES;
    const byId = new Map(input.sessions.map((session) => [session.id, session]));
    const rootSessionId = delegationRootOf(input.sessions, input.currentSessionId);

    const childrenByParent = new Map<string, Session[]>();
    for (const session of input.sessions) {
        if (session.kind !== "SPAWN" || !session.spawnedFromSessionId) continue;
        if (!byId.has(session.spawnedFromSessionId)) continue;
        const siblings = childrenByParent.get(session.spawnedFromSessionId) ?? [];
        siblings.push(session);
        childrenByParent.set(session.spawnedFromSessionId, siblings);
    }
    for (const siblings of childrenByParent.values()) {
        siblings.sort((a, b) => {
            const at = a.spawnedAt ?? a.createdAt,
                bt = b.spawnedAt ?? b.createdAt;
            return at === bt ? a.title.localeCompare(b.title) : at.localeCompare(bt);
        });
    }

    const nodes: DelegationNode[] = [];
    const edges: DelegationEdge[] = [];
    /** 环保护：同一会话只展开一次（脏数据不能让 DFS 不终止或节点爆掉）。 */
    const visited = new Set<string>();
    let truncated = false;
    const visit = (session: Session, depth: number, parentSessionId: string | null): void => {
        if (nodes.length >= maxNodes) {
            truncated = true;
            return;
        }
        if (visited.has(session.id)) return;
        visited.add(session.id);
        nodes.push({
            sessionId: session.id,
            title: session.title,
            depth,
            parentSessionId,
            spawnedAt: session.spawnedAt ?? null,
            ...(input.statusBySessionId?.has(session.id)
                ? { status: input.statusBySessionId.get(session.id) }
                : {}),
        });
        if (parentSessionId) edges.push({ from: parentSessionId, to: session.id });
        for (const child of childrenByParent.get(session.id) ?? []) {
            if (truncated) return;
            visit(child, depth + 1, session.id);
        }
    };

    const root = byId.get(rootSessionId);
    if (root) {
        visit(root, 0, null);
    } else {
        // 会话列表还没加载到当前会话：至少给出一个占位根，避免面板空白无解释。
        nodes.push({
            sessionId: rootSessionId,
            title: input.currentSessionId,
            depth: 0,
            parentSessionId: null,
            spawnedAt: null,
        });
    }

    return {
        rootSessionId,
        nodes,
        edges,
        maxDepth: nodes.reduce((max, node) => Math.max(max, node.depth), 0),
        truncated,
    };
}

/** 节点状态文案的 i18n key（复用既有 `derivedStateStatus/Outcome` 两套词汇，不造新词）。 */
export function delegationStatusLabelKey(status: DelegationNodeStatus | undefined): string | null {
    if (!status) return null;
    if (status.terminal) return `chat.derivedStateOutcome.${status.terminal}`;
    if (status.active) return `chat.derivedStateStatus.${status.active}`;
    return null;
}

/** 是否在途（决定节点状态点是否用「进行中」语气；未知不算在途）。 */
export function delegationStatusIsActive(status: DelegationNodeStatus | undefined): boolean {
    return Boolean(status?.active);
}

/**
 * 节点预算行：`已用/上限 · 深度 当前/上限`（delegation-usage 是**根会话**级别的额度，
 * 所有后代共享；因此只在根节点上展示，避免每个节点重复同一份数字）。
 */
export function formatDelegationBudget(usage: DelegationUsageView | null | undefined): string {
    if (!usage) return "";
    return `${usage.usedSessions}/${usage.maxCount} · ${usage.currentDepth}/${usage.maxDepth}`;
}
