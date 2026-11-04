#!/usr/bin/env node
/**
 * BL-303 / check:event-keys —— 事件名审计扫描器（Phase 3，默认 report-only）。
 *
 * 判据（与 internal/A03-xihe/docs/xh-event-naming-audit.md §9 对齐）：
 *   ① 同语义出现多个"活跃"键 ⇒ RED；alias 过了 aliasRetireAfter 仍出现 ⇒ RED。
 *   ② 不在 baseline 的新键必须匹配 `^(domain)_([a-z0-9]+_)*(past_verb)$`，domain ∈ 10 词白名单；
 *      协议白名单（done/error/token/...）与 baseline 旧键除外。
 *   ③ 动态 event 值（event={} / event=%s / event=${...}）只 WARN，不阻断。
 *
 * 默认 `--report-only`：始终 exit 0（只出报告）。`--enforce` 才会在 RED 时 exit 1。
 * `--write-baseline` 从当前扫描结果生成 config/event-keys-baseline.json（显式动作）。
 *
 * 零依赖（Node 24）；单次全树扫描目标 ≤2s。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DOMAINS = [
    "context",
    "messages",
    "run",
    "tool",
    "approval",
    "session",
    "workspace",
    "credential",
    "mcp",
    "export",
];

/** Frozen protocol names: never subject to the naming rule. */
export const PROTOCOL_WHITELIST = new Set([
    "done",
    "error",
    "token",
    "status",
    "usage",
    "heartbeat",
    "connected",
]);

/** Past participles / terminal-state facts accepted by the model. */
export const PAST_VERBS = [
    "created",
    "updated",
    "deleted",
    "failed",
    "rejected",
    "applied",
    "completed",
    "started",
    "closed",
    "received",
    "served",
    "written",
    "skipped",
    "expired",
    "refused",
    "denied",
    "succeeded",
    "observed",
    "detected",
    "violated",
    "cancelled",
    "truncated",
    "retried",
    "opened",
    "exhausted",
    "required",
    "unavailable",
    "disabled",
    "enabled",
    "hit",
    "missed",
    "exceeded",
    "used",
    "cleared",
    "restored",
    "resumed",
    "timed_out",
    "queued",
    "admitted",
    "responded",
    "called",
    "pruned",
    "replaced",
    "forked",
    "asked",
    "answered",
    "added",
    "revisioned",
];

const DOMAIN_RE = new RegExp(`^(${DOMAINS.join("|")})_([a-z0-9]+_)*([a-z0-9_]+)$`);
const PAST_RE = new RegExp(`^(${PAST_VERBS.join("|")})$`);

/** Returns null when compliant, else a short reason. */
export function namingRuleViolation(key) {
    if (PROTOCOL_WHITELIST.has(key)) return null;
    const match = DOMAIN_RE.exec(key);
    if (!match) return `domain 不在白名单（${DOMAINS.join("/")}）`;
    const verb = match[3];
    if (!PAST_RE.test(verb)) return `结尾不是过去分词/终态词（${verb}）`;
    return null;
}

function asDateOnly(value) {
    return new Date(`${value}T23:59:59.999Z`);
}

/**
 * Pure evaluator (unit-testable; no filesystem).
 *
 * @param {{ log: Array<{key:string, locations:string[]}>, sse: Array<...>, agentEvent: Array<...> }} catalog
 * @param {{baseline: object, semantics: object, today?: string}} options
 */
