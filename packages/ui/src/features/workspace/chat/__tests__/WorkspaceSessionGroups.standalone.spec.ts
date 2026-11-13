import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { i18n } from "../../../../i18n";
import { api } from "../../../../composables/api";
import { useSessionStore } from "../../../../stores/session";
import WorkspaceSessionGroups from "../components/WorkspaceSessionGroups.vue";

/**
 * task-373 / `D-1236` 的左栏判据：
 * ① 为 0 **隐藏**分组；② 有则**沉底**（`D-1221`）；③ 一个工作区都没有但有独立会话的用户
 * **不落**「还没有工作区」空态（否则硬判据对最需要它的人失效）；④ 读失败仍渲染 + 重试，
 * 不静默伪装成「你没有独立会话」；⑤ 搜索过滤独立会话行。
 */
const WS_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STANDALONE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function workspaceRow() {
    return { id: WS_ID, name: "Ws", workspaceRole: "OWNER" as const };
}

function standaloneRow(title: string) {
    return {
        id: STANDALONE_ID,
        title,
        workspaceId: null,
        archived: false,
        createdAt: "2026-11-14T00:00:00Z",
        updatedAt: "2026-11-14T00:00:00Z",
    };
}

function testRouter() {
    return createRouter({
        history: createMemoryHistory(),
        routes: [{ path: "/:pathMatch(.*)*", component: { setup: () => () => null } }],
    });
}

async function mountGroups() {
    const wrapper = mount(WorkspaceSessionGroups, {
        global: { plugins: [i18n, testRouter()], stubs: { Teleport: true } },
    });
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    sessionStorage.clear();
    vi.spyOn(api, "listWorkspaces").mockResolvedValue([workspaceRow()] as never);
    vi.spyOn(api, "getSessions").mockResolvedValue({ sessions: [], workspace: null } as never);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("WorkspaceSessionGroups standalone group (task-373)", () => {
    it("hides the group when there is no standalone session", async () => {
        vi.spyOn(api, "getWorkspacelessSessions").mockResolvedValue({
            sessions: [],
            workspace: null,
        } as never);
        const wrapper = await mountGroups();
        expect(wrapper.find('[data-testid="sidebar-standalone-group"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="sidebar-workspace-group-' + WS_ID + '"]').exists()).toBe(
            true,
        );
        wrapper.unmount();
    });

    it("renders it last (sinks to the bottom) with its rows", async () => {
        vi.spyOn(api, "getWorkspacelessSessions").mockResolvedValue({
            sessions: [standaloneRow("独立会话一号")],
            workspace: null,
        } as never);
        const wrapper = await mountGroups();
        const sections = wrapper.findAll("section");
        expect(sections.length).toBe(2);
        expect(sections.at(-1)!.attributes("data-testid")).toBe("sidebar-standalone-group");
        expect(wrapper.get('[data-testid="sidebar-standalone-group"]').text()).toContain(
            "独立会话",
        );
        expect(wrapper.get('[data-testid="sidebar-standalone-group-body"]').text()).toContain(
            "独立会话一号",
        );
        wrapper.unmount();
    });

    it("does not fall into the no-workspace empty state when only standalone sessions exist", async () => {
        vi.spyOn(api, "listWorkspaces").mockResolvedValue([] as never);
        vi.spyOn(api, "getWorkspacelessSessions").mockResolvedValue({
            sessions: [standaloneRow("只有独立会话")],
            workspace: null,
        } as never);
        const wrapper = await mountGroups();
        expect(wrapper.find('[data-testid="sidebar-empty-no-workspace"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="sidebar-standalone-group"]').exists()).toBe(true);
        wrapper.unmount();
    });

    it("keeps the group visible with a retry when the read fails (no silent fake empty)", async () => {
        const load = vi
            .spyOn(api, "getWorkspacelessSessions")
            .mockRejectedValueOnce(new Error("boom"))
            .mockResolvedValue({ sessions: [], workspace: null } as never);
        const wrapper = await mountGroups();
        expect(wrapper.find('[data-testid="sidebar-standalone-group"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="sidebar-standalone-error"]').exists()).toBe(true);

        await wrapper.get('[data-testid="sidebar-standalone-retry"]').trigger("click");
        await flushPromises();
        expect(load).toHaveBeenCalledTimes(2);
        expect(wrapper.find('[data-testid="sidebar-standalone-error"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("filters standalone rows by the search query and emits new-standalone-session from the row +", async () => {
        vi.spyOn(api, "getWorkspacelessSessions").mockResolvedValue({
            sessions: [standaloneRow("可被搜到的会话")],
            workspace: null,
        } as never);
        const wrapper = await mountGroups();
        const store = useSessionStore();
        store.searchQuery = "搜不到";
        await flushPromises();
        // 全局零命中走的是既有的「没有匹配的会话」形态（不是「该组暂无会话」）。
        expect(wrapper.find('[data-testid="sidebar-empty-no-match"]').exists()).toBe(true);
        expect(wrapper.text()).not.toContain("可被搜到的会话");

        store.searchQuery = "";
        await flushPromises();
        await wrapper.get('[data-testid="sidebar-standalone-group-new"]').trigger("click");
        expect(wrapper.emitted("new-standalone-session")).toHaveLength(1);
        wrapper.unmount();
    });
});
