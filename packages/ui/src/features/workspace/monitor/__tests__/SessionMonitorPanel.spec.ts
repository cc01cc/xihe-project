import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { i18n } from "../../../../i18n";
import { api } from "../../../../composables/api";
import {
    applyTransportAttempt,
    applyTransportProgress,
    clearTransportLive,
} from "../../chat/transportLive";
import { notifySessionConnection, notifySessionEvent } from "../../chat/sessionEvents";
import SessionMonitorPanel from "../SessionMonitorPanel.vue";
import type {
    RunTraceResponse,
    RunTransportAttemptsResponse,
    SessionMonitorResponse,
} from "../../../../types";

vi.mock("../../../../composables/api", () => ({
    api: {
        getSessionMonitor: vi.fn<(sessionId: string) => Promise<SessionMonitorResponse>>(),
        getRunAttempts: vi.fn<(runId: string) => Promise<RunTransportAttemptsResponse>>(),
        getRunTrace:
            vi.fn<
                (
                    runId: string,
                    options?: { cursor?: string; limit?: number },
                ) => Promise<RunTraceResponse>
            >(),
    },
}));

const getSessionMonitor = vi.mocked(api.getSessionMonitor);
const getRunAttempts = vi.mocked(api.getRunAttempts);
const getRunTrace = vi.mocked(api.getRunTrace);
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_1 = "44444444-4444-4444-8444-444444444444";
const ATTEMPT_2 = "55555555-5555-4555-8555-555555555555";

let wrapper: VueWrapper | null = null;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function monitorResponse(overrides: Partial<SessionMonitorResponse> = {}): SessionMonitorResponse {
    return {
        generatedAt: "2026-10-14T02:00:00Z",
        session: {
            id: SESSION_ID,
            title: "demo",
            agentPrincipalId: null,
            modelProvider: "custom-openai-compatible",
            modelName: "wire-model",
            providerConnectionId: CONNECTION_ID,
            connectionRevision: 1,
            createdAt: null,
            updatedAt: null,
        },
        activity: [],
        history: {
            windowSize: 20,
            counts: { success: 2, error: 1 },
            recent: [
                {
                    runId: RUN_ID,
                    origin: "user_submission",
                    terminalOutcome: "success",
                    errorCode: null,
                    createdAt: null,
                    terminalAt: "2026-10-14T01:50:00Z",
                },
            ],
        },
        readiness: {
            connection: {
                status: "READY",
                lastErrorCode: null,
                lastVerifiedAt: "2026-10-13T22:10:00Z",
            },
            agent: {
                status: "up",
                llmReady: "ready",
                verifiedAt: "2026-10-14T01:55:00Z",
                configRevision: "r1",
            },
            lastObservedRun: {
                runId: RUN_ID,
                terminalOutcome: "success",
                errorCode: null,
                terminalAt: "2026-10-14T01:50:00Z",
            },
        },
        transport: { attemptCount: 3, failedCount: 1, partialCount: 1 },
        ...overrides,
    };
}

function attemptsResponse(
    overrides: Partial<RunTransportAttemptsResponse> = {},
): RunTransportAttemptsResponse {
    return {
        runId: RUN_ID,
        attempts: [
            {
                attemptId: ATTEMPT_1,
                seq: 1,
                status: "terminal",
                outcome: "success",
                provider: "custom-openai-compatible",
                model: "wire-model",
                connectionId: CONNECTION_ID,
                connectionRevision: 1,
                startedAt: "2026-10-14T01:59:00Z",
                endedAt: "2026-10-14T01:59:01Z",
                durationMs: 1000,
                errorCode: null,
                firstChunkMs: 83,
                chunkCount: 4,
                uploadBytes: null,
                downloadBytes: null,
                lastProgressStage: null,
                lastProgressElapsedMs: null,
            },
            {
                attemptId: ATTEMPT_2,
                seq: 2,
                status: "running",
                outcome: null,
                provider: "custom-openai-compatible",
                model: "wire-model",
                connectionId: CONNECTION_ID,
                connectionRevision: 1,
                startedAt: "2026-10-14T01:59:02Z",
                endedAt: null,
                durationMs: null,
                errorCode: null,
                firstChunkMs: null,
                chunkCount: null,
                uploadBytes: null,
                downloadBytes: null,
                lastProgressStage: "first_chunk",
                lastProgressElapsedMs: 140,
            },
        ],
        aggregate: { attemptCount: 2, failedCount: 0, partialCount: 0 },
        ...overrides,
    };
}

