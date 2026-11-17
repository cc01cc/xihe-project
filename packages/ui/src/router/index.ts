import { createRouter, createWebHistory, type RouteLocationRaw } from "vue-router";
import { Boxes, CalendarClock, LayoutGrid, Server, Settings, Users } from "@lucide/vue";
import { api } from "../composables/api";
import {
    clearTabWorkspace,
    migrateLegacyWorkspace,
    readTabWorkspaceId,
    writeTabWorkspaceId,
} from "../lib/workspaceContext";
import { isUuid } from "../lib/uuid";
import { WORKSPACE_PICKER_PATH } from "../lib/routes";
import {
    isExplicitPickerEntry,
    lastLocationForRoute,
    readLastLocation,
    resolveLastLocationTarget,
    writeLastLocation,
} from "../lib/lastLocation";
import { resolveUnauthenticatedEntry } from "../lib/authEntry";
import { isEntryRouteName, shouldBounceEntryToWorkspace } from "./loginEntry";
import {
    SETTINGS_GROUPS,
    SETTINGS_LAYERS,
    defaultLayerPath,
    defaultResourcePath,
    groupDomainsForLayer,
    isSettingsGroupLayer,
    RESOURCE_DEFS,
} from "../lib/settingsIa";
import {
    normalizeResourceLayerQuery,
    resourceDetailRouteName,
    resourceDetailRoutePath,
} from "./resourceDetailRoutes";
import { LAYER_DOMAINS } from "../stores/config";
// 资源页宿主映射（PLAN-0772 M2 引入；PLAN-0773 M4-2 / task-210 搬到 `lib/resourceViews.ts`
// —— 工作区资源页要复用同一批视图组件，映射只能有一份，否则新增资源时两处必然漂）。
import { RESOURCE_VIEWS } from "../lib/resourceViews";

/**
 * 组 id → 组页视图（task-485：组变成注册表后，路由侧只需要这一张映射；
 * 没有映射的组**不注册路由**，而不是注册到某个兜底页 —— 后者会让「有组名、点进去空」重现）。
 */
const SETTINGS_GROUP_VIEWS: Record<string, () => Promise<unknown>> = {
    "model-config": () => import("../views/settings/ModelConfigView.vue"),
    "agent-config": () => import("../views/settings/AgentConfigView.vue"),
};

/**
 * task-96（用户裁定「智能体是组织成员，不是资源」）：资源区不再有智能体页 ⇒ 旧 URL **302** 到新家。
 *
 * <p><b>为什么 302 写在本文件、不写 `lib/legacyRoutes.ts`</b>：那个文件的自述语义是「一次性删除、
 * 不留 redirect」（决策 10，用户 2026-11-12），消费者 `router/__tests__/legacy-paths.spec.ts` 与
 * `e2e/mock/resources-ia.spec.ts` 都按「旧资源路径必须 404」断言。一个文件同时承担两种相反语义，
 * 下一个人必然挑对自己方便的那条。302 的既有先例全在本文件（`instance/agent-profile`、
 * `workspace-default/agent-templates`、`tool-faces`），本条与它们同形。</p>
 *
 * <p><b>分流口径</b>（三条落点由 `task-91` 建成）：</p>
 * <ul>
 *   <li>`?layer=INSTANCE` ⇒ 实例层「平台智能体」页（`settings-instance-agent-principals`）；</li>
 *   <li>`?layer=WORKSPACE` ⇒ 该工作区的成员页（智能体在工作区侧一直是**成员/绑定**面）。
 *       workspaceId 先取 `?workspaceId=`（历史深链可能带），再回退页签上下文
 *       （`readTabWorkspaceId()` = sessionStorage `xihe-workspace`，`lib/workspaceContext.ts:33`）；
 *       **两者都没有时不猜工作区**，回组织成员页；</li>
 *   <li>其余（缺省 / `?layer=USER` / 非法值）⇒ 组织成员页（资源侧默认层就是 `USER`，且用户
 *       2026-11-14 ④ 已裁定「智能体个人属于成员管理，并不是在设置域里面」）。</li>
 * </ul>
 *
 * <p>**不返回 404**：这些 URL 在文档、e2e 与用户书签里都存在，404 的支持成本高于一次跳转 ——
 * 与 `agent-profile` 那条（下方 `instance/agent-profile`）同一理由。</p>
 */
