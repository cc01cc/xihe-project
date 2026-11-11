/**
 * **生成物** — 由 scripts/gen-mock-schema-catalog.mjs 从 CP config-schemas 生成，请勿手改。
 * 重生成：node scripts/gen-mock-schema-catalog.mjs（漂移自查加 --check）。
 * 语义：mock 稿「设置区每个字段的来源」对账底账（task-127）。
 */

export interface MockSchemaField {
    key: string;
    type: "string" | "integer" | "number" | "boolean" | "enum" | "map" | "json";
    options?: string[];
    description?: string;
    required?: boolean;
    default?: unknown;
}

/** 内嵌 JSON 原文：oxfmt 不改字符串内容 ⇒ 生成物字节级确定。 */
const CATALOG_JSON = `{
    "agent-profile": [
        {
            "key": "userName",
            "type": "string"
        }
    ],
    "agent-runtime": [
        {
            "key": "useRegistry",
            "type": "enum",
            "options": [
                "true",
                "false"
            ]
        },
        {
            "key": "useSupervisor",
            "type": "enum",
            "options": [
                "true",
                "false"
            ]
        },
        {
            "key": "providerRequestFingerprintEnabled",
            "type": "enum",
            "options": [
                "true",
                "false"
            ]
        },
        {
            "key": "workersDir",
            "type": "string"
        },
        {
            "key": "instructions",
            "type": "string"
        },
        {
            "key": "systemToolTimeoutS",
            "type": "integer"
        },
        {
            "key": "toolOutputLimitBytes",
            "type": "integer"
        },
        {
            "key": "runMaxTurns",
            "type": "integer"
        },
        {
            "key": "runMaxElapsedSeconds",
            "type": "integer"
        },
        {
            "key": "runMaxTokens",
            "type": "integer"
        },
        {
            "key": "runMaxTurnsCeiling",
            "type": "integer"
        },
        {
            "key": "runMaxElapsedSecondsCeiling",
            "type": "integer"
        },
        {
            "key": "runMaxTokensCeiling",
            "type": "integer"
        },
        {
            "key": "loopRepeatWarn",
            "type": "integer"
        },
        {
            "key": "loopRepeatRefuse",
            "type": "integer"
        },
        {
            "key": "loopRepeatEscalate",
            "type": "integer"
        },
        {
            "key": "loopErrorRunWarn",
            "type": "integer"
        },
        {
            "key": "loopErrorRunEscalate",
            "type": "integer"
        },
        {
            "key": "loopStaleResultWarn",
            "type": "integer"
        },
        {
            "key": "loopStaleResultEscalate",
            "type": "integer"
        },
        {
            "key": "loopWindowSize",
            "type": "integer"
        },
        {
            "key": "loopRepeatEscalateCeiling",
            "type": "integer"
        },
        {
            "key": "loopErrorRunEscalateCeiling",
            "type": "integer"
        },
        {
            "key": "loopStaleResultEscalateCeiling",
            "type": "integer"
        },
        {
            "key": "loopWindowSizeCeiling",
            "type": "integer"
        },
        {
            "key": "wakeChainMaxDepth",
            "type": "integer"
        },
        {
            "key": "maxConcurrentRunsPerSession",
            "type": "integer"
        },
        {
            "key": "delegationMaxCountCeiling",
            "type": "integer"
        },
        {
            "key": "delegationMaxDepthCeiling",
            "type": "integer"
        },
        {
            "key": "loopExemptTools",
            "type": "json"
        }
    ],
    "agent-templates": [
        {
            "key": "roles",
            "type": "json"
        },
        {
            "key": "templates",
            "type": "json"
        }
    ],
    "approval-policy": [
        {
            "key": "mode",
            "type": "enum",
            "options": [
                "manual",
                "auto"
            ]
        },
        {
            "key": "askActionClasses",
            "type": "json"
        }
    ],
    "context-policy": [
        {
            "key": "defaults.fingerprintEnabled",
            "type": "boolean",
            "description": "PLAN-0666: per-workspace context-fingerprint switch (default true). When false, dispatched runs store an explicit {enabled:false,status:disabled} document instead of hashing the context."
        },
        {
            "key": "defaults.softThresholdPct",
            "type": "number"
        },
        {
            "key": "defaults.hardThresholdPct",
            "type": "number"
        },
        {
            "key": "defaults.keepRecentMessages",
            "type": "integer"
        },
        {
            "key": "defaults.agentsMdMaxBytes",
            "type": "integer"
        },
        {
            "key": "defaults.envMaxBytes",
            "type": "integer"
        },
        {
            "key": "defaults.maxInputTokens",
            "type": "integer"
        },
        {
            "key": "defaults.pruneWindowChars",
            "type": "integer"
        },
        {
            "key": "defaults.recoveryBand",
            "type": "number"
        },
        {
            "key": "defaults.maxConsecutiveIneffective",
            "type": "integer"
        },
        {
            "key": "defaults.summaryProvider",
            "type": "enum",
            "options": [
                "llm",
                "rule"
            ]
        },
        {
            "key": "defaults.summaryModel",
            "type": "string"
        },
        {
            "key": "defaults.summaryTimeoutMs",
            "type": "integer"
        },
        {
            "key": "models",
            "type": "map"
        }
    ],
    "context-templates": [
        {
            "key": "templates",
            "type": "json"
        },
        {
            "key": "defaultTemplate",
            "type": "string"
        },
        {
            "key": "userDefault",
            "type": "string"
        },
        {
            "key": "providerModelDefaults",
            "type": "json"
        }
    ],
    "embedding": [
        {
            "key": "profile.providerId",
            "type": "string"
        },
        {
            "key": "profile.connectionKey",
            "type": "string"
        },
        {
            "key": "profile.model",
            "type": "string"
        }
    ],
    "job-policy": [
        {
            "key": "defaultTimeoutSecs",
            "type": "integer"
        },
        {
            "key": "maxTimeoutSecs",
            "type": "integer"
        }
    ],
    "llm-provider": [
        {
            "key": "profile.providerId",
            "type": "string"
        },
        {
            "key": "profile.connectionKey",
            "type": "string"
        },
        {
            "key": "profile.model",
            "type": "string"
        },
        {
            "key": "imageProfile.providerId",
            "type": "string"
        },
        {
            "key": "imageProfile.connectionKey",
            "type": "string"
        },
        {
            "key": "imageProfile.model",
            "type": "string"
        },
        {
            "key": "imageProvider",
            "type": "string"
        },
        {
            "key": "modelParams",
            "type": "map",
            "description": "Per-model sampling parameters (PLAN-0523 decision #9/#12): map of model name to optional {maxTokens, temperature, timeout}. PUT replaces the whole map; an empty object clears. Layer-scoped (whole-domain override)."
        }
    ],
    "logging": [
        {
            "key": "logLevel",
            "type": "enum",
            "options": [
                "TRACE",
                "DEBUG",
                "INFO",
                "WARN",
                "ERROR",
                "trace",
                "debug",
                "info",
                "warn",
                "error"
            ]
        },
        {
            "key": "levelAgent",
            "type": "enum",
            "options": [
                "TRACE",
                "DEBUG",
                "INFO",
                "WARN",
                "ERROR",
                "trace",
                "debug",
                "info",
                "warn",
                "error"
            ]
        },
        {
            "key": "levelCp",
            "type": "enum",
            "options": [
                "TRACE",
                "DEBUG",
                "INFO",
                "WARN",
                "ERROR",
                "trace",
                "debug",
                "info",
                "warn",
                "error"
            ]
        },
        {
            "key": "levelRuntime",
            "type": "enum",
            "options": [
                "TRACE",
                "DEBUG",
                "INFO",
                "WARN",
                "ERROR",
                "trace",
                "debug",
                "info",
                "warn",
                "error"
            ]
        },
        {
            "key": "levelUi",
            "type": "enum",
            "options": [
                "TRACE",
                "DEBUG",
                "INFO",
                "WARN",
                "ERROR",
                "trace",
                "debug",
                "info",
                "warn",
                "error"
            ]
        },
        {
            "key": "centralTelemetryEnabled",
            "type": "enum",
            "options": [
                "true",
                "false"
            ]
        }
    ],
    "pricing": [
        {
            "key": "models",
            "type": "json",
            "description": "model key (provider/model as carried by the usage event) -> pricing entry"
        }
    ],
    "rag": [
        {
            "key": "chunkSize",
            "type": "integer"
        },
        {
            "key": "chunkOverlap",
            "type": "integer"
        },
        {
            "key": "topK",
            "type": "integer"
        },
        {
            "key": "minScore",
            "type": "number"
        }
    ],
    "user-preference": [
        {
            "key": "theme",
            "type": "enum",
            "options": [
                "dark",
                "light",
                "system"
            ]
        },
        {
            "key": "language",
            "type": "string"
        }
    ]
}` as const;

export const SCHEMA_CATALOG: Record<string, MockSchemaField[]> = JSON.parse(CATALOG_JSON) as Record<
    string,
    MockSchemaField[]
>;

export const SCHEMA_DOMAINS = Object.keys(SCHEMA_CATALOG);
