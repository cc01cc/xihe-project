import { createRouter, createWebHistory } from "vue-router";
import { api } from "../composables/api";
import {
    migrateLegacyWorkspace,
    readTabWorkspaceId,
    writeTabWorkspaceId,
} from "../lib/workspaceContext";
import { resolveUnauthenticatedEntry } from "../lib/authEntry";
import { defaultLayerPath, knowledgeRedirectTarget } from "../lib/settingsIa";
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
                    // PLAN-0750 M3（矩阵 U3）：用户层「我的智能体」落地页。
                    // **不是**工作区「工作区设置 → 智能体」的复制品：本页只承担
                    // ①个人视图列表（R3：CP 只回 created_by=self）
                    // ②无工作区上下文的创建（U1：走 CREATE_OWN_AGENT，不是 MANAGE_WORKSPACE_AGENTS）
                    // ③卡片上的「绑定到工作区」动作（R1 的显式绑定面）。
                    // 工作区侧的创建入口保持只有 WorkspaceAgentsPanel 那一个（U2：不改造单门）。
                    path: "my-agents",
                    name: "settings-my-agents",
                    component: () => import("../views/settings/MyAgentsView.vue"),
                    meta: { settingsLayer: "user" },
                },
                {
                    // PLAN-0752 T4.4（task-91）：知识库**只有工作区承载**（T4.3：CP 无库表、按 workspace 分区），
                    // 而这条 user 层路由没有任何导航指向它 —— 保留它等于留一个「点得到的用户层知识库」幽灵页。
                    // 因此改成工作区重定向：有当前工作区 ⇒ 落到工作区设置的「知识库」tab；没有 ⇒ 回工作区选择面。
                    path: "knowledge",
                    name: "settings-knowledge",
                    redirect: () => knowledgeRedirectTarget(readTabWorkspaceId()),
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
 * Resolved once per page load. On failure we behave exactly like the pre-local-mode
 * login wall, so an unreachable CP never changes the entry (PLAN-0758 keeps only
 * the `initialized` discriminator).
 */
let bootstrapCache: { initialized: boolean } | null = null;

async function resolveBootstrap(): Promise<{ initialized: boolean }> {
    if (bootstrapCache) return bootstrapCache;
    try {
        bootstrapCache = await api.bootstrapStatus();
    } catch {
        bootstrapCache = { initialized: true };
    }
    return bootstrapCache;
}

router.beforeEach(async (to) => {
    migrateLegacyWorkspace();
    const token = localStorage.getItem("xihe-token"),
        requiresAuth = to.matched.some((r) => r.meta?.requiresAuth);

    if (requiresAuth && !token) {
        const bootstrap = await resolveBootstrap();
        // PLAN-0612 T6.3：入口判定抽成纯函数（`lib/authEntry.ts`），才能对"仍跳 /login"这类回归
        // 做单测。PLAN-0758 后只剩 onboarding / login 两态。
        const entry = resolveUnauthenticatedEntry(bootstrap);
        if (entry === "onboarding") {
            return { name: "onboarding", query: { redirect: to.fullPath } };
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
