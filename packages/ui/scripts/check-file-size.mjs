#!/usr/bin/env node
/**
 * 文件长度 ratchet 门（task-1030；Lead 2026-11-24 裁定）。
 *
 * 为什么自研：oxlint 1.83.0 **不实现任何长度规则** —— `max-lines` /
 * `max-lines-per-function` / `max-statements` / `max-depth` / `complexity` /
 * `max-nested-callbacks` 在 `node_modules/oxlint/dist/plugins.js` 全部 grep 不到。
 * 证据与阈值理由见 `docs/file-size-gate.md`。
 *
 * 判据（行数 + 字节双阈值，与 `check-lint-warnings.mjs` 同一 ratchet 手法）：
 *   1. 不在基线且超 error 阈值 ⇒ exit 1（新文件不许一上来就超标）；
 *   2. 在基线但行数或字节变大 ⇒ exit 1（存量只许变小）；
 *   3. 在基线且变小 / 消失 / 已低于 warn 阈值 ⇒ 打提示「可收缩」，不阻断；
 *   4. `*.d.ts` 与基线 `$exempt` 列出的路径不参与判定（理由逐项登记在基线里）。
 *
 * 用法：
 *   node scripts/check-file-size.mjs                  # 只判（lint gate 用）
 *   node scripts/check-file-size.mjs --write-baseline # 生成/吸收存量（默认只增不删）
 *   node scripts/check-file-size.mjs --write-baseline --prune
 *                                                     # 同批收缩已低于 warn 阈值的存量
 *   node scripts/check-file-size.mjs --root <dir> [--root <dir> …]
 *                                                     # 多根扫描，同一路径取最大值
 *                                                     # （用于 HEAD 与工作树的并集，防止把在途缩小写进基线）
 *   node scripts/check-file-size.mjs --baseline <path> # 换基线文件（测试用）
 *
 * 基线只能由本脚本生成/收缩，勿手改。
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_BASELINE = join(ROOT, "file-size-baseline.json");

/** 扫 `src/` 时要整体跳过的目录名（判据见卡面：测试 / 预览 / e2e 不是产品源文件）。 */
export const EXCLUDED_DIRS = Object.freeze(["__tests__", "preview", "e2e"]);
const EXCLUDED_DIR_SET = new Set(EXCLUDED_DIRS);

/**
 * 阈值为首版取值（task-1030 要求 1）。行数是硬信号，字节兜住「一行几千字符」的极端文件；
 * `src/i18n/messages/**` 是文案密集区，按卡面放宽到 1200 行 error。
 */
export const THRESHOLDS = Object.freeze({
    default: Object.freeze({
        warnLines: 500,
        errorLines: 900,
        warnBytes: 24_000,
        errorBytes: 48_000,
    }),
    i18nMessages: Object.freeze({
        warnLines: 900,
        errorLines: 1_200,
        warnBytes: 90_000,
        errorBytes: 120_000,
    }),
});

const TYPE_DECLARATION_REASON = "纯类型声明（.d.ts），无运行时代码";

/** 归一化为仓库风格的相对路径（正斜杠）。 */
export function toPosix(value) {
    return value.split(String.fromCharCode(92)).join("/");
}

/** 目录段级排除：只认完整段，避免 `preview-dockview.html` 这类名字被误伤。 */
export function isExcluded(relPath) {
    return relPath.split("/").some((segment) => EXCLUDED_DIR_SET.has(segment));
}

export function isTypeDeclaration(relPath) {
    return relPath.endsWith(".d.ts");
}

export function thresholdsFor(relPath) {
    return relPath.startsWith("src/i18n/messages/") ? THRESHOLDS.i18nMessages : THRESHOLDS.default;
}

/**
 * 行数口径：`wc -l` 语义（换行符个数；末尾无换行则补 1）。
 * 不用 `split("\n")`，因为大文件会多分配一份整文件数组。
 */
export function countLines(text) {
    if (text.length === 0) return 0;
    let lines = 0;
    for (let i = 0; i < text.length; i += 1) {
        if (text.charCodeAt(i) === 10) lines += 1;
    }
    if (!text.endsWith("\n")) lines += 1;
    return lines;
}

