import { writableAtOf, type MockDomain } from "./types";

/**
 * 我（dev-3）负责的 4 个重域：llm-provider / agent-runtime / context-policy / rag。
 *
 * **键全部取自** `packages/control-plane/src/main/resources/config-schemas/<domain>.json`
 * （[实测] 2026-11-11 逐个 `ConvertFrom-Json | .properties` 计数）：llm-provider 4 / agent-runtime 30 /
 * context-policy 2 / rag 4。**左栏 badge 由本文件的字段数派生**（裁定 B），不再手写旧数字。
 *
 * `writableAt` 一律走 `writableAtOf()`；[裁定 A] `context-policy` 有跨层合并（不在 explicit-only），
 * 真 explicit-only 的是 agent-templates / api-request-templates。
 * [裁定 E] llm-provider 属专用面板域（整块列表编辑），不画成表单。
 */

const rag: MockDomain = {
    id: "rag",
    // [task-81 D-829 ②] 层可写性只有 Set 推导、没找到 resolveChain ⇒ 屏上标 [推导]，且不显示「继承自上层」
    layerDerivedOnly: true,
    label: "RAG 检索",
    summary: "检索参数：分块、召回、重排与相似度阈值。数值越大召回越粗、调用越少。",
    layout: "form",
    groups: [
        {
            label: "分块与召回",
            fields: [
                {
                    key: "chunkSize",
                    label: "分块大小",
                    help: "单文档切块上限；越大召回越粗、embedding 调用越少（改小更准，但索引时间与费用上升）。",
                    control: "number",
                    value: 128,
                    writableAt: writableAtOf("rag", "chunkSize"),
                },
                {
                    key: "chunkOverlap",
                    label: "分块重叠",
                    help: "相邻块重叠字数；越不容易把一句话切断，代价是索引体积变大。",
                    control: "number",
                    value: 16,
                    writableAt: writableAtOf("rag", "chunkOverlap"),
                },
                {
                    key: "topK",
                    label: "召回条数",
                    help: "每次检索回填给模型的片段数；调大提高命中率，但会挤占上下文预算。",
                    control: "number",
                    value: 8,
                    writableAt: writableAtOf("rag", "topK"),
                },
                {
                    key: "minScore",
                    label: "最低相关度",
                    help: "低于该分数的片段直接丢弃（0–1）；调高答案更稳，但可能一条都召不回来。",
                    control: "number",
                    value: 0.35,
                    writableAt: writableAtOf("rag", "minScore"),
                },
            ],
        },
    ],
};

/**
 * [裁定 E] llm-provider 属专用面板域：整块编辑（提供商列表 + 详情），不画成表单。
 * 详情字段 = `llm-provider.json` 的 4 个顶层键（profile / imageProfile / imageProvider / modelParams）；
 * 列表行是**示例资源**（[推导] 非真实连接），仅用于表现「列表态」。
 */
