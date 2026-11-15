#!/usr/bin/env node
/**
 * oxlint warnings ratchet 门（task-171 ②；「逐步减少 warning」唯一能验收的机制）。
 *
 * 判据：warnings **总数不得超过** packages/ui/oxlint-warning-baseline.json 里的 total。
 * 超出 ⇒ 打印「新增了哪些族、各几条」。errors 恒为硬失败（基线只放宽 warnings）。
 *
 * **默认 report-only**（exit 0，除非 errors > 0）；--enforce 才在超出基线时 exit 1。
 * 接线（放进 lint / validate）属 Lead 裁定，本脚本不自作主张。
 *
 * 用法：
 *   node scripts/check-lint-warnings.mjs                     # 只报（report-only）
 *   node scripts/check-lint-warnings.mjs --enforce           # 超出基线即 exit 1
 *   node scripts/check-lint-warnings.mjs --write-baseline    # 生成/收缩基线（脚本写，勿手改）
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const BASELINE = join(ROOT, "oxlint-warning-baseline.json");
const argv = new Set(process.argv.slice(2));

const run = spawnSync("pnpm", ["exec", "oxlint", ".", "-f", "json"], {
    cwd: ROOT,
    encoding: "utf8",
    shell: true,
    maxBuffer: 1024 * 1024 * 256,
});
if (run.error) {
    console.error("FAIL 跑不动 oxlint：" + run.error.message);
    process.exit(2);
}
let parsed;
try {
    parsed = JSON.parse(run.stdout ?? "");
} catch {
    console.error("FAIL oxlint 输出不是 JSON（exit=" + run.status + "）");
    console.error(String(run.stderr ?? "").slice(0, 2000));
    process.exit(2);
}
const diagnostics = parsed.diagnostics ?? [];
const warnings = diagnostics.filter((d) => d.severity === "warning");
const errors = diagnostics.filter((d) => d.severity === "error");
const byRule = {};
for (const d of warnings) {
    const code = String(d.code ?? "?");
    byRule[code] = (byRule[code] ?? 0) + 1;
}
const total = warnings.length;

if (argv.has("--write-baseline")) {
    const payload = {
        $comment:
            "oxlint warnings 基线（task-171 ② ratchet 门）。只能由 node scripts/check-lint-warnings.mjs --write-baseline 生成/收缩，勿手改；基线只许变小，变大须在卡面说明原因。",
        total,
        errors: errors.length,
        files: parsed.number_of_files ?? null,
        byRule: Object.fromEntries(Object.entries(byRule).sort((a, b) => b[1] - a[1])),
        generatedAt: new Date().toISOString(),
    };
    writeFileSync(BASELINE, JSON.stringify(payload, null, 2) + "\n", "utf8");
    console.log("WROTE 基线 total=" + total + "（errors=" + errors.length + "）⇒ " + BASELINE);
    process.exit(errors.length === 0 ? 0 : 1);
}

let baseline = null;
try {
    baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
} catch {
    console.log("NO-BASELINE 基线文件读不到（" + BASELINE + "）⇒ 本次只报读数：warnings=" + total);
    process.exit(errors.length === 0 ? 0 : 1);
}

const delta = total - baseline.total;
const grown = Object.entries(byRule)
    .map(([rule, count]) => ({
        rule,
        count,
        before: baseline.byRule?.[rule] ?? 0,
        diff: count - (baseline.byRule?.[rule] ?? 0),
    }))
    .filter((entry) => entry.diff > 0)
    .sort((a, b) => b.diff - a.diff);

console.log(
    "oxlint warnings " +
        total +
        " / 基线 " +
        baseline.total +
        "（Δ " +
        (delta >= 0 ? "+" : "") +
        delta +
        "）" +
        " | errors " +
        errors.length +
        " | 族 " +
        Object.keys(byRule).length,
);
if (grown.length) {
    console.log("新增/增长的族（" + grown.length + "）：");
    for (const entry of grown) {
        console.log(
            "  +" +
                entry.diff +
                "  " +
                entry.rule +
                "（" +
                entry.before +
                " → " +
                entry.count +
                "）",
        );
    }
} else {
    console.log("无增长的族。");
}

if (errors.length > 0) {
    console.error(
        "FAIL errors=" + errors.length + "（ratchet 只放宽 warnings，errors 恒为硬失败）",
    );
    process.exit(1);
}
if (delta > 0) {
    if (argv.has("--enforce")) {
        console.error("FAIL warnings 超出基线 " + delta + " 条（--enforce）");
        process.exit(1);
    }
    console.log("REPORT-ONLY 超出基线但未 --enforce ⇒ exit 0（接线由 Lead 裁）");
}
process.exit(0);
