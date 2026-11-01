import { createRouter, createWebHistory } from "vue-router";
import { api } from "../composables/api";
import { logger } from "../lib/logger";
import {
    migrateLegacyWorkspace,
    readTabWorkspace,
    readTabWorkspaceId,
    writeTabWorkspace,
    writeTabWorkspaceId,
} from "../lib/workspaceContext";
import { resolveLocalModeLanding } from "../lib/workspaceLanding";

const router = createRouter({
    history: createWebHistory(),
    routes: [
        {
            path: "/",
            redirect: "/workspace",
        },
        {
            path: "/workspace",
            component: () => import("../layouts/AppLayout.vue"),
            meta: { requiresAuth: true },
            children: [
                {
                    path: "",
                    name: "workspace-home",
                    // PLAN-0608 (T1.5 / P0-2): with no tab context this is the
                    // explicit workspace picker; the guard below redirects to
                    // /workspace/{id} whenever a context already exists.
                    component: () => import("../components/WorkspacePicker.vue"),
                },
            ],
        },
        {
            path: "/workspace/:workspaceId",
            component: () => import("../layouts/AppLayout.vue"),
            meta: { requiresAuth: true },
            children: [
                {
                    path: "",
                    name: "workspace",
                    component: () => import("../features/workspace/pages/WorkspaceView.vue"),
                },
                {
                    path: "chat/:sessionId",
                    name: "workspace-chat",
                    component: () => import("../features/workspace/pages/WorkspaceView.vue"),
                },
                {
                    path: "environment",
                    name: "workspace-environment",
                    component: () =>
                        import("../features/workspace/pages/WorkspaceEnvironmentView.vue"),
                },
                {
                    path: "scheduled-tasks",
                    name: "workspace-scheduled-tasks",
                    component: () => import("../features/workspace/pages/ScheduledTasksView.vue"),
                },
                {
                    path: "settings",
                    name: "workspace-settings",
                    component: () =>
                        import("../features/workspace/pages/WorkspaceSettingsView.vue"),
                },
            ],
        },
        {
            path: "/settings",
            component: () => import("../layouts/AppLayout.vue"),
            meta: { requiresAuth: true },
            children: [
                {
                    path: "",
                    redirect: { name: "settings-config" },
                },
                {
                    path: "config",
                    name: "settings-config",
                    component: () => import("../views/settings/ConfigSettings.vue"),
                },
                {
                    path: "policy",
                    redirect: { name: "settings-config" },
                },
                {
                    path: "config-locks",
                    name: "settings-config-locks",
                    component: () => import("../views/settings/ConfigLocksView.vue"),
                },
                {
                    path: "tool-faces",
                    name: "settings-tool-faces",
                    component: () => import("../views/settings/ToolFacesView.vue"),
                },
                {
                    path: "credentials",
                    name: "settings-credentials",
                    component: () => import("../views/settings/CredentialsView.vue"),
                },
                {
                    path: "knowledge",
                    name: "settings-knowledge",
                    component: () => import("../views/settings/KnowledgeBaseView.vue"),
                },
                {
                    path: "data",
                    name: "settings-data",
                    component: () => import("../views/settings/DataControlsView.vue"),
                },
                {
                    path: "monitoring",
                    name: "settings-monitoring",
                    component: () => import("../views/settings/MonitoringView.vue"),
                },
                {
                    path: "audit",
                    name: "settings-audit",
                    component: () => import("../views/settings/AuditView.vue"),
                },
                {
                    // PLAN-0610 W5c: the principal-grant page is retired (CP answers 410
                    // PRINCIPAL_GRANTS_RETIRED since W2). The old path stays as a redirect so an
                    // existing bookmark lands on the replacement instead of a blank route.
                    path: "principal-grants",
                    redirect: { name: "settings-roles" },
                },
                {
                    // PLAN-0610 W5b: access-role definitions + bindings (ADMIN-gated).
                    path: "roles",
                    name: "settings-roles",
                    component: () => import("../views/settings/RolesView.vue"),
                },
            ],
        },
        {
            path: "/login",
            name: "login",
            component: () => import("../views/auth/LoginView.vue"),
        },
        {
            path: "/register",
            name: "register",
            component: () => import("../views/auth/RegisterView.vue"),
        },
        {
            // PLAN-0526: first-run bootstrap when the instance has no account yet.
            path: "/onboarding",
            name: "onboarding",
            component: () => import("../views/auth/OnboardingView.vue"),
        },
        {
            // Legacy bookmarks (e.g. removed /chat/:sessionId) recover to the
            // Workspace-first landing instead of a blank unmatched-route view.
            path: "/:pathMatch(.*)*",
            redirect: "/workspace",
        },
    ],
});