function isSourceFile(name) {
    return name.endsWith(".ts") || name.endsWith(".vue");
}

/** 扫单个根的 `src/`，返回 [{ path, lines, bytes }]（path 相对该根）。 */
export function scanRoot(root) {
    const files = [];
    const walk = (dir) => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!EXCLUDED_DIR_SET.has(entry.name)) walk(full);
                continue;
            }
            if (!entry.isFile() || !isSourceFile(entry.name)) continue;
            const buffer = readFileSync(full);
            files.push({
                path: toPosix(relative(root, full)),
                lines: countLines(buffer.toString("utf8")),
                bytes: buffer.length,
            });
        }
    };
    walk(join(root, "src"));
    return files;
}

/** 多根合并：同一相对路径取 (lines, bytes) 各自最大值，保证基线对每棵树都成立。 */
export function mergeScans(scans) {
    const byPath = new Map();
    for (const files of scans) {
        for (const file of files) {
            const prev = byPath.get(file.path);
            if (!prev) {
                byPath.set(file.path, { ...file });
                continue;
            }
            prev.lines = Math.max(prev.lines, file.lines);
            prev.bytes = Math.max(prev.bytes, file.bytes);
        }
    }
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * 判定本体（纯函数，测试直接构造输入）。
 * @returns {{ errors: object[], warnings: object[], shrinks: object[], exempt: object[], stock: object[] }}
 */
export function evaluate({ files, baseline, exemptions = {} }) {
    const baseFiles = baseline?.files ?? {};
    const errors = [];
    const warnings = [];
    const shrinks = [];
    const exempt = [];
    const stock = [];
    const seen = new Set();

    for (const file of files) {
        const relPath = file.path;
        if (isExcluded(relPath)) continue;
        seen.add(relPath);
        if (isTypeDeclaration(relPath) || Object.hasOwn(exemptions, relPath)) {
            exempt.push({ path: relPath, lines: file.lines, bytes: file.bytes });
            continue;
        }
        const limits = thresholdsFor(relPath);
        const base = baseFiles[relPath];
        if (base) {
            const grewLines = file.lines > base.lines;
            const grewBytes = file.bytes > base.bytes;
            if (grewLines || grewBytes) {
                errors.push({
                    kind: "grown",
                    path: relPath,
                    lines: file.lines,
                    bytes: file.bytes,
                    baseLines: base.lines,
                    baseBytes: base.bytes,
                    grewLines,
                    grewBytes,
                });
                continue;
            }
            if (file.lines < base.lines || file.bytes < base.bytes) {
                shrinks.push({
                    kind: "shrunk",
                    path: relPath,
                    lines: file.lines,
                    bytes: file.bytes,
                    baseLines: base.lines,
                    baseBytes: base.bytes,
                });
            } else if (file.lines > limits.errorLines || file.bytes > limits.errorBytes) {
                stock.push({ path: relPath, lines: file.lines, bytes: file.bytes });
            }
            continue;
        }
        if (file.lines > limits.errorLines || file.bytes > limits.errorBytes) {
            errors.push({
                kind: "new-over-error",
                path: relPath,
                lines: file.lines,
                bytes: file.bytes,
                limits,
            });
            continue;
        }
        if (file.lines > limits.warnLines || file.bytes > limits.warnBytes) {
            warnings.push({ path: relPath, lines: file.lines, bytes: file.bytes, limits });
        }
    }

    for (const [relPath, base] of Object.entries(baseFiles)) {
        if (seen.has(relPath) || isExcluded(relPath)) continue;
        shrinks.push({
            kind: "missing",
            path: relPath,
            lines: 0,
            bytes: 0,
            baseLines: base.lines,
            baseBytes: base.bytes,
        });
    }

    return { errors, warnings, shrinks, exempt, stock };
}

/**
 * 基线生成（纯函数）：收录所有越过 warn 阈值的文件；默认**只增不删**，
 * 低于 warn 的旧条目不自动丢（避免把「暂时缩小」写成永久放宽），`--prune` 才收缩。
 */
export function buildBaseline({ files, previous, prune = false }) {
    const prevFiles = previous?.files ?? {};
    const prevExempt = previous?.$exempt ?? {};
    const outFiles = {};
    const outExempt = {};
    const seen = new Set();
    const dropped = [];
    const kept = [];

    for (const file of files) {
        const relPath = file.path;
        if (isExcluded(relPath)) continue;
        seen.add(relPath);
        if (isTypeDeclaration(relPath)) {
            outExempt[relPath] = TYPE_DECLARATION_REASON;
            continue;
        }
        const limits = thresholdsFor(relPath);
        const overWarn = file.lines > limits.warnLines || file.bytes > limits.warnBytes;
        if (overWarn) {
            outFiles[relPath] = { lines: file.lines, bytes: file.bytes };
        } else if (!prune && Object.hasOwn(prevFiles, relPath)) {
            outFiles[relPath] = {
                lines: prevFiles[relPath].lines,
                bytes: prevFiles[relPath].bytes,
            };
            kept.push(relPath);
        } else if (Object.hasOwn(prevFiles, relPath)) {
            dropped.push(relPath);
        }
    }

    for (const [relPath, previousEntry] of Object.entries(prevFiles)) {
        if (seen.has(relPath) || isExcluded(relPath)) continue;
        if (prune) {
            dropped.push(relPath);
        } else {
            outFiles[relPath] = { lines: previousEntry.lines, bytes: previousEntry.bytes };
            kept.push(relPath);
        }
    }

    for (const [relPath, reason] of Object.entries(prevExempt)) {
        if (isExcluded(relPath)) continue;
        if (!seen.has(relPath)) {
            if (prune) {
                if (!isTypeDeclaration(relPath)) dropped.push(relPath);
            } else if (!isTypeDeclaration(relPath)) {
                outExempt[relPath] = reason;
                kept.push(relPath);
            }
            continue;
        }
        if (!isTypeDeclaration(relPath) && !Object.hasOwn(outExempt, relPath)) {
            outExempt[relPath] = reason;
        }
    }

    return {
        files: Object.fromEntries(
            Object.entries(outFiles).sort((a, b) => a[0].localeCompare(b[0])),
        ),
        exemptions: Object.fromEntries(
            Object.entries(outExempt).sort((a, b) => a[0].localeCompare(b[0])),
        ),
        kept: kept.sort(),
        dropped: dropped.sort(),
    };
}

function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return null;
    }
}

