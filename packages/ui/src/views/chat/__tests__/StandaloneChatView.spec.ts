import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { h } from "vue";
import { i18n } from "../../../i18n";
import { api } from "../../../composables/api";
import { useAuthStore } from "../../../stores/auth";
import { useSessionStore } from "../../../stores/session";
import { readTabWorkspaceId, writeTabWorkspace } from "../../../lib/workspaceContext";
import StandaloneChatView from "../StandaloneChatView.vue";

// ChatPanel 只吃 sessionId，本页复用它；这里替身掉以免把整条 chat 依赖树拉进单测。
vi.mock("../../../features/workspace/chat/components/ChatPanel.vue", () => ({
    default: {
        name: "ChatPanelStub",
        props: { sessionId: { type: String, required: true } },
        setup(props: { sessionId: string }) {
            return () => h("div", { "data-testid": "chat-panel-stub" }, props.sessionId);
        },
    },
}));

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function row(workspaceId: string | null) {
    return {
        id: SESSION_ID,
        title: "独立会话标题",
        workspaceId,
        archived: false,
        createdAt: "2026-11-14T00:00:00Z",
        updatedAt: "2026-11-14T00:00:00Z",
    };
}

let router: Router;

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    sessionStorage.clear();
    router = createRouter({
        history: createMemoryHistory(),
        routes: [
            {
                path: "/chat/:sessionId",
                name: "standalone-chat",
                component: { setup: () => () => null },
            },
            {
                path: "/workspace/:workspaceId/chat/:sessionId",
                name: "workspace-chat",
                component: { setup: () => () => null },
            },
        ],
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

async function mountPage() {
    await router.push("/chat/" + SESSION_ID);
    await router.isReady();
    const wrapper = mount(StandaloneChatView, {
        global: { plugins: [i18n, router], stubs: { Teleport: true } },
    });
    await flushPromises();
    return wrapper;
}

describe("StandaloneChatView (task-373 / D-1228)", () => {
    it("mounts ChatPanel for a workspace-less session and clears the workspace context", async () => {
        const auth = useAuthStore();
        auth.$patch({ workspace: { id: WORKSPACE_ID, name: "Ws" } });
        writeTabWorkspace({ id: WORKSPACE_ID });
        const store = useSessionStore();
        store.sessions = [
            {
                id: SESSION_ID,
                title: "工作区会话",
                createdAt: "2026-11-14T00:00:00Z",
                updatedAt: "2026-11-14T00:00:00Z",
                workspaceId: WORKSPACE_ID,
                context: { agents: [] },
            } as never,
        ];
        vi.spyOn(api, "getSession").mockResolvedValue(row(null) as never);

        const wrapper = await mountPage();

        // 先判替身真的挂上，再判业务（否则红会落在业务断言上，指向错误的文件）。
        expect(wrapper.find('[data-testid="chat-panel-stub"]').exists()).toBe(true);
        expect(wrapper.get('[data-testid="chat-panel-stub"]').text()).toBe(SESSION_ID);
        expect(wrapper.get('[data-testid="standalone-chat-title"]').text()).toBe("独立会话标题");
        expect(wrapper.get('[data-testid="standalone-chat-badge"]').text()).toBe("独立会话");
        // 读门按 workspace 相等过滤 ⇒ 上下文必须清掉（内存 + sessionStorage 两份）。
        expect(auth.currentWorkspaceId).toBeNull();
        expect(readTabWorkspaceId()).toBeNull();
        // 清之前先把 live 投影存进按组缓存，左栏那一组不会变成假空态。
        expect(store.sessionsByWorkspace[WORKSPACE_ID]).toHaveLength(1);
        wrapper.unmount();
    });

    it("sends a session that belongs to a workspace back to its workspace chat route", async () => {
        vi.spyOn(api, "getSession").mockResolvedValue(row(WORKSPACE_ID) as never);
        const wrapper = await mountPage();
        expect(router.currentRoute.value.name).toBe("workspace-chat");
        expect(router.currentRoute.value.params.workspaceId).toBe(WORKSPACE_ID);
        // 本页是独立挂载（不经 router-view），跳转不会卸载它 ⇒ 判据取「没有把这条会话
        // 当成独立会话应用」，而不是判 DOM 卸载（真应用里路由切换会卸载本页）。
        expect(useSessionStore().currentSessionId).toBeNull();
        expect(wrapper.get('[data-testid="standalone-chat-title"]').text()).toBe("未命名会话");
        wrapper.unmount();
    });

    it("shows a retryable error instead of an empty chat when the read fails", async () => {
        const load = vi
            .spyOn(api, "getSession")
            .mockRejectedValueOnce(new Error("boom"))
            .mockResolvedValue(row(null) as never);
        const wrapper = await mountPage();
        expect(wrapper.find('[data-testid="standalone-chat-error"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="chat-panel-stub"]').exists()).toBe(false);

        await wrapper.get('[data-testid="standalone-chat-retry"]').trigger("click");
        await flushPromises();
        expect(load).toHaveBeenCalledTimes(2);
        expect(wrapper.find('[data-testid="chat-panel-stub"]').exists()).toBe(true);
        wrapper.unmount();
    });
});
