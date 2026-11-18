import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import SessionItem from "../components/SessionItem.vue";

vi.mock("vue-i18n", () => ({
    useI18n: () => ({ t: (key: string) => key }),
}));

describe("SessionItem", () => {
    it("renders title and time", () => {
        const session = { id: "s1", title: "My Chat", updatedAt: new Date().toISOString() };
        const wrapper = mount(SessionItem, {
            props: { session, isActive: false },
        });
        expect(wrapper.text()).toContain("My Chat");
    });

    it("applies active class when isActive is true", () => {
        const session = { id: "s1", title: "Active", updatedAt: new Date().toISOString() };
        const wrapper = mount(SessionItem, {
            props: { session, isActive: true },
        });
        const classes = wrapper.find("div").classes();
        const hasActive = classes.some(
            (c: string) => c.includes("active") || c.includes("Active") || c.includes("bg-"),
        );
        expect(hasActive).toBe(true);
    });

    it("renders clickable session", () => {
        const session = { id: "s1", title: "Clickable", updatedAt: new Date().toISOString() };
        const wrapper = mount(SessionItem, {
            props: { session, isActive: false },
        });
        expect(wrapper.text()).toContain("Clickable");
        expect(wrapper.find("div").exists()).toBe(true);
    });

    it("renders a non-interactive pending approval badge with its count", () => {
        const session = { id: "s1", title: "Pending", updatedAt: new Date().toISOString() };
        const wrapper = mount(SessionItem, {
            props: { session, isActive: false, pendingCount: 2 },
        });

        const badge = wrapper.find('[data-testid="session-pending-badge"]');
        expect(badge.exists()).toBe(true);
        expect(badge.text()).toContain("sidebar.pendingApprovalBadge");
        expect(badge.text()).toContain("2");
        expect(badge.element.tagName).toBe("SPAN");
    });

    it("supports keyboard selection without adding a nested button", async () => {
        const session = { id: "s1", title: "Keyboard", updatedAt: new Date().toISOString() };
        const wrapper = mount(SessionItem, {
            props: { session, isActive: false },
        });

        await wrapper.find('[data-testid="session-item"]').trigger("keydown", { key: "Enter" });
        expect(wrapper.emitted("select")).toEqual([["s1"]]);
        expect(wrapper.find('[data-testid="session-pending-badge"]').exists()).toBe(false);
    });

    it("offers fork from the active session context menu only", async () => {
        const session = { id: "s1", title: "Current", updatedAt: new Date().toISOString() };
        const active = mount(SessionItem, {
            props: { session, isActive: true },
            global: { stubs: { Teleport: true } },
        });
        await active.get('[data-testid="session-item"]').trigger("contextmenu");
        await active.get('[data-testid="session-item-fork"]').trigger("click");
        expect(active.emitted("fork")).toEqual([["s1"]]);

        const inactive = mount(SessionItem, {
            props: { session, isActive: false },
            global: { stubs: { Teleport: true } },
        });
        await inactive.get('[data-testid="session-item"]').trigger("contextmenu");
        expect(inactive.find('[data-testid="session-item-fork"]').exists()).toBe(false);
        active.unmount();
        inactive.unmount();
    });

    /**
     * D-1828（条目 57B）：移动态会话行恢复**可见**标题（用户裁 B；行高增加/条数下降为已接受代价）。
     *
     * <p>背景取证：batch-4 的「21px 纯图标仅靠 aria-label 可辨」读数出自**关态**抽屉探针，
     * task-58 开态复测 247.6px 行宽、标题可见 —— 本用例是把「标题必须在可见文本里」这一裁定的
     * **负例锁**：若哪天行退回纯图标（标题只进 aria-label），text() 立即丢标题 ⇒ 红。</p>
     */
    it("D-1828: renders the title as a visible truncated span, not only aria-label (mobile ruling)", () => {
        const session = { id: "s1", title: "移动态可见标题", updatedAt: new Date().toISOString() };
        const wrapper = mount(SessionItem, {
            props: { session, isActive: false },
        });

        const row = wrapper.get('[data-testid="session-item"]');
        // 可见文本（不是可访问名）：标题在 textContent 里。
        expect(row.text()).toContain("移动态可见标题");
        // 呈现形式：截断样式的标题 span（移动态侧栏靠它在 220–360px 里截断）。
        const titleSpan = row.find("span.truncate");
        expect(titleSpan.exists()).toBe(true);
        expect(titleSpan.text()).toBe("移动态可见标题");
        // aria-label 保留（读屏双保险），但**不能是唯一的标题载体**。
        expect(row.attributes("aria-label")).toBe("移动态可见标题");
    });
});