function pad(value, width) {
    return (String(value) + " ".repeat(width)).slice(0, width);
}

function metricsText(lines, bytes) {
    return lines + " 行 / " + bytes + " B";
}

function renderReport(result, limitsByPath) {
    const lines = [];
    lines.push(
        "file-size: 存量 " +
            result.stock.length +
            " 个允许超标 / warn " +
            result.warnings.length +
            " / exempt " +
            result.exempt.length +
            " / 可收缩 " +
            result.shrinks.length,
    );
    for (const item of result.warnings) {
        const limits = limitsByPath.get(item.path) ?? item.limits;
        lines.push(
            "WARN  " +
                pad(item.path, 72) +
                " " +
                metricsText(item.lines, item.bytes) +
                "（warn " +
                limits.warnLines +
                " 行 / " +
                limits.warnBytes +
                " B）",
        );
    }
    for (const item of result.shrinks) {
        if (item.kind === "missing") {
            lines.push(
                "SHRINK 已消失：" +
                    item.path +
                    "（基线 " +
                    metricsText(item.baseLines, item.baseBytes) +
                    "）",
            );
        } else {
            lines.push(
                "SHRINK " +
                    item.path +
                    "：" +
                    metricsText(item.baseLines, item.baseBytes) +
                    " → " +
                    metricsText(item.lines, item.bytes) +
                    "（可用 --write-baseline --prune 收缩）",
            );
        }
    }
    for (const item of result.errors) {
        if (item.kind === "grown") {
            const grew = [
                item.grewLines ? "行数 +" + (item.lines - item.baseLines) : null,
                item.grewBytes ? "字节 +" + (item.bytes - item.baseBytes) : null,
            ]
                .filter(Boolean)
                .join(" / ");
            lines.push(
                "FAIL  " +
                    pad(item.path, 72) +
                    " 基线内变大（" +
                    grew +
                    "）：" +
                    metricsText(item.baseLines, item.baseBytes) +
                    " → " +
                    metricsText(item.lines, item.bytes),
            );
        } else {
            lines.push(
                "FAIL  " +
                    pad(item.path, 72) +
                    " 新文件超 error 阈值 " +
                    metricsText(item.lines, item.bytes) +
                    "（error " +
                    item.limits.errorLines +
                    " 行 / " +
                    item.limits.errorBytes +
                    " B）",
            );
        }
    }
    return lines;
}

