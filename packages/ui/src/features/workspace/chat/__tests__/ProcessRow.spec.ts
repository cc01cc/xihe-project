import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { h } from "vue";
import { Wrench } from "@lucide/vue";
import ProcessRow from "../components/ProcessRow.vue";

/**
 * ProcessRow = 2026-11-04 用户裁定（DSH 式过程渲染）里唯一的单行可折叠 chip：
 * 思考 / 推理 / 工具调用 / refusal 共用它。本 spec 钉四件事：
 * ① 默认折叠、点击/`aria-expanded` 切换；② 失败态在折叠行上就有颜色 + `data-failed`；
 * ③ `testid`/`toggle-testid` 可由调用方覆盖（ToolCallCard 用 `tool-card-toggle`）；
 * ④ actor 徽标（PLAN-0659 T1.2）：给 `actor` 就渲染首字母 + 名字 + `data-actor-*`；
 *    不给（单主体线程）就完全不渲染 —— 是否传由调用方按线程主体数决定。
 */
describe("ProcessRow", () => {
    it("renders a single collapsed row with label, summary, meta and status", () => {
        const wrapper = mount(ProcessRow, {
            props: {
                kind: "tool",
                label: "read_file",
                summary: "src/main.ts",
                meta: "12ms",
                status: "已完成",
                icon: Wrench,
            },
            slots: { default: () => h("p", "body") },
        });

        const row = wrapper.get('[data-testid="process-row"]');
        expect(row.attributes("data-process-kind")).toBe("tool");
        expect(wrapper.get('[data-testid="process-row-summary"]').text()).toBe("src/main.ts");
        expect(wrapper.get('[data-testid="process-row-meta"]').text()).toBe("12ms");
        expect(wrapper.text()).toContain("已完成");
        // 默认折叠：展开体不渲染，chevron 在。
        expect(wrapper.text()).not.toContain("body");
        expect(wrapper.find('[data-testid="process-row-chevron"]').exists()).toBe(true);
    });

    it("toggles on click and reflects aria-expanded", async () => {
        const wrapper = mount(ProcessRow, {
            props: { kind: "reasoning", label: "思考" },
            slots: { default: () => h("p", "body") },
        });
        const toggle = wrapper.get('[data-testid="process-row-toggle"]');
        expect(toggle.attributes("aria-expanded")).toBe("false");

        await toggle.trigger("click");
        expect(toggle.attributes("aria-expanded")).toBe("true");
        expect(wrapper.text()).toContain("body");
    });

    it("marks failed rows on the collapsed line (color + data-failed), no expand needed", () => {
        const wrapper = mount(ProcessRow, {
            props: {
                kind: "tool",
                label: "spawn_worker",
                status: "已拒绝",
                failed: true,
                testid: "tool-card",
                toggleTestid: "tool-card-toggle",
            },
            slots: { default: () => h("p", "body") },
        });

        const row = wrapper.get('[data-testid="tool-card"]');
        expect(row.attributes("data-failed")).toBe("true");
        expect(wrapper.get('[data-testid="tool-card-toggle"]').text()).toContain("已拒绝");
        // 红色落在这条折叠行上（label 用 destructive），不必展开。
        expect(wrapper.get("button").html()).toContain("text-destructive");
    });

    it("renders the actor badge (initials + name + DOM identity) for mixed-principal threads", () => {
        const wrapper = mount(ProcessRow, {
            props: {
                kind: "tool",
                label: "read_file",
                actor: {
                    name: "Agent Alpha",
                    initials: "AA",
                    kind: "AGENT",
                    principalId: "part-agent-alpha",
                },
            },
        });
        expect(wrapper.get('[data-testid="process-row"]').attributes("data-has-actor")).toBe(
            "true",
        );
        const badge = wrapper.get('[data-testid="process-row-actor"]');
        // 身份断言认 participantId / kind，不认名字文本。
        expect(badge.attributes("data-actor-principal-id")).toBe("part-agent-alpha");
        expect(badge.attributes("data-actor-kind")).toBe("AGENT");
        expect(wrapper.get('[data-testid="process-row-actor-initials"]').text()).toBe("AA");
        expect(badge.text()).toContain("Agent Alpha");
        // 徽标靠 title 兜住截断后的全名。
        expect(badge.attributes("title")).toBe("Agent Alpha");
    });

    it("renders no actor badge when the caller passes no actor (single-principal thread)", () => {
        const wrapper = mount(ProcessRow, { props: { kind: "tool", label: "read_file" } });
        expect(wrapper.find('[data-testid="process-row-actor"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="process-row"]').attributes("data-has-actor")).toBe(
            undefined,
        );
    });

    it("drops the chevron and the click affordance when there is no body", () => {
        const wrapper = mount(ProcessRow, {
            props: { kind: "thinking", label: "思考中", expandable: false },
        });
        expect(wrapper.find('[data-testid="process-row-chevron"]').exists()).toBe(false);
        expect(wrapper.text()).toContain("思考中");
    });

    it("renders the always-visible extra slot (e.g. waiting-on row) while collapsed", () => {
        const wrapper = mount(ProcessRow, {
            props: { kind: "tool", label: "delegate" },
            slots: {
                extra: () => h("div", { "data-testid": "extra-row" }, "waiting"),
                default: () => h("p", "body"),
            },
        });
        expect(wrapper.find('[data-testid="extra-row"]').exists()).toBe(true);
        expect(wrapper.text()).not.toContain("body");
    });
});