export function evaluateCatalog(catalog, { baseline, semantics, today = new Date().toISOString().slice(0, 10) }) {
    const red = [];
    const yellow = [];
    const greenNew = [];
    const groups = Array.isArray(semantics?.groups) ? semantics.groups : [];
    const baselineSets = {
        log: new Set(baseline?.logEventKeys ?? []),
        sse: new Set(baseline?.sseEventNames ?? []),
        agentEvent: new Set(baseline?.agentEventTypes ?? []),
    };
    const todayMs = asDateOnly(today).getTime();

    for (const kind of ["log", "sse", "agentEvent"]) {
        const entries = catalog[kind] ?? [];
        const byKey = new Map(entries.map((entry) => [entry.key, entry]));
        const claimedAliases = new Set();
        const claimedCanonical = new Set();

        for (const group of groups) {
            const canon = group.canonical;
            const aliases = Array.isArray(group.aliases) ? group.aliases : [];
            const canonicalPresent = byKey.has(canon);
            const presentAliases = aliases.filter((alias) => byKey.has(alias.key));
            for (const alias of presentAliases) claimedAliases.add(alias.key);
            if (canonicalPresent) claimedCanonical.add(canon);

            if (presentAliases.length > 1) {
                red.push({
                    kind,
                    key: presentAliases.map((alias) => alias.key).join(","),
                    rule: "same-semantic-multiple-aliases",
                    detail: `语义组 ${canon} 同时存在 ${presentAliases.length} 个 alias`,
                });
            }
            for (const alias of presentAliases) {
                const retireMs = alias.retireAfter ? asDateOnly(alias.retireAfter).getTime() : Infinity;
                const expired = retireMs < todayMs;
                if (expired) {
                    red.push({
                        kind,
                        key: alias.key,
                        rule: "alias-retired",
                        detail: `alias 已过 aliasRetireAfter=${alias.retireAfter}，双写必须退场`,
                    });
                } else {
                    yellow.push({
                        kind,
                        key: alias.key,
                        rule: "alias-in-migration-window",
                        detail: canonicalPresent
                            ? `canonical ${canon} 与 alias 并存（迁移窗口至 ${alias.retireAfter ?? "未定"}）`
                            : `待改名 alias（canonical ${canon} 尚未出现；窗口至 ${alias.retireAfter ?? "未定"}）`,
                    });
                }
            }
            if (canonicalPresent && presentAliases.length > 0) {
                yellow.push({
                    kind,
                    key: canon,
                    rule: "dual-write-active",
                    detail: `旧名仍在（${presentAliases.map((alias) => alias.key).join(",")}）；双写窗口内允许`,
                });
            }
        }

        for (const entry of entries) {
            if (claimedAliases.has(entry.key) || claimedCanonical.has(entry.key)) continue;
            if (baselineSets[kind].has(entry.key)) continue;
            if (PROTOCOL_WHITELIST.has(entry.key)) continue;
            const violation = namingRuleViolation(entry.key);
            if (violation) {
                red.push({ kind, key: entry.key, rule: "new-key-naming", detail: violation });
            } else {
                greenNew.push({ kind, key: entry.key });
            }
        }
    }

    return { red, yellow, greenNew };
}

function walkFiles(root, onFile) {
    const stack = [root];
    let scanned = 0;
    while (stack.length > 0) {
        const current = stack.pop();
        let entries;
        try {
            entries = readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (
                    ["node_modules", "target", ".venv", "dist", ".git", "__pycache__"].includes(
                        entry.name,
                    )
                ) {
                    continue;
                }
                if (
                    entry.name === "test" ||
                    entry.name === "tests" ||
                    entry.name === "__tests__" ||
                    entry.name === "docs" ||
                    entry.name === "plans"
                ) {
                    continue;
                }
                stack.push(full);
                continue;
            }
            if (!/\.(java|py|rs|ts|mjs|vue)$/.test(entry.name)) continue;
            if (/\.(spec|test)\.(ts|mjs|js)$/.test(entry.name)) continue;
            scanned += 1;
            onFile(full);
        }
    }
    return scanned;
}

function firstLocations(map, key, file, line, limit = 5) {
    const entry = map.get(key) ?? { key, locations: [], count: 0 };
    entry.count += 1;
    if (entry.locations.length < limit) entry.locations.push(`${file}:${line}`);
    map.set(key, entry);
}

