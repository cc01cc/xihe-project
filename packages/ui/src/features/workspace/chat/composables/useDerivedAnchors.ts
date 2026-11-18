import { computed, shallowRef, watch } from "vue";
import { api } from "../../../../composables/api";
import { logger } from "../../../../lib/logger";
import { useAuthStore } from "../../../../stores/auth";
import { useSessionStore } from "../../../../stores/session";
import type { SessionDerivedStateResponse } from "../../../../types";
import {
    buildDerivedRunAnchors,
    type DerivedRunAnchor,
    type DerivedRunAnchorsResult,
} from "../derivedAnchors";

/**
 * task-1 / D-1846：派生态 anchor 的**接线层**（读投影的取数与刷新）。
 *
 * 纯投影在 `derivedAnchors.ts`（可单测），这里只做三件事：
 *  1. 保证会话列表已加载（`kind=SPAWN` 的边/标题/时间锚来自 `GET /sessions`）；
 *  2. 取一次工作区主体名册（`agentPrincipalId → name`，用于区分多主体；失败即降级为短码）；
 *  3. 把父会话的 derived-state（调用方已经维护、SSE 驱动）并入投影。
 *
 * 刷新语义（契约 A2）：**不新增轮询/定时器**。状态变化的驱动仍是既有 SSE 链
 * （`derived_state_changed` / `spawn_agent` ⇒ 调用方重读 derived-state），本 composable 只是
 * `computed` 的消费者 —— derived-state 变了，anchor 就地重绘（key 不变 ⇒ 不会产生第二条）。
 *
 * 失败策略：名册/会话列表读不到时**退回结构化输入**（名册空表 ⇒ 呈现层用短码；会话列表读不到
 * ⇒ 没有 anchor，而不是伪造 anchor），并各记一条 warn，不静默。
 */
export function useDerivedAnchors(options: {
    sessionId: () => string;
    /** 父会话的 derived-state（ChatPanel 已持有；null = 还没加载到）。 */
    derivedState: () => SessionDerivedStateResponse | null;
}) {
    const sessionStore = useSessionStore();
    const authStore = useAuthStore();

    /** `agentPrincipalId → 显示名`；空表 = 名册不可得（呈现层退化，不报错）。 */
    const principalNames = shallowRef<ReadonlyMap<string, string>>(new Map());

    let sessionsRequest: Promise<void> | null = null;
    let namesRequest: Promise<void> | null = null;
    let namesWorkspaceId: string | null = null;
    /**
     * 已经为哪些「derived-state 里有、会话列表里没有」的子会话触发过补拉。
     *
     * spawn 刚发生时 `GET /sessions` 的那份列表还是旧的：derived-state 已经报出新子会话，
     * 但空列表没有它的 `spawnedAt`（= 时间锚）。这里做**一次**按需补拉（不是轮询）：
     * 补到就正常出 anchor；补不到（已删/无权）就记账，不再对同一个 id 反复请求。
     */
    const attemptedChildFetches = new Set<string>();

    function loadSessionsQuietly(): void {
        if (sessionsRequest) return;
        sessionsRequest = sessionStore
            .loadSessions()
            .then(() => undefined)
            .catch((cause) => {
                // 读不到会话列表 ⇒ 没有 anchor（不伪造）；下一次会话切换会再试。
                logger.warn("failed to load sessions for derived anchors", cause);
            })
            .finally(() => {
                sessionsRequest = null;
            });
    }

    function ensureSessions(): void {
        if (sessionStore.sessions.length > 0) return;
        loadSessionsQuietly();
    }

    /** derived-state 提到的子会话 id（两条轴合并；顺序无关）。 */
    function derivedChildIds(): string[] {
        const derived = options.derivedState();
        if (!derived) return [];
        return [
            ...derived.activeChildren.map((child) => child.childSessionId),
            ...derived.terminalNotices.map((notice) => notice.childSessionId),
        ];
    }

    function ensurePrincipalNames(): void {
        const workspaceId = authStore.currentWorkspaceId;
        if (!workspaceId || namesWorkspaceId === workspaceId || namesRequest) return;
        namesRequest = api
            .getWorkspaceAgents(workspaceId)
            .then((agents) => {
                const next = new Map<string, string>();
                for (const agent of agents ?? []) {
                    if (agent.principalId && agent.name) next.set(agent.principalId, agent.name);
                }
                principalNames.value = next;
                namesWorkspaceId = workspaceId;
            })
            .catch((cause) => {
                // 名册是**显示**增强：失败保持空表（短码仍能区分主体），并留痕。
                logger.warn("failed to load agent principal names for derived anchors", cause);
            })
            .finally(() => {
                namesRequest = null;
            });
    }

    watch(
        () => [options.sessionId(), authStore.currentWorkspaceId] as const,
        () => {
            attemptedChildFetches.clear();
            if (!options.sessionId()) return;
            ensureSessions();
            ensurePrincipalNames();
        },
        { immediate: true },
    );

    // 新派生的子会话：derived-state 已知而会话列表尚未包含 ⇒ 按需补一次列表（拿到时间锚）。
    watch(
        () => derivedChildIds(),
        (childIds) => {
            if (childIds.length === 0) return;
            const known = new Set(sessionStore.sessions.map((session) => session.id));
            const missing = childIds.filter(
                (id) => !known.has(id) && !attemptedChildFetches.has(id),
            );
            if (missing.length === 0) return;
            for (const id of missing) attemptedChildFetches.add(id);
            loadSessionsQuietly();
        },
        { immediate: true },
    );

    const result = computed<DerivedRunAnchorsResult>(() => {
        const currentSessionId = options.sessionId();
        if (!currentSessionId) return { anchors: [], hiddenCount: 0 };
        return buildDerivedRunAnchors({
            currentSessionId,
            sessions: sessionStore.sessions,
            derivedState: options.derivedState(),
            principalNames: principalNames.value,
        });
    });

    const anchors = computed<readonly DerivedRunAnchor[]>(() => result.value.anchors);
    const hiddenCount = computed(() => result.value.hiddenCount);

    /** 手动重取（会话切换已自动；这里给「名册过期」这类显式刷新留一个入口）。 */
    async function refresh(): Promise<void> {
        namesWorkspaceId = null;
        principalNames.value = new Map();
        ensurePrincipalNames();
        if (sessionStore.sessions.length === 0) ensureSessions();
        await Promise.resolve();
    }

    return { anchors, hiddenCount, refresh };
}
