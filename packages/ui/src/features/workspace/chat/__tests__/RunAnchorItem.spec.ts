import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { i18n } from "../../../../i18n";
import RunAnchorItem from "../components/RunAnchorItem.vue";
import type { DerivedRunAnchor } from "../derivedAnchors";

/**
 * task-1 / D-1846：anchor 卡片（呈现层）。三条断言面：
 *  - 状态文案/tier 来自 `runStateView`（同一张表，不在这里另立词）；
 *  - 主体名优先、UUID 永不上屏、无名时退化为 run 短码（契约 A4.3）；
 *  - 整卡是 `<button>`，点击 emit 子会话 id（契约 A5）。
 */
function anchor(overrides: Partial<DerivedRunAnchor> = {}): DerivedRunAnchor {
    return {
        key: "run-1",
        runId: "11111111-2222-3333-4444-555555555555",
        sessionId: "child-session-1",
        spawnedFromSessionId: "parent",
        startedAt: "2026-11-18T10:00:00.000Z",
        agentPrincipalId: "principal-xh",
        agentPrincipalName: "xh lead",
        subject: null,
        status: "running",
        terminalAt: null,
        ...overrides,
    };
}

function mountItem(value: DerivedRunAnchor) {
    return mount(RunAnchorItem, {
        props: { anchor: value },
        global: { plugins: [i18n] },
    });
}

describe("RunAnchorItem (task-1 derived anchor)", () => {
    it("shows the principal name, the derived status label and stays a button", () => {
        const wrapper = mountItem(anchor({ status: "running" }));
        expect(wrapper.get('[data-testid="run-anchor-label"]').text()).toBe("xh lead");
        expect(wrapper.get('[data-testid="run-anchor-status"]').text()).toBe(
            i18n.global.t("chat.derivedStateStatus.running"),
        );
        expect(wrapper.get('[data-testid="run-anchor"]').attributes("data-anchor-tier")).toBe(
            "active",
        );
        // 在途不显示耗时（runView 的既有裁定：不引定时器重渲染）。
        expect(wrapper.find('[data-testid="run-anchor-duration"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="run-anchor-open"]').element.tagName).toBe("BUTTON");
        // UUID 不上屏（DEV-032）；身份只在 DOM 属性上供断言/排障。
        expect(wrapper.text()).not.toContain("1111");
        expect(wrapper.get('[data-testid="run-anchor"]').attributes("data-anchor-run-id")).toBe(
            "11111111-2222-3333-4444-555555555555",
        );
    });

    it("updates in place: terminal status keeps the same DOM identity and gains a duration", () => {
        const running = mountItem(anchor({ status: "running" }));
        const done = mountItem(
            anchor({ status: "succeeded", terminalAt: "2026-11-18T10:00:03.400Z" }),
        );

        expect(done.get('[data-testid="run-anchor"]').attributes("data-anchor-session-id")).toBe(
            running.get('[data-testid="run-anchor"]').attributes("data-anchor-session-id"),
        );
        expect(done.get('[data-testid="run-anchor"]').attributes("data-anchor-tier")).toBe(
            "terminal",
        );
        expect(done.get('[data-testid="run-anchor-duration"]').text()).toBe("3.4s");
        expect(done.get('[data-testid="run-anchor-status"]').text()).toBe(
            i18n.global.t("chat.followUpStatusCompleted"),
        );
    });

    it("marks failures explicitly instead of staying silent (N4)", () => {
        const wrapper = mountItem(
            anchor({ status: "failed", terminalAt: "2026-11-18T10:00:20.000Z" }),
        );
        const status = wrapper.get('[data-testid="run-anchor-status"]');
        expect(status.text()).toBe(i18n.global.t("chat.followUpStatusFailed"));
        expect(status.classes()).toContain("text-destructive");
        expect(wrapper.get('[data-testid="run-anchor"]').attributes("data-anchor-status")).toBe(
            "failed",
        );
    });

    it("falls back to a run short code when no principal name is resolvable (N5)", () => {
        const wrapper = mountItem(
            anchor({
                agentPrincipalName: null,
                subject: null,
                runId: "abcdef12-0000-0000-0000-0000",
            }),
        );
        expect(wrapper.get('[data-testid="run-anchor-label"]').text()).toBe("run-abcdef");
    });

    it("renders no status label at all when the status is unknown (never guesses)", () => {
        const wrapper = mountItem(anchor({ status: null }));
        expect(wrapper.find('[data-testid="run-anchor-status"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="run-anchor"]').attributes("data-anchor-tier")).toBe(
            undefined,
        );
    });

    it("emits the child session id on click, with an accessible open label", async () => {
        const wrapper = mountItem(anchor());
        await wrapper.get('[data-testid="run-anchor-open"]').trigger("click");
        expect(wrapper.emitted("open")).toEqual([["child-session-1"]]);
        expect(wrapper.get('[data-testid="run-anchor-open"]').attributes("aria-label")).toContain(
            "xh lead",
        );
    });

    it("shows a distinct task name next to the principal when it is not an inherited title", () => {
        const wrapper = mountItem(anchor({ subject: "dsd 迁移方案" }));
        expect(wrapper.get('[data-testid="run-anchor-subject"]').text()).toBe("dsd 迁移方案");
    });
});
