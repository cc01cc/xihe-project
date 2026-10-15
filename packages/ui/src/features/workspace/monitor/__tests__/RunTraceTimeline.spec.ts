import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { i18n } from "../../../../i18n";
import RunTraceTimeline from "../RunTraceTimeline.vue";

type TraceResponse = NonNullable<InstanceType<typeof RunTraceTimeline>["$props"]["trace"]>;

function traceResponse(overrides: Partial<TraceResponse> = {}): TraceResponse {
    return {
        runId: "run-1",
        asOf: "2026-10-15T10:00:00Z",
        completeness: "complete",
        provenance: {
            status: "complete",
            providerConnectionId: "11111111-1111-4111-8111-111111111111",
            connectionRevision: 4,
            apiTypeId: "openai-chat-completions",
            apiTypeVersion: 2,
            contextTemplateLayer: "workspace",
            contextTemplateId: "22222222-2222-4222-8222-222222222222",
            contextTemplateVersion: 3,
        },
        sources: [
            { source: "chat_run", status: "complete" },
            { source: "context_event", status: "complete" },
        ],
        events: [],
        nextCursor: null,
        ...overrides,
    };
}

function event(
    eventId: string,
    occurredAt: string,
    overrides: Partial<TraceResponse["events"][number]> = {},
): TraceResponse["events"][number] {
    return {
        eventId,
        occurredAt,
        source: "context_event",
        kind: "agent.tool",
        status: "started",
        durationMs: null,
        toolName: null,
        providerId: null,
        modelId: null,
        errorCode: null,
        usage: null,
        references: {},
        ...overrides,
    };
}

function mountTimeline(props: InstanceType<typeof RunTraceTimeline>["$props"]) {
    return mount(RunTraceTimeline, { props, global: { plugins: [i18n] } });
}

