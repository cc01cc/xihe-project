import { onBeforeUnmount, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import {
    ApiError,
    apiErrorFromResponse,
    normalizeWorkspaceEvent,
    workspaceHeaders,
} from "../../../composables/api";
import { logger } from "@/lib/logger";
import { chatTransport } from "@/services/chatTransport";
import type { WorkspaceEvent } from "@/types";
import { clearSseSubscriberLimit, reportSseSubscriberLimit } from "./sseSubscriberLimit";

export interface WorkspaceSSEOptions {
    onEvent?: (event: WorkspaceEvent) => void | Promise<void>;
}

/**
 * Workspace-scoped SSE subscription. This intentionally uses the existing
 * transport's lifecycle/reconnect machinery with a distinct key; Chat SSE
 * parsing and stores remain separate from Workspace file events.
 */
export function useWorkspaceSSE(
    workspaceId: MaybeRefOrGetter<string | null | undefined>,
    options: WorkspaceSSEOptions = {},
) {
    const isConnected = ref(false),
        isConnecting = ref(false),
        connectionError = ref<string | null>(null),
        /** BL-335：`connectionError` 的 problem code（例如 `WORKSPACE_EVENT_SUBSCRIBERS_LIMIT`）。 */
        connectionErrorCode = ref<string | null>(null),
        lastSequence = ref(0);
    let activeKey: string | null = null,
        activeWorkspaceId: string | null = null;

    function stop(key = activeKey) {
        if (key) chatTransport.stop(key);
        if (key === activeKey || !key) {
            activeKey = null;
            activeWorkspaceId = null;
            isConnected.value = false;
            isConnecting.value = false;
        }
    }

    function start(id: string) {
        const key = `workspace:${id}`;
        activeKey = key;
        activeWorkspaceId = id;
        lastSequence.value = 0;
        connectionError.value = null;
        isConnecting.value = true;
        void chatTransport
            .sendMessages(key, {
                url: `/api/v1/workspaces/${encodeURIComponent(id)}/events`,
                headers: {
                    ...workspaceHeaders(id),
                    Accept: "text/event-stream",
                },
                onopen: async (response) => {
                    if (!response.ok) {
                        // BL-335：非 2xx 是在 `onopen` 里抛出的，**不会**落到下面 `sendMessages` 的
                        // `.catch`（异步 onopen 的 throw 会被 transport 吞掉）。所以这里就地记录
                        // code + 上报横幅，再按原语义抛给 transport。
                        try {
                            await apiErrorFromResponse(response);
                        } catch (error) {
                            connectionError.value =
                                error instanceof Error ? error.message : String(error);
                            if (error instanceof ApiError) {
                                connectionErrorCode.value = error.problem.code ?? null;
                                reportSseSubscriberLimit(error.problem.code);
                            }
                            throw error;
                        }
                    }
                    isConnected.value = true;
                    isConnecting.value = false;
                    connectionError.value = null;
                    connectionErrorCode.value = null;
                    // BL-335：重新连上 ⇒ 之前的订阅上限提示作废（否则横幅会一直挂着）。
                    clearSseSubscriberLimit();
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
                    if (
                        event.kind !== "snapshot_required" &&
                        event.sequence > lastSequence.value + 1 &&
                        lastSequence.value > 0
                    ) {
                        logger.warn("workspace_sse_sequence_gap", {
                            workspaceId: id,
                            previousSequence: lastSequence.value,
                            receivedSequence: event.sequence,
                        });
                        await options.onEvent?.({
                            workspaceId: id,
                            sequence: event.sequence,
                            kind: "snapshot_required",
                            source: "ui-sequence-gap",
                            reason: event.reason ?? "sequence_gap",
                        });
                    }
                    lastSequence.value = Math.max(lastSequence.value, event.sequence);
                    await options.onEvent?.(event);
                },
                onerror: (error) => {
                    if (activeWorkspaceId !== id) return;
                    isConnected.value = false;
                    isConnecting.value = false;
                    connectionError.value = error.message;
                    // BL-335：非 2xx 是在 **transport 的 onopen** 里抛的（`chatTransport.sendMessages`
                    // 先调 `apiErrorFromResponse(response)`，成功后才调我们的 `onopen`），所以
                    // problem code **只能**在 `onerror` 拿到；不要把这段搬到 `onopen`（那里根本进不来）。
                    // 该实现约束由 `e2e/mock/bl335-sse-limit-notice.spec.ts` 的"工作区事件 429"用例钉住。
                    if (error instanceof ApiError) {
                        connectionErrorCode.value = error.problem.code ?? null;
                        reportSseSubscriberLimit(error.problem.code);
                    }
                },
                onclose: () => {
                    if (activeWorkspaceId !== id) return;
                    isConnected.value = false;
                    isConnecting.value = false;
                },
            })
            .catch((error: unknown) => {
                if (activeWorkspaceId !== id) return;
                isConnected.value = false;
                isConnecting.value = false;
                connectionError.value = error instanceof Error ? error.message : String(error);
                // BL-335：把 problem code 留住（原来只存 message，429 的具体码被丢掉），
                // 命中"订阅者上限"时上报给壳级横幅，让用户看到"停止刷新 + 关标签页"的指引。
                if (error instanceof ApiError) {
                    connectionErrorCode.value = error.problem.code ?? null;
                    reportSseSubscriberLimit(error.problem.code);
                }
            });
    }

    watch(
        () => toValue(workspaceId),
        (nextId, previousId) => {
            if (previousId && previousId !== nextId) stop(`workspace:${previousId}`);
            if (nextId) start(nextId);
            else stop();
        },
        { immediate: true },
    );

    onBeforeUnmount(() => stop());

    return {
        isConnected,
        isConnecting,
        connectionError,
        connectionErrorCode,
        lastSequence,
        stop,
    };
}
