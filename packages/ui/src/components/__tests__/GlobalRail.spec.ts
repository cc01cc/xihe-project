import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import type { Router } from "vue-router";
import GlobalRail from "../sidebar/GlobalRail.vue";
import { useAuthStore } from "../../stores/auth";
import { defaultLayerPath } from "../../lib/settingsIa";

const messages = {
    "zh-CN": {
        sidebar: {
            workbench: "工作台",
            settings: "设置",
            logout: "退出登录",
            admin: "管理",
            toggle: "切换侧边栏",
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

function patchAuth(isInstanceAdmin = false) {
    const auth = useAuthStore();
    auth.$patch({
        token: "token",
        user: {
            id: "u-1",
            email: "tester@xihe.local",
            capabilities: {
                isInstanceAdmin,
                isInstanceSuper: false,
                workspaceAdminOf: [],
            },
        },
    });
    return auth;
}

async function mountRail(): Promise<ReturnType<typeof mount>> {
    const wrapper = mount(GlobalRail, { global: { plugins: [i18n] } });
    await flushPromises();
    return wrapper;
}

/**
 * 双态在 vendored Sidebar 里由**外层**记（[data-slot=sidebar] 的 data-state）；
 * data-testid 通过 $attrs 落在外层里面的 sidebar-container 上。所以要从 testid 元素
 * 向祖先方向取状态，而不是直接取属性。
 */
function railState(wrapper: ReturnType<typeof mount>): string | null {
    const rail = wrapper.get('[data-testid="global-rail"]').element as HTMLElement;
    return rail.closest('[data-slot="sidebar"]')?.getAttribute("data-state") ?? null;
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    pushSpy.mockClear();
    routeState.name = "workspace";
    routeState.path = "/workspace/ws-1";
});

describe("GlobalRail (PLAN-0762 T2.1/T2.3/T2.4)", () => {
    it("renders the global rail with exactly the two MVP modules and a rail handle", async () => {
        patchAuth();
        const wrapper = await mountRail();
        expect(wrapper.get('[data-testid="global-rail"]').exists()).toBe(true);
        expect(wrapper.get('[data-testid="global-rail-module-workbench"]').text()).toContain(
            "工作台",
        );
        expect(wrapper.get('[data-testid="global-rail-module-settings"]').text()).toContain("设置");
        // 不加第三个模块：非管理员看不到管理入口（管理员只作为工具面存在，不是模块）。
        expect(wrapper.find('[data-testid="global-rail-admin"]').exists()).toBe(false);
        // SidebarRail = 悬停双态入口（shadcn-vue collapsible="icon"）。
        expect(wrapper.find('[data-sidebar="rail"]').exists()).toBe(true);
    });

    it("is icon-only by default and expands to icon+text via the rail handle (dual state)", async () => {
        patchAuth();
        const wrapper = await mountRail();
        expect(railState(wrapper)).toBe("collapsed");

        await wrapper.get('[data-sidebar="rail"]').trigger("click");
        await flushPromises();

        expect(railState(wrapper)).toBe("expanded");
        // 双态持久化：独立 key；绝不写全局布局键 xihe-layout-global（T2.4 防串味）。
        expect(localStorage.getItem("xihe-global-rail-open")).toBe("true");
        expect(localStorage.getItem("xihe-layout-global")).toBeNull();
    });

    it("restores the persisted expanded state on the next mount", async () => {
        patchAuth();
        localStorage.setItem("xihe-global-rail-open", "true");
        const wrapper = await mountRail();
        expect(railState(wrapper)).toBe("expanded");
    });

    it("switches modules: workbench -> /workspace, settings -> default layer path", async () => {
        patchAuth();
        const wrapper = await mountRail();
        await wrapper.get('[data-testid="global-rail-module-settings"]').trigger("click");
        expect(pushSpy).toHaveBeenLastCalledWith(defaultLayerPath("instance"));

        await wrapper.get('[data-testid="global-rail-module-workbench"]').trigger("click");
        expect(pushSpy).toHaveBeenLastCalledWith("/workspace");
    });

    it("logs out and returns to the login route", async () => {
        const auth = patchAuth();
        const wrapper = await mountRail();
        await wrapper.get('[data-testid="global-rail-logout"]').trigger("click");
        expect(auth.token).toBeFalsy();
        expect(pushSpy).toHaveBeenLastCalledWith("/login");
    });

    it("marks the active module and keeps admin as a capability-gated utility entry", async () => {
        patchAuth(true);
        routeState.path = "/settings/instance/logging";
        const wrapper = await mountRail();
        expect(
            wrapper.get('[data-testid="global-rail-module-settings"]').attributes("data-active"),
        ).toBe("true");
        expect(wrapper.find('[data-testid="global-rail-admin"]').exists()).toBe(true);

        routeState.path = "/workspace/ws-1";
        const wrapper2 = await mountRail();
        expect(
            wrapper2.get('[data-testid="global-rail-module-workbench"]').attributes("data-active"),
        ).toBe("true");
        // 非激活项不写 data-active（vendored 组件用 isActive || undefined）。
        expect(
            wrapper2.get('[data-testid="global-rail-module-settings"]').attributes("data-active"),
        ).toBeUndefined();
    });
});
