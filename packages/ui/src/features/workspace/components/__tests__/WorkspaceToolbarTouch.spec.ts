import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { i18n } from "../../../../i18n";
import WorkspaceToolbar from "../WorkspaceToolbar.vue";

/**
 * task-57（WCAG 2.2 SC 2.5.8 = 24×24 AA）× **D-206**（Lead 裁定）：
 *
 * 1) 溢出菜单 7 个入口统一 `min-h-12` = 12 × 3.5px = **42px**（D-206 可逆自裁，四条理由：
 *    避免 44→32.2 手感回归 / token 非任意值 / 7×42=294px 在 844 视口内 / 24 是下限不是目标）。
 *    改前是两档：`more-monitor`/`more-members` 带 `max-md:min-h-[44px]`（任意值），另 5 项
 *    只有 `py-1.5` ⇒ 内容高 32.2px。两档都 ≥24 ⇒ 都不违例，要修的是「同族两档 + 任意值」。
 *
 * 2) 工具条三枚移动按钮（files / new-chat / more）**换 vendor Button**（Lead go）：
 *    原手搓 `<button class="p-1.5">` + `size-3.5` = 22.75px（ui-2 batch-4 实测 22.8）⇒
 *    `variant="ghost" size="icon-sm"` = 24.5px。显式保留 text-muted-foreground / hover:bg-accent /
 *    md:hidden；图标仍 size-3.5。断言 `data-variant="ghost"` + `data-size="icon-sm"`
 *    且类名里**不得再出现 `p-1.5`**（防回潮到手搓贴类）。
 *
 * jsdom 不求值 Tailwind ⇒ 全部钉类名/结构；真实 rect 由 ui-2 在 390×844 / 768×1024 复测。
 */
vi.mock("vue-router", () => ({
    useRouter: () => ({ push: vi.fn<() => Promise<void>>() }),
}));

// auth store 会连带 import 真 router（createRouter/createWebHistory）⇒ 替身掉，
// 本判据只关心命中盒类名，不需要权限/路由真实实现（组件只读 currentWorkspaceId）。
vi.mock("../../../../stores/auth", () => ({
    useAuthStore: () => ({ currentWorkspaceId: "ws-1" }),
}));

const MENU_ITEMS = [
    "workspace-toolbar-more-changes",
    "workspace-toolbar-more-monitor",
    "workspace-toolbar-more-members",
    "workspace-toolbar-more-delegation",
    "workspace-toolbar-more-environment",
    "workspace-toolbar-more-scheduled",
    "workspace-toolbar-more-settings",
];

const MOBILE_BUTTONS = [
    "workspace-toolbar-files-mobile",
    "workspace-toolbar-new-chat-mobile",
    "workspace-toolbar-more-mobile",
];

async function mountToolbar() {
    return mount(WorkspaceToolbar, {
        props: { workspaceId: "ws-1" },
        global: { plugins: [i18n, createPinia()] },
    });
}

describe("WorkspaceToolbar 触控（task-57 / D-206）", () => {
    it("菜单 7 项都带 min-h-12（42px，D-206 口径）", async () => {
        const wrapper = await mountToolbar();
        await wrapper.get('[data-testid="workspace-toolbar-more-mobile"]').trigger("click");
        expect(wrapper.find('[data-testid="workspace-toolbar-more-menu"]').exists()).toBe(true);
        for (const tid of MENU_ITEMS) {
            const item = wrapper.get(`[data-testid="${tid}"]`);
            expect(item.classes(), tid).toContain("min-h-12");
        }
        wrapper.unmount();
    });

    it("不许再用任意值 px 顶命中盒（44px 那两档已撤，统一到 token）", async () => {
        const wrapper = await mountToolbar();
        await wrapper.get('[data-testid="workspace-toolbar-more-mobile"]').trigger("click");
        for (const tid of MENU_ITEMS) {
            const item = wrapper.get(`[data-testid="${tid}"]`);
            expect(item.classes().join(" "), tid).not.toContain("min-h-[");
        }
        wrapper.unmount();
    });

    it("移动三枚是 vendor Button ghost/icon-sm，且不再手搓 p-1.5", async () => {
        const wrapper = await mountToolbar();
        for (const tid of MOBILE_BUTTONS) {
            const btn = wrapper.get(`[data-testid="${tid}"]`);
            expect(btn.attributes("data-slot"), tid).toBe("button");
            expect(btn.attributes("data-variant"), tid).toBe("ghost");
            expect(btn.attributes("data-size"), tid).toBe("icon-sm");
            expect(btn.classes(), tid).not.toContain("p-1.5");
        }
        wrapper.unmount();
    });
});
