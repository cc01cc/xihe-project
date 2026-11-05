#!/usr/bin/env node
/**
 * PLAN-0670 M4 / T4.3 — perf gate evaluator (pure, no stack, no product code).
 *
 * Reads metrics produced by `scripts/perf/run-baseline.mjs` (NDJSON phase lines or one aggregated
 * JSON) and prints PASS/FAIL per check; exit code 0 = PASS, 1 = FAIL, 2 = usage.
 *
 *   node scripts/perf/gate.mjs --metrics <file> [--thresholds <file>] [--json]
 *   node scripts/perf/gate.mjs --metrics <file> --with-ui --ui-metrics <m2d-webui-memory.json>
 *   node scripts/perf/gate.mjs --metrics <file> --self-check        # proves the gate can go red
 *   node scripts/perf/gate.mjs --metrics <file> --write-thresholds   # backfill = measured × 1.5
 *
 * Thresholds live in `scripts/perf/perf-thresholds.json` (provisional until the first full run;
 * see its `source` block). The UI stage is optional because it needs Playwright + an isolated stack.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_THRESHOLDS = join(HERE, "perf-thresholds.json");

function arg(name, fallback = null) {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : process.argv[index + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        console.error(`cannot read JSON ${path}: ${error.message}`);
        process.exit(2);
    }
}

/** Accepts: aggregated {tiers:[...]}, a bare array, or NDJSON phase lines. */
function loadMetrics(path) {
    const text = readFileSync(path, "utf8").trim();
    if (text.startsWith("{")) {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed.tiers) ? parsed.tiers : [parsed];
    }
    if (text.startsWith("[")) return JSON.parse(text);
    return text.split(/\r?\n/).filter((line) => line.trim().startsWith("{"))
        .map((line) => JSON.parse(line))
        .filter((row) => row.phase === "run" || row.phase === "dispatch");
}

function evaluate(metrics, thresholds) {
    const rows = [];
    const push = (tier, check, measured, limit) => rows.push({
        tier, check, measured, limit,
        pass: measured === null || measured === undefined ? true : measured <= limit,
    });
    const seen = new Set();
    for (const metric of metrics) {
        const tier = metric.tier;
        if (!tier || !thresholds.tiers[tier]) continue;
        const limit = thresholds.tiers[tier];
        seen.add(tier);
        if (metric.failures > 0) {
            rows.push({ tier, check: "failures", measured: metric.failures, limit: 0, pass: false });
        }
        if (metric.phase === "dispatch") {
            push(tier, "heapPeakMb", metric.memory?.heapPeakMb ?? null, limit.heapPeakMbMax);
            push(tier, "rssGrowthMb", metric.memory?.rssGrowthMb ?? null, limit.rssGrowthMbMax);
            continue;
        }
        push(tier, "p95Ms", metric.latencyMs?.p95 ?? null, limit.p95Ms);
        push(tier, "responseBytesMean", metric.responseBytes?.mean ?? null, limit.responseBytesMeanMax);
        push(tier, "heapPeakMb", metric.memory?.heapPeakMb ?? null, limit.heapPeakMbMax);
        push(tier, "rssGrowthMb", metric.memory?.rssGrowthMb ?? null, limit.rssGrowthMbMax);
    }
    return { rows, missingTiers: Object.keys(thresholds.tiers).filter((tier) => !seen.has(tier)) };
}

