import { describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia } from "pinia";

/**
 * task-156：设置页「← 返回聊天」只在移动端保留。
 * 判据：桌面（lg+）左 rail 已有「工作台」同动作（BackToChatButton 与之重复），
 * 移动端 rail 不渲染 ⇒ 页内按钮必须保留；实现用容器 `lg:hidden`，组件本身不动。
 */
const messages = {
    "zh-CN": {
        settings: {
            ia: {
                menuButton: "菜单",
                closeMenu: "关闭",
                navMonitoring: "监控",
                navData: "数据",
                navRoles: "角色与授权",
                navAudit: "审计日志",
                navConfigLocks: "配置锁定",
                navToolFaces: "工具分类",
                groupOps: "实例运维",
                groupSecurity: "安全与权限",
                groupMyResources: "我的资源",
                groupInstanceResources: "实例资源",
                backToUserLayer: "去用户层",
            },
            domainRag: "检索增强",
        },
        common: { loading: "加载中" },
    },
};

const i18n = createI18n({ legacy: false, locale: "zh-CN", messages });

vi.mock("vue-router", () => ({
    useRoute: () => ({
        meta: {},
        path: "/settings/instance/rag",
        fullPath: "/settings/instance/rag",
        query: {},
    }),
    useRouter: () => ({
        push: vi.fn<() => Promise<void>>(),
        replace: vi.fn<() => Promise<void>>(),
    }),
    // SettingsLayout → SettingsSidebar → stores/auth 会 import router/index.ts，
    // 该模块在导入期就调 createRouter / createWebHistory —— mock 必须给得起。
    createRouter: () => ({
        push: vi.fn<() => Promise<void>>(),
        replace: vi.fn<() => Promise<void>>(),
        beforeEach: vi.fn<() => void>(),
        afterEach: vi.fn<() => void>(),
        isReady: () => Promise.resolve(),
        currentRoute: { value: {} },
    }),
    createWebHistory: () => ({}),
    RouterLink: { template: "<a><slot /></a>" },
}));

import SettingsLayout from "../SettingsLayout.vue";

function mountLayout() {
    return mount(SettingsLayout, {
        global: {
            // task-429：task-341（b14f0195b）给 SettingsLayout 加了 useAuthStore()（:29），
            // 需要 active Pinia。fresh store 无 token ⇒ hydrateWorkspace 早退（auth.ts:472），不发请求。
            plugins: [i18n, createPinia()],
            stubs: {
                SettingsSidebar: { template: '<div data-testid="settings-sidebar-stub" />' },
                SettingsLayerHeader: {
                    template: '<div data-testid="settings-layer-header-stub"><slot /></div>',
                },
                BackToChatButton: {
                    template: '<button data-testid="settings-back-to-chat" />',
                },
                RouterView: { template: '<div data-testid="router-view-stub" />' },
            },
        },
        attachTo: document.body,
    });
}

describe("SettingsLayout 返回聊天入口 (task-156)", () => {
    it("keeps the back-to-chat button only on mobile (container is lg:hidden)", () => {
        const wrapper = mountLayout();
        const button = wrapper.find('[data-testid="settings-back-to-chat"]');
        expect(button.exists()).toBe(true);
        // 外层容器就是控制可见性的那一层：桌面隐藏、移动端显示。
        expect(button.element.parentElement?.className ?? "").toContain("lg:hidden");
        wrapper.unmount();
    });
});

/**
 * task-510（G-08 + H-01）：移动抽屉必须是**真的 Sheet**（reka Dialog 原语），不是手搓 div。
 *
 * <p>修前那一段自己写了 `role="dialog" aria-modal="true" data-variant="sheet"` 和遮罩
 * `@click` —— **看起来像 vendor 件，却没有它的行为**：Esc 关不掉、Tab 焦点跑到背后正文，
 * 读屏/键盘用户在抽屉里没有出口（除了点遮罩）。判据不是"看起来对不对"，是这两条行为：
 * ① `Escape` ⇒ 抽屉消失；② 焦点进到抽屉内部（reka 打开时自动聚焦首个可聚焦元素）。</p>
 *
 * <p>为什么钉行为而不是钉 `import`：替换成 Sheet 只是手段。判据要能独立成立 ——
 * 将来有人把 Sheet 换成别的原语（如 Dialog），只要行为还在，这两条仍应通过。</p>
 */
describe("SettingsLayout 移动抽屉必须是真 Sheet（task-510）", () => {
    async function openDrawer() {
        const wrapper = mountLayout();
        await wrapper.get('[data-testid="settings-drawer-toggle"]').trigger("click");
        await nextTick();
        return wrapper;
    }

    it("Escape 关闭抽屉", async () => {
        const wrapper = await openDrawer();
        expect(wrapper.find('[data-testid="settings-drawer"]').exists()).toBe(true);

        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await nextTick();
        // reka 的 Presence 在关闭态要等一帧（退出动画）才卸载 ⇒ 用 rAF 推进，不用固定 sleep。
        // 一帧后再断言一次：确认是「卸载」而不是「留在关闭态」。
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        await nextTick();

        expect(wrapper.find('[data-testid="settings-drawer"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("打开后焦点在抽屉内部（焦点陷阱生效）", async () => {
        const wrapper = await openDrawer();
        const drawer = wrapper.get('[data-testid="settings-drawer"]').element as HTMLElement;

        await nextTick();
        expect(drawer.contains(document.activeElement)).toBe(true);
        wrapper.unmount();
    });
});
