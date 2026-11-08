import {
    computed,
    getCurrentInstance,
    onBeforeUnmount,
    ref,
    toValue,
    watch,
    type MaybeRefOrGetter,
} from "vue";
import {
    ApiError,
    apiErrorFromResponse,
    normalizeWorkspaceEvent,
    workspaceHeaders,
} from "../../../composables/api";
import { logger } from "@/lib/logger";
import { chatTransport } from "@/services/chatTransport";
import type { WorkspaceEvent } from "@/types";
import {
    useSharedEventLeader,
    type SharedLeaderConnectionContext,
    type SharedLeaderDeps,
} from "../../../composables/useSharedEventLeader";
import {
    clearSseSubscriberLimit,
    reportSseSubscriberLimit,
    useSseSubscriberLimit,
} from "./sseSubscriberLimit";

export interface WorkspaceSSEOptions {
    onEvent?: (event: WorkspaceEvent) => void | Promise<void>;
    /**
     * PLAN-0676 T2：可选的连接身份标注头 `X-Workspace-SSE-Client`。
     * 默认不发（`undefined`）。**纯身份、不参与授权、不改变配额**——它只用于 CLI / 桌面浮窗 /
     * 排障时区分来源，服务端也不得据此放宽任何门。
     */
    clientTag?: string;
    /**
     * 测试缝：把 leader 层的浏览器依赖（locks/storage/channel/clock）注进来，用来覆盖
     * "无 Web Locks 降级"、"无 BroadcastChannel 退化"、"并发两页只开一条连接" 等分支。
     * 生产调用方不传。
     */
    leaderDeps?: SharedLeaderDeps;
}

/** 横幅三态（`SseSubscriberLimitNotice` 的 `state`）；`null` = 不显示。 */
export type WorkspaceSseNoticeState = "limit" | "disconnected" | "reconnecting" | null;

/**
 * PLAN-0691 T1.6-C1：插件绑定事件 kind（attach / detach）。
 *
 * <p>**跨 lane 的 wire 字面量**：与 CP `WorkspaceEventManager.KIND_PLUGIN_BINDING`、lane A
 * 的 binding 端点共用同一个字符串 `plugin_binding`，测试里钉死了它——改名必须让测试红，
 * 而不是让两侧静默错位。</p>
 *
 * <p>漏登记的最坏后果（双向）：CP 侧没进 `validateKind` 白名单 ⇒ publish 抛 400
 * `INVALID_REQUEST`，而调用方通常**已经提交了绑定事务**（attach 已落库）⇒ 数据变了、界面
 * 不刷新，用户看到的是卡住的 pending 插件而不是校验错误；UI 侧没进 `workspaceEventKinds`
 * ⇒ 事件在 `normalizeWorkspaceEvent` 被丢弃，症状一模一样（只剩一条 warn）。所以两侧的
 * 白名单都要与发布方同批，顺序不能反。</p>
 */
export const PLUGIN_BINDING_EVENT_KIND = "plugin_binding";

/**
 * Workspace-scoped SSE subscription.
 *
 * <p>PLAN-0676 T2：本 composable 不再自己建连接，而是把"谁持有连接"交给
 * `useSharedEventLeader`（同一 workspace 的多个标签页共享一条上游 SSE，其余标签页经
 * `BroadcastChannel` 收同一份事件）。这样 CP 侧的"每 workspace 8 条订阅"重新变成"用户数"
 * 而不是"标签页数"，复制标签页不再把自己挤出额度（BL-332）。</p>
 *
 * <p>语义保持：事件仍是归一化后的 `WorkspaceEvent`，`snapshot_required` 仍然只表示"拉全量"
 * （`stores/workspace.ts` 与 `stores/scheduledTasks.ts` 已按此消费）；序列缺口同样合成一条
 * `snapshot_required` 交给上层，绝不从 0 重放。</p>
 */