function traceResponse(overrides: Partial<RunTraceResponse> = {}): RunTraceResponse {
    return {
        runId: RUN_ID,
        asOf: "2026-10-14T02:00:00Z",
        completeness: "complete",
        provenance: {
            status: "unknown",
            providerConnectionId: null,
            connectionRevision: null,
            apiTypeId: null,
            apiTypeVersion: null,
            contextTemplateLayer: null,
            contextTemplateId: null,
            contextTemplateVersion: null,
        },
        sources: [{ source: "chat_run", status: "complete" }],
        events: [],
        nextCursor: null,
        ...overrides,
    };
}

function traceEvent(eventId: string, status: "started" | "succeeded" = "started") {
    return {
        eventId,
        occurredAt: "2026-10-14T01:59:00Z",
        source: "context_event" as const,
        kind: "agent.tool" as const,
        status,
        durationMs: null,
        toolName: "workspace.read_file",
        providerId: null,
        modelId: null,
        errorCode: null,
        usage: null,
        references: { toolCallId: `call-${eventId}` },
    };
}

function runningActivity() {
    return {
        runId: RUN_ID,
        origin: "user_submission",
        status: "running",
        createdAt: "2026-10-14T01:59:00Z",
        waitingOnRunId: null,
        waitingToolCallId: null,
        leaseExpired: false,
    };
}

beforeEach(() => {
    clearTransportLive();
    getRunAttempts.mockResolvedValue(attemptsResponse());
    getRunTrace.mockResolvedValue(traceResponse());
});

function mountPanel(): VueWrapper {
    wrapper = mount(SessionMonitorPanel, {
        props: { sessionId: SESSION_ID },
        global: { plugins: [i18n] },
    });
    return wrapper;
}

afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.clearAllMocks();
});

