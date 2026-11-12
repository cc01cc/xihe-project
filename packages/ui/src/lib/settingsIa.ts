import {
    INSTANCE_DOMAINS,
    LAYER_DOMAINS,
    type ConfigDomain,
    type ConfigLayer,
} from "../stores/config";

/**
 * PLAN-0752 M1 骨架的纯逻辑层：层 × 域矩阵、路由解析、左栏分组。
 *
 * <p>为什么单独成模块（task-66）：路由注册、左栏、404 判定三处必须用**同一份**矩阵，
 * 否则"左栏能看到但路由 404"这类不一致会随域分批实施反复出现。矩阵本身不在前端另造：
 * `LAYER_DOMAINS`（stores/config）已是 CP `ConfigService.java:90-96` 两组白名单的镜像
 * （实例 12 / 用户 9 / 工作区 9），本模块只做**查询与分组**。</p>
 *
 * <p>注意 `logging` 只有实例层：CP 的 `WORKSPACE_WRITABLE_DOMAINS` 不含它，
 * 所以工作区层是 9 域而不是 10（design.md §3.2，2026-11-10 修正）。</p>
 */

/**
 * 设置区可出现的层。task-253（用户 2026-11-10 裁定）：**全局设置只有实例 / 用户两层**，
 * 工作区设置在各工作区内部、本轮不设计，因此这里不再有 workspace 层 ——
 * 层是路由（/settings/instance/**、/settings/user/**），不是 UI 状态。
 */
export type SettingsLayer = ConfigLayer;

/**
 * 全局设置可出现的三层。PLAN-0766（task-160）：在实例/用户两层之间插入共享的
 * `workspace-default` 层（wire 值与路由段同名，小写）。它不是 per-workspace 层
 * （那层已由 task-253 从 UI 退役），而是部署级的一份默认值行集：对没有显式 workspace
 * 覆盖的所有工作区生效，可读任意已认证用户、可写仅 `MANAGE_WORKSPACE_DEFAULT_CONFIG`
 * 持有者（能力原子求值，不是角色名判断）。
 */
export const SETTINGS_LAYERS_LOW_TO_HIGH: readonly SettingsLayer[] = [
    "instance",
    "user",
    "workspace-default",
];

/**
 * **显示顺序 = 层进顺序（低 → 高，当前层在最后）**：instance → user → workspace-default。
 *
 * task-77：唯一真相在上面那个 `SETTINGS_LAYERS_LOW_TO_HIGH`（低 → 高：instance < personal <
 * workspace-default，与 `LlmDefaultProfilePanel` 的取值优先级
 * `workspace > workspace-default > personal > instance` 同义）。左栏自上而下就是升序，
 * 所以这里只做一次拷贝 —— **禁止**在本文件或渲染处再手写第二份字面量数组；右栏徽标要
 * 高 → 低显示时，由消费方对这个数组取反序。
 */
export const SETTINGS_LAYERS: readonly SettingsLayer[] = [...SETTINGS_LAYERS_LOW_TO_HIGH];

/** 用户层不可写的域（= 用户层矩阵里没有的那些）：logging / approval-policy / job-policy。 */
export function isInstanceOnlyForUser(domain: ConfigDomain): boolean {
    return !LAYER_DOMAINS.user.includes(domain);
}

/** 域的本地化 key（左栏、面包屑、域页 h2 共用）。 */
export const DOMAIN_LABEL_KEY: Record<ConfigDomain, string> = {
    "llm-provider": "settings.domainLlmProvider",
    "context-policy": "settings.domainContextPolicy",
    embedding: "settings.domainEmbedding",
    rag: "settings.domainRag",
    "agent-runtime": "settings.domainAgentRuntime",
    "agent-profile": "settings.domainAgentProfile",
    "user-preference": "settings.domainUserPreference",
    logging: "settings.domainLogging",
    "approval-policy": "settings.domainApprovalPolicy",
    "agent-templates": "settings.domainAgentTemplates",
    "api-request-templates": "settings.domainContextTemplates",
    "job-policy": "settings.domainJobPolicy",
};

export type ResolveLayerRouteResult =
    | { ok: true; layer: SettingsLayer; domain: ConfigDomain }
    | { ok: false; reason: "unknown-layer" | "unknown-domain" | "domain-not-in-layer" };

export function isSettingsLayer(value: unknown): value is SettingsLayer {
    return typeof value === "string" && (SETTINGS_LAYERS as readonly string[]).includes(value);
}

