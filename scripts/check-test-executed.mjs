#!/usr/bin/env node
/**
 * BL-461 / PLAN-0727: Maven `-Dtest` zero-match guard.
 *
 * `mvn test -Dtest=<typo>` can print BUILD SUCCESS while executing **zero** tests and
 * writing **no** surefire reports. This script reads the reports Maven just wrote and
 * fails when there is nothing to prove execution:
 *   - reports dir missing / no TEST-*.xml        ⇒ exit 1 (zero-execution false green)
 *   - total tests= is 0                          ⇒ exit 1
 *   - total tests > 0                            ⇒ exit 0
 *   - malformed args / unreadable XML            ⇒ exit 2
 *
 * Usage: node scripts/check-test-executed.mjs [--reports <dir>] [--json]
 * Default reports dir: <cwd>/target/surefire-reports (run from packages/control-plane,
 * or pass an explicit --reports when -Dxihe.target.dir is used).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_REPORTS = path.join(process.cwd(), "target", "surefire-reports");

export function summarizeReports(reportsDir, { since = null } = {}) {
    const result = { reportsDir, files: 0, tests: 0, skipped: 0, errors: 0, failures: 0 };
    if (!fs.existsSync(reportsDir)) return result;
    for (const name of fs.readdirSync(reportsDir)) {
        if (!name.startsWith("TEST-") || !name.endsWith(".xml")) continue;
        const fullPath = path.join(reportsDir, name);
        // BL-461: 只统计本次运行写出的报告；否则旧的 surefire 报告会让 0 执行也"绿".
        if (since !== null && fs.statSync(fullPath).mtimeMs < since) continue;
        const text = fs.readFileSync(fullPath, "utf8");
        const tests = /\btests="(\d+)"/.exec(text);
        const skipped = /\bskipped="(\d+)"/.exec(text);
        const errors = /\berrors="(\d+)"/.exec(text);
        const failures = /\bfailures="(\d+)"/.exec(text);
        if (!tests) throw new Error(`surefire report has no tests= attribute: ${name}`);
        result.files += 1;
        result.tests += Number(tests[1]);
        result.skipped += skipped ? Number(skipped[1]) : 0;
        result.errors += errors ? Number(errors[1]) : 0;
        result.failures += failures ? Number(failures[1]) : 0;
    }
    return result;
}

function parseArgs(argv) {
    const out = { reportsDir: DEFAULT_REPORTS, json: false, since: null };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--reports") {
            const value = argv[++i];
            if (!value) throw new Error("--reports requires a directory");
            out.reportsDir = path.resolve(value);
        } else if (arg === "--since") {
            const value = argv[++i];
            if (!value || !Number.isFinite(Number(value))) throw new Error("--since requires epoch ms");
            out.since = Number(value);
        } else if (arg === "--json") {
            out.json = true;
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    return out;
}

function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(`[check-test-executed] ${error.message}`);
        return 2;
    }
    let summary;
    try {
        summary = summarizeReports(options.reportsDir, { since: options.since });
    } catch (error) {
        console.error(`[check-test-executed] 解析 surefire 报告失败：${error.message}`);
        return 2;
    }
    if (options.json) console.log(JSON.stringify(summary));
    const line =
        `[check-test-executed] reports=${summary.files} tests=${summary.tests} ` +
        `failures=${summary.failures} errors=${summary.errors} skipped=${summary.skipped} ` +
        `dir=${options.reportsDir}`;
    if (summary.files === 0 || summary.tests === 0) {
        console.error(`${line}\n[check-test-executed] 零执行假绿：Did you mean to run any tests? ` +
            `Maven may print BUILD SUCCESS with -Dtest matching nothing; refusing to report green.`);
        return 1;
    }
    console.log(line);
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exit(main());
}
