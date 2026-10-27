import { beforeEach, describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import type { RouteLocationNormalizedLoaded, Router } from "vue-router";

const admin = { value: false };

vi.mock("vue-router", () => ({
    // stores/auth imports the router singleton, so the factory exports must exist.
    createRouter: () => ({
        push: vi.fn<(location: unknown) => Promise<void>>(),
        replace: vi.fn<(location: unknown) => Promise<void>>(),
        beforeEach: vi.fn<() => void>(),
        afterEach: vi.fn<() => void>(),
        isReady: () => Promise.resolve(),
        currentRoute: { value: {} },
    }),
    createWebHistory: () => ({}),
    useRoute: () =>
        ({
            name: "settings-config",
            path: "/settings/config",
            params: {},
            query: {},
            hash: "",
            fullPath: "/settings/config",
            matched: [],
            redirectedFrom: undefined,
            meta: {},
        }) as RouteLocationNormalizedLoaded,
    useRouter: () => ({ push: vi.fn<Router["push"]>(), replace: vi.fn<Router["replace"]>() }),
    RouterLink: { template: "<a><slot /></a>" },
}));

vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({ isAdmin: admin.value }),
}));

import SettingsNav from "../SettingsNav.vue";

const messages = {
    "zh-CN": {
        settings: {
            configTab: "配置管理",
            knowledge: "知识库",
            dataControls: "数据控制",
            toolFaces: "工具分类",
        },
    },
};

function createI18nInstance() {
    return createI18n({ legacy: false, locale: "zh-CN", fallbackLocale: "zh-CN", messages });
}

function mountNav() {
    return mount(SettingsNav, { global: { plugins: [createI18nInstance()] } });
}

describe("SettingsNav", () => {
    beforeEach(() => {
        admin.value = false;
    });

    it("renders config tab", () => {
        expect(mountNav().text()).toContain("配置管理");
    });

    it("renders knowledge tab", () => {
        expect(mountNav().text()).toContain("知识库");
    });

    it("renders data controls tab", () => {
        expect(mountNav().text()).toContain("数据控制");
    });

    it("retires the permission rules tab but keeps tool classification", () => {
        const wrapper = mountNav();
        expect(wrapper.text()).not.toContain("权限规则");
        expect(wrapper.text()).toContain("工具分类");
    });

    it("renders links with correct paths", () => {
        const html = mountNav().html();
        expect(html).toContain("/settings/config");
        expect(html).toContain("/settings/knowledge");
        expect(html).toContain("/settings/data");
        expect(html).not.toContain("/settings/policy");
        expect(html).toContain("/settings/tool-faces");
    });

    it("PLAN-0556: shows the lock page only to administrators", () => {
        expect(mountNav().html()).not.toContain("/settings/config-locks");

        admin.value = true;
        expect(mountNav().html()).toContain("/settings/config-locks");
    });
});
