import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { i18n } from "../../../../i18n";
import { api } from "../../../../composables/api";
import { notifySessionConnection, notifySessionEvent } from "../../chat/sessionEvents";
import SessionMonitorPanel from "../SessionMonitorPanel.vue";
import type { SessionMonitorResponse } from "../../../../types";

vi.mock("../../../../composables/api", () => ({
    api: {
        getSessionMonitor: vi.fn<(sessionId: string) => Promise<SessionMonitorResponse>>(),
    },
}));

const getSessionMonitor = vi.mocked(api.getSessionMonitor);
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";

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
        ...overrides,
    };
}

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
});
