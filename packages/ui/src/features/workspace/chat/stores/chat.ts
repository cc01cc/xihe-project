import { defineStore } from "pinia";
import { ref } from "vue";
import type {
    ChatRunUsage,
    ChatSessionRunState,
    Message,
    MessagePart,
    ToolCall,
} from "../../../../types";
import { ApiError, api, type ApiSessionBranch } from "../../../../composables/api";
import { logger } from "../../../../lib/logger";
import type { AgentContextTruncation } from "../composables/useSSE";
import { useAgentStore } from "../../../../stores/agent";

export const XIHE_STORAGE_KEYS = ["xihe-token", "xihe-user", "xihe-workspace"] as const;

// PLAN-292 M3 (C3): recovery banner states — resumed (run still alive
// server-side, approvals replayable) / cancelled (terminal, nothing running)
// / retry (lease expired or status unknown) / failed (PLAN-0493: terminal with
// a guard-caused errorCode, message carries the reason + takeover hint).
// 'succeeded' runs set no banner.
export type RunRecoveryState = "resumed" | "cancelled" | "retry" | "failed";

export interface RunRecovery {
    state: RunRecoveryState;
    runId: string;
    message: string;
}

/**
 * PLAN-0631 D31-04: a run CP **parked** instead of dispatching.
 *
 * CP answers `202 {status:"queued", reason:"agent_down"}` when the Agent is down
 * but the LLM was ready; the Run is queued for transport recovery and **nothing
 * is executing**. Before this, the UI unconditionally entered "thinking", so the
 * user watched a spinner forever. This is a local view of a real wire fact — the
 * CP keeps deciding when it actually starts.
 */
export interface RunQueuedInfo {
    runId?: string;
    /** CP `ChatRunResponse.reason` (only `agent_down` today); absent = unknown. */
    reason?: string;
}

