#!/usr/bin/env node
/**
 * e2e 类型门（PLAN-0626 后续）。
 *
 * 背景：`packages/ui/tsconfig.json` 只 include `src/**` 与 `vite.config.ts`，`e2e/` **不在任何
 * tsconfig 覆盖内**，所以 e2e 的错误只能靠"跑一次 Playwright 才炸"发现。这里补一个静态门：
 *
 *   1. 用 `tsconfig.e2e.json` 跑 `tsc --noEmit`；
 *   2. 与 `e2e-typecheck-baseline.json` 比对 —— **只拦新增错误**，存量按 (文件, TS 码) 计数在册；
 *   3. 基线只允许缩小：修好一条就从基线删一条，脚本会打印"已消失的基线条目"提示收账。
 *
 * 用法：
 *   node scripts/typecheck-e2e.mjs                 # 门（有新增错误 ⇒ exit 1）
 *   node scripts/typecheck-e2e.mjs --write-baseline # 重写基线（仅在有明确理由时用）
 *   node scripts/typecheck-e2e.mjs --verbose        # 连存量错误也逐条打印
 *
 * 为什么用基线而不是"全绿"：存量 63 条是 Playwright 1.5x 类型与 DOM lib 的既有冲突
 * （`route.request().url()` 的 `URL`、`APIResponse` vs `Response` 等），一次性修完属独立
 * 技术债；先让门生效，新增错误立刻拦住。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const TSCONFIG = path.join(PACKAGE_ROOT, "tsconfig.e2e.json");
const BASELINE = path.join(PACKAGE_ROOT, "e2e-typecheck-baseline.json");
const TSC = path.join(PACKAGE_ROOT, "node_modules", "typescript", "bin", "tsc");

const args = new Set(process.argv.slice(2));
const writeBaseline = args.has("--write-baseline");
const verbose = args.has("--verbose");

if (!existsSync(TSC)) {
    console.error(
        `[typecheck:e2e] 找不到 ${path.relative(PACKAGE_ROOT, TSC)}：请先在 packages/ui 跑 pnpm install。`,
    );
    process.exit(2);
}
if (!existsSync(TSCONFIG)) {
    console.error(`[typecheck:e2e] 缺少 ${path.relative(PACKAGE_ROOT, TSCONFIG)}。`);
    process.exit(2);
}

const run = spawnSync(process.execPath, [TSC, "--noEmit", "-p", TSCONFIG], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    timeout: 5 * 60 * 1000,
});
const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
const errorLines = output.split(/\r?\n/).filter((line) => /: error TS\d+/.test(line));

/** `e2e/mock/a.spec.ts(12,3): error TS2349: …` → { file: "e2e/mock/a.spec.ts", code: "TS2349" } */
function parseError(line) {
    const match = /^(?<file>.+?)\((?<line>\d+),(?<col>\d+)\): error (?<code>TS\d+)/.exec(line);
    if (!match) return null;
    return { file: match.groups.file.replace(/\\/g, "/"), code: match.groups.code };
}

const counts = new Map();
for (const line of errorLines) {
    const parsed = parseError(line);
    if (!parsed) continue;
    const key = `${parsed.file}\u0000${parsed.code}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
}

function toBaselineObject(map) {
    const files = {};
    for (const [key, count] of [...map.entries()].sort()) {
        const [file, code] = key.split("\u0000");
        files[file] ??= {};
        files[file][code] = count;
    }
    return { note: "e2e 类型门存量基线 —— 只允许缩小：修好一条删一条。", files };
}

if (writeBaseline) {
    writeFileSync(BASELINE, `${JSON.stringify(toBaselineObject(counts), null, 2)}\n`, "utf8");
    console.log(
        `[typecheck:e2e] 已写入基线：${counts.size} 个 (文件, TS 码) 组合，共 ${errorLines.length} 条存量错误。`,
    );
    process.exit(0);
}

const baseline = existsSync(BASELINE)
    ? (JSON.parse(readFileSync(BASELINE, "utf8")).files ?? {})
    : {};
const known = new Map();
for (const [file, codes] of Object.entries(baseline)) {
    for (const [code, count] of Object.entries(codes)) known.set(`${file}\u0000${code}`, count);
}

const newErrors = [];
const staleKeys = [];
for (const [key, count] of counts.entries()) {
    const allowed = known.get(key) ?? 0;
    if (count > allowed) {
        const [file, code] = key.split("\u0000");
        newErrors.push({ file, code, count, allowed });
    }
}
for (const [key, count] of known.entries()) {
    if ((counts.get(key) ?? 0) < count) {
        const [file, code] = key.split("\u0000");
        staleKeys.push({ file, code, baseline: count, actual: counts.get(key) ?? 0 });
    }
}

if (verbose) {
    console.log(`[typecheck:e2e] 存量错误逐条（${errorLines.length}）：`);
    for (const line of errorLines) console.log(`  ${line}`);
}

if (staleKeys.length) {
    console.log(
        `[typecheck:e2e] 基线可收账：${staleKeys.length} 个组合的错误已少于基线（修好了就 --write-baseline 更新）：`,
    );
    for (const item of staleKeys.slice(0, 20)) {
        console.log(`  - ${item.file} ${item.code}: 基线 ${item.baseline} → 实际 ${item.actual}`);
    }
}

if (newErrors.length) {
    console.error(
        `[typecheck:e2e] 新增类型错误 ${newErrors.length} 个组合（存量 ${errorLines.length} 条在册）：`,
    );
    for (const item of newErrors) {
        console.error(`  x ${item.file} ${item.code}: 基线 ${item.allowed} → 实际 ${item.count}`);
    }
    console.error(
        "[typecheck:e2e] 修掉这些错误；确属存量（例如新文件照搬旧写法）请走评审后再 --write-baseline。",
    );
    process.exit(1);
}

console.log(
    `[typecheck:e2e] 通过：新增 0；存量 ${errorLines.length} 条在册（${counts.size} 个 (文件, TS 码) 组合）。`,
);
