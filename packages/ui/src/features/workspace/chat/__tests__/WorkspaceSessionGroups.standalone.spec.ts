import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { i18n } from "../../../../i18n";
import { api } from "../../../../composables/api";
import { useAuthStore } from "../../../../stores/auth";
import { useSessionStore } from "../../../../stores/session";
import WorkspaceSessionGroups from "../components/WorkspaceSessionGroups.vue";

/**
 * task-373 / `D-1236` 的左栏判据：
 * ① 为 0 **隐藏**分组；② 有则**在最上**（`D-1754` ③，已作废 `D-1221` ①「位置：列表末尾」）；
 * ③ 一个工作区都没有但有独立会话的用户**不落**「还没有工作区」空态（否则硬判据对最需要它的人失效）；
 * ④ 读失败仍渲染 + 重试，不静默伪装成「你没有独立会话」；⑤ 搜索过滤独立会话行。
 *
 * <p><b>② 拆成两条顺序断言（task-114，不许只钉一条）：</b>A = standalone 在任何工作区组之前
 * （`D-1754` ③）；B = 当前工作区组仍在**工作区组里**第一个（`D-1174`「我在哪」）。
 * 两条是正交的轴 —— `D-1174` 管组间相对顺序，`D-1754` ③ 管 standalone 相对所有组的位置。
 * 只钉 A 的最坏形态：把 standalone 顶到最前后，「我现在的会话」被挤出首屏第一格
 * （`D-1174` 的原始诉求失效），而测试照样绿。所以 A、B 各一条、各自可单独变异成红。</p>
 */
const WS_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** 第二个工作区：顺序断言必须有**两个**工作区组才能分别钉「standalone 在最上」与「当前组打头」。 */
const OTHER_WS_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STANDALONE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function workspaceRow(id: string = WS_ID, name = "Ws") {
    return { id, name, workspaceRole: "OWNER" as const };
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

/**
 * 模板顺序的唯一读数：**按 DOM 顺序取各 `<section>` 的 testid**。
 * 不读 CSS 位置、不读源码行号 —— jsdom 不求值布局，只有顺序这一个事实可断言。
 */
function sectionTestIds(wrapper: ReturnType<typeof mount>) {
    return wrapper.findAll("section").map((section) => section.attributes("data-testid") ?? "");
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

    /**
     * 两条顺序断言**同时**成立才算绿（task-114 的护栏；下面 A、B 各自还有一条专属用例，
     * 因为「两条同时绿」是验收，而「各自能单独变红」是判别力）。
     */
    it("A+B: standalone 在最上，且当前工作区仍在工作区组里第一个（D-1754 ③ / D-1174）", async () => {
        vi.spyOn(api, "listWorkspaces").mockResolvedValue([
            workspaceRow(WS_ID, "Ws"),
            workspaceRow(OTHER_WS_ID, "Other"),
        ] as never);
        useAuthStore().workspace = workspaceRow(OTHER_WS_ID, "Other") as never;
        vi.spyOn(api, "getWorkspacelessSessions").mockResolvedValue({
            sessions: [standaloneRow("独立会话一号")],
            workspace: null,
        } as never);
        const wrapper = await mountGroups();

        const ids = sectionTestIds(wrapper);
        expect(ids).toEqual([
            "sidebar-standalone-group",
            `sidebar-workspace-group-${OTHER_WS_ID}`,
            `sidebar-workspace-group-${WS_ID}`,
        ]);
        expect(wrapper.get('[data-testid="sidebar-standalone-group"]').text()).toContain(
            "独立会话",
        );
        expect(wrapper.get('[data-testid="sidebar-standalone-group-body"]').text()).toContain(
            "独立会话一号",
        );
        wrapper.unmount();
    });

    /**
     * 断言 A（`D-1754` ③）：standalone 分组排在**任何**工作区组之前。
     * 变异读数：把 standalone `<section>` 挪回 `v-for` 之后 ⇒ 本条红（此时 B 仍绿 —— 两条各自独立）。
     */
    it("A. standalone 在最上（D-1754 ③）", async () => {
        vi.spyOn(api, "listWorkspaces").mockResolvedValue([
            workspaceRow(WS_ID, "Ws"),
            workspaceRow(OTHER_WS_ID, "Other"),
        ] as never);
        vi.spyOn(api, "getWorkspacelessSessions").mockResolvedValue({
            sessions: [standaloneRow("独立会话一号")],
            workspace: null,
        } as never);
        const wrapper = await mountGroups();

        const ids = sectionTestIds(wrapper);
        expect(ids.filter((id) => id !== "sidebar-standalone-group")).toEqual([
            `sidebar-workspace-group-${WS_ID}`,
            `sidebar-workspace-group-${OTHER_WS_ID}`,
        ]);
        expect(ids.indexOf("sidebar-standalone-group")).toBe(0);
        wrapper.unmount();
    });

    /**
     * 断言 B（`D-1174`「我在哪」）：**当前**工作区组仍排在工作区组的第一个 —— 只钉 A 的最坏
     * 形态就是「standalone 顶上去以后用户找不到我现在的会话」，而「standalone 在最上」照样成立。
     * 变异读数：把 `orderedWorkspaces` 换成不重排的 `workspaces`（当前工作区不再打头）⇒ 本条红。
     */
    it("B. 当前工作区组仍在工作区组里第一个（D-1174）", async () => {
        vi.spyOn(api, "listWorkspaces").mockResolvedValue([
            workspaceRow(WS_ID, "Ws"),
            workspaceRow(OTHER_WS_ID, "Other"),
        ] as never);
        useAuthStore().workspace = workspaceRow(OTHER_WS_ID, "Other") as never;
        vi.spyOn(api, "getWorkspacelessSessions").mockResolvedValue({
            sessions: [standaloneRow("独立会话一号")],
            workspace: null,
        } as never);
        const wrapper = await mountGroups();

        const workspaceGroupIds = sectionTestIds(wrapper).filter((id) =>
            id.startsWith("sidebar-workspace-group-"),
        );
        expect(workspaceGroupIds[0]).toBe(`sidebar-workspace-group-${OTHER_WS_ID}`);
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

    it("group-new 触控盒 ≥24（task-57：p-1+size-3.5 只有 19.25px）", async () => {
        const wrapper = await mountGroups();
        // `p-1`(7) + `size-3.5`(12.25) = 19.25px（ui-2 batch-4 实测 19.3）⇒ 顶到
        // `min-h-7 min-w-7` = 24.5px；图标仍 size-3.5 不变。jsdom 不求值 Tailwind ⇒ 钉类名。
        const newBtn = wrapper.get('[data-testid="sidebar-standalone-group-new"]');
        expect(newBtn.classes()).toEqual(
            expect.arrayContaining(["min-h-7", "min-w-7", "items-center", "justify-center"]),
        );
        expect(newBtn.classes()).not.toContain("p-1");
        wrapper.unmount();
    });
});
