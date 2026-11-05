/**
 * BL-344 残留（最后 1/3）：**单一路由出口**的结构级回归。
 *
 * 为什么单独一个文件：`AppLayout` 的 `isMobile` 是**模块级常量**（`matchMedia(...)` 在模块求值时
 * 就定下来了），所以同进程内 `vi.resetModules()` + 动态 `import()` 才能拿到"另一种断点"的实例。
 *
 * 断言口径（如实）：`resetModules` 会重建整棵组件树，**跨模块重载的 DOM identity 不可比**，
 * 所以这里做**结构级断言**——两种断点下都只存在**一个**路由出口（`[data-testid="route-view"]`
 * 计数 = 1），且容器只在"有页签栏/无页签栏"之间切换 `contents` 类。
 * 修前是 `v-if` 一个 `<router-view>` + `v-else` 一个，断点翻转必然换 outlet ⇒ 页面重挂。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../i18n";

function stubMatchMedia(matches: boolean) {
    vi.stubGlobal("matchMedia", (query: string) => ({
        matches,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
    }));
}

async function mountLayout(matches: boolean) {
    stubMatchMedia(matches);
    vi.resetModules();
    const { default: AppLayout } = await import("../AppLayout.vue");
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [
            {
                path: "/workspace/:workspaceId",
                component: { template: '<div data-testid="route-page" />' },
            },
        ],
    });
    await router.push("/workspace/workspace-1");
    await router.isReady();
    const wrapper = mount(AppLayout, {
        global: {
            plugins: [router, i18n],
            stubs: {
                Sidebar: { template: '<aside data-testid="sidebar-stub" />' },
                "router-view": { template: '<div data-testid="route-view" />' },
            },
        },
    });
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    // 与 AppLayout.spec 同口径：把 fetch 停在永不完结的请求上，避免出网与退避定时器噪音。
    vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined)),
    );
});

describe("AppLayout 路由出口（BL-344 残留）", () => {
    it("桌面断点：唯一路由出口，容器参与布局（非 contents）", async () => {
        const wrapper = await mountLayout(false);
        expect(wrapper.findAll('[data-testid="route-view"]')).toHaveLength(1);
        const viewport = wrapper.get('[data-testid="workspace-route-viewport"]');
        expect(viewport.exists()).toBe(true);
        expect(viewport.classes()).not.toContain("contents");
        wrapper.unmount();
    });

    it("移动断点：同样是这一个出口（容器退化为 contents，而不是换成另一个 outlet）", async () => {
        const wrapper = await mountLayout(true);
        // 结构级判据：出口数量仍是 1 —— 修前这里会落到另一个 `<router-view>` 实例上。
        expect(wrapper.findAll('[data-testid="route-view"]')).toHaveLength(1);
        const viewport = wrapper.get('[data-testid="workspace-route-viewport"]');
        expect(viewport.exists(), "容器常驻，仅切换布局参与方式").toBe(true);
        expect(viewport.classes()).toContain("contents");
        wrapper.unmount();
    });
});
