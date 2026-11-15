#!/usr/bin/env node
/**
 * oxlint warnings ratchet 门（task-171 ②；task-219 改为**按族**拦）。
 *
 * <p>判据（Lead 2026-11-15 裁定，来源 task-217 盘点漏过 3 条新警告）：
 * <b>任一 rule 族的计数超过基线 ⇒ exit 1</b>；总数只打印、不拦。</p>
 *
 * <p>为什么不拦总数：总数会被「A 族 +2、B 族 −2」互相抵消而掩盖漂移 —— 2026-11-15 实测
 * `consistent-type-imports` +3 恰好有别的族 −3，只看总数看不出来。errors 恒为硬失败（基线只放宽 warnings）。</p>
 *
 * <p><b>默认 report-only</b>（exit 0，除非 errors &gt; 0）；`--enforce` 才按族 exit 1。
 * 接线在 `A03-xihe/mise.toml`（`check:lint-warnings` 与 `lint` 聚合）。</p>
 *
 * 用法：
 *   node scripts/check-lint-warnings.mjs                     # 只报（report-only）
 *   node scripts/check-lint-warnings.mjs --enforce           # 任一族超基线即 exit 1（新语义）
 *   node scripts/check-lint-warnings.mjs --enforce-total     # 旧语义（总数超基线即 exit 1），仅供对照
 *   node scripts/check-lint-warnings.mjs --write-baseline    # 生成/收缩基线（脚本写，勿手改）
 *   node scripts/check-lint-warnings.mjs --list <rule>       # 打印该族当前所有 file:line
 *   node scripts/check-lint-warnings.mjs --from-json <path>  # 用已存盘的 oxlint JSON 代替现跑
 *   node scripts/check-lint-warnings.mjs --selftest          # 六例自检（退出码 0 = 全部与预期一致）
 *
 * 基线只许变小；变大必须在卡面写原因。**自愈单命令**见每次失败时的提示行。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const BASELINE = join(ROOT, "oxlint-warning-baseline.json");
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

/** `--from-json <path>`：用已存盘的 oxlint JSON（自检与「修前真实输出」红样本用）。 */
function optionValue(flag) {
    const at = args.indexOf(flag);
    return at >= 0 ? args[at + 1] : undefined;
}

// ── 读数 ─────────────────────────────────────────────────────────────────────

/** 结构深比较（只用于「内容没变就别刷 generatedAt」，不参与任何判据）。 */
function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual(a[k], b[k]));
}

/**
 * task-228：**基线文件的格式由生成器负责**，不靠人记得再跑一次 oxfmt。
 *
 * <p>为什么必须机器做：`a6bc295dd` 那笔就是「脚本生成的账本没进 oxfmt」⇒ 整包
 * `pnpm run lint` 断在 `oxfmt --check` 步、`oxlint` 压根没跑到（只查脚本本身查不出来）。
 * 格式化放在生成期，并在写盘后**立刻自查** `oxfmt --check`：自查不过说明生成器坏了，直接 exit 2，
 * 而不是留下一份坏账本让下一个人替它跑格式。</p>
 */
function formatBaseline() {
    const fmt = spawnSync("pnpm", ["exec", "oxfmt", BASELINE], {
        cwd: ROOT,
        encoding: "utf8",
        shell: true,
    });
    if (fmt.error || fmt.status !== 0) {
        console.error(
            "FAIL 基线写盘后 oxfmt 格式化失败：" + (fmt.error ? fmt.error.message : fmt.stderr),
        );
        process.exit(2);
    }
    const check = spawnSync("pnpm", ["exec", "oxfmt", "--check", BASELINE], {
        cwd: ROOT,
        encoding: "utf8",
        shell: true,
    });
    if (check.status !== 0) {
        console.error(
            "FAIL 基线仍未通过 oxfmt --check（生成器与 oxfmt 口径不一致）：" + check.stdout,
        );
        process.exit(2);
    }
}

function runOxlint() {
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
    return { stdout: run.stdout ?? "", status: run.status };
}

