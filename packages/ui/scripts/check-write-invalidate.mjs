#!/usr/bin/env node
/**
 * 写后失效普查门（task-937 / R74）。
 *
 * <p><b>为什么存在</b>：用户点名的缺陷是「很多组件要整页刷新后才更新值」。本项目**不是**
 * 没有状态管理（Pinia 已在用），缺的是写动作成功后的**读面失效**：创建/改名/绑定/发送
 * 之后只在 mount 或列表为空时读过一次，派生字段（标题/成员）就永远停在旧值。本门把
 * 「写调用之后，同一函数内是否出现读面刷新」变成可枚举、可基线的读数，防止新调用点
 * 继续走同一条短路。</p>
 *
 * <p><b>判据（一条）</b>：扫描 `src/**`（排除 `__tests__`）里的 `api.<写动词>*` 与 `apiPost`，
 * 在**同一函数**内、该调用之后必须出现刷新记号：`load*` / `refresh*` / `reload*` /
 * `invalidate*` / `applySessionRecord` / `replaceFromServer` / `upsertSession` / `readRevision`。
 * 没有 ⇒ 记一条 finding。存量收进 `scripts/write-invalidate-baseline.json`，**只减不增**。</p>
 *
 * <p><b>已知盲区（诚实登记）</b>：① 不建 AST，「同一函数」用括号配对近似，跨函数把刷新写在
 * 调用方不算命中（那正是本门要咬的形态）；② 只认 `api.*` 与 `apiPost`，别的 HTTP 封装不在
 * 判据内；③ 刷新记号是词法判据，不验证它真的打到了对应读面。</p>
 *
 * 用法：
 *   node scripts/check-write-invalidate.mjs [--json] [--write-baseline] [--selftest] [路径…]
 * 退出码：0 通过（findings ≤ baseline）/ 1 新增或超基线 / 2 用法或环境错误 / selftest 不符 1。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const BASELINE = join(ROOT, "scripts", "write-invalidate-baseline.json");
const SKIP = new Set(["node_modules", "dist", ".tmp", "test-results", "e2e-results", ".git"]);
const EXT = /\.(ts|tsx|mts|cts|vue)$/;
const WRITE_CALL = /\bapi\.([A-Za-z0-9_$]+)\s*\(|\bapiPost\s*\(/g;
const WRITE_VERB =
    /^(create|update|delete|rename|archive|bind|unbind|attach|detach|add|remove|set|put|post|patch|submit|save|publish|revoke|grant|fork|start|stop|cancel|approve|reject|invite|upload|move|copy)/;
const REFRESH =
    /\b(load[A-Za-z0-9_]*|refresh[A-Za-z0-9_]*|reload[A-Za-z0-9_]*|invalidate[A-Za-z0-9_]*|applySessionRecord|replaceFromServer|upsertSession|readRevision)\b/;
const FUNCTION_START =
    /(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{|(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\([^;]*?\)\s*=>\s*\{/g;

function stripComments(text) {
    return text.replace(
        /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g,
        (m, str, comment) => str || comment.replace(/[^\n]/g, " "),
    );
}

function collectFiles(roots) {
    const files = [];
    /** 本门扫的是**调用方**；`api.ts` 是 HTTP 客户端的定义处，不是写后读面。 */
    const EXCLUDE = new Set(["src/composables/api.ts"]);
    function walk(dir) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (SKIP.has(entry.name) || entry.name === "__tests__") continue;
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (EXT.test(entry.name)) {
                const display = relative(ROOT, path).replace(/\\/g, "/");
                if (!EXCLUDE.has(display)) files.push(path);
            }
        }
    }
    for (const root of roots) {
        const path = resolve(ROOT, root);
        let stats;
        try {
            stats = statSync(path);
        } catch {
            console.error("FAIL 路径不存在: " + root);
            process.exit(2);
        }
        if (stats.isDirectory()) walk(path);
        else files.push(path);
    }
    return files;
}

