#!/usr/bin/env node
/**
 * PLAN-0687 / check:e2e-bypass —— E2E in-page bypass 静态门（默认 report-only，永不阻断）。
 *
 * 判据（承 PLAN-0644 §4.3 / D7，PLAN-0687 F1 改判后口径）：
 *   - 扫描 `packages/ui/e2e/real/**` 的每个 `page.evaluate(...)` 块，块内出现 `fetch(` ⇒ in-page
 *     fetch 命中（即「在浏览器页内直接调后端接口」的候选，可能绕过被测产品 UI）。
 *   - 每个命中必须满足其一才算 PASS：
 *       ① 同块内（或 evaluate 起始前 2 行）有 `// fixture-only: <理由>` 或 `// read-only: <理由>`
 *          —— 对应 0644 §4.3 允许通道（夹具准备 / 只读查询）；
 *       ② 在 allowlist `config/e2e-inpage-bypass-allowlist.json` 中登记（file + url）。
 *   - 其余 ⇒ VIOLATION。bypass（完成产品行为）应改产品 UI 路径，不得靠标注洗白 —— 标注只是
 *     「声明这是允许通道」的机制，裁定语义见 PLAN-0687 `spec/bypass-audit-matrix.md`。
 *
 * 口径与零依赖：注释/字符串内的 `page.evaluate`/`fetch` 不计（轻量 tokenizer；与 PLAN-0687 M0 的
 * TypeScript AST 扫描结果逐条对齐，见 `plans/PLAN-0687-.../evidence/rescan.md`）。mock lane 不在本门
 * 判据内（0644 §4.3 判据针对 real lane 的产品路径）。`mock/` 命中由 PLAN-0687 只登记不扩包。
 *
 * 用法：
 *   node scripts/check-e2e-inpage-bypass.mjs                # 默认 report-only（exit 0）
 *   node scripts/check-e2e-inpage-bypass.mjs --enforce      # 有 violation ⇒ exit 1
 *   node scripts/check-e2e-inpage-bypass.mjs --json         # 机器可读
 *   node scripts/check-e2e-inpage-bypass.mjs --write-baseline  # 当前 violation 写进 allowlist
 *   node scripts/check-e2e-inpage-bypass.mjs --root <dir> --config <file>
 *   node scripts/check-e2e-inpage-bypass.mjs --expect-hits 12 --expect-annotated 12   # BL-430 基线计数断言
 *
 * BL-430 / PLAN-0736：report-only 门只看 violation，命中计数漂移会静默通过。加 `--expect-hits <n>`
 * 与 `--expect-annotated <n>`（或读 `config/e2e-inpage-bypass-baseline.json` 的 {hits, annotated}）后，
 * 实测 ≠ 期望 ⇒ exit 1 + 差异清单；计数变了必须显式改基线（登记新命中/清掉旧命中），不许静默漂移。
 *
 * 退出码：0 = 通过（report-only 恒 0）；1 = --enforce 且有 violation；2 = 扫描/配置错误。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 判据作用面：只扫 real lane（mock lane 不在 0644 §4.3 判据内）。 */
export const SCAN_DIRS = ["packages/ui/e2e/real"];

/** 参与扫描的源码后缀。 */
export const FILE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

/** 允许通道标注：`// fixture-only:` / `// read-only:`（0644 design:188 约定 + 本 PLAN 扩展）。 */
export const ANNOTATION_PATTERN = /\/\/\s*(fixture-only|read-only)\s*:/i;

/** allowlist 默认位置（仓库相对）。 */
export const DEFAULT_CONFIG = "config/e2e-inpage-bypass-allowlist.json";
/** 基线计数默认位置（BL-430 / PLAN-0736）：report-only 门也校验 hits/annotated 不漂移。 */
export const DEFAULT_BASELINE = "config/e2e-inpage-bypass-baseline.json";

/**
 * 读取基线计数（BL-430）：`{hits: n, annotated: m}`；文件缺失/字段非法 ⇒ null。
 * 期望可通过 `--expect-hits/--expect-annotated` 显式覆盖基线。
 */
