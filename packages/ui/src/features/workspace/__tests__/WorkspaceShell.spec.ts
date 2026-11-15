import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import { i18n } from "../../../i18n";
import WorkspaceShell from "../pages/WorkspaceShell.vue";

/**
 * 工作区壳（task-264 / S2a）：**面包屑在非聊天页也可见**的壳层判据。
 *
 * <p>为什么单测要挂在 {@link WorkspaceShell} 而不是只挂 WorkspaceStatusBar：状态栏组件级 spec
 * （components/__tests__/WorkspaceStatusBar.spec.ts）直接 mount 状态栏，**就算有人把状态栏从壳里
 * 摘掉、或改成只在聊天页渲染，它照样绿**。本文件 mount 的是壳本身，路由置为**非聊天页**
 * （workspace-environment），断言状态栏 + 面包屑真的被壳渲染出来 —— 这才咬住「开口项 1
 * （D-1640 ①）做与不做」的那条差别：状态栏上移壳层 ⇒ 六页都有面包屑。</p>
 *
 * <p>同时钉住 S2a 的另两条壳层纪律：导航行仍在（单行 chrome），且全壳 aria-current="page"
 * 只有面包屑末段一处（导航行不许再叠一个当前项）。</p>
 */
const WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";

const routeState = vi.hoisted(() => ({ routeName: "workspace-environment" as string }));

vi.mock("vue-router", () => ({
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
    useRoute: () =>
        ({
            name: routeState.routeName,
            path: `/workspace/${WORKSPACE_ID}/environment`,
            params: { workspaceId: WORKSPACE_ID },
            query: {},
        }) as unknown as RouteLocationNormalizedLoaded,
    useRouter: () => ({
        resolve: (to: { name?: string; params?: Record<string, string> }) => ({
            href:
                to.name === "workspace"
                    ? `/workspace/${String(to.params?.workspaceId ?? "")}`
                    : `/workspace/${String(to.params?.workspaceId ?? "")}/${String(to.name)}`,
            name: to.name,
        }),
        getRoutes: () => [
            {
                name: "workspace",
                meta: {
                    workspacePage: { id: "sessions", labelKey: "workspaceNav.sessions", order: 10 },
                },
            },
            {
                name: "workspace-environment",
                meta: {
                    workspacePage: {
                        id: "environment",
                        labelKey: "workspaceNav.environment",
                        order: 20,
                    },
                },
            },
        ],
    }),
}));

async function mountShell() {
    const wrapper = mount(WorkspaceShell, {
        global: {
            plugins: [i18n],
            stubs: {
                RouterLink: { template: "<a><slot /></a>" },
                RouterView: { template: "<div data-testid='route-view-stub' />" },
            },
        },
    });
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
    routeState.routeName = "workspace-environment";
    localStorage.setItem("xihe-token", "test-token");
    localStorage.setItem("xihe-user", JSON.stringify({ id: "u1" }));
});

describe("WorkspaceShell 壳层（task-264 / S2a）", () => {
    it("非聊天页：壳把状态栏 + 面包屑渲染出来（不是只在聊天页）", async () => {
        const wrapper = await mountShell();
        // 前提：壳与路由页插槽都挂上了（否则下面的断言测的是空壳）。
        expect(wrapper.find('[data-testid="workspace-shell"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="route-view-stub"]').exists()).toBe(true);

        // 状态栏在壳里，且面包屑在状态栏内 —— 非聊天页（environment）也有。
        const bar = wrapper.find('[data-testid="workspace-status-bar"]');
        expect(bar.exists()).toBe(true);
        expect(bar.find('[data-testid="workspace-breadcrumb"]').exists()).toBe(true);

        // 面包屑三段（工作区 › 工作区名 › 当前页），末段存在。
        const breadcrumb = wrapper.find('[data-testid="workspace-breadcrumb"]');
        expect(breadcrumb.findAll('[data-slot="breadcrumb-item"]').length).toBe(3);
        expect(breadcrumb.find('[data-slot="breadcrumb-page"]').exists()).toBe(true);
        wrapper.unmount();
    });

    it("导航行仍在壳里，且全壳 aria-current=page 只有面包屑末段一处", async () => {
        const wrapper = await mountShell();
        expect(wrapper.find('[data-testid="workspace-secondary-nav"]').exists()).toBe(true);
        // 导航行是 role=tab 语义，不抢「当前页」；当前页唯一属于面包屑末段。
        expect(wrapper.findAll('[aria-current="page"]').length).toBe(1);
        wrapper.unmount();
    });
});
