import { describe, expect, it } from "vitest";
import { SCHEMA_CATALOG } from "../data/schema-catalog";
import { MOCK_VALUES } from "../data/mockValues";

/**
 * task-127：MOCK_VALUES 覆盖门 —— 稿上每个 schema 字段必须有真实取值（禁占位）。
 * 与 scripts/check-mock-domains.mjs（DOM 侧 ⊆ 对账）互补：这里管静态值表，
 * 那里管渲染结果。enum 值必须 ∈ SCHEMA_CATALOG options。
 */

const UI_DOMAINS = [
    "llm-provider",
    "context-policy",
    "embedding",
    "rag",
    "agent-runtime",
    "agent-profile",
    "user-preference",
    "logging",
    "approval-policy",
    "agent-templates",
    "job-policy",
];

describe("MOCK_VALUES 覆盖（task-127 禁占位）", () => {
    it("UI 层矩阵内每个 schema 字段都有非空取值", () => {
        const gaps: string[] = [];
        for (const domain of UI_DOMAINS) {
            for (const field of SCHEMA_CATALOG[domain] ?? []) {
                const v = MOCK_VALUES[domain]?.[field.key];
                if (v === undefined || v === null || v === "") gaps.push(domain + ":" + field.key);
            }
        }
        expect(gaps, "缺值的字段: " + gaps.join(", ")).toEqual([]);
    });

    it("enum 字段取值 ∈ options", () => {
        const bad: string[] = [];
        for (const domain of UI_DOMAINS) {
            for (const field of SCHEMA_CATALOG[domain] ?? []) {
                if (field.type !== "enum" || !field.options) continue;
                const v = String(MOCK_VALUES[domain]?.[field.key] ?? "");
                if (!field.options.includes(v)) {
                    bad.push(domain + ":" + field.key + "=" + JSON.stringify(v));
                }
            }
        }
        expect(bad, "越界取值: " + bad.join(", ")).toEqual([]);
    });

    it("map/json 字段取值可 JSON 序列化且非空容器", () => {
        const bad: string[] = [];
        for (const domain of UI_DOMAINS) {
            for (const field of SCHEMA_CATALOG[domain] ?? []) {
                if (field.type !== "map" && field.type !== "json") continue;
                const v = MOCK_VALUES[domain]?.[field.key];
                if (
                    v === undefined ||
                    (typeof v === "object" && Object.keys(v as object).length === 0)
                ) {
                    bad.push(domain + ":" + field.key);
                }
                expect(() => JSON.stringify(v)).not.toThrow();
            }
        }
        expect(bad, "空容器: " + bad.join(", ")).toEqual([]);
    });
});