function optionValues(flag) {
    const values = [];
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === flag && typeof argv[i + 1] === "string" && argv[i + 1].length > 0) {
            values.push(argv[i + 1]);
        }
    }
    return values;
}

function main() {
    const flags = new Set(process.argv.slice(2));
    const roots = optionValues("--root").map((value) => resolve(value));
    if (roots.length === 0) roots.push(ROOT);
    const baselinePath = resolve(optionValues("--baseline")[0] ?? DEFAULT_BASELINE);
    const write = flags.has("--write-baseline");
    const prune = flags.has("--prune");

    const files = mergeScans(roots.map((root) => scanRoot(root)));

    if (write) {
        const previous = readJson(baselinePath);
        const built = buildBaseline({ files, previous, prune });
        const core = {
            $comment:
                "文件长度 ratchet 基线（task-1030）：行数 + 字节双阈值，存量只许变小。只能由 node scripts/check-file-size.mjs --write-baseline 生成/收缩，勿手改；新增超标文件或基线内变大都会被限制。",
            total: Object.keys(built.files).length,
            files: built.files,
            $exempt: built.exemptions,
        };
        const keepTimestamp =
            previous !== null &&
            typeof previous.generatedAt === "string" &&
            deepEqual(
                Object.fromEntries(
                    Object.entries(previous).filter(([key]) => key !== "generatedAt"),
                ),
                core,
            );
        const payload = {
            ...core,
            generatedAt: keepTimestamp ? previous.generatedAt : new Date().toISOString(),
        };
        writeFileSync(baselinePath, JSON.stringify(payload, null, 4) + "\n", "utf8");
        console.log(
            "WROTE " +
                baselinePath +
                "：files=" +
                payload.total +
                " / $exempt=" +
                Object.keys(built.exemptions).length +
                "（扫描 " +
                files.length +
                " 个文件，跳过 __tests__/preview/e2e）",
        );
        if (built.kept.length > 0) {
            console.log("KEPT  低于 warn 但仍在基线（默认只增不删）：" + built.kept.length + " 个");
        }
        if (built.dropped.length > 0) {
            console.log("DROPPED 已消失/已收缩：" + built.dropped.length + " 个");
            for (const relPath of built.dropped) console.log("  - " + relPath);
        }
        process.exit(0);
    }

    const baseline = readJson(baselinePath);
    if (baseline === null) {
        console.error("FAIL 读不到基线 " + baselinePath + "（先跑 --write-baseline）");
        process.exit(2);
    }
    const result = evaluate({
        files,
        baseline,
        exemptions: baseline.$exempt ?? {},
    });
    const limitsByPath = new Map();
    for (const file of files) limitsByPath.set(file.path, thresholdsFor(file.path));
    for (const line of renderReport(result, limitsByPath)) console.log(line);

    if (result.errors.length > 0) {
        console.error(
            "FAIL file-size：" +
                result.errors.length +
                " 处超限 / 变大（基线只许变小；确属合理增长须在卡面说明并重生成基线）",
        );
        process.exit(1);
    }
    console.log("PASS file-size（基线内存量 " + result.stock.length + " 个允许超标）");
    process.exit(0);
}

const invokedDirectly =
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) main();
