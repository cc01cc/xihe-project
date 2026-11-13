/**
 * **生成物** — 由 scripts/gen-config-schema.mjs 从 CP config-schemas 生成，请勿手改。
 * 再生成（cwd=packages/ui）：node scripts/gen-config-schema.mjs
 * 漂移自查：node scripts/gen-config-schema.mjs --check（生成物与真源不一致 ⇒ exit 1）
 *
 * 真源：packages/control-plane/src/main/resources/config-schemas/*.json（13 域）
 * 展平规则：嵌套 object → 点号键；additionalProperties 为对象 → type "map"；type 数组取首标量；
 * "map" 额外带 mapValueFields（值对象属性，供按行渲染）；
 * enum → type "enum" + enumValues（中文 label 见 fieldLabels.ts，不并入本模块）。
 */

export type SchemaFieldType = "string" | "integer" | "number" | "boolean" | "enum" | "map" | "json";

export interface SchemaField {
    key: string;
    type: SchemaFieldType;
    /** type "map" 的值对象属性（键名不含前缀）；其他类型不出现。 */
    mapValueFields?: SchemaField[];
    enumValues?: { value: string; label?: string }[];
    description?: string;
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
            "enumValues": [
                {
                    "value": "true"
                },
                {
                    "value": "false"
                }
            ]
        },
        {
            "key": "useSupervisor",
            "type": "enum",
            "enumValues": [
                {
                    "value": "true"
                },
                {
                    "value": "false"
                }
            ]
        },
        {
            "key": "providerRequestFingerprintEnabled",
            "type": "enum",
            "enumValues": [
                {
                    "value": "true"
                },
                {
                    "value": "false"
                }
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
            "enumValues": [
                {
                    "value": "manual"
                },
                {
                    "value": "auto"
                }
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
            "enumValues": [
                {
                    "value": "llm"
                },
                {
                    "value": "rule"
                }
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
            "type": "map",
            "mapValueFields": [
                {
                    "key": "maxInputTokens",
                    "type": "integer"
                },
                {
                    "key": "tokenizerRef",
                    "type": "string"
                },
                {
                    "key": "softThresholdPct",
                    "type": "number"
                },
                {
                    "key": "hardThresholdPct",
                    "type": "number"
                },
                {
                    "key": "keepRecentMessages",
                    "type": "integer"
                },
                {
                    "key": "agentsMdMaxBytes",
                    "type": "integer"
                },
                {
                    "key": "envMaxBytes",
                    "type": "integer"
                },
                {
                    "key": "pruneWindowChars",
                    "type": "integer"
                },
                {
                    "key": "recoveryBand",
                    "type": "number"
                },
                {
                    "key": "maxConsecutiveIneffective",
                    "type": "integer"
                },
                {
                    "key": "summaryProvider",
                    "type": "enum",
                    "enumValues": [
                        {
                            "value": "llm"
                        },
                        {
                            "value": "rule"
                        }
                    ]
                },
                {
                    "key": "summaryModel",
                    "type": "string"
                },
                {
                    "key": "summaryTimeoutMs",
                    "type": "integer"
                }
            ]
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
            "mapValueFields": [
                {
                    "key": "maxTokens",
                    "type": "integer"
                },
                {
                    "key": "temperature",
                    "type": "number"
                },
                {
                    "key": "timeout",
                    "type": "integer"
                }
            ],
            "description": "Per-model sampling parameters (PLAN-0523 decision #9/#12): map of model name to optional {maxTokens, temperature, timeout}. PUT replaces the whole map; an empty object clears. Layer-scoped (whole-domain override)."
        }
    ],
    "logging": [
        {
            "key": "logLevel",
            "type": "enum",
            "enumValues": [
                {
                    "value": "TRACE"
                },
                {
                    "value": "DEBUG"
                },
                {
                    "value": "INFO"
                },
                {
                    "value": "WARN"
                },
                {
                    "value": "ERROR"
                },
                {
                    "value": "trace"
                },
                {
                    "value": "debug"
                },
                {
                    "value": "info"
                },
                {
                    "value": "warn"
                },
                {
                    "value": "error"
                }
            ]
        },
        {
            "key": "levelAgent",
            "type": "enum",
            "enumValues": [
                {
                    "value": "TRACE"
                },
                {
                    "value": "DEBUG"
                },
                {
                    "value": "INFO"
                },
                {
                    "value": "WARN"
                },
                {
                    "value": "ERROR"
                },
                {
                    "value": "trace"
                },
                {
                    "value": "debug"
                },
                {
                    "value": "info"
                },
                {
                    "value": "warn"
                },
                {
                    "value": "error"
                }
            ]
        },
        {
            "key": "levelCp",
            "type": "enum",
            "enumValues": [
                {
                    "value": "TRACE"
                },
                {
                    "value": "DEBUG"
                },
                {
                    "value": "INFO"
                },
                {
                    "value": "WARN"
                },
                {
                    "value": "ERROR"
                },
                {
                    "value": "trace"
                },
                {
                    "value": "debug"
                },
                {
                    "value": "info"
                },
                {
                    "value": "warn"
                },
                {
                    "value": "error"
                }
            ]
        },
        {
            "key": "levelRuntime",
            "type": "enum",
            "enumValues": [
                {
                    "value": "TRACE"
                },
                {
                    "value": "DEBUG"
                },
                {
                    "value": "INFO"
                },
                {
                    "value": "WARN"
                },
                {
                    "value": "ERROR"
                },
                {
                    "value": "trace"
                },
                {
                    "value": "debug"
                },
                {
                    "value": "info"
                },
                {
                    "value": "warn"
                },
                {
                    "value": "error"
                }
            ]
        },
        {
            "key": "levelUi",
            "type": "enum",
            "enumValues": [
                {
                    "value": "TRACE"
                },
                {
                    "value": "DEBUG"
                },
                {
                    "value": "INFO"
                },
                {
                    "value": "WARN"
                },
                {
                    "value": "ERROR"
                },
                {
                    "value": "trace"
                },
                {
                    "value": "debug"
                },
                {
                    "value": "info"
                },
                {
                    "value": "warn"
                },
                {
                    "value": "error"
                }
            ]
        },
        {
            "key": "centralTelemetryEnabled",
            "type": "enum",
            "enumValues": [
                {
                    "value": "true"
                },
                {
                    "value": "false"
                }
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
            "enumValues": [
                {
                    "value": "dark"
                },
                {
                    "value": "light"
                },
                {
                    "value": "system"
                }
            ]
        },
        {
            "key": "language",
            "type": "string"
        }
    ]
}` as const;

export const CONFIG_SCHEMA_CATALOG: Record<string, SchemaField[]> = JSON.parse(
    CATALOG_JSON,
) as Record<string, SchemaField[]>;

export const CONFIG_SCHEMA_DOMAINS: string[] = Object.keys(CONFIG_SCHEMA_CATALOG);
