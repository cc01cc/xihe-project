import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import SessionDerivedStatePanel from "../SessionDerivedStatePanel.vue";
import { i18n } from "../../../i18n";

describe("SessionDerivedStatePanel (PLAN-0408 T3.1)", () => {
    it("shows active and terminal children separately and uses a generic label for a hidden name", () => {
        const wrapper = mount(SessionDerivedStatePanel, {
            props: {
                activeChildren: [
                    {
                        childSessionId: "11111111-1111-4111-8111-111111111111",
                        runId: "22222222-2222-4222-8222-222222222222",
                        name: null,
                        status: "awaiting_approval",
                    },
                ],
                terminalNotices: [
                    {
                        childSessionId: "33333333-3333-4333-8333-333333333333",
                        runId: "44444444-4444-4444-8444-444444444444",
                        name: "Research child",
                        state: "partial",
                        terminalAt: "2026-09-27T04:00:00Z",
                    },
                ],
            },
            global: { plugins: [i18n] },
        });

        expect(wrapper.find('[data-testid="derived-active-children"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="derived-terminal-notices"]').exists()).toBe(true);
        expect(wrapper.get('[data-testid="derived-active-child"]').text()).toContain("子会话");
        expect(wrapper.get('[data-testid="derived-child-status"]').text()).toContain("等待审批");
        expect(wrapper.get('[data-testid="derived-terminal-notice"]').text()).toContain(
            "Research child",
        );
        expect(wrapper.get('[data-testid="derived-terminal-state"]').text()).toContain("部分完成");
        expect(wrapper.get("time").attributes("datetime")).toBe("2026-09-27T04:00:00Z");
        expect(wrapper.text()).not.toContain("11111111-1111-4111-8111-111111111111");
    });

    it("keeps an error status visible instead of fabricating an empty result", () => {
        const wrapper = mount(SessionDerivedStatePanel, {
            props: { activeChildren: [], terminalNotices: [], error: true },
            global: { plugins: [i18n] },
        });

        expect(wrapper.get('[data-testid="derived-state-error"]').text()).toContain(
            "子任务状态暂不可用",
        );
    });
});