export const useChatStore = defineStore("chat", () => {
    // Messages are not business data we should resurrect from localStorage.
    // The server is the canonical source via /api/v1/sessions/{id}/messages,
    // and the session store + chat store are cleared on user switch / logout.
    const messages = ref<Record<string, Message[]>>({}),
        streamingMessageId = ref<Record<string, string | null>>({}),
        sessionRunStates = ref<Record<string, ChatSessionRunState>>({}),
        // PLAN-0631 D31-04: parked (queued) runs are a separate view: they are not
        // "thinking" and they own no streaming message. Cleared as soon as the run
        // actually starts, terminates, or the session is detached/reset.
        sessionRunQueued = ref<Record<string, RunQueuedInfo>>({});
    // PLAN-0343: last run-terminal usage snapshot per session (CP relays the
    // mapped usage event once per run). Not persisted across reloads — the
    // llm.usage ContextEvent is durable; the header line is live-run visibility.
    const sessionLastUsage = ref<Record<string, ChatRunUsage>>({}),
        sessionBranches = ref<Record<string, ApiSessionBranch[]>>({}),
        selectedBranchIds = ref<Record<string, string>>({}),
        branchVersions = new Map<string, number>(),
        branchLoadPromises = new Map<string, Promise<ApiSessionBranch[]>>(),
        /**
         * Runs this view has started but whose durable projection it has not seen yet, and
         * the ids of the messages this view created for them.
         *
         * CP persists the run's assistant Message, but `GET /sessions/{id}/messages` is a
         * read projection that can lag the terminal SSE event by a round trip — a token can
         * even reach this client before the `202` body, so the live bubble may not know its
         * `runId` yet. The history refresh that runs when a stream goes terminal used to
         * replace the transcript with that projection; in the lag window it no longer
         * contained the run, so the tokens the user had already seen and the whole error box
         * vanished (`message-error` never mounted). Client-owned messages are retained until
         * the projection carries their run (id or `runId` match).
         */
        unprojectedRuns = new Map<string, Set<string>>(),
        clientOwnedMessageIds = new Map<string, Set<string>>();

    /**
     * PLAN-0645 M2: the live assistant bubble is keyed by **(sessionId, runId)** — up to
     * `maxConcurrentRunsPerSession` runs stream into one session at once and each owns its own
     * bubble. The empty runId segment is the fallback scope for legacy/runId-less events, and
     * `resolveStreamKey` maps an unknown runId onto the single live scope when exactly one exists —
     * which keeps every pre-0645 single-run caller byte-compatible.
     */
    const STREAM_KEY_SEP = "\u0000";

    function streamKey(sessionId: string, runId?: string): string {
        return `${sessionId}${STREAM_KEY_SEP}${runId ?? ""}`;
    }

    function liveStreamKeys(sessionId: string): string[] {
        const prefix = `${sessionId}${STREAM_KEY_SEP}`;
        return Object.keys(streamingMessageId.value).filter(
            (key) => key.startsWith(prefix) && streamingMessageId.value[key],
        );
    }

    function resolveStreamKey(sessionId: string, runId?: string): string {
        if (runId !== undefined) return streamKey(sessionId, runId);
        const live = liveStreamKeys(sessionId);
        return live.length === 1 ? live[0] : streamKey(sessionId);
    }

    /**
     * PLAN-0670 M2c / BL-292：run 级上下文截断标记（sessionId → runId → marker）。
     * 必须按 runId 索引：多 run 同屏时用一个全局单值会把 A 的截断提示串到 B 上。
     */
    const runContextTruncations = ref<Record<string, Record<string, AgentContextTruncation>>>({});
    const dismissedRunContextTruncations = ref(new Set<string>());

    function runTruncationKey(sessionId: string, runId: string): string {
        return `${sessionId}:${runId}`;
    }

    function setRunContextTruncation(
        sessionId: string,
        runId: string,
        truncation: AgentContextTruncation,
    ) {
        const sessionMap = runContextTruncations.value[sessionId] ?? {};
        sessionMap[runId] = truncation;
        runContextTruncations.value = { ...runContextTruncations.value, [sessionId]: sessionMap };
    }

    function getRunContextTruncation(
        sessionId: string,
        runId: string | undefined,
    ): AgentContextTruncation | undefined {
        if (!runId) return undefined;
        return runContextTruncations.value[sessionId]?.[runId];
    }

    function isRunContextTruncationDismissed(sessionId: string, runId: string): boolean {
        return dismissedRunContextTruncations.value.has(runTruncationKey(sessionId, runId));
    }

    function dismissRunContextTruncation(sessionId: string, runId: string) {
        const next = new Set(dismissedRunContextTruncations.value);
        next.add(runTruncationKey(sessionId, runId));
        dismissedRunContextTruncations.value = next;
    }

    function getMessages(sessionId: string): Message[] {
        return messages.value[sessionId] ?? [];
    }

    function getSessionBranches(sessionId: string): ApiSessionBranch[] {
        return sessionBranches.value[sessionId] ?? [];
    }

    function getSelectedBranchId(sessionId: string): string | undefined {
        return selectedBranchIds.value[sessionId];
    }

    function setSessionBranches(sessionId: string, branches: ApiSessionBranch[]) {
        sessionBranches.value[sessionId] = branches;
        const selected = selectedBranchIds.value[sessionId];
        if (selected && branches.some((branch) => branch.branchId === selected)) return;
        const root = branches.find((branch) => branch.parentBranchId === null),
            fallback = root ?? branches[0];
        if (fallback) selectedBranchIds.value[sessionId] = fallback.branchId;
        else delete selectedBranchIds.value[sessionId];
    }

    function selectBranch(sessionId: string, branchId: string): boolean {
        if (!sessionBranches.value[sessionId]?.some((branch) => branch.branchId === branchId))
            return false;
        selectedBranchIds.value[sessionId] = branchId;
        return true;
    }

    async function loadSessionBranches(sessionId: string): Promise<ApiSessionBranch[]> {
        const pending = branchLoadPromises.get(sessionId);
        if (pending) return pending;
        const version = branchVersions.get(sessionId) ?? 0;
        const promise = api
            .getSessionBranches(sessionId)
            .then(({ items }) => {
                if ((branchVersions.get(sessionId) ?? 0) === version)
                    setSessionBranches(sessionId, items);
                return items;
            })
            .finally(() => {
                if (branchLoadPromises.get(sessionId) === promise)
                    branchLoadPromises.delete(sessionId);
            });
        branchLoadPromises.set(sessionId, promise);
        return promise;
    }

    function clearSessionBranches(sessionId: string) {
        branchVersions.set(sessionId, (branchVersions.get(sessionId) ?? 0) + 1);
        branchLoadPromises.delete(sessionId);
        delete sessionBranches.value[sessionId];
        delete selectedBranchIds.value[sessionId];
    }

    function getStreamingMessageId(sessionId: string, runId?: string): string | null {
        return streamingMessageId.value[resolveStreamKey(sessionId, runId)] ?? null;
    }

    function getSessionRunState(sessionId: string): ChatSessionRunState {
        return sessionRunStates.value[sessionId] ?? { status: "idle" };
    }

    /**
     * PLAN-0631 D31-04: the parked-run view. `null` = CP never told us this run is
     * queued (also the state after the run starts or ends) — never inferred.
     */
    function getRunQueued(sessionId: string): RunQueuedInfo | null {
        return sessionRunQueued.value[sessionId] ?? null;
    }

    function setRunQueued(sessionId: string, info: RunQueuedInfo) {
        sessionRunQueued.value[sessionId] = { ...info };
    }

    function clearRunQueued(sessionId: string) {
        delete sessionRunQueued.value[sessionId];
    }

    function getSessionLastUsage(sessionId: string): ChatRunUsage | null {
        return sessionLastUsage.value[sessionId] ?? null;
    }

    function setSessionLastUsage(sessionId: string, usage: ChatRunUsage) {
        sessionLastUsage.value[sessionId] = usage;
    }

    function getSessionRunId(sessionId: string): string | undefined {
        return sessionRunStates.value[sessionId]?.runId;
    }

    function setSessionRunState(
        sessionId: string,
        status: ChatSessionRunState["status"],
        runId?: string,
    ) {
        if (status === "idle" && runId === undefined) {
            delete sessionRunStates.value[sessionId];
            return;
        }
        sessionRunStates.value[sessionId] = {
            status,
            ...(runId !== undefined ? { runId } : {}),
        };
    }

    function isStreaming(sessionId: string): boolean {
        const status = sessionRunStates.value[sessionId]?.status;
        return (
            liveStreamKeys(sessionId).length > 0 ||
            status === "thinking" ||
            status === "executing" ||
            status === "awaiting_approval"
        );
    }

    function addMessage(sessionId: string, message: Message) {
        if (!messages.value[sessionId]) {
            messages.value[sessionId] = [];
        }
        messages.value[sessionId].push(message);
    }

    /**
     * PLAN-0670 M2d.1：向上分页取到的更旧消息**前插**（保持时间序），按 id 去重。
     * 与 `loadMessages` 的替换语义分开：分页加载绝不能覆盖当前窗口/在途流。
     */
    function prependMessages(sessionId: string, olderMessages: Message[]): number {
        if (olderMessages.length === 0) return 0;
        const current = messages.value[sessionId] ?? [],
            existing = new Set(current.map((message) => message.id)),
            unique = olderMessages.filter((message) => !existing.has(message.id));
        if (unique.length === 0) return 0;
        messages.value[sessionId] = [...unique, ...current];
        return unique.length;
    }

    /**
     * PLAN-0670 M2d.3：内存内消息上限（默认 500，Lead 2026-11-05 批准）。
     * 从**最旧**端丢弃并返回丢弃条数 —— 调用方必须把丢掉的条数显式呈现为"已折叠"，
     * 不允许静默丢（静默丢会让用户以为消息丢了）。丢弃造成的 scrollHeight 变化由
     * MessageList 的 `captureAnchor/restoreAnchor` 补偿（与 prepend 同一套）。
     */
    function trimMessages(sessionId: string, maxCount: number): number {
        const current = messages.value[sessionId];
        if (!current || current.length <= maxCount) return 0;
        const dropCount = current.length - maxCount;
        messages.value[sessionId] = current.slice(dropCount);
        return dropCount;
    }

    function loadMessages(sessionId: string, sessionMessages: Message[]) {
        // An in-flight response is owned by the live SSE stream. Do not let a
        // slower history request replace its optimistic user/assistant messages.
        if (isStreaming(sessionId)) return;
        const owned = clientOwnedMessageIds.get(sessionId);
        if (!owned || owned.size === 0) {
            messages.value[sessionId] = sessionMessages;
            return;
        }
        const pending = unprojectedRuns.get(sessionId),
            projectedIds = new Set(sessionMessages.map((message) => message.id)),
            projectedRuns = new Set(
                sessionMessages
                    .map((message) => message.runId)
                    .filter((runId): runId is string => Boolean(runId)),
            );
        // The projection is authoritative for everything it carries now; drop those messages
        // (and their runs) from the client-owned set so they can never be resurrected later.
        for (const id of projectedIds) owned.delete(id);
        // Deleting the current entry during Set iteration is safe.
        for (const runId of pending ?? []) {
            if (projectedRuns.has(runId)) pending?.delete(runId);
        }
        const previous = messages.value[sessionId] ?? [],
            selectedBranch = selectedBranchIds.value[sessionId];
        for (const message of previous) {
            if (message.runId !== undefined && projectedRuns.has(message.runId)) {
                owned.delete(message.id);
            }
        }
        // Keep what this view recorded and the projection does not carry yet — the run's
        // prompt, its live/terminal reply, the error box, its status markers. Ownership comes
        // from creation (see `markClientOwned`), never from a positional guess: a token can
        // beat the `202` body, so a live reply may still carry no `runId` here.
        // Scoped to the selected branch so switching branches cannot resurrect the other
        // branch's live messages.
        const retained = previous.filter(
            (message) =>
                owned.has(message.id) &&
                !projectedIds.has(message.id) &&
                (message.branchId === undefined ||
                    selectedBranch === undefined ||
                    message.branchId === selectedBranch),
        );
        messages.value[sessionId] =
            retained.length > 0 ? [...sessionMessages, ...retained] : sessionMessages;
    }

    /** Mark a message as created by this view (never observed in a projection snapshot). */
    function markClientOwned(sessionId: string, messageId: string | undefined) {
        if (!messageId) return;
        const ids = clientOwnedMessageIds.get(sessionId) ?? new Set<string>();
        ids.add(messageId);
        clientOwnedMessageIds.set(sessionId, ids);
    }

    /**
     * Bind a run id to the client-owned messages this view recorded before the `202` body
     * reached it (a stream token can win that race). Without the id the live reply can
     * neither be reconciled with the projection once it lands nor be told apart from an
     * unrelated transcript entry.
     */
    function adoptRunId(sessionId: string, runId: string | undefined) {
        if (!runId) return;
        trackUnprojectedRun(sessionId, runId);
        const owned = clientOwnedMessageIds.get(sessionId);
        if (!owned) return;
        for (const message of messages.value[sessionId] ?? []) {
            if (owned.has(message.id) && message.runId === undefined) message.runId = runId;
        }
        // PLAN-0645 M2: a bubble created before the `202` body lives in the fallback scope. Once
        // the run id is known, move the scope so the per-run callbacks (token/done/error) address
        // the bubble we already have instead of opening a second one for the same run.
        const fallbackKey = streamKey(sessionId),
            liveId = streamingMessageId.value[fallbackKey];
        if (liveId) {
            const live = (messages.value[sessionId] ?? []).find((msg) => msg.id === liveId);
            if (live && live.runId === runId) {
                streamingMessageId.value[streamKey(sessionId, runId)] = liveId;
                streamingMessageId.value[fallbackKey] = null;
            }
        }
    }

    /**
     * Remember that this view started `runId`; its messages stay visible across history
     * refreshes until the durable projection contains the run (see `unprojectedRuns`).
     */
    function trackUnprojectedRun(sessionId: string, runId: string | undefined) {
        if (!runId) return;
        const runs = unprojectedRuns.get(sessionId) ?? new Set<string>();
        runs.add(runId);
        unprojectedRuns.set(sessionId, runs);
    }

    function detachLiveSession(sessionId: string) {
        for (const key of liveStreamKeys(sessionId)) {
            const messageId = streamingMessageId.value[key];
            if (messageId) {
                messages.value[sessionId] = (messages.value[sessionId] ?? []).filter(
                    (message) => message.id !== messageId,
                );
                clientOwnedMessageIds.get(sessionId)?.delete(messageId);
            }
            streamingMessageId.value[key] = null;
        }
        delete sessionRunStates.value[sessionId];
        clearRunQueued(sessionId);
        removeRunStatusMarker(sessionId);
    }

    function deleteMessage(sessionId: string, messageId: string) {
        const sessionMessages = messages.value[sessionId];
        if (!sessionMessages) return;
        messages.value[sessionId] = sessionMessages.filter((msg) => msg.id !== messageId);
    }

    function addMarker(sessionId: string, marker: Omit<Message, "id" | "sessionId">) {
        const id = crypto.randomUUID();
        markClientOwned(sessionId, id);
        addMessage(sessionId, { id, sessionId, ...marker });
    }

    /** A status marker is the client-only "…is running" line; `interrupted` is a semantic entry. */
    function isStatusMarker(message: Message): boolean {
        return message.marker === "status" && message.status !== "interrupted";
    }

    /**
     * PLAN-0631 D31-07: the live status line is a **singleton per run**.
     *
     * SSE `status` events fire on every thinking/executing transition. Pushing a
     * new client-only marker each time left a trail of "Thinking.../Executing
     * task..." rows in the transcript (one run could leave a dozen). Update the
     * run's single marker in place instead; `removeRunStatusMarker` drops it at the
     * terminal transition, because a finished run is not a status.
     *
     * Never touches the `interrupted` marker (that one is history the user needs).
     */
    function upsertRunStatusMarker(sessionId: string, status: string, runId?: string) {
        const list = messages.value[sessionId] ?? [];
        const existing = [...list]
            .reverse()
            .find(
                (message) =>
                    isStatusMarker(message) &&
                    (runId === undefined || message.runId === undefined || message.runId === runId),
            );
        if (existing) {
            existing.status = status;
            if (existing.runId === undefined && runId !== undefined) existing.runId = runId;
            return;
        }
        addMarker(sessionId, {
            role: "system",
            content: status,
            timestamp: new Date().toISOString(),
            marker: "status",
            status,
            ...(runId !== undefined ? { runId } : {}),
        });
    }

    function removeRunStatusMarker(sessionId: string, runId?: string) {
        const list = messages.value[sessionId];
        if (!list) return;
        const kept = list.filter(
            (message) =>
                !(
                    isStatusMarker(message) &&
                    (runId === undefined || message.runId === undefined || message.runId === runId)
                ),
        );
        if (kept.length !== list.length) messages.value[sessionId] = kept;
    }

    function findStreamingMessage(sessionId: string, runId?: string): Message | undefined {
        const messageId = streamingMessageId.value[resolveStreamKey(sessionId, runId)];
        if (!messageId) return undefined;
        return messages.value[sessionId]?.find((msg) => msg.id === messageId);
    }

    /**
     * PLAN-0631 D31-08: stamp the **live** assistant message with the responder CP
     * attributed through the SSE envelope (`participantId`). The value is constant per
     * run, so the first known one wins; a null/absent attribution is left alone — no
     * PRIMARY back-fill (DEV-032) and no client-side guessing.
     */
    function setStreamingMessageResponder(
        sessionId: string,
        participantId: string | null,
        runId?: string,
    ) {
        if (participantId === null) return;
        const message = findStreamingMessage(sessionId, runId);
        if (message && message.participantId === undefined) message.participantId = participantId;
    }

    function messageHasRenderableContent(message: Message): boolean {
        return Boolean(
            message.content ||
            message.toolCalls?.length ||
            message.parts?.some((part) => part.type !== "citation" && Boolean(part.content)),
        );
    }

    function createStreamingMessage(sessionId: string, runId?: string, branchId?: string): string {
        // PLAN-0631 D31-04: the run actually started — the parked view must go.
        clearRunQueued(sessionId);
        trackUnprojectedRun(sessionId, runId);
        // Tool-first runs create the live assistant message from `upsertToolCall`
        // before any token arrives; reuse it instead of spawning a second bubble.
        const existing = findStreamingMessage(sessionId, runId);
        if (existing) {
            if (runId !== undefined) existing.runId = runId;
            if (branchId !== undefined) existing.branchId = branchId;
            return existing.id;
        }
        const id = crypto.randomUUID(),
            message: Message = {
                id,
                sessionId,
                role: "assistant",
                content: "",
                timestamp: new Date().toISOString(),
                isStreaming: true,
                runId,
                branchId,
                runStatus: "streaming",
            };
        markClientOwned(sessionId, id);
        addMessage(sessionId, message);
        streamingMessageId.value[streamKey(sessionId, runId)] = id;
        setSessionRunState(sessionId, "thinking", runId);
        return id;
    }

    type ToolCallUpsert = Partial<ToolCall> & Pick<ToolCall, "id">;

    /**
     * PLAN-0342 T1.5: merge SSE tool events into the live assistant message so
     * MessageItem/ToolCallCard render the real path. `tool_call` inserts
     * `running`, `tool_result` moves it to `completed`/`failed` with
     * result/diagnostics. Tool-first runs have no token yet, so the live
     * message is created on demand.
     */
    function upsertToolCall(sessionId: string, call: ToolCallUpsert, scopeRunId?: string) {
        // PLAN-0645 M2 + BL-229: which bubble a tool event belongs to is decided by the **CP
        // runId** (`scopeRunId` — the ChatRun id CP stamps on every event), never by the Agent's
        // snake_case `run_id` (a LangChain callback id). `token`/`done`/`error` route by the
        // former, so routing tools by the latter left an orphan live scope that `done` could not
        // clear — `isStreaming()` stayed true and the composer kept the stop button.
        // `call.runId` keeps its own meaning: the `tool_call`↔`tool_result` merge key.
        const keyRunId = scopeRunId ?? call.runId,
            messageId =
                streamingMessageId.value[resolveStreamKey(sessionId, keyRunId)] ??
                createStreamingMessage(sessionId, keyRunId),
            message = messages.value[sessionId]?.find((msg) => msg.id === messageId);
        if (!message) return;

        if (!message.toolCalls) {
            message.toolCalls = [];
        }
        const incomingIds = [call.id, call.runId].filter(
            (value): value is string => typeof value === "string" && value !== "",
        );
        // PLAN-0342 review fix: `tool_call` carries the tool-run id while
        // `tool_result` carries the model's tool_call_id; both share `run_id`,
        // so merge on either key to avoid a ghost "running" card.
        const existing = message.toolCalls.find(
            (tc) =>
                incomingIds.includes(tc.id) ||
                (typeof tc.runId === "string" && incomingIds.includes(tc.runId)),
        );
        if (existing) {
            // Keep the first-seen id stable so both wire ids keep merging into the
            // same card; only enrich with the result payload.
            const { id: _ignoredId, runId: _ignoredRunId, ...rest } = call;
            Object.assign(existing, rest);
            if (!existing.runId && call.runId) {
                existing.runId = call.runId;
            }
            return;
        }
        message.toolCalls.push({ name: "", arguments: "", status: "running", ...call });
    }

    function appendToParts(sessionId: string, part: MessagePart, runId?: string) {
        const messageId = streamingMessageId.value[resolveStreamKey(sessionId, runId)];
        if (!messageId) return;

        const msgs = messages.value[sessionId],
            message = msgs?.find((msg) => msg.id === messageId);
        if (!message) return;

        if (!message.parts) {
            message.parts = [];
        }

        if (part.type === "text") {
            const lastText =
                message.parts.length > 0 ? message.parts[message.parts.length - 1] : null;
            if (lastText?.type === "text") {
                lastText.content += part.content;
                return;
            }
        }

        if (part.type === "reasoning") {
            const lastReasoning =
                message.parts.length > 0 ? message.parts[message.parts.length - 1] : null;
            if (lastReasoning?.type === "reasoning") {
                lastReasoning.content += part.content;
                return;
            }
        }

        if (part.type === "artifact") {
            const lastArtifact =
                message.parts.length > 0 ? message.parts[message.parts.length - 1] : null;
            if (lastArtifact?.type === "artifact" && lastArtifact.identifier === part.identifier) {
                lastArtifact.content += part.content;
                return;
            }
        }

        message.parts.push(part);
    }

    function replaceStreamingParts(sessionId: string, nextParts: MessagePart[], runId?: string) {
        const messageId = streamingMessageId.value[resolveStreamKey(sessionId, runId)];
        if (!messageId) return;

        const message = messages.value[sessionId]?.find((msg) => msg.id === messageId);
        if (!message) return;

        message.parts = [...nextParts];
    }

    function finalizeStreaming(sessionId: string, runId?: string) {
        const streamKeyToClear = resolveStreamKey(sessionId, runId),
            messageId = streamingMessageId.value[streamKeyToClear];
        if (!messageId) {
            if (liveStreamKeys(sessionId).length === 0) {
                setSessionRunState(sessionId, "idle");
                clearRunQueued(sessionId);
                removeRunStatusMarker(sessionId);
            }
            return;
        }

        const message = messages.value[sessionId]?.find((msg) => msg.id === messageId);
        if (message) {
            message.isStreaming = false;
            message.runStatus = "succeeded";
            message.terminalOutcome = "success";
            if (message.parts) {
                message.content = message.parts
                    .filter((p) => p.type === "text")
                    .map((p) => p.content)
                    .join("");
            }
        }

        streamingMessageId.value[streamKeyToClear] = null;
        // PLAN-0645 M2: a sibling run may still be streaming — only the last scope resets the
        // session-level state line and the live status marker.
        if (liveStreamKeys(sessionId).length === 0) {
            setSessionRunState(sessionId, "idle");
            // PLAN-0631 D31-04/07: terminal — no parked view, no live status line.
            clearRunQueued(sessionId);
            removeRunStatusMarker(sessionId);
        }
    }

    function cancelStreaming(sessionId: string, runId: string) {
        const streamKeyToClear = streamKey(sessionId, runId),
            messageId = streamingMessageId.value[streamKeyToClear];
        const message = messages.value[sessionId]?.find((msg) => msg.id === messageId);
        if (message && message.runId && message.runId !== runId) return;
        if (message) {
            if (!messageHasRenderableContent(message)) {
                messages.value[sessionId] = messages.value[sessionId].filter(
                    (msg) => msg.id !== messageId,
                );
            } else {
                message.isStreaming = false;
                message.runStatus = "cancelled";
                message.terminalOutcome = "cancelled";
                message.toolCalls = message.toolCalls?.map((toolCall) =>
                    toolCall.status === "running" || toolCall.status === "pending"
                        ? { ...toolCall, status: "cancelled" }
                        : toolCall,
                );
                if (message.parts) {
                    message.content = message.parts
                        .filter((part) => part.type === "text")
                        .map((part) => part.content)
                        .join("");
                }
            }
        }
        streamingMessageId.value[streamKeyToClear] = null;
        // PLAN-0645 M2: keep the session state live while a sibling run is still streaming.
        if (liveStreamKeys(sessionId).length === 0) {
            setSessionRunState(sessionId, "idle");
            // PLAN-0631 D31-04/07: the run is no longer active from the view's side.
            clearRunQueued(sessionId);
            // The `interrupted` marker added just above is semantic history and survives
            // `removeRunStatusMarker` (it only removes live "…is running" lines).
            removeRunStatusMarker(sessionId);
        }
    }

    /**
     * PLAN-0341 U3 case B: overflow retry keeps prior visible content but marks
     * it interrupted so the retry's new reply is the official answer.
     * Case A (no visible content): drop the empty streaming bubble.
     */
    function interruptForOverflowRetry(sessionId: string, runId?: string) {
        const streamKeyToClear = resolveStreamKey(sessionId, runId),
            messageId = streamingMessageId.value[streamKeyToClear];
        if (!messageId) return;

        const message = messages.value[sessionId]?.find((msg) => msg.id === messageId);
        if (message) {
            const hasContent = messageHasRenderableContent(message);
            if (!hasContent) {
                messages.value[sessionId] = messages.value[sessionId].filter(
                    (msg) => msg.id !== messageId,
                );
            } else {
                message.isStreaming = false;
                message.runStatus = "interrupted";
                message.interrupted = true;
                message.terminalOutcome = "partial";
                if (message.parts) {
                    message.content = message.parts
                        .filter((p) => p.type === "text")
                        .map((p) => p.content)
                        .join("");
                }
                addMarker(sessionId, {
                    role: "system",
                    content: "interrupted",
                    timestamp: new Date().toISOString(),
                    marker: "status",
                    status: "interrupted",
                    // Attribute the marker to the folded run so it is retained with that
                    // run until the projection carries it (see `unprojectedRuns`), instead
                    // of being dropped by the very next history refresh.
                    ...(message.runId !== undefined ? { runId: message.runId } : {}),
                });
            }
        }
        streamingMessageId.value[streamKeyToClear] = null;
        // PLAN-0645 M2: only reset the session state when the folded run was the last live scope.
        if (liveStreamKeys(sessionId).length === 0) {
            setSessionRunState(sessionId, "idle");
        }
    }

    /**
     * 这些 code 是"流本身断了"的内部哨兵：没有可渲染内容时删掉空气泡是正确清理。
     * 其它 code 都是**可展示的业务错误**（含 429 准入拒绝），必须保留气泡。
     */
    const INTERNAL_STREAM_ERROR_CODES = new Set([
        "AGENT_STREAM_FAILED",
        "AGENT_STREAM_AMBIGUOUS",
        "AGENT_STREAM_TIMEOUT",
        "SSE_CONNECTION_FAILED",
    ]);

    function markStreamingError(
        sessionId: string,
        error: {
            code: string;
            detail: string;
            runId?: string;
            retryable?: boolean;
            outcome?: string;
            /** PLAN-0622：429 RESOURCE_EXHAUSTED 的等待秒数与资源种类。 */
            retryAfterSeconds?: number;
            resourceKind?: string;
        },
    ) {
        // PLAN-0645 M2: the failing run (when named) owns the bubble this error is written to.
        const streamKeyToClear = resolveStreamKey(sessionId, error.runId),
            messageId = streamingMessageId.value[streamKeyToClear];
        if (!messageId) {
            // 真实链路：占位气泡只在 SSE `onStart` 里创建（SSEStream.vue），而 D28 的 429 发生在
            // **准入**（202 之前），不会产生任何 SSE 事件 ⇒ 原来的 `return` 会把整条错误静默丢掉，
            // 用户点发送后界面什么都不显示。业务错误必须有自己的气泡。
            if (!INTERNAL_STREAM_ERROR_CODES.has(error.code)) {
                const errorMessageId = crypto.randomUUID();
                markClientOwned(sessionId, errorMessageId);
                addMessage(sessionId, {
                    id: errorMessageId,
                    sessionId,
                    role: "assistant",
                    content: "",
                    timestamp: new Date().toISOString(),
                    errorCode: error.code,
                    error: error.detail,
                    retryable: error.retryable ?? true,
                    retryAfterSeconds: error.retryAfterSeconds,
                    resourceKind: error.resourceKind,
                    runId: error.runId,
                    runStatus: "failed",
                    terminalOutcome: "error",
                });
                setSessionRunState(sessionId, "error", error.runId);
            }
            // PLAN-0631 D31-04/07: the run is over; drop the parked view and the
            // live status line (the error box is the terminal surface).
            clearRunQueued(sessionId);
            removeRunStatusMarker(sessionId);
            return;
        }

        const message = messages.value[sessionId]?.find((msg) => msg.id === messageId);
        if (message) {
            // Tool cards are renderable content: keep a tool-only bubble (with its
            // diagnostics) alive, but only assistant text counts as "partial".
            const hasTextContent = Boolean(
                    message.content ||
                    message.parts?.some(
                        (part) => part.type !== "citation" && Boolean(part.content),
                    ),
                ),
                hasRenderableContent = hasTextContent || Boolean(message.toolCalls?.length);
            // PLAN-0622 D28：429 可能发生在**准入**（202 之前），此时气泡没有任何内容。
            // "无内容就删气泡"是旧假设（错误总在内容之后到达），会把业务错误一起删掉，
            // 用户点发送后界面什么都不显示。所以只有**内部流错误**才走清理：
            // 业务错误（RESOURCE_EXHAUSTED / AGENT_PRINCIPAL_DISABLED / 凭证类 4xx …）
            // 一律保留气泡并把错误字段写进去，交给 MessageItem 出本地化话术。
            if (!hasRenderableContent && INTERNAL_STREAM_ERROR_CODES.has(error.code)) {
                messages.value[sessionId] = messages.value[sessionId].filter(
                    (msg) => msg.id !== messageId,
                );
                streamingMessageId.value[streamKeyToClear] = null;
                if (liveStreamKeys(sessionId).length === 0) {
                    setSessionRunState(sessionId, "idle");
                    clearRunQueued(sessionId);
                    removeRunStatusMarker(sessionId);
                }
                if (error.runId) void refreshRunRecovery(sessionId, error.runId);
                return;
            }
            message.isStreaming = false;
            message.errorCode = error.code;
            message.error = error.detail;
            message.retryable = error.retryable ?? true;
            // PLAN-0622：429 配额/并发耗尽的等待秒数与资源种类，供 MessageItem 出本地化话术。
            message.retryAfterSeconds = error.retryAfterSeconds;
            message.resourceKind = error.resourceKind;
            message.runId = error.runId ?? message.runId;
            const ambiguous = error.outcome === "ambiguous",
                partial = !ambiguous && (hasTextContent || error.outcome === "partial");
            message.runStatus = ambiguous ? "ambiguous" : partial ? "partial" : "failed";
            message.terminalOutcome = ambiguous ? "ambiguous" : partial ? "partial" : "error";
            if (message.parts) {
                message.content = message.parts
                    .filter((part) => part.type === "text")
                    .map((part) => part.content)
                    .join("");
            }
        }

        streamingMessageId.value[streamKeyToClear] = null;
        if (liveStreamKeys(sessionId).length === 0) {
            setSessionRunState(sessionId, "idle");
            clearRunQueued(sessionId);
            removeRunStatusMarker(sessionId);
        }
        if (error.runId) void refreshRunRecovery(sessionId, error.runId);
    }

    const runRecovery = ref<Record<string, RunRecovery | undefined>>({}),
        recoveryGenerations = new Map<string, number>(),
        recoveryRunIds = new Map<string, string>();
    let recoveryGeneration = 0;

    // PLAN-292 M3 (C2): ask the CP what actually happened to the run behind a
    // dead SSE stream. Server truth decides the banner; never fabricate a state.
    async function refreshRunRecovery(sessionId: string, runId: string): Promise<void> {
        const requestGeneration = ++recoveryGeneration;
        recoveryGenerations.set(sessionId, requestGeneration);
        recoveryRunIds.set(sessionId, runId);
        const isCurrent = () => recoveryGenerations.get(sessionId) === requestGeneration;
        try {
            const res = await api.getChatRunStatus(runId);
            if (!isCurrent() || res.sessionId !== sessionId || res.runId !== runId) return;
            // PLAN-0631 D31-04: CP status is authoritative. The local parked view
            // only survives while CP still says `queued`; any other reading clears it.
            if (res.status !== "queued") clearRunQueued(sessionId);
            const agentStore = useAgentStore();
            if (
                res.status === "awaiting_approval" ||
                (res.status === "running" && !res.leaseExpired)
            ) {
                setSessionRunState(
                    sessionId,
                    res.status === "awaiting_approval" ? "awaiting_approval" : "thinking",
                    runId,
                );
                runRecovery.value[sessionId] = {
                    state: "resumed",
                    runId,
                    message: "会话已恢复，任务仍在执行，待审批操作可继续处理",
                };
                for (const approval of res.pendingApprovals ?? []) {
                    agentStore.addApprovalRequest(approval);
                }
                void agentStore.refreshPendingApprovals();
            } else if (res.status === "failed" && res.terminalOutcome === "ambiguous") {
                // PLAN-292 C1: the relay stream broke while an approval was in
                // flight — the run is failed/ambiguous but the pending decision is
                // still replayable from the server.
                setSessionRunState(sessionId, "awaiting_approval", runId);
                runRecovery.value[sessionId] = {
                    state: "resumed",
                    runId,
                    message: "连接中断，待审批操作仍可继续处理",
                };
                for (const approval of res.pendingApprovals ?? []) {
                    agentStore.addApprovalRequest(approval);
                }
                void agentStore.refreshPendingApprovals();
            } else if (
                ["cancelling", "cancelled", "failed", "ambiguous", "completed"].includes(res.status)
            ) {
                if (res.status === "cancelling" || res.status === "cancelled") {
                    cancelStreaming(sessionId, runId);
                }
                agentStore.resolveApprovalsForRun(
                    sessionId,
                    runId,
                    res.status === "cancelling" || res.status === "cancelled"
                        ? "expired"
                        : "dispatch_unknown",
                );
                if (res.status === "cancelling" || res.status === "cancelled") {
                    await agentStore.refreshPendingApprovals();
                }
                setSessionRunState(sessionId, "idle");
                // PLAN-0493 T3.1: a failed run caused by a run guard presents
                // the reason plus the takeover hint in the recovery banner — a
                // zero-content stop (tool-only loops) leaves no assistant
                // message to carry the error box; other terminal states keep
                // the generic copy.
                let recoveryMessage = "任务已取消或结束，未完成的执行不会继续";
                let recoveryState: RunRecoveryState = "cancelled";
                if (res.status === "failed" && res.errorCode === "RUN_NO_PROGRESS") {
                    recoveryMessage =
                        "检测到重复或无进展动作，运行已停止；可在下方输入框继续发送，接续本次会话";
                    recoveryState = "failed";
                } else if (res.status === "failed" && res.errorCode === "RUN_BUDGET_EXHAUSTED") {
                    recoveryMessage =
                        "本次运行已达到累计预算上限；可在下方输入框继续发送，接续本次会话";
                    recoveryState = "failed";
                }
                runRecovery.value[sessionId] = {
                    state: recoveryState,
                    runId,
                    message: recoveryMessage,
                };
            } else if (res.status === "running" && res.leaseExpired) {
                agentStore.resolveApprovalsForRun(sessionId, runId);
                setSessionRunState(sessionId, "idle");
                runRecovery.value[sessionId] = {
                    state: "retry",
                    runId,
                    message: "任务执行租约已过期，请重试",
                };
            } else {
                // succeeded — history already shows the final message, no banner.
                agentStore.resolveApprovalsForRun(sessionId, runId);
                setSessionRunState(sessionId, "idle");
                delete runRecovery.value[sessionId];
            }
        } catch (cause) {
            if (!isCurrent()) return;
            if (
                cause instanceof ApiError &&
                (cause.problem.status === 401 || cause.problem.status === 403)
            ) {
                logger.warn("Chat run recovery authorization failed", cause);
                useAgentStore().reset();
                delete runRecovery.value[sessionId];
                return;
            }
            logger.warn("Failed to refresh chat run recovery", cause);
            runRecovery.value[sessionId] = {
                state: "retry",
                runId,
                message: "无法确认任务状态，请重试",
            };
        }
    }

    function dismissRunRecovery(sessionId: string) {
        if (recoveryRunIds.has(sessionId) || runRecovery.value[sessionId]) {
            recoveryGeneration += 1;
            recoveryGenerations.set(sessionId, recoveryGeneration);
            recoveryRunIds.delete(sessionId);
        }
        delete runRecovery.value[sessionId];
    }

    function invalidateRunRecovery(sessionId: string, runId: string) {
        const activeRunId = recoveryRunIds.get(sessionId) ?? runRecovery.value[sessionId]?.runId;
        if (activeRunId !== runId) return;
        recoveryGeneration += 1;
        recoveryGenerations.set(sessionId, recoveryGeneration);
        recoveryRunIds.delete(sessionId);
        delete runRecovery.value[sessionId];
        setSessionRunState(sessionId, "idle");
    }

    function clearSession(sessionId: string) {
        delete messages.value[sessionId];
        clearSessionBranches(sessionId);
        // PLAN-0645 M2: the live-bubble map is keyed by (sessionId, runId) — drop every run scope.
        const streamPrefix = `${sessionId}${STREAM_KEY_SEP}`;
        for (const key of Object.keys(streamingMessageId.value)) {
            if (key.startsWith(streamPrefix)) delete streamingMessageId.value[key];
        }
        delete sessionRunStates.value[sessionId];
        delete sessionRunQueued.value[sessionId];
        delete runRecovery.value[sessionId];
        unprojectedRuns.delete(sessionId);
        clientOwnedMessageIds.delete(sessionId);
        recoveryGenerations.delete(sessionId);
        recoveryRunIds.delete(sessionId);
    }

    function deleteSession(sessionId: string) {
        clearSession(sessionId);
    }

    function clearAllData() {
        for (const key of XIHE_STORAGE_KEYS) {
            try {
                localStorage.removeItem(key);
            } catch {
                // ignore
            }
        }
        messages.value = {};
        sessionBranches.value = {};
        selectedBranchIds.value = {};
        for (const sessionId of new Set([...branchVersions.keys(), ...branchLoadPromises.keys()])) {
            branchVersions.set(sessionId, (branchVersions.get(sessionId) ?? 0) + 1);
        }
        branchLoadPromises.clear();
        streamingMessageId.value = {};
        sessionRunStates.value = {};
        sessionRunQueued.value = {};
        sessionLastUsage.value = {};
        runRecovery.value = {};
        unprojectedRuns.clear();
        clientOwnedMessageIds.clear();
        recoveryGeneration += 1;
        recoveryGenerations.clear();
        recoveryRunIds.clear();
    }

    function clearForUserSwitch() {
        messages.value = {};
        sessionBranches.value = {};
        selectedBranchIds.value = {};
        for (const sessionId of new Set([...branchVersions.keys(), ...branchLoadPromises.keys()])) {
            branchVersions.set(sessionId, (branchVersions.get(sessionId) ?? 0) + 1);
        }
        branchLoadPromises.clear();
        streamingMessageId.value = {};
        sessionRunStates.value = {};
        sessionRunQueued.value = {};
        sessionLastUsage.value = {};
        runRecovery.value = {};
        unprojectedRuns.clear();
        clientOwnedMessageIds.clear();
        recoveryGeneration += 1;
        recoveryGenerations.clear();
        recoveryRunIds.clear();
    }

    return {
        messages,
        streamingMessageId,
        sessionRunStates,
        sessionRunQueued,
        runRecovery,
        getMessages,
        getSessionBranches,
        getSelectedBranchId,
        setSessionBranches,
        selectBranch,
        loadSessionBranches,
        clearSessionBranches,
        getStreamingMessageId,
        getSessionRunState,
        getSessionRunId,
        setSessionRunState,
        getRunQueued,
        setRunQueued,
        clearRunQueued,
        getSessionLastUsage,
        setSessionLastUsage,
        isStreaming,
        addMessage,
        loadMessages,
        prependMessages,
        setRunContextTruncation,
        getRunContextTruncation,
        isRunContextTruncationDismissed,
        dismissRunContextTruncation,
        trimMessages,
        trackUnprojectedRun,
        markClientOwned,
        adoptRunId,
        detachLiveSession,
        deleteMessage,
        addMarker,
        upsertRunStatusMarker,
        removeRunStatusMarker,
        setStreamingMessageResponder,
        createStreamingMessage,
        upsertToolCall,
        appendToParts,
        replaceStreamingParts,
        finalizeStreaming,
        interruptForOverflowRetry,
        markStreamingError,
        refreshRunRecovery,
        dismissRunRecovery,
        invalidateRunRecovery,
        clearSession,
        deleteSession,
        clearAllData,
        clearForUserSwitch,
    };
});
