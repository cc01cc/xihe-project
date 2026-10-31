import { createRouter, createWebHistory } from "vue-router";
import { api } from "../composables/api";
import {
    migrateLegacyWorkspace,
    readTabWorkspaceId,
    writeTabWorkspace,
    writeTabWorkspaceId,
} from "../lib/workspaceContext";

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
                    // PLAN-0585 M2: ADMIN-only principal grant surface (nav item is ADMIN-gated too).
                    path: "principal-grants",
                    name: "settings-principal-grants",
                    component: () => import("../views/settings/PrincipalGrantsView.vue"),
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
                const res = await api.localLogin();
                localStorage.setItem("xihe-token", res.accessToken);
                localStorage.setItem("xihe-user", JSON.stringify(res.user));
                if (res.workspace) {
                    writeTabWorkspace(res.workspace);
                } else if (res.workspaceId) {
                    writeTabWorkspace({
                        id: res.workspaceId,
                        name: "Default Workspace",
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

