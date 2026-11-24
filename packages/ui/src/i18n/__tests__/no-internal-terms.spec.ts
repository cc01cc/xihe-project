import { describe, expect, it } from "vitest";

import { messages } from "../index";

/**
 * task-1011: user-visible copy must not leak internal vocabulary.
 *
 * This scans **every value** of both locales (not comments, not key names), so a new
 * string that mentions an internal concept fails here instead of shipping.
 */
const BANNED: Array<{ label: string; pattern: RegExp }> = [
    { label: "内部术语：读面", pattern: /读面/ },
    { label: "内部术语：契约", pattern: /契约/ },
    { label: "内部术语：真源", pattern: /真源/ },
    { label: "内部术语：派生值", pattern: /派生值/ },
    { label: "内部术语：照显", pattern: /照显/ },
    { label: "任务编号（task-N）", pattern: /task-\d+/ },
    {
        label: "HTTP 端点（METHOD /api/…）",
        pattern: /\b(GET|POST|PUT|PATCH|DELETE)\s+\/api\//,
    },
    { label: "internal term: read face", pattern: /read[- ]face/i },
    { label: "internal term: source of truth", pattern: /source of truth/i },
    { label: "internal term: derived value", pattern: /derived value/i },
];

function flatten(node: unknown, path: string[]): Array<{ path: string; value: string }> {
    if (typeof node === "string") {
        return [{ path: path.join("."), value: node }];
    }
    if (Array.isArray(node)) {
        return node.flatMap((item, index) => flatten(item, [...path, String(index)]));
    }
    if (node && typeof node === "object") {
        return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
            flatten(value, [...path, key]),
        );
    }
    return [];
}

describe("user-visible copy gate", () => {
    const entries = Object.entries(messages as Record<string, unknown>).map(([locale, tree]) => ({
        locale,
        strings: flatten(tree, []),
    }));

    it("scans both locales (a gate over an empty set is a false green)", () => {
        expect(entries.map((entry) => entry.locale)).toEqual(["zh-CN", "en-US"]);
        for (const entry of entries) {
            expect(entry.strings.length).toBeGreaterThan(500);
        }
    });

    for (const { locale, strings } of entries) {
        for (const banned of BANNED) {
            it(`${locale}: no ${banned.label}`, () => {
                const hits = strings.filter((entry) => banned.pattern.test(entry.value));
                expect(
                    hits.map((hit) => `[${locale}] ${hit.path}: ${hit.value}`),
                    `user-visible strings must not contain "${banned.label}"`,
                ).toEqual([]);
            });
        }
    }
});
