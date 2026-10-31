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
            collapseRail: "收起导航栏",
            expandRail: "展开导航栏",
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

async function mountRail(props: { collapsed?: boolean; navOpen?: boolean } = {}) {
    const wrapper = mount(NavRail, {
        props: { collapsed: true, navOpen: true, ...props },
        global: { plugins: [i18n] },
    });
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    setActivePinia(createPinia());
    pushSpy.mockClear();
    vi.restoreAllMocks();
    routeState.name = "workspace";
    routeState.path = "/workspace/ws-1";
});

describe("NavRail", () => {
    it("renders icon-only global modules with accessible names when collapsed", async () => {
        patchAuth();
        const wrapper = await mountRail();

        expect(wrapper.get('[data-testid="nav-rail"]').classes()).toContain("w-12");
        expect(wrapper.get('[data-testid="nav-rail-workspace"]').text()).toBe("工作区");
        expect(wrapper.get('[data-testid="nav-rail-settings"]').text()).toBe("设置");
        expect(wrapper.get('[data-testid="nav-rail-logout"]').text()).toBe("退出登录");
        // Labels stay in the accessibility tree only while the rail is collapsed.
        expect(wrapper.get('[data-testid="nav-rail-workspace"] span').classes()).toContain(
            "sr-only",
        );
    });

    it("expands to icon + label without changing the navigation targets", async () => {
        patchAuth();
        const wrapper = await mountRail({ collapsed: false });

        expect(wrapper.get('[data-testid="nav-rail"]').classes()).toContain("w-44");
        expect(wrapper.get('[data-testid="nav-rail-workspace"] span').classes()).toContain(
            "truncate",
        );
        await wrapper.get('[data-testid="nav-rail-settings"]').trigger("click");
        expect(pushSpy).toHaveBeenCalledWith("/settings/config");
    });

    it("shows the Admin module for instance admins only", async () => {
        patchAuth();
        const memberRail = await mountRail();
        expect(memberRail.find('[data-testid="nav-rail-admin"]').exists()).toBe(false);

        setActivePinia(createPinia());
        patchAuth({ role: "ADMIN" });
        const adminRail = await mountRail();
        await adminRail.get('[data-testid="nav-rail-admin"]').trigger("click");
        expect(pushSpy).toHaveBeenCalledWith("/settings/config-locks");
    });

    it("marks the active module with aria-current", async () => {
        patchAuth();
        const workspaceRail = await mountRail();
        expect(
            workspaceRail.get('[data-testid="nav-rail-workspace"]').attributes("aria-current"),
        ).toBe("page");

        routeState.name = "settings-config";
        routeState.path = "/settings/config";
        const settingsRail = await mountRail();
        expect(
            settingsRail.get('[data-testid="nav-rail-settings"]').attributes("aria-current"),
        ).toBe("page");
        expect(
            settingsRail.get('[data-testid="nav-rail-workspace"]').attributes("aria-current"),
        ).toBeUndefined();
    });

    it("emits panel and rail toggle intents with aria-pressed state", async () => {
        patchAuth();
        const wrapper = await mountRail({ navOpen: false, collapsed: true });

        const panelToggle = wrapper.get('[data-testid="nav-rail-panel-toggle"]');
        expect(panelToggle.attributes("aria-pressed")).toBe("false");
        await panelToggle.trigger("click");
        expect(wrapper.emitted("toggle-nav")).toHaveLength(1);

        const railToggle = wrapper.get('[data-testid="nav-rail-toggle"]');
        expect(railToggle.attributes("aria-pressed")).toBe("true");
        await railToggle.trigger("click");
        expect(wrapper.emitted("toggle-rail")).toHaveLength(1);
    });

    it("navigates to the workspace and logs out from the rail", async () => {
        const auth = patchAuth();
        const logout = vi.spyOn(auth, "logout").mockImplementation(() => {});
        const wrapper = await mountRail();

        await wrapper.get('[data-testid="nav-rail-workspace"]').trigger("click");
        await flushPromises();
        expect(pushSpy).toHaveBeenCalledWith("/workspace/ws-1");

        await wrapper.get('[data-testid="nav-rail-logout"]').trigger("click");
        expect(logout).toHaveBeenCalled();
        expect(pushSpy).toHaveBeenLastCalledWith("/login");
    });
});
