import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import WorkspaceDock from "../WorkspaceDock.vue";

const i18n = createI18n({
    legacy: false,
    locale: "en",
    messages: {
        en: {
            workspace: {
                dockTabs: "Workbench panels",
                dockOverflow: "More panels",
                dockCloseTab: "Close this panel",
                dockResize: "Resize the panel",
                closePanel: "Close the auxiliary panel",
            },
        },
    },
});

const THREE_TABS = [
    { id: "code", label: "Code" },
    { id: "changes", label: "Changes" },
    { id: "monitor", label: "Monitor" },
];

function mountDock(
    props: Partial<{
        tabs: { id: string; label: string }[];
        activeTab: string;
        width: number;
        maxVisibleTabs: number;
    }> = {},
) {
    return mount(WorkspaceDock, {
        props: { tabs: THREE_TABS, activeTab: "code", width: 360, ...props },
        global: { plugins: [i18n] },
        slots: {
            code: '<div data-testid="dock-code-content" />',
            changes: '<div data-testid="dock-changes-content" />',
            monitor: '<div data-testid="dock-monitor-content" />',
            alpha: '<div data-testid="dock-alpha-content" />',
            beta: '<div data-testid="dock-beta-content" />',
        },
    });
}

describe("WorkspaceDock (PLAN-0582 S2)", () => {
    it("renders the open tab set with exactly one active tab and only its content", () => {
        const wrapper = mountDock();

        expect(wrapper.get('[data-testid="workspace-aux-panel"]').exists()).toBe(true);
        expect(wrapper.findAll('[role="tab"]')).toHaveLength(3);
        expect(wrapper.get('[data-testid="dock-tab-code"]').attributes("aria-selected")).toBe(
            "true",
        );
        expect(wrapper.get('[data-testid="dock-tab-changes"]').attributes("aria-selected")).toBe(
            "false",
        );
        // Only the active panel is mounted (single active tab).
        expect(wrapper.find('[data-testid="dock-code-content"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="dock-changes-content"]').exists()).toBe(false);
    });

    it("emits the tab activation intent when another tab is clicked", async () => {
        const wrapper = mountDock();

        await wrapper.get('[data-testid="dock-tab-monitor"]').trigger("click");

        expect(wrapper.emitted("update:activeTab")?.at(-1)).toEqual(["monitor"]);
    });

    it("closes a tab from its own close affordance and from a middle click", async () => {
        const wrapper = mountDock();

        // Visible close affordance only on the active tab.
        expect(wrapper.find('[data-testid="dock-tab-close-changes"]').exists()).toBe(false);
        await wrapper.get('[data-testid="dock-tab-close-code"]').trigger("click");
        expect(wrapper.emitted("close-tab")?.at(-1)).toEqual(["code"]);

        // Middle click anywhere on a tab closes it; other buttons do not.
        await wrapper.get('[data-testid="dock-tab-changes"]').trigger("auxclick", { button: 0 });
        expect(wrapper.emitted("close-tab")).toHaveLength(1);
        await wrapper.get('[data-testid="dock-tab-changes"]').trigger("auxclick", { button: 1 });
        expect(wrapper.emitted("close-tab")?.at(-1)).toEqual(["changes"]);
    });

    it("moves tabs beyond the visible limit into an overflow menu", async () => {
        const tabs = [
            { id: "code", label: "Code" },
            { id: "changes", label: "Changes" },
            { id: "monitor", label: "Monitor" },
            { id: "alpha", label: "Alpha" },
            { id: "beta", label: "Beta" },
        ];
        const wrapper = mountDock({ tabs, activeTab: "code", maxVisibleTabs: 3 });

        expect(wrapper.findAll('[role="tab"]')).toHaveLength(3);
        expect(wrapper.find('[data-testid="dock-overflow-menu"]').exists()).toBe(false);

        await wrapper.get('[data-testid="dock-overflow-trigger"]').trigger("click");

        const menu = wrapper.get('[data-testid="dock-overflow-menu"]');
        expect(menu.text()).toContain("Alpha");
        expect(menu.text()).toContain("Beta");

        await wrapper.get('[data-testid="dock-overflow-item-beta"]').trigger("click");
        expect(wrapper.emitted("update:activeTab")?.at(-1)).toEqual(["beta"]);
        // Selecting from the menu closes it.
        expect(wrapper.find('[data-testid="dock-overflow-menu"]').exists()).toBe(false);
    });

    it("does not render an overflow trigger when every tab fits", () => {
        const wrapper = mountDock();

        expect(wrapper.find('[data-testid="dock-overflow-trigger"]').exists()).toBe(false);
    });

    it("resizes with the pointer and clamps into the 320-480 range", async () => {
        const wrapper = mountDock({ width: 360 });
        const resizer = wrapper.get('[data-testid="dock-resizer"]');

        expect(resizer.attributes("role")).toBe("separator");
        expect(resizer.attributes("aria-orientation")).toBe("vertical");
        expect(resizer.attributes("aria-valuenow")).toBe("360");
        expect(resizer.attributes("aria-valuemin")).toBe("320");
        expect(resizer.attributes("aria-valuemax")).toBe("480");

        // Dragging the left edge right makes the dock narrower (right-hand panel).
        await resizer.trigger("mousedown", { clientX: 1000 });
        document.dispatchEvent(new MouseEvent("mousemove", { clientX: 1060 }));
        document.dispatchEvent(new MouseEvent("mouseup", {}));

        expect(wrapper.emitted("update:width")?.at(-1)).toEqual([320]);
    });

    it("resizes with the keyboard on the separator", async () => {
        const wrapper = mountDock({ width: 360 });
        const resizer = wrapper.get('[data-testid="dock-resizer"]');

        await resizer.trigger("keydown", { key: "ArrowLeft" });
        expect(wrapper.emitted("update:width")?.at(-1)).toEqual([376]);

        await resizer.trigger("keydown", { key: "ArrowRight" });
        expect(wrapper.emitted("update:width")?.at(-1)).toEqual([344]);

        await resizer.trigger("keydown", { key: "Home" });
        expect(wrapper.emitted("update:width")?.at(-1)).toEqual([320]);

        await resizer.trigger("keydown", { key: "End" });
        expect(wrapper.emitted("update:width")?.at(-1)).toEqual([480]);
    });

    it("emits a collapse intent from its header close button", async () => {
        const wrapper = mountDock();

        await wrapper.get('[data-testid="workspace-aux-close"]').trigger("click");

        expect(wrapper.emitted("close")).toHaveLength(1);
        expect(wrapper.emitted("close-tab")).toBeUndefined();
    });

    it("stays out of the flex layout below 1800px and becomes inline above it", () => {
        const wrapper = mountDock();
        const classes = wrapper.get('[data-testid="workspace-aux-panel"]').classes();

        // Ruling #3: overlay by default (absolute), flex child only at min-[1800px].
        expect(classes).toContain("absolute");
        expect(classes).toContain("min-[1800px]:static");
        expect(classes).toContain("z-20");
    });

    it("keeps the configured width as an inline style so widths are independent of mode", () => {
        const wrapper = mountDock({ width: 420 });

        expect(wrapper.get('[data-testid="workspace-aux-panel"]').attributes("style")).toContain(
            "width: 420px",
        );
    });
});
