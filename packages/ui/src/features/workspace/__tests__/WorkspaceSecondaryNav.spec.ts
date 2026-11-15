import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import { i18n } from "../../../i18n";
import WorkspaceSecondaryNav from "../components/WorkspaceSecondaryNav.vue";

/**
 * 工作区二级导航 = **一行导航项**（task-190 建；**task-160 / S2a 收成一行、面包屑搬走**）。
 *
 * <p><b>task-160 之后本文件判什么</b>：</p>
 * <ol>
 *   <li>面包屑**已经不在这里**（它搬去了底部状态栏；断言面在
 *       `components/__tests__/WorkspaceStatusBar.spec.ts`）—— 这条防止「两边都渲染」或「两边都没有」；</li>
 *   <li>单行：根 `<nav>` 不带 `flex-wrap` / `justify-between`，且钉了 `h-8` 与 `shrink-0`
 *       （`h-8` = 8 × `--spacing` 3.5 = 28 px）；</li>
 *   <li>导航项仍是 `role="tab"` + `aria-selected`，但**不再带 `aria-current="page"`** ——
 *       一页只能有一个「当前页」，那个由状态栏面包屑末段持有。</li>
 * </ol>
 *
 * <p><b>task-297 的历史为什么还留在这</b>：当年 `trail.container` 是死字段（面包屑只渲染两段），
 * 判据是「中间段有没有渲染」。那段判据**跟着面包屑一起搬到了状态栏 spec**，不是被删掉 ——
 * 删掉等于让同一个缺陷在搬家后重新免疫。</p>
 */
const WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";

const routeState = vi.hoisted(() => ({ routeName: "workspace" as string }));

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
    RouterLink: { template: "<a><slot /></a>" },
    useRoute: () =>
        ({
            name: routeState.routeName,
            path: `/workspace/${WORKSPACE_ID}`,
            params: { workspaceId: WORKSPACE_ID },
            query: {},
        }) as unknown as RouteLocationNormalizedLoaded,
    useRouter: () => ({
        resolve: (to: { name?: string; params?: Record<string, string> }) => ({
            href:
                to.name === "workspace"
                    ? `/workspace/${String(to.params?.workspaceId ?? "")}`
                    : `/workspace/${String(to.params?.workspaceId ?? "")}/${String(to.name)}`,
            name: to.name,
        }),
        getRoutes: () => [
            {
                name: "workspace",
                meta: {
                    workspacePage: {
                        id: "sessions",
                        labelKey: "workspaceNav.sessions",
                        order: 10,
                    },
                },
            },
            {
                name: "workspace-environment",
                meta: {
                    workspacePage: {
                        id: "environment",
                        labelKey: "workspaceNav.environment",
                        order: 20,
                    },
                },
            },
        ],
    }),
}));

async function mountNav() {
    const wrapper = mount(WorkspaceSecondaryNav, {
        global: {
            plugins: [i18n],
            stubs: { RouterLink: { template: "<a><slot /></a>" } },
        },
    });
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
    routeState.routeName = "workspace";
    localStorage.setItem("xihe-token", "test-token");
    localStorage.setItem("xihe-user", JSON.stringify({ id: "u1" }));
});

describe("WorkspaceSecondaryNav 单行化（task-160 / S2a）", () => {
    it("根 nav 是单行：无 flex-wrap / justify-between，且 h-8 + shrink-0", async () => {
        const wrapper = await mountNav();
        const nav = wrapper.find('[data-testid="workspace-secondary-nav"]');
        expect(nav.exists()).toBe(true);
        const cls = nav.classes();
        expect(cls).toContain("h-8");
        expect(cls).toContain("shrink-0");
        expect(cls).not.toContain("flex-wrap");
        expect(cls).not.toContain("justify-between");
        wrapper.unmount();
    });

    it("面包屑已经不在这里（搬去底部状态栏，面包屑断言在 WorkspaceStatusBar.spec.ts）", async () => {
        const wrapper = await mountNav();
        expect(wrapper.find('[data-testid="workspace-breadcrumb"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="workspace-breadcrumb-container"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("导航项仍在：role=tab + aria-selected 标记激活项，且全页不再有 aria-current", async () => {
        const wrapper = await mountNav();
        const sessions = wrapper.find('[data-testid="workspace-nav-sessions"]');
        expect(sessions.exists()).toBe(true);
        expect(sessions.attributes("role")).toBe("tab");
        expect(sessions.attributes("aria-selected")).toBe("true");

        const environment = wrapper.find('[data-testid="workspace-nav-environment"]');
        expect(environment.attributes("aria-selected")).toBe("false");

        // 一页只能有一个「当前页」：它属于状态栏面包屑末段，导航行不许再叠一个。
        expect(wrapper.findAll('[aria-current="page"]').length).toBe(0);
        wrapper.unmount();
    });

    it("导航项文案来自 i18n（不是裸 key）", async () => {
        const wrapper = await mountNav();
        const sessions = wrapper.find('[data-testid="workspace-nav-sessions"]');
        expect(sessions.text()).toBe(i18n.global.t("workspaceNav.sessions"));
        expect(sessions.text()).not.toContain("workspaceNav.");
        wrapper.unmount();
    });
});