/** oxlint JSON → { diagnostics, number_of_files }；解析失败即 exit 2（调用侧问题，不算红）。 */
function parseOxlintJson(text, label) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        console.error("FAIL " + label + " 不是 JSON（前 400 字符）：" + String(text).slice(0, 400));
        process.exit(2);
    }
    return {
        diagnostics: parsed.diagnostics ?? [],
        number_of_files: parsed.number_of_files ?? null,
    };
}

/**
 * 从诊断算 { total, errors, files, byRule, locations }。
 * `locations` 让「族超了」能点名到 file:line（基线里也存一份，用于算差集）。
 */
export function summarize(diagnostics) {
    const byRule = {};
    const locations = {};
    let errors = 0;
    for (const d of diagnostics) {
        if (d.severity === "error") {
            errors += 1;
            continue;
        }
        if (d.severity !== "warning") continue;
        const rule = String(d.code ?? "?");
        byRule[rule] = (byRule[rule] ?? 0) + 1;
        const span = d.labels?.[0]?.span;
        const at = String(d.filename ?? "?") + ":" + (span?.line ?? "?");
        (locations[rule] ??= []).push(at);
    }
    for (const rule of Object.keys(locations)) locations[rule].sort();
    const total = Object.values(byRule).reduce((sum, n) => sum + n, 0);
    return { total, errors, byRule, locations };
}

/** `file:line` → `file`（只切最后一处冒号：oxlint 的 filename 是相对路径，无盘符风险，也不依赖平台）。 */
function fileOf(at) {
    const cut = at.lastIndexOf(":");
    return cut > 0 ? at.slice(0, cut) : at;
}

/**
 * 按族比较当前读数与基线：返回增长族（含**新文件**清单）。
 *
 * 判据量只有 `diff`（计数）；`added` 仅供打印，**从不参与 exit code**。
 * 新增判定按 **file 前缀**：该 file 在基线的同族坐标里已出现 ⇒ 视为行号漂移/同文件新增，
 * 不列为「新文件」（否则一次只加注释的重构会把整族坐标都报成新增，噪音淹没真信号）。
 */
export function grownFamilies(now, baseline) {
    const baseByRule = baseline?.byRule ?? {};
    const baseLocations = baseline?.locations ?? {};
    // 旧基线没有坐标 ⇒ 无法算差集，此处不逐条列（改为提示用 --list <族> 看），避免把整族都报成"新增"。
    const hasLocations = Object.keys(baseLocations).length > 0;
    return Object.entries(now.byRule)
        .map(([rule, count]) => {
            const before = baseByRule[rule] ?? 0;
            const baseFiles = new Set((baseLocations[rule] ?? []).map(fileOf));
            return {
                rule,
                count,
                before,
                diff: count - before,
                added: hasLocations
                    ? [
                          ...new Map(
                              (now.locations[rule] ?? [])
                                  .filter((at) => !baseFiles.has(fileOf(at)))
                                  .map((at) => [fileOf(at), at]),
                          ).values(),
                      ]
                    : [],
            };
        })
        .filter((entry) => entry.diff > 0)
        .sort((a, b) => b.diff - a.diff || a.rule.localeCompare(b.rule));
}