export function loadBaselineCounts(absPath) {
    if (!existsSync(absPath)) return null;
    try {
        const parsed = JSON.parse(readFileSync(absPath, "utf8"));
        const hitCount = Number(parsed?.hits);
        const annotatedCount = Number(parsed?.annotated);
        if (!Number.isInteger(hitCount) || hitCount < 0) return null;
        if (!Number.isInteger(annotatedCount) || annotatedCount < 0) return null;
        return { hits: hitCount, annotated: annotatedCount };
    } catch {
        return null;
    }
}

/**
 * 对比实测与期望（BL-430）：只比给定的期望字段；返回差异清单，空数组 = 一致。
 */
export function countDiffs({ hits, annotated, expectHits, expectAnnotated }) {
    const diffs = [];
    if (expectHits !== null && expectHits !== undefined && Number.isInteger(expectHits) && hits !== expectHits) {
        diffs.push({ kind: "hits", expected: expectHits, actual: hits });
    }
    if (expectAnnotated !== null && expectAnnotated !== undefined && Number.isInteger(expectAnnotated) && annotated !== expectAnnotated) {
        diffs.push({ kind: "annotated", expected: expectAnnotated, actual: annotated });
    }
    return diffs;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 把注释与字符串内容替换为空格（保留换行与长度），得到可安全做括号匹配/关键字搜索的掩码文本。
 * 只在真实源码结构上搜索，避免 `// page.evaluate(() => fetch(...))` 这类注释被误判。
 */
export function maskSource(source) {
    const chars = source.split("");
    const masked = Array.from({ length: chars.length });
    let state = "code";
    let quote = "";
    for (let i = 0; i < chars.length; i += 1) {
        const ch = chars[i];
        const next = chars[i + 1];
        if (state === "code") {
            if (ch === "/" && next === "/") {
                state = "line-comment";
                masked[i] = " ";
                continue;
            }
            if (ch === "/" && next === "*") {
                state = "block-comment";
                masked[i] = " ";
                continue;
            }
            if (ch === '"' || ch === "'" || ch === "`") {
                state = "string";
                quote = ch;
                masked[i] = " ";
                continue;
            }
            masked[i] = ch;
            continue;
        }
        if (state === "line-comment") {
            if (ch === "\n") {
                state = "code";
                masked[i] = "\n";
            } else {
                masked[i] = " ";
            }
            continue;
        }
        if (state === "block-comment") {
            if (ch === "*" && next === "/") {
                masked[i] = " ";
                masked[i + 1] = " ";
                i += 1;
                state = "code";
            } else {
                masked[i] = ch === "\n" ? "\n" : " ";
            }
            continue;
        }
        // string
        if (ch === "\\") {
            masked[i] = " ";
            if (i + 1 < chars.length) {
                masked[i + 1] = chars[i + 1] === "\n" ? "\n" : " ";
                i += 1;
            }
            continue;
        }
        if (ch === quote) {
            state = "code";
            masked[i] = " ";
            continue;
        }
        masked[i] = ch === "\n" ? "\n" : " ";
    }
    return masked.join("");
}

function lineAt(text, index) {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i += 1) {
        if (text.charCodeAt(i) === 10) line += 1;
    }
    return line;
}

