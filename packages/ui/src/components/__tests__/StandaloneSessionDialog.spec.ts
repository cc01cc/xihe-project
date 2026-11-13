import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import type { toast as sonnerToast } from "vue-sonner";
import { i18n } from "../../i18n";
import { api } from "../../composables/api";
import { useSessionStore } from "../../stores/session";
import StandaloneSessionDialog from "../sidebar/StandaloneSessionDialog.vue";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn<typeof sonnerToast.error>() }));
vi.mock("vue-sonner", () => ({ toast: { error: toastError } }));

/**
 * task-373：新建独立会话必须显式带 agentPrincipalId（CP 缺它 400），候选来自**个人**视图。
 * 三态各有出口：0 ⇒ 去创建智能体；1 ⇒ 不打断；多 ⇒ 选一个。失败保留弹窗。
 */
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function principal(id: string, name: string, disabled = false) {
    return {
        principalId: id,
        name,
        templateId: null,
        templateName: null,
        createdAt: "2026-11-14T00:00:00Z",
        disabled,
    };
}

function createdRow() {
    return {
        id: SESSION_ID,
        title: "New Chat",
        workspaceId: null,
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
    toastError.mockClear();
    router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: "/:pathMatch(.*)*", component: { setup: () => () => null } }],
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

async function mountDialog() {
    await router.push("/workspace");
    await router.isReady();
    const wrapper = mount(StandaloneSessionDialog, {
        props: { show: true },
        global: { plugins: [i18n, router], stubs: { Teleport: true } },
    });
    await flushPromises();
    return wrapper;
}

describe("StandaloneSessionDialog (task-373)", () => {
    it("offers a way out when the account has no personal agent", async () => {
        vi.spyOn(api, "listMyAgentPrincipals").mockResolvedValue([] as never);
        const create = vi.spyOn(api, "createStandaloneSession");
        const wrapper = await mountDialog();

        expect(wrapper.find('[data-testid="standalone-dialog-empty"]').exists()).toBe(true);
        expect(create).not.toHaveBeenCalled();
        await wrapper.get('[data-testid="standalone-dialog-create-agent"]').trigger("click");
        await flushPromises();
        expect(router.currentRoute.value.path).toBe("/resources/agents");
        expect(wrapper.emitted("close")).toHaveLength(1);
        wrapper.unmount();
    });

    it("creates immediately when there is exactly one usable personal agent", async () => {
        vi.spyOn(api, "listMyAgentPrincipals").mockResolvedValue([
            principal("p-1", "唯一智能体"),
            principal("p-2", "已停用", true),
        ] as never);
        const create = vi
            .spyOn(api, "createStandaloneSession")
            .mockResolvedValue(createdRow() as never);
        const wrapper = await mountDialog();

        expect(create).toHaveBeenCalledWith("p-1");
        expect(wrapper.emitted("created")?.[0]).toEqual([SESSION_ID]);
        expect(wrapper.emitted("close")).toHaveLength(1);
        expect(useSessionStore().workspacelessSessions.map((item) => item.id)).toEqual([
            SESSION_ID,
        ]);
        wrapper.unmount();
    });

    it("asks which agent when there are several, and only creates after confirmation", async () => {
        vi.spyOn(api, "listMyAgentPrincipals").mockResolvedValue([
            principal("p-1", "甲"),
            principal("p-2", "乙"),
        ] as never);
        const create = vi
            .spyOn(api, "createStandaloneSession")
            .mockResolvedValue(createdRow() as never);
        const wrapper = await mountDialog();

        expect(create).not.toHaveBeenCalled();
        expect(wrapper.find('[data-testid="standalone-dialog-agent-p-2"]').exists()).toBe(true);
        await wrapper.get('[data-testid="standalone-dialog-agent-p-2"]').trigger("click");
        await wrapper.get('[data-testid="standalone-dialog-confirm"]').trigger("click");
        await flushPromises();
        expect(create).toHaveBeenCalledWith("p-2");
        wrapper.unmount();
    });

    it("keeps the dialog open and reports the failure when creation fails", async () => {
        vi.spyOn(api, "listMyAgentPrincipals").mockResolvedValue([
            principal("p-1", "甲"),
            principal("p-2", "乙"),
        ] as never);
        vi.spyOn(api, "createStandaloneSession").mockRejectedValue(new Error("nope"));
        const wrapper = await mountDialog();

        await wrapper.get('[data-testid="standalone-dialog-agent-p-1"]').trigger("click");
        await wrapper.get('[data-testid="standalone-dialog-confirm"]').trigger("click");
        await flushPromises();

        expect(toastError).toHaveBeenCalledTimes(1);
        expect(wrapper.emitted("close")).toBeUndefined();
        expect(wrapper.find('[data-testid="standalone-dialog-confirm"]').exists()).toBe(true);
        wrapper.unmount();
    });
});
