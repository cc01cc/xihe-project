#!/usr/bin/env node
/**
 * task-62 / check-doc-line-refs —— 文档「文件:行号」引用漂移扫描（**report-only**）。
 *
 * 背景：文档写 `AuthController.java:137` 这种行号引用，被引文件一插段就整体位移
 * （task-58 实证：DEV-033 的 mise.toml 一批 11 条全漂；task-60 盘点：抽样 60 条里 46.7% 已漂）。
 * 本脚本只做一件事：**带锚的引用**在声明行 ±WINDOW 内搜不到锚 ⇒ 报漂移。
 *
 * 引用形态（一期）：
 *   `path/to/File.java:137#withFirstWorkspace`      ← 带锚（会被检查）
 *   `mise.toml:413#dev:host`                        ← 锚里允许 : # . - $ 等符号字符
 *   `path/to/File.java:137`                         ← **不带锚**：不判错，只计数（存量过渡口径）
 *
 * 判定：
 *   ok               锚在 [line-W, line+W] 内命中
 *   drift            锚不在窗口内（若全篇另有命中，detail 里给出 :行号 供改锚或改号）
 *   out-of-range     行号超过目标文件行数
 *   missing-target   目标文件不存在
 *   ambiguous-target 只写文件名且同名多义（引用没写够路径）
 *   no-anchor        不带锚 ⇒ 不判错、只计数（task-62 裁定：否则一期就红一片）
 *
 * 默认 **report-only：永远 exit 0**（与 check:event-keys 同一推进节奏）。
 * `--strict` 才在 drift/out-of-range/missing-target 存在时 exit 1（留给将来接门禁用）。
 *
 * 一期覆盖（易漂集，可用 --all-targets 放开）：mise.toml / ChatController.java / index.ts /
 * openapi.yaml / useSSE.ts / main.css。白名单（默认跳过的目录）：plans、archive、evidence。
 *
 * 用法：
 *   node scripts/check-doc-line-refs.mjs [--root <dir>]... [--json] [--all-targets]
 *        [--baseline <json>] [--write-baseline <json>] [--strict]
 * 零依赖（Node 24）。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const WINDOW = 10;
export const EASY_DRIFT_TARGETS = [
    "mise.toml",
    "ChatController.java",
    "index.ts",
    "openapi.yaml",
    "useSSE.ts",
    "main.css",
];
export const DEFAULT_WHITELIST = ["plans", "archive", "evidence"];
const SKIP_DIRS = new Set([
    "node_modules",
    "target",
    ".git",
    ".worktrees",
    ".local",
    "dist",
    "build",
    ".venv",
    "__pycache__",
    ".tmp",
    ".next",
    "coverage",
]);

const REF_RE = /`([A-Za-z0-9_@./+-]+\.(?:java|kt|ts|tsx|vue|sql|mjs|cjs|js|toml|json|jsonc|md|py|yaml|yml|xml|ps1|sh|rs|css|mts)):(\d+)(?:-(\d+))?(?:#([A-Za-z0-9_$.#:\-]+))?`/gu;

/** 从一段 markdown 里抽引用。返回 [{line, target, start, end, anchor, raw}] */
export function parseRefs(text) {
    const out = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
        REF_RE.lastIndex = 0;
        let m;
        while ((m = REF_RE.exec(lines[i])) !== null) {
            const start = Number(m[2]);
            const end = m[3] === undefined ? start : Number(m[3]);
            out.push({
                line: i + 1,
                target: m[1],
                start: Math.min(start, end),
                end: Math.max(start, end),
                anchor: m[4] ?? null,
                raw: m[0],
            });
        }
    }
    return out;
}

const norm = (p) => p.split("\\").join("/");

/** 目录遍历（跳过构建/缓存目录与白名单目录） */
export function walkMarkdown(rootDir, whitelist = DEFAULT_WHITELIST) {
    const files = [];
    const stack = [rootDir];
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name) || whitelist.includes(entry.name)) continue;
                stack.push(full);
                continue;
            }
            if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
        }
    }
    return files.sort();
}

