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
        // task-81 P1-1 改断言：**原断言锁的是已废弃的语义**。
        // 改前「未发布 ⇒ disconnected」把两种不同原因压成同一个像是故障的读数：
        //   ①订阅了但断了（真故障）②本页根本没订阅（环境/资源/成员/设置页）。
        // 现在未发布 ⇒ **unsubscribed**（中性），这是修 P1-1 的**目的本身**，不是迁就新代码。
        // 这条断言仍然保留它的原判据「读数来自 store 而非 props」——下面 publishConnection 后
        // 变 connected 就是对那条判据的证明。
        expect(stateOf(wrapper)).toBe("unsubscribed");
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

    /**
     * task-185（S2a 遗留）：**chat 页没有「当前项」是设计，不是缺陷**。
     *
     * 证据链：`router/index.ts:135` 明写 chat 路由**不带** `meta.workspacePage`（入口是会话列表）；
     * `useWorkspaceNav.ts:80` 明写「无独立页名的路由（如聊天页）只有两段」；模板里末段是
     * `v-if="trail.page"` ⇒ chat 页只有「工作区 › 工作区名」两段，`aria-current="page"` 自然为 0
     * （它由 vendor `BreadcrumbPage.vue:15` 硬写，而该组件根本没被渲染）。
     *
     * ⇒ 判据③ 收紧为「**有独立页名的页面**，面包屑存在时状态栏恰 1 处」。
     * 本用例把这条设计钉住：一旦有人给 chat 路由补 `meta.workspacePage`（改变导航清单），它会红。
     */
    it("chat 页（无独立页名）只有两段且没有 aria-current —— 设计如此，判据只对多级页面成立", async () => {
        await setAuthWorkspace(WORKSPACE_ID, WORKSPACE_NAME);
        routeState.routeName = "workspace-chat";
        const wrapper = await mountBar();

        // 数 `breadcrumb-item`（vendor 的 `li` 会同时承载条目与分隔符 ⇒ 直接数 `li` 会多一个）。
        const items = wrapper.findAll('[data-slot="breadcrumb-item"]');
        const whole = wrapper.find('[data-testid="workspace-breadcrumb"]').text();
        expect(items.length, "两段：工作区 › 工作区名").toBe(2);
        expect(whole).toContain("工作区");
        expect(whole).toContain(WORKSPACE_NAME);
        expect(wrapper.findAll('[aria-current="page"]').length, "无末段 ⇒ 无当前项").toBe(0);
        // 末段不是「用了 span 的链接」，而是**整段不存在**：连 BreadcrumbPage 都没有。
        expect(wrapper.find('[data-slot="breadcrumb-page"]').exists()).toBe(false);
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
