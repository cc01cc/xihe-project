import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import type { Router } from "vue-router";
import GlobalRail from "../sidebar/GlobalRail.vue";
import { useAuthStore } from "../../stores/auth";
import { defaultLayerPath, defaultResourcePath } from "../../lib/settingsIa";

const messages = {
    "zh-CN": {
        sidebar: {
            workbench: "工作台",
            // PLAN-0772 M2：全局条第三个入口（资源模块）。
            resources: "资源",
            settings: "设置",
            logout: "退出登录",
            admin: "管理",
            toggle: "切换侧边栏",
            // task-214：footer 顺序断言要读 `global-rail-toggle` 的 aria-label（随态变化）。
            collapse: "收起侧边栏",
            expand: "展开侧边栏",
            // 夹具补齐（本条与本卡改动无关的存量缺口）：`GlobalRailModule` 用到
            // `sidebar.moduleMenu`，而本夹具的 messages 没这条 ⇒ 该文件在 HEAD 上就红
            // （"渲染结果里出现裸 i18n 键"）。补键不改判据、不放宽断言。
            moduleMenu: "打开模块页面菜单",
            // 夹具补齐（task-259 顺带；与本次回退无关的存量缺口）：`GLOBAL_MODULES` 自
            // `dc3603db6`（组织成员页）起多了一个 `org-members` 模块，其 labelKey 是
            // `sidebar.orgMembers`，而本夹具没这条 ⇒ 本文件在 HEAD 上就红（渲染结果里出现裸键）。
            // 补键不放宽任何断言。
            orgMembers: "组织成员",
        },
    },
};

const { pushSpy, routeState } = vi.hoisted(() => ({
    pushSpy: vi.fn<Router["push"]>(),
    routeState: {
        params: {} as Record<string, string>,
        name: "workspace",
        path: "/workspace/ws-1",
    },
}));

vi.mock("vue-router", () => ({
    createRouter: () => ({
        push: vi.fn<() => void>(),
        replace: vi.fn<() => void>(),
        beforeEach: vi.fn<() => void>(),
        afterEach: vi.fn<() => void>(),
        isReady: () => Promise.resolve(),
        currentRoute: { value: {} },
    }),
    createWebHistory: () => ({}),
    useRouter: () => ({ push: pushSpy }),
    useRoute: () => routeState,
}));

const i18n = createI18n({
    legacy: false,
    locale: "zh-CN",
    fallbackLocale: "zh-CN",
    messages,
});

function patchAuth(isInstanceAdmin = false) {
    const auth = useAuthStore();
    auth.$patch({
        token: "token",
        user: {
            id: "u-1",
            email: "tester@xihe.local",
            capabilities: {
                isInstanceAdmin,
                isInstanceSuper: false,
                workspaceAdminOf: [],
            },
        },
    });
    return auth;
}

async function mountRail(): Promise<ReturnType<typeof mount>> {
    const wrapper = mount(GlobalRail, { global: { plugins: [i18n] } });
    await flushPromises();
    return wrapper;
}

/**
 * 双态在 vendored Sidebar 里由**外层**记（[data-slot=sidebar] 的 data-state）；
 * data-testid 通过 $attrs 落在外层里面的 sidebar-container 上。所以要从 testid 元素
 * 向祖先方向取状态，而不是直接取属性。
 */
function railState(wrapper: ReturnType<typeof mount>): string | null {
    const rail = wrapper.get('[data-testid="global-rail"]').element as HTMLElement;
    return rail.closest('[data-slot="sidebar"]')?.getAttribute("data-state") ?? null;
}

/**
 * footer 里**三个相关控件**的 DOM 顺序（task-214）。只取这三个 id 而不是整个
 * `[data-testid]` 列表：`GlobalRailModule` 内部还渲染了自己的 testid
 * （`global-rail-menu-settings`），把它算进来会让断言在「模块内部结构变了」时假红 ——
 * 本卡要证明的是**这三者的先后**，不是 footer 里恰好只有三项。
 */
const FOOTER_ACTION_IDS = [
    "global-rail-module-settings",
    "global-rail-logout",
    "global-rail-toggle",
] as const;

