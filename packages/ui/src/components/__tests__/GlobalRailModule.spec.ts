import { describe, expect, it } from "vitest";
import { computed, defineComponent, h, ref } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { provideSidebarContext } from "../ui/sidebar/utils";
import GlobalRailModule from "../sidebar/GlobalRailModule.vue";
import { globalModule } from "../../lib/globalModules";
// 菜单项的 labelKey 来自 SSOT（`settingsIa` 的资源矩阵）⇒ 必须用**真 locale**，
// 局部 messages 夹具会漏掉一半键、让渲染结果里出现裸键（task-93/task-105 的探针就是这么抓的）。
import { i18n } from "../../i18n";

/**
 * task-259：**折叠态指针不再打开二级菜单**（回退 `83b4fd213`），菜单本体与点击/键盘通道保留。
 *
 * <p>为什么分两层判据：<b>组件层</b>证明「指针没有被接进打开通道」（`pointerenter` 不产生
 * `update:open`），<b>e2e 层</b>（`e2e/mock/global-rail-dual-state.spec.ts`）证明真实指针停 900ms
 * 菜单不出现。组件层能抓「有人把 handler 加回来」，抓不到浏览器合成事件的实际时序；e2e 反之。
 * 两层缺一层就会出现「删了菜单却说是删了通道」这类误判。</p>
 *
 * <p>顺带钉住<b>正例</b>（chevron 点击仍能开）：只删不验会把「删掉一条通道」做成「删掉整个菜单」，
 * 而后者不是本卡要的（`D-896 ③` 的可达性要求 —— 点击与键盘必须同样能开 —— 仍然成立）。</p>
 *
 * <p>挂载壳的由来：`SidebarMenuButton` 在 setup 里直接 `useSidebar()`（reka `createContext`
 * 无 fallback）⇒ 单独挂载必须自带 context，产品里由 `GlobalRail` 的 `SidebarProvider` 提供。
 * 这里复刻最小壳（同 `SettingsResourceNav.spec.ts` 的手法），**不挂第二个 `SidebarProvider`**
 * —— 它自带 document 级 ⌘B 监听与 `16rem` 宽度副作用。</p>
 */
const resources = globalModule("resources");

function mountModule(open = false) {
    const Host = defineComponent({
        setup() {
            const sidebarOpen = ref(false);
            provideSidebarContext({
                state: computed(() => (sidebarOpen.value ? "expanded" : "collapsed")),
                open: sidebarOpen,
                setOpen: (value: boolean) => {
                    sidebarOpen.value = value;
                },
                isMobile: ref(false),
                openMobile: ref(false),
                setOpenMobile: () => {},
                toggleSidebar: () => {
                    sidebarOpen.value = !sidebarOpen.value;
                },
            });
            return () =>
                h(GlobalRailModule, {
                    module: resources,
                    open,
                    activePath: "/resources/credentials",
                    active: true,
                });
        },
    });
    return mount(Host, { global: { plugins: [i18n] }, attachTo: document.body });
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
});

describe("GlobalRailModule（task-259 回退 D-899）", () => {
    it("折叠态指针进入/离开都不打开菜单（悬浮通道已删）", async () => {
        const wrapper = mountModule();
        await flushPromises();
        const row = wrapper.get(".relative");
        const trigger = wrapper.get('[data-testid="global-rail-menu-resources"]');
        await row.trigger("pointerenter");
        await row.trigger("pointerover");
        await trigger.trigger("pointerenter");
        await row.trigger("pointerleave");
        await flushPromises();
        // 判据是**没有发出任何打开请求**（emit 计数 0），不是「菜单没渲染」——
        // 后者在受控组件里恒成立（open 由 props 决定），拿它当断言等于什么都没验。
        expect(wrapper.findComponent(GlobalRailModule).emitted("update:open")).toBeUndefined();
        // 悬浮也不改变可访问性状态（`aria-expanded` 仍由 open prop 决定）。
        expect(trigger.attributes("aria-expanded")).toBe("false");
        wrapper.unmount();
    });

    it("正例：点 chevron 发出 update:open(true)（菜单本体与可点击通道保留）", async () => {
        const wrapper = mountModule();
        await flushPromises();
        const trigger = wrapper.get('[data-testid="global-rail-menu-resources"]');
        // 触发器是原生 <button>：Tab 可达、Enter/Space 可开由它保证（无需额外 keydown 绑定）。
        expect(trigger.element.tagName).toBe("BUTTON");
        await trigger.trigger("click");
        await flushPromises();
        expect(wrapper.findComponent(GlobalRailModule).emitted("update:open")?.at(-1)).toEqual([
            true,
        ]);
        wrapper.unmount();
    });

    it("正例：open=true 时菜单内容挂载，菜单项来自 SSOT 投影（资源 5 项）", async () => {
        const wrapper = mountModule(true);
        await flushPromises();
        const menu = wrapper.get('[data-testid="global-rail-menu-content-resources"]');
        expect(menu.text()).toContain("凭据");
        expect(menu.findAll("[data-testid^='global-rail-menu-item-resources-']")).toHaveLength(5);
        wrapper.unmount();
    });

    it("折叠态触发器用 sr-only 视觉让位，但不排除出可达性树（键盘仍能开）", async () => {
        const wrapper = mountModule();
        const trigger = wrapper.get('[data-testid="global-rail-menu-resources"]');
        expect(trigger.classes().join(" ")).toContain("group-data-[collapsible=icon]:sr-only");
        // 排除出可达性树靠的是 aria-hidden / disabled / tabindex=-1 —— 三者都不得出现。
        expect(trigger.attributes("aria-hidden")).toBeUndefined();
        expect(trigger.attributes("disabled")).toBeUndefined();
        expect(trigger.attributes("tabindex")).toBeUndefined();
        expect(trigger.attributes("aria-label")).toBe("打开模块页面菜单");
        wrapper.unmount();
    });
});
