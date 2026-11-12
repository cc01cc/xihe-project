import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import type { Router } from "vue-router";
import GlobalRail from "../sidebar/GlobalRail.vue";
import { useAuthStore } from "../../stores/auth";
import { defaultLayerPath, defaultResourcePath } from "../../lib/settingsIa";

const messages = {
    "zh-CN": {
        sidebar: {
            workbench: "工作台",
            // PLAN-0772 M2：全局条第三个入口（资源模块）。
            resources: "资源",
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
    it("主区 = 工作台 → 资源；footer = 设置 → 登出（D-933 + PLAN-0772 第三入口）", async () => {
        patchAuth(true); // 即便管理员：D-933 —— 管理按钮已直接移除，不设替代入口。
        const wrapper = await mountRail();
        expect(wrapper.get('[data-testid="global-rail"]').exists()).toBe(true);
        // PLAN-0772 M2 起主区**不再只有工作台**：资源是第三个顶层入口、排在主区第二项。
        // （本用例原名为 "workbench only in the main area"，PLAN-0772 之后那句话已是假话 ⇒ task-293 改掉。）
        const main = wrapper.get('[data-testid="global-rail"] [data-slot="sidebar-content"]');
        expect(
            main
                .findAll('[data-testid^="global-rail-module-"]')
                .map((n) => n.attributes("data-testid")),
        ).toEqual(["global-rail-module-workbench", "global-rail-module-resources"]);
        expect(wrapper.get('[data-testid="global-rail-module-workbench"]').text()).toContain(
            "工作台",
        );
        expect(wrapper.get('[data-testid="global-rail-module-resources"]').text()).toContain(
            "资源",
        );
        // 设置与登出一起收在 footer，设置居登出上方（D-933）。
        const footer = wrapper.get('[data-testid="global-rail"] [data-slot="sidebar-footer"]');
        expect(
            footer
                .findAll('[data-testid^="global-rail-module-"]')
                .map((n) => n.attributes("data-testid")),
        ).toEqual(["global-rail-module-settings"]);
        expect(wrapper.get('[data-testid="global-rail-module-settings"]').text()).toContain("设置");
        const footerOrder = footer
            .findAll("[data-testid]")
            .map((node) => node.attributes("data-testid"));
        expect(footerOrder.indexOf("global-rail-module-settings")).toBeLessThan(
            footerOrder.indexOf("global-rail-logout"),
        );
        // 管理入口对任何角色都不再渲染（含管理员）。
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

    it("switches modules: workbench -> /workspace, resources -> defaultResourcePath(), settings -> default layer path", async () => {
        patchAuth();
        const wrapper = await mountRail();
        await wrapper.get('[data-testid="global-rail-module-settings"]').trigger("click");
        expect(pushSpy).toHaveBeenLastCalledWith(defaultLayerPath("instance"));

        await wrapper.get('[data-testid="global-rail-module-workbench"]').trigger("click");
        expect(pushSpy).toHaveBeenLastCalledWith("/workspace");

        // PLAN-0772 M2：第三入口点下去要落到**默认资源子页**，且落点只能有一处定义
        // （`/resources` 的 router redirect 也用同一个 `defaultResourcePath()`）⇒ 这里断言
        // 函数返回值而不是复制字面量，否则两处一改就漂。
        await wrapper.get('[data-testid="global-rail-module-resources"]').trigger("click");
        expect(pushSpy).toHaveBeenLastCalledWith(defaultResourcePath());
        expect(defaultResourcePath()).toBe("/resources/credentials?layer=USER");
    });

    it("资源入口在 /resources/** 上保持激活（前缀判定，含详情深链）", async () => {
        patchAuth();
        for (const path of [
            "/resources/credentials?layer=USER",
            "/resources/skills/x?layer=USER",
        ]) {
            routeState.path = path;
            const wrapper = await mountRail();
            expect(
                wrapper
                    .get('[data-testid="global-rail-module-resources"]')
                    .attributes("data-active"),
            ).toBe("true");
            // 同一时刻工作台不得同时激活（两个入口都是 `startsWith` 前缀判定，写错会两个都亮）。
            expect(
                wrapper
                    .get('[data-testid="global-rail-module-workbench"]')
                    .attributes("data-active"),
            ).not.toBe("true");
            wrapper.unmount();
        }
    });

    it("logs out and returns to the login route", async () => {
        const auth = patchAuth();
        const wrapper = await mountRail();
        await wrapper.get('[data-testid="global-rail-logout"]').trigger("click");
        expect(auth.token).toBeFalsy();
        expect(pushSpy).toHaveBeenLastCalledWith("/login");
    });

    it("marks the active module; config-locks/roles count as settings after D-933", async () => {
        patchAuth(true);
        routeState.path = "/settings/instance/logging";
        const wrapper = await mountRail();
        expect(
            wrapper.get('[data-testid="global-rail-module-settings"]').attributes("data-active"),
        ).toBe("true");
        // D-933 回归守卫：config-locks 不再有独立 admin 态，归设置模块激活。
        routeState.path = "/settings/config-locks";
        const wrapperLocks = await mountRail();
        expect(
            wrapperLocks
                .get('[data-testid="global-rail-module-settings"]')
                .attributes("data-active"),
        ).toBe("true");
        expect(wrapperLocks.find('[data-testid="global-rail-admin"]').exists()).toBe(false);

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
