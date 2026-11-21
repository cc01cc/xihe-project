import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import SettingsGroupView from "../SettingsGroupView.vue";
import { i18n } from "../../../i18n";

/**
 * task-92 缺口一：**组页**与域页同一套整页草稿离开判据（`SettingsGroupView` 原先裸挂
 * `ConfigLayerPanels`，dirty 广播无人接收 ⇒ 组页改完不保存就切层/切域，草稿静默丢失）。
 *
 * <p>这里只证明**接线**对：dirty-change ⇒ setDrafts、守卫按草稿挂起导航、确认框绑在守卫决策上、
 * 「丢弃」不放保存动作、还原成 count=0 ⇒ 立刻放行不弹。真导航语义由
 * `composables/__tests__/useDraftLeaveGuard.spec.ts`（真 memory router）覆盖。</p>
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

const authState = vi.hoisted(() => ({ readAtom: true, writeAtom: true, status: "ready" }));
vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({
        get canReadInstanceContent() {
            return authState.readAtom;
        },
        get selfPermissionsStatus() {
            return authState.status;
        },
        hasInstanceAtom: (actionClass: string) =>
            actionClass === "WRITE_INSTANCE_CONTENT" ? authState.writeAtom : true,
        ensureSelfPermissions: () => Promise.resolve(true),
    }),
}));

function mountView(options: { attach?: boolean } = {}) {
    return mount(SettingsGroupView, {
        ...(options.attach ? { attachTo: document.body } : {}),
        props: { layer: "instance", groupId: "model-config" },
        global: {
            plugins: [i18n],
            stubs: {
                ConfigLayerPanels: {
                    name: "ConfigLayerPanels",
                    emits: ["dirty-change"],
                    template: '<div data-testid="panels-stub" />',
                },
                LayerPrecedenceBadges: { template: '<div data-testid="badges-stub" />' },
                InstanceReadonlyNotice: { template: '<div data-testid="readonly-stub" />' },
            },
        },
    });
}

function panelsStub(wrapper: ReturnType<typeof mountView>) {
    return wrapper.getComponent({ name: "ConfigLayerPanels" });
}

describe("SettingsGroupView · 整页草稿离开确认（task-92）", () => {
    beforeEach(() => {
        guardHooks.leave.length = 0;
        authState.readAtom = true;
        authState.writeAtom = true;
        authState.status = "ready";
        document.body.innerHTML = "";
    });

    it("无草稿：leave 与 update 两条守卫都注册，导航立即放行且不弹确认框", async () => {
        const wrapper = mountView();
        await flushPromises();
        expect(guardHooks.leave.length, "组页也要注册 leave + update 两条守卫").toBe(2);
        await expect(guardHooks.leave[0]() as Promise<boolean>).resolves.toBe(true);
        await expect(guardHooks.leave[1]() as Promise<boolean>).resolves.toBe(true);
        expect(document.body.querySelector('[data-testid="settings-leave-confirm"]')).toBeNull();
        wrapper.unmount();
    });

    it("有草稿：守卫挂起并弹确认框点名各域，「丢弃并离开」放行", async () => {
        const wrapper = mountView({ attach: true });
        await flushPromises();
        panelsStub(wrapper).vm.$emit("dirty-change", {
            count: 2,
            labels: ["模型配置", "上下文策略"],
        });
        await flushPromises();

        const decision = guardHooks.leave[0]() as Promise<boolean>;
        await flushPromises();
        const dialog = document.body.querySelector('[data-testid="settings-leave-confirm"]');
        expect(dialog, "组页有草稿时必须把确认框挂出来").not.toBeNull();
        expect(dialog?.textContent).toContain("有未保存的改动");
        expect(dialog?.textContent, "确认框要点名是哪几个域").toContain("模型配置");
        expect(dialog?.textContent).toContain("上下文策略");
        expect(
            document.body.querySelectorAll('[data-testid="settings-leave-confirm"]').length,
            "计数 1：一次导航只挂一个确认框（task-98 验收①）",
        ).toBe(1);

        const discard = document.body.querySelector<HTMLElement>(
            '[data-testid="settings-leave-discard"]',
        );
        expect(discard).not.toBeNull();
        discard?.click();
        await flushPromises();
        await expect(decision, "丢弃 = 放行导航").resolves.toBe(true);
        expect(document.body.querySelector('[data-testid="settings-leave-confirm"]')).toBeNull();
        wrapper.unmount();
        document.body.innerHTML = "";
    });

    it("有草稿：「继续编辑」取消这次导航，确认框关闭", async () => {
        const wrapper = mountView({ attach: true });
        await flushPromises();
        panelsStub(wrapper).vm.$emit("dirty-change", { count: 1, labels: ["模型配置"] });
        await flushPromises();

        const decision = guardHooks.leave[1]() as Promise<boolean>;
        await flushPromises();
        const keep = document.body.querySelector<HTMLElement>(
            '[data-testid="settings-leave-keep"]',
        );
        expect(keep).not.toBeNull();
        keep?.click();
        await flushPromises();
        await expect(decision, "继续编辑 = 取消导航").resolves.toBe(false);
        expect(document.body.querySelector('[data-testid="settings-leave-confirm"]')).toBeNull();
        wrapper.unmount();
        document.body.innerHTML = "";
    });

    it("还原草稿（面板广播 count=0）：不弹确认框，导航立即放行", async () => {
        const wrapper = mountView({ attach: true });
        await flushPromises();
        panelsStub(wrapper).vm.$emit("dirty-change", { count: 1, labels: ["模型配置"] });
        await flushPromises();
        panelsStub(wrapper).vm.$emit("dirty-change", { count: 0, labels: [] });
        await flushPromises();

        await expect(guardHooks.leave[0]() as Promise<boolean>).resolves.toBe(true);
        expect(document.body.querySelector('[data-testid="settings-leave-confirm"]')).toBeNull();
        wrapper.unmount();
        document.body.innerHTML = "";
    });
});
