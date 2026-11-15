import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import { i18n } from "../../../../i18n";
import WorkspaceStatusBar from "../WorkspaceStatusBar.vue";

/**
 * 底部状态栏（task-312 建、**task-160 / S2a 搬到壳层并接面包屑**）。
 *
 * <p><b>本文件在 task-160 之后判什么</b>：</p>
 * <ol>
 *   <li>三态「实际是哪一态」可区分（D-1153：不是「元素存在」）；
 *   <li>读数**来自 store**（`useWorkspaceConnectionStore`），不是 props —— 这是「状态栏上移壳层」
 *       能成立的前提：页面把读数发布进 store，壳层只读；
 *   <li>面包屑整段在这里，且 `aria-current="page"` **全页只有一处**（导航行已按 task-160 去掉它）。</li>
 * </ol>
 */

const WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";
const WORKSPACE_NAME = "演示工作区";

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
                    workspacePage: {
                        id: "sessions",
                        labelKey: "workspaceNav.sessions",
                        order: 10,
                    },
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

async function mountBar() {
    const wrapper = mount(WorkspaceStatusBar, {
        global: {
            plugins: [i18n],
            stubs: { RouterLink: { template: "<a><slot /></a>" } },
        },
    });
    await flushPromises();
    return wrapper;
}

async function connectionStore() {
    const { useWorkspaceConnectionStore } = await import("../../../../stores/workspaceConnection");
    return useWorkspaceConnectionStore();
}

async function setAuthWorkspace(id: string, name: string) {
    const { useAuthStore } = await import("../../../../stores/auth");
    const auth = useAuthStore();
    auth.workspace = { id, name } as never;
}

function stateOf(wrapper: Awaited<ReturnType<typeof mountBar>>): string | null {
    return (
        wrapper
            .find('[data-testid="workspace-status-connection"]')
            .attributes("data-connection-state") ?? null
    );
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

describe("WorkspaceStatusBar 三态（task-312）", () => {
    it("三态各自渲染出**不同的** data-connection-state 与不同文案（不是「都渲染了」就算过）", async () => {
        const store = await connectionStore();
        const wrapper = await mountBar();

        store.publishConnection({ connected: false, connecting: true, error: null });
        await flushPromises();
        const connecting = stateOf(wrapper);
        const connectingText = wrapper.find('[data-testid="workspace-status-connection"]').text();

        store.publishConnection({ connected: true, connecting: false, error: null });
        await flushPromises();
        const connected = stateOf(wrapper);
        const connectedText = wrapper.find('[data-testid="workspace-status-connection"]').text();

        store.publishConnection({ connected: false, connecting: false, error: null });
        await flushPromises();
        const disconnected = stateOf(wrapper);
        const disconnectedText = wrapper.find('[data-testid="workspace-status-connection"]').text();

        // ① 取值互不相同 —— 能抓住「三态塌成一态」
        expect([connecting, connected, disconnected]).toEqual([
            "connecting",
            "connected",
            "disconnected",
        ]);
        // ② 文案也必须互不相同（属性不同、文案一样 = 用户看不出三态）
        expect(new Set([connectingText, connectedText, disconnectedText]).size).toBe(3);
        wrapper.unmount();
    });

    it("connecting 优先于 connected —— 重连中即使已连接为 true，也不能读成「已连接」", async () => {
        const store = await connectionStore();
        const wrapper = await mountBar();
        store.publishConnection({ connected: true, connecting: true, error: null });
        await flushPromises();
        expect(stateOf(wrapper)).toBe("connecting");
        wrapper.unmount();
    });

    it("读数来自 store 而不是 props：组件不声明任何 props（状态栏在壳层，壳层没有页面读数）", async () => {
        const store = await connectionStore();
        const wrapper = await mountBar();
        // 未发布 = 未连接（默认值），这条能抓住「读 props 默认 false」之外的其它形态
        expect(stateOf(wrapper)).toBe("disconnected");
        store.publishConnection({ connected: true, connecting: false, error: null });
        await flushPromises();
        expect(stateOf(wrapper)).toBe("connected");
        // 组件自身没有 props 声明：有 props 就说明还有第二条读数通道（= 两个 writer）
        expect((WorkspaceStatusBar as unknown as { props?: unknown }).props).toBeUndefined();
        wrapper.unmount();
    });
});

describe("WorkspaceStatusBar 面包屑（task-160 从导航行搬来）", () => {
    it('三段齐全：工作区 › 工作区名 › 当前页，且 aria-current="page" 全页只有一处', async () => {
        await setAuthWorkspace(WORKSPACE_ID, WORKSPACE_NAME);
        const wrapper = await mountBar();

        const middle = wrapper.find('[data-testid="workspace-breadcrumb-container"]');
        expect(middle.exists()).toBe(true);
        expect(middle.text()).toBe(WORKSPACE_NAME);

        const whole = wrapper.find('[data-testid="workspace-breadcrumb"]').text();
        expect(whole).toContain("工作区");
        expect(whole).toContain(WORKSPACE_NAME);
        expect(whole).toContain(i18n.global.t("workspaceNav.environment"));

        // 一页只能有一个「当前页」：面包屑末段（BreadcrumbPage 自带）占掉它，导航行不能再有。
        expect(wrapper.findAll('[aria-current="page"]').length).toBe(1);
        wrapper.unmount();
    });

    it("面包屑与读数同排：面包屑在状态栏容器内部（不是被搬到别处）", async () => {
        await setAuthWorkspace(WORKSPACE_ID, WORKSPACE_NAME);
        const wrapper = await mountBar();
        const bar = wrapper.find('[data-testid="workspace-status-bar"]');
        expect(bar.exists()).toBe(true);
        expect(bar.find('[data-testid="workspace-breadcrumb"]').exists()).toBe(true);
        wrapper.unmount();
    });
});

describe("WorkspaceStatusBar 读数的显示条件", () => {
    it("待审批 0 不渲染、>0 才渲染并显示数量", async () => {
        const { useAgentStore } = await import("../../../../stores/agent");
        const agent = useAgentStore();
        const wrapper = await mountBar();
        expect(wrapper.find('[data-testid="workspace-status-pending"]').exists()).toBe(false);

        agent.pendingApprovalSummaries = [{ sessionId: "s1", count: 3 }] as never;
        await flushPromises();
        const pending = wrapper.find('[data-testid="workspace-status-pending"]');
        expect(pending.exists()).toBe(true);
        expect(pending.text()).toContain("3");
        wrapper.unmount();
    });

    it("用量：无 run 不渲染；0 也是有效读数（不能因为 0 就隐藏）", async () => {
        const store = await connectionStore();
        const wrapper = await mountBar();
        expect(wrapper.find('[data-testid="workspace-status-usage"]').exists()).toBe(false);

        store.publishUsage(0, 0);
        await flushPromises();
        const usage = wrapper.find('[data-testid="workspace-status-usage"]');
        expect(usage.exists()).toBe(true);
        expect(usage.text()).toContain("0");
        wrapper.unmount();
    });
});
