import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import RunGroupHeader from "../components/RunGroupHeader.vue";

/**
 * PLAN-0659 T1.1：run 头（runId 短码 + 主体名 + 状态徽标 + 耗时 + 折叠开关）。
 * 身份只用 `data-run-id` 全文断言（短码仅展示）。
 */
const i18n = createI18n({
    legacy: false,
    locale: "zh",
    messages: {
        zh: {
            chat: {
                runHeader: { toggle: "展开或折叠 run {run}" },
                followUpStatusCompleted: "已完成",
                followUpStatusFailed: "失败",
                derivedStateStatus: {
                    running: "运行中",
                },
            },
        },
    },
});

function mountHeader(props: Record<string, unknown> = {}) {
    return mount(RunGroupHeader, {
        props: {
            runId: "3f2a9c11-aaaa-bbbb-cccc-dddddddddddd",
            status: "succeeded",
            createdAt: "2026-11-04T10:00:00.000Z",
            terminalAt: "2026-11-04T10:00:03.400Z",
            principalName: "Atlas · 架构",
            collapsed: false,
            ...props,
        },
        global: { plugins: [i18n] },
    });
}

describe("RunGroupHeader", () => {
    it("renders run short code, principal, status and duration", () => {
        const wrapper = mountHeader();

        const header = wrapper.get('[data-testid="run-header"]');
        expect(header.attributes("data-run-id")).toBe("3f2a9c11-aaaa-bbbb-cccc-dddddddddddd");
        expect(header.attributes("data-run-status")).toBe("succeeded");
        expect(wrapper.get('[data-testid="run-header-run-id"]').text()).toBe("run-3f2a9c");
        expect(wrapper.get('[data-testid="run-header-principal"]').text()).toContain("Atlas");
        expect(wrapper.get('[data-testid="run-header-status"]').text()).toBe("已完成");
        expect(wrapper.get('[data-testid="run-header-duration"]').text()).toBe("3.4s");
        expect(header.attributes("data-failed")).toBeUndefined();
    });

    it("marks failed runs on the collapsed header line (no expand needed)", () => {
        const wrapper = mountHeader({ status: "failed", terminalOutcome: "error" });

        const header = wrapper.get('[data-testid="run-header"]');
        expect(header.attributes("data-failed")).toBe("true");
        expect(wrapper.get('[data-testid="run-header-status"]').classes().join(" ")).toContain(
            "text-destructive",
        );
    });

    it("reflects collapsed state and emits toggle", async () => {
        const wrapper = mountHeader({ collapsed: true });
        const toggle = wrapper.get('[data-testid="run-header-toggle"]');
        expect(toggle.attributes("aria-expanded")).toBe("false");

        await toggle.trigger("click");
        expect(wrapper.emitted("toggle")).toHaveLength(1);
    });

    it("omits duration while the run is still active (no terminalAt)", () => {
        const wrapper = mountHeader({ status: "running", terminalAt: null });
        expect(wrapper.find('[data-testid="run-header-duration"]').exists()).toBe(false);
    });
});