function agentResourceLocation(to: { query: Record<string, unknown> }): RouteLocationRaw {
    const raw = typeof to.query.layer === "string" ? to.query.layer.toUpperCase() : "";
    // 旧 query **必须显式清空**（task-97 裁定 A，2026-11-15）：vue-router 4 的
    // `handleRedirectRecord` 是 `assign({ query: to.query, hash: to.hash }, newTargetLocation)`
    // （`node_modules/vue-router/dist/vue-router.js`，`[源码]`）⇒ 返回值**不带 query 键时旧 query 会被继承**。
    // 不带的结果是 `/members?layer=USER`、`/workspace/<id>/members?workspaceId=<id>` 这类过期参数：
    // 既误导读者，落地页也可能自行解读 `?layer`（那就是另一条路径了）。所以三条出口都带 `query: {}`。
    if (raw === "INSTANCE") return { name: "settings-instance-agent-principals", query: {} };
    if (raw === "WORKSPACE") {
        const fromQuery = typeof to.query.workspaceId === "string" ? to.query.workspaceId : null;
        const workspaceId = fromQuery ?? readTabWorkspaceId();
        return workspaceId
            ? { path: "/workspace/" + workspaceId + "/members", query: {} }
            : { name: "org-members", query: {} };
    }
    return { name: "org-members", query: {} };
}

