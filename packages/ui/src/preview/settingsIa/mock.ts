/**
 * Mock data for the settings-IA preview (task-44). No store, no fetch — plain objects.
 *
 * Shapes mirror the *proposal* discussed 2026-11-10: every config key carries three layer
 * values (instance / user / workspace); the effective layer is the highest layer that set a
 * value, and the lower layers stay visible as an inheritance chain (the `↳` line).
 * The values are deliberately **different per layer** — otherwise the layer badges would look
 * identical and prove nothing.
 */
export type ConfigLayer = "workspace" | "user" | "instance";
export type LockKind = "instance" | "env";

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

export interface DomainEntry {
    id: string;
    label: string;
    keys: number;
    overridden: number;
    locked?: LockKind;
}

export const domains: DomainEntry[] = [
    { id: "rag", label: "检索增强（RAG）", keys: 9, overridden: 3, locked: "env" },
    { id: "provider", label: "模型与连接", keys: 14, overridden: 2 },
    { id: "embedding", label: "向量与索引", keys: 6, overridden: 1 },
    { id: "agent", label: "智能体运行时", keys: 11, overridden: 1, locked: "instance" },
    { id: "memory", label: "记忆", keys: 7, overridden: 0 },
    { id: "tools", label: "工具面", keys: 8, overridden: 2 },
    { id: "mcp", label: "MCP 连接", keys: 5, overridden: 0, locked: "instance" },
    { id: "session", label: "会话与上下文", keys: 9, overridden: 1 },
    { id: "sandbox", label: "沙盒与执行", keys: 6, overridden: 0, locked: "env" },
    { id: "telemetry", label: "遥测", keys: 4, overridden: 0 },
    { id: "ui", label: "界面偏好", keys: 5, overridden: 1 },
    { id: "security", label: "安全与权限", keys: 7, overridden: 0, locked: "instance" },
];

export type AgentSource = "instance" | "mine";
export type AgentCap = "read" | "write" | "admin";

export interface AgentRow {
    id: string;
    name: string;
    model: string;
    source: AgentSource;
    cap: AgentCap;
    capOptions: AgentCap[];
    bound: boolean;
}

export const agentRows: AgentRow[] = [
    {
        id: "ap-01",
        name: "code-reviewer",
        model: "claude-sonnet-4.6",
        source: "instance",
        cap: "write",
        capOptions: ["read", "write"],
        bound: true,
    },
    {
        id: "ap-02",
        name: "doc-writer",
        model: "gpt-5.1",
        source: "instance",
        cap: "read",
        capOptions: ["read"],
        bound: true,
    },
    {
        id: "ap-03",
        name: "my-rag-probe",
        model: "bge-m3 / 768",
        source: "mine",
        cap: "read",
        capOptions: ["read", "write"],
        bound: false,
    },
    {
        id: "ap-05",
        name: "docs-indexer",
        model: "bge-m3 / 768",
        source: "instance",
        cap: "read",
        capOptions: ["read"],
        bound: false,
    },
    {
        id: "ap-06",
        name: "test-runner",
        model: "claude-sonnet-4.6",
        source: "mine",
        cap: "write",
        capOptions: ["read", "write"],
        bound: false,
    },
    {
        id: "ap-04",
        name: "release-notes",
        model: "deepseek-v3.2",
        source: "mine",
        cap: "write",
        capOptions: ["read", "write", "admin"],
        bound: false,
    },
];
