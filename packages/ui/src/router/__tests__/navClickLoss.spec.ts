import { describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import GlobalRail from "../../components/sidebar/GlobalRail.vue";
import { DropdownMenu } from "../../components/ui/dropdown-menu";
import { ORG_MEMBERS_PATH, SCHEDULED_TASKS_PATH, WORKBENCH_PATH } from "../../lib/globalModules";
import { defaultLayerPath, defaultResourcePath } from "../../lib/settingsIa";

/**
 * task-1012：全局导航「点击被吞」的回归判据。
 *
 * 卡面要的是**可执行**约束，不是注释里的口头约定：
 * 1) 快速连点两个 rail 按钮（同一 tick）后，最终 URL 必须等于**最后一次点击**的目标；
 * 2) 模块二级菜单必须是**非模态** —— 模态 DropdownMenu 会把文档其余部分标成
 *    `pointer-events: none`，于是「菜单开着 → 点另一个 rail 按钮」的第一次点击只用来关菜单，
 *    目标按钮收不到事件（浏览器实测 10/10 丢失，见 evidence/2026-11-24-nav-click-loss）；
 * 3) chevron 触发器不得用 `absolute` 压在导航按钮的命中区上 —— 旧实现里点行右侧
 *    14px 会开菜单而不导航（实测 10/10）。
 *
 * 这里用**真实 vue-router（memory history）**而不是 vi.mock：本卡要证的是"最终落地路由"，
 * 只断言 `push` 被调用无法区分「发起过」和「真的落地」。
 */

const i18n = createI18n({
    legacy: false,
    locale: "zh-CN",
    messages: {
        "zh-CN": {
            sidebar: {
                workbench: "工作台",
                resources: "资源",
                settings: "设置",
                logout: "退出登录",
                collapse: "收起导航面板",
                expand: "展开导航面板",
                toggle: "切换导航面板",
                moduleMenu: "打开模块页面菜单",
                orgMembers: "组织成员",
            },
            workspaceNav: { scheduledTasks: "自动化任务" },
            common: { globalNav: "全局导航", skipToMain: "跳到主内容" },
        },
    },
});

function buildRouter(): Router {
    const Stub = { template: "<div />" };
    return createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: WORKBENCH_PATH, component: Stub },
            { path: ORG_MEMBERS_PATH, component: Stub },
            { path: SCHEDULED_TASKS_PATH, component: Stub },
            { path: defaultResourcePath().split("?")[0], component: Stub },
            { path: "/settings", redirect: defaultLayerPath("instance") },
            { path: defaultLayerPath("instance"), component: Stub },
            { path: "/login", component: Stub },
        ],
    });
}

async function mountRailAt(path: string) {
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = buildRouter();
    await router.push(path);
    await router.isReady();
    const wrapper = mount(GlobalRail, {
        global: { plugins: [router, i18n, pinia] },
    });
    await flushPromises();
    return { wrapper, router };
}

const testId = (id: string) => `[data-testid="global-rail-module-${id}"]`;

describe("task-1012 rail 连点可靠性", () => {
    it("同一 tick 内连点 settings → workbench，最终落地最后一次点击目标", async () => {
        const { wrapper, router } = await mountRailAt(SCHEDULED_TASKS_PATH);
        await wrapper.get(testId("settings")).trigger("click");
        await wrapper.get(testId("workbench")).trigger("click");
        await flushPromises();
        await router.isReady();
        expect(router.currentRoute.value.path).toBe(WORKBENCH_PATH);
    });

    it("同一 tick 内连点 org-members → settings，最终落设置默认层", async () => {
        const { wrapper, router } = await mountRailAt(SCHEDULED_TASKS_PATH);
        await wrapper.get(testId("org-members")).trigger("click");
        await wrapper.get(testId("settings")).trigger("click");
        await flushPromises();
        await router.isReady();
        // /settings 是 redirect ⇒ 判据是**落地后**的默认层路径（redirect 也算落地）。
        expect(router.currentRoute.value.path).toBe(defaultLayerPath("instance"));
    });

    it("所有模块二级菜单都是非模态（外部点击不被吞）", async () => {
        const { wrapper } = await mountRailAt(SCHEDULED_TASKS_PATH);
        const menus = wrapper.findAllComponents(DropdownMenu);
        expect(menus.length).toBeGreaterThan(0);
        for (const menu of menus) {
            expect(menu.props("modal")).toBe(false);
        }
    });

    it("chevron 触发器不压在导航按钮命中区（无 absolute 定位）", async () => {
        const { wrapper } = await mountRailAt(SCHEDULED_TASKS_PATH);
        const settingsRow = wrapper.get(testId("settings"));
        expect(settingsRow.classes()).not.toContain("absolute");
        const trigger = wrapper.get('[data-testid="global-rail-menu-settings"]');
        expect(trigger.classes()).not.toContain("absolute");
        expect(trigger.classes()).toContain("shrink-0");
    });
});