function footerActionOrder(wrapper: ReturnType<typeof mount>): string[] {
    const footer = wrapper.get('[data-testid="global-rail"] [data-slot="sidebar-footer"]');
    const ids = footer.findAll("[data-testid]").map((node) => node.attributes("data-testid") ?? "");
    return ids.filter((id) => (FOOTER_ACTION_IDS as readonly string[]).includes(id));
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    pushSpy.mockClear();
    routeState.name = "workspace";
    routeState.path = "/workspace/ws-1";
});

describe("GlobalRail (PLAN-0762 T2.1/T2.3/T2.4)", () => {
    it("主区 = 工作台 → 资源；footer = 设置 → 登出（D-933 + PLAN-0772 第三入口）", async () => {
        patchAuth(true); // 即便管理员：D-933 —— 管理按钮已直接移除，不设替代入口。
        const wrapper = await mountRail();
        expect(wrapper.get('[data-testid="global-rail"]').exists()).toBe(true);
        // PLAN-0772 M2 起主区**不再只有工作台**：资源是第三个顶层入口。
        // （本用例原名为 "workbench only in the main area"，PLAN-0772 之后那句话已是假话 ⇒ task-293 改掉。）
        // `dc3603db6`（组织成员页）又加了 `org-members` 模块，但本断言没跟着改 ⇒ 本文件在 HEAD 上
        // 就红（"主区只有两项"是过期事实）。task-259 同批修正：顺序 = GLOBAL_MODULES 的声明序。
        const main = wrapper.get('[data-testid="global-rail"] [data-slot="sidebar-content"]');
        expect(
            main
                .findAll('[data-testid^="global-rail-module-"]')
                .map((n) => n.attributes("data-testid")),
        ).toEqual([
            "global-rail-module-workbench",
            "global-rail-module-org-members",
            "global-rail-module-resources",
        ]);
        expect(wrapper.get('[data-testid="global-rail-module-workbench"]').text()).toContain(
            "工作台",
        );
        expect(wrapper.get('[data-testid="global-rail-module-resources"]').text()).toContain(
            "资源",
        );
        // 设置与登出一起收在 footer，设置居登出上方（D-933）。
        const footer = wrapper.get('[data-testid="global-rail"] [data-slot="sidebar-footer"]');
        expect(
            footer
                .findAll('[data-testid^="global-rail-module-"]')
                .map((n) => n.attributes("data-testid")),
        ).toEqual(["global-rail-module-settings"]);
        expect(wrapper.get('[data-testid="global-rail-module-settings"]').text()).toContain("设置");
        const footerOrder = footer
            .findAll("[data-testid]")
            .map((node) => node.attributes("data-testid"));
        expect(footerOrder.indexOf("global-rail-module-settings")).toBeLessThan(
            footerOrder.indexOf("global-rail-logout"),
        );
        // 管理入口对任何角色都不再渲染（含管理员）。
        expect(wrapper.find('[data-testid="global-rail-admin"]').exists()).toBe(false);
        // SidebarRail = 悬停双态入口（shadcn-vue collapsible="icon"）。
        expect(wrapper.find('[data-sidebar="rail"]').exists()).toBe(true);
    });

    /**
     * task-214（Lead 裁定）：footer 里**动作项**（设置 / 退出登录）与**框架控件**（收起/展开）
     * 不许混排 —— 收起属于「栏的边界」，必须贴最底。
     *
     * <p>判据用 **DOM 顺序**（`[data-testid]` 序列）而不是坐标：jsdom 没有布局，坐标只会
     * 变成 0 ⇒ 断言恒真。这条断言是**唯一**能证明"位置"的东西 —— 本文件此前只断言了
     * aria 属性（`aria-label`/`aria-expanded`），那种断言在控件被挪到中间时照样绿。</p>
     */
    it("footer 顺序：动作组（设置 → 登出）在上，收起控件贴最底（折起/展开两态同构）", async () => {
        patchAuth();
        const wrapper = await mountRail();
        // 折起态（默认 56px 图标栏）
        expect(railState(wrapper)).toBe("collapsed");
        expect(footerActionOrder(wrapper)).toEqual([
            "global-rail-module-settings",
            "global-rail-logout",
            "global-rail-toggle",
        ]);
        // 框架控件与动作组之间有 vendored 分隔件（`SidebarSeparator`），只用既有 token。
        const footer = wrapper.get('[data-testid="global-rail"] [data-slot="sidebar-footer"]');
        expect(footer.findAll('[data-sidebar="separator"]')).toHaveLength(1);

        const toggle = wrapper.get('[data-testid="global-rail-toggle"]');
        // 折起态仍可见：DOM 里存在且是**原生 button**（Enter/Space 可切由它保证，不靠额外 keydown 绑定）。
        expect(toggle.element.tagName).toBe("BUTTON");
        expect(toggle.attributes("aria-expanded")).toBe("false");
        expect(toggle.attributes("aria-label")).toBe("展开侧边栏");

        // 点一下换态：aria 三件（expanded / label / 文案）一起跟，顺序不受影响。
        await toggle.trigger("click");
        await flushPromises();
        expect(railState(wrapper)).toBe("expanded");
        expect(wrapper.get('[data-testid="global-rail-toggle"]').attributes("aria-expanded")).toBe(
            "true",
        );
        expect(wrapper.get('[data-testid="global-rail-toggle"]').attributes("aria-label")).toBe(
            "收起侧边栏",
        );
        expect(footerActionOrder(wrapper)).toEqual([
            "global-rail-module-settings",
            "global-rail-logout",
            "global-rail-toggle",
        ]);
    });

    /**
     * task-224（用户 2026-11-13 直述「展开全局导航栏后，左上角的 LOGO 不用移动位置」）：
     * logo 槽位原来写 `self-center` —— 那句「天然居中 (56 − 28) / 2 = 14」只对**折起态**成立；
     * 展开态栏宽 192px，`self-center` 是「居中于当前宽度」⇒ logo 右移 (192 − 56) / 2 = 68px。
     * 改成固定左内距 `ml-3.5`（= 3.5 × 3.5 = 14px，与折起态逐像素相同）+ `self-start`。
     *
     * <p>为什么断言落在 class 而不落在坐标：jsdom 没有布局，`getBoundingClientRect()` 恒 0
     * ⇒ 坐标断言恒真（假绿）。这里只证明**决定位置的类被换掉了**，真实 x 由 task-224 卡面的
     * 1920 双态截图读数承担：两态 x 相同；反证 = 换回 `self-center` ⇒ 展开态右移 68px。</p>
     */
    it("logo 用固定左内距（两态同 x），不用 self-center（task-224）", async () => {
        patchAuth();
        const wrapper = await mountRail();
        const logo = wrapper.get('[data-testid="global-rail-logo"]');
        const classes = logo.classes();
        expect(classes).not.toContain("self-center");
        expect(classes).toContain("self-start");
        expect(classes).toContain("ml-3.5");
        // 本卡不改这些（尺寸 28px / 纵向 7px 上下）：写进断言是为了让「顺手改样式」当场红。
        expect(classes).toContain("size-8");
        expect(classes).toContain("my-2");
        // 两态都只有这一个 logo 槽位（展开态不渲染第二份）。
        expect(wrapper.findAll('[data-testid="global-rail-logo"]')).toHaveLength(1);
    });

    it("is icon-only by default and expands to icon+text via the rail handle (dual state)", async () => {
        patchAuth();
        const wrapper = await mountRail();
        expect(railState(wrapper)).toBe("collapsed");

        await wrapper.get('[data-sidebar="rail"]').trigger("click");
        await flushPromises();

        expect(railState(wrapper)).toBe("expanded");
        // 双态持久化口径随 task-189（0126ef771，2026-11-13）改成状态对象 `xihe-global-rail`
        // = `{ open, width }`；旧布尔键 `xihe-global-rail-open` 只作一次性迁移输入、随后清除。
        // （本条与 task-214 的 footer 移位无关：旧断言写的是**迁移前**的键 ⇒ 自 task-189 起一直红。）
        expect(JSON.parse(localStorage.getItem("xihe-global-rail") ?? "{}").open).toBe(true);
        expect(localStorage.getItem("xihe-global-rail-open")).toBeNull();
        // 独立 key；绝不写全局布局键 xihe-layout-global（T2.4 防串味）。
        expect(localStorage.getItem("xihe-layout-global")).toBeNull();
    });

    it("restores the persisted expanded state on the next mount", async () => {
        patchAuth();
        // 同 task-189 口径：新键是 `{ open, width }`。种子必须写新键 —— 写旧布尔键时
        // `useStorage` 会先落默认值、迁移逻辑随即因「新键已存在」放弃迁移 ⇒ 永远读不到。
        localStorage.setItem("xihe-global-rail", JSON.stringify({ open: true, width: 288 }));
        const wrapper = await mountRail();
        expect(railState(wrapper)).toBe("expanded");
    });

    it("switches modules: workbench -> /workspace, resources -> defaultResourcePath(), settings -> default layer path", async () => {
        patchAuth();
        const wrapper = await mountRail();
        await wrapper.get('[data-testid="global-rail-module-settings"]').trigger("click");
        expect(pushSpy).toHaveBeenLastCalledWith(defaultLayerPath("instance"));

        await wrapper.get('[data-testid="global-rail-module-workbench"]').trigger("click");
        expect(pushSpy).toHaveBeenLastCalledWith("/workspace");

        // PLAN-0772 M2：第三入口点下去要落到**默认资源子页**。
        // 组件侧落地 = `resourcePath(RESOURCE_DEFS[0].id)`（`globalModules.ts:100`，**不带层**）；
        // `defaultResourcePath()` 额外带 `?layer=`，层由 `/resources/<id>` 的 `beforeEnter`
        // 规范化写回 ⇒ 判据是「落到同一页」，故这里比**路径部分**而不是整串。
        await wrapper.get('[data-testid="global-rail-module-resources"]').trigger("click");
        expect(String(pushSpy.mock.lastCall?.[0])).toBe(defaultResourcePath().split("?")[0]);
        expect(defaultResourcePath()).toBe("/resources/credentials?layer=USER");
    });

    it("资源入口在 /resources/** 上保持激活（前缀判定，含详情深链）", async () => {
        patchAuth();
        for (const path of [
            "/resources/credentials?layer=USER",
            "/resources/skills/x?layer=USER",
        ]) {
            routeState.path = path;
            const wrapper = await mountRail();
            expect(
                wrapper
                    .get('[data-testid="global-rail-module-resources"]')
                    .attributes("data-active"),
            ).toBe("true");
            // 同一时刻工作台不得同时激活（两个入口都是 `startsWith` 前缀判定，写错会两个都亮）。
            expect(
                wrapper
                    .get('[data-testid="global-rail-module-workbench"]')
                    .attributes("data-active"),
            ).not.toBe("true");
            wrapper.unmount();
        }
    });

    it("logs out and returns to the login route", async () => {
        const auth = patchAuth();
        const wrapper = await mountRail();
        await wrapper.get('[data-testid="global-rail-logout"]').trigger("click");
        expect(auth.token).toBeFalsy();
        expect(pushSpy).toHaveBeenLastCalledWith("/login");
    });

    it("marks the active module; config-locks/roles count as settings after D-933", async () => {
        patchAuth(true);
        routeState.path = "/settings/instance/logging";
        const wrapper = await mountRail();
        expect(
            wrapper.get('[data-testid="global-rail-module-settings"]').attributes("data-active"),
        ).toBe("true");
        // D-933 回归守卫：config-locks 不再有独立 admin 态，归设置模块激活。
        routeState.path = "/settings/config-locks";
        const wrapperLocks = await mountRail();
        expect(
            wrapperLocks
                .get('[data-testid="global-rail-module-settings"]')
                .attributes("data-active"),
        ).toBe("true");
        expect(wrapperLocks.find('[data-testid="global-rail-admin"]').exists()).toBe(false);

        routeState.path = "/workspace/ws-1";
        const wrapper2 = await mountRail();
        expect(
            wrapper2.get('[data-testid="global-rail-module-workbench"]').attributes("data-active"),
        ).toBe("true");
        // 非激活项不写 data-active（vendored 组件用 isActive || undefined）。
        expect(
            wrapper2.get('[data-testid="global-rail-module-settings"]').attributes("data-active"),
        ).toBeUndefined();
    });
});
