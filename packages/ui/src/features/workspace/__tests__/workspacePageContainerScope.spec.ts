import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { computed, ref } from "vue";
import { i18n } from "../../../i18n";
import { registerWorkspaceTabBar } from "../components/workspaceTabBarContext";
import WorkspaceWorkbench from "../components/WorkspaceWorkbench.vue";

/**
 * task-47 G3（DSD-1469）：「工作区页面没有容器」的唯一可运行判据。
 *
 * 这张卡之前只有文档口径（DEV-010 §10.1.1 两类页面对照表）与 WorkspaceShell.spec.ts 的
 * 「导航带在不在」断言 —— 后者对**容器**一字未提，所以「工作区内容页被谁顺手塞进工作台容器」
 * 这种回归没有任何门会红。本文件补的就是这条。
 *
 * 正分支：五个内容页（环境 / 定时任务 / 资源 / 成员 / 设置）单独渲染时，容器页签
 * workspace-container-tab-*、右栏会话配置页签 pane:right:session-config 与会话列表
 * sidebar-workspace-groups 计数**全为 0**；每页同时断言自己的一级标题 testid 在场 ——
 * 否则「空渲染」也能把 0 计数骗成绿。
 *
 * 反分支：会话页的工作台（WorkspaceWorkbench）渲染时容器页签**必须存在**，否则正分支的
 * 0 计数就只是「选择器写错了」的同义反复，没有咬住「容器只属于工作台」这条边界。
 *
 * 夹具口径：真实 i18n（不做文案替身）、RouterLink 换成 a、页面用到的 api 全部替身成空结果 ——
 * 判据只看 DOM 里有没有那三类节点，不看数据。
 */

const WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";

const routeState = vi.hoisted(() => ({
    name: "workspace-environment" as string,
    params: { workspaceId: "55555555-5555-4555-8555-555555555555" } as Record<string, string>,
}));

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
    useRoute: () => ({
        name: routeState.name,
        path: "/workspace/" + routeState.params.workspaceId,
        params: routeState.params,
        query: {},
        meta: {},
    }),
    useRouter: () => ({
        push: vi.fn<() => Promise<void>>(),
        replace: vi.fn<() => Promise<void>>(),
    }),
}));

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message?: unknown) => void>(),
        error: vi.fn<(message?: unknown) => void>(),
        warning: vi.fn<(message?: unknown) => void>(),
        info: vi.fn<(message?: unknown) => void>(),
    },
}));

/**
 * api 采用**部分替身**（importOriginal 展开真模块），只把方法换成空结果：
 * 整模块替换会连 onAuthTokensRefreshed 这类副作用钩子一起拔掉，auth store 初始化即抛
 * 「No onAuthTokensRefreshed export」，红的是夹具不是判据。
 */
/**
 * api 采用**部分替身**（importOriginal 展开真模块），只把方法换成最小形状的空结果：
 * 整模块替换会连 onAuthTokensRefreshed 这类副作用钩子一起拔掉，auth store 初始化即抛
 * 「No onAuthTokensRefreshed export」，红的是夹具不是判据。
 *
 * 为什么不是一律回 `{}`：环境页会把 `environment.status` 直接喂给 statusLabel()，`{}` 让
 * 字段变 undefined ⇒ 渲染期 unhandled rejection（读的是夹具的假，不是容器判据）。
 */
