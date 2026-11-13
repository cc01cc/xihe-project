import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { Router } from "vue-router";
import { i18n as appI18n } from "../../../../i18n";
import { useAuthStore } from "../../../../stores/auth";
import { useSessionStore } from "../../../../stores/session";
import WorkspaceSessionGroups from "../components/WorkspaceSessionGroups.vue";

/**
 * task-352 / `D-1206`：左栏 = 工作区分组 + 会话项（懒加载）。
 *
 * <p>文件名是历史（`task-349` 作废后没有再改名的必要），内容钉的是 352 的五条判据里
 * 能在组件层钉的四条：
 * ① 两个分组都渲染出来；② 首屏请求数 = 1，展开第二组才 +1，**折叠再展开 +0**；
 * ③ 两个空态各自 testid 且文案互不相等（承接 `task-349` 的判据）；
 * ④ 选中会话所在分组展开（`aria-expanded`）。</p>
 *
 * <p>请求数用 `api.getSessions` 的调用账本量（不是「看起来不卡」）：
 * `task-352` 卡面硬约束①的判据就是这条读数。</p>
 */
const zhSidebar = (
    appI18n.global.getLocaleMessage("zh-CN") as unknown as {
        sidebar: Record<string, unknown>;
    }
).sidebar;
type Branch = { title: string; body?: string; action?: string };
const noWorkspace = zhSidebar.emptyNoWorkspace as Branch;
const noSession = zhSidebar.emptyNoSession as Branch;

// `oxlint` 的 `vitest/require-mock-type-parameters` 是阻断规则：`vi.fn()` 必须带类型参数，
// 否则 `mockResolvedValue` 的入参就是 `never`，夹具写错了也不会红。
const { pushSpy, listWorkspaces, getSessions, getWorkspacelessSessions } = vi.hoisted(() => ({
    pushSpy: vi.fn<Router["push"]>(),
    listWorkspaces: vi.fn<() => Promise<unknown[]>>(),
    getSessions: vi.fn<(workspaceId?: string) => Promise<unknown>>(),
    getWorkspacelessSessions: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("vue-router", async (importOriginal) => {
    const actual = await importOriginal<typeof import("vue-router")>();
    return {
        ...actual,
        useRouter: () => ({ push: pushSpy }),
        useRoute: () => ({ params: {}, name: "workspace-chat", path: "/workspace/ws/chat/s" }),
    };
});

// 只替换两个取数面，其余（ApiError / workspaceHeaders / 归一化）保持真实现 ——
// 把整个模块换成手搓对象会让「两套归一化」从这个 spec 里开始。
vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../../composables/api")>();
    return {
        ...actual,
        api: { ...actual.api, listWorkspaces, getSessions, getWorkspacelessSessions },
    };
});

function sessionRecord(id: string, title: string, workspaceId: string) {
    return {
        id,
        title,
        workspaceId,
        createdAt: "2026-11-13T10:00:00Z",
        updatedAt: "2026-11-13T10:00:00Z",
        kind: null,
        spawnedFromSessionId: null,
        agentPrincipalId: null,
    };
}

let pinia = createPinia();

function mountGroups() {
    return mount(WorkspaceSessionGroups, { global: { plugins: [appI18n, pinia] } });
}

function seedWorkspace(workspaceId: string | null) {
    useAuthStore().$patch({
        token: "mock-token",
        user: { id: "u-1", email: "tester@xihe.local" },
        workspace: workspaceId ? { id: workspaceId, name: "Ws " + workspaceId } : null,
    });
}

/** 每次挂载前把两个取数面接到给定数据上（`matrix[wsId]` = 该组的会话）。 */
function seedData(
    workspaces: string[],
    matrix: Record<string, ReturnType<typeof sessionRecord>[]>,
) {
    listWorkspaces.mockResolvedValue(
        workspaces.map((id) => ({ id, name: "Ws " + id, workspaceRole: "OWNER" })),
    );
    getSessions.mockImplementation(async (workspaceId?: string) => {
        const key = workspaceId ?? workspaces[0]!;
        return { sessions: matrix[key] ?? [], workspace: null };
    });
}

beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    pushSpy.mockReset();
    listWorkspaces.mockReset();
    getSessions.mockReset();
    // task-373 / `D-1236`：「一个分组都没有」空态现在还要求**独立会话分组也不显示**
    // （`WorkspaceSessionGroups.vue:278` 的 `!hasWorkspace && !showStandalone`）。
    // 不桩这条读面，jsdom 里真 fetch 失败 ⇒ 分组带错渲染 ⇒ showStandalone 为真 ⇒
    // ③b 的前提（一个分组都没有）根本不成立。独立会话自己的判据在
    // `WorkspaceSessionGroups.standalone.spec.ts`，这里只把前提摆正，不重复钉。
    getWorkspacelessSessions.mockReset();
    getWorkspacelessSessions.mockResolvedValue({ sessions: [], workspace: null });
});

