import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import { i18n } from "../../../i18n";
import WorkspaceMembersPanel from "../components/WorkspaceMembersPanel.vue";

/**
 * PLAN-0773 M4-3（task-236）`/workspace/:id/members` 的机器判据：
 * ① 路由可达 + 一级导航第 6 项（order 45）——项数与顺序由 `workspaceNav.ssot.spec.ts` 钉；
 * ② **成员页与设置页 tab 时代渲染的是同一个组件**（`findComponent(WorkspaceMembersPanel)`，防复制一份成员逻辑）；
 * ③ `canViewMembers === false`（VIEWER）不渲染成员列表、**不发明 403 页**（沿用设置页 tab 的既有语义）。
 */
const WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";

const routeState = vi.hoisted(() => ({
    workspaceId: "55555555-5555-4555-8555-555555555555",
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
    useRoute: () =>
        ({
            name: "workspace-members",
            path: `/workspace/${routeState.workspaceId}/members`,
            params: { workspaceId: routeState.workspaceId },
            query: {},
        }) as RouteLocationNormalizedLoaded,
    useRouter: () => ({
        push: vi.fn<() => Promise<void>>(),
        replace: vi.fn<() => Promise<void>>(),
    }),
}));

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message?: unknown) => string | number>(),
        error: vi.fn<(message?: unknown) => string | number>(),
        warning: vi.fn<(message?: unknown) => string | number>(),
        info: vi.fn<(message?: unknown) => string | number>(),
    },
}));

function mockMembersFetch() {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const url = typeof input === "string" ? input : input.url,
            parsed = new URL(url, "http://localhost");
        if (parsed.pathname.endsWith(`/workspaces/${WORKSPACE_ID}/members`)) {
            return Promise.resolve(new Response(JSON.stringify({ members: [] }), { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });
}

async function mountPage() {
    const { default: WorkspaceMembersView } = await import("../pages/WorkspaceMembersView.vue");
    const wrapper = mount(WorkspaceMembersView, {
        global: { plugins: [i18n] },
    });
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
    mockMembersFetch();
});

describe("WorkspaceMembersView（M4-3 / task-236）", () => {
    it("渲染的是 WorkspaceMembersPanel 本体（同一组件，不复制成员逻辑）", async () => {
        const wrapper = await mountPage();

        expect(wrapper.find('[data-testid="workspace-members-page"]').exists()).toBe(true);
        const panel = wrapper.findComponent(WorkspaceMembersPanel);
        expect(panel.exists()).toBe(true);
        expect(panel.props("workspaceId")).toBe(WORKSPACE_ID);
        wrapper.unmount();
    });

    it("readonly 推导与设置页 tab 时代同一份：OWNER 可管理、EDITOR 只读", async () => {
        const auth = (await import("../../../stores/auth")).useAuthStore();
        let wrapper = await mountPage();
        // 工作区未解析 ⇒ undefined（面板首帧禁用表单，BL-344 语义）。
        expect(wrapper.findComponent(WorkspaceMembersPanel).props("readonly")).toBeUndefined();
        wrapper.unmount();

        auth.workspace = { id: WORKSPACE_ID, name: "Ws", workspaceRole: "OWNER" } as never;
        wrapper = await mountPage();
        expect(wrapper.findComponent(WorkspaceMembersPanel).props("readonly")).toBe(false);
        wrapper.unmount();

        auth.workspace = { id: WORKSPACE_ID, name: "Ws", workspaceRole: "EDITOR" } as never;
        wrapper = await mountPage();
        expect(wrapper.findComponent(WorkspaceMembersPanel).props("readonly")).toBe(true);
        wrapper.unmount();
    });

    it("canViewMembers=false（VIEWER）不渲染成员列表，也不发明 403 页", async () => {
        const wrapper = await mountPage();
        const auth = (await import("../../../stores/auth")).useAuthStore();
        auth.workspace = { id: WORKSPACE_ID, name: "Ws", workspaceRole: "VIEWER" } as never;
        await wrapper.vm.$nextTick();
        await flushPromises();

        expect(auth.canViewMembers).toBe(false);
        expect(wrapper.findComponent(WorkspaceMembersPanel).exists()).toBe(false);
        expect(wrapper.find('[data-testid="ws-members-panel"]').exists()).toBe(false);
        // 不发明 403 页：除页壳标题外没有任何「无权」面。
        expect(wrapper.text()).not.toContain("403");
        wrapper.unmount();
    });
});