const router = createRouter({
    history: createWebHistory(),
    routes: [
        {
            path: "/",
            redirect: "/workbench",
        },
        {
            // task-34（原 task-228）：模块入口 /workspace → /workbench。**容器路由
            // `/workspace/:workspaceId/**` 不动**（工作区=容器层、工作台=模块层，两层标识符
            // 不再混用）。旧 URL 走 redirect 保留书签/文档深链，query/hash 原样透传（card ②(a)）。
            // 路径取 `WORKSPACE_PICKER_PATH`（task-111 / H4-c）：它是「显式进 picker」的唯一锚点，
            // 与 `isExplicitPickerEntry` 的判据同源 —— 两处各写字面量时改名不会红，只会让判据静默失效。
            path: WORKSPACE_PICKER_PATH,
            redirect: (to) => ({ path: "/workbench", query: to.query, hash: to.hash }),
        },
        {
            path: "/workbench",
            component: () => import("../layouts/AppLayout.vue"),
            meta: { requiresAuth: true },
            children: [
                {
                    path: "",
                    // 路由 name 保持 `workspace-home`：名字不是 URL，全仓 10+ 处
                    // `{ name: "workspace-home" }` 导航依赖它；改名的收益只是措辞。
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
                    // PLAN-0773 M4-4（task-190）：工作区内部二级导航的外壳。
                    // 子路由保持原有 name 与相对段，导航项由 `meta.workspacePage` 派生
                    // （`lib/workspacePages.ts` + `features/workspace/composables/useWorkspaceNav.ts`），
                    // 本文件是**页面清单的唯一来源**：加一页 = 加一条带 meta 的记录，导航自动跟上。
                    path: "",
                    component: () => import("../features/workspace/pages/WorkspaceShell.vue"),
                    children: [
                        {
                            path: "",
                            name: "workspace",
                            component: () =>
                                import("../features/workspace/pages/WorkspaceView.vue"),
                            meta: {
                                workspacePage: {
                                    // task-217：页 id 与页名都是「会话」——「工作台」是**模块层**名字（`sidebar.workbench`，D-924），
                                    // 不再当工作区内部的页名；id 是导航锚点与 testid 来源，必须和页名同心。
                                    id: "sessions",
                                    labelKey: "workspaceNav.sessions",
                                    order: 10,
                                    icon: LayoutGrid,
                                },
                            },
                        },
                        {
                            // 聊天页属于工作台容器内部（不进二级导航：它没有独立入口，
                            // 入口是会话列表），所以**不带** `meta.workspacePage`。
                            path: "chat/:sessionId",
                            name: "workspace-chat",
                            component: () =>
                                import("../features/workspace/pages/WorkspaceView.vue"),
                        },
                        {
                            path: "environment",
                            name: "workspace-environment",
                            component: () =>
                                import("../features/workspace/pages/WorkspaceEnvironmentView.vue"),
                            meta: {
                                workspacePage: {
                                    id: "environment",
                                    labelKey: "workspaceNav.environment",
                                    order: 20,
                                    icon: Server,
                                },
                            },
                        },
                        {
                            path: "scheduled-tasks",
                            name: "workspace-scheduled-tasks",
                            component: () =>
                                import("../features/workspace/pages/ScheduledTasksView.vue"),
                            meta: {
                                workspacePage: {
                                    id: "scheduled-tasks",
                                    labelKey: "workspaceNav.scheduledTasks",
                                    order: 30,
                                    icon: CalendarClock,
                                },
                            },
                        },
                        {
                            /**
                             * PLAN-0773 M4-2（task-210）：**本工作区**的资源页 —— 四个资源
                             * （技能 / MCP / 凭据 / 智能体），层**固定「本工作区」**，平台层与
                             * 用户层只作只读引用（链接到 `/resources/<id>?layer=`）。
                             *
                             * <p>资源清单**不在这里**：由 `RESOURCE_DEFS` 里「有 WORKSPACE 层」的资源
                             * 派生（`WorkspaceResourcesView.vue` 一个地方算），本文件只登记这一页。</p>
                             */
                            path: "resources",
                            name: "workspace-resources",
                            component: () =>
                                import("../features/workspace/pages/WorkspaceResourcesView.vue"),
                            meta: {
                                workspacePage: {
                                    id: "resources",
                                    labelKey: "workspaceNav.resources",
                                    // 动作面（设置）/边界位（资源）之间保持 order 空档：M4-3 的
                                    // 「成员」页预定 45，不重排既有 10/20/30/40。
                                    order: 35,
                                    icon: Boxes,
                                },
                            },
                        },
                        {
                            // task-253：工作区配置层已从 UI 移除（域段路由 /settings/:domain 随之退役）。
                            // PLAN-0773 M4-1 会把工作区层配置页加回来（本卡只做导航骨架）。
                            path: "settings",
                            name: "workspace-settings",
                            component: () =>
                                import("../features/workspace/pages/WorkspaceSettingsView.vue"),
                            meta: {
                                workspacePage: {
                                    id: "settings",
                                    labelKey: "workspaceNav.settings",
                                    order: 40,
                                    icon: Settings,
                                },
                            },
                        },
                        {
                            // PLAN-0773 M4-3（task-236）：成员从设置页 tab 提升为一级页。
                            // order 45 是 task-210 预留值：不重排既有 10/20/30/35/40。
                            path: "members",
                            name: "workspace-members",
                            component: () =>
                                import("../features/workspace/pages/WorkspaceMembersView.vue"),
                            meta: {
                                workspacePage: {
                                    id: "members",
                                    labelKey: "workspaceNav.members",
                                    order: 45,
                                    icon: Users,
                                },
                            },
                        },
                    ],
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
                /**
                 * task-227（用户 2026-11-13「合页，不合域」）：模型配置**组页** `/settings/<层>/model-config`。
                 *
                 * <p>三条刻意的取舍：①**只注册一次**（每个层一个组路由），而不是"重定向到某一段" ——
                 * 重定向会让"一页三段"退化成"一页一段 + 两次跳转"，正好违反判据；
                 * ②**三个域路由原样保留**（下面那三段 map 不动）：旧 URL 仍然直达单域页，
                 * 深层链接/书签/文档引用不失效；③**是否注册由矩阵算**（`modelConfigDomainsForLayer`
                 * 求交集，≥2 段才成组）—— D-1122 把工作区层的模型域整层下线后，那条路由会
                 * 自动消失，不需要再改这里。</p>
                 */
                ...SETTINGS_GROUPS.flatMap((group) =>
                    SETTINGS_LAYERS.flatMap((layer) => {
                        // 政策层：组在这层是否允许成组（D-1122 把模型组关在工作区层之外；
                        // task-485 把智能体组同样关在工作区层之外）—— 与矩阵链事实分开判。
                        if (!isSettingsGroupLayer(group.id, layer)) return [];
                        // 事实层：成员 < 2 不成组（点进去只有一段），与左栏 navItemsForLayer 同一条规则。
                        if (groupDomainsForLayer(group.id, layer).length < 2) return [];
                        const view = SETTINGS_GROUP_VIEWS[group.id];
                        if (!view) return [];
                        return [
                            {
                                path: `${layer}/${group.id}`,
                                name: `settings-${layer}-${group.id}`,
                                component: view,
                                props: { layer },
                                meta: { settingsLayer: layer, settingsGroup: group.id },
                            },
                        ];
                    }),
                ),
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
                // WORKSPACE_WRITABLE 镜像 —— D-1122 / T2.4 后是 **4 个 UI 域**（4 个行为域；
                // service-only 的 context-templates 不在 config API 里）。模型 4 域已退出该层，
                // 所以它们的 `/settings/workspace-default/<域>` **不再注册**（不是注册了再 400）。
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
                /**
                 * task-485 / task-226 D4（用户 2026-11-14 ④「智能体个人属于成员管理，并不是在设置域
                 * 里面」）：`agent-profile` 撤出设置区 ⇒ 旧深层链接 **302 到成员管理**，不做 404。
                 *
                 * <p>为什么必须 302：旧 URL 在文档、e2e 与用户书签里都在（`settingsIa.spec.ts` 曾断言
                 * 这条路径存在）；404 会变成「点了没反应/白屏」的支持成本。与既有先例同形
                 * （`?tab=members` → 成员页、`tool-faces` → approval-policy 页签）。</p>
                 */
                {
                    path: "instance/agent-profile",
                    redirect: { name: "org-members" },
                },
                {
                    path: "user/agent-profile",
                    redirect: { name: "org-members" },
                },
                /**
                 * task-485 ①：`agent-templates` 撤出工作区层 ⇒ `/settings/workspace-default/agent-templates`
                 * 已经没有页（矩阵里没有这一格），但旧书签/document 链接仍在 ⇒ **302 到它的新家**
                 * （智能体配置组页，实例层），不做 404。
                 *
                 * <p>为什么新落点是**实例层**而不是用户层：模板与角色是**治理物**（实例层发布、全工作区
                 * 引用），用户层那份是个人副本；从"工作区默认层曾经能写模板"这条路径进来的人，意图是
                 * 治理面。若他不具备实例层权限，落点是既有的 403 视图（与任何实例层深链一致），
                 * 不是白屏 404 —— 两者的支持成本不同，这是本卡判据 2 原文的要求。</p>
                 */
                {
                    path: "workspace-default/agent-templates",
                    redirect: { name: "settings-instance-agent-config" },
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
                /**
                 * task-91（用户裁定「智能体是组织成员，不是资源」）：平台智能体的新家。
                 *
                 * <p>与 `monitoring` / `data` 同形：不是配置域，路径不进 `LAYER_DOMAINS`。
                 * 资源区的 `/resources/agents?layer=INSTANCE` 在下一卡摘除时，按既有先例
                 * （`user/agent-profile` 等三条）**在这里的父级写 302**，而不是把重定向塞进
                 * `lib/legacyRoutes.ts` —— 那个文件的自述语义是「一次性删除、不留 redirect」。</p>
                 */
                {
                    path: "instance/agent-principals",
                    name: "settings-instance-agent-principals",
                    component: () => import("../views/settings/InstanceAgentsView.vue"),
                    meta: { settingsLayer: "instance" },
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
             * PLAN-0773 M3（task-240，Lead 2026-11-13 裁 (a) 全局模块落点）：组织成员页。
             * 实例级面（org-units 契约明写 org 与 workspace 平行、不过滤工作区），进全局
             * rail 第 4 项；与工作区容器页 /workspace/:id/members（成员资格面，task-236）
             * 是两个面、两条入口，不互相挂载。GlobalRail 在 App.vue 全局渲染，本页不带工作区
             * 上下文。当前只读：写面（M3-3）按钮禁用 + 说明。
             */
            path: "/members",
            name: "org-members",
            component: () => import("../features/org-members/pages/OrgMembersView.vue"),
            meta: { requiresAuth: true },
        },
        {
            /**
             * PLAN-0772 M2（design.md 目标 1 + 决策 10）：资源面独立成**第三个顶层入口**。**
             *
             * <p>旧资源入口（原先挂在 `/settings/**` 下的凭据 / MCP / 技能 / 智能体 / 知识库）
             * **一次性删除、不留 redirect** —— 用户 2026-11-12 裁定「不用考虑旧的兼容性，要改就全改，
             * 一次性改」。留着 redirect 会留下两套路径语义，日后没人敢删；删干净则是**可判定**的
             * 完成判据（`git grep` 归 0）。</p>
             *
             * <p><b>具体是哪几条不在这里重复</b>：清单的**唯一单源**是
             * `src/lib/legacyRoutes.ts` 的 `LEGACY_RESOURCE_PATHS`（`task-315` 收口 `297` 缺口 3 ——
             * 此前这段注释与 unit 守卫、e2e 404 负断言三处手抄，任一处漏改就静默过期）。
             * 要新增"已删除路径"，改那个模块即可，两个车道的判据会同时跟上。</p>
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
                /**
                 * 资源详情单页（task-228）：`/resources/<id>/:pk`，`pk` 在**资源 + 层**内唯一。
                 *
                 * <p>为什么按资源展开成 4 条而不是一条通用 `:resourceId` 路由：`ResourcesLayout`
                 * 只从**静态** `meta.resourceId` 求资源（层 tab / 面包屑 / 左栏高亮全靠它），
                 * 一条参数化路由会让布局在 meta 缺失时掉回默认资源（`credentials`），
                 * 于是 `/resources/skills/x` 的层 tab 会画成凭据的 —— 静态展开则 typecheck 可查漏项。</p>
                 */
                ...RESOURCE_DEFS.filter((def) => (def.gaps ?? []).length === 0).map((def) => ({
                    path: resourceDetailRoutePath(def.id),
                    name: resourceDetailRouteName(def.id),
                    component: () => import("../views/resources/ResourceDetailView.vue"),
                    meta: { resourceId: def.id },
                    beforeEnter: normalizeResourceLayerQuery(def.id),
                })),
                {
                    // 缺口资源（G3）的可读落点：不伪装成可管理页面，只解释缺口并给出口。
                    path: "knowledge",
                    name: "resources-knowledge",
                    component: RESOURCE_VIEWS.knowledge,
                    meta: { resourceId: "knowledge" },
                },
                {
                    /**
                     * 知识库**没有实体、没有列表行、没有详情**（G3：CP 无表、无 CRUD）。
                     *
                     * <p>仍注册一条详情落点而不是让它掉进 404：深链 `/resources/knowledge/<任意>` 要
                     * 给出**明确的"没有详情面"解释**（诚实态），而不是"这条路由不存在"的误导 ——
                     * 用户点到的明明是资源区里真实存在的资源。`beforeEnter` 与其它详情一致，
                     * 把 `?layer=` 规范化（knowledge 无层 ⇒ 恒回落 `WORKSPACE`）。</p>
                     */
                    path: resourceDetailRoutePath("knowledge"),
                    name: resourceDetailRouteName("knowledge"),
                    component: () => import("../views/resources/ResourceDetailView.vue"),
                    meta: { resourceId: "knowledge" },
                    beforeEnter: normalizeResourceLayerQuery("knowledge"),
                },
                /**
                 * task-96：资源区的智能体页已摘除（用户裁定「智能体是组织成员，不是资源」）。
                 * 旧 URL 302 到新家（分流见 `agentResourceLocation`）；**详情**也 302 到列表级落点 ——
                 * 详情页没有独立新家，让书签落到列表比 404 好。
                 *
                 * <p>两条都必须显式写在这里：列表与详情原先由 `RESOURCE_DEFS` **派生**，摘除定义后
                 * 它们会连同路由一起消失，留下的 URL 就变成 404 —— 而 404 洽洽是本卡要避免的那件事。</p>
                 */
                {
                    path: "agents",
                    redirect: (to) => agentResourceLocation(to),
                },
                {
                    path: "agents/:pk",
                    redirect: (to) => agentResourceLocation(to),
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
            // task-373 / `D-1228` + `D-1236`：独立会话（无工作区）的聊天页。
            // **不是**工作区路由的复活：没有 workspaceId 段、不写 tab 工作区上下文、
            // 不带工作区 chrome（页签栏/文件树/dock 都属于工作区）。`ChatPanel` 只吃
            // sessionId，所以这里复用它，toolMode 保持默认 none（无工作区 ⇒ 无文件上下文）。
            path: "/chat/:sessionId",
            component: () => import("../layouts/AppLayout.vue"),
            meta: { requiresAuth: true },
            children: [
                {
                    path: "",
                    name: "standalone-chat",
                    component: () => import("../views/chat/StandaloneChatView.vue"),
                },
            ],
        },
        {
            // Legacy bookmarks recover to the Workspace-first landing instead of a
            // blank unmatched-route view. (`/chat/:sessionId` is a real route again
            // since task-373 — it now means a workspace-less Session.)
            path: "/:pathMatch(.*)*",
            redirect: "/workbench",
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
        isEntryRouteName(to.name) &&
        shouldBounceEntryToWorkspace(Boolean(token), localStorage.getItem("xihe-user") !== null)
    ) {
        // task-224 档 3（守卫语义，**行为变更**）：旧判据是"localStorage 里有 token 就弹走"，
        // 于是半个会话（token 残留、user 已没了，或 token 早已过期但没被校验）也会被当成
        // 已登录弹进 /workspace —— 那正是"12 个并发 401"的起点。新判据要求**会话材料齐备**
        // （token + 缓存 user 都在）才让路；不齐备就停在入口页，用户看见的是登录表单而不是
        // 一次进站即被踢出的闪烁。
        // 影响面（显式记录）：完整会话下"已登录误访问 /login"的体验**不变**（照旧弹 /workspace）；
        // 变的是残 token 场景 —— 现在停在登录页。登录成功仍由 `LoginView` 消费 `?redirect=`。
        return { path: "/workbench" };
    }

    if (token) {
        const routeWorkspaceId =
            typeof to.params.workspaceId === "string" ? to.params.workspaceId : "";
        if (routeWorkspaceId && !isUuid(routeWorkspaceId)) {
            // task-537：**先验形状再写上下文**。之前把非 UUID 直接写进 tab 上下文，
            // 孩子们的首个请求就带着它出去，CP 400（`X-Workspace-Id must be a UUID`），
            // 页面只剩左栏空态 —— 把「错」伪装成「空」。这里清掉上下文并回工作区列表，
            // 由列表页给出明确文案（
            // `?invalidWorkspace=1`），所以既不发明知会失败的请求，也不进死路。
            clearTabWorkspace();
            return { name: "workspace-home", query: { invalidWorkspace: "1" } };
        }
        if (routeWorkspaceId) {
            // Set the tab workspace before child components issue their first
            // request; WorkspaceView then validates access with CP.
            writeTabWorkspaceId(routeWorkspaceId);
        } else if (to.name === "workspace-home") {
            const tabWorkspaceId = readTabWorkspaceId();
            if (tabWorkspaceId) {
                return { path: `/workspace/${tabWorkspaceId}`, query: to.query };
            }
            // task-111 / H4-c（Lead 2026-11-17 裁定）：**显式导航到 picker 路由不是恢复入口**。
            // `/workspace` 经路由表 redirect 落到本条（`workspace-home`）时，用户要的就是选择面
            // —— 这时恢复等于劫持他的显式意图（被上一跳拖回某个会话，picker 不出现）。判据用
            // vue-router 挂的 `to.redirectedFrom`（重定向链上保留最初位置），释义见
            // `lib/lastLocation.ts#isExplicitPickerEntry`。命中 ⇒ 直接放行到 picker。
            // 反面**不许跟着废**：`/workbench` 冷启（无 `redirectedFrom`）等仍照旧恢复 —— 本分支
            // 是函数最后一个判定，`return true` 就是「不恢复」的完整语义。
            if (isExplicitPickerEntry(to)) return true;
            // task-111 / H1：**tab 上下文（sessionStorage，逐 tab）优先** —— 只有本 tab
            // 没有上下文时才读跨 tab 的上一跳（localStorage）。两个 tab 各停一处时，
            // 本 tab 重载必须回本 tab 的落点，不能被另一 tab 的最后写点拖走。
            // `resolveLastLocationTarget` 对坏值 fail-closed（非 UUID 不恢复），不会把
            // 守卫弹进 invalid-workspace 反弹。
            const restored = resolveLastLocationTarget(readLastLocation());
            if (restored) {
                return { path: restored, query: to.query };
            }
        }
    }

    return true;
});

/**
 * task-111 / D-1754 ①：上一跳（`xihe-last-location`）的**唯一写点**。
 *
 * 写点必须是 `afterEach`（卡面 H2）：导航被守卫 redirect 时（非 UUID 深链、入口
 * 弹走等），`afterEach` 只对**真正落地**的那次导航触发 —— redirect 目标不会被记成
 * 上一跳；写点若在 `beforeEach`，被弹走的深链目标会先被写下来，冷启恢复就会撞回
 * 那个根本到不了的目标。哨兵：`plan-0608-browser.spec.ts`（只读，不许编辑）。
 */
router.afterEach((to, _from, failure) => {
    // 取消/重复（duplicated）的导航没有「到达」新位置，不写。
    if (failure) return;
    const entry = lastLocationForRoute(to);
    if (entry) writeLastLocation(entry);
});

export default router;