const ENV_STUB = vi.hoisted(() => ({
    workspaceId: "55555555-5555-4555-8555-555555555555",
    status: "ready",
    storageBackend: "host_directory",
    storageMode: "direct_attach",
    executionMode: "windows-host",
    runtime: { status: "ready", deviceId: null, reason: undefined, lastHeartbeatAt: null },
    capability: { available: false, maturity: "stable", reason: undefined },
    jobCapability: { available: false, canStart: false, unavailableReason: undefined },
    hostPath: null,
    executionSpec: null,
    assignment: null,
}));

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../composables/api")>();
    /**
     * 逐接口给**形状正确**的空结果：一律 {} 会让 store 把 undefined 赋给数组字段，
     * 渲染期读 `.length` 报 TypeError（定时任务页 first-version 红即此因）。
     */
    const answers: Record<string, unknown> = {
        getWorkspaceEnvironment: ENV_STUB,
        getWorkspaceJobs: [],
        listScheduledTasks: { tasks: [], total: 0, page: 1, size: 200 },
    };
    const apiStub = new Proxy(actual.api, {
        get(target, prop) {
            if (typeof prop !== "string") return undefined;
            if (!(prop in target)) return undefined;
            return vi
                .fn<(wsId: string) => Promise<unknown>>()
                .mockResolvedValue(prop in answers ? answers[prop] : {});
        },
    });
    return { ...actual, api: apiStub };
});

/**
 * SSE 组合式替身的**形状必须与真返回值同形**：ScheduledTasksView 读 noticeState.value、
 * connectionErrorCode.value 与 retry —— 少一个就是渲染期 TypeError（本文件首版红即此因）。
 */
vi.mock("../composables/useWorkspaceSSE", () => ({
    useWorkspaceSSE: () => ({
        isConnected: { value: false },
        isConnecting: { value: false },
        connectionError: { value: null },
        connectionErrorCode: { value: null },
        lastSequence: { value: 0 },
        pluginBindingRevision: { value: null },
        role: { value: "leader" },
        noticeState: { value: undefined },
        flapCount: { value: 0 },
        retry: vi.fn<() => void>(),
        stop: vi.fn<() => void>(),
        subscribe: vi.fn<() => void>(),
        unsubscribe: vi.fn<() => void>(),
    }),
}));

vi.mock("@/services/chatTransport", () => ({
    chatTransport: {
        sendMessages: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        stop: vi.fn<() => void>(),
    },
}));

/** 资源页的四张子视图替身：真面板会拉 api/store（那是各自 spec 的事），这里只验页面层不含容器。 */
vi.mock("../../../lib/resourceViews", async () => {
    const vue = await import("vue");
    const stub = (id: string) => async () => ({
        __esModule: true,
        default: {
            name: id + "-view-stub",
            setup() {
                return () => vue.h("div", { "data-testid": "resource-view-" + id });
            },
        },
    });
    return {
        RESOURCE_VIEWS: {
            credentials: stub("credentials"),
            mcp: stub("mcp"),
            skills: stub("skills"),
            knowledge: stub("knowledge"),
        },
    };
});

/** 容器判据的三个选择器（口径与 DEV-010 §10.1.1 / containers.ts 的 CONTAINER_IDS 对齐）。 */
const CONTAINER_SELECTORS = [
    '[data-testid^="workspace-container-tab-"]',
    '[data-testid^="pane:right:session-config"]',
    '[data-testid="sidebar-workspace-groups"]',
];

function containerHits(html: string): { selector: string; count: number }[] {
    const probe = document.createElement("div");
    probe.innerHTML = html;
    return CONTAINER_SELECTORS.map((selector) => ({
        selector,
        count: probe.querySelectorAll(selector).length,
    }));
}

async function mountPage(loader: () => Promise<{ default: unknown }>) {
    const { default: page } = await loader();
    const wrapper = mount(page as never, { global: { plugins: [i18n] } });
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
    localStorage.setItem("xihe-token", "test-token");
    localStorage.setItem("xihe-user", JSON.stringify({ id: "u1" }));
    localStorage.setItem("xihe-workspace", JSON.stringify({ id: WORKSPACE_ID, name: "Ws" }));
    globalThis.fetch = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
});