export function isConfigDomain(value: unknown): value is ConfigDomain {
    return typeof value === "string" && (INSTANCE_DOMAINS as readonly string[]).includes(value);
}

/** 某域在哪些层可写（**顺序 = 显示顺序（高 → 低）**，与左栏组顺序同源：`SETTINGS_LAYERS`）。 */
export function layersForDomain(domain: ConfigDomain): SettingsLayer[] {
    return SETTINGS_LAYERS.filter((layer) => LAYER_DOMAINS[layer].includes(domain));
}

export function domainsForLayer(layer: SettingsLayer): readonly ConfigDomain[] {
    return LAYER_DOMAINS[layer];
}

/** 该域在该层是否存在于矩阵里（不存在 ⇒ 路由不注册 ⇒ 404，V3/V25）。 */
export function domainRouteExists(layer: unknown, domain: unknown): boolean {
    return resolveLayerRoute(layer, domain).ok;
}

/**
 * 路由参数 → 域。三处（路由注册 / 左栏 / 404 兜底）共用，纯函数便于单测。
 *
 * <p>返回 `reason` 而不是布尔，是为了让 404 视图能区分"层不认识"与"域不认识"，
 * 也给后续 M2 的 T2.3（logging 在 user 层）留可读的错误分类。</p>
 */
export function resolveLayerRoute(layer: unknown, domain: unknown): ResolveLayerRouteResult {
    if (!isSettingsLayer(layer)) return { ok: false, reason: "unknown-layer" };
    if (!isConfigDomain(domain)) return { ok: false, reason: "unknown-domain" };
    if (!domainRouteExistsInMatrix(layer, domain)) {
        return { ok: false, reason: "domain-not-in-layer" };
    }
    return { ok: true, layer, domain };
}

function domainRouteExistsInMatrix(layer: SettingsLayer, domain: ConfigDomain): boolean {
    return LAYER_DOMAINS[layer].includes(domain);
}

/**
 * 从 URL 路径反推层（V3/V25 的 404 兜底用）。
 *
 * <p>为什么需要它：`/settings/:pathMatch(.*)*` 这类兜底路由没有「层×域」参数，若给它写死
 * `meta.settingsLayer = "instance"`，`/settings/user/logging` 的 404 页会顶着「实例配置」的层标题
 * ——文案/左栏都对，只有层身份在说胡话（2026-11-10 量测实测，task-66 V03d/V03e）。
 * 层是外框，只有**一个**地方决定它：路由 meta 有则用，没有则从这里按路径推导。</p>
 */
export function settingsLayerForPath(path: string): SettingsLayer {
    if (path.startsWith("/settings/workspace-default")) return "workspace-default";
    return path.startsWith("/settings/user") ? "user" : "instance";
}

/**
 * 知识库旧路径 `/settings/knowledge` 的落点（PLAN-0752 T4.4 / task-91）。
 *
 * <p>知识库**只有工作区承载**（CP 无库表，数据按 `workspace_id` 分区），而这条 user 层路由没有
 * 任何导航指向它 —— 留着就是一个「点得到的用户层知识库」幽灵页。所以旧书签改成工作区重定向；
 * 没有当前工作区上下文时回工作区选择面，而不是把用户丢进一个空页。</p>
 */
export function knowledgeRedirectTarget(workspaceId: string | null): {
    name: string;
    params?: Record<string, string>;
    query?: Record<string, string>;
} {
    const trimmed = (workspaceId ?? "").trim();
    return trimmed
        ? {
              name: "workspace-settings",
              params: { workspaceId: trimmed },
              query: { tab: "knowledge" },
          }
        : { name: "workspace-home" };
}

/** 全局设置页的域路径（instance / workspace-default / user 三层都进 `/settings`）。 */
export function settingsDomainPath(layer: SettingsLayer, domain: ConfigDomain): string {
    return `/settings/${layer}/${domain}`;
}

/** 层默认页：实例层与非管理员都落到矩阵里的第一个域。 */
export function defaultLayerPath(layer: SettingsLayer): string {
    const first = LAYER_DOMAINS[layer][0];
    return first ? settingsDomainPath(layer, first) : "/settings/user/llm-provider";
}

/** PLAN-0766 T3.3：写 workspace-default 层的唯一能力原子（CP 用自己的 catalog 求值，UI 不复制名单）。 */
export const WORKSPACE_DEFAULT_CONFIG_ATOM = "MANAGE_WORKSPACE_DEFAULT_CONFIG";

export function isWorkspaceDefaultLayer(layer: SettingsLayer): boolean {
    return layer === "workspace-default";
}