const llmProvider: MockDomain = {
    id: "llm-provider",
    label: "LLM 提供商",
    summary: "提供商连接与默认模型整块编辑：列表选一条，进详情改它的默认模型与参数。",
    layout: "panel",
    groups: [],
    panel: {
        // [task-81] 量词由数据给：左栏徽标与标题行都读它；缺省「条目」（12 个徽标里唯一一个「—」的根因）
        unit: "个提供商",
        addLabel: "新增提供商",
        columns: [
            { key: "name", label: "名称" },
            { key: "type", label: "类型" },
            { key: "model", label: "默认模型" },
            { key: "state", label: "状态" },
        ],
        // [推导] 示例行，不是真实连接数据；真实连接走 /provider-connections，不在 config 域。
        rows: [
            {
                id: "row-1",
                cells: {
                    name: "openai-main",
                    type: "OpenAI",
                    model: "gpt-5.1",
                    state: "已启用",
                },
            },
            {
                id: "row-2",
                cells: {
                    name: "anthropic-main",
                    type: "Anthropic",
                    model: "claude-sonnet-4.6",
                    state: "已启用",
                },
            },
            {
                id: "row-3",
                cells: {
                    name: "local-qwen",
                    type: "OpenAI 兼容",
                    model: "qwen3-max",
                    state: "未验证",
                },
            },
        ],
        detail: {
            groups: [
                {
                    label: "默认模型（profile）",
                    fields: [
                        {
                            key: "profile.providerId",
                            label: "提供商",
                            help: "chat 默认走哪个提供商；改这里会影响所有没显式指定模型的会话。",
                            control: "text",
                            value: "openai-main",
                            writableAt: writableAtOf("llm-provider", "profile.providerId"),
                        },
                        {
                            key: "profile.connectionKey",
                            label: "连接",
                            help: "凭据与出口绑定在连接上；换连接等于换 key 与限流配额。",
                            control: "text",
                            value: "openai-main-prod",
                            writableAt: writableAtOf("llm-provider", "profile.connectionKey"),
                        },
                        {
                            key: "profile.model",
                            label: "模型",
                            help: "不写就用连接默认模型；写了则以这里为准（改错会导致会话 4xx）。",
                            control: "text",
                            value: "gpt-5.1",
                            writableAt: writableAtOf("llm-provider", "profile.model"),
                        },
                    ],
                },
                {
                    label: "图像模型（imageProfile / imageProvider）",
                    fields: [
                        {
                            key: "imageProvider",
                            label: "图像提供商",
                            help: "[源码] 仅实例层可写；空值表示该层不生成图像。",
                            control: "text",
                            value: "openai-main",
                            writableAt: writableAtOf("llm-provider", "imageProvider"),
                        },
                        {
                            key: "modelParams",
                            label: "模型参数",
                            help: "透传给模型的附加参数（temperature 等）；改错会直接被上游拒绝。",
                            control: "textarea",
                            value: "{}",
                            writableAt: writableAtOf("llm-provider", "modelParams"),
                        },
                    ],
                },
            ],
        },
    },
};

/**
 * context-policy：13 个叶子键全部挂在 `defaults` 下（[实测] `context-policy.json` 顶层只有 `defaults` 一个键）
 * ⇒ `key` 写全路径，否则回不到 schema 逐字核对。
 *
 * `layerDerivedOnly: true`：[源码] 未找到该域解析链（只在 USER/WORKSPACE 两个可写集合里），
 * 按裁定 ④ 改动 2，屏上显示可见的 `[推导]` 徽标，且不显示「继承自上层」。
 */