export function useWorkspaceSSE(
    workspaceId: MaybeRefOrGetter<string | null | undefined>,
    options: WorkspaceSSEOptions = {},
) {
    const connectionError = ref<string | null>(null),
        /** BL-335：`connectionError` 的 problem code（例如 `WORKSPACE_EVENT_SUBSCRIBERS_LIMIT`）。 */
        connectionErrorCode = ref<string | null>(null);

    const { isActive: limitActive } = useSseSubscriberLimit();
    let activeWorkspaceId: string | null = null;

    /**
     * PLAN-0691 T1.6-C1：最近一条 `plugin_binding` 事件的序列号（`null` = 还没收到过）。
     *
     * <p>它是"绑定目录变了"的单调事实源：消费方（会话插件面板）看到它前进就重新拉
     * `GET /api/v1/sessions/{sessionId}/plugins`，**不解析事件体**——binding 细分字段
     * （`bindingId`/`action`/`revision`/`catalogVersion`）尚未进 `WorkspaceEvent` 信封
     * （T1.6 持久化那步裁定，B 类），这里不猜字段形状。</p>
     */
    const pluginBindingRevision = ref<number | null>(null);

    const channelKey = computed(() => {
        const id = toValue(workspaceId);
        return id ? `ws:${id}` : null;
    });

    /** 把一条"请拉全量"的信号交给上层；`reason` 进日志与事件里，便于区分来源。 */
    function requestFullRefresh(reason: string) {
        const id = activeWorkspaceId;
        if (!id) {
            return;
        }
        logger.warn("workspace_sse_full_refresh", { workspaceId: id, reason });
        void options.onEvent?.({
            workspaceId: id,
            sequence: leader.lastSeq.value,
            kind: "snapshot_required",
            // 保持历史来源串：序列缺口是 `ui-sequence-gap`（老断言依赖它），其余合成刷新标明来源。
            source: reason === "gap" ? "ui-sequence-gap" : "ui-full-refresh",
            reason,
        });
    }

    function upstreamConnect(context: SharedLeaderConnectionContext) {
        const id = activeWorkspaceId;
        if (!id) {
            return { close: () => undefined };
        }
        const key = `workspace:${id}`;
        const headers: Record<string, string> = {
            ...workspaceHeaders(id),
            Accept: "text/event-stream",
        };
        if (options.clientTag) {
            headers["X-Workspace-SSE-Client"] = options.clientTag;
        }
        connectionError.value = null;
        connectionErrorCode.value = null;
        void chatTransport
            .sendMessages(key, {
                url: `/api/v1/workspaces/${encodeURIComponent(id)}/events`,
                headers,
                onopen: async (response) => {
                    if (!response.ok) {
                        // BL-335：非 2xx 是在 `onopen` 里抛出的，**不会**落到 `sendMessages` 的
                        // `.catch`（异步 onopen 的 throw 会被 transport 吞掉）。就地记录 code 并
                        // 上报横幅，再按原语义抛给 transport。
                        try {
                            await apiErrorFromResponse(response);
                        } catch (error) {
                            connectionError.value =
                                error instanceof Error ? error.message : String(error);
                            if (error instanceof ApiError) {
                                connectionErrorCode.value = error.problem.code ?? null;
                                reportSseSubscriberLimit(error.problem.code, key);
                            }
                            throw error;
                        }
                    }
                    context.setConnected(true);
                    connectionError.value = null;
                    connectionErrorCode.value = null;
                    // BL-335：重新连上 ⇒ 之前的订阅上限提示作废（否则横幅会一直挂着）。
                    clearSseSubscriberLimit(undefined, key);
                },
                onmessage: async (message) => {
                    if (activeWorkspaceId !== id) return;
                    let payload: unknown;
                    try {
                        payload = JSON.parse(message.data) as unknown;
                    } catch (error) {
                        logger.warn("workspace_sse_invalid_json", {
                            workspaceId: id,
                            event: message.event,
                            error,
                        });
                        return;
                    }
                    const event = normalizeWorkspaceEvent(payload, id, message.event);
                    if (!event) {
                        logger.warn("workspace_sse_invalid_event", {
                            workspaceId: id,
                            event: message.event,
                        });
                        return;
                    }
                    // 去重 / 缺口判定 / 扇出到其它标签页都交给 leader 层（它按 sequence 单调处理，
                    // 并在缺口处回调 onResync ⇒ requestFullRefresh）。
                    context.emit(event);
                },
                onerror: (error) => {
                    if (activeWorkspaceId !== id) return;
                    context.setConnected(false);
                    connectionError.value = error.message;
                    if (error instanceof ApiError) {
                        connectionErrorCode.value = error.problem.code ?? null;
                        reportSseSubscriberLimit(error.problem.code, key);
                    }
                },
                onclose: () => {
                    if (activeWorkspaceId !== id) return;
                    context.setConnected(false);
                },
            })
            .catch((error: unknown) => {
                if (activeWorkspaceId !== id) return;
                context.setConnected(false);
                connectionError.value = error instanceof Error ? error.message : String(error);
                // BL-335：把 problem code 留住（原来只存 message，429 的具体码被丢掉）。
                if (error instanceof ApiError) {
                    connectionErrorCode.value = error.problem.code ?? null;
                    reportSseSubscriberLimit(error.problem.code, key);
                }
            });
        return {
            close: () => chatTransport.stop(key),
        };
    }

    const leader = useSharedEventLeader<WorkspaceEvent>(channelKey, upstreamConnect, {
        sequenceOf: (event) => event.sequence,
        onEvent: (event) => {
            if (event.kind === PLUGIN_BINDING_EVENT_KIND) {
                // 只推进序列号，不解析 payload（见 `pluginBindingRevision` 的注释）。
                pluginBindingRevision.value = event.sequence;
            }
            void options.onEvent?.(event);
        },
        onResync: (reason) => requestFullRefresh(reason),
        logTag: "workspace_sse",
        deps: options.leaderDeps,
    });

    const isConnecting = computed(
        () =>
            leader.role.value === "acquiring" ||
            (leader.role.value === "leader" && !leader.isConnected.value),
    );

    const noticeState = computed<WorkspaceSseNoticeState>(() => {
        if (limitActive.value) {
            return "limit";
        }
        if (
            leader.role.value === "acquiring" ||
            (leader.role.value === "follower" && !leader.isConnected.value)
        ) {
            return "reconnecting";
        }
        if (connectionError.value) {
            return "disconnected";
        }
        return null;
    });

    watch(
        () => toValue(workspaceId),
        (nextId) => {
            activeWorkspaceId = nextId ?? null;
            leader.stop();
            if (nextId) {
                leader.start();
            }
        },
        { immediate: true },
    );

    if (getCurrentInstance()) {
        onBeforeUnmount(() => leader.stop());
    }

    return {
        /** leader 家族自身已连上；follower 由"近期收到 peer 心跳"派生（空窗必降级）。 */
        isConnected: leader.isConnected,
        isConnecting,
        connectionError,
        connectionErrorCode,
        lastSequence: leader.lastSeq,
        /** PLAN-0691 T1.6-C1：最近一条 `plugin_binding` 事件的序列号（`null` = 未收到过）。 */
        pluginBindingRevision,
        role: leader.role,
        noticeState,
        flapCount: leader.flapCount,
        /** 横幅的"重试"：重选 leader 并重建上游（follower 侧等价于请 leader 重连）。 */
        retry: () => {
            leader.stop();
            leader.start();
        },
        stop: () => leader.stop(),
    };
}