function walkAll(indexRoots) {
    const files = [];
    const seen = new Set();
    const stack = [...indexRoots];
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) continue;
                stack.push(full);
                continue;
            }
            if (entry.isFile() && !seen.has(full)) {
                // 索引根可能互相嵌套（projectRoot 是 oneRoot 的子目录）⇒ 去重，否则每个文件都被算成"同名多义"
                seen.add(full);
                files.push(full);
            }
        }
    }
    return files;
}

export function buildIndex(indexRoots) {
    const byBase = new Map();
    for (const file of walkAll(indexRoots)) {
        const base = file.slice(file.lastIndexOf(sep) + 1);
        const list = byBase.get(base);
        if (list === undefined) byBase.set(base, [file]);
        else list.push(file);
    }
    return byBase;
}

/** 目标文件解析：绝对 → 项目根 → one 根 → 引用处目录 → 全索引唯一同名 */
export function resolveTarget(refTarget, citingFile, ctx) {
    const t = norm(refTarget);
    const base = t.slice(t.lastIndexOf("/") + 1);
    const candidates = [];
    if (isAbsolute(t)) candidates.push(t);
    // 显式路径优先；只写文件名时，先按「项目根」解释（mise.toml / AGENTS.md / README.md 这类仓库根文件）
    candidates.push(join(ctx.projectRoot, t), join(ctx.oneRoot, t), join(dirname(citingFile), t));
    for (const candidate of candidates) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return { file: candidate };
    }
    let list = ctx.index.get(base);
    if (list === undefined || list.length === 0) return { file: null, reason: "missing" };
    // 同名多义时，先用「落在本项目树内」缩小（A03 文档引 A03 文件），仍多义才判 ambiguous
    const preferred = list.filter((p) => norm(p).startsWith(norm(ctx.projectRoot) + "/"));
    if (preferred.length > 0) list = preferred;
    if (list.length > 1) {
        const suffix = "/" + t.toLowerCase();
        const narrowed = list.filter((p) => norm(p).toLowerCase().endsWith(suffix));
        if (narrowed.length === 1) return { file: narrowed[0] };
        return { file: null, reason: "ambiguous", count: list.length };
    }
    return { file: list[0] };
}

/** 单条引用判定 */
export function classifyRef(ref, citingFile, ctx) {
    const resolved = resolveTarget(ref.target, citingFile, ctx);
    const item = {
        citing: norm(relative(ctx.oneRoot, citingFile)),
        citingLine: ref.line,
        target: ref.target,
        lines: ref.start === ref.end ? String(ref.start) : ref.start + "-" + ref.end,
        anchor: ref.anchor,
        status: "ok",
        detail: "",
        foundAt: [],
    };
    if (resolved.file === null) {
        item.status = resolved.reason === "ambiguous" ? "ambiguous-target" : "missing-target";
        item.detail = resolved.reason === "ambiguous"
            ? "同名 " + resolved.count + " 个候选，引用没写够路径"
            : "目标文件不存在";
        return item;
    }
    item.resolvedTarget = norm(relative(ctx.oneRoot, resolved.file));
    const lines = readFileSync(resolved.file, "utf8").split("\n");
    if (ref.start > lines.length) {
        item.status = "out-of-range";
        item.detail = "目标仅 " + lines.length + " 行";
        return item;
    }
    if (ref.anchor === null) {
        item.status = "no-anchor";
        item.detail = "不带锚，不判错（计数）";
        return item;
    }
    const needle = ref.anchor;
    const from = Math.max(1, ref.start - WINDOW);
    const to = Math.min(lines.length, ref.end + WINDOW);
    for (let n = from; n <= to; n += 1) {
        if (lines[n - 1].includes(needle)) {
            item.status = "ok";
            item.detail = "锚命中 :" + n;
            item.foundAt = [n];
            return item;
        }
    }
    const all = [];
    for (let n = 0; n < lines.length; n += 1) if (lines[n].includes(needle)) all.push(n + 1);
    item.status = "drift";
    item.detail = all.length === 0
        ? "锚在目标文件全篇 0 命中（可能主张过期，见 task-60 文档 §3）"
        : "锚不在 ±" + WINDOW + " 行窗口内；全篇命中 " + all.slice(0, 6).map((n) => ":" + n).join(",");
    item.foundAt = all.slice(0, 20);
    return item;
}