describe("SessionMonitorPanel", () => {
    it("renders activity/history/readiness from the aggregate and marks Agent readiness as global", async () => {
        getSessionMonitor.mockResolvedValue(
            monitorResponse({
                activity: [
                    {
                        runId: RUN_ID,
                        origin: "user_submission",
                        status: "running",
                        createdAt: "2026-10-14T01:59:00Z",
                        waitingOnRunId: null,
                        waitingToolCallId: null,
                        leaseExpired: false,
                    },
                ],
            }),
        );
        const panel = mountPanel();
        await flushPromises();

        expect(getSessionMonitor).toHaveBeenCalledWith(SESSION_ID);
        expect(panel.findAll('[data-testid="monitor-activity-item"]')).toHaveLength(1);
        expect(panel.findAll('[data-testid="monitor-history-count"]')).toHaveLength(2);
        expect(panel.findAll('[data-testid="monitor-history-item"]')).toHaveLength(1);
        expect(panel.get('[data-testid="monitor-agent-global-tag"]').text()).toBe(
            i18n.global.t("monitor.agentGlobalTag"),
        );
        expect(panel.text()).toContain("READY");
        expect(panel.get('[data-testid="monitor-connection-chip"]').text()).toBe(
            i18n.global.t("monitor.connection.snapshot"),
        );
    });

    it("shows empty states when there are no runs", async () => {
        getSessionMonitor.mockResolvedValue(
            monitorResponse({
                history: { windowSize: 20, counts: {}, recent: [] },
                readiness: {
                    connection: null,
                    agent: {
                        status: "unknown",
                        llmReady: "unknown",
                        verifiedAt: null,
                        configRevision: "",
                    },
                    lastObservedRun: null,
                },
            }),
        );
        const panel = mountPanel();
        await flushPromises();

        expect(panel.find('[data-testid="monitor-activity-empty"]').exists()).toBe(true);
        expect(panel.find('[data-testid="monitor-history-empty"]').exists()).toBe(true);
        expect(panel.get('[data-testid="monitor-connection-missing"]').text()).toBe(
            i18n.global.t("monitor.notProvided"),
        );
        expect(
            panel.get('[data-testid="monitor-trace-run-select"]').attributes("disabled"),
        ).toBeDefined();
    });

    it("loads a selected Run trace and appends cursor pages without reordering or duplicating events", async () => {
        const first = traceEvent("context_event:tool-called", "started");
        const second = {
            ...traceEvent("context_event:tool-result", "succeeded"),
            occurredAt: "2026-10-14T01:59:01Z",
        };
        getSessionMonitor.mockResolvedValue(monitorResponse({ activity: [runningActivity()] }));
        getRunTrace
            .mockResolvedValueOnce(
                traceResponse({ events: [first], nextCursor: "opaque/cursor+one" }),
            )
            .mockResolvedValueOnce(traceResponse({ events: [first, second], nextCursor: null }));

        const panel = mountPanel();
        await flushPromises();

        expect(
            (panel.get('[data-testid="monitor-trace-run-select"]').element as HTMLSelectElement)
                .value,
        ).toBe(RUN_ID);
        expect(getRunTrace).toHaveBeenNthCalledWith(1, RUN_ID, { limit: 100 });
        expect(panel.findAll('[data-testid="run-trace-event"]')).toHaveLength(1);

        await panel.get('[data-testid="run-trace-load-more"]').trigger("click");
        await flushPromises();

        expect(getRunTrace).toHaveBeenNthCalledWith(2, RUN_ID, {
            cursor: "opaque/cursor+one",
            limit: 100,
        });
        expect(
            panel
                .findAll('[data-testid="run-trace-event"]')
                .map((row) => row.attributes("data-event-id")),
        ).toEqual(["context_event:tool-called", "context_event:tool-result"]);
        expect(panel.find('[data-testid="run-trace-load-more"]').exists()).toBe(false);
    });

    it("refreshes the selected Run trace when it moves from activity into history", async () => {
        const terminalEvent = traceEvent("context_event:terminal");
        getSessionMonitor
            .mockResolvedValueOnce(monitorResponse({ activity: [runningActivity()] }))
            .mockResolvedValueOnce(monitorResponse({ activity: [] }));
        getRunTrace
            .mockResolvedValueOnce(traceResponse({ events: [] }))
            .mockResolvedValueOnce(traceResponse({ events: [terminalEvent] }));

        const panel = mountPanel();
        await flushPromises();
        expect(getRunTrace).toHaveBeenCalledTimes(1);
        expect(panel.findAll('[data-testid="run-trace-event"]')).toHaveLength(0);

        vi.useFakeTimers();
        try {
            notifySessionEvent(SESSION_ID);
            await vi.advanceTimersByTimeAsync(500);
            await flushPromises();
        } finally {
            vi.useRealTimers();
        }

        expect(getRunTrace).toHaveBeenCalledTimes(2);
        expect(
            panel
                .findAll('[data-testid="run-trace-event"]')
                .map((row) => row.attributes("data-event-id")),
        ).toEqual(["context_event:terminal"]);
    });

    it("keeps trace errors generic and retries the selected Run", async () => {
        getSessionMonitor.mockResolvedValue(monitorResponse());
        getRunTrace.mockRejectedValueOnce(new Error("raw server detail with prompt=secret"));
        const panel = mountPanel();
        await flushPromises();

        const alert = panel.get('[data-testid="run-trace-timeline"] [role="alert"]');
        expect(alert.text()).toBe(i18n.global.t("monitor.trace.failed"));
        expect(panel.get('[data-testid="run-trace-timeline"]').text()).not.toContain(
            "prompt=secret",
        );

        getRunTrace.mockResolvedValueOnce(
            traceResponse({ events: [traceEvent("context_event:retry")] }),
        );
        await panel.get('[data-testid="run-trace-retry"]').trigger("click");
        await flushPromises();

        expect(getRunTrace).toHaveBeenLastCalledWith(RUN_ID, { limit: 100 });
        expect(panel.findAll('[data-testid="run-trace-event"]')).toHaveLength(1);
    });

    it("rejects a cursor page with a different asOf and retries the same opaque cursor", async () => {
        const first = traceEvent("context_event:first");
        const second = traceEvent("context_event:second", "succeeded");
        getSessionMonitor.mockResolvedValue(monitorResponse());
        getRunTrace
            .mockResolvedValueOnce(
                traceResponse({ events: [first], nextCursor: "fixed-snapshot-cursor" }),
            )
            .mockResolvedValueOnce(
                traceResponse({
                    asOf: "2026-10-14T02:01:00Z",
                    events: [second],
                }),
            )
            .mockResolvedValueOnce(traceResponse({ events: [second] }));

        const panel = mountPanel();
        await flushPromises();
        await panel.get('[data-testid="run-trace-load-more"]').trigger("click");
        await flushPromises();

        expect(panel.findAll('[data-testid="run-trace-event"]')).toHaveLength(1);
        expect(panel.get('[data-testid="run-trace-timeline"] [role="alert"]').text()).toBe(
            i18n.global.t("monitor.trace.loadMoreFailed"),
        );

        await panel.get('[data-testid="run-trace-retry-more"]').trigger("click");
        await flushPromises();

        expect(getRunTrace).toHaveBeenLastCalledWith(RUN_ID, {
            cursor: "fixed-snapshot-cursor",
            limit: 100,
        });
        expect(panel.findAll('[data-testid="run-trace-event"]')).toHaveLength(2);
    });

    it("preserves unknown completeness and conservative source statuses across conflicting pages", async () => {
        getSessionMonitor.mockResolvedValue(monitorResponse());
        getRunTrace
            .mockResolvedValueOnce(
                traceResponse({
                    completeness: "unknown",
                    sources: [
                        { source: "context_event", status: "complete" },
                        { source: "provider_attempt", status: "unknown" },
                        { source: "runtime_job", status: "complete" },
                    ],
                    events: [traceEvent("context_event:first")],
                    nextCursor: "source-conflict-cursor",
                }),
            )
            .mockResolvedValueOnce(
                traceResponse({
                    sources: [
                        { source: "context_event", status: "unavailable" },
                        { source: "provider_attempt", status: "complete" },
                        { source: "runtime_job", status: "not_applicable" },
                    ],
                    events: [traceEvent("context_event:second", "succeeded")],
                }),
            );

        const panel = mountPanel();
        await flushPromises();
        await panel.get('[data-testid="run-trace-load-more"]').trigger("click");
        await flushPromises();

        expect(
            panel.get('[data-testid="run-trace-completeness"]').attributes("data-completeness"),
        ).toBe("unknown");
        expect(
            panel.findAll('[data-testid="run-trace-sources"] li').map((row) => row.text()),
        ).toEqual([
            `context_event: ${i18n.global.t("monitor.trace.sourceStatus.unavailable")}`,
            `provider_attempt: ${i18n.global.t("monitor.trace.sourceStatus.unknown")}`,
            `runtime_job: ${i18n.global.t("monitor.trace.sourceStatus.unavailable")}`,
        ]);
    });

    it("surfaces a fetch failure with retry that recovers", async () => {
        getSessionMonitor.mockRejectedValueOnce(new Error("boom"));
        const panel = mountPanel();
        await flushPromises();

        expect(panel.find('[data-testid="monitor-error"]').exists()).toBe(true);

        getSessionMonitor.mockResolvedValueOnce(monitorResponse());
        await panel.get('[data-testid="monitor-error"] button').trigger("click");
        await flushPromises();

        expect(panel.find('[data-testid="monitor-error"]').exists()).toBe(false);
        expect(panel.findAll('[data-testid="monitor-history-item"]')).toHaveLength(1);
    });

    it("debounces session events into a single refetch", async () => {
        getSessionMonitor.mockResolvedValue(monitorResponse());
        mountPanel();
        await flushPromises();
        expect(getSessionMonitor).toHaveBeenCalledTimes(1);

        notifySessionEvent(SESSION_ID);
        notifySessionEvent(SESSION_ID);
        notifySessionEvent(SESSION_ID);
        await sleep(650);
        await flushPromises();

        expect(getSessionMonitor).toHaveBeenCalledTimes(2);
    });

    it("marks stale on connection failure and recovers on live", async () => {
        getSessionMonitor.mockResolvedValue(monitorResponse());
        const panel = mountPanel();
        await flushPromises();

        notifySessionConnection(SESSION_ID, "offline");
        await flushPromises();
        expect(panel.get('[data-testid="monitor-connection-chip"]').text()).toBe(
            i18n.global.t("monitor.connection.stale"),
        );
        expect(panel.find('[data-testid="monitor-stale-banner"]').exists()).toBe(true);

        notifySessionConnection(SESSION_ID, "live");
        await flushPromises();
        expect(panel.get('[data-testid="monitor-connection-chip"]').text()).toBe(
            i18n.global.t("monitor.connection.live"),
        );
        expect(panel.find('[data-testid="monitor-stale-banner"]').exists()).toBe(false);
    });

    it("keeps the last snapshot visible when a refresh fails", async () => {
        getSessionMonitor.mockResolvedValueOnce(monitorResponse());
        const panel = mountPanel();
        await flushPromises();

        getSessionMonitor.mockRejectedValueOnce(new Error("refresh failed"));
        notifySessionEvent(SESSION_ID);
        await sleep(650);
        await flushPromises();

        expect(panel.find('[data-testid="monitor-fetch-failed-banner"]').exists()).toBe(true);
        expect(panel.findAll('[data-testid="monitor-history-item"]')).toHaveLength(1);
    });

    it("applies an offline signal that arrives before the first fetch resolves", async () => {
        let release: ((value: SessionMonitorResponse) => void) | undefined;
        getSessionMonitor.mockReturnValue(
            new Promise<SessionMonitorResponse>((resolve) => {
                release = resolve;
            }),
        );
        const panel = mountPanel();
        await flushPromises();

        notifySessionConnection(SESSION_ID, "offline");
        await flushPromises();
        release?.(monitorResponse());
        await flushPromises();

        expect(panel.get('[data-testid="monitor-connection-chip"]').text()).toBe(
            i18n.global.t("monitor.connection.stale"),
        );
        expect(panel.find('[data-testid="monitor-stale-banner"]').exists()).toBe(true);
        expect(panel.findAll('[data-testid="monitor-history-item"]')).toHaveLength(1);
    });

    it("renders the session transport aggregate and the latest run's attempt rows", async () => {
        getSessionMonitor.mockResolvedValue(monitorResponse({ activity: [runningActivity()] }));
        const panel = mountPanel();
        await flushPromises();

        const aggregate = panel.get('[data-testid="monitor-transport-aggregate"]').text();
        expect(aggregate).toBe(
            i18n.global.t("monitor.transport.aggregate", {
                attempts: 3,
                failed: 1,
                partial: 1,
            }),
        );
        expect(aggregate).not.toContain("{");

        expect(getRunAttempts).toHaveBeenCalledWith(RUN_ID);
        expect(panel.get('[data-testid="monitor-transport-run"]').text()).toContain("33333333");
        expect(panel.findAll('[data-testid="monitor-transport-stage"]')).toHaveLength(4);

        const rows = panel.findAll('[data-testid="monitor-transport-attempt"]');
        expect(rows).toHaveLength(2);
        // The newest attempt is still running and keeps the durable stage sample.
        expect(rows[1].text()).toContain(i18n.global.t("monitor.transport.running"));
        // The refresh sample is displayed statically (no extrapolation).
        expect(panel.get('[data-testid="monitor-transport-stages"]').text()).toContain("140 ms");

        // v1 wire bytes are unknown, never fabricated.
        const metrics = panel.get('[data-testid="monitor-transport-metrics"]').text();
        expect(metrics).toContain(i18n.global.t("monitor.transport.unknown"));
    });

    it("merges live transport progress without regressing stages and freezes on terminal", async () => {
        getSessionMonitor.mockResolvedValue(monitorResponse({ activity: [runningActivity()] }));
        const panel = mountPanel();
        await flushPromises();

        const liveBase = {
            runId: RUN_ID,
            attemptId: ATTEMPT_2,
            seq: 2,
            startedAt: "2026-10-14T01:59:02Z",
        };
        expect(
            applyTransportProgress(SESSION_ID, {
                ...liveBase,
                stage: "first_chunk",
                elapsedMs: 83,
            }),
        ).toBe(true);
        // Out-of-order stale stages never regress the mirror.
        expect(
            applyTransportProgress(SESSION_ID, {
                ...liveBase,
                stage: "attempt_started",
                elapsedMs: 10,
            }),
        ).toBe(false);
        await flushPromises();

        // The live mirror overrides the fetched running row (83 ms beats 140 ms).
        expect(panel.get('[data-testid="monitor-transport-stages"]').text()).toContain("83 ms");

        expect(
            applyTransportAttempt(SESSION_ID, {
                ...liveBase,
                endedAt: "2026-10-14T01:59:05Z",
                durationMs: 3000,
                outcome: "partial",
                errorCode: "AGENT_STREAM_FAILED",
                firstChunkMs: 83,
                chunkCount: 2,
                uploadBytes: null,
                downloadBytes: null,
            }),
        ).toBe(true);
        await flushPromises();

        const rows = panel.findAll('[data-testid="monitor-transport-attempt"]');
        expect(rows[1].text()).toContain("partial");
        expect(rows[1].text()).toContain("AGENT_STREAM_FAILED");
        // A terminal mirror refuses any further progress for the attempt.
        expect(
            applyTransportProgress(SESSION_ID, { ...liveBase, stage: "streaming", elapsedMs: 90 }),
        ).toBe(false);
    });

    it("refetches attempts together with the monitor aggregate on session events", async () => {
        getSessionMonitor.mockResolvedValue(monitorResponse());
        mountPanel();
        await flushPromises();
        expect(getRunAttempts).toHaveBeenCalledTimes(1);

        notifySessionEvent(SESSION_ID);
        await sleep(650);
        await flushPromises();

        expect(getRunAttempts).toHaveBeenCalledTimes(2);
    });

    it("keeps live attempts visible when the durable history fetch fails", async () => {
        getSessionMonitor.mockResolvedValue(monitorResponse());
        getRunAttempts.mockRejectedValueOnce(new Error("route unavailable"));
        const panel = mountPanel();
        await flushPromises();

        expect(panel.find('[data-testid="monitor-transport-history-unavailable"]').exists()).toBe(
            true,
        );
        expect(panel.find('[data-testid="monitor-transport-empty"]').exists()).toBe(true);

        expect(
            applyTransportAttempt(SESSION_ID, {
                runId: RUN_ID,
                attemptId: ATTEMPT_2,
                seq: 2,
                startedAt: "2026-10-14T01:59:02Z",
                endedAt: "2026-10-14T01:59:03Z",
                durationMs: 900,
                outcome: "success",
                errorCode: null,
                firstChunkMs: 50,
                chunkCount: 1,
                uploadBytes: null,
                downloadBytes: null,
            }),
        ).toBe(true);
        await flushPromises();

        const rows = panel.findAll('[data-testid="monitor-transport-attempt"]');
        expect(rows).toHaveLength(1);
        expect(rows[0].text()).toContain("success");
    });
});
