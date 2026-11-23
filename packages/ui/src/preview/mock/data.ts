import {
    BookOpenText,
    Bot,
    Database,
    Gauge,
    KeyRound,
    Languages,
    LayoutTemplate,
    ListChecks,
    LockKeyhole,
    MessageSquare,
    Network,
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
import { domainsForLayer, instanceOpsGroups, resourceGroups } from "@/lib/settingsIa";

/**
 * Mock data for the task-233 sheets.
 *
 * Counts are the **CP matrix facts** already used by `src/lib/settingsIa.ts` (instance 11
 * domains + 2 ops + 5 security, task-485 撤 `agent-profile` 后的读数), re-stated here so these
 * sheets do not depend on that module's `SettingsLayer` shape. Nothing is invented; nothing is
 * fetched.
 */
export interface NavItem {
    id: string;
    label: string;
    icon: typeof Wrench;
    badge?: string;
    // 示例，非真实名单；真实缺口以 settings-ui-issue-inventory N-09 / C-01 为准
    /**
     * 能力未提供（settings-ui-issue-inventory N-09）：**这个能力本身不存在**，不是「本域没配」。
     * task-509 补提交：稿面上**不写**内部术语/缺口编号（曾写「后端缺口」），用户读到的是状态。
     * 注意现状 —— 这个 flag 目前在 preview 里只被 `navReconciliation.spec` 用于核对条目集合，
     * **没有组件据它渲染可见文本**（`grep \.gap\b src/preview` 只剩本声明）；要做文字标记时
     * 用「暂不可用」，不要捡回「缺口」。
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
    // task-901：安全组的 `roles` 页改名 `presets`（`settingsIa.ts:719`）；
    // 元数据键必须同批跟，否则 `missingNavMeta` 会把新页记成「无图标」。
    presets: ShieldCheck,
    // task-96：平台智能体的新家（`instanceOpsGroups()` 的安全组）；不加这一条 `missingNavMeta` 会红。
    "agent-principals": Bot,
    audit: ScrollText,
    // task-8：授权总览（安全组末尾）。与 `SettingsSidebar.vue` 的 OPS_ICONS 同图标：
    // 两处都缺就会让 `missingNavMeta` 记成「无图标」，稿页上出现「N 条无图标」。
    "authorization-overview": ShieldCheck,
    // 资源模块的 id 来自 `resourceGroups()`（mcp/credentials/skills/knowledge）；
    // 同一组 id 在 `SettingsResourceNav.vue` 的 `RESOURCE_ICONS` 里另有一份组件内映射——
    // 两边都要有，否则 `missingNavMeta` 会把缺图标的条目记成「无图标」。
    // 资源面是独立模块（`/resources/*`）；`resourceGroups()` 现为 **3 真 + 1 缺口**（缺口 = knowledge `G3`）。
    mcp: Wrench,
    credentials: KeyRound,
    skills: ScrollText,
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
    // 标签与页面 h1 一致（`settings.presetsTitle` = 「授权预设与绑定」）。
    presets: "授权预设与绑定",
    "agent-principals": "平台智能体",
    audit: "审计日志",
    // 标签必须与页面 h1 一致（DSD-1490「导航命名 = 定语+导航」）：页面标题是
    // `settings.authorizationOverview.title` = 「授权总览」。
    "authorization-overview": "授权总览",
    mcp: "MCP 服务",
    credentials: "凭据",
    skills: "技能",
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
// 两条状态标记属**示例数据**（「数据管理未配置」「审计日志能力未提供」），产品里由真实数据决定。
export const opsItems: NavItem[] = groupItems("ops").map((nav) =>
    nav.id === "data" ? { ...nav, unconfigured: true } : nav,
);
export const securityItems: NavItem[] = groupItems("security").map((nav) =>
    nav.id === "audit" ? { ...nav, gap: true } : nav,
);
/**
 * PLAN-0772 M2：资源**已是独立模块**（第三个顶层入口 `/resources`），不再属于设置区左栏
 * ⇒ 这 5 条从「实例层资源组」搬到模块级清单，生成自 `resourceGroups()`（5 资源 × 层 tab）。
 *
 * <p>这条搬家在稿上必须看得见：把条目留在设置区，评审者会以为资源还在设置里。</p>
 */
export const resourceItems: NavItem[] = resourceGroups().map((resource) =>
    item(resource.id, undefined, { gap: resource.path ? undefined : true }),
);
/**
 * 用户层入口（Lead 2026-11-10 裁定：全局设置只有实例层与用户层；工作区设置在各工作区内部，
 * 本轮不设计）。
 *
 * <p>「偏好设置」在两层都存在：实例层那次是**默认值**，用户层这次是**我自己的偏好**
 * （CP 矩阵 `LAYER_DOMAINS.user` 含 `user-preference`）。所以它出现在两个分组里是矩阵事实，
 * 不是重复条目——这也是为什么左栏必须按层分组：同一条目在不同层是不同的写入目标。</p>
 */
// 用户层只剩 8 个配置域（`domainsForLayer("user")`，含 user-preference：它在两层都存在，是矩阵事实）。
// 3 条资源入口已随 PLAN-0772 M2 搬到资源模块（`/resources/*`），设置区不再有资源条目。
export const userItems: NavItem[] = domainsForLayer("user").map((domain) =>
    item(domain, badgeOf(domain)),
);

/**
 * **对账表**（稿页直接打印，2026-11-11 裁定）：每段条目数由生成结果现算，不写死。
 *
 * <p>为什么把表放在页面上而不是只写在汇报里：下一轮评审的人不必读代码、也不必问谁，
 * 自己在稿上就能数「实例 11+2+5=18 / 用户 8」对不对得上产品左栏（旧读数「12+2+3+4=21 /
 * 用户 9+3=12」是 task-485 撤 `agent-profile` 之前的数字，已作废）。</p>
 */
export const NAV_RECONCILIATION: { segment: string; count: number }[] = [
    { segment: "实例层 · 配置域", count: domains.length },
    { segment: "实例层 · 运维", count: opsItems.length },
    { segment: "实例层 · 安全", count: securityItems.length },
    { segment: "用户层 · 配置域", count: domainsForLayer("user").length },
    { segment: "资源模块 · 资源条目（各带层 tab）", count: resourceItems.length },
];

/**
 * 徽标口径（与产品 `SettingsSidebar.vue` 的入口数一致：域 + ops 条目；资源已搬走不再计入）。
 *
 * <p>PLAN-0772 M2 的三个数（task-485 撤 agent-profile、task-96 撤智能体资源并加平台智能体入口、
 * task-8 加「授权总览」后）：实例层 **18** = 11 域 + 2 运维 + 5 安全（权限过滤前；缺
 * `MANAGE_ROLES` 时少 `roles` 一行 = 17，也非实例管理员时再少 `config-locks` = 16）；
 * 用户层 **8** = 8 域；资源模块 **4** = 4 资源条目。</p>
 */
export const NAV_COUNTS = {
    instance: domains.length + opsItems.length + securityItems.length,
    user: domainsForLayer("user").length,
    resources: resourceItems.length,
};

/**
 * 全局条（模块切换）：**五个**实例级模块 —— 工作台 / 组织成员 / 资源 / 设置 / 自动化任务。
 *
 * <p><b>为什么不是「只有两个」</b>：旧裁定 PLAN-0762 T2.3 / DEV-010 §10.2「MVP 只放主体工作区 +
 * 设置页，不加第三个」已被后续三条裁定逐次 supersede —— PLAN-0772 M2 加「资源」（D-1011）、
 * task-240 / PLAN-0773 M3 加「组织成员」（Lead 裁 (a)：「实例级面进全局模块」）、task-11 /
 * D-1220 ③ 回退把「自动化任务」从工作区上下文面板改成恒在的实例级模块。
 * 产品侧同源：`src/lib/globalModules.ts:113-170` 的 `GLOBAL_MODULES`（本数组与它逐项同名同序，
 * 判据是 id 与顺序一致；文案仍由各自 i18n 键给值，稿页这里写死中文只为脱离 i18n 运行）。</p>
 *
 * <p>2026-11-11 返工：此处原有一个 `observability / 观测` 项 —— **它不是模块**
 * （[源码] `monitoring` 只是设置页路由 `settings-monitoring`，见 `router/index.ts:121-122`），已删。</p>
 */
export const modules: NavItem[] = [
    // 产品 id 是 workbench（labelKey `sidebar.workbench`「工作台」）；旧稿写成 workspace/工作区，
    // 与「工作区」这个**内容面**概念撞名（DSD-1490 称呼表第 1/2 行），按产品对齐。
    { id: "workbench", label: "工作台", icon: MessageSquare },
    // task-240 / PLAN-0773 M3：实例级「组织成员」面进全局模块（产品图标 Network，见 globalModules.ts:126）。
    { id: "org-members", label: "组织成员", icon: Network },
    { id: "resources", label: "资源", icon: Wrench },
    { id: "settings", label: "设置", icon: SlidersHorizontal },
    // task-11 / D-1220 ③ 回退：恒在的实例级「自动化任务」总览（产品图标 ListChecks，globalModules.ts:159）。
    { id: "scheduled-tasks", label: "自动化任务", icon: ListChecks },
];
