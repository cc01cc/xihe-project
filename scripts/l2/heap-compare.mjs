/**
 * BL-348 **"拒绝对比"硬门**：只有在采样口径完全一致时才允许算 delta。
 *
 * 规则（任一不符 ⇒ **报错退出 1**，绝不给出 delta）：
 *   commit / dirty / chromium / viewport(width,height) / dpr / fixture / protocol
 *
 * 为什么要有这条：BL-340 六轮迭代里，同一份代码因**口径不同**给出过 ratio 1.40 vs 1.00、
 * 首跳 2055 vs 1488 的相反结论。内存测量同理——不同构建/浏览器/视口的两个数字相减没有意义，
 * 但"减出来一个数"太容易了，所以把拒绝写进工具，而不是写在文档里靠人守。
 *
 * 用法：
 *   node scripts/l2/heap-compare.mjs --a=run1.json --b=run2.json [--max-diff=5]
 *   退出码：0 = 可比且全部指标在阈值内；1 = 口径不可比 / 指标超阈值 / 参数或文件错误。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CALIBER_FIELDS = ["commit", "dirty", "chromium", "dpr", "fixture"];
/**
 * 指标与**各自容差口径**（口径随数据落盘，避免后人不知道某指标为何特殊）。
 * - `renderedRows`：**绝对 ±2 行**（7–15 行属小基数，百分比会把正常摆动判成不稳定）；
 * - 其余四项：**百分比 ±5%**（稳定基数，百分比合理）。
 * 不要给 DOM/heap/listeners 套绝对容差——它们的量级差两个数量级。
 */
const METRIC_SPECS = [
    { key: "renderedRows", caliber: "absolute", absoluteTolerance: 2 },
    { key: "domNodes", caliber: "percent", percent: 5 },
    { key: "jsHeapMb", caliber: "percent", percent: 5 },
    { key: "jsEventListeners", caliber: "percent", percent: 5 },
    { key: "documents", caliber: "percent", percent: 5 },
];

function parseArgs(argv) {
    const args = { a: "", b: "", maxDiff: 5, out: "" };
    for (const item of argv) {
        const match = /^--([^=]+)(?:=(.*))?$/.exec(item);
        if (!match) continue;
        const [, key, value] = match;
        if (key === "a") args.a = value ?? "";
        else if (key === "b") args.b = value ?? "";
        else if (key === "max-diff") args.maxDiff = Number(value ?? 5);
        else if (key === "out") args.out = value ?? "";
    }
    return args;
}

function load(path) {
    if (!path) throw new Error("缺少 --a / --b 路径");
    const absolute = resolve(path);
    if (!existsSync(absolute)) throw new Error(`文件不存在：${absolute}`);
    return JSON.parse(readFileSync(absolute, "utf8"));
}

function caliberOf(sample) {
    return {
        commit: sample.commit ?? "(missing)",
        dirty: sample.dirty ?? "(missing)",
        chromium: sample.chromium ?? "(missing)",
        dpr: sample.dpr ?? "(missing)",
        fixture: sample.fixture ?? "(missing)",
        viewport: `${sample.viewport?.width ?? "?"}x${sample.viewport?.height ?? "?"}`,
        protocol: JSON.stringify(sample.protocol ?? null),
    };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const left = load(args.a);
    const right = load(args.b);

    const leftCaliber = caliberOf(left);
    const rightCaliber = caliberOf(right);
    const mismatches = [];
    for (const field of [...CALIBER_FIELDS, "viewport", "protocol"]) {
        if (leftCaliber[field] !== rightCaliber[field]) {
            mismatches.push({ field, a: leftCaliber[field], b: rightCaliber[field] });
        }
    }
    // dirty=true 的样本一律不可参与比对（无法证明来自同一工作树状态）
    if (left.dirty === true || right.dirty === true) {
        mismatches.push({ field: "dirty", a: left.dirty, b: right.dirty, note: "dirty 样本不可比" });
    }
    // commit / dirty **缺失**也不能比：两份都缺时字段"相等"，但那是缺数据不是同口径。
    for (const field of ["commit", "dirty"]) {
        const a = left[field];
        const b = right[field];
        if (a === undefined || b === undefined) {
            mismatches.push({
                field,
                a: a ?? "(missing)",
                b: b ?? "(missing)",
                note: "字段缺失 ⇒ 无法证明同构建同工作树，拒绝对比",
            });
        }
    }

    if (mismatches.length > 0) {
        console.error("[heap-compare] ❌ 口径不一致，**拒绝对比**：");
        for (const item of mismatches) {
            console.error(`  - ${item.field}: ${String(item.a)} ≠ ${String(item.b)}${item.note ? ` (${item.note})` : ""}`);
        }
        console.error("[heap-compare] 修好口径（同构建/同浏览器/同视口/同 fixture/同协议）后再比。");
        process.exit(1);
    }

    console.log(`[heap-compare] 口径一致：commit=${leftCaliber.commit} chromium=${leftCaliber.chromium}`);
    console.log(`  viewport=${leftCaliber.viewport} dpr=${leftCaliber.dpr} fixture=${leftCaliber.fixture}`);
    const rows = [];
    let failed = false;
    for (const spec of METRIC_SPECS) {
        const key = spec.key;
        const a = left.metrics?.[key]?.median;
        const b = right.metrics?.[key]?.median;
        if (a === undefined || b === undefined) {
            console.error(`  ! 指标缺失：${key}`);
            failed = true;
            continue;
        }
        const absDiff = Math.abs(b - a);
        const diffPct = a === 0 && b === 0 ? 0 : (absDiff / Math.max(1, a)) * 100;
        // 口径随数据落盘：`renderedRows` 用**绝对容差**（±2 行），其余用百分比。
        // 为什么：7–15 行是小基数，7 vs 9 = 28.6% 只是"滚动中测高收敛 1–2 行"的正常摆动，
        // 用百分比会把正常波动判成不稳定（2026-11-06 实测：门因此误报，非数据问题）。
        const within =
            spec.caliber === "absolute"
                ? absDiff <= (spec.absoluteTolerance ?? 2)
                : diffPct <= (spec.percent ?? args.maxDiff);
        if (!within) failed = true;
        rows.push({
            metric: key,
            a,
            b,
            absDiff,
            diffPct: Number(diffPct.toFixed(1)),
            caliber: spec.caliber === "absolute" ? `absolute±${spec.absoluteTolerance ?? 2}` : `percent${spec.percent ?? args.maxDiff}`,
            within,
        });
    }
    console.table(rows);
    const outPath = args.out ? resolve(args.out) : "";
    if (outPath) {
        writeFileSync(
            outPath,
            `${JSON.stringify({ generatedAt: new Date().toISOString(), caliber: caliberOf(left), metrics: rows, passed: !failed }, null, 2)}\n`,
            "utf8",
        );
        console.log(`[heap-compare] 比对结果已写入 ${outPath}`);
    }
    if (failed) {
        console.error("[heap-compare] ❌ 有指标超出各自容差：通道在该指标上不稳定");
        process.exit(1);
    }
    console.log("[heap-compare] ✅ 全部指标在各自容差内：通道成立");
}

try {
    main();
} catch (error) {
    console.error("[heap-compare] 错误：", error.message);
    process.exit(1);
}
