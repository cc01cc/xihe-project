/**
 * task-127：单页稿的**示例值表** —— schema-catalog 里每个可见字段一份真实感取值（禁占位）。
 *
 * 值域纪律：enum 字段的值必须 ∈ SCHEMA_CATALOG options（对账脚本逐键校验）；
 * 文案用产品语境真实样例（连接名 / 模型名 / 路径），不写 xxx / lorem / placeholder。
 * api-request-templates 无 config-schema（CP 侧专用面板承载），其内容由 MockSinglePage 手工排布。
 */

export const MOCK_VALUES: Record<string, Record<string, unknown>> = {
    "agent-profile": {
        userName: "xihe-operator",
    },
    "agent-runtime": {
        useRegistry: "true",
        useSupervisor: "true",
        providerRequestFingerprintEnabled: "true",
        workersDir: ".xihe/workers",
        instructions:
            "你是 Xihe 工作区内的编码助手。优先使用 workspace 工具读写文件；\n" +
            "执行 shell 前说明目的；单次工具输出超过上限时先落盘再摘要。",
        systemToolTimeoutS: 120,
        toolOutputLimitBytes: 1048576,
        runMaxTurns: 40,
        runMaxElapsedSeconds: 900,
        runMaxTokens: 200000,
        runMaxTurnsCeiling: 200,
        runMaxElapsedSecondsCeiling: 7200,
        runMaxTokensCeiling: 1000000,
        loopRepeatWarn: 3,
        loopRepeatRefuse: 6,
        loopRepeatEscalate: 4,
        loopErrorRunWarn: 2,
        loopErrorRunEscalate: 3,
        loopStaleResultWarn: 2,
        loopStaleResultEscalate: 3,
        loopWindowSize: 8,
        loopRepeatEscalateCeiling: 8,
        loopErrorRunEscalateCeiling: 6,
        loopStaleResultEscalateCeiling: 6,
        loopWindowSizeCeiling: 16,
        wakeChainMaxDepth: 4,
        maxConcurrentRunsPerSession: 2,
        delegationMaxCountCeiling: 12,
        delegationMaxDepthCeiling: 4,
        loopExemptTools: ["workspace.read_file", "workspace.list_dir", "workspace.stat"],
    },
    "agent-templates": {
        roles: [
            { id: "coder", name: "编码助手", instructions: "先读后写，改动最小化。" },
            { id: "reviewer", name: "评审员", instructions: "只指出问题，不改代码。" },
        ],
        templates: [
            { id: "tpl-default", roleId: "coder", content: "默认任务模板（PLAN-0414）。" },
            { id: "tpl-review", roleId: "reviewer", content: "变更评审模板。" },
        ],
    },
    "approval-policy": {
        mode: "manual",
        askActionClasses: ["file.write", "shell.exec", "network.egress"],
    },
    "context-policy": {
        "defaults.fingerprintEnabled": true,
        "defaults.softThresholdPct": 0.72,
        "defaults.hardThresholdPct": 0.9,
        "defaults.keepRecentMessages": 6,
        "defaults.agentsMdMaxBytes": 65536,
        "defaults.envMaxBytes": 16384,
        "defaults.maxInputTokens": 128000,
        "defaults.pruneWindowChars": 24000,
        "defaults.recoveryBand": 0.1,
        "defaults.maxConsecutiveIneffective": 3,
        "defaults.summaryProvider": "llm",
        "defaults.summaryModel": "gpt-4o-mini",
        "defaults.summaryTimeoutMs": 30000,
        models: {
            "anthropic/claude-sonnet-4-5": { softThresholdPct: 0.75, hardThresholdPct: 0.92 },
            "openai/gpt-4o": { softThresholdPct: 0.7, hardThresholdPct: 0.9 },
        },
    },
    embedding: {
        "profile.providerId": "openai",
        "profile.connectionKey": "conn-embed-primary",
        "profile.model": "text-embedding-3-small",
    },
    "job-policy": {
        defaultTimeoutSecs: 3600,
        maxTimeoutSecs: 86400,
    },
    "llm-provider": {
        "profile.providerId": "anthropic",
        "profile.connectionKey": "conn-claude-primary",
        "profile.model": "claude-sonnet-4-5",
        "imageProfile.providerId": "openai",
        "imageProfile.connectionKey": "conn-image-primary",
        "imageProfile.model": "gpt-image-1",
        imageProvider: "openai",
        modelParams: {
            "claude-sonnet-4-5": { maxTokens: 8192, temperature: 0.2 },
            "gpt-image-1": { maxTokens: 4096, timeout: 60 },
        },
    },
    logging: {
        logLevel: "INFO",
        levelAgent: "INFO",
        levelCp: "WARN",
        levelRuntime: "INFO",
        levelUi: "ERROR",
        centralTelemetryEnabled: "true",
    },
    rag: {
        chunkSize: 512,
        chunkOverlap: 64,
        topK: 6,
        minScore: 0.35,
    },
    "user-preference": {
        theme: "dark",
        language: "zh-CN",
    },
};
