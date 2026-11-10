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
// 域全集与派生计数只在 `data/all-domains.ts` 一处（此前这里与 S1SettingsAfter.vue 各拼一份 ⇒ 必然漂）
import { badgeOf } from "./data/all-domains";

/**
 * Mock data for the task-233 sheets.
 *
 * Counts are the **CP matrix facts** already used by `src/preview/settingsIa/mock.ts` (instance 12
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
};

const LABELS: Record<string, string> = {
    "llm-provider": "LLM 提供商",
    "context-policy": "上下文策略",
    embedding: "向量化",
    rag: "RAG 检索",
    "agent-runtime": "智能体运行时",
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
};

function item(id: string, badge?: string, state?: Partial<NavItem>): NavItem {
    return { id, label: LABELS[id] ?? id, icon: ICONS[id] ?? Wrench, badge, ...state };
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

export const domains: NavItem[] = [
    item("llm-provider", badgeOf("llm-provider")),
    item("context-policy", badgeOf("context-policy")),
    item("embedding", badgeOf("embedding")),
    item("rag", badgeOf("rag")),
    item("agent-runtime", badgeOf("agent-runtime")),
    item("agent-profile", badgeOf("agent-profile")),
    item("user-preference", badgeOf("user-preference")),
    item("logging", badgeOf("logging")),
    item("approval-policy", badgeOf("approval-policy")),
    item("agent-templates", badgeOf("agent-templates")),
    item("api-request-templates", badgeOf("api-request-templates")),
    item("job-policy", badgeOf("job-policy")),
];

export const opsItems: NavItem[] = [
    item("monitoring"),
    item("data", undefined, { unconfigured: true }),
];
export const securityItems: NavItem[] = [
    item("config-locks"),
    item("roles"),
    item("audit", undefined, { gap: true }),
];
/**
 * 用户层入口（Lead 2026-11-10 裁定：全局设置只有实例层与用户层；工作区设置在各工作区内部，
 * 本轮不设计）。
 *
 * <p>「偏好设置」在两层都存在：实例层那次是**默认值**，用户层这次是**我自己的偏好**
 * （CP 矩阵 `LAYER_DOMAINS.user` 含 `user-preference`）。所以它出现在两个分组里是矩阵事实，
 * 不是重复条目——这也是为什么左栏必须按层分组：同一条目在不同层是不同的写入目标。</p>
 */
export const userItems: NavItem[] = [
    item("my-credentials"),
    item("agent-principals", undefined, { gap: true }),
    item("user-preference", "5"),
    item("knowledge-mcp"),
];

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
