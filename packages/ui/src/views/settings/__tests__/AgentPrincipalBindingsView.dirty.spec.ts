import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import AgentPrincipalBindingsView from "../AgentPrincipalBindingsView.vue";
import { i18n } from "../../../i18n";
import { api } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";

/**
 * task-92 缺口二（页面段）：主体「工作区绑定」整页原先没有离开守卫 —— 勾了若干工作区不保存就切走，
 * 勾选静默丢失。这里钉**接线**：面板广播 dirty ⇒ 守卫拦导航 ⇒ 确认框点名当前主体；
 * 广播 false（勾回原值 / 保存成功）⇒ 不弹。真导航语义由 `useDraftLeaveGuard.spec.ts` 覆盖。
 */
const guardHooks = vi.hoisted(() => ({ leave: [] as Array<() => unknown> }));
vi.mock("vue-router", () => ({
    useRoute: () => ({ params: { id: "p-1" }, query: {} }),
    useRouter: () => ({
        replace: vi.fn<() => Promise<void>>(() => Promise.resolve()),
        push: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    }),
    onBeforeRouteLeave: (guard: () => unknown) => {
        guardHooks.leave.push(guard);
    },
    onBeforeRouteUpdate: (guard: () => unknown) => {
        guardHooks.leave.push(guard);
    },
}));

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listAgentPrincipals: vi.fn<typeof apiModule.api.listAgentPrincipals>(),
        },
    };
});
const mockedApi = vi.mocked(api, true);

function mountView(options: { attach?: boolean } = {}) {
    return mount(AgentPrincipalBindingsView, {
        ...(options.attach ? { attachTo: document.body } : {}),
        props: { id: "p-1" },
        global: {
            plugins: [i18n],
            stubs: {
                AgentWorkspaceBindingsPanel: {
                    name: "AgentWorkspaceBindingsPanel",
                    props: ["principalId"],
                    emits: ["bound-workspaces", "dirty"],
                    template: '<div data-testid="bindings-panel-stub" />',
                },
                AgentDelegatedSessionsTable: {
                    name: "AgentDelegatedSessionsTable",
                    props: ["principalId", "workspaces"],
                    template: '<div data-testid="delegated-sessions-stub" />',
                },
            },
        },
    });
}

function panelStub(wrapper: ReturnType<typeof mountView>) {
    return wrapper.getComponent({ name: "AgentWorkspaceBindingsPanel" });
}

describe("AgentPrincipalBindingsView · 整页草稿离开确认（task-92）", () => {
    beforeEach(() => {
        guardHooks.leave.length = 0;
        document.body.innerHTML = "";
        mockedApi.listAgentPrincipals.mockResolvedValue([
            { principalId: "p-1", name: "Coder" } as never,
        ]);
    });

    it("无草稿：leave 与 update 两条守卫都注册，导航立即放行", async () => {
        const wrapper = mountView();
        await flushPromises();
        expect(guardHooks.leave.length, "绑定整页也要注册 leave + update 两条守卫").toBe(2);
        await expect(guardHooks.leave[0]() as Promise<boolean>).resolves.toBe(true);
        expect(document.body.querySelector('[data-testid="settings-leave-confirm"]')).toBeNull();
        wrapper.unmount();
    });

    it("面板有勾选草稿：守卫挂起、确认框点名当前主体，「丢弃并离开」放行", async () => {
        const wrapper = mountView({ attach: true });
        await flushPromises();
        panelStub(wrapper).vm.$emit("dirty", true);
        await flushPromises();

        const decision = guardHooks.leave[0]() as Promise<boolean>;
        await flushPromises();
        const dialog = document.body.querySelector('[data-testid="settings-leave-confirm"]');
        expect(dialog, "有勾选草稿时必须拦导航").not.toBeNull();
        expect(dialog?.textContent).toContain("有未保存的改动");
        expect(dialog?.textContent, "确认框要能说出是哪个主体").toContain("Coder");

        document.body.querySelector<HTMLElement>('[data-testid="settings-leave-discard"]')?.click();
        await flushPromises();
        await expect(decision, "丢弃 = 放行导航").resolves.toBe(true);
        wrapper.unmount();
        document.body.innerHTML = "";
    });

    it("「继续编辑」取消这次导航", async () => {
        const wrapper = mountView({ attach: true });
        await flushPromises();
        panelStub(wrapper).vm.$emit("dirty", true);
        await flushPromises();

        const decision = guardHooks.leave[1]() as Promise<boolean>;
        await flushPromises();
        document.body.querySelector<HTMLElement>('[data-testid="settings-leave-keep"]')?.click();
        await flushPromises();
        await expect(decision, "继续编辑 = 取消导航").resolves.toBe(false);
        wrapper.unmount();
        document.body.innerHTML = "";
    });

    it("草稿还原（面板广播 false）⇒ 不弹，导航立即放行", async () => {
        const wrapper = mountView({ attach: true });
        await flushPromises();
        panelStub(wrapper).vm.$emit("dirty", true);
        await flushPromises();
        panelStub(wrapper).vm.$emit("dirty", false);
        await flushPromises();

        await expect(guardHooks.leave[0]() as Promise<boolean>).resolves.toBe(true);
        expect(document.body.querySelector('[data-testid="settings-leave-confirm"]')).toBeNull();
        wrapper.unmount();
        document.body.innerHTML = "";
    });
});