export interface SettingsNavItem {
    id: string;
    labelKey: string;
    path: string;
    /** 缺口项：只显示但标「缺口」，不伪装成可用入口（design.md §3.2 / G1/G3）。 */
    gap?: boolean;
}

/**
 * 后端能力缺口代码：**唯一来源**是 `internal/A03-xihe/docs/resource-layer-permission-audit.md` §F
 * （G1–G7，逐条有现状证据）。前端只引用代码与一句话说明，不据此删入口——
 * 用户 2026-11-10 裁定 D7：**留位标缺口，不隐藏**（隐藏会让人以为能力不存在）。
 */
export type BackendGap = "G1" | "G2" | "G3" | "G4";

/**
 * 「资源」组的条目（不是配置域，走 `/settings/<name>` 或缺口说明）。
 *
 * <p>缺口项**没有 path**：点击不跳转、不给 404，弹出说明（与 mock v2 的
 * `blockedNoticeTitle/Body` 同一种做法：说明 + 不跳转 + 可关闭）。</p>
 */
export interface ResourceNavItem {
    id: string;
    labelKey: string;
    /** 该层有后端承载时给真实入口路径。 */
    path?: string;
    /** 缺口代码（空数组 = 通用缺口，audit §F 未单列，说明文字里写清缺什么）。 */
    gaps?: BackendGap[];
    /** 缺口说明 i18n key：一句话说清「缺什么 + 后端现状」。 */
    gapNoteKey?: string;
}

/**
 * 实例层「资源」组（design §3.2 第 2 行；task-165 起 **4 条真入口 + 1 个缺口位**）。
 *
 * <p>四条与 audit §F 的对应：MCP=G1（表 `workspace_id NOT NULL` 无实例/用户层）、
 * 凭据=G2（`owner_type` 只有 USER/WORKSPACE）、知识库=G3（CP 无库实体、只有 4 个代理端点）、
 * 智能体=G4（CP 无 tools/agent 注册实体，只有分类与工作区绑定）。</p>
 *
 * <p><b>task-165（D-1006/D-1007/D-1008/D-1009）把 G1/G2/G4 转真</b>：`owner_type` 增
 * `INSTANCE`（D-1007）、wire 采 `/api/v1/instance/<资源>`（D-1008）、实例凭据存在且只服务实例级
 * 资源（D-1009）。⇒ 按 skills 的先例「**转真就摘缺口**」：去掉 `gaps`/`gapNoteKey`、给真
 * `path`，条目从「虚线徽标灰显」变成 `router-link`（形态由 `SettingsResourceNav` 决定，
 * 本函数只给结构）。<b>矩阵不受影响</b>：资源面不是配置域，`LAYER_DOMAINS`/`INSTANCE_DOMAINS`
 * 仍 12 项（D-1006 B6）。</p>
 *
 * <p>知识库（G3）仍是缺口：CP 没有库实体、只有 4 个代理端点 ⇒ 继续留位标缺口（D7：留位不隐藏）。</p>
 */
