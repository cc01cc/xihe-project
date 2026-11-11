import {
    BookOpenText,
    Bot,
    Database,
    Gauge,
    KeyRound,
    Languages,
    LayoutTemplate,
    LockKeyhole,
    MessageSquare,
    ScrollText,
    ShieldCheck,
    SlidersHorizontal,
    Sparkles,
    UserCog,
    Wrench,
} from "@lucide/vue";
// 域全集与派生计数只在 `data/all-domains.ts` 一处（此前有两处各拼一份 ⇒ 必然漂；旧双拼实现已随 38c5b833 删除）
import { badgeOf } from "./data/all-domains";
// task-121 ①：**清单**不再手写 —— 层/域矩阵与资源、运维分组的唯一正文在 `lib/settingsIa.ts`。
// 2026-11-11 用户亲审：「用户层的域怎么就这么几个？」—— 稿上手写 4 条，真值 9 域 + 3 资源 = 12。
import {
    domainsForLayer,
    instanceOpsGroups,
    instanceResourceGroup,
    userResourceGroup,
} from "@/lib/settingsIa";

/**
 * Mock data for the task-233 sheets.
 *
 * Counts are the **CP matrix facts** already used by `src/lib/settingsIa.ts` (instance 12
 * domains + 2 ops + 3 security), re-stated here so these sheets do not depend on that module's
 * `SettingsLayer` shape. Nothing is invented; nothing is fetched.
 */
export interface NavItem {
    id: string;
    label: string;
    icon: typeof Wrench;
    badge?: string;
    // 示例，非真实名单；真实缺口以 settings-ui-issue-inventory N-09 / C-01 为准
    /**
     * 后端缺口（settings-ui-issue-inventory N-09）：**这个能力本身不存在**，不是「本域没配」。
     * 渲染成禁用 + 右侧「后端缺口」文字标记——不能只靠变淡区分（灰度截图下就分不出来了）。
     */
    gap?: boolean;
    /** 能力存在但本层 0 项配置（C-01）：可点，右侧「未配置」虚线标记。 */
    unconfigured?: boolean;
}

const ICONS: Record<string, typeof Wrench> = {
    "llm-provider": Sparkles,
    "context-policy": MessageSquare,
    embedding: Database,
    rag: BookOpenText,
    "agent-runtime": Bot,
    "agent-profile": UserCog,
    "user-preference": Languages,
    logging: ScrollText,
    "approval-policy": ShieldCheck,
    "agent-templates": LayoutTemplate,
    "api-request-templates": SlidersHorizontal,
    "job-policy": Gauge,
    monitoring: Gauge,
    data: Database,
    "config-locks": LockKeyhole,
    roles: ShieldCheck,
    audit: ScrollText,
    "agent-principals": Bot,
    "my-credentials": KeyRound,
    "knowledge-mcp": Database,
    // 实例层资源组的 4 个缺口位 id 来自 `instanceResourceGroup()`（agents/mcp/credentials/knowledge）——
    // 与用户层那 3 条 id 不同名，所以两张表都要有，否则 `missingNavMeta` 会把它们记成「无图标」。
    agents: Bot,
    mcp: Wrench,
    credentials: KeyRound,
    knowledge: Database,
};

const LABELS: Record<string, string> = {
    "llm-provider": "LLM 提供商",
    "context-policy": "上下文策略",
    embedding: "向量化",
    rag: "RAG 检索",
    "agent-runtime": "智能体执行参数",
    "agent-profile": "智能体档案",
    "user-preference": "偏好设置",
    logging: "日志",
    "approval-policy": "审批策略",
    "agent-templates": "智能体模板",
    "api-request-templates": "API 请求模板",
    "job-policy": "任务策略",
    monitoring: "监控",
    data: "数据管理",
    "config-locks": "配置锁定",
    roles: "角色与权限",
    audit: "审计日志",
    "agent-principals": "智能体账号",
    "my-credentials": "我的凭据",
    "knowledge-mcp": "知识库 / MCP",
    agents: "智能体",
    mcp: "MCP 服务",
    credentials: "凭据",
    knowledge: "知识库",
};

/**
 * 缺展示元数据的条目 id（生成后有条目、但 ICONS/LABELS 里没有它）。
 *
 * <p>为什么要有这个数组：**console.warn 在截图评审时等于不存在**（Lead 2026-11-11 ⑨'）。
 * 生成式清单一旦多出一条新域而没有图标，评审者只能从页面上看见「N 条无图标」才能发现，
 * 而不是等下一次有人读控制台。</p>
 */
export const missingNavMeta: string[] = [];

function item(id: string, badge?: string, state?: Partial<NavItem>): NavItem {
    const label = LABELS[id];
    const icon = ICONS[id];
    if (!label || !icon) missingNavMeta.push(id);
    return { id, label: label ?? id, icon: icon ?? Wrench, badge, ...state };
}

const OPS_GROUPS = instanceOpsGroups();

/** 取某个运维/安全分组下的条目（分组不存在时返回空数组，不抛错——稿子不该因产品分组改名而白屏）。 */
function groupItems(groupId: string): NavItem[] {
    const group = OPS_GROUPS.find((candidate) => candidate.id === groupId);
    return (group?.items ?? []).map((nav) => item(nav.id));
}

