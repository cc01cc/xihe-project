#!/usr/bin/env node
/**
 * BL-303 / check:event-keys 自测 —— 4 个合成用例（Lead 2026-11-05 要求：
 * 正确名 / 别名 / 新域外名 / 动态值），外加 baseline grandfather 与过期 alias。
 *
 * 这些用例不扫描真实源码（除临时 fixture），所以它们能在任何 checkout 上稳定跑。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
    evaluateCatalog,
    namingRuleViolation,
    scanRepo,
} from "../check-event-keys.mjs";

const EMPTY_BASELINE = { logEventKeys: [], sseEventNames: [], agentEventTypes: [] };
const NO_SEMANTICS = { groups: [] };

function logEntry(key) {
    return { key, locations: ["synthetic:1"], count: 1 };
}

test("case 1: a correct new name is GREEN_NEW, not RED", () => {
    const result = evaluateCatalog(
        { log: [logEntry("context_truncated")], sse: [], agentEvent: [] },
        { baseline: EMPTY_BASELINE, semantics: NO_SEMANTICS },
    );
    assert.equal(result.red.length, 0);
    assert.deepEqual(
        result.greenNew.map((item) => item.key),
        ["context_truncated"],
    );
    assert.equal(namingRuleViolation("context_truncated"), null);
});

test("case 2: an alias in its migration window is YELLOW; after aliasRetireAfter it is RED", () => {
    const semantics = {
        groups: [
            {
                canonical: "context_truncated",
                aliases: [{ key: "agent_context_truncated", retireAfter: "2026-11-19" }],
            },
        ],
    };
    const window = evaluateCatalog(
        { log: [logEntry("agent_context_truncated")], sse: [], agentEvent: [] },
        { baseline: EMPTY_BASELINE, semantics, today: "2026-11-05" },
    );
    assert.equal(window.red.length, 0);
    assert.ok(window.yellow.some((item) => item.rule === "alias-in-migration-window"));

    const expired = evaluateCatalog(
        { log: [logEntry("agent_context_truncated")], sse: [], agentEvent: [] },
        { baseline: EMPTY_BASELINE, semantics, today: "2026-11-20" },
    );
    assert.equal(expired.red.length, 1);
    assert.equal(expired.red[0].rule, "alias-retired");
});

test("case 3: a new key outside the domain whitelist / without past participle is RED", () => {
    const result = evaluateCatalog(
        {
            log: [logEntry("auth_login_ok"), logEntry("context_foo")],
            sse: [],
            agentEvent: [],
        },
        { baseline: EMPTY_BASELINE, semantics: NO_SEMANTICS },
    );
    assert.equal(result.red.length, 2);
    assert.ok(result.red.every((item) => item.rule === "new-key-naming"));
    assert.match(namingRuleViolation("auth_login_ok"), /domain/);
    assert.match(namingRuleViolation("context_foo"), /过去分词/);
});

test("case 3b: newly whitelisted domains accept proper keys; unknown domain / non-participle stay RED", () => {
    const ok = evaluateCatalog(
        {
            log: [
                logEntry("plugin_tool_catalog_filtered"),
                logEntry("provider_fingerprint_dropped"),
                logEntry("runtime_git_log_unreachable"),
            ],
            sse: [],
            agentEvent: [],
        },
        { baseline: EMPTY_BASELINE, semantics: NO_SEMANTICS },
    );
    assert.equal(ok.red.length, 0);

    const bad = evaluateCatalog(
        { log: [logEntry("billing_charge_failed"), logEntry("plugin_tool_catalog")], sse: [], agentEvent: [] },
        { baseline: EMPTY_BASELINE, semantics: NO_SEMANTICS },
    );
    assert.equal(bad.red.length, 2);
    assert.ok(bad.red.every((item) => item.rule === "new-key-naming"));
    assert.match(namingRuleViolation("billing_charge_failed"), /domain/);
    assert.match(namingRuleViolation("plugin_tool_catalog"), /过去分词/);
});

test("case 4: a dynamic event value is WARN-only, never a key/RED", () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "event-keys-"));
    try {
        const src = path.join(fixture, "packages", "agent", "src");
        mkdirSync(src, { recursive: true });
        writeFileSync(
            path.join(src, "sample.py"),
            [
                'logger.info("event=context_truncated")',
                'logger.info("event={}", value)',
                'logger.info("event=%s", value)',
                'logger.info("event=${dynamic}")',
            ].join("\n"),
            "utf8",
        );
        const scan = scanRepo(fixture);
        assert.deepEqual(
            scan.catalog.log.map((entry) => entry.key),
            ["context_truncated"],
        );
        assert.equal(scan.dynamic.count, 3);
        const result = evaluateCatalog(scan.catalog, {
            baseline: EMPTY_BASELINE,
            semantics: NO_SEMANTICS,
        });
        assert.equal(result.red.length, 0, "dynamic values must not create red findings");
    } finally {
        rmSync(fixture, { recursive: true, force: true });
    }
});

test("baseline grandfathers existing keys; a bad old name is not RED", () => {
    const result = evaluateCatalog(
        { log: [logEntry("agent_memory_passive_write")], sse: [], agentEvent: [] },
        {
            baseline: { ...EMPTY_BASELINE, logEventKeys: ["agent_memory_passive_write"] },
            semantics: NO_SEMANTICS,
        },
    );
    assert.equal(result.red.length, 0);
});

test("protocol whitelist keys are frozen and never RED", () => {
    const result = evaluateCatalog(
        { log: [], sse: [logEntry("done"), logEntry("heartbeat")], agentEvent: [] },
        { baseline: EMPTY_BASELINE, semantics: NO_SEMANTICS },
    );
    assert.equal(result.red.length, 0);
});
