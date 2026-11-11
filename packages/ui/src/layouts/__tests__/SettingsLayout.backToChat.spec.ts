import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";

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

describe("SettingsLayout 返回聊天入口 (task-156)", () => {
    it("keeps the back-to-chat button only on mobile (container is lg:hidden)", () => {
        const wrapper = mount(SettingsLayout, {
            global: {
                plugins: [i18n],
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
        });
        const button = wrapper.find('[data-testid="settings-back-to-chat"]');
        expect(button.exists()).toBe(true);
        // 外层容器就是控制可见性的那一层：桌面隐藏、移动端显示。
        expect(button.element.parentElement?.className ?? "").toContain("lg:hidden");
        wrapper.unmount();
    });
});