function matchParen(masked, openIndex) {
    let depth = 0;
    for (let i = openIndex; i < masked.length; i += 1) {
        const ch = masked[i];
        if (ch === "(") depth += 1;
        else if (ch === ")") {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/** 从 `fetch(` 起始位置抽取第一个实参的字面量 URL（模板字符串保留 `${...}` 原样）。 */
function extractUrl(source, fetchIndex) {
    const chunk = source.slice(fetchIndex, fetchIndex + 400);
    const callMatch = /fetch\s*\(\s*([`'"]?)/.exec(chunk);
    if (!callMatch) return "";
    const quote = callMatch[1];
    const start = fetchIndex + callMatch[0].length;
    if (!quote) {
        const bare = /^([^\s,)]{1,300})/.exec(source.slice(start, start + 300));
        return bare ? bare[1] : "";
    }
    const end = source.indexOf(quote, start);
    if (end === -1) return "";
    return source.slice(start, end);
}

/** 抽取命中附近的 HTTP method（`method: 'PATCH'` 形式）；识别不到返回空串。 */
function extractMethod(source, fetchIndex) {
    const windowStart = Math.max(0, fetchIndex - 400);
    const windowText = source.slice(windowStart, fetchIndex + 400);
    const methodMatch = /method\s*:\s*['"`]([A-Za-z]+)['"`]/.exec(windowText);
    return methodMatch ? methodMatch[1].toUpperCase() : "";
}

/**
 * 扫描一段源码，返回 in-page fetch 命中列表。
 * @param {string} source 源码
 * @param {{file: string}} meta 文件（仓库相对 POSIX 路径）
 * @returns {Array<{file: string, evaluateLine: number, evaluateEndLine: number, fetchLine: number, url: string, method: string}>}
 */
export function scanSource(source, { file }) {
    const masked = maskSource(source);
    const lines = source.split(/\r?\n/);
    const hits = [];
    const evaluateRe = /page\s*[!?]?\s*\.\s*evaluate\s*\(/g;
    let match;
    while ((match = evaluateRe.exec(masked)) !== null) {
        const openIndex = match.index + match[0].length - 1;
        const closeIndex = matchParen(masked, openIndex);
        if (closeIndex === -1) break;
        const evaluateLine = lineAt(masked, match.index);
        const evaluateEndLine = lineAt(masked, closeIndex);
        const body = masked.slice(openIndex + 1, closeIndex);
        const fetchRe = /\bfetch\s*\(/g;
        let fetchMatch;
        while ((fetchMatch = fetchRe.exec(body)) !== null) {
            const fetchIndex = openIndex + 1 + fetchMatch.index;
            hits.push({
                file,
                evaluateLine,
                evaluateEndLine,
                fetchLine: lineAt(masked, fetchIndex),
                url: extractUrl(source, fetchIndex),
                method: extractMethod(source, fetchIndex),
            });
        }
        // 标注扫描：evaluate 起始前 2 行 ~ 块结束行
        const from = Math.max(1, evaluateLine - 2);
        const annotation = lines.slice(from - 1, evaluateEndLine).some((line) => ANNOTATION_PATTERN.test(line));
        for (const hit of hits) {
            if (hit.evaluateLine === evaluateLine) hit.annotated = annotation;
        }
        evaluateRe.lastIndex = closeIndex + 1;
    }
    return hits;
}

function walkFiles(root, dir, out) {
    const full = path.join(root, dir);
    if (!existsSync(full)) return;
    for (const entry of readdirSync(full, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const rel = path.posix.join(dir.split(path.sep).join("/"), entry.name);
        if (entry.isDirectory()) {
            walkFiles(root, rel, out);
            continue;
        }
        if (!entry.isFile()) continue;
        if (!FILE_EXTENSIONS.has(path.extname(entry.name))) continue;
        out.push(rel);
    }
}

/** 扫描 root 下判据作用面，返回 { files, hits }。 */
export function scanRoot(root) {
    const files = [];
    for (const dir of SCAN_DIRS) walkFiles(root, dir, files);
    files.sort();
    const hits = [];
    for (const file of files) {
        const source = readFileSync(path.join(root, file), "utf8");
        hits.push(...scanSource(source, { file }));
    }
    return { files, hits };
}

/** 读取 allowlist；缺失视为空（不致命），JSON 坏 ⇒ 抛错。 */
export function loadAllowlist(absPath) {
    if (!existsSync(absPath)) return { exists: false, entries: [] };
    const parsed = JSON.parse(readFileSync(absPath, "utf8"));
    const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed.entries) ? parsed.entries : [];
    return { exists: true, entries };
}

function allowlistMatch(entries, hit) {
    return entries.find((entry) => {
        if (!entry || entry.file !== hit.file) return false;
        if (entry.url) return entry.url === hit.url;
        return entry.evaluateLine === hit.evaluateLine;
    });
}

/**
 * 判定：annotation 优先，其次 allowlist；返回分类计数与 violation 列表。
 */
export function evaluateHits({ hits, allowlist }) {
    const annotated = [];
    const allowlisted = [];
    const violations = [];
    for (const hit of hits) {
        if (hit.annotated) {
            annotated.push(hit);
            continue;
        }
        const entry = allowlistMatch(allowlist, hit);
        if (entry) {
            allowlisted.push({ ...hit, allowlistReason: entry.reason ?? "" });
            continue;
        }
        violations.push(hit);
    }
    return { annotated, allowlisted, violations };
}

/** 生成 allowlist 内容（--write-baseline）：把当前 violation 全部登记为基线残留。 */
export function buildAllowlist({ hits, root, generatedAt }) {
    const entries = hits.map((hit) => ({
        file: hit.file,
        evaluateLine: hit.evaluateLine,
        fetchLine: hit.fetchLine,
        url: hit.url,
        reason: `baseline ${generatedAt}（grandfathered；应改 // fixture-only: / // read-only: 标注或改产品路径）`,
    }));
    return {
        $comment: "PLAN-0687 in-page bypass allowlist：仅用于历史残留登记。新增命中优先加 `// fixture-only:` / `// read-only:` 标注；禁止用本文件洗白 bypass。",
        version: 1,
        generatedBy: "scripts/check-e2e-inpage-bypass.mjs --write-baseline",
        generatedAt,
        generatedFrom: path.posix.join(path.basename(root) || "", "packages/ui/e2e/real"),
        entries,
    };
}

function formatHit(hit) {
    const method = hit.method ? `${hit.method} ` : "";
    const url = hit.url || "(无法解析 URL)";
    return `${hit.file}:${hit.fetchLine} [evaluate@${hit.evaluateLine}] ${method}${url}`;
}

export function printReport({ evaluation, scannedFiles, elapsedMs, mode, allowlistPath }) {
    const lines = [];
    lines.push(
        `[check:e2e-bypass] mode=${mode} scanned=${scannedFiles} hits=${evaluation.annotated.length + evaluation.allowlisted.length + evaluation.violations.length} annotated=${evaluation.annotated.length} allowlisted=${evaluation.allowlisted.length} violations=${evaluation.violations.length} (${elapsedMs.toFixed(0)}ms)`,
    );
    if (!evaluation.violations.length) {
        lines.push("  ✓ 所有 in-page fetch 命中都有允许通道标注或在 allowlist 中");
        return lines.join("\n");
    }
    lines.push(`  allowlist: ${allowlistPath}`);
    for (const hit of evaluation.violations) {
        lines.push(`  ✗ VIOLATION ${formatHit(hit)}`);
    }
    lines.push("  修法：夹具/只读用法加 `// fixture-only: <理由>` 或 `// read-only: <理由>`；完成产品行为的调用改走产品 UI 路径（不得标注洗白）。");
    return lines.join("\n");
}

function parseArgs(argv) {
    const options = {
        root: REPO_ROOT,
        config: path.join(REPO_ROOT, DEFAULT_CONFIG),
        baseline: path.join(REPO_ROOT, DEFAULT_BASELINE),
        expectHits: null,
        expectAnnotated: null,
        enforce: false,
        json: false,
        writeBaseline: false,
        help: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--enforce") options.enforce = true;
        else if (arg === "--report-only") options.enforce = false;
        else if (arg === "--json") options.json = true;
        else if (arg === "--write-baseline") options.writeBaseline = true;
        else if (arg === "--help" || arg === "-h") options.help = true;
        else if (arg === "--root") options.root = path.resolve(argv[++i]);
        else if (arg === "--config") options.config = path.resolve(argv[++i]);
        else if (arg === "--expect-hits") options.expectHits = Number(argv[++i]);
        else if (arg === "--expect-annotated") options.expectAnnotated = Number(argv[++i]);
        else if (arg === "--baseline") options.baseline = path.resolve(argv[++i]);
        else throw new Error(`未知参数: ${arg}（--help 查看用法）`);
    }
    if (options.expectHits !== null && (!Number.isInteger(options.expectHits) || options.expectHits < 0)) {
        throw new Error("--expect-hits 必须是非负整数");
    }
    if (options.expectAnnotated !== null && (!Number.isInteger(options.expectAnnotated) || options.expectAnnotated < 0)) {
        throw new Error("--expect-annotated 必须是非负整数");
    }
    return options;
}

const HELP = `check:e2e-bypass —— E2E in-page bypass 静态门（PLAN-0687）

用法:
  node scripts/check-e2e-inpage-bypass.mjs [选项]

选项:
  --report-only       只报告，始终 exit 0（默认）
  --enforce           有 violation 时 exit 1
  --json              机器可读输出
  --write-baseline    把当前 violation 写入 allowlist（显式动作，慎用）
  --root <dir>        仓库根（默认 = 本脚本上一级）
  --config <file>     allowlist 路径（默认 config/e2e-inpage-bypass-allowlist.json）
  --baseline <file>   基线计数路径（默认 config/e2e-inpage-bypass-baseline.json）
  --expect-hits <n>   期望 real 命中数（缺省读基线；实测 ≠ 期望 ⇒ exit 1）
  --expect-annotated <n> 期望已标注数（缺省读基线；实测 ≠ 期望 ⇒ exit 1）
  --help              显示本帮助

判据见文件头注释与 PLAN-0687 design.md。`;

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        console.log(HELP);
        return 0;
    }
    const started = performance.now();
    const scan = scanRoot(options.root);
    let allowlist;
    try {
        allowlist = loadAllowlist(options.config);
    } catch (error) {
        console.error(`[check:e2e-bypass] allowlist 不可解析: ${options.config}: ${error.message}`);
        return 2;
    }
    const evaluation = evaluateHits({ hits: scan.hits, allowlist: allowlist.entries });
    const baselineCounts = options.root === REPO_ROOT ? loadBaselineCounts(options.baseline) : null;
    const elapsedMs = performance.now() - started;
    const mode = options.writeBaseline ? "write-baseline" : options.enforce ? "enforce" : "report-only";

    if (options.writeBaseline) {
        const payload = buildAllowlist({
            hits: evaluation.violations,
            root: options.root,
            generatedAt: new Date().toISOString().slice(0, 10),
        });
        writeFileSync(options.config, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
        console.log(
            `[check:e2e-bypass] wrote ${options.config} (${payload.entries.length} 条基线残留) —— 优先改用 // fixture-only: 标注`,
        );
        return 0;
    }

    if (options.json) {
        console.log(
            JSON.stringify(
                {
                    mode,
                    root: options.root,
                    scannedFiles: scan.files.length,
                    hits: scan.hits.length,
                    annotated: evaluation.annotated.length,
                    allowlisted: evaluation.allowlisted.length,
                    violations: evaluation.violations.map((hit) => ({ ...hit })),
                    allowlist: options.config,
                    allowlistExists: allowlist.exists,
                    elapsedMs: Number(elapsedMs.toFixed(1)),
                },
                null,
                2,
            ),
        );
    } else {
        console.log(
            printReport({
                evaluation,
                scannedFiles: scan.files.length,
                elapsedMs,
                mode,
                allowlistPath: options.config,
            }),
        );
    }
    // BL-430 / PLAN-0736：report-only 门也要校验命中计数漂移；差异 ⇒ exit 1 + 清单。
    // 仅当 root = 本仓库（REPO_ROOT）时才生效：fixture root 是夹具树（默认基线不适用），
    // 显式 --expect-hits/--expect-annotated/--baseline 时仍照常校验。
    const expectHits = options.expectHits ?? (baselineCounts?.hits ?? null);
    const expectAnnotated = options.expectAnnotated ?? (baselineCounts?.annotated ?? null);
    const actualHits = scan.hits.length;
    const actualAnnotated = evaluation.annotated.length;
    const countDiffsResult = countDiffs({ hits: actualHits, annotated: actualAnnotated, expectHits, expectAnnotated });
    if (countDiffsResult.length > 0) {
        const lines = countDiffsResult.map((diff) => `  ✗ COUNT_MISMATCH ${diff.kind}: expected=${diff.expected} actual=${diff.actual} (Δ=${diff.actual - diff.expected})`);
        console.error(`[check:e2e-bypass] 基线计数漂移（BL-430）：`);
        console.error(lines.join("\n"));
        console.error(`  修法：命中数变化必须显式改基线/allowlist 并登记新命中或清掉旧命中（不许静默漂移）。`);
        return 1;
    }
    if (options.enforce && evaluation.violations.length > 0) return 1;
    return 0;
}

export { REPO_ROOT, main };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    main()
        .then((code) => {
            process.exitCode = code;
        })
        .catch((error) => {
            console.error(`[check:e2e-bypass] scan error: ${error.message}`);
            process.exitCode = 2;
        });
}
