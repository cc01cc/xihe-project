/**
 * DEPRECATED(task-137-rev2)：D-914 ① 交付改为「真产品页面 + 网络层 mock」，本文件属更早的「静态设计稿单页」路线，已不再渲染也不再产出交付图；**保留不删**（Lead 口径：零删除，退役由 PLAN-0764 M1 合并时统一处理）。指标：task-137 rev2 的真实入口是 preview-real.html + src/preview/mock/api-server.ts。
 */
/**
 * task-137（mock v2 · 中文适配）：配置字段的中文词典 —— 100% 覆盖 SCHEMA_CATALOG 的可见字段。
 *
 * 纪律（Lead 核过的事实）：
 *   · 有产品键的字段用 `key`（渲染时 t(key)，与产品同一份 zh 文案）；无键的字段用 `zh` curated。
 *   · `desc` = 中文一句话用途说明（替代 schema 英文 description，专有名词不译）。
 *   · `options` = enum 值 → 中文标签（true/false → 开启/关闭；模型名、日志级别等专有名词不译）。
 *   · check-mock-domains.mjs 断言「每个渲染字段都有中文 label」——词典缺项即红。
 */
export interface FieldLabelEntry {
    /** 产品 i18n 键（存在则优先渲染 t(key)）。 */
    key?: string;
    /** 无产品键时的 curated 中文标签。 */
    zh?: string;
    /** 中文一句话用途。 */
    desc: string;
    /** enum 值 → 中文标签（专有名词可省略，省略则原样显示）。 */
    options?: Record<string, string>;
}