function renderReport(now, baseline, grown) {
    const delta = now.total - (baseline?.total ?? 0);
    const lines = [
        "oxlint warnings " +
            now.total +
            " / 基线 " +
            (baseline?.total ?? "?") +
            "（Δ " +
            (delta >= 0 ? "+" : "") +
            delta +
            "）" +
            " | errors " +
            now.errors +
            " | 族 " +
            Object.keys(now.byRule).length +
            " | 判据=按族",
    ];
    if (grown.length) {
        lines.push("超基线的族（" + grown.length + "）：");
        for (const entry of grown) {
            lines.push(
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
            if (entry.added.length) {
                lines.push(
                    "      新增文件（" +
                        entry.added.length +
                        "）：" +
                        entry.added.slice(0, 10).join("、") +
                        (entry.added.length > 10
                            ? " …另 " + (entry.added.length - 10) + " 个"
                            : ""),
                );
                lines.push("      行号见 --list <族>：行号漂移不算新增（按 file 前缀判定）");
            }
        }
    } else {
        lines.push("无增长的族。");
    }
    return lines;
}

function selfHealHint() {
    return (
        "自愈：若新增系正当（例：新测试文件引入了同族新写法），先修掉；确属可接受则" +
        " `node packages/ui/scripts/check-lint-warnings.mjs --write-baseline` 收账" +
        "（基线只许因**已修**而变小，因新增而变大须在卡面写原因）。"
    );
}

// ── 自检 ─────────────────────────────────────────────────────────────────────

/**
 * 自检六例。夹具全部写进系统临时目录（不落仓库），跑完即删。
 * 退出码：0 = 六例全部与预期一致；1 = 有例与预期不符；2 = 环境问题。
 */
function selftest() {
    const dir = mkdtempSync(join(tmpdir(), "lint-warnings-selftest-"));
    const writeFixture = (name, diagnostics, extra = {}) => {
        const path = join(dir, name);
        writeFileSync(
            path,
            JSON.stringify({
                diagnostics,
                number_of_files: 10,
                ...extra,
            }),
            "utf8",
        );
        return path;
    };
    const warn = (code, file, line) => ({
        severity: "warning",
        code,
        message: "m",
        filename: file,
        labels: [{ span: { line, column: 1 } }],
    });
    const err = (code, file, line) => ({ ...warn(code, file, line), severity: "error" });

    const base = {
        total: 4,
        errors: 0,
        byRule: { "import(first)": 2, "typescript(consistent-type-imports)": 2 },
        locations: {
            "import(first)": ["a.ts:1", "b.ts:1"],
            "typescript(consistent-type-imports)": ["c.ts:3", "d.ts:9"],
        },
    };

    const cases = [
        {
            name: "① 族计数全等 ⇒ exit 0（不乱红）",
            fixture: writeFixture("equal.json", [
                warn("import(first)", "a.ts", 1),
                warn("import(first)", "b.ts", 1),
                warn("typescript(consistent-type-imports)", "c.ts", 3),
                warn("typescript(consistent-type-imports)", "d.ts", 9),
            ]),
            baseline: base,
            enforce: true,
            wantExit: 0,
            wantText: ["无增长的族。"],
        },
        {
            name: "② 某族 +1（总数也 +1）⇒ exit 1 且点名该族与新增 file:line",
            fixture: writeFixture("grow-one.json", [
                warn("import(first)", "a.ts", 1),
                warn("import(first)", "b.ts", 1),
                warn("import(first)", "e.ts", 7),
                warn("typescript(consistent-type-imports)", "c.ts", 3),
                warn("typescript(consistent-type-imports)", "d.ts", 9),
            ]),
            baseline: base,
            enforce: true,
            wantExit: 1,
            wantText: ["import(first)", "2 → 3", "e.ts:7"],
        },
        {
            name: "③ 总数不变、A 族 +1 而 B 族 −1 ⇒ exit 1（**总数拦会漏掉的那一例**）",
            fixture: writeFixture("swap.json", [
                warn("import(first)", "a.ts", 1),
                warn("import(first)", "b.ts", 1),
                warn("import(first)", "e.ts", 7),
                warn("typescript(consistent-type-imports)", "c.ts", 3),
            ]),
            baseline: base,
            enforce: true,
            wantExit: 1,
            wantText: ["import(first)", "Δ +0"],
        },
        {
            name: "④ 总数下降但某族上升 ⇒ exit 1（防止被总数掩盖）",
            fixture: writeFixture("total-down.json", [
                warn("import(first)", "a.ts", 1),
                warn("import(first)", "b.ts", 1),
                warn("import(first)", "e.ts", 7),
            ]),
            baseline: base,
            enforce: true,
            wantExit: 1,
            wantText: ["import(first)", "2 → 3", "Δ -1"],
        },
        {
            name: "⑤ report-only 下同一条也 exit 0（默认不阻断）",
            fixture: writeFixture("report-only.json", [
                warn("import(first)", "a.ts", 1),
                warn("import(first)", "b.ts", 1),
                warn("import(first)", "z.ts", 1),
            ]),
            baseline: base,
            enforce: false,
            wantExit: 0,
            wantText: ["REPORT-ONLY"],
        },
        {
            name: "⑦ 有 error ⇒ exit 1（errors 恒为硬失败，与 --enforce 无关）",
            fixture: writeFixture("has-error.json", [
                err("eslint(no-unused-vars)", "x.ts", 2),
                warn("import(first)", "a.ts", 1),
                warn("import(first)", "b.ts", 1),
                warn("typescript(consistent-type-imports)", "c.ts", 3),
                warn("typescript(consistent-type-imports)", "d.ts", 9),
            ]),
            baseline: base,
            enforce: false,
            wantExit: 1,
            wantText: ["errors 1", "FAIL errors="],
        },
        {
            name: "⑧ 文件已在基线、行号整体 +100 且同文件多一处 ⇒ 计数红，但**不出现噪音条目**",
            fixture: writeFixture("line-shift.json", [
                warn("import(first)", "a.ts", 101),
                warn("import(first)", "a.ts", 102),
                warn("import(first)", "b.ts", 101),
                warn("typescript(consistent-type-imports)", "c.ts", 103),
                warn("typescript(consistent-type-imports)", "d.ts", 109),
            ]),
            baseline: base,
            enforce: true,
            wantExit: 1,
            wantText: ["import(first)", "2 → 3"],
            wantAbsent: ["新增文件", "a.ts:101"],
        },
        {
            name: "⑥ 基线无 byRule（旧格式）⇒ 不按族红，只告警",
            fixture: writeFixture("legacy.json", [warn("import(first)", "z.ts", 1)]),
            baseline: { total: 0 },
            enforce: true,
            wantExit: 0,
            wantText: ["基线无族数据"],
        },
    ];

    let failed = 0;
    for (const testCase of cases) {
        const now = summarize(
            parseOxlintJson(readFileSync(testCase.fixture, "utf8"), testCase.fixture).diagnostics,
        );
        const grown = grownFamilies(now, testCase.baseline);
        const legacyBaseline = !testCase.baseline.byRule;
        const lines = renderReport(now, testCase.baseline, grown);
        let exit = 0;
        if (now.errors > 0) exit = 1;
        else if (testCase.enforce && grown.length && !legacyBaseline) exit = 1;
        else if (testCase.enforce && grown.length) lines.push("WARN 基线无族数据 ⇒ 本次不按族阻断");
        if (now.errors > 0) lines.push("FAIL errors=" + now.errors);
        if (exit === 0 && !testCase.enforce && grown.length)
            lines.push("REPORT-ONLY 有增长但未 --enforce");
        const text = lines.join("\n");
        const exitOk = exit === testCase.wantExit;
        const textOk =
            testCase.wantText.every((needle) => text.includes(needle)) &&
            (testCase.wantAbsent ?? []).every((needle) => !text.includes(needle));
        if (!exitOk || !textOk) {
            failed += 1;
            console.error(
                "FAIL " + testCase.name + " ⇒ exit=" + exit + "（期望 " + testCase.wantExit + "）",
            );
            console.error(text);
        } else {
            console.log("PASS " + testCase.name);
        }
    }
    rmSync(dir, { recursive: true, force: true });
    console.log(
        "SELFTEST " + (cases.length - failed) + "/" + cases.length + (failed ? " ⇒ FAIL" : " ⇒ OK"),
    );
    process.exit(failed ? 1 : 0);
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

function main() {
    if (has("--selftest")) {
        selftest();
        return;
    }

    const fromJson = optionValue("--from-json");
    const parsed = fromJson
        ? parseOxlintJson(readFileSync(fromJson, "utf8"), fromJson)
        : parseOxlintJson(runOxlint().stdout, "oxlint 输出");
    const now = summarize(parsed.diagnostics);
    now.files = parsed.number_of_files;

    if (has("--write-baseline")) {
        let payload = {
            $comment:
                "oxlint warnings 基线（task-171 ② ratchet 门；task-219 起按族拦）。只能由 node scripts/check-lint-warnings.mjs --write-baseline 生成/收缩，勿手改；基线只许变小，变大须在卡面说明原因。",
            total: now.total,
            errors: now.errors,
            files: now.files,
            // 计数降序；同计数按族名升序 —— 否则并列族的先后取决于 oxlint 扫描顺序，
            // 跨机器/跨版本就可能翻序，把「重复生成两次 git diff 为空」这条幂等判据变成偶然成立（task-228）。
            byRule: Object.fromEntries(
                Object.entries(now.byRule).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
            ),
            locations: Object.fromEntries(
                Object.entries(now.locations).sort((a, b) => a[0].localeCompare(b[0])),
            ),
            generatedAt: new Date().toISOString(),
        };
        // task-228 ①：缩进 4（.oxfmtrc.jsonc 的 tabWidth: 4），随后由 formatBaseline() 交给 oxfmt 收口；
        // ② generatedAt 只在**内容真变**时刷新 —— 同一棵树连跑两次必须逐字节相同，否则
        // 「重复生成两次 git diff 为空」这条幂等判据永远不成立（时间戳每次都变）。
        const previous = (() => {
            try {
                return JSON.parse(readFileSync(BASELINE, "utf8"));
            } catch {
                return null;
            }
        })();
        const core = Object.fromEntries(
            Object.entries(payload).filter(([key]) => key !== "generatedAt"),
        );
        const previousCore =
            previous && typeof previous === "object"
                ? Object.fromEntries(
                      Object.entries(previous).filter(([key]) => key !== "generatedAt"),
                  )
                : null;
        const keepTimestamp =
            previousCore !== null &&
            deepEqual(previousCore, core) &&
            typeof previous.generatedAt === "string";
        payload = {
            ...core,
            generatedAt: keepTimestamp ? previous.generatedAt : new Date().toISOString(),
        };
        writeFileSync(BASELINE, JSON.stringify(payload, null, 4) + "\n", "utf8");
        formatBaseline();
        console.log("WROTE 基线 total=" + now.total + "（errors=" + now.errors + "）⇒ " + BASELINE);
        process.exit(now.errors === 0 ? 0 : 1);
    }

    const listRule = optionValue("--list");
    if (listRule) {
        const hits = now.locations[listRule] ?? [];
        console.log("族 " + listRule + "：" + hits.length + " 处");
        for (const at of hits) console.log("  " + at);
        process.exit(now.errors === 0 ? 0 : 1);
    }

    let baseline = null;
    try {
        baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
    } catch {
        console.log(
            "NO-BASELINE 基线文件读不到（" + BASELINE + "）⇒ 只报读数 warnings=" + now.total,
        );
        process.exit(now.errors === 0 ? 0 : 1);
    }

    const grown = grownFamilies(now, baseline);
    const lines = renderReport(now, baseline, grown);
    for (const line of lines) console.log(line);

    if (now.errors > 0) {
        console.error(
            "FAIL errors=" + now.errors + "（ratchet 只放宽 warnings，errors 恒为硬失败）",
        );
        process.exit(1);
    }
    if (!baseline.byRule) {
        console.log("WARN 基线无族数据（旧格式）⇒ 本次不按族阻断；下次 --write-baseline 会补齐");
        process.exit(0);
    }
    if (!grown.length) process.exit(0);

    const hint = selfHealHint();
    if (has("--enforce")) {
        console.error(
            "FAIL 有 " +
                grown.length +
                " 个族的 warnings 超过基线（按族拦；总数=" +
                now.total +
                " 不单独判）：" +
                grown.map((g) => g.rule + " +" + g.diff).join("、"),
        );
        console.error(hint);
        process.exit(1);
    }
    if (has("--enforce-total")) {
        const delta = now.total - baseline.total;
        if (delta > 0) {
            console.error("FAIL 总数超出基线 " + delta + " 条（--enforce-total 旧语义）");
            console.error(hint);
            process.exit(1);
        }
    }
    console.log("REPORT-ONLY 有族增长但未 --enforce ⇒ exit 0");
    console.log(hint);
    process.exit(0);
}

main();
