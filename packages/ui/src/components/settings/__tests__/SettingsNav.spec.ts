import { beforeEach, describe, it, expect, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import type { RouteLocationNormalizedLoaded, Router } from "vue-router";

/** `/me` capability flag — still drives the config-locks tab (BL-392). */
const admin = { value: false };
/** `MANAGE_ROLES` action atom from `GET /me/permissions` — drives the roles tab (PLAN-0651 T4.2). */
const rolesAllowed = { value: false };
const ensureSelfPermissions = vi.fn<() => Promise<boolean>>(() => Promise.resolve(true));

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
    useAuthStore: () => ({
        isAdmin: admin.value,
        canManageRoles: rolesAllowed.value,
        ensureSelfPermissions,
    }),
}));

import SettingsNav from "../SettingsNav.vue";

const messages = {
    "zh-CN": {
        settings: {
            configTab: "配置管理",
            configLockNav: "配置锁定",
            rolesNav: "角色与绑定",
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
        rolesAllowed.value = false;
        ensureSelfPermissions.mockClear();
        ensureSelfPermissions.mockResolvedValue(true);
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

    it("PLAN-0556 / BL-392: shows the lock page only to administrators", () => {
        expect(mountNav().html()).not.toContain("/settings/config-locks");

        admin.value = true;
        expect(mountNav().html()).toContain("/settings/config-locks");
    });

    it("PLAN-0651 T4.2: the roles tab follows the MANAGE_ROLES atom, not the capability flag", () => {
        // Neither capability nor atom: hidden.
        expect(mountNav().html()).not.toContain("/settings/roles");

        // The atom alone unlocks the tab — a custom role may hold it without `instance:admin`.
        rolesAllowed.value = true;
        expect(mountNav().html()).toContain("/settings/roles");
    });

    it("PLAN-0651 T4.2: the instance-admin capability does not imply the roles tab", () => {
        admin.value = true;
        // CP's role face is atom-gated, so the capability flag must not stand in for it.
        expect(mountNav().html()).not.toContain("/settings/roles");
    });

    it("PLAN-0651 T4.2: an empty atom projection leaves the permission tab hidden", () => {
        const wrapper = mountNav();
        // The store exposes `canManageRoles === false` for an empty `instancePermissions`;
        // the nav must not fall back to the capability flag.
        admin.value = true;
        rolesAllowed.value = false;
        expect(wrapper.html()).not.toContain("/settings/roles");
        expect(wrapper.text()).toContain("配置管理");
    });

    it("PLAN-0651 T4.2: a failed atom projection hides the tab and keeps the nav usable", async () => {
        // Fail-closed: the store resolves `false` after logging the failure (it never rejects).
        admin.value = true;
        ensureSelfPermissions.mockResolvedValue(false);
        const wrapper = mountNav();
        await flushPromises();
        expect(wrapper.html()).not.toContain("/settings/roles");
        // The capability-gated lock tab is unaffected by the atom projection.
        expect(wrapper.html()).toContain("/settings/config-locks");
        expect(wrapper.text()).toContain("配置管理");
    });

    it("PLAN-0651 T4.2: starts the atom projection on mount", () => {
        mountNav();
        expect(ensureSelfPermissions).toHaveBeenCalledTimes(1);
    });
});