const contextPolicy: MockDomain = {
    id: "context-policy",
    label: "上下文策略",
    summary: "上下文压缩与预算：阈值、保留量、摘要模型。调大更连贯，调小更省钱。",
    layout: "form",
    layerDerivedOnly: true,
    groups: [
        {
            label: "压缩阈值",
            fields: [
                {
                    key: "defaults.fingerprintEnabled",
                    label: "上下文指纹",
                    help: "[源码] 关掉后不再对上下文做哈希，改为显式写入 enabled:false 文档；审计侧会失去「两次运行上下文是否相同」的判据。",
                    control: "switch",
                    value: true,
                    writableAt: writableAtOf("context-policy", "defaults.fingerprintEnabled"),
                },
                {
                    key: "defaults.softThresholdPct",
                    label: "软阈值",
                    help: "[推导] 触发软压缩的占用比例；调低会更早压缩、省 token 但更容易丢细节（0.1–1）。",
                    control: "number",
                    value: 0.7,
                    writableAt: writableAtOf("context-policy", "defaults.softThresholdPct"),
                },
                {
                    key: "defaults.hardThresholdPct",
                    label: "硬阈值",
                    help: "[推导] 触发强制压缩的比例；必须高于软阈值，否则软压缩还没跑就被硬压缩抢先。",
                    control: "number",
                    value: 0.9,
                    writableAt: writableAtOf("context-policy", "defaults.hardThresholdPct"),
                },
                {
                    key: "defaults.keepRecentMessages",
                    label: "保留最近消息",
                    help: "[推导] 压缩时原样保留的最近消息条数；调大能保住对话连贯，代价是压缩后仍占较多 token。",
                    control: "number",
                    value: 20,
                    writableAt: writableAtOf("context-policy", "defaults.keepRecentMessages"),
                },
            ],
        },
        {
            label: "预算与裁剪",
            fields: [
                {
                    key: "defaults.agentsMdMaxBytes",
                    label: "AGENTS.md 上限",
                    help: "[推导] 注入 AGENTS.md 的字节上限；超出会被截断，调大更容易顶满上下文预算。",
                    control: "number",
                    value: 32768,
                    writableAt: writableAtOf("context-policy", "defaults.agentsMdMaxBytes"),
                },
                {
                    key: "defaults.envMaxBytes",
                    label: "环境信息上限",
                    help: "[推导] 注入环境信息（路径/工具列表等）的字节上限；调小可能让模型看不到可用工具。",
                    control: "number",
                    value: 16384,
                    writableAt: writableAtOf("context-policy", "defaults.envMaxBytes"),
                },
                {
                    key: "defaults.maxInputTokens",
                    label: "输入预算",
                    help: "[推导] 单次请求可用的输入 token 上限；超过即触发压缩，调大更贵。",
                    control: "number",
                    value: 128000,
                    writableAt: writableAtOf("context-policy", "defaults.maxInputTokens"),
                },
                {
                    key: "defaults.pruneWindowChars",
                    label: "裁剪窗口字符数",
                    help: "[推导] 按字符裁剪旧内容的窗口大小；越小越省 token、越容易丢掉前文引用。",
                    control: "number",
                    value: 2000,
                    writableAt: writableAtOf("context-policy", "defaults.pruneWindowChars"),
                },
                {
                    key: "defaults.recoveryBand",
                    label: "恢复带宽",
                    help: "[推导] 压缩后允许回补的余量比例；调大减少「刚压缩完立刻又满」的反复。",
                    control: "number",
                    value: 0.1,
                    writableAt: writableAtOf("context-policy", "defaults.recoveryBand"),
                },
                {
                    key: "defaults.maxConsecutiveIneffective",
                    label: "无效压缩上限",
                    help: "[推导] 连续无效压缩的容忍次数；超过后停止重试，避免把一次会话拖死在压缩上。",
                    control: "number",
                    value: 3,
                    writableAt: writableAtOf(
                        "context-policy",
                        "defaults.maxConsecutiveIneffective",
                    ),
                },
            ],
        },
        {
            label: "摘要模型",
            fields: [
                {
                    key: "defaults.summaryProvider",
                    label: "摘要提供商",
                    help: "[推导] 压缩摘要用哪个提供商；为空则用默认 chat profile，量大时会额外计费。",
                    control: "text",
                    value: "openai-main",
                    writableAt: writableAtOf("context-policy", "defaults.summaryProvider"),
                },
                {
                    key: "defaults.summaryModel",
                    label: "摘要模型",
                    help: "[推导] 压缩摘要用的模型；用小模型更省钱，但摘要质量下降会影响后续回答。",
                    control: "text",
                    value: "gpt-5.1-mini",
                    writableAt: writableAtOf("context-policy", "defaults.summaryModel"),
                },
                {
                    key: "defaults.summaryTimeoutMs",
                    label: "摘要超时（毫秒）",
                    help: "[推导] 摘要调用超时；太短会让压缩频繁失败并回退到裁剪。",
                    control: "number",
                    value: 30000,
                    writableAt: writableAtOf("context-policy", "defaults.summaryTimeoutMs"),
                },
            ],
        },
    ],
};
export const CORE_DOMAINS: MockDomain[] = [rag, llmProvider, contextPolicy];

export default CORE_DOMAINS;
