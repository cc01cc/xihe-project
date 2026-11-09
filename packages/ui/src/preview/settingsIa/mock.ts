/**
 * Mock data for the settings-IA preview (task-44 → v2 of task-56). No store, no fetch — plain objects.
 *
 * v2 (per PLAN-0752 §3): the IA is three levels — **layer** (outer frame: instance / user /
 * workspace) → **domain** (second level) → **entry** (third level). The layer/domain counts are
 * the CP matrix facts (PLAN-0752 §3.2), not invented: instance 12 domains + operations 2 +
 * security 3, user 9 domains + my resources 3, workspace 10 domains + resources 3.
 *
 * Config rows keep three layer values each (instance / user / workspace); the effective layer is
 * the highest layer that set a value, and lower layers stay visible as the inheritance chain.
 * The values are deliberately **different per layer** — otherwise the layer badges would look
 * identical and prove nothing.
 */
export type ConfigLayer = "workspace" | "user" | "instance";
export type LockKind = "instance" | "env";

/** 层：外框维度。同一时刻只在一层内（PLAN-0752 §3.1）。 */
export type SettingsLayer = "instance" | "user" | "workspace";

export interface LayerValue {
    layer: ConfigLayer;
    value: string;
}

export interface ConfigKeyRow {
    key: string;
    label: string;
    description: string;
    /** 生效值（= 最高层的取值） */
    effective: string;
    /** 生效层 */
    layer: ConfigLayer;
    /** 被覆盖的下层值（按层从高到低），渲染成 `↳ 实例 64k / 用户 96k` */
    chain: LayerValue[];
    locked?: LockKind;
    editor: "number" | "switch" | "select" | "text";
    options?: string[];
    /** 在**当前层**（工作区）可否编辑 */
    writable: boolean;
}

export const domainRows: ConfigKeyRow[] = [
    {
        key: "rag.chunkSize",
        label: "分块大小",
        description: "单文档切块上限；越大召回越粗、embedding 调用越少",
        effective: "128k",
        layer: "workspace",
        chain: [
            { layer: "instance", value: "64k" },
            { layer: "user", value: "96k" },
        ],
        editor: "select",
        options: ["32k", "64k", "96k", "128k"],
        writable: true,
    },
    {
        key: "rag.topK",
        label: "召回条数",
        description: "每次检索回填给模型的片段数",
        effective: "8",
        layer: "workspace",
        chain: [{ layer: "user", value: "6" }],
        editor: "number",
        writable: true,
    },
    {
        key: "rag.rerankEnabled",
        label: "重排",
        description: "召回后用 cross-encoder 重排（更准、更慢）",
        effective: "开",
        layer: "workspace",
        chain: [
            { layer: "instance", value: "关" },
            { layer: "user", value: "开" },
        ],
        editor: "switch",
        writable: true,
    },
    {
        key: "rag.embeddingModel",
        label: "向量模型",
        description: "由实例统一指定，工作区不可改写（换模型会使既有索引失效）",
        effective: "bge-m3 / 768",
        layer: "instance",
        chain: [],
        locked: "instance",
        editor: "text",
        writable: false,
    },
    {
        key: "rag.indexerEndpoint",
        label: "索引服务地址",
        description: "部署期由环境变量注入，UI 只读展示",
        effective: "http://127.0.0.1:12634",
        layer: "instance",
        chain: [],
        locked: "env",
        editor: "text",
        writable: false,
    },
    {
        key: "rag.minScore",
        label: "最低相关度",
        description: "低于该分数的片段直接丢弃",
        effective: "0.35",
        layer: "instance",
        chain: [],
        editor: "number",
        writable: true,
    },
    {
        key: "rag.hybridAlpha",
        label: "混合检索权重",
        description: "0 = 纯关键词，1 = 纯向量",
        effective: "0.3",
        layer: "user",
        chain: [{ layer: "instance", value: "0.5" }],
        editor: "number",
        writable: true,
    },
    {
        key: "rag.ingestBatchSize",
        label: "入库批大小",
        description: "一次提交给索引服务的片段数",
        effective: "64",
        layer: "workspace",
        chain: [{ layer: "instance", value: "32" }],
        editor: "number",
        writable: true,
    },
    {
        key: "rag.citationRequired",
        label: "强制引用",
        description: "回答必须带片段引用，否则重试",
        effective: "开",
        layer: "instance",
        chain: [],
        editor: "switch",
        writable: true,
    },
];

