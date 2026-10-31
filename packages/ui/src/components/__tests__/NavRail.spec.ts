import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import type { Router } from "vue-router";
import NavRail from "../sidebar/NavRail.vue";
import { useAuthStore } from "../../stores/auth";

const messages = {
    "zh-CN": {
        sidebar: {
            workspace: "工作区",
            settings: "设置",
            logout: "退出登录",
            admin: "管理",
            collapse: "收起侧边栏",
            expand: "展开侧边栏",
        },
    },
};

const { pushSpy, routeState } = vi.hoisted(() => ({
    pushSpy: vi.fn<Router["push"]>(),
    routeState: {
        params: {} as Record<string, string>,
        name: "workspace",
        path: "/workspace/ws-1",
    },
}));

vi.mock("vue-router", () => ({
    createRouter: () => ({
        push: vi.fn<() => void>(),
        replace: vi.fn<() => void>(),
        beforeEach: vi.fn<() => void>(),
        afterEach: vi.fn<() => void>(),
        isReady: () => Promise.resolve(),
        currentRoute: { value: {} },
    }),
    createWebHistory: () => ({}),
    useRouter: () => ({ push: pushSpy }),
    useRoute: () => routeState,
}));

const i18n = createI18n({
    legacy: false,
    locale: "zh-CN",
    fallbackLocale: "zh-CN",
    messages,
});

function patchAuth(options: { role?: string; workspace?: boolean } = {}) {
    const auth = useAuthStore();
    auth.$patch({
        token: "token",
        user: {
            id: "u-1",
            email: "tester@xihe.local",
            ...(options.role ? { role: options.role } : {}),
        },
        workspace:
            options.workspace === false
                ? null
                : { id: "ws-1", name: "Workspace One", ownerId: "u-1" },
    });
    return auth;
}

async function mountRail() {
    const wrapper = mount(NavRail, { global: { plugins: [i18n] } });
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    pushSpy.mockClear();
    vi.restoreAllMocks();
    routeState.name = "workspace";
    routeState.path = "/workspace/ws-1";
});

describe("NavRail (PLAN-0582 S2: fixed 56px icon-only rail)", () => {
    it("renders a fixed 56px icon-only strip with accessible names", async () => {
        patchAuth();
        const wrapper = await mountRail();
        const rail = wrapper.get('[data-testid="nav-rail"]');

        expect(rail.classes()).toContain("w-14");
        expect(rail.classes()).not.toContain("w-44");
        // Ruling #1: no expand/collapse state on the rail itself.
        expect(wrapper.find('[data-testid="nav-rail-toggle"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="nav-rail-panel-toggle"]').exists()).toBe(false);

        // Ruling #2: the workspace entry lives only in the navigation panel head.
        expect(wrapper.find('[data-testid="nav-rail-workspace"]').exists()).toBe(false);

        expect(wrapper.get('[data-testid="nav-rail-settings"]').attributes("aria-label")).toBe(
            "设置",
        );
        expect(wrapper.get('[data-testid="nav-rail-settings"]').attributes("title")).toBe("设置");
        expect(wrapper.get('[data-testid="nav-rail-logout"]').attributes("aria-label")).toBe(
            "退出登录",
        );
    });

    it("keeps every icon control reachable by name (sr-only labels, no visible text)", async () => {
        patchAuth();
        const wrapper = await mountRail();

        // Icon-only: the label lives in an sr-only span so role/name queries and
        // text-content matchers (e2e `filter({ hasText: /logout/ })`) both work.
        for (const testid of ["nav-rail-settings", "nav-rail-logout"]) {
            const button = wrapper.get(`[data-testid="${testid}"]`);
            expect(button.find("span.sr-only").exists()).toBe(true);
        }
    });

    it("marks the active module with aria-current", async () => {
        patchAuth({ role: "ADMIN" });

        const settingsRail = await mountRail();
        routeState.path = "/settings/config";
        const settingsWrapper = await mountRail();
        expect(
            settingsWrapper.get('[data-testid="nav-rail-settings"]').attributes("aria-current"),
        ).toBe("page");
        expect(settingsRail.get('[data-testid="nav-rail-settings"]').exists()).toBe(true);

        routeState.path = "/settings/principal-grants";
        const adminWrapper = await mountRail();
        expect(adminWrapper.get('[data-testid="nav-rail-admin"]').attributes("aria-current")).toBe(
            "page",
        );
        expect(
            adminWrapper.get('[data-testid="nav-rail-settings"]').attributes("aria-current"),
        ).toBeUndefined();
    });

    it("hides the admin module from non-admin members", async () => {
        patchAuth({ role: "USER" });
        const memberRail = await mountRail();
        expect(memberRail.find('[data-testid="nav-rail-admin"]').exists()).toBe(false);

        setActivePinia(createPinia());
        patchAuth({ role: "ADMIN" });
        const adminRail = await mountRail();
        expect(adminRail.find('[data-testid="nav-rail-admin"]').exists()).toBe(true);
    });

    it("navigates to settings and logs out from the rail", async () => {
        const auth = patchAuth();
        localStorage.setItem(
            "xihe-layout-global",
            JSON.stringify({ navOpen: true, navWidth: 300 }),
        );
        const wrapper = await mountRail();

        await wrapper.get('[data-testid="nav-rail-settings"]').trigger("click");
        expect(pushSpy).toHaveBeenCalledWith("/settings/config");

        await wrapper.get('[data-testid="nav-rail-logout"]').trigger("click");
        await flushPromises();
        expect(auth.token).toBeNull();
        expect(pushSpy).toHaveBeenCalledWith("/login");
    });

    it("does not navigate to a workspace (the panel head owns that entry)", async () => {
        patchAuth();
        const wrapper = await mountRail();
        const pushesBefore = pushSpy.mock.calls.length;
        await wrapper.get('[data-testid="nav-rail-settings"]').trigger("click");
        expect(pushSpy.mock.calls.at(-1)).toEqual(["/settings/config"]);
        expect(pushSpy.mock.calls.length).toBe(pushesBefore + 1);
    });
});