export function instanceResourceGroup(): ResourceNavItem[] {
    return [
        {
            /**
             * task-88（用户裁定 A：留着、改名、并且要实现掉）：
             *
             * <p><b>名字为什么分开</b>：实例层 = **全平台可用**的那批智能体（平台智能体 / Platform agents）；
             * 用户层 = **你个人的主体身份**（`agent-principals` / 智能体主体）。两者曾共用「智能体」
             * 一个词，于是左栏出现两个都叫「智能体」的条目 —— 用户报的重名病就是它。</p>
             *
             * <p><b>不要也叫 "Agent principals"</b>：那正是要消掉的重名（用户层已经有 `agent-principals`）。</p>
             *
             * <p><b>为什么 id 仍是 `agents`</b>：`id` 决定 `data-testid`（`settings-nav-resource-agents`、
             * `settings-nav-resource-gap-agents`）与缺口弹窗的锚点；改 id 会牵动 E2E 与断言，收益为零。
             * 文字与 id 解耦，改名只动 i18n。</p>
             *
             * <p><b>task-165</b>：D-1006 B4 落了平台智能体模型（全局可见、无需逐工作区绑定、仅
             * instance admin 可建），实例级注册表走 `/api/v1/instance/agents` ⇒ G4 转真，摘缺口。</p>
             */
            id: "agents",
            labelKey: "settings.ia.resourceAgents",
            path: "/settings/instance/agents",
        },
        {
            // task-165：D-1006 B5 实例 MCP 注册表 + 与工作区级「继承/工作区覆盖同名」，
            // wire 走 `/api/v1/instance/mcp`（D-1008）⇒ G1 转真，摘缺口。
            id: "mcp",
            labelKey: "settings.ia.resourceMcp",
            path: "/settings/instance/mcp",
        },
        {
            // task-165：D-1007 给 `owner_type` 增 `INSTANCE`（实例行 `owner_id` 为空）、
            // D-1009 定「实例凭据存在、只服务实例级资源、不可由个人凭据提升」，
            // wire 走 `/api/v1/instance/credentials`（D-1008，含 `{id}/reveal`）⇒ G2 转真，摘缺口。
            id: "credentials",
            labelKey: "settings.ia.resourceCredentials",
            path: "/settings/instance/credentials",
        },
        {
            // task-83：**不是缺口** —— 这是四类实例资源里唯一后端已就绪的一项：
            // `GET /api/v1/skills` 的 `definitionScope` 默认就是 `instance`，openapi 原文
            // 「Instance-scope definitions are visible to every authenticated caller」；
            // `/skills/{skillId}`、`/skills/{skillId}/bindings`、`/skills/import` 也都在（PLAN-0628/0680）。
            // 所以给**真入口**，不带 `gaps`/`gapNoteKey` —— 与用户层 `agent-principals`
            // 「转真就摘缺口」的写法保持一致，不沿用灰显那一套（缺口机制本身仍供 knowledge-mcp 留位）。
            id: "skills",
            labelKey: "settings.ia.resourceSkills",
            path: "/settings/skills",
        },
        {
            id: "knowledge",
            labelKey: "settings.ia.resourceKnowledge",
            gaps: ["G3"],
            gapNoteKey: "settings.ia.gapNoteKnowledge",
        },
    ];
}

/**
 * 用户层「我的资源」组（design §3.2 第 4 行：3 条目 = 智能体主体 / 我的凭据 / 知识库·MCP）。
 *
 * <p>承载状态（PLAN-0750 M3 之后）：</p>
 * <ul>
 *   <li><b>智能体主体</b>——真入口 `/settings/agent-principals`。用户级创建走 `CREATE_OWN_AGENT`
 *       无工作区上下文（矩阵 U1），列表走 `GET /agent-principals` 无 `workspaceId` 的个人视图
 *       （R3：只回 `created_by=self`）。**不再是缺口**，所以去掉 `gaps`/`gapNoteKey`。</li>
 *   <li><b>我的凭据</b>——真入口 `/settings/credentials`（`owner_type=USER`）。</li>
 *   <li><b>知识库·MCP</b>——仍是 G1/G3 缺口，按 D7 留位。</li>
 * </ul>
 * <p>注意：缺口机制本身不能因为本项转真就去掉——`knowledge-mcp` 仍靠它留位（D7：留位标缺口，
 * 不隐藏）。</p>
 */
export function userResourceGroup(): ResourceNavItem[] {
    return [
        {
            id: "agent-principals",
            labelKey: "settings.ia.resourceAgentPrincipals",
            path: "/settings/agent-principals",
        },
        {
            id: "my-credentials",
            labelKey: "settings.ia.resourceMyCredentials",
            path: "/settings/credentials",
        },
        {
            id: "knowledge-mcp",
            labelKey: "settings.ia.resourceKnowledgeMcp",
            gaps: ["G1", "G3"],
            gapNoteKey: "settings.ia.gapNoteKnowledgeMcp",
        },
    ];
}

export interface SettingsNavGroup {
    id: string;
    labelKey: string;
    items: SettingsNavItem[];
}

/**
 * 实例层运维与安全两组（不属于配置域，路由是 `/settings/<name>`）。
 * 可见性在组件里按 capability/atom 过滤——本函数只给"结构"，不给"权限"。
 */
export function instanceOpsGroups(): SettingsNavGroup[] {
    return [
        {
            id: "ops",
            labelKey: "settings.ia.groupOps",
            items: [
                {
                    id: "monitoring",
                    labelKey: "settings.ia.navMonitoring",
                    path: "/settings/monitoring",
                },
                { id: "data", labelKey: "settings.ia.navData", path: "/settings/data" },
            ],
        },
        {
            id: "security",
            labelKey: "settings.ia.groupSecurity",
            items: [
                {
                    id: "config-locks",
                    labelKey: "settings.ia.navConfigLocks",
                    path: "/settings/config-locks",
                },
                { id: "roles", labelKey: "settings.ia.navRoles", path: "/settings/roles" },
                { id: "audit", labelKey: "settings.ia.navAudit", path: "/settings/audit" },
            ],
        },
    ];
}