export function scanRepo(root) {
    const packageRoots = ["control-plane", "agent", "ui", "runtime"]
        .map((name) => path.join(root, "packages", name, "src"))
        .filter((candidate) => existsSync(candidate));
    const logMap = new Map();
    const sseMap = new Map();
    const agentEventMap = new Map();
    const dynamicSamples = [];
    let dynamicCount = 0;

    const logRe = /\bevent=([a-z][a-z0-9_]*)/g;
    const dynamicRe = /\bevent=(?:\{\}|%[sd]|\$\{[^}]+\})/g;
    const sseRe = /\.send\(\s*[^,;]+,\s*"([a-z][a-z0-9_]*)"/g;
    const sseConstRe = /SSE_EVENT_[A-Z0-9_]+\s*=\s*"([a-z][a-z0-9_]*)"/g;
    const agentEventRe = /AgentEvent\(\s*type="([a-z][a-z0-9_]*)"/g;

    let files = 0;
    for (const packageRoot of packageRoots) {
        files += walkFiles(packageRoot, (full) => {
            const rel = path.relative(root, full).replaceAll(path.sep, "/");
            let text;
            try {
                text = readFileSync(full, "utf8");
            } catch {
                return;
            }
            const lines = text.split("\n");
            for (let index = 0; index < lines.length; index += 1) {
                const line = lines[index];
                const trimmed = line.trimStart();
                if (
                    trimmed.startsWith("//") ||
                    trimmed.startsWith("*") ||
                    trimmed.startsWith("#") ||
                    trimmed.startsWith("--")
                ) {
                    continue;
                }
                let match;
                logRe.lastIndex = 0;
                while ((match = logRe.exec(line)) !== null) {
                    firstLocations(logMap, match[1], rel, index + 1);
                }
                dynamicRe.lastIndex = 0;
                while ((match = dynamicRe.exec(line)) !== null) {
                    dynamicCount += 1;
                    if (dynamicSamples.length < 5) {
                        dynamicSamples.push(`${rel}:${index + 1} ${match[0]}`);
                    }
                }
                if (rel.includes("control-plane")) {
                    sseRe.lastIndex = 0;
                    while ((match = sseRe.exec(line)) !== null) {
                        firstLocations(sseMap, match[1], rel, index + 1);
                    }
                    sseConstRe.lastIndex = 0;
                    while ((match = sseConstRe.exec(line)) !== null) {
                        firstLocations(sseMap, match[1], rel, index + 1);
                    }
                }
                if (rel.includes("packages/agent/")) {
                    agentEventRe.lastIndex = 0;
                    while ((match = agentEventRe.exec(line)) !== null) {
                        firstLocations(agentEventMap, match[1], rel, index + 1);
                    }
                }
            }
        });
    }

    const toCatalog = (map) => [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
    return {
        files,
        catalog: {
            log: toCatalog(logMap),
            sse: toCatalog(sseMap),
            agentEvent: toCatalog(agentEventMap),
        },
        dynamic: { count: dynamicCount, samples: dynamicSamples },
    };
}

function readJson(file) {
    return JSON.parse(readFileSync(file, "utf8"));
}

export function buildBaseline(scan, root) {
    let commit = "unknown";
    try {
        commit = execFileSync("git", ["-C", root, "rev-parse", "--short=12", "HEAD"], {
            encoding: "utf8",
        }).trim();
    } catch {
        /* keep unknown (offline tarball) */
    }
    return {
        _note:
            "BL-303 check:event-keys baseline (grandfather). 只登记当前存量名，不代表推荐名；" +
            "新键不在这里才会被 namingRuleViolation 检查。由 `node scripts/check-event-keys.mjs --write-baseline` 生成，review 后提交。",
        generatedAt: new Date().toISOString(),
        a03Commit: commit,
        counts: {
            logEventKeys: scan.catalog.log.length,
            sseEventNames: scan.catalog.sse.length,
            agentEventTypes: scan.catalog.agentEvent.length,
        },
        logEventKeys: scan.catalog.log.map((entry) => entry.key),
        sseEventNames: scan.catalog.sse.map((entry) => entry.key),
        agentEventTypes: scan.catalog.agentEvent.map((entry) => entry.key),
    };
}

function parseArgs(argv) {
    const options = {
        root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
        baseline: null,
        semantics: null,
        enforce: false,
        json: false,
        writeBaseline: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--enforce") options.enforce = true;
        else if (arg === "--report-only") options.enforce = false;
        else if (arg === "--json") options.json = true;
        else if (arg === "--write-baseline") options.writeBaseline = true;
        else if (arg === "--root") options.root = path.resolve(argv[++index]);
        else if (arg === "--baseline") options.baseline = path.resolve(argv[++index]);
        else if (arg === "--semantics") options.semantics = path.resolve(argv[++index]);
        else if (arg === "--help" || arg === "-h") options.help = true;
        else throw new Error(`unknown argument: ${arg}`);
    }
    options.baseline ??= path.join(options.root, "config/event-keys-baseline.json");
    options.semantics ??= path.join(options.root, "config/event-keys-semantics.json");
    return options;
}

function printReport(scan, evaluation, elapsedMs, options) {
    const baseline = options.baselineExists ? readJson(options.baseline) : null;
    const lines = [
        `[check:event-keys] mode=${options.enforce ? "enforce" : "report-only"}`,
        `root: ${options.root}`,
        `scanned: ${scan.files} files (${scan.dynamic.count} dynamic event values)` +
            (baseline ? `; baseline ${baseline.counts.logEventKeys} log / ${baseline.counts.sseEventNames} sse / ${baseline.counts.agentEventTypes} agent-event keys (${baseline.a03Commit})` : "; baseline absent"),
        `RED   ${evaluation.red.length}`,
        `YELLOW ${evaluation.yellow.length}`,
        `GREEN_NEW ${evaluation.greenNew.length}`,
        `elapsed ${elapsedMs.toFixed(0)}ms`,
    ];
    for (const item of evaluation.red.slice(0, 30)) {
        lines.push(`  RED [${item.kind}] ${item.key} — ${item.detail}`);
    }
    for (const item of evaluation.yellow.slice(0, 20)) {
        lines.push(`  YELLOW [${item.kind}] ${item.key} — ${item.detail}`);
    }
    for (const item of evaluation.greenNew.slice(0, 10)) {
        lines.push(`  NEW-GREEN [${item.kind}] ${item.key}`);
    }
    for (const sample of scan.dynamic.samples) {
        lines.push(`  WARN dynamic: ${sample}`);
    }
    return lines.join("\n");
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(
            "usage: node scripts/check-event-keys.mjs [--report-only|--enforce] [--json] [--write-baseline] [--root DIR] [--baseline FILE] [--semantics FILE]",
        );
        return 0;
    }
    const started = performance.now();
    const scan = scanRepo(options.root);
    const elapsedMs = performance.now() - started;

    if (options.writeBaseline) {
        const baseline = buildBaseline(scan, options.root);
        writeFileSync(options.baseline, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
        console.log(
            `[check:event-keys] wrote ${options.baseline} (${baseline.counts.logEventKeys} log / ${baseline.counts.sseEventNames} sse / ${baseline.counts.agentEventTypes} agent-event keys, a03 ${baseline.a03Commit}) in ${elapsedMs.toFixed(0)}ms`,
        );
        return 0;
    }

    options.baselineExists = existsSync(options.baseline);
    if (!options.baselineExists) {
        console.error(`[check:event-keys] baseline missing: ${options.baseline}`);
        return 2;
    }
    if (!existsSync(options.semantics)) {
        console.error(`[check:event-keys] semantics missing: ${options.semantics}`);
        return 2;
    }
    const evaluation = evaluateCatalog(scan.catalog, {
        baseline: readJson(options.baseline),
        semantics: readJson(options.semantics),
    });
    if (options.json) {
        console.log(
            JSON.stringify(
                {
                    mode: options.enforce ? "enforce" : "report-only",
                    files: scan.files,
                    dynamic: scan.dynamic,
                    red: evaluation.red,
                    yellow: evaluation.yellow,
                    greenNew: evaluation.greenNew,
                    elapsedMs: Number(elapsedMs.toFixed(1)),
                },
                null,
                2,
            ),
        );
    } else {
        console.log(printReport(scan, evaluation, elapsedMs, options));
    }
    if (options.enforce && evaluation.red.length > 0) return 1;
    return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    main()
        .then((code) => process.exit(code))
        .catch((error) => {
            console.error(`[check:event-keys] scan error: ${error.message}`);
            process.exit(2);
        });
}
