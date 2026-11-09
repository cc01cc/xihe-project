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

/** 设置区可出现的层。工作区层的路由段不同（`/workspace/:id/settings/:domain`）。 */
export type SettingsLayer = ConfigLayer;

export const SETTINGS_LAYERS: readonly SettingsLayer[] = ["instance", "user", "workspace"];

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

/** 某域在哪些层可写（顺序：instance → user → workspace，与 LAYER_DOMAINS 一致）。 */
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
    if (path.startsWith("/workspace/")) return "workspace";
    return path.startsWith("/settings/user") ? "user" : "instance";
}

/** 全局设置页的域路径（只有 instance / user 两层进 `/settings`）。 */
export function settingsDomainPath(
    layer: Exclude<SettingsLayer, "workspace">,
    domain: ConfigDomain,
): string {
    return `/settings/${layer}/${domain}`;
}

/** 工作区层域路径（工作区上下文在路径段里，不再加层段）。 */
export function workspaceSettingsDomainPath(workspaceId: string, domain: ConfigDomain): string {
    return `/workspace/${encodeURIComponent(workspaceId)}/settings/${domain}`;
}

/** 层默认页：实例层与非管理员都落到矩阵里的第一个域。 */
export function defaultLayerPath(layer: Exclude<SettingsLayer, "workspace">): string {
    const first = LAYER_DOMAINS[layer][0];
    return first ? settingsDomainPath(layer, first) : "/settings/user/llm-provider";
}

export interface SettingsNavItem {
    id: string;
    labelKey: string;
    path: string;
    /** 缺口项：只显示但标「缺口」，不伪装成可用入口（design.md §3.2 / G1/G3）。 */
    gap?: boolean;
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