describe("G3 内容页没有容器（正分支）", () => {
    const pages = [
        {
            label: "环境页",
            routeName: "workspace-environment",
            anchor: "workspace-environment-heading",
            loader: () =>
                import("../pages/WorkspaceEnvironmentView.vue") as Promise<{ default: unknown }>,
        },
        {
            label: "定时任务页",
            routeName: "workspace-scheduled-tasks",
            anchor: "scheduled-tasks-heading",
            loader: () =>
                import("../pages/ScheduledTasksView.vue") as Promise<{ default: unknown }>,
        },
        {
            label: "资源页",
            routeName: "workspace-resources",
            anchor: "workspace-resources-view",
            loader: () =>
                import("../pages/WorkspaceResourcesView.vue") as Promise<{ default: unknown }>,
        },
        {
            label: "成员页",
            routeName: "workspace-members",
            anchor: "workspace-members-page",
            loader: () =>
                import("../pages/WorkspaceMembersView.vue") as Promise<{ default: unknown }>,
        },
        {
            label: "设置页",
            routeName: "workspace-settings",
            anchor: "workspace-settings-page",
            loader: () =>
                import("../pages/WorkspaceSettingsView.vue") as Promise<{ default: unknown }>,
        },
    ];

    for (const page of pages) {
        it(
            page.label +
                "：渲染出自己的一级标题，且容器页签 / 右栏会话配置页签 / 会话列表计数全为 0",
            async () => {
                routeState.name = page.routeName;
                const wrapper = await mountPage(page.loader);
                // 前提：页面真的挂起来了 —— 否则下面三条 0 计数测的是空壳（假绿）。
                expect(wrapper.find('[data-testid="' + page.anchor + '"]').exists()).toBe(true);
                const hits = containerHits(wrapper.html());
                expect(hits).toEqual([
                    { selector: CONTAINER_SELECTORS[0], count: 0 },
                    { selector: CONTAINER_SELECTORS[1], count: 0 },
                    { selector: CONTAINER_SELECTORS[2], count: 0 },
                ]);
                wrapper.unmount();
            },
        );
    }
});

/**
 * 反分支的**前置事实**：容器行不自己存页签，它读 `workspaceTabBarContext` 那份总线快照
 * （唯一 writer 是 WorkspaceTabBar，它挂在工作台**兄弟**位置 AppLayout 里）。所以单 mount
 * 工作台时 `mainContainerTabs` 恒空 —— 那时数 0 个页签是**测夹具**，不是测产品。
 * 这里按 Writer 的真实注册形状注册一份快照（字段与 WorkspaceTabBar.vue:180-191 同形），
 * 让「会话页真有容器页签行」这条可判。
 */
function registerProbeTabs(): () => void {
    const tabs = ref([{ id: "session:s1", label: "s1", closable: true, testid: "session:s1" }]);
    const activeId = ref<string | null>("session:s1");
    return registerWorkspaceTabBar({
        tabs: computed(() => tabs.value),
        activeId: computed(() => activeId.value),
        select: () => {},
        close: () => {},
    });
}

describe("G3 会话页有容器（反分支）", () => {
    it("WorkspaceWorkbench 渲染出容器页签行与页签，容器判据不是自说自话", async () => {
        routeState.name = "workspace-session";
        const releaseTabs = registerProbeTabs();
        const stubs = {
            FileTreePanel: { template: '<div data-testid="file-tree-stub" />' },
            FileEditor: { template: '<div data-testid="file-editor-stub" />' },
            WorkspaceChangesPanel: { template: '<div data-testid="changes-panel-stub" />' },
            SessionMonitorPanel: { template: '<div data-testid="session-monitor-stub" />' },
            SessionContextPanel: { template: '<div data-testid="session-context-panel-stub" />' },
        };
        const wrapper = mount(WorkspaceWorkbench, {
            props: { workspaceId: WORKSPACE_ID, sessionId: null },
            global: { plugins: [i18n], stubs },
        });
        await flushPromises();
        // 容器行本体（nav）在场，且 data-container="main" —— allowEmpty 让 0 页签时也渲染。
        const rows = wrapper.findAll('[data-testid="workspace-container-tabs"]');
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.some((row) => row.attributes("data-container") === "main")).toBe(true);
        const hits = containerHits(wrapper.html());
        expect(hits[0].count).toBeGreaterThan(0);
        wrapper.unmount();
        releaseTabs();
    });
});