/**
 * 12 个 CP 配置域（PLAN-0752 §3.2）。`layers` 是**该域在哪一层可写**的矩阵事实：
 * - `logging` / `approval-policy` / `job-policy` 只在实例层（用户层不出现 ⇒ 不是漏项）
 * - `agent-profile` / `user-preference` 不在工作区层
 * 标签走 copy 表，mock 只放 id 与计数，避免文案与 locale 脱钩。
 */
export interface DomainDef {
    id: string;
    keys: number;
    overridden: number;
    locked?: LockKind;
    layers: SettingsLayer[];
}

export const domainDefs: DomainDef[] = [
    { id: "llm-provider", keys: 14, overridden: 2, layers: ["instance", "user", "workspace"] },
    { id: "context-policy", keys: 9, overridden: 1, layers: ["instance", "user", "workspace"] },
    { id: "embedding", keys: 6, overridden: 1, layers: ["instance", "user", "workspace"] },
    { id: "rag", keys: 9, overridden: 3, locked: "env", layers: ["instance", "user", "workspace"] },
    {
        id: "agent-runtime",
        keys: 11,
        overridden: 1,
        locked: "instance",
        layers: ["instance", "user", "workspace"],
    },
    { id: "agent-profile", keys: 7, overridden: 0, layers: ["instance", "user"] },
    { id: "user-preference", keys: 5, overridden: 1, layers: ["instance", "user"] },
    { id: "logging", keys: 4, overridden: 0, layers: ["instance"] },
    { id: "approval-policy", keys: 6, overridden: 2, locked: "instance", layers: ["instance"] },
    { id: "agent-templates", keys: 5, overridden: 0, layers: ["instance", "user", "workspace"] },
    {
        id: "api-request-templates",
        keys: 5,
        overridden: 0,
        layers: ["instance", "user", "workspace"],
    },
    { id: "job-policy", keys: 4, overridden: 0, layers: ["instance"] },
];

export function domainsFor(layer: SettingsLayer): DomainDef[] {
    return domainDefs.filter((d) => d.layers.includes(layer));
}

/** 左栏二级分组（分组 id → 标签在 copy 表）。实例层：运维 2 / 安全与权限 3；用户层：我的资源 3。 */
export const opsNav = ["monitoring", "data"] as const;
export const securityNav = ["config-locks", "roles", "audit"] as const;
export const resourceNav = ["my-agents", "my-credentials", "knowledge-mcp"] as const;
export const workspaceResourceNav = ["agents", "credentials", "knowledge"] as const;

/** 工作区角色（V87:131-134）：只有两档，智能体自 V108 起也走 role_bindings。 */
export type WorkspaceRole = "viewer" | "editor";
export type AgentSource = "instance" | "mine";

export interface AgentRow {
    id: string;
    name: string;
    model: string;
    source: AgentSource;
    /** 绑定时授予该智能体在本工作区的角色（WS_VIEWER / WS_EDITOR），不是新权限轴 */
    wsRole: WorkspaceRole;
    /** 该账号可授予的最高工作区角色决定可选项：只读只能 viewer，读写才能 editor */
    wsRoleOptions: WorkspaceRole[];
    bound: boolean;
}

export const agentRows: AgentRow[] = [
    {
        id: "ap-01",
        name: "code-reviewer",
        model: "claude-sonnet-4.6",
        source: "instance",
        wsRole: "editor",
        wsRoleOptions: ["viewer", "editor"],
        bound: true,
    },
    {
        id: "ap-02",
        name: "doc-writer",
        model: "gpt-5.1",
        source: "instance",
        wsRole: "viewer",
        wsRoleOptions: ["viewer"],
        bound: true,
    },
    {
        id: "ap-03",
        name: "my-rag-probe",
        model: "bge-m3 / 768",
        source: "mine",
        wsRole: "viewer",
        wsRoleOptions: ["viewer", "editor"],
        bound: false,
    },
    {
        id: "ap-05",
        name: "docs-indexer",
        model: "bge-m3 / 768",
        source: "instance",
        wsRole: "viewer",
        wsRoleOptions: ["viewer"],
        bound: false,
    },
    {
        id: "ap-06",
        name: "test-runner",
        model: "claude-sonnet-4.6",
        source: "mine",
        wsRole: "editor",
        wsRoleOptions: ["viewer", "editor"],
        bound: false,
    },
    {
        id: "ap-04",
        name: "release-notes",
        model: "deepseek-v3.2",
        source: "mine",
        wsRole: "editor",
        wsRoleOptions: ["viewer", "editor"],
        bound: false,
    },
];
