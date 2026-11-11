/**
 * PLAN-0762 T3.1 回归契约 —— (A) 方案：复用 `Sidebar` 组件族、**手工 provide context**、
 * **不注册第二个 `SidebarProvider`**（用户 2026-11-11 裁定；spike 读数与依据见
 * `internal/A03-xihe/evidence/2026-11-11-t31-spike/README.md`）。
 *
 * <p>本文件是 (A) 唯一的机制级回归保护（产品侧消费者 = `settings/SettingsSidebar.vue`，
 * 它自己**不**断言这些旁路，只看结构）。四条锁：</p>
 *  ① `Sidebar` 的 context 注入是**硬依赖**（reka `createContext` 无 fallback）⇒ 不 provide 必抛；
 *  ② 手工子树**不监听** ⌘/Ctrl+B（provider 子树照常响应，两者不串台）；
 *  ③ 手工子树**不写** `sidebar_state` cookie（单键写手只有 provider）；
 *  ④ `--sidebar-width` 由调用方注入，`Sidebar` 只按变量取宽；`SidebarMenuButton[tooltip]`
 *     需要自包 `TooltipProvider`（原本 provider 替我们包）。
 *
 * <p>为什么用 harness 而不是直接挂产品组件：这四条问的是「vendor 组件族 + 手工 context」这条
 * 路本身还成不成立，与设置区 IA 无关。产品结构由 `SettingsSidebar.spec.ts` 另测。</p>
 *
 * <p>vendor 升级时：先跑本文件，再按 spike 文档「vendor 升级耦合点」五处 grep。</p>
 */
import { beforeEach, describe, expect, it } from "vitest";
import { computed, defineComponent, h, nextTick, ref } from "vue";
import { mount } from "@vue/test-utils";
import { provideSidebarContext } from "@/components/ui/sidebar/utils";
import Sidebar from "@/components/ui/sidebar/Sidebar.vue";
import SidebarMenuButton from "@/components/ui/sidebar/SidebarMenuButton.vue";
import SidebarProvider from "@/components/ui/sidebar/SidebarProvider.vue";
import { TooltipProvider } from "@/components/ui/tooltip";

const KEYDOWN = () =>
    new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true });

function clearCookies() {
    for (const part of document.cookie.split(";")) {
        const name = part.split("=")[0]?.trim();
        if (name) document.cookie = `${name}=; path=/; max-age=0`;
    }
}

/** 手工 context 子树：`open` 由调用方持有（产品里 = 全局布局键的 `navOpen`）。 */
function manualHarness(opts: { tooltipProvider?: boolean; tooltip?: boolean } = {}) {
    const open = ref(true);
    const setOpenCalls: boolean[] = [];
    const isMobile = ref(false);
    const openMobile = ref(false);

    const Host = defineComponent({
        setup() {
            provideSidebarContext({
                state: computed(() => (open.value ? "expanded" : "collapsed")),
                open,
                setOpen: (value: boolean) => {
                    open.value = value;
                    setOpenCalls.push(value);
                },
                isMobile,
                openMobile,
                setOpenMobile: (value: boolean) => {
                    openMobile.value = value;
                },
                toggleSidebar: () => {
                    open.value = !open.value;
                    setOpenCalls.push(open.value);
                },
            });

            const content = () =>
                h(
                    Sidebar,
                    {},
                    {
                        default: () =>
                            h(
                                SidebarMenuButton,
                                opts.tooltip === false ? {} : { tooltip: "设置" },
                                { default: () => "NavItem" },
                            ),
                    },
                );

            // 调用方注入宽度变量（产品里 = SettingsLayout 的 `--sidebar-width`）
            return () =>
                h(
                    "div",
                    { style: "--sidebar-width: 280px" },
                    opts.tooltipProvider
                        ? [h(TooltipProvider, { delayDuration: 0 }, { default: content })]
                        : [content()],
                );
        },
    });

    return { Host, open, setOpenCalls };
}

/** 复刻 GlobalRail 形态：真 provider 子树（⌘B / cookie / 16rem 都由它提供）。 */
function providerHarness() {
    const Host = defineComponent({
        setup() {
            return () =>
                h(
                    SidebarProvider,
                    { defaultOpen: true },
                    {
                        default: () => h(Sidebar, {}, { default: () => h("span", "rail") }),
                    },
                );
        },
    });
    return { Host };
}

const sidebarOf = (wrapper: ReturnType<typeof mount>): HTMLElement =>
    wrapper.find('[data-slot="sidebar"]').element as HTMLElement;