function evaluateUi(uiMetrics, uiThresholds, { legacy = false } = {}) {
    const rows = [];
    const missing = [];
    const push = (tier, check, measured, limit, pass) => rows.push({ tier, check, measured, limit, pass });
    for (const tier of uiMetrics.tiers ?? []) {
        const perf = tier.scrollPerf ?? {};
        const rendered = tier.renderedFirstScreen ?? perf.renderedFirst ?? tier.renderedMessages ?? 0;
        const total = tier.sessionTotal ?? tier.messageCount ?? 0;
        const domNodes = tier.domNodes ?? null;

        if (legacy) {
            // --legacy-full-render: the pre-virtual-scroll criteria, kept so pre-fix code can still
            // be judged on its own terms (history stays comparable; do NOT delete the old rule).
            if (tier.messageCount && domNodes) {
                const perMessage = Math.round((domNodes / tier.messageCount) * 10) / 10;
                const limit = uiThresholds.legacyDomNodesPerMessageMax ?? 25;
                push(`ui-${tier.label}`, "domNodesPerMessage", perMessage, limit, perMessage <= limit);
            }
            if (tier.label === "5k" && tier.status === "ok") {
                push("ui-5k", "fps", perf.fps ?? null, uiThresholds.fps5kMin,
                    (perf.fps ?? 0) >= uiThresholds.fps5kMin);
            }
            if (tier.label === "20k") {
                push("ui-20k", "renderCompleted", `${rendered}/${total}`, `>=${total}`, rendered >= total);
            }
            continue;
        }

        // 1) rendered window band (10..200): a virtual list renders a window, not everything —
        //    but "rendered > 0" alone would let a 1-row fake pass (Lead 2026-11-05).
        if (tier.status === "ok") {
            push(`ui-${tier.label}`, "renderedWindow", `${rendered}/${total}`,
                `${uiThresholds.renderedMin}..${uiThresholds.renderedMax}`,
                rendered >= uiThresholds.renderedMin && rendered <= uiThresholds.renderedMax);
        }
        // 2) DOM absolute cap (nodes must be constant, not proportional to message count).
        if (domNodes !== null && domNodes !== undefined) {
            push(`ui-${tier.label}`, "domNodesMax", domNodes, uiThresholds.domNodesMax,
                domNodes <= uiThresholds.domNodesMax);
        }
        // 3) scrollable: content taller than viewport AND scroll events actually fired.
        //    Files produced by the pre-fix script lack these fields — skip (cannot judge), and the
        //    missing-field list is printed so nobody mistakes "not measured" for "passed".
        if (tier.status === "ok" && perf.scrollable !== undefined && perf.scrollEvents !== undefined) {
            push(`ui-${tier.label}`, "scrollable",
                `${perf.scrollHeightBefore ?? 0}>${perf.clientHeight ?? 0},events=${perf.scrollEvents ?? 0}`,
                "true", Boolean(perf.scrollable) && (perf.scrollEvents ?? 0) > 0);
        } else if (tier.status === "ok") {
            missing.push(`ui-${tier.label}.scrollable`);
        }
        if (tier.label === "5k" && tier.status === "ok") {
            push("ui-5k", "fps", perf.fps ?? null, uiThresholds.fps5kMin,
                (perf.fps ?? 0) >= uiThresholds.fps5kMin);
        }
        if (tier.label === "20k") {
            push("ui-20k", "renderCompleted", tier.status, "ok", tier.status === "ok" && rendered > 0);
        }
    }
    return { rows, missing };
}

function printRows(rows) {
    const label = { p95Ms: "p95 (ms)", responseBytesMean: "response mean (B)", heapPeakMb: "heap peak (MB)",
        rssGrowthMb: "RSS growth (MB)", failures: "failures", domNodesPerMessage: "DOM nodes/msg",
        domNodesMax: "DOM nodes (abs)", renderedWindow: "rendered/total", scrollable: "scrollable",
        fps: "scroll FPS", renderCompleted: "20k render" };
    for (const row of rows) {
        const measured = row.measured === null || row.measured === undefined ? "n/a"
            : typeof row.measured === "number" ? String(Math.round(row.measured * 10) / 10) : String(row.measured);
        console.log(`  ${row.pass ? "PASS" : "FAIL"}  ${row.tier.padEnd(6)} ${(label[row.check] ?? row.check).padEnd(18)} `
            + `measured=${measured.padEnd(14)} limit=${row.limit}`);
    }
}

function impossibleThresholds(thresholds) {
    const clone = JSON.parse(JSON.stringify(thresholds));
    for (const tier of Object.values(clone.tiers)) {
        tier.p95Ms = 0.001;
        tier.responseBytesMeanMax = 1;
        tier.heapPeakMbMax = 1;
        tier.rssGrowthMbMax = 1;
    }
    clone.ui.domNodesMax = 1;
    clone.ui.renderedMin = 100000;
    clone.ui.renderedMax = 0;
    clone.ui.fps5kMin = 100000;
    clone.ui.require20kRender = true;
    return clone;
}

