import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import SseSubscriberLimitNotice from "../SseSubscriberLimitNotice.vue";
import {
    __resetSseSubscriberLimitForTests,
    reportSseSubscriberLimit,
} from "../../composables/sseSubscriberLimit";

/**
 * PLAN-0676 T2：同一横幅的三态渲染（`limit` / `disconnected` / `reconnecting`）。
 *
 * 边界（Lead 裁定）：横幅组件归 t56，本批只**加**三态 props 与文案，**不改**她的状态机——
 * 所以这里同时钉住"不传 `state` 时退回 BL-335 的模块级 `limit` 行为"，防止扩展把老路径弄坏。
 */
function mountNotice(props: Record<string, unknown> = {}) {
    const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": {} } });
    return mount(SseSubscriberLimitNotice, {
        props,
        global: {
            plugins: [i18n],
            // 只断言结构与 i18n key 命中，不锁死文案（文案会随语种/措辞演进）。
            stubs: { TriangleAlertIcon: true, RefreshCwIcon: true },
        },
    });
}

describe("SseSubscriberLimitNotice", () => {
    beforeEach(() => {
        __resetSseSubscriberLimitForTests();
    });

    it("renders nothing when there is no state and no module-level limit", () => {
        expect(mountNotice().find('[data-testid="sse-subscriber-limit-notice"]').exists()).toBe(
            false,
        );
    });

    it("keeps the BL-335 module-state path working (no state prop)", () => {
        reportSseSubscriberLimit("WORKSPACE_EVENT_SUBSCRIBERS_LIMIT");
        const wrapper = mountNotice();
        const notice = wrapper.get('[data-testid="sse-subscriber-limit-notice"]');

        expect(notice.attributes("data-state")).toBe("limit");
        expect(notice.attributes("data-reason")).toContain("WORKSPACE_EVENT_SUBSCRIBERS_LIMIT");
        expect(notice.attributes("role")).toBe("status");
        expect(notice.attributes("aria-live")).toBe("polite");
    });

    it.each([
        ["limit", "WORKSPACE_EVENT_SUBSCRIBERS_LIMIT"],
        ["disconnected", "SSE_SEND_FAILED"],
        ["reconnecting", undefined],
    ])("renders the %s state with its own copy and reason", (state, code) => {
        const wrapper = mountNotice({ state, code });
        const notice = wrapper.get('[data-testid="sse-subscriber-limit-notice"]');

        expect(notice.attributes("data-state")).toBe(state);
        // 诊断靠 data-reason，不靠文案（文案不出现裸 code）。
        expect(notice.attributes("data-reason")).toBe(code ?? "unknown");
        expect(notice.text()).not.toContain(code ?? "unknown");
    });

    it("only offers retry where retrying can help (not while reconnecting)", () => {
        const retry = vi.fn<() => void>();
        const disconnected = mountNotice({ state: "disconnected", onRetry: retry });
        const button = disconnected.get('[data-testid="sse-notice-retry"]');
        void button.trigger("click");
        expect(retry).toHaveBeenCalledTimes(1);

        const reconnecting = mountNotice({ state: "reconnecting", onRetry: retry });
        expect(reconnecting.find('[data-testid="sse-notice-retry"]').exists()).toBe(false);
    });

    it("names the workspace when provided", () => {
        const wrapper = mountNotice({ state: "disconnected", workspaceName: "研发工作区" });
        expect(wrapper.text()).toContain("研发工作区");
    });
});