export const FIELD_LABELS: Record<string, Record<string, FieldLabelEntry>> = {
    "llm-provider": {
        "profile.providerId": {
            zh: "提供商 ID",
            desc: "默认对话模型所属的提供商标识。",
        },
        "profile.connectionKey": {
            zh: "连接标识",
            desc: "指向一条已配置的 Provider 连接。",
        },
        "profile.model": {
            zh: "模型",
            desc: "默认对话模型名，随提供商能力降级选择。",
        },
        "imageProfile.providerId": {
            zh: "图像提供商 ID",
            desc: "图像生成模型的提供商标识。",
        },
        "imageProfile.connectionKey": {
            zh: "图像连接标识",
            desc: "图像生成使用的 Provider 连接。",
        },
        "imageProfile.model": {
            zh: "图像模型",
            desc: "全局默认的图像生成模型。",
        },
        imageProvider: {
            zh: "图像生成提供商",
            desc: "图像生成走的 provider 路径。",
        },
        modelParams: {
            zh: "模型采样参数",
            desc: "按模型名配置 maxTokens / temperature / timeout；整表替换。",
        },
    },
    embedding: {
        "profile.providerId": {
            zh: "嵌入提供商 ID",
            desc: "嵌入模型所属的提供商标识。",
        },
        "profile.connectionKey": {
            zh: "嵌入连接标识",
            desc: "嵌入调用使用的 Provider 连接。",
        },
        "profile.model": {
            zh: "嵌入模型",
            desc: "向量化使用的嵌入模型。",
        },
    },
    rag: {
        // 产品 zh-CN 里这几个键文案仍是英文（"Chunk Size" 等，TODO(i18n) 待定稿）⇒ 同时给 zh。
        chunkSize: {
            key: "settings.fieldChunkSize",
            zh: "切片长度",
            desc: "切片长度（字符）。",
        },
        chunkOverlap: {
            key: "settings.fieldChunkOverlap",
            zh: "切片重叠",
            desc: "相邻切片的重叠量，避免语义被切断。",
        },
        topK: {
            key: "settings.fieldTopK",
            zh: "检索条数",
            desc: "检索返回的候选片段数。",
        },
        minScore: {
            key: "settings.fieldMinScore",
            zh: "相似度下限",
            desc: "相似度下限，低于该值的片段不进入上下文。",
        },
    },
    "context-policy": {
        "defaults.fingerprintEnabled": {
            zh: "上下文指纹",
            desc: "按工作区开启上下文指纹复用（默认开启）。",
            options: { true: "开启", false: "关闭" },
        },
        "defaults.softThresholdPct": {
            zh: "软阈值",
            desc: "上下文占用达到该比例时开始压缩。",
        },
        "defaults.hardThresholdPct": {
            zh: "硬阈值",
            desc: "占用达到该比例时强制裁剪，须高于软阈值。",
        },
        "defaults.keepRecentMessages": {
            zh: "保留最近消息数",
            desc: "压缩时始终保留的最近消息条数。",
        },
        "defaults.agentsMdMaxBytes": {
            zh: "AGENTS.md 上限",
            desc: "注入 AGENTS.md 的字节上限。",
        },
        "defaults.envMaxBytes": {
            zh: "环境信息上限",
            desc: "注入环境变量与工作区信息的字节上限。",
        },
        "defaults.maxInputTokens": {
            zh: "输入 token 上限",
            desc: "单次请求允许的最大输入 token 数。",
        },
        "defaults.pruneWindowChars": {
            zh: "裁剪窗口字符数",
            desc: "裁剪时按字符窗口选取保留片段。",
        },
        "defaults.recoveryBand": {
            zh: "恢复区间",
            desc: "裁剪后预留的余量比例，避免立刻再次触发。",
        },
        "defaults.maxConsecutiveIneffective": {
            zh: "连续无效上限",
            desc: "连续多少次压缩无效后升级处理。",
        },
        "defaults.summaryProvider": {
            zh: "摘要来源",
            desc: "上下文摘要由模型生成还是规则生成。",
            options: { llm: "模型摘要", rule: "规则摘要" },
        },
        "defaults.summaryModel": {
            zh: "摘要模型",
            desc: "生成摘要所用的模型名。",
        },
        "defaults.summaryTimeoutMs": {
            zh: "摘要超时（毫秒）",
            desc: "摘要请求的等待上限。",
        },
        models: {
            zh: "按模型覆盖",
            desc: "按模型名覆盖软/硬阈值；整表替换。",
        },
    },
    "agent-runtime": {
        useRegistry: {
            key: "settings.fieldUseRegistry",
            desc: "是否启用工具注册表。",
            options: { true: "开启", false: "关闭" },
        },
        useSupervisor: {
            key: "settings.fieldUseSupervisor",
            desc: "是否启用 supervisor 审核层。",
            options: { true: "开启", false: "关闭" },
        },
        providerRequestFingerprintEnabled: {
            key: "settings.fieldProviderRequestFingerprint",
            desc: "是否按请求指纹去重提供商调用。",
            options: { true: "开启", false: "关闭" },
        },
        workersDir: { key: "settings.fieldWorkersDir", desc: "后台 worker 的工作目录。" },
        instructions: { key: "settings.fieldInstructions", desc: "运行的附加系统指令（多行）。" },
        systemToolTimeoutS: {
            key: "settings.fieldSystemToolTimeout",
            desc: "系统工具单次调用的超时（秒）。",
        },
        toolOutputLimitBytes: {
            key: "settings.fieldToolOutputLimit",
            desc: "单次工具输出的字节上限。",
        },
        runMaxTurns: { key: "settings.fieldRunMaxTurns", desc: "单次运行的轮数上限。" },
        runMaxElapsedSeconds: {
            key: "settings.fieldRunMaxElapsedSeconds",
            desc: "单次运行的时长上限（秒）。",
        },
        runMaxTokens: { key: "settings.fieldRunMaxTokens", desc: "单次运行的 token 上限。" },
        runMaxTurnsCeiling: {
            key: "settings.fieldRunMaxTurnsCeiling",
            desc: "轮数上限的硬天花板（实例层）。",
        },
        runMaxElapsedSecondsCeiling: {
            key: "settings.fieldRunMaxElapsedSecondsCeiling",
            desc: "时长上限的硬天花板（实例层）。",
        },
        runMaxTokensCeiling: {
            key: "settings.fieldRunMaxTokensCeiling",
            desc: "token 上限的硬天花板（实例层）。",
        },
        loopRepeatWarn: { key: "settings.fieldLoopRepeatWarn", desc: "重复调用达到该次数时告警。" },
        loopRepeatRefuse: {
            key: "settings.fieldLoopRepeatRefuse",
            desc: "重复调用达到该次数时拒绝执行。",
        },
        loopRepeatEscalate: {
            key: "settings.fieldLoopRepeatEscalate",
            desc: "重复调用升级处理的阈值。",
        },
        loopErrorRunWarn: {
            key: "settings.fieldLoopErrorRunWarn",
            desc: "错误连续出现时告警的阈值。",
        },
        loopErrorRunEscalate: {
            key: "settings.fieldLoopErrorRunEscalate",
            desc: "错误连续出现时升级的阈值。",
        },
        loopStaleResultWarn: {
            key: "settings.fieldLoopStaleResultWarn",
            desc: "陈旧结果出现时告警的阈值。",
        },
        loopStaleResultEscalate: {
            key: "settings.fieldLoopStaleResultEscalate",
            desc: "陈旧结果升级的阈值。",
        },
        loopWindowSize: { key: "settings.fieldLoopWindowSize", desc: "循环检测的滑动窗口大小。" },
        loopRepeatEscalateCeiling: {
            key: "settings.fieldLoopRepeatEscalateCeiling",
            desc: "重复升级阈值的上限。",
        },
        loopErrorRunEscalateCeiling: {
            key: "settings.fieldLoopErrorRunEscalateCeiling",
            desc: "错误升级阈值的上限。",
        },
        loopStaleResultEscalateCeiling: {
            key: "settings.fieldLoopStaleResultEscalateCeiling",
            desc: "陈旧结果升级阈值的上限。",
        },
        loopWindowSizeCeiling: {
            key: "settings.fieldLoopWindowSizeCeiling",
            desc: "循环窗口大小的上限。",
        },
        wakeChainMaxDepth: { zh: "唤醒链最大深度", desc: "同一唤醒链最多递归的层数。" },
        maxConcurrentRunsPerSession: { zh: "会话并发运行上限", desc: "同一会话同时允许的运行数。" },
        delegationMaxCountCeiling: { zh: "委派数量上限", desc: "单次运行的子委派数量硬上限。" },
        delegationMaxDepthCeiling: { zh: "委派深度上限", desc: "委派链的最大嵌套层数。" },
        loopExemptTools: { zh: "循环豁免工具", desc: "这些工具调用不计入循环检测。" },
    },
    "agent-profile": {
        userName: { key: "settings.fieldUserName", desc: "智能体在界面上显示的名字。" },
    },
    "agent-templates": {
        roles: { zh: "角色", desc: "智能体角色定义（标识 / 名称 / 指令）。" },
        templates: { zh: "模板", desc: "任务模板集合，按角色引用。" },
    },
    "approval-policy": {
        mode: {
            key: "settings.fieldApprovalMode",
            desc: "审批的触发方式。",
            options: { manual: "手动审批", auto: "自动审批" },
        },
        askActionClasses: {
            key: "settings.fieldApprovalAskActionClasses",
            desc: "需要审批的动作类别清单。",
        },
    },
    "job-policy": {
        defaultTimeoutSecs: {
            key: "settings.fieldDefaultTimeoutSecs",
            desc: "Job 默认时限（秒）。",
        },
        maxTimeoutSecs: { key: "settings.fieldMaxTimeoutSecs", desc: "Job 时限的硬上限（秒）。" },
    },
    logging: {
        logLevel: { key: "settings.fieldLogLevel", desc: "全局日志级别。" },
        levelAgent: { key: "settings.fieldLevelAgent", desc: "Agent 模块的日志级别。" },
        levelCp: { key: "settings.fieldLevelCp", desc: "CP 模块的日志级别。" },
        levelRuntime: { key: "settings.fieldLevelRuntime", desc: "Runtime 模块的日志级别。" },
        levelUi: { key: "settings.fieldLevelUi", desc: "UI 模块的日志级别。" },
        centralTelemetryEnabled: {
            key: "settings.fieldCentralTelemetryEnabled",
            desc: "是否上报中央遥测。",
            options: { true: "开启", false: "关闭" },
        },
    },
    "user-preference": {
        theme: {
            key: "settings.fieldTheme",
            desc: "界面配色主题。",
            options: { dark: "深色", light: "浅色", system: "跟随系统" },
        },
        language: {
            key: "settings.language",
            desc: "界面语言（PLAN-0602，localStorage 为唯一状态）。",
            options: { "zh-CN": "中文（zh-Hans）", "en-US": "English (en)" },
        },
    },
};

/** 词典查询：找不到条目时由 check-mock-domains 报缺（不静默回退 schema 键）。 */
export function fieldLabelEntry(domain: string, key: string): FieldLabelEntry | undefined {
    return FIELD_LABELS[domain]?.[key];
}
