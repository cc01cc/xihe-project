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
 *   node scripts/check-lint-warnings.mjs --write-baseline    # 生成/收缩基线（脚本写，勿手改；errors>0 时拒绝写盘）
 *   node scripts/check-lint-warnings.mjs --write-baseline --scope <前缀> [--scope …]
 *                                                            # task-36 收账边界：只吸收 scope 内的新增
 *   node scripts/check-lint-warnings.mjs --write-baseline --allow-foreign
 *                                                            # 明确放行边界外新增（打印 + 基线留痕）
 *   node scripts/check-lint-warnings.mjs --list <rule>       # 打印该族当前所有 file:line
 *   node scripts/check-lint-warnings.mjs --from-json <path>  # 用已存盘的 oxlint JSON 代替现跑
 *   node scripts/check-lint-warnings.mjs --selftest          # 九例自检（退出码 0 = 全部与预期一致）
 *
 * 基线只许变小；变大必须在卡面写原因。**自愈单命令**见每次失败时的提示行。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

/** 可重复选项（task-36 的 `--scope` 要能传多个写面前缀）。 */
function optionValues(flag) {
    const out = [];
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === flag && typeof args[i + 1] === "string" && args[i + 1].length > 0) {
            out.push(args[i + 1]);
        }
    }
    return out;
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
function formatBaseline(target = BASELINE) {
    const fmt = spawnSync("pnpm", ["exec", "oxfmt", target], {
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
    const check = spawnSync("pnpm", ["exec", "oxfmt", "--check", target], {
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

/**
 * task-230：`errors > 0` 时**拒绝写盘**（exit 2），保持文件原样。
 *
 * <p>为什么必须拒绝、而不是「照写再 exit 1」：`task-228` 首轮重生时，别人一个**未跟踪的语法坏文件**
 * 就让生成物写进了 `errors: 1` —— 污染发生在 exit 1 之前，账本已被改坏。ratchet 台账里出现
 * `errors > 0` 等于把一次红**永久固化成基线**。判据用 **sha256 前后比对**证明「文件没被动过」，
 * 不用 mtime（同一秒内写回也能骗过 mtime）。</p>
 */
function writeBaseline({ baselinePath, payload, errors, format = formatBaseline }) {
    if (errors > 0) {
        console.error(
            "FAIL 拒绝写基线：errors=" +
                errors +
                "（先修 errors 再写基线；" +
                baselinePath +
                " 保持原样）",
        );
        return 2;
    }
    writeFileSync(baselinePath, JSON.stringify(payload, null, 4) + "\n", "utf8");
    format(baselinePath);
    return 0;
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
    // task-43：errors 也要能按区域归属 —— 否则测试区一个半成品语法错就能把产品门顶红，
    // 那与「测试债不该算产品债」是同一个病。
    const errorLocations = [];
    let errors = 0;
    for (const d of diagnostics) {
        if (d.severity === "error") {
            errors += 1;
            const espan = d.labels?.[0]?.span;
            errorLocations.push(String(d.filename ?? "?") + ":" + (espan?.line ?? "?"));
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
    errorLocations.sort();
    const total = Object.values(byRule).reduce((sum, n) => sum + n, 0);
    return { total, errors, byRule, locations, errorLocations };
}

// ── 区域（src / tests）───────────────────────────────────────────────────────

/**
 * task-43 / D-1692：棘轮分区域。规范 SSOT：
 * .agents/skills/test/references/test-lint-area-separation.md 第 3 节。
 *
 * 为什么必须分：同一套门槛同时管测试与产品代码会让测试债被算成产品债 —— 实测（2026-11-16）
 * 432 条警告里 src 产品区 128 条、src 内测试 90 条、e2e 201 条、工具面 13 条；只要一条测试新增就能把
 * 产品门顶红，于是「产品债到底多少」这个问题永远答不出来。
 *
 * 分区域改的是「基线结构 + 判据分区」，不是收账边界（Lead task-43 硬约束 (1)）：
 * --write-baseline 的 --scope 语义一字不变，越界仍 exit 3。两者是两件事：
 * --area 回答「这个门该管谁」，--scope 回答「这次收账我允许吸收谁的新增」。
 */
export const AREAS = Object.freeze(["src", "tests"]);

/**
 * 路径 -> 区域。判据是路径而不是「文件里有没有 test 字样」，因为门要能对任意输入复算。
 * e2e/** 归 tests（它是测试代码，只是不装 vitest 插件 —— 见规范 SSOT 2.1 的显式坑）。
 * 工具面（scripts/**、vite.config.ts）归 src：它们不是测试，也不该躲在测试区里被放宽。
 */
export function areaOfPath(file) {
    const p = String(file ?? "")
        .split(String.fromCharCode(92))
        .join("/");
    if (p.startsWith("e2e/")) return "tests";
    if (p.startsWith("src/")) {
        if (p.includes("__tests__")) return "tests";
        if (p.endsWith(".spec.ts") || p.endsWith(".test.ts")) return "tests";
        if (p.startsWith("src/test-utils/")) return "tests";
        return "src";
    }
    // 其余（scripts/**、vite.config.ts、根配置）算产品侧：宁可让工具面吃产品门的严格度，
    // 也不让任何非测试代码借「测试区宽」的通道溜走。
    return "src";
}

/** file:line -> 区域（只切最后一处冒号，与 fileOf 同口径）。无法解析 => null（不猜）。 */
export function areaOfLocation(at) {
    const cut = at.lastIndexOf(":");
    if (cut <= 0) return null;
    return areaOfPath(at.slice(0, cut));
}

/**
 * 从 byArea 形状或旧基线（只有 byRule+locations）推出两区的 {byRule, total}。
 *
 * 旧基线不需要额外迁移文件：它的 locations 天然带路径，按路径分桶即可无损还原
 * （实测旧基线 417 条 = src 141 + tests 276，完全覆盖 => 迁移零丢失）。这样「旧格式」
 * 不是第二套判决口径，只是同一口径的另一种存储（Lead 硬约束 (2)）。
 */
export function areasOf(baseline) {
    const out = {};
    for (const area of AREAS) out[area] = { byRule: {}, total: 0 };
    const byArea = baseline?.byArea;
    if (byArea && typeof byArea === "object") {
        for (const area of AREAS) {
            const a = byArea[area];
            if (!a) continue;
            out[area].byRule = { ...(a.byRule ?? {}) };
            out[area].total = Number.isFinite(a.total)
                ? Number(a.total)
                : Object.values(out[area].byRule).reduce((s, n) => s + n, 0);
        }
        return out;
    }
    // 旧格式：按 locations 的路径分桶（无 locations 的极旧基线 => 两区都空 => 调用方按「无族数据」处理）。
    for (const [rule, ats] of Object.entries(baseline?.locations ?? {})) {
        for (const at of ats) {
            const area = areaOfLocation(at);
            if (!area) continue;
            out[area].byRule[rule] = (out[area].byRule[rule] ?? 0) + 1;
            out[area].total += 1;
        }
    }
    return out;
}

/** 把 summarize 的扁平结果按区域再切一份（判据本体仍只有一份：summarize）。 */
export function splitByArea(now) {
    const out = {};
    for (const area of AREAS) out[area] = { byRule: {}, locations: {}, total: 0, errors: 0 };
    for (const [rule, ats] of Object.entries(now.locations ?? {})) {
        for (const at of ats) {
            const area = areaOfLocation(at);
            if (!area) continue;
            out[area].byRule[rule] = (out[area].byRule[rule] ?? 0) + 1;
            (out[area].locations[rule] ??= []).push(at);
            out[area].total += 1;
        }
    }
    for (const area of AREAS) {
        for (const rule of Object.keys(out[area].locations)) out[area].locations[rule].sort();
    }
    for (const at of now.errorLocations ?? []) {
        const area = areaOfLocation(at);
        if (area) out[area].errors += 1;
    }
    return out;
}

/** --area 取值校验：默认 src（产品门），见 Lead 硬约束 (3)。 */
function resolveArea(raw) {
    if (raw === undefined) return { areas: ["src"], label: "src（默认）" };
    if (raw === "all") return { areas: AREAS.slice(), label: "all" };
    if (AREAS.includes(raw)) return { areas: [raw], label: raw };
    console.error("FAIL --area 只接受 src|tests|all，收到 " + JSON.stringify(raw));
    process.exit(2);
}

/** 按区域比族：grownFamilies 的区域版（判据逻辑复用同一份，不新造一套）。 */
export function grownFamiliesInArea(nowArea, baseArea) {
    return Object.entries(nowArea.byRule ?? {})
        .map(([rule, count]) => {
            const before = baseArea.byRule?.[rule] ?? 0;
            return { rule, count, before, diff: count - before };
        })
        .filter((entry) => entry.diff > 0)
        .sort((a, b) => b.diff - a.diff || a.rule.localeCompare(b.rule));
}

/** `file:line` → `file`（只切最后一处冒号：oxlint 的 filename 是相对路径，无盘符风险，也不依赖平台）。 */
function fileOf(at) {
    const cut = at.lastIndexOf(":");
    return cut > 0 ? at.slice(0, cut) : at;
}

/**
 * task-36：`--write-baseline` 的**收账边界** —— 只许把「自己写面内」的新增写进基线。
 *
 * <p>为什么需要：ratchet 的基线一旦把**别人在途**的新警告收进去，那批 WIP 就永久变成"合法存量"，
 * 等它真正合入时门不会再响，等它被放弃时基线又白涨一次。task-261 分批清账期间已反复踩到
 * （A 批在修、B 批新增，谁跑一次 `--write-baseline` 就把 B 批的账收了）。</p>
 *
 * <p>判据单位是 **(族, 文件)** 而不是单条 file:line —— 与「行号漂移不算新增」的既有口径一致：
 * 只加注释让整族行号平移，不应把整族坐标都判成"别人的新增"。归属用**每文件计数差**：
 * 某文件在该族的条数比基线多 ⇒ 它是这族增长的贡献者；贡献者不在任何 `--scope` 前缀下 ⇒ 越界。</p>
 *
 * <p>为什么不管「族没长但换了文件」（A 文件修掉、B 文件新增，净零）：净零没有放宽 ratchet 的计数，
 * 而计数才是门的判据；这条边界只负责「别把增长收账」。</p>
 */
export function foreignGrowth(now, baseline, scopes) {
    const baseByRule = baseline?.byRule ?? {};
    const baseLocations = baseline?.locations ?? {};
    const hasLocations = Object.keys(baseLocations).length > 0;
    const inScope = (file) => scopes.some((prefix) => file.startsWith(prefix));
    const out = [];
    for (const rule of Object.keys(now.locations ?? {})) {
        const before = baseByRule[rule] ?? 0;
        const after = now.byRule?.[rule] ?? 0;
        if (after <= before) continue;
        if (!hasLocations) {
            // 旧格式基线没有坐标 ⇒ 无法归属任何人；宁可拒写，让调用方显式 --allow-foreign。
            out.push({ rule, file: "(基线无坐标，无法归属)", from: before, to: after, at: [] });
            continue;
        }
        const baseCountByFile = new Map();
        for (const at of baseLocations[rule] ?? []) {
            const key = fileOf(at);
            baseCountByFile.set(key, (baseCountByFile.get(key) ?? 0) + 1);
        }
        const nowCountByFile = new Map();
        for (const at of now.locations[rule] ?? []) {
            const key = fileOf(at);
            nowCountByFile.set(key, (nowCountByFile.get(key) ?? 0) + 1);
        }
        for (const [file, count] of nowCountByFile) {
            const from = baseCountByFile.get(file) ?? 0;
            if (count <= from) continue;
            if (inScope(file)) continue;
            out.push({
                rule,
                file,
                from,
                to: count,
                at: (now.locations[rule] ?? []).filter((at) => fileOf(at) === file),
            });
        }
    }
    return out.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file));
}

function foreignHint(scopes) {
    return (
        "放行：确认是**你自己的**新增 ⇒ 加 `--scope <前缀>`（可重复，例 `--scope src/components/settings`）；" +
        "确属他人在途且必须收账 ⇒ `--allow-foreign`（会打印并在基线的 `foreignAbsorbed` 里留痕）。" +
        (scopes.length ? "" : "当前未给 --scope ⇒ 任何新增都算越界。")
    );
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

/**
 * task-43：**按区域**渲染报告。与旧 renderReport 并存而不是替换它 ——
 * 旧函数被 --selftest 的 14 例直接调用（那些例锁的是 task-36 的收账边界语义，
 * 不能为了分区域去改动它们的调用形状，否则「边界语义有没有被改坏」就不再可证）。
 */
function renderReportArea({ now, nowAreas, baseAreas, grownByArea, areaSel, legacyBaseline }) {
    const sel = areaSel.areas;
    const nowTotal = sel.reduce((s, a) => s + nowAreas[a].total, 0);
    const baseTotal = legacyBaseline ? "?" : sel.reduce((s, a) => s + baseAreas[a].total, 0);
    const delta = legacyBaseline ? "?" : nowTotal - baseTotal;
    const lines = [
        "oxlint warnings " +
            nowTotal +
            " / 基线 " +
            baseTotal +
            (legacyBaseline ? "" : "（Δ " + (delta >= 0 ? "+" : "") + delta + "）") +
            " | errors " +
            now.errors +
            " | 区域 " +
            sel.map((a) => a + "=" + nowAreas[a].total).join(" ") +
            " | 判据=按族·按区域",
    ];
    // 未选区域要显式报读数：否则读者以为「没提到就是 0」。
    const other = AREAS.filter((a) => !sel.includes(a));
    if (other.length) {
        lines.push(
            "（本次不判的区域：" +
                other.map((a) => a + "=" + nowAreas[a].total).join(" ") +
                " ⇒ 想看就加 --area tests 或 --area all）",
        );
    }
    const grownAll = sel.flatMap((area) => grownByArea[area].map((g) => ({ ...g, area })));
    if (!grownAll.length) {
        lines.push("无增长的族（区域 " + areaSel.label + "）。");
        return lines;
    }
    lines.push("超基线的族（" + grownAll.length + "）：");
    for (const entry of grownAll) {
        lines.push(
            "  +" +
                entry.diff +
                "  [" +
                entry.area +
                "] " +
                entry.rule +
                "（" +
                entry.before +
                " → " +
                entry.count +
                "）",
        );
    }
    return lines;
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
        "（基线只许因**已修**而变小，因新增而变大须在卡面写原因）。" +
        " 注意 task-36 起 `--write-baseline` 只吸收 `--scope` 内的新增，边界外会拒写（exit 3）。"
    );
}

// ── 自检 ─────────────────────────────────────────────────────────────────────

/**
 * 自检九例。夹具全部写进系统临时目录（不落仓库），跑完即删。
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
    let checked = 0;
    for (const testCase of cases) {
        checked += 1;
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

    // ⑨ task-230：errors > 0 时 writeBaseline **拒绝写盘** ⇒ 退出码 2 且文件 sha256 不变（收紧自「照写再 exit 1」）。
    {
        const target = join(dir, "baseline-guarded.json");
        const original = '{\n    "total": 709,\n    "errors": 0\n}\n';
        writeFileSync(target, original, "utf8");
        const shaOf = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
        const before = shaOf(target);
        const refused = writeBaseline({
            baselinePath: target,
            payload: { total: 1 },
            errors: 2,
            format: () => {},
        });
        const unchanged = shaOf(target) === before;
        checked += 1;
        if (refused !== 2 || !unchanged) {
            failed += 1;
            console.error(
                "FAIL ⑨ errors>0 必须拒绝写盘 ⇒ 退出码 " +
                    refused +
                    "（期望 2），文件不变=" +
                    unchanged,
            );
        } else {
            console.log("PASS ⑨ errors>0 ⇒ 拒绝写盘（exit 2）且 sha256 不变");
        }
    }

    // ⑩–⑭ task-36：`--write-baseline` 的收账边界（scope 外的他人新增不得被吸收）。
    {
        const shaOf = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
        /** 按 `locations` 造一份 now/base 形状（byRule/total 由它派生，避免两处手写不一致）。 */
        const shape = (locationsByRule) => {
            const locations = {};
            const byRule = {};
            for (const [rule, ats] of Object.entries(locationsByRule)) {
                locations[rule] = [...ats].sort();
                byRule[rule] = ats.length;
            }
            return {
                total: Object.values(byRule).reduce((sum, n) => sum + n, 0),
                errors: 0,
                byRule,
                locations,
            };
        };
        const baseCase = shape({ "import(first)": ["a.ts:1", "b.ts:1"] });
        const mine = shape({ "import(first)": ["a.ts:1", "b.ts:1", "src/mine/x.ts:3"] });
        const theirs = shape({ "import(first)": ["a.ts:1", "b.ts:1", "src/other/y.ts:5"] });
        const flat = shape({ "import(first)": ["a.ts:1", "b.ts:1"] });

        const scopeCases = [
            ["⑩ scope 覆盖新增 ⇒ 0 处越界（可写）", mine, ["src/mine/"], 0],
            ["⑪ scope 外新增 ⇒ 1 处越界且点名 rule+file", theirs, ["src/mine/"], 1],
            ["⑫ 未给 --scope ⇒ 任何新增都越界", mine, [], 1],
            ["⑬ 无新增 ⇒ 0 处越界（幂等前提）", flat, [], 0],
        ];
        for (const [name, nowFixture, scopes, want] of scopeCases) {
            checked += 1;
            const got = foreignGrowth(nowFixture, baseCase, scopes);
            const namedOk =
                got.length === 0 ||
                (got[0].rule === "import(first)" && got[0].file.startsWith("src/"));
            if (got.length !== want || !namedOk) {
                failed += 1;
                console.error(
                    "FAIL " +
                        name +
                        " ⇒ 越界 " +
                        got.length +
                        "（期望 " +
                        want +
                        "）" +
                        JSON.stringify(got),
                );
            } else {
                console.log("PASS " + name);
            }
        }

        // ⑭ 同 payload 连写两次 ⇒ 逐字节不变（--write-baseline 幂等的前提）
        {
            const target = join(dir, "idempotent-baseline.json");
            writeFileSync(target, '{\n    "total": 0\n}\n', "utf8");
            const payload = {
                total: 2,
                errors: 0,
                files: 1,
                byRule: { "import(first)": 2 },
                locations: { "import(first)": ["a.ts:1", "b.ts:1"] },
            };
            const firstExit = writeBaseline({
                baselinePath: target,
                payload,
                errors: 0,
                format: () => {},
            });
            const first = shaOf(target);
            const secondExit = writeBaseline({
                baselinePath: target,
                payload,
                errors: 0,
                format: () => {},
            });
            const second = shaOf(target);
            checked += 1;
            if (firstExit !== 0 || secondExit !== 0 || first !== second) {
                failed += 1;
                console.error(
                    "FAIL ⑭ 同 payload 连写两次必须字节不变 ⇒ exit " +
                        firstExit +
                        "/" +
                        secondExit +
                        "，sha 相同=" +
                        (first === second),
                );
            } else {
                console.log("PASS ⑭ 同 payload 连写两次 ⇒ 字节不变");
            }
        }
    }

    // ⑮–⑱ task-43：棘轮分区域（byArea / --area 三态 / 旧基线无损迁移 / 产品门不放松）。
    // 这四条与 ⑩–⑭ 是**两件事**：⑩–⑭ 锁「收账边界」（--scope），⑮–⑱ 锁「判据分区」（--area）。
    {
        const shapeNow = (locationsByRule) => {
            const locations = {};
            const byRule = {};
            for (const [rule, ats] of Object.entries(locationsByRule)) {
                locations[rule] = [...ats].sort();
                byRule[rule] = ats.length;
            }
            return {
                total: Object.values(byRule).reduce((s, n) => s + n, 0),
                errors: 0,
                byRule,
                locations,
            };
        };
        // 样本必须同时覆盖四类边界路径，否则「某一类判错」不会红：
        // src 产品 / src 内 __tests__ / src 内 .spec.ts / src/test-utils（测试夹具）/ e2e。
        const nowMixed = shapeNow({
            "import(first)": ["src/a.ts:1", "src/features/x.ts:2", "src/a.spec.ts:3"],
            "unicorn(no-null)": ["e2e/mock/y.spec.ts:4", "src/test-utils/fixture.ts:5"],
        });
        const split = splitByArea(nowMixed);
        const legacyBaseline = shapeNow({ "import(first)": ["src/a.ts:1", "src/features/x.ts:2"] });

        const areaCases = [
            {
                name: "⑮ 区域归属：src 与 tests 各归各（e2e / src 内 .spec.ts / test-utils 都归 tests）",
                got: split,
                want: (s) => s.src.total === 2 && s.tests.total === 3,
                detail: "src=2 tests=3（含 test-utils 那条）",
            },
            {
                name: "⑯ 旧基线（只有 locations）⇒ 按路径无损推回 byArea（不是第二套口径）",
                got: areasOf(legacyBaseline),
                want: (a) =>
                    a.src.total === 2 && a.tests.total === 0 && a.src.byRule["import(first)"] === 2,
                detail: "src=2 tests=0",
            },
            {
                name: "⑰ 新基线（byArea）⇒ 原样读出，不被 locations 二次推导",
                got: areasOf({
                    byArea: {
                        src: { total: 7, byRule: { "x(y)": 7 } },
                        tests: { total: 3, byRule: { "x(y)": 3 } },
                    },
                    locations: { "x(y)": ["src/a.ts:1"] },
                }),
                want: (a) => a.src.total === 7 && a.tests.total === 3,
                detail: "src=7 tests=3（以 byArea 为准）",
            },
            {
                name: "⑱ 产品门不放松：正例（src 真增长必须报出）+ 反例（测试新增不进 src 门）",
                // 只测反例的话「恒返回空」的实现也绿 —— 第一次写这条用例时就假绿过，
                // 所以必须同时钉正例：src 区真涨 1 条要能报出来。
                got: {
                    // 注意取 .src：grownFamiliesInArea 收的是**区域切片**，不是 splitByArea 的整包
                    // （第一次写成整包时 byRule 不存在 ⇒ 恒空 ⇒ 正例假绿，已修）。
                    grow: grownFamiliesInArea(
                        splitByArea(
                            shapeNow({
                                "import(first)": [
                                    "src/a.ts:1",
                                    "src/features/x.ts:2",
                                    "src/b.ts:5",
                                ],
                            }),
                        ).src,
                        areasOf(
                            shapeNow({ "import(first)": ["src/a.ts:1", "src/features/x.ts:2"] }),
                        ).src,
                    ),
                    quiet: grownFamiliesInArea(
                        splitByArea(
                            shapeNow({
                                "import(first)": [
                                    "src/a.ts:1",
                                    "src/features/x.ts:2",
                                    "src/x.spec.ts:9",
                                ],
                            }),
                        ).src,
                        areasOf(
                            shapeNow({ "import(first)": ["src/a.ts:1", "src/features/x.ts:2"] }),
                        ).src,
                    ),
                },
                want: (g) => g.grow.length === 1 && g.grow[0].diff === 1 && g.quiet.length === 0,
                detail: "src 新增 1 条 ⇒ 报 1 族；新增落在 .spec.ts ⇒ src 门静默",
            },
        ];
        for (const testCase of areaCases) {
            checked += 1;
            if (!testCase.want(testCase.got)) {
                failed += 1;
                console.error(
                    "FAIL " +
                        testCase.name +
                        "（期望 " +
                        testCase.detail +
                        "，实得 " +
                        JSON.stringify(testCase.got).slice(0, 160) +
                        "）",
                );
            } else {
                console.log("PASS " + testCase.name);
            }
        }
    }
    rmSync(dir, { recursive: true, force: true });
    console.log("SELFTEST " + (checked - failed) + "/" + checked + (failed ? " ⇒ FAIL" : " ⇒ OK"));
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
        // task-43：收账要按区域记（--scope 前缀落在测试目录 ⇒ 记 tests 区），
        // 但**边界语义不变**：foreignGrowth 仍只看 (族, 文件) 计数差与 --scope 前缀。
        const nowAreasForBaseline = splitByArea(now);
        const previous = (() => {
            try {
                return JSON.parse(readFileSync(BASELINE, "utf8"));
            } catch {
                return null;
            }
        })();
        // task-36：收账边界 —— 不吸收「别人在途」的新增（判据与边界说明见 foreignGrowth）。
        const scopes = optionValues("--scope").map((scope) => scope.replace(/\\/g, "/"));
        const foreign = foreignGrowth(now, previous, scopes);
        if (foreign.length && !has("--allow-foreign")) {
            console.error(
                "FAIL 拒绝收账：有 " +
                    foreign.length +
                    " 处新增落在收账边界外" +
                    (scopes.length ? "（--scope " + scopes.join("、") + "）" : "（未给 --scope）") +
                    "：",
            );
            for (const entry of foreign) {
                console.error(
                    "  +" + (entry.to - entry.from) + "  " + entry.rule + "  " + entry.file,
                );
                for (const at of entry.at.slice(0, 5)) console.error("        " + at);
                if (entry.at.length > 5)
                    console.error("        …另 " + (entry.at.length - 5) + " 处");
            }
            console.error("  " + BASELINE + " 保持原样（未写盘）。");
            console.error(foreignHint(scopes));
            process.exit(3);
        }
        if (foreign.length) {
            console.log("WARN --allow-foreign 放行 " + foreign.length + " 处边界外新增（留痕）：");
            for (const entry of foreign) {
                console.log(
                    "  +" + (entry.to - entry.from) + "  " + entry.rule + "  " + entry.file,
                );
            }
        }
        let payload = {
            $comment:
                "oxlint warnings 基线（task-171 ② ratchet 门；task-219 起按族拦）。只能由 node scripts/check-lint-warnings.mjs --write-baseline 生成/收缩，勿手改；基线只许变小，变大须在卡面说明原因。",
            total: now.total,
            errors: now.errors,
            files: now.files,
            // task-43：棘轮分区域 —— 两区各自一份 byRule + total（规范 SSOT §3）。
            // 顶层 total/byRule 保留：它们是「全量读数」，供人读与旧消费者；门的判据改为按区域。
            byArea: Object.fromEntries(
                AREAS.map((area) => [
                    area,
                    {
                        total: nowAreasForBaseline[area].total,
                        byRule: Object.fromEntries(
                            Object.entries(nowAreasForBaseline[area].byRule).sort(
                                (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
                            ),
                        ),
                        locations: Object.fromEntries(
                            Object.entries(nowAreasForBaseline[area].locations).sort((a, b) =>
                                a[0].localeCompare(b[0]),
                            ),
                        ),
                    },
                ]),
            ),
            // 计数降序；同计数按族名升序 —— 否则并列族的先后取决于 oxlint 扫描顺序，
            // 跨机器/跨版本就可能翻序，把「重复生成两次 git diff 为空」这条幂等判据变成偶然成立（task-228）。
            byRule: Object.fromEntries(
                Object.entries(now.byRule).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
            ),
            locations: Object.fromEntries(
                Object.entries(now.locations).sort((a, b) => a[0].localeCompare(b[0])),
            ),
            // task-36：只有真的用 --allow-foreign 吸收了边界外新增才写这个键（否则省略）——
            // 既让「谁放行了什么」在 diff 里可复核，也不破坏「同样内容再跑一次逐字节不变」。
            ...(foreign.length
                ? { foreignAbsorbed: foreign.map((entry) => entry.rule + " " + entry.file) }
                : {}),
            generatedAt: new Date().toISOString(),
        };
        // task-228 ①：缩进 4（.oxfmtrc.jsonc 的 tabWidth: 4），随后由 formatBaseline() 交给 oxfmt 收口；
        // ② generatedAt 只在**内容真变**时刷新 —— 同一棵树连跑两次必须逐字节相同，否则
        // 「重复生成两次 git diff 为空」这条幂等判据永远不成立（时间戳每次都变）。
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
        const writeExit = writeBaseline({ baselinePath: BASELINE, payload, errors: now.errors });
        if (writeExit !== 0) process.exit(writeExit);
        console.log("WROTE 基线 total=" + now.total + "（errors=" + now.errors + "）⇒ " + BASELINE);
        process.exit(0);
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

    // task-43：按区域判（--area src|tests|all，默认 src = 产品门）
    const areaSel = resolveArea(optionValue("--area"));
    const nowAreas = splitByArea(now);
    const baseAreas = areasOf(baseline);
    const legacyBaseline = !baseline.byArea && Object.keys(baseline.locations ?? {}).length === 0;
    const grownByArea = {};
    for (const area of areaSel.areas) {
        grownByArea[area] = grownFamiliesInArea(nowAreas[area], baseAreas[area]);
    }
    const lines = renderReportArea({
        now,
        nowAreas,
        baseAreas,
        grownByArea,
        areaSel,
        legacyBaseline,
    });
    for (const line of lines) console.log(line);

    // errors 也按 --area 判：产品门的红不该由测试区一个半成品引起（同「测试债≠产品债」的病）。
    const selErrors = areaSel.areas.reduce((s, a) => s + nowAreas[a].errors, 0);
    const otherErrors = AREAS.filter((a) => !areaSel.areas.includes(a)).reduce(
        (s, a) => s + nowAreas[a].errors,
        0,
    );
    if (selErrors > 0) {
        console.error(
            "FAIL [" +
                areaSel.label +
                "] errors=" +
                selErrors +
                "（ratchet 只放宽 warnings，errors 在**被判区域**内恒为硬失败）",
        );
        process.exit(1);
    }
    if (otherErrors > 0) {
        // 不判的区域有 error ⇒ 只说清，不阻断（否则测试区半成品又能顶红产品门）。
        console.log(
            "（注意：未判区域有 " + otherErrors + " 个 error，本门不管；要看就加对应 --area）",
        );
    }
    if (legacyBaseline) {
        console.log(
            "WARN 基线既无 byArea 也无 locations（极旧格式）⇒ 本次不按族阻断；下次 --write-baseline 会补齐",
        );
        process.exit(0);
    }
    // 不用 map 里的对象展开：oxc(no-map-spread) 会报「在 map 里展开改属性效率低」——
    // 那是对我自己的门里新增的一条警告，按纪律**先修掉而不是收账**。
    const grownAll = areaSel.areas.flatMap((area) =>
        grownByArea[area].map((g) => ({
            area,
            rule: g.rule,
            count: g.count,
            before: g.before,
            diff: g.diff,
        })),
    );
    if (!grownAll.length) process.exit(0);

    const hint = selfHealHint();
    if (has("--enforce")) {
        console.error(
            "FAIL [" +
                areaSel.label +
                "] 有 " +
                grownAll.length +
                " 个族的 warnings 超基线（按族+按区域拦；该区读数 " +
                areaSel.areas.map((a) => a + "=" + nowAreas[a].total).join(" ") +
                "，不做总数判断）：" +
                grownAll.map((g) => g.area + "/" + g.rule + " +" + g.diff).join("、"),
        );
        console.error(hint);
        process.exit(1);
    }
    if (has("--enforce-total")) {
        const delta = areaSel.areas.reduce(
            (sum, a) => sum + (nowAreas[a].total - baseAreas[a].total),
            0,
        );
        if (delta > 0) {
            console.error(
                "FAIL 总数超出基线 " + delta + " 条（--enforce-total 旧语义，按 --area 求和）",
            );
            console.error(hint);
            process.exit(1);
        }
    }
    console.log("REPORT-ONLY 有族增长但未 --enforce ⇒ exit 0");
    console.log(hint);
    process.exit(0);
}

main();
