import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import WorkspaceContainerAddButton from "../WorkspaceContainerAddButton.vue";

const i18n = createI18n({
    legacy: false,
    locale: "en",
    messages: {
        en: {
            workspace: {
                containerPlusNew: "New tab: choose a panel type",
                dockTabOpen: "Open",
            },
        },
    },
});

const ENTRIES = [
    { id: "files", label: "Files", checked: true, testid: "workspace-add-item-files" },
    { id: "context", label: "Context", checked: false, testid: "workspace-add-item-context" },
];

/**
 * task-140 / D-1907 rev7：两个容器的「+」必须是**同一个组件**。
 * 这里的用例是那份「同一组件」契约本身 —— 组件 id 只影响 testid 后缀与
 * aria-label 之外的呈现，行为完全一致；因此下面每个用例都跑 main 与 right 两遍。
 */
function mountButton(containerId: "main" | "right" = "main", extra: Record<string, unknown> = {}) {
    return mount(WorkspaceContainerAddButton, {
        props: { containerId, entries: ENTRIES, ...extra },
        global: { plugins: [i18n] },
    });
}

async function openMenu(wrapper: ReturnType<typeof mountButton>) {
    await wrapper
        .get(`[data-testid="workspace-container-plus-${wrapper.props("containerId")}"]`)
        .trigger("click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    return wrapper;
}

describe("WorkspaceContainerAddButton（task-140 / D-1907 rev7）", () => {
    it.each(["main", "right"] as const)("触发按钮 testid 与 aria-label：%s", (containerId) => {
        const wrapper = mountButton(containerId);
        const trigger = wrapper.get(`[data-testid="workspace-container-plus-${containerId}"]`);

        expect(trigger.attributes("type")).toBe("button");
        // 既有 66+ 消费点（task155 等）按这个 testid 定位，不得漂移。
        expect(trigger.attributes("aria-label")).toBe("New tab: choose a panel type");
    });

    it.each(["main", "right"] as const)(
        "菜单是 role=menu、项是 menuitemcheckbox：%s",
        async (containerId) => {
            const wrapper = await openMenu(mountButton(containerId));
            const menu = wrapper.get(`[data-testid="workspace-container-add-menu-${containerId}"]`);

            expect(menu.attributes("role")).toBe("menu");

            const files = wrapper.get('[data-testid="workspace-add-item-files"]');
            expect(files.attributes("role")).toBe("menuitemcheckbox");
            // 已开项：aria-checked=true + 可见的「已开」标记。
            expect(files.attributes("aria-checked")).toBe("true");
            expect(files.text()).toContain("Open");

            // 未开项：aria-checked=false，且不带「已开」标记。
            const context = wrapper.get('[data-testid="workspace-add-item-context"]');
            expect(context.attributes("aria-checked")).toBe("false");
            expect(context.text()).not.toContain("Open");
        },
    );

    it("选中项只 emit select（写入语义归调用方的单一 writer）", async () => {
        const wrapper = await openMenu(mountButton("main"));

        await wrapper.get('[data-testid="workspace-add-item-context"]').trigger("click");

        expect(wrapper.emitted("select")).toEqual([["context"]]);
        // 不接 update:model-value ⇒ 组件不自己记第二份真源。
        expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    });

    it("disabled 时触发按钮不可点（上限/只读容器由调用方决定）", () => {
        const wrapper = mountButton("right", { disabled: true });

        expect(
            wrapper.get('[data-testid="workspace-container-plus-right"]').attributes("disabled"),
        ).toBeDefined();
    });
});
