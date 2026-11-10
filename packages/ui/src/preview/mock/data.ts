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

function item(id: string, badge?: string): NavItem {
    return { id, label: LABELS[id] ?? id, icon: ICONS[id] ?? Wrench, badge };
}

/** 实例层 12 个配置域（CP `INSTANCE_WRITABLE_DOMAINS` 全集）。 */
export const domains: NavItem[] = [
    item("llm-provider", "14"),
    item("context-policy", "9"),
    item("embedding", "6"),
    item("rag", "9"),
    item("agent-runtime", "11"),
    item("agent-profile", "7"),
    item("user-preference", "5"),
    item("logging", "4"),
    item("approval-policy", "6"),
    item("agent-templates", "5"),
    item("api-request-templates", "5"),
    item("job-policy", "4"),
];

export const opsItems: NavItem[] = [item("monitoring"), item("data")];
export const securityItems: NavItem[] = [item("config-locks"), item("roles"), item("audit")];
export const resourceItems: NavItem[] = [
    item("agent-principals"),
    item("my-credentials"),
    item("knowledge-mcp"),
];

/** 全局条（模块切换）三层：工作区 / 设置 / 观测。 */
export const modules: NavItem[] = [
    { id: "workspace", label: "工作区", icon: MessageSquare },
    { id: "settings", label: "设置", icon: SlidersHorizontal },
    { id: "observability", label: "观测", icon: Gauge },
];