function backfill(metrics, thresholds) {
    const derived = JSON.parse(JSON.stringify(thresholds));
    const round = (value) => value === null || value === undefined ? null : Math.round(value * 10) / 10;
    for (const metric of metrics) {
        const tier = metric.tier;
        if (!tier || !derived.tiers[tier] || metric.phase !== "run") continue;
        const limit = derived.tiers[tier];
        if (metric.latencyMs?.p95) limit.p95Ms = round(metric.latencyMs.p95 * 1.5);
        if (metric.responseBytes?.mean) limit.responseBytesMeanMax = Math.round(metric.responseBytes.mean * 1.5);
        if (metric.memory?.heapPeakMb) limit.heapPeakMbMax = round(metric.memory.heapPeakMb * 1.5);
        if (metric.memory?.rssGrowthMb) limit.rssGrowthMbMax = round(metric.memory.rssGrowthMb * 1.5);
    }
    derived.source.provisional = false;
    derived.source.updatedAt = new Date().toISOString();
    derived.source.backfilledFrom = "perf:chat real run (measured × 1.5)";
    return derived;
}

// ---------------------------------------------------------------------------------------------
const metricsPath = arg("metrics");
if (!metricsPath) {
    console.error("usage: gate.mjs --metrics <file> [--thresholds <file>] [--with-ui --ui-metrics <file>] "
        + "[--self-check] [--write-thresholds] [--json]");
    process.exit(2);
}
const thresholdsPath = resolve(arg("thresholds", DEFAULT_THRESHOLDS));
const metrics = loadMetrics(metricsPath);
let thresholds = readJson(thresholdsPath);
if (flag("self-check")) thresholds = impossibleThresholds(thresholds);
if (flag("write-thresholds")) {
    const backfilled = backfill(metrics, readJson(thresholdsPath));
    writeFileSync(thresholdsPath, `${JSON.stringify(backfilled, null, 2)}\n`, "utf8");
    console.log(`[ok] thresholds backfilled (measured × 1.5) -> ${thresholdsPath}`);
    thresholds = backfilled;
}

const result = evaluate(metrics, thresholds);
const rows = [...result.rows];
let uiResult = null;
if (flag("with-ui")) {
    const uiMetricsPath = arg("ui-metrics");
    if (!uiMetricsPath) {
        console.error("--with-ui needs --ui-metrics <m2d-webui-memory.json>");
        process.exit(2);
    }
    uiResult = evaluateUi(readJson(uiMetricsPath), thresholds.ui,
        { legacy: flag("legacy-full-render") });
    rows.push(...uiResult.rows);
}

const failures = rows.filter((row) => !row.pass);
const passed = failures.length === 0 && result.missingTiers.length === 0;
console.log(`\nPLAN-0670 perf gate — ${flag("with-ui") ? "CP + UI" : "CP"}`
    + `${flag("legacy-full-render") ? " (legacy full-render criteria)" : ""} — `
    + `${passed ? "PASS" : "FAIL"} (${rows.length - failures.length}/${rows.length} checks, `
    + `thresholds=${thresholds.source?.provisional ? "provisional" : "backfilled"})`);
printRows(rows);
if (result.missingTiers.length) console.log(`  FAIL  missing tiers: ${result.missingTiers.join(", ")}`);
if (uiResult?.missing?.length) {
    console.log(`  NOTE  unmeasured UI fields (old script, not judged): ${uiResult.missing.join(", ")}`);
}
if (flag("json")) {
    console.log(JSON.stringify({ passed, rows, missingTiers: result.missingTiers }, null, 2));
}
if (flag("self-check")) {
    const wentRed = !passed;
    console.log(wentRed
        ? "\nSELF-CHECK PASS: gate went red as expected (impossible thresholds)."
        : "\nSELF-CHECK FAIL: gate stayed green with impossible thresholds — the gate is stuck green!");
    process.exit(wentRed ? 0 : 1);
}
process.exit(passed ? 0 : 1);