/**
 * 实例层 12 个配置域（CP `UI_DOMAINS` 全集，见 `ConfigService.java:76-79`）。
 *
 * **计数由数据派生，不是从产品截图抄的**（2026-11-11 裁定 B）：
 * `fieldCountOf()` 数 `domains-*.ts` 里真实存在的 `groups[].fields[]`；
 * 某域数据还没落地时渲染 **`—`**，**不渲染 0**（0 会被读成「这个域没有配置项」，是另一种假信息）。
 * 每个域的数据落地后，那个数字自动变真 —— 不需要再批量改一遍。
 */
// 徽标文本由 `data/all-domains.ts` 的 `badgeOf()` 派生（面板域量资源条数 / 表单域量配置项数 /
// 数据未落地渲染 `—`），这里不再保留第二份实现。

// **生成式**：id 只来自 `domainsForLayer("instance")`（= LAYER_DOMAINS.instance），不在此重列。
export const domains: NavItem[] = domainsForLayer("instance").map((domain) =>
    item(domain, badgeOf(domain)),
);

// 运维/安全组同样**生成**：分组名与条目的唯一正文是 `instanceOpsGroups()`。
// 两条状态标记属**示例数据**（「数据管理未配置」「审计日志后端缺口」），产品里由真实数据决定。
export const opsItems: NavItem[] = groupItems("ops").map((nav) =>
    nav.id === "data" ? { ...nav, unconfigured: true } : nav,
);
export const securityItems: NavItem[] = groupItems("security").map((nav) =>
    nav.id === "audit" ? { ...nav, gap: true } : nav,
);
/** 实例层「资源」组：4 条全缺口（G1–G4），生成自 `instanceResourceGroup()`。 */
export const instanceResourceItems: NavItem[] = instanceResourceGroup().map((resource) =>
    item(resource.id, undefined, { gap: true }),
);
/**
 * 用户层入口（Lead 2026-11-10 裁定：全局设置只有实例层与用户层；工作区设置在各工作区内部，
 * 本轮不设计）。
 *
 * <p>「偏好设置」在两层都存在：实例层那次是**默认值**，用户层这次是**我自己的偏好**
 * （CP 矩阵 `LAYER_DOMAINS.user` 含 `user-preference`）。所以它出现在两个分组里是矩阵事实，
 * 不是重复条目——这也是为什么左栏必须按层分组：同一条目在不同层是不同的写入目标。</p>
 */
export const userItems: NavItem[] = [
    // 9 个用户层配置域（`domainsForLayer("user")`，含 user-preference：它在两层都存在，是矩阵事实）
    ...domainsForLayer("user").map((domain) => item(domain, badgeOf(domain))),
    // 3 条资源（我的凭据 / 智能体账号 = 真入口；知识库·MCP = 缺口）
    ...userResourceGroup().map((resource) =>
        item(resource.id, undefined, resource.path ? undefined : { gap: true }),
    ),
];

/**
 * **对账表**（稿页直接打印，2026-11-11 裁定）：每段条目数由生成结果现算，不写死。
 *
 * <p>为什么把表放在页面上而不是只写在汇报里：下一轮评审的人不必读代码、也不必问谁，
 * 自己在稿上就能数「实例 12+2+3+4=21 / 用户 9+3=12」对不对得上产品左栏。</p>
 */
export const NAV_RECONCILIATION: { segment: string; count: number }[] = [
    { segment: "实例层 · 配置域", count: domains.length },
    { segment: "实例层 · 运维", count: opsItems.length },
    { segment: "实例层 · 安全", count: securityItems.length },
    { segment: "实例层 · 资源（全缺口位）", count: instanceResourceItems.length },
    { segment: "用户层 · 配置域", count: domainsForLayer("user").length },
    { segment: "用户层 · 资源", count: userResourceGroup().length },
];

/** 徽标口径（与产品 `SettingsSidebar.vue:111/117` 的入口数一致：域 + 资源 + ops 条目）。 */
export const NAV_COUNTS = {
    instance:
        domains.length + opsItems.length + securityItems.length + instanceResourceItems.length,
    user: domainsForLayer("user").length + userResourceGroup().length,
};

/**
 * 全局条（模块切换）：**只有两个** —— 工作区 / 设置。
 *
 * [裁定 PLAN-0762 T2.3 / DEV-010 §10.2] MVP 的全局条只放「主体工作区 / 设置页」两个模块，
 * **不加第三个**；第三个模块何时进、进什么，[裁定] 待用户裁定（DEV-010 §10.6）。
 * 2026-11-11 返工：此处原有一个 `observability / 观测` 项 —— **它不是模块**
 * （[源码] `monitoring` 只是设置页路由 `settings-monitoring`，见 `router/index.ts:121-122`），已删。
 */
export const modules: NavItem[] = [
    { id: "workspace", label: "工作区", icon: MessageSquare },
    { id: "settings", label: "设置", icon: SlidersHorizontal },
];