/** 括号配对；返回与 `openIndex` 处的 `{` 配对的 `}` 下标，找不到就退回到文本末尾。 */
function matchBrace(text, openIndex) {
    let depth = 0;
    for (let i = openIndex; i < text.length; i += 1) {
        if (text[i] === "{") depth += 1;
        else if (text[i] === "}") {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return text.length - 1;
}

function functionSpans(text) {
    const spans = [];
    for (const match of text.matchAll(FUNCTION_START)) {
        const openIndex = match.index + match[0].lastIndexOf("{");
        spans.push({
            name: match[1] ?? match[2] ?? "anonymous",
            start: match.index,
            end: matchBrace(text, openIndex),
        });
    }
    return spans;
}

/**
 * `api.ts` 里真实存在的 HTTP 方法名。只认这些名字，避免把 Dockview 之类同名实例
 * （`api.addPanel` / `api.setActive`）误当成写调用。`apiPost` 是单独的 HTTP helper，另算。
 */
const HTTP_METHODS = (() => {
    const names = new Set();
    try {
        const source = readFileSync(join(ROOT, "src", "composables", "api.ts"), "utf8");
        for (const match of source.matchAll(/^\s{4}(?:async\s+)?([A-Za-z0-9_$]+)\s*\(/gm))
            names.add(match[1]);
    } catch {
        // 读不到就退化为「只看动词」；gate 仍会如实打印。
    }
    return names;
})();

function scanText(displayPath, rawText, options = {}) {
    const text = stripComments(rawText);
    const spans = functionSpans(text);
    const findings = [];
    for (const match of text.matchAll(WRITE_CALL)) {
        const index = match.index;
        const method = match[1];
        if (method && !options.allowAnyName) {
            if (!WRITE_VERB.test(method) || !HTTP_METHODS.has(method)) continue;
        }
        const call = method ? "api." + method : "apiPost";
        // 多行调用里方法名是 `api.create...`；这里取完整方法名（不含参数）作为 key。
        const callName = call;
        const owner =
            spans
                .filter((span) => span.start <= index && index <= span.end)
                .sort((a, b) => b.start - a.start)[0] ?? null;
        const end = owner ? owner.end : text.length;
        const after = text.slice(index, end);
        if (REFRESH.test(after)) continue;
        findings.push({
            file: displayPath,
            function: owner?.name ?? "top-level",
            call: callName || call,
            line: text.slice(0, index).split("\n").length,
        });
    }
    return findings;
}

function keyOf(finding) {
    return `${finding.file}|${finding.function}|${finding.call}`;
}

function readBaseline() {
    try {
        const parsed = JSON.parse(readFileSync(BASELINE, "utf8"));
        if (parsed && typeof parsed.entries === "object") return parsed.entries;
    } catch {
        // 缺基线 = 空基线（首次可明确报「新增」）。
    }
    return {};
}

function group(findings) {
    const entries = {};
    for (const finding of findings) {
        const key = keyOf(finding);
        entries[key] = (entries[key] ?? 0) + 1;
    }
    return entries;
}

function compare(findings, baseline) {
    const current = group(findings);
    const over = [];
    for (const [key, count] of Object.entries(current)) {
        const allowed = baseline[key] ?? 0;
        if (count > allowed) over.push({ key, count, allowed });
    }
    const stale = Object.keys(baseline).filter((key) => !(key in current));
    return { current, over, stale };
}

function writeBaseline(findings) {
    const entries = group(findings);
    const payload = {
        gate: "check-write-invalidate",
        task: "task-937",
        note: "存量基线，只减不增；新增写调用必须同函数内带读面刷新",
        entries,
    };
    writeFileSync(BASELINE, JSON.stringify(payload, null, 4) + "\n");
    return Object.keys(entries).length;
}

function runSelftest() {
    const dir = mkdtempSync(join(tmpdir(), "xh-write-invalidate-"));
    try {
        const good = join(dir, "good.ts");
        const bad = join(dir, "bad.ts");
        writeFileSync(
            good,
            [
                "async function saveThing() {",
                "    await api.updateThing({ id: 'x' });",
                "    await loadThings();",
                "}",
            ].join("\n"),
        );
        writeFileSync(
            bad,
            [
                "async function saveThing() {",
                "    await api.updateThing({ id: 'x' });",
                "    toast.success('done');",
                "}",
            ].join("\n"),
        );
        const goodFindings = scanText("good.ts", readFileSync(good, "utf8"), {
            allowAnyName: true,
        });
        const badFindings = scanText("bad.ts", readFileSync(bad, "utf8"), {
            allowAnyName: true,
        });
        const checks = [
            ["good fixture has no findings", goodFindings.length === 0],
            ["bad fixture reports one finding", badFindings.length === 1],
            [
                "bad fixture names the call",
                badFindings[0]?.call === "api.updateThing" &&
                    badFindings[0]?.function === "saveThing",
            ],
        ];
        // 反证：同一「坏」文件补上读面刷新后必须消失。
        const repairedFindings = scanText(
            "bad.ts",
            readFileSync(bad, "utf8").replace("toast.success('done');", "await loadThings();"),
            { allowAnyName: true },
        );
        checks.push(["repair removes the finding", repairedFindings.length === 0]);
        // ratchet：基线 1 允许 1，基线 0 则拒绝同一条。
        checks.push([
            "baseline blocks an unregistered finding",
            compare(badFindings, {}).over.length === 1,
        ]);
        checks.push([
            "baseline accepts a registered finding",
            compare(badFindings, group(badFindings)).over.length === 0,
        ]);
        let failed = 0;
        for (const [label, ok] of checks) {
            if (!ok) {
                failed += 1;
                console.error("FAIL " + label);
            }
        }
        if (failed > 0) {
            console.error(`selftest failed: ${failed}/${checks.length}`);
            return 1;
        }
        console.log(`selftest PASS (${checks.length} cases)`);
        return 0;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

function main() {
    const args = process.argv.slice(2);
    if (args.includes("--selftest")) return runSelftest();
    const json = args.includes("--json");
    const write = args.includes("--write-baseline");
    const roots = args.filter((arg) => !arg.startsWith("--"));
    const files = collectFiles(roots.length > 0 ? roots : ["src"]);
    const findings = [];
    for (const file of files) {
        findings.push(
            ...scanText(relative(ROOT, file).replace(/\\/g, "/"), readFileSync(file, "utf8")),
        );
    }
    if (write) {
        const count = writeBaseline(findings);
        console.log(`baseline written: ${count} entries (${findings.length} findings)`);
        return 0;
    }
    const baseline = readBaseline();
    const result = compare(findings, baseline);
    if (json) console.log(JSON.stringify({ findings, ...result }, null, 2));
    else {
        console.log(
            `write-invalidate: ${findings.length} findings / ${Object.keys(baseline).length} baseline entries`,
        );
        for (const item of result.over) {
            console.log(`FAIL ${item.key} (+${item.count - item.allowed})`);
        }
        for (const item of result.stale) console.log(`STALE ${item}`);
    }
    if (result.over.length > 0) return 1;
    return 0;
}

process.exitCode = main();
