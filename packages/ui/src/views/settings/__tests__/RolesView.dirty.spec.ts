import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import RolesView from "../RolesView.vue";
import { i18n } from "../../../i18n";
import { api } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";

/**
 * task-92 缺口二（页面段）：`RolesView` 两段草稿（用户绑定 / 智能体角色）原先无人拦 —— 改完不保存
 * 就切走，草稿静默丢失。这里钉**接线**：面板广播 dirty ⇒ 守卫拦导航 ⇒ 确认框点名本页；
 * 还原（广播 false）⇒ 不弹。真导航语义由 `useDraftLeaveGuard.spec.ts` 覆盖。
 */
const guardHooks = vi.hoisted(() => ({ leave: [] as Array<() => unknown> }));
vi.mock("vue-router", () => ({
    useRoute: () => ({ query: {} }),
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

const authState = vi.hoisted(() => ({ canManageRoles: true }));
vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({
        ensureSelfPermissions: () => Promise.resolve(true),
        get isAdmin() {
            return false;
        },
        get canManageRoles() {
            return authState.canManageRoles;
        },
        get currentWorkspaceId() {
            return null;
        },
    }),
}));

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            presetsCatalog: vi.fn<typeof apiModule.api.presetsCatalog>(),
            listPresets: vi.fn<typeof apiModule.api.listPresets>(),
            listWorkspaces: vi.fn<typeof apiModule.api.listWorkspaces>(),
        },
    };
});
const mockedApi = vi.mocked(api, true);

function mountView(options: { attach?: boolean } = {}) {
    return mount(RolesView, {
        ...(options.attach ? { attachTo: document.body } : {}),
        global: {
            plugins: [i18n],
            stubs: {
                RoleBindingsPanel: {
                    name: "RoleBindingsPanel",
                    props: ["presets", "workspaces"],
                    emits: ["notice", "dirty"],
                    template: '<div data-testid="role-bindings-stub" />',
                },
                RoleEditorDialog: { template: '<div data-testid="role-editor-stub" />' },
                // retry-key 是**给组件消费的键名**，不该落进 DOM：stub 不关继承会把
                // "settings.errorSurface.refresh" 当属性渲染出来，触发裸键兜底断言（假阳性）。
                SettingsErrorSurface: {
                    name: "SettingsErrorSurface",
                    inheritAttrs: false,
                    props: ["retryKey", "titleKey", "descriptionKey", "error"],
                    template: '<div data-testid="error-surface-stub" />',
                },
            },
        },
    });
}

function panelStub(wrapper: ReturnType<typeof mountView>) {
    return wrapper.getComponent({ name: "RoleBindingsPanel" });
}

async function openBindings(wrapper: ReturnType<typeof mountView>) {
    await wrapper.get('[data-testid="roles-tab-bindings"]').trigger("click");
    await flushPromises();
}

describe("RolesView · 整页草稿离开确认（task-92）", () => {
    beforeEach(() => {
        guardHooks.leave.length = 0;
        authState.canManageRoles = true;
        document.body.innerHTML = "";
        mockedApi.presetsCatalog.mockResolvedValue({ atoms: [] } as never);
        mockedApi.listPresets.mockResolvedValue([]);
        mockedApi.listWorkspaces.mockResolvedValue([]);
    });

    it("无草稿：leave 与 update 两条守卫都注册，导航立即放行", async () => {
        const wrapper = mountView();
        await flushPromises();
        expect(guardHooks.leave.length, "授权预设与绑定页也要注册 leave + update 两条守卫").toBe(2);
        await expect(guardHooks.leave[0]() as Promise<boolean>).resolves.toBe(true);
        expect(document.body.querySelector('[data-testid="settings-leave-confirm"]')).toBeNull();
        wrapper.unmount();
    });

    it("绑定面板有草稿：守卫挂起、确认框点名本页，「丢弃并离开」放行", async () => {
        const wrapper = mountView({ attach: true });
        await flushPromises();
        await openBindings(wrapper);
        panelStub(wrapper).vm.$emit("dirty", true);
        await flushPromises();

        const decision = guardHooks.leave[0]() as Promise<boolean>;
        await flushPromises();
        const dialog = document.body.querySelector('[data-testid="settings-leave-confirm"]');
        expect(dialog, "绑定面板有草稿时必须拦导航").not.toBeNull();
        expect(dialog?.textContent).toContain("有未保存的改动");
        expect(dialog?.textContent, "确认框要能说出是哪个面").toContain(
            i18n.global.t("settings.presetsTitle"),
        );

        document.body.querySelector<HTMLElement>('[data-testid="settings-leave-discard"]')?.click();
        await flushPromises();
        await expect(decision, "丢弃 = 放行导航").resolves.toBe(true);
        wrapper.unmount();
        document.body.innerHTML = "";
    });

    it("「继续编辑」取消这次导航", async () => {
        const wrapper = mountView({ attach: true });
        await flushPromises();
        await openBindings(wrapper);
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
        await openBindings(wrapper);
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
