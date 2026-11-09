import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { i18n } from "../../../i18n";
import { api } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";
import RolesView from "../RolesView.vue";

/**
 * PLAN-0610 W5c — **retirement spec** (this file used to exercise `PrincipalGrantsView`).
 *
 * CP retired `/api/v1/principal-grants/*` with `410 PRINCIPAL_GRANTS_RETIRED` (W2 / decision #28) and
 * the admin page is gone as well: component deleted, nav entry deleted, i18n copy deleted, and the
 * old path became a redirect to `/settings/roles` so an existing bookmark does not hit a blank route.
 *
 * The file is **kept and rewritten** rather than deleted (removing a tracked spec needs wave
 * approval), and it is now the executable statement that the surface stays retired: every assertion
 * below fails if the page, its API client methods, its nav entry, its copy or the redirect return.
 */
vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            rolesCatalog: vi.fn<typeof apiModule.api.rolesCatalog>(),
            listRoles: vi.fn<typeof apiModule.api.listRoles>(),
            listWorkspaces: vi.fn<typeof apiModule.api.listWorkspaces>(),
            getBindings: vi.fn<typeof apiModule.api.getBindings>(),
            listAdminUsers: vi.fn<typeof apiModule.api.listAdminUsers>(),
        },
    };
});

const authState = vi.hoisted(() => ({ isAdmin: true }));
vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({
        // D-713/B7: RolesView now asks auth for its own permission projection on mount (direct
        // route may mount before SettingsNav). The mock must expose the real store API.
        ensureSelfPermissions: vi.fn<() => Promise<boolean>>(() => Promise.resolve(true)),
        get isAdmin() {
            return authState.isAdmin;
        },
    }),
}));

/**
 * task-36 ②：RolesView 现在由设置区公共壳渲染（返回聊天 + SettingsNav），需要真实 router。
 * 本文件刻意**不** mock vue-router —— 上面还要 import 产品 router 断言退役路由表，
 * 所以这里只额外造一个内存 router 给挂载用。
 */
function makeMountRouter(): Router {
    return createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: "/settings/config", component: { template: "<div />" } },
            { path: "/settings/roles", component: { template: "<div />" } },
            { path: "/workspace", component: { template: "<div />" } },
            { path: "/workspace/:workspaceId/chat/:sessionId", component: { template: "<div />" } },
            { path: "/:pathMatch(.*)*", component: { template: "<div />" } },
        ],
    });
}

const mockedApi = vi.mocked(api, true);
const UI_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

let wrappers: VueWrapper[] = [];

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    authState.isAdmin = true;
    vi.clearAllMocks();
    mockedApi.rolesCatalog.mockResolvedValue({ atoms: [], scopes: ["instance", "workspace"] });
    mockedApi.listRoles.mockResolvedValue([]);
    mockedApi.listWorkspaces.mockResolvedValue([]);
    mockedApi.getBindings.mockResolvedValue({ scopeType: "instance", scopeId: null, bindings: [] });
});

afterEach(() => {
    wrappers.forEach((wrapper) => wrapper.unmount());
    wrappers = [];
    document.body.innerHTML = "";
});

describe("principal-grant retirement (PLAN-0610 W5c)", () => {
    it("has no page component and no API client methods left", async () => {
        // The component module must not resolve at all: it is deleted, not merely hidden. The
        // specifier is assembled at runtime and marked `@vite-ignore` so Vite cannot rewrite this
        // into a build-time import (which would fail the whole suite instead of this assertion).
        const retired = ["..", "PrincipalGrantsView.vue"].join("/");
        await expect(import(/* @vite-ignore */ retired)).rejects.toThrow(/PrincipalGrantsView/);

        const client = api as unknown as Record<string, unknown>;
        expect(client.getPrincipalGrants).toBeUndefined();
        expect(client.patchPrincipalGrants).toBeUndefined();
    });

    it("keeps no i18n copy for the retired surface", () => {
        const translate = i18n.global.t as unknown as (key: string) => string;
        // vue-i18n echoes the key when it cannot resolve it, so an unresolved key proves removal.
        for (const key of [
            "settings.principalGrantsTitle",
            "settings.principalGrantsNav",
            "settings.principalGrantsSave",
            "settings.principalGrantsErrorGeneric",
        ]) {
            expect(translate(key)).toBe(key);
        }
        // The replacement surface's copy resolves (sanity check that the locale file did load).
        expect(translate("settings.rolesTitle")).not.toBe("settings.rolesTitle");
    });

    it("keeps no nav entry, only the role surface", () => {
        // task-74 B4：旧 SettingsNav 组件已回收（零使用者），导航唯一实现是 SettingsSidebar +
        // settingsIa 的分组数据 —— 判据跟着搬家，断言对象换到当前实现上。
        const sidebarSource = readFileSync(
            resolve(UI_SRC, "components/settings/SettingsSidebar.vue"),
            "utf8",
        );
        expect(sidebarSource).not.toContain("principal-grants");
        const iaSource = readFileSync(resolve(UI_SRC, "lib/settingsIa.ts"), "utf8");
        expect(iaSource).not.toContain("principal-grants");
        expect(iaSource).toContain("/settings/roles");
    });

    it("redirects the old path to the role surface instead of rendering a page", async () => {
        const router = (await import("../../../router")).default;
        const oldPathRoutes = router
            .getRoutes()
            .filter((route) => route.path === "/settings/principal-grants");

        expect(oldPathRoutes).toHaveLength(1);
        // A redirect route owns no component…
        expect(oldPathRoutes[0]?.components).toBeUndefined();
        expect(oldPathRoutes[0]?.redirect).toBeDefined();
        // …and the route name of the retired page is gone entirely.
        expect(router.hasRoute("settings-principal-grants")).toBe(false);
        expect(router.resolve("/settings/roles").name).toBe("settings-roles");
    });

    it("renders the role surface in place of the retired page", async () => {
        const wrapper = mount(RolesView, {
            attachTo: document.body,
            global: { plugins: [i18n, makeMountRouter()] },
        });
        wrappers.push(wrapper);
        await flushPromises();

        expect(wrapper.find('[data-testid="roles-view"]').exists()).toBe(true);
        // The retired page's whole test-id surface is gone.
        for (const testId of [
            "principal-grant-view",
            "principal-grant-form",
            "principal-grant-username",
            "principal-grant-save",
            "principal-grant-editor",
        ]) {
            expect(document.body.querySelector(`[data-testid="${testId}"]`)).toBeNull();
        }
    });

    it("points the F-02 agent guidance link at the role surface", () => {
        // PLAN-0626 M3: the guidance link lives in the panel body that the dock's `agents`
        // tab renders (`WorkspaceAgentsPanel.vue`); the dialog file is only a mobile shell.
        const panelSource = readFileSync(
            resolve(UI_SRC, "features/workspace/components/WorkspaceAgentsPanel.vue"),
            "utf8",
        );
        expect(panelSource).not.toContain("/settings/principal-grants");
        expect(panelSource).toContain('to="/settings/roles"');
    });
});
