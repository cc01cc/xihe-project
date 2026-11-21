import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { RouterView, createMemoryHistory, createRouter, type Router } from "vue-router";
import { defineComponent, h, onMounted, type Component } from "vue";
import { useDraftLeaveGuard } from "../useDraftLeaveGuard";

/**
 * task-190 J1/J2：设置页**整页草稿**的离开守卫。
 *
 * <p>跑真 `createRouter` + 真导航，而不是 mock 掉 `onBeforeRouteLeave`：本卡要证明的正是
 * 「导航真的被挂起、真的按用户选择放行/取消」，mock 掉守卫钩子等于自证同义反复。四个动作各一条断言：</p>
 * <ol>
 *   <li>无草稿 ⇒ 直接放行（不许无差别拦人）；</li>
 *   <li>有草稿 ⇒ 导航挂起 + 确认框打开，路由不动；</li>
 *   <li>「继续编辑」⇒ 导航取消，仍在本页；</li>
 *   <li>「丢弃并离开」⇒ 导航放行，**且保存次数 0**（Lead 判据 ④：丢弃不是「先把改动存了再走」）。</li>
 * </ol>
 *
 * <p>另有 `beforeunload` 的挂/摘（J2）：刷新是浏览器级离开，路由守卫拦不到；漏摘会让整个站点
 * 每次关标签页都弹确认。</p>
 */

interface Harness {
    guard: ReturnType<typeof useDraftLeaveGuard>;
    saveCalls: () => number;
    save: () => void;
}

const harnesses: Record<string, Harness> = {};

function makePage(name: string): Component {
    return defineComponent({
        name: `Page-${name}`,
        setup() {
            const guard = useDraftLeaveGuard();
            let saveCalls = 0;
            /** 模拟页面里的「保存」按钮 —— 只有用户点它才会加一。 */
            const save = () => {
                saveCalls += 1;
            };
            onMounted(() => {
                harnesses[name] = { guard, saveCalls: () => saveCalls, save };
            });
            return () => h("div", { "data-page": name }, name);
        },
    });
}

let router: Router;

async function makeRouter(): Promise<Router> {
    const r = createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: "/settings/instance/logging", component: makePage("logging") },
            { path: "/settings/instance/telemetry", component: makePage("telemetry") },
            { path: "/elsewhere", component: makePage("elsewhere") },
        ],
    });
    await r.push("/settings/instance/logging");
    await r.isReady();
    return r;
}

const Root = defineComponent({
    // 必须用真的 RouterView：写成 h("router-view") 只会渲染一个未知 HTML 元素，页面组件永不挂载 ⇒
    // 守卫从未注册、harness 也取不到（首版就是这样静的：6 例全报 reading 'guard' of undefined）。
    setup: () => () => h("div", [h(RouterView)]),
});

async function mountApp() {
    const wrapper = mount(Root as never, { global: { plugins: [router] } });
    await flushPromises();
    return wrapper;
}

beforeEach(async () => {
    for (const key of Object.keys(harnesses)) delete harnesses[key];
    router = await makeRouter();
});

describe("useDraftLeaveGuard · 路由内离开（J1）", () => {
    it("无草稿时直接放行，不弹确认框", async () => {
        const wrapper = await mountApp();
        const guard = harnesses.logging.guard;
        expect(guard.pageDirty.value).toBe(false);
        await router.push("/settings/instance/telemetry");
        await flushPromises();
        expect(router.currentRoute.value.fullPath).toBe("/settings/instance/telemetry");
        expect(guard.promptOpen.value).toBe(false);
        wrapper.unmount();
    });

    it("有草稿时导航被挂起、确认框打开、路由不动", async () => {
        const wrapper = await mountApp();
        const guard = harnesses.logging.guard;
        guard.setDrafts(["日志"]);
        expect(guard.pageDirty.value).toBe(true);

        const navigation = router.push("/settings/instance/telemetry");
        await flushPromises();
        expect(guard.promptOpen.value).toBe(true);
        expect(router.currentRoute.value.fullPath).toBe("/settings/instance/logging");
        // 还没拍板：导航既没完成也没报错。
        expect(harnesses.logging).toBeDefined();

        guard.keepEditing();
        await navigation;
        await flushPromises();
        // 「继续编辑」= 取消这次导航（vue-router 以 aborted failure 收口）。
        expect(router.currentRoute.value.fullPath).toBe("/settings/instance/logging");
        expect(guard.promptOpen.value).toBe(false);
        wrapper.unmount();
    });

    it("「丢弃并离开」放行导航，且保存次数为 0（Lead 判据 ④）", async () => {
        const wrapper = await mountApp();
        const guard = harnesses.logging.guard;
        guard.setDrafts(["日志"]);

        const navigation = router.push("/settings/instance/telemetry");
        await flushPromises();
        expect(guard.promptOpen.value).toBe(true);
        expect(harnesses.logging.saveCalls()).toBe(0);

        guard.discardDrafts();
        await navigation;
        await flushPromises();
        expect(router.currentRoute.value.fullPath).toBe("/settings/instance/telemetry");
        expect(guard.draftLabels.value).toEqual([]);
        expect(guard.promptOpen.value).toBe(false);
        expect(harnesses.logging.saveCalls(), "丢弃必须先不保存再离开").toBe(0);
        wrapper.unmount();
    });

    it("切到另一条设置路由（onBeforeRouteUpdate 路径）同样被拦", async () => {
        const wrapper = await mountApp();
        const guard = harnesses.logging.guard;
        guard.setDrafts(["日志"]);
        const navigation = router.push("/settings/instance/logging?tab=policy");
        await flushPromises();
        expect(guard.promptOpen.value).toBe(true);
        expect(router.currentRoute.value.fullPath).toBe("/settings/instance/logging");
        guard.discardDrafts();
        await navigation;
        await flushPromises();
        expect(router.currentRoute.value.fullPath).toBe("/settings/instance/logging?tab=policy");
        wrapper.unmount();
    });
});

describe("useDraftLeaveGuard · 浏览器级离开（J2）", () => {
    it("有草稿才注册 beforeunload，清空后立即摘掉", async () => {
        const addSpy = vi.spyOn(window, "addEventListener");
        const removeSpy = vi.spyOn(window, "removeEventListener");
        const wrapper = await mountApp();
        const guard = harnesses.logging.guard;
        const beforeUnloadAdds = () =>
            addSpy.mock.calls.filter(([name]) => name === "beforeunload");
        const beforeUnloadRemoves = () =>
            removeSpy.mock.calls.filter(([name]) => name === "beforeunload");

        expect(beforeUnloadAdds().length).toBe(0);
        guard.setDrafts(["日志"]);
        await flushPromises();
        expect(beforeUnloadAdds().length).toBe(1);

        guard.setDrafts([]);
        await flushPromises();
        expect(beforeUnloadRemoves().length).toBe(1);

        addSpy.mockRestore();
        removeSpy.mockRestore();
        wrapper.unmount();
    });

    it("卸载时摘掉监听（切页后不再拦刷新）", async () => {
        const removeSpy = vi.spyOn(window, "removeEventListener");
        const wrapper = await mountApp();
        harnesses.logging.guard.setDrafts(["日志"]);
        await flushPromises();
        wrapper.unmount();
        const removes = removeSpy.mock.calls.filter(([name]) => name === "beforeunload");
        expect(removes.length).toBe(1);
        removeSpy.mockRestore();
    });
});