/** 扫描一批 md */
export function scan({ roots, indexRoots, projectRoot, oneRoot, scope = EASY_DRIFT_TARGETS, whitelist = DEFAULT_WHITELIST }) {
    const ctx = { projectRoot, oneRoot, index: buildIndex(indexRoots) };
    const items = [];
    let refs = 0;
    let outOfScope = 0;
    for (const root of roots) {
        for (const file of walkMarkdown(root, whitelist)) {
            const text = readFileSync(file, "utf8");
            for (const ref of parseRefs(text)) {
                refs += 1;
                const base = ref.target.slice(ref.target.lastIndexOf("/") + 1);
                if (scope !== null && !scope.includes(base)) {
                    outOfScope += 1;
                    continue;
                }
                items.push(classifyRef(ref, file, ctx));
            }
        }
    }
    const count = (status) => items.filter((i) => i.status === status).length;
    const totals = {
        refs,
        inScope: items.length,
        outOfScope,
        checked: items.length - count("no-anchor"),
        ok: count("ok"),
        drift: count("drift"),
        outOfRange: count("out-of-range"),
        missingTarget: count("missing-target"),
        ambiguousTarget: count("ambiguous-target"),
        withoutAnchor: count("no-anchor"),
    };
    const byTarget = new Map();
    for (const item of items) {
        const base = item.target.slice(item.target.lastIndexOf("/") + 1);
        const row = byTarget.get(base) ?? { target: base, refs: 0, checked: 0, ok: 0, drift: 0, outOfRange: 0, missingTarget: 0, withoutAnchor: 0 };
        row.refs += 1;
        if (item.status === "ok") row.ok += 1;
        else if (item.status === "drift") row.drift += 1;
        else if (item.status === "out-of-range") row.outOfRange += 1;
        else if (item.status === "missing-target" || item.status === "ambiguous-target") row.missingTarget += 1;
        else if (item.status === "no-anchor") row.withoutAnchor += 1;
        if (item.status !== "no-anchor") row.checked += 1;
        byTarget.set(base, row);
    }
    return {
        schema: "check-doc-line-refs/1",
        reportOnly: true,
        window: WINDOW,
        roots: roots.map((r) => norm(relative(oneRoot, r))),
        scope: scope === null ? null : scope,
        totals,
        byTarget: [...byTarget.values()].sort((a, b) => b.refs - a.refs),
        items,
    };
}

// 引用身份 = 引用处行 + 目标文件（不含行号）：修好一条时只改行号，身份不变，才能算「已修复」
const itemKey = (item) => item.citing + "|" + item.citingLine + "|" + item.target;

export function compareBaseline(current, baseline) {
    const baselineDrift = new Set((baseline.items ?? []).filter((i) => i.status === "drift").map(itemKey));
    const currentDrift = current.items.filter((i) => i.status === "drift");
    const currentKeys = new Set(currentDrift.map(itemKey));
    const newDrift = currentDrift.filter((i) => !baselineDrift.has(itemKey(i)));
    // 「已修复」只算**本次真扫到且不再漂**的项；本次没扫到的项不算修复（否则未带锚的存量会被误读成已修好）
    const currentByKey = new Map(current.items.map((i) => [itemKey(i), i]));
    const fixed = (baseline.items ?? []).filter((i) => i.status === "drift"
        && currentByKey.has(itemKey(i)) && currentByKey.get(itemKey(i)).status !== "drift");
    return {
        path: baseline.pathHint ?? "",
        baselineDrift: baselineDrift.size,
        newDrift: newDrift.length,
        fixed: fixed.length,
        remaining: currentDrift.length,
        newItems: newDrift.map(itemKey),
        fixedItems: fixed.map(itemKey),
    };
}

