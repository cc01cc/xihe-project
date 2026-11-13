/**
 * BL-344：「能力位抖动导致成员面板卸载、用户已填内容被清空」的回归用例。
 *
 * 缺陷：`canViewMembers` 原来只有一个布尔（`workspaceRole !== "VIEWER"`，而
 * `workspaceRole` 在工作区还没加载时回落到 `EDITOR`），加载/刷新期间能力位一抖，
 * `WorkspaceSettingsView` 的成员面板就被 `v-if` 卸载再重挂 —— 面板内的
 * `addUsername`（纯 `ref`）随之清空，按钮回到 disabled（host E2E
 * `workspace-members` 30s 超时的根因）。
 *
 * 修法：能力位三态（`unknown` / `true` / `false`）。本用例断言：
 *  1. 未知（`undefined`）时成员 tab 可见、面板**挂载**；
 *  2. 未知期间重渲染**不重建**面板（DOM 节点 identity 不变 ⇒ 子树状态不会被销毁）；
 *  3. 确定无权（`false`）时才回落 `general` 且面板卸载（"未知"与"无权"必须分开）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import { i18n } from "../../../i18n";
import { makeWorkspace } from "../../../tests/workspaceFixture";

const WORKSPACE_ID = "77777777-7777-4777-8777-777777777777";

const routeState = vi.hoisted(() => ({
    workspaceId: "77777777-7777-4777-8777-777777777777",
    query: { tab: "members" } as Record<string, string>,
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
    useRoute: () =>
        ({
            name: "workspace-settings",
            path: `/workspace/${routeState.workspaceId}/settings`,
            params: { workspaceId: routeState.workspaceId },
            query: routeState.query,
            hash: "",
            fullPath: `/workspace/${routeState.workspaceId}/settings`,
            matched: [],
            redirectedFrom: undefined,
            meta: {},
        }) as RouteLocationNormalizedLoaded,
    useRouter: () => ({
        push: vi.fn<() => Promise<void>>(),
        replace: vi.fn<() => Promise<void>>(),
    }),
    RouterLink: { template: "<a><slot /></a>" },
}));

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message?: unknown) => string | number>(),
        error: vi.fn<(message?: unknown) => string | number>(),
        warning: vi.fn<(message?: unknown) => string | number>(),
        info: vi.fn<(message?: unknown) => string | number>(),
    },
}));

/** 最小 fetch：工作区 + 成员列表（面板挂载即取，返回空列表即可）。 */
function mockFetch() {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const url = typeof input === "string" ? input : input.url;
        const parsed = new URL(url, "http://localhost");
        if (parsed.pathname.endsWith(`/workspaces/${WORKSPACE_ID}`)) {
            return Promise.resolve(
                new Response(
                    JSON.stringify(
                        makeWorkspace({
                            id: WORKSPACE_ID,
                            name: "Workspace",
                            storageMode: "direct_attach",
                        }),
                    ),
                    { status: 200, headers: { "content-type": "application/json" } },
                ),
            );
        }
        if (parsed.pathname.includes("/members")) {
            return Promise.resolve(
                new Response(JSON.stringify({ items: [] }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
            );
        }
        return Promise.resolve(
            new Response(JSON.stringify({ layered: {}, domains: {} }), {
                status: 200,
                headers: { "content-type": "application/json" },
            }),
        );
    });
}

async function mountView() {
    const WorkspaceSettingsView = (await import("../../workspace/pages/WorkspaceSettingsView.vue"))
        .default;
    return mount(WorkspaceSettingsView, {
        global: {
            plugins: [i18n],
            stubs: { RouterLink: { template: "<a><slot /></a>" } },
        },
        attachTo: document.body,
    });
}

describe("BL-344 能力位三态：未知不销毁成员面板", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        routeState.query = { tab: "members" };
        sessionStorage.clear();
        localStorage.clear();
        vi.restoreAllMocks();
        mockFetch();
    });

    it("未知（工作区未加载）⇒ 成员 tab 可见且面板挂载", async () => {
        const auth = (await import("../../../stores/auth")).useAuthStore();
        expect(auth.workspace).toBeNull();
        expect(auth.canViewMembers).toBeUndefined();

        const wrapper = await mountView();
        await vi.waitFor(() => {
            expect(wrapper.find('[data-testid="ws-settings-members"]').exists()).toBe(true);
        });
        wrapper.unmount();
    });

    it("未知期间重渲染不重建面板（子树状态不被销毁）", async () => {
        const wrapper = await mountView();
        await vi.waitFor(() => {
            expect(wrapper.find('[data-testid="ws-settings-members"]').exists()).toBe(true);
        });

        const panel = wrapper.find('[data-testid="ws-settings-members"]');
        const firstElement = panel.element;
        const auth = (await import("../../../stores/auth")).useAuthStore();
        // 仍然是"未知"（工作区依旧没加载）：不得因此重建子树。
        expect(auth.canViewMembers).toBeUndefined();
        auth.$patch({});
        await wrapper.vm.$nextTick();

        expect(wrapper.find('[data-testid="ws-settings-members"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="ws-settings-members"]').element).toBe(firstElement);
        wrapper.unmount();
    });

    it("确定无权（VIEWER）才回落 general 并卸载面板", async () => {
        const wrapper = await mountView();
        await vi.waitFor(() => {
            expect(wrapper.find('[data-testid="ws-settings-members"]').exists()).toBe(true);
        });

        const auth = (await import("../../../stores/auth")).useAuthStore();
        auth.workspace = {
            id: WORKSPACE_ID,
            name: "Workspace",
            workspaceRole: "VIEWER",
        } as never;
        await wrapper.vm.$nextTick();

        expect(auth.canViewMembers).toBe(false);
        await vi.waitFor(() => {
            expect(wrapper.find('[data-testid="ws-settings-members"]').exists()).toBe(false);
        });
        wrapper.unmount();
    });
});