describe("左栏工作区分组（task-352）", () => {
    it("两个工作区都渲染成分组；首屏只拉当前组，展开第二组才 +1", async () => {
        seedWorkspace("ws-a");
        seedData(["ws-a", "ws-b"], {
            "ws-a": [sessionRecord("s-a1", "Alpha 会话", "ws-a")],
            "ws-b": [sessionRecord("s-b1", "Beta 会话", "ws-b")],
        });

        const wrapper = mountGroups();
        await flushPromises();

        // ① 两个分组头都在（未做时只会渲染当前那一个）
        expect(wrapper.find('[data-testid="sidebar-workspace-group-ws-a"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="sidebar-workspace-group-ws-b"]').exists()).toBe(true);
        expect(wrapper.text()).toContain("Ws ws-a");
        expect(wrapper.text()).toContain("Ws ws-b");

        // ② 首屏请求数 = 1（当前组）；未做懒加载时 = workspace 数 = 2。
        // 当前组走 live 投影那条路（`loadSessions()`，workspace 由 tab 上下文的头决定，
        // 所以实参为空）；别组才带显式 workspaceId —— 两条路的分界就在这里被钉住。
        expect(getSessions).toHaveBeenCalledTimes(1);
        expect(getSessions.mock.calls[0]).toEqual([]);
        expect(wrapper.text()).toContain("Alpha 会话");
        expect(wrapper.text()).not.toContain("Beta 会话");

        // 展开第二组 ⇒ 第 2 个请求，且它的会话出现
        await wrapper.get('[data-testid="sidebar-workspace-group-toggle-ws-b"]').trigger("click");
        await flushPromises();
        expect(getSessions).toHaveBeenCalledTimes(2);
        expect(getSessions).toHaveBeenLastCalledWith("ws-b");
        expect(wrapper.text()).toContain("Beta 会话");

        // ② 折叠再展开：**不许重新拉取**（计数不变）
        await wrapper.get('[data-testid="sidebar-workspace-group-toggle-ws-b"]').trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="sidebar-workspace-group-body-ws-b"]').exists()).toBe(
            false,
        );
        await wrapper.get('[data-testid="sidebar-workspace-group-toggle-ws-b"]').trigger("click");
        await flushPromises();
        expect(getSessions).toHaveBeenCalledTimes(2);
        expect(wrapper.text()).toContain("Beta 会话");
    });

    it("④ 选中会话所在分组展开（aria-expanded=true）", async () => {
        seedWorkspace("ws-a");
        seedData(["ws-a", "ws-b"], { "ws-a": [sessionRecord("s-a1", "Alpha 会话", "ws-a")] });

        const wrapper = mountGroups();
        await flushPromises();

        expect(
            wrapper
                .get('[data-testid="sidebar-workspace-group-toggle-ws-a"]')
                .attributes("aria-expanded"),
        ).toBe("true");
        expect(
            wrapper
                .get('[data-testid="sidebar-workspace-group-toggle-ws-b"]')
                .attributes("aria-expanded"),
        ).toBe("false");
    });

    it("③a 分组展开但该组无会话：独立出口（新建会话）", async () => {
        seedWorkspace("ws-a");
        seedData(["ws-a"], { "ws-a": [] });

        const wrapper = mountGroups();
        await flushPromises();

        const box = wrapper.get('[data-testid="sidebar-empty-no-session"]');
        expect(box.text()).toContain(noSession.title);
        expect(wrapper.find('[data-testid="sidebar-empty-no-workspace"]').exists()).toBe(false);
        await box.get('[data-testid="sidebar-empty-no-session-action"]').trigger("click");
        expect(wrapper.emitted("new-session")).toEqual([["ws-a"]]);
    });

    it("③b 一个分组都没有：另一个出口（新建工作区），且两态文案互不相等", async () => {
        seedWorkspace(null);
        seedData([], {});

        const wrapper = mountGroups();
        await flushPromises();

        const box = wrapper.get('[data-testid="sidebar-empty-no-workspace"]');
        expect(box.text()).toContain(noWorkspace.title);
        expect(wrapper.find('[data-testid="sidebar-empty-no-session"]').exists()).toBe(false);
        // 反向判据：两态不是同一句话（合并两块就等于没分）
        expect(box.text()).not.toContain(noSession.title);
        expect(noWorkspace.title).not.toBe(noSession.title);
        expect(noWorkspace.title.includes(noSession.title)).toBe(false);
        expect(noSession.title.includes(noWorkspace.title)).toBe(false);

        await box.get('[data-testid="sidebar-empty-no-workspace-action"]').trigger("click");
        expect(pushSpy).toHaveBeenCalledWith("/workspace");
    });

    it("搜索零命中：第三种空态，不冒充「该组暂无会话」", async () => {
        seedWorkspace("ws-a");
        seedData(["ws-a"], { "ws-a": [sessionRecord("s-a1", "Alpha 会话", "ws-a")] });
        const sessionStore = useSessionStore();
        sessionStore.searchQuery = "zzz-no-match";

        const wrapper = mountGroups();
        await flushPromises();

        const box = wrapper.get('[data-testid="sidebar-empty-no-match"]');
        expect(box.text()).toContain(zhSidebar.emptyNoMatch as string);
        expect(box.text()).not.toContain(noSession.title);
    });
});