describe("(A) Sidebar 组件族 + 手工 provideSidebarContext（不挂 provider）", () => {
    beforeEach(() => {
        clearCookies();
    });

    it("Q1 手工 provide 后 Sidebar 挂载，data-state 随调用方 open 切换", async () => {
        const { Host, open } = manualHarness({ tooltip: false });
        const wrapper = mount(Host);

        expect(wrapper.find('[data-slot="sidebar"]').exists()).toBe(true);
        expect(sidebarOf(wrapper).dataset.state).toBe("expanded");
        // Sidebar.vue:61 —— data-collapsible 只在 collapsed 时等于 collapsible，expanded 为 ""
        expect(sidebarOf(wrapper).dataset.collapsible).toBe("");

        open.value = false; // = 产品的 navOpen=false
        await nextTick();
        expect(sidebarOf(wrapper).dataset.state).toBe("collapsed");
        expect(sidebarOf(wrapper).dataset.collapsible).toBe("offcanvas");

        open.value = true;
        await nextTick();
        expect(sidebarOf(wrapper).dataset.state).toBe("expanded");
    });

    it("Q1 反证：没有 provide 时 Sidebar 直接抛错（注入是硬依赖，不是可选）", () => {
        const Bare = defineComponent({
            setup: () => () => h(Sidebar, {}, { default: () => h("span", "x") }),
        });
        expect(() => mount(Bare)).toThrow(/Injection .*not found/);
    });

    it("Q2 不带 provider ⇒ ⌘B 对本子树无效（无监听）；同级 provider 子树仍响应", async () => {
        const manual = manualHarness({ tooltip: false });
        const manualWrapper = mount(manual.Host);
        expect(sidebarOf(manualWrapper).dataset.state).toBe("expanded");

        document.dispatchEvent(KEYDOWN());
        await nextTick();
        expect(sidebarOf(manualWrapper).dataset.state).toBe("expanded");
        expect(manual.setOpenCalls).toEqual([]);

        // 同一 document 上再挂一个 provider 子树（GlobalRail 形态）
        const provider = providerHarness();
        const providerWrapper = mount(provider.Host);
        expect(sidebarOf(providerWrapper).dataset.state).toBe("expanded");

        document.dispatchEvent(KEYDOWN());
        await nextTick();
        expect(sidebarOf(providerWrapper).dataset.state).toBe("collapsed");
        // 关键：provider 的 ⌘B 不会串到手工子树
        expect(sidebarOf(manualWrapper).dataset.state).toBe("expanded");
        expect(manual.setOpenCalls).toEqual([]);
    });

    it("Q3a 手工子树不写 sidebar_state cookie；provider 子树会写（对照）", async () => {
        const before = document.cookie;
        expect(before).not.toContain("sidebar_state");

        const manual = manualHarness({ tooltip: false });
        const manualWrapper = mount(manual.Host);
        manual.open.value = false;
        await nextTick();
        expect(document.cookie).toBe(before);
        expect(document.cookie).not.toContain("sidebar_state");

        const provider = providerHarness();
        mount(provider.Host);
        document.dispatchEvent(KEYDOWN());
        await nextTick();
        expect(document.cookie).toContain("sidebar_state=false");
        expect(sidebarOf(manualWrapper).dataset.state).toBe("collapsed");
    });

    it("Q3b 宽度来自调用方注入的 --sidebar-width，不是 16rem 常量", () => {
        const { Host } = manualHarness({ tooltip: false });
        const wrapper = mount(Host);
        const root = wrapper.element as HTMLElement;

        expect(root.style.getPropertyValue("--sidebar-width")).toBe("280px");
        expect(wrapper.html()).not.toContain("16rem");
        // Sidebar 只按变量取宽（w-(--sidebar-width)），组件内不写字面量宽度
        expect(wrapper.html()).toContain("w-(--sidebar-width)");

        // 对照：真 provider 会把 --sidebar-width 写死 16rem（我们不想要的那层）
        expect(mount(providerHarness().Host).html()).toContain("--sidebar-width: 16rem");
    });

    it("Q3c tooltip 需要自己包 TooltipProvider（provider 原本替我们包）", () => {
        // 无 TooltipProvider ⇒ reka TooltipRoot 注入失败，挂载抛错
        expect(() => mount(manualHarness({ tooltip: true }).Host)).toThrow(
            /Injection .*TooltipProvider.*not found/,
        );

        // 自己包一层即可正常挂载
        const wrapper = mount(manualHarness({ tooltip: true, tooltipProvider: true }).Host);
        expect(wrapper.find('[data-slot="sidebar"]').exists()).toBe(true);
        expect(wrapper.text()).toContain("NavItem");
    });
});