describe("RunTraceTimeline", () => {
    it("announces loading accessibly", () => {
        const wrapper = mountTimeline({ trace: null, loading: true, error: false, retry: vi.fn() });

        expect(wrapper.get('[role="status"]').text()).toContain("正在加载");
        expect(wrapper.get('[role="status"]').attributes("aria-live")).toBe("polite");
    });

    it("shows a safe error state and calls retry", async () => {
        const retry = vi.fn();
        const wrapper = mountTimeline({ trace: null, loading: false, error: true, retry });

        expect(wrapper.get('[role="alert"]').text()).toContain("暂时不可用");
        await wrapper.get('[data-testid="run-trace-retry"]').trigger("click");
        expect(retry).toHaveBeenCalledOnce();
    });

    it("shows the server-declared unknown source coverage and a load-more control", async () => {
        const loadMore = vi.fn();
        const wrapper = mountTimeline({
            trace: traceResponse({
                sources: [{ source: "runtime_job", status: "unknown" }],
                nextCursor: "opaque-cursor",
            }),
            loading: false,
            error: false,
            retry: vi.fn(),
            hasMore: true,
            loadingMore: false,
            moreError: false,
            loadMore,
        });

        expect(wrapper.get('[data-testid="run-trace-sources"]').text()).toContain("覆盖未知");
        await wrapper.get('[data-testid="run-trace-load-more"]').trigger("click");
        expect(loadMore).toHaveBeenCalledOnce();
    });

    it("renders an empty state and all three completeness states without inventing events", () => {
        const wrapper = mountTimeline({
            trace: traceResponse({ events: [], completeness: "partial" }),
            loading: false,
            error: false,
            retry: vi.fn(),
        });

        expect(wrapper.get('[data-testid="run-trace-completeness"]').text()).toContain("部分");
        expect(wrapper.get('[role="status"]').text()).toContain("暂无可显示事件");
        expect(wrapper.findAll('[data-testid="run-trace-event"]')).toHaveLength(0);

        for (const completeness of ["complete", "partial", "unknown"] as const) {
            const stateWrapper = mountTimeline({
                trace: traceResponse({ completeness }),
                loading: false,
                error: false,
                retry: vi.fn(),
            });
            const chip = stateWrapper.get('[data-testid="run-trace-completeness"]');
            expect(chip.attributes("data-completeness")).toBe(completeness);
            expect(chip.text()).toContain(
                completeness === "complete" ? "完整" : completeness === "partial" ? "部分" : "未知",
            );
            stateWrapper.unmount();
        }
    });

    it("renders safe configuration provenance and translates input admission", () => {
        const admitted = event("context_event:admission-1", "2026-10-15T09:00:00Z", {
            kind: "input.admitted",
            status: "admitted",
            references: { contextEventId: "77777777-7777-4777-8777-777777777777" },
        });
        const wrapper = mountTimeline({
            trace: traceResponse({ events: [admitted] }),
            loading: false,
            error: false,
            retry: vi.fn(),
        });

        const provenance = wrapper.get('[data-testid="run-trace-provenance"]');
        expect(provenance.attributes("data-provenance-status")).toBe("complete");
        expect(provenance.text()).toContain("openai-chat-completions");
        expect(provenance.text()).toContain("11111111-1111-4111-8111-111111111111");
        const events = wrapper.get('[data-testid="run-trace-events"]');
        expect(events.text()).toContain("用户输入已接收");
        expect(events.text()).toContain("已接收");
    });

    it("shows each missing provenance field as unknown when coverage is partial", () => {
        const wrapper = mountTimeline({
            trace: traceResponse({
                provenance: {
                    status: "partial",
                    providerConnectionId: null,
                    connectionRevision: 4,
                    apiTypeId: null,
                    apiTypeVersion: 2,
                    contextTemplateLayer: null,
                    contextTemplateId: null,
                    contextTemplateVersion: 3,
                },
            }),
            loading: false,
            error: false,
            retry: vi.fn(),
        });

        const provenance = wrapper.get('[data-testid="run-trace-provenance"]');
        expect(provenance.attributes("data-provenance-status")).toBe("partial");
        expect(provenance.text()).toContain("Provider Connection: 未知");
        expect(provenance.text()).toContain("API 类型: 未知");
        expect(provenance.text()).toContain("上下文模板层: 未知");
    });

    it("preserves API time order and shows only allowlisted trace fields", () => {
        const earlier = event("provider_attempt:attempt-b", "2026-10-15T09:00:00.000000001Z", {
            source: "provider_attempt",
            kind: "provider.attempt",
            status: "failed",
            providerId: "provider-a",
            modelId: "model-b",
            durationMs: 125,
            errorCode: "UPSTREAM_TIMEOUT",
            usage: { inputTokens: 0, outputTokens: 7, totalTokens: 7 },
            references: { attemptId: "attempt-456" },
        });
        const later = event("context_event:evt-a", "2026-10-15T09:00:00.000000002Z", {
            source: "context_event",
            kind: "agent.tool",
            status: "started",
            toolName: "image.generate",
            durationMs: null,
            references: { toolCallId: "call-123" },
        });
        const wrapper = mountTimeline({
            trace: traceResponse({ events: [earlier, later] }),
            loading: false,
            error: false,
            retry: vi.fn(),
        });

        const rows = wrapper.findAll('[data-testid="run-trace-event"]');
        expect(rows.map((row) => row.attributes("data-event-id"))).toEqual([
            "provider_attempt:attempt-b",
            "context_event:evt-a",
        ]);
        expect(rows[0].text()).toContain("provider-a");
        expect(rows[0].text()).toContain("model-b");
        expect(rows[0].text()).toContain("UPSTREAM_TIMEOUT");
        expect(rows[0].text()).toContain("耗时: 125 毫秒");
        expect(rows[0].text()).toContain("输入 tokens: 0");
        expect(rows[0].text()).toContain("输出 tokens: 7");
        expect(rows[1].text()).toContain("image.generate");
        expect(rows[1].text()).toContain("toolCallId: call-123");
        expect(rows[1].text()).toContain("耗时: 未知");
        expect(rows[0].text()).not.toContain("arguments");
        expect(rows[0].text()).not.toContain("result");
        expect(rows[0].text()).not.toContain("prompt");
    });

    it("hides unsafe tool names, error codes, and reference values", () => {
        const unsafe = Object.assign(
            event("context_event:evt-secret", "2026-10-15T09:00:00Z", {
                toolName: "tool-name with spaces",
                errorCode: "raw exception with body",
                references: { toolCallId: "https://host.invalid/?token=secret" },
            }),
            {
                arguments: "ARGUMENT_SECRET",
                result: "RESULT_SECRET",
                prompt: "PROMPT_SECRET",
                body: "BODY_SECRET",
            },
        );
        unsafe.references = {
            toolCallId: "https://host.invalid/?token=secret",
            privatePayload: "PRIVATE_REFERENCE_SECRET",
        } as unknown as TraceResponse["events"][number]["references"];
        const wrapper = mountTimeline({
            trace: traceResponse({ events: [unsafe] }),
            loading: false,
            error: false,
            retry: vi.fn(),
        });

        const text = wrapper.get('[data-testid="run-trace-event"]').text();
        expect(text).not.toContain("tool-name with spaces");
        expect(text).not.toContain("raw exception with body");
        expect(text).not.toContain("token=secret");
        expect(text).not.toContain("ARGUMENT_SECRET");
        expect(text).not.toContain("RESULT_SECRET");
        expect(text).not.toContain("PROMPT_SECRET");
        expect(text).not.toContain("BODY_SECRET");
        expect(text).not.toContain("PRIVATE_REFERENCE_SECRET");
    });
});
