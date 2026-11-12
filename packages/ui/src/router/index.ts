import { createRouter, createWebHistory } from "vue-router";
import { api } from "../composables/api";
import {
    migrateLegacyWorkspace,
    readTabWorkspaceId,
    writeTabWorkspaceId,
} from "../lib/workspaceContext";
import { resolveUnauthenticatedEntry } from "../lib/authEntry";
import { defaultLayerPath, defaultResourcePath, RESOURCE_DEFS } from "../lib/settingsIa";
import { LAYER_DOMAINS } from "../stores/config";

/**
 * 资源页宿主（PLAN-0772 M2）。显式表而不是拼路径：`import()` 用变量在 Vite 里只有「前缀 + 后缀」
 * 的受限形式，拼错就是运行时 404 —— 显式映射让 typecheck 就能抓到漏项。
 */
const RESOURCE_VIEWS: Record<string, () => Promise<unknown>> = {
    credentials: () => import("../views/resources/CredentialsResourceView.vue"),
    mcp: () => import("../views/resources/McpResourceView.vue"),
    skills: () => import("../views/resources/SkillsResourceView.vue"),
    agents: () => import("../views/resources/AgentsResourceView.vue"),
};

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
                    // task-253：工作区配置层已从 UI 移除（域段路由 /settings/:domain 随之退役）。
                    // 工作区内部设置面本轮不重新设计，只剩不带域段的入口。
                    path: "settings",
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
                // PLAN-0766（task-160）：共享工作区默认层。域集来自 stores/config 的
                // WORKSPACE_WRITABLE 镜像（8 个 UI 域；service-only 的 context-templates 不在 config API 里）。
                ...LAYER_DOMAINS["workspace-default"].map((domain) => ({
                    path: `workspace-default/${domain}`,
                    name: `settings-workspace-default-domain-${domain}`,
                    component: () => import("../views/settings/SettingsDomainView.vue"),
                    props: { layer: "workspace-default" as const, domain },
                    meta: {
                        settingsLayer: "workspace-default" as const,
                        settingsDomain: domain,
                    },
                })),
                // 旧路径 redirect（V2）：层不进 URL 时代的入口
                {
                    path: "workspace-default",
                    redirect: () => defaultLayerPath("workspace-default"),
                },
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
            /**
             * PLAN-0772 M2（design.md 目标 1 + 决策 10）：资源面独立成**第三个顶层入口**。
             *
             * <p>旧路径（`/settings/instance/credentials|agents|mcp`、`/settings/skills`、
             * `/settings/credentials`、`/settings/agent-principals`、`/settings/knowledge`）
             * **一次性删除、不留 redirect** —— 用户 2026-11-12 裁定「不用考虑旧的兼容性，要改就全改，
             * 一次性改」。留着 redirect 会留下两套路径语义，日后没人敢删；删干净则是**可判定**的
             * 完成判据（`git grep` 归 0）。</p>
             *
             * <p>层在 `?layer=`（大写），不在路径段：一资源一页 + 页内层 tab（决策 2）。
             * 路由只注册**真实存在的资源**（`RESOURCE_DEFS` 里没有 gaps 的），knowledge 单独一条
             * 缺口落点（左栏不链接它，但深链不该 404）。</p>
             */
            path: "/resources",
            component: () => import("../layouts/ResourcesLayout.vue"),
            meta: { requiresAuth: true },
            children: [
                { path: "", redirect: () => defaultResourcePath() },
                ...RESOURCE_DEFS.filter((def) => (def.gaps ?? []).length === 0).map((def) => ({
                    path: def.id,
                    name: `resources-${def.id}`,
                    component: RESOURCE_VIEWS[def.id],
                    meta: { resourceId: def.id },
                })),
                {
                    // 缺口资源（G3）的可读落点：不伪装成可管理页面，只解释缺口并给出口。
                    path: "knowledge",
                    name: "resources-knowledge",
                    component: () => import("../views/resources/KnowledgeResourceView.vue"),
                    meta: { resourceId: "knowledge" },
                },
                {
                    // 资源模块的 404（`/resources/<不存在>`）：不写 meta.resourceId，避免布局拿不到
                    // 资源时崩掉；兜底视图与设置区共用（同一句「这条路由不存在」）。
                    path: ":pathMatch(.*)*",
                    name: "resources-not-found",
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
