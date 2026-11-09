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
import { resolveUnauthenticatedEntry } from "../lib/authEntry";
import { defaultLayerPath } from "../lib/settingsIa";
import { LAYER_DOMAINS } from "../stores/config";

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
                    // PLAN-0752 M1：工作区层进 URL 的域段（可选；不带域段 = 旧入口）
                    path: "settings/:domain?",
                    name: "workspace-settings",
                    component: () =>
                        import("../features/workspace/pages/WorkspaceSettingsView.vue"),
                },
            ],
        },
        {
            /**
             * PLAN-0752 M1（V1/V3/V25）：设置区不再复用 AppLayout，层进 URL。
             *
             * 只注册矩阵里存在的「层×域」组合（12 + 9）——不存在的组合根本不匹配，
             * 落到末尾的 404 兜底；这是「路由不存在」的直译，而不是渲染一个错误页假装存在。
             */
            path: "/settings",
            component: () => import("../layouts/SettingsLayout.vue"),
            meta: { requiresAuth: true },
            children: [
                {
                    // 层默认页：实例层第一个域；非管理员由域页的 403 视图兜底（V4）
                    path: "",
                    redirect: () => defaultLayerPath("instance"),
                },
                ...LAYER_DOMAINS.instance.map((domain) => ({
                    path: `instance/${domain}`,
                    name: `settings-instance-domain-${domain}`,
                    component: () => import("../views/settings/SettingsDomainView.vue"),
                    props: { layer: "instance" as const, domain },
                    meta: { settingsLayer: "instance" as const, settingsDomain: domain },
                })),
                ...LAYER_DOMAINS.user.map((domain) => ({
                    path: `user/${domain}`,
                    name: `settings-user-domain-${domain}`,
                    component: () => import("../views/settings/SettingsDomainView.vue"),
                    props: { layer: "user" as const, domain },
                    meta: { settingsLayer: "user" as const, settingsDomain: domain },
                })),
                // 旧路径 redirect（V2）：层不进 URL 时代的入口
                {
                    path: "config",
                    redirect: () => defaultLayerPath("instance"),
                },
                {
                    path: "policy",
                    redirect: () => defaultLayerPath("instance"),
                },
                {
                    // PLAN-0752 T3.3 / design 决策 #7 + D2：工具分类已并入 approval-policy 域页签，
                    // 不再单独占顶级设置页；旧书签保留 302（防 bookmark 死掉），落地即该域的
                    // 「工具分类」页签（?tab= 只表达域内视图，不表达层）。
                    path: "tool-faces",
                    redirect: {
                        name: "settings-instance-domain-approval-policy",
                        query: { tab: "tool-faces" },
                    },
                },
                // 实例运维 / 安全与权限（不是配置域，路径不在层段下）
                {
                    path: "monitoring",
                    name: "settings-monitoring",
                    component: () => import("../views/settings/MonitoringView.vue"),
                    meta: { settingsLayer: "instance" },
                },
                {
                    path: "data",
                    name: "settings-data",
                    component: () => import("../views/settings/DataControlsView.vue"),
                    meta: { settingsLayer: "instance" },
                },
                {
                    path: "config-locks",
                    name: "settings-config-locks",
                    component: () => import("../views/settings/ConfigLocksView.vue"),
                    meta: { settingsLayer: "instance" },
                },
                {
                    path: "roles",
                    name: "settings-roles",
                    component: () => import("../views/settings/RolesView.vue"),
                    meta: { settingsLayer: "instance" },
                },
                {
                    path: "audit",
                    name: "settings-audit",
                    component: () => import("../views/settings/AuditView.vue"),
                    meta: { settingsLayer: "instance" },
                },
                {
                    // 资源面（M4 才搬进「我的资源」分组）：M1 先保持可达，路径不变
                    path: "credentials",
                    name: "settings-credentials",
                    component: () => import("../views/settings/CredentialsView.vue"),
                    meta: { settingsLayer: "user" },
                },
                {
                    path: "knowledge",
                    name: "settings-knowledge",
                    component: () => import("../views/settings/KnowledgeBaseView.vue"),
                    meta: { settingsLayer: "user" },
                },
                {
                    // PLAN-0610 W5c：principal-grants 已退役，旧书签落到替代页
                    path: "principal-grants",
                    redirect: { name: "settings-roles" },
                },
                {
                    // V3/V25：层×域矩阵里没有的组合（含手输 URL 与外部书签）⇒ 404 视图。
                    // 注意**不写** meta.settingsLayer：兜底路由没有层参数，写死任意一层都会让 404
                    // 页的层标题说胡话；层由 SettingsLayout 用 settingsLayerForPath(route.path) 推导。
                    path: ":pathMatch(.*)*",
                    name: "settings-not-found",
                    component: () => import("../views/settings/SettingsNotFoundView.vue"),
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
        // PLAN-0612 T6.3：入口三态抽成纯函数（`lib/authEntry.ts`），才能对"非 localMode 仍跳
        // /login"这类回归做单测；这里的分支顺序与抽取前逐字一致。
        const entry = resolveUnauthenticatedEntry(bootstrap);
        if (entry === "onboarding") {
            return { name: "onboarding", query: { redirect: to.fullPath } };
        }
        if (entry === "local-login") {
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