/**
 * PLAN-0526: resolved once per page load. On failure we behave exactly like the
 * pre-local-mode login wall, so an unreachable CP never changes the entry.
 */
let bootstrapCache: { initialized: boolean; localMode: boolean } | null = null;

async function resolveBootstrap(): Promise<{ initialized: boolean; localMode: boolean }> {
    if (bootstrapCache) return bootstrapCache;
    try {
        bootstrapCache = await api.bootstrapStatus();
    } catch {
        bootstrapCache = { initialized: true, localMode: false };
    }
    return bootstrapCache;
}

router.beforeEach(async (to) => {
    migrateLegacyWorkspace();
    const token = localStorage.getItem("xihe-token"),
        requiresAuth = to.matched.some((r) => r.meta?.requiresAuth);

    if (requiresAuth && !token) {
        const bootstrap = await resolveBootstrap();
        if (!bootstrap.initialized) {
            return { name: "onboarding", query: { redirect: to.fullPath } };
        }
        if (bootstrap.localMode) {
            try {
                // PLAN-0614 决策 #5 / BL-173：落点优先级 = 已有 tab 上下文（记住上次选择）→
                // localLogin 返回的第一个活跃工作区 → 都没有则停在选择面（空态可操作）。
                // 以前这里无条件用登录响应覆盖 tab 上下文，用户在本页签选过的工作区会被顶掉。
                const tabBeforeLogin = readTabWorkspace();
                const res = await api.localLogin();
                localStorage.setItem("xihe-token", res.accessToken);
                localStorage.setItem("xihe-user", JSON.stringify(res.user));
                const landing = resolveLocalModeLanding({
                    tabWorkspace: tabBeforeLogin,
                    loginWorkspace: res.workspace,
                    loginWorkspaceId: res.workspaceId,
                    fallbackName: "Default Workspace",
                });
                // PLAN-0614：只有拿到工作区才写 tab 上下文；没有工作区时不写（空态由选择面呈现）。
                // 这是 0608 I6 的已文档化例外（localMode 免密自动登录有意写入）。
                if (landing) writeTabWorkspace(landing);
                // PLAN-0611: the guard writes localStorage, but the Pinia store may already exist
                // (`main.ts` mounts the app before the initial navigation resolves), so its
                // in-memory token/user would stay "signed out" — `isAuthenticated`/`isAdmin` false
                // until a manual reload, i.e. no admin surfaces on a first passwordless entry.
                // Adopt the session so it behaves exactly like a real sign-in. The import is dynamic
                // on purpose: `stores/auth.ts` imports this router singleton, so a static import
                // would create a module cycle.
                try {
                    const { useAuthStore } = await import("../stores/auth");
                    useAuthStore().adoptGuardSession(
                        res.accessToken,
                        res.user,
                        landing,
                        res.refreshToken,
                    );
                } catch (error) {
                    // No active Pinia (unit tests) or a broken store: the localStorage write above
                    // still lets the guard finish, so log instead of blocking entry.
                    logger.warn("Failed to adopt the local-mode session into the store", {
                        error: String(error),
                    });
                }
                return true;
            } catch {
                // Gate refused (non-loopback / not single-user) — fall back to login.
            }
        }
        return { name: "login", query: { redirect: to.fullPath } };
    } else if (
        (to.name === "login" || to.name === "register" || to.name === "onboarding") &&
        token
    ) {
        return { path: "/workspace" };
    }

    if (token) {
        const routeWorkspaceId =
            typeof to.params.workspaceId === "string" ? to.params.workspaceId : "";
        if (routeWorkspaceId) {
            // Set the tab workspace before child components issue their first
            // request; WorkspaceView then validates access with CP.
            writeTabWorkspaceId(routeWorkspaceId);
        } else if (to.name === "workspace-home") {
            const tabWorkspaceId = readTabWorkspaceId();
            if (tabWorkspaceId) {
                return { path: `/workspace/${tabWorkspaceId}`, query: to.query };
            }
        }
    }

    return true;
});

export default router;
