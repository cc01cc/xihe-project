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
 * task-937 / R74：**写后失效**的两条回归判据。
 *
 * <p>反证口径：把 `WorkspaceSessionGroups.vue` 里 `writeInvalidate` 的 `watch` 删掉后，
 * ①「发送后标题更新」会停在旧标题（`getSessions` 只被调用一次）；
 * ②「创建工作区后列表长度 +1」不会重新读列表（新分组节点不存在）。
 * 两条都不是恒真断言：它们观察的是**第二次请求**与**DOM 的新节点**。</p>
 */
const WS_ID = "11111111-1111-4111-8111-111111111111";
const NEW_WS_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

function workspaceRow(id: string, name: string) {
    return { id, name, workspaceRole: "OWNER" as const };
}

function sessionRow(title: string) {
    return {
        id: SESSION_ID,
        title,
        workspaceId: WS_ID,
        createdAt: "2026-11-24T00:00:00Z",
        updatedAt: "2026-11-24T00:00:00Z",
        kind: null,
        spawnedFromSessionId: null,
        agentPrincipalId: null,
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
        global: {
            plugins: [i18n, testRouter()],
            stubs: { Teleport: { template: "<div><slot /></div>" } },
        },
    });
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    sessionStorage.clear();
    useAuthStore().$patch({
        token: "mock-token",
        user: { id: "u-1", email: "tester@xihe.local" },
        workspace: workspaceRow(WS_ID, "Workspace One"),
    });
    vi.spyOn(api, "listWorkspaces").mockResolvedValue([
        workspaceRow(WS_ID, "Workspace One"),
    ] as never);
    vi.spyOn(api, "getSessions").mockResolvedValue({
        sessions: [sessionRow("未命名会话")],
        workspace: null,
    } as never);
    vi.spyOn(api, "getWorkspacelessSessions").mockResolvedValue({
        sessions: [],
        workspace: null,
    } as never);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("写后失效（task-937 / R74）", () => {
    it("发送后标题更新：写动作推进失效信号 ⇒ 侧栏同动作重读派生标题", async () => {
        const wrapper = await mountGroups();
        expect(wrapper.text()).toContain("未命名会话");

        vi.spyOn(api, "getSessions").mockResolvedValue({
            sessions: [sessionRow("首条消息派生的标题")],
            workspace: null,
        } as never);
        // ChatPanel 的首条消息定向读回（`loadSession → applySessionRecord`）推进的就是这个信号。
        useSessionStore().invalidateReadViews();
        await flushPromises();

        expect(vi.mocked(api.getSessions)).toHaveBeenCalledTimes(2);
        expect(wrapper.text()).toContain("首条消息派生的标题");
        expect(wrapper.text()).not.toContain("未命名会话");
        wrapper.unmount();
    });

    it("创建工作区后列表长度 +1：当前工作区不在旧列表 ⇒ 同动作重读工作区列表", async () => {
        const wrapper = await mountGroups();
        const before = wrapper.findAll('section[data-testid^="sidebar-workspace-group-"]').length;
        expect(before).toBe(1);

        vi.spyOn(api, "listWorkspaces").mockResolvedValue([
            workspaceRow(WS_ID, "Workspace One"),
            workspaceRow(NEW_WS_ID, "Workspace Two"),
        ] as never);
        // WorkspaceCreateDialog 成功后的真实写法：先写 auth.workspace，再跳转。
        useAuthStore().$patch({ workspace: workspaceRow(NEW_WS_ID, "Workspace Two") });
        await flushPromises();

        expect(
            wrapper.find(`section[data-testid="sidebar-workspace-group-${NEW_WS_ID}"]`).exists(),
        ).toBe(true);
        expect(wrapper.findAll('section[data-testid^="sidebar-workspace-group-"]').length).toBe(
            before + 1,
        );
        wrapper.unmount();
    });
});