function printHuman(result, out) {
    const t = result.totals;
    out.write("[check-doc-line-refs] report-only（默认 exit 0；--strict 才拦截）\n");
    out.write("roots: " + result.roots.join(", ") + "\n");
    out.write("scope: " + (result.scope === null ? "all-targets" : result.scope.join(", ")) + "\n");
    out.write("refs=" + t.refs + " in-scope=" + t.inScope + " out-of-scope=" + t.outOfScope + "\n");
    out.write("checked=" + t.checked + " ok=" + t.ok + " drift=" + t.drift + " out-of-range=" + t.outOfRange
        + " missing-target=" + t.missingTarget + " ambiguous-target=" + t.ambiguousTarget
        + " 无锚(不判错)=" + t.withoutAnchor + "\n");
    if (result.baseline !== undefined) {
        const b = result.baseline;
        out.write("baseline: 基线漂移=" + b.baselineDrift + " 新增=" + b.newDrift + " 已修复=" + b.fixed + " 剩余=" + b.remaining + "\n");
    }
    const bad = result.items.filter((i) => i.status === "drift" || i.status === "out-of-range" || i.status === "missing-target");
    if (bad.length > 0) {
        out.write("-- 漂移明细（" + bad.length + " 条）：\n");
        for (const item of bad.slice(0, 40)) {
            out.write("   " + item.citing + ":" + item.citingLine + " → " + item.target + ":" + item.lines
                + (item.anchor === null ? "" : "#" + item.anchor) + "  [" + item.status + "] " + item.detail + "\n");
        }
        if (bad.length > 40) out.write("   … 其余 " + (bad.length - 40) + " 条见 --json\n");
    }
    out.write("-- 无锚引用（计数，不判错）：" + t.withoutAnchor + " 条\n");
}

function parseArgs(argv) {
    const opts = { roots: [], json: false, allTargets: false, baseline: null, writeBaseline: null, strict: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--root") opts.roots.push(argv[++i]);
        else if (arg === "--json") opts.json = true;
        else if (arg === "--all-targets") opts.allTargets = true;
        else if (arg === "--baseline") opts.baseline = argv[++i];
        else if (arg === "--write-baseline") opts.writeBaseline = argv[++i];
        else if (arg === "--strict") opts.strict = true;
        else if (arg === "--help" || arg === "-h") opts.help = true;
        else throw new Error("未知参数: " + arg);
    }
    return opts;
}

function main() {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const projectRoot = resolve(scriptDir, "..");
    const oneRoot = resolve(projectRoot, "..");
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        process.stdout.write("用法: node scripts/check-doc-line-refs.mjs [--root <dir>]... [--json] [--all-targets] [--baseline <json>] [--write-baseline <json>] [--strict]\n");
        return 0;
    }
    const roots = (opts.roots.length > 0 ? opts.roots : [join(projectRoot, "docs")]).map((r) => resolve(r));
    for (const root of roots) {
        if (!existsSync(root)) throw new Error("扫描根不存在: " + root);
    }
    const indexRoots = [projectRoot];
    if (existsSync(join(oneRoot, "config")) && existsSync(join(oneRoot, "scripts"))) indexRoots.push(oneRoot);
    const result = scan({
        roots,
        indexRoots,
        projectRoot,
        oneRoot,
        scope: opts.allTargets ? null : EASY_DRIFT_TARGETS,
    });
    if (opts.baseline !== null) {
        const baseline = JSON.parse(readFileSync(resolve(opts.baseline), "utf8"));
        baseline.pathHint = norm(opts.baseline);
        result.baseline = compareBaseline(result, baseline);
    }
    if (opts.writeBaseline !== null) writeFileSync(resolve(opts.writeBaseline), JSON.stringify(result, null, 2) + "\n");
    if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else printHuman(result, process.stdout);
    const failing = result.totals.drift + result.totals.outOfRange + result.totals.missingTarget;
    if (opts.strict && failing > 0) return 1;
    return 0;
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) process.exitCode = main();
