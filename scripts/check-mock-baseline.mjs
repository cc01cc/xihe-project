#!/usr/bin/env node
/**
 * PLAN-0735 / BL-164: compare the mock-lane report against the registered baseline.
 *
 * Why: Playwright exits 0 while skipped tests simply do not run; a "green" run can
 * silently shrink the suite (a spec turned fixme/skip) or absorb new failures as flaky.
 * This reads the JSON report `test:mock` wrote, compares counts and skip titles with
 * `packages/ui/e2e/mock-baseline.json`, and fails with `E_MOCK_BASELINE_DRIFT` on any
 * change (or `--allow-drift` to accept it deliberately).
 *
 * Usage: node scripts/check-mock-baseline.mjs [--report <json>] [--baseline <json>]
 *        [--allow-drift] [--allow-stale-report] [--no-write-baseline] [--write-baseline]
 *
 * task-250（用户裁定「丙」，2026-11-15）：**计数默认自动跟随实际收集数**。
 *   - failed=0 ⇒ 就地改写 `counts.expected/skipped`（+ `sourceRun` 记录命令/采集时刻/HEAD/spec sha256/收集数）；
 *   - failed≠0 ⇒ 一个字都不写（红不入基线），仍按 drift 判红；
 *   - `--no-write-baseline` = 退回「只读比对」的老语义（自洽轴不一致重新变成硬红）；
 *   - `--write-baseline` = 只写不比对（failed≠0 时 exit 2 + 点名 failed 清单）。
 * Exit 0 = match; 1 = drift; 2 = missing/unparsable inputs, or a stale report (`E_STALE_REPORT`).
 *
 * D-1039 ②（2026-11-12）: a report *file* turns this gate blind — comparing against a report
 * generated before the specs it claims to cover reports "no drift" for tests nobody ran.
 * Two-tier criterion (the naive "report mtime < newest spec mtime" alone red-lights 8 pure
 * checkout-mtime artifacts, measured 2026-11-12): the naive layer only marks "suspicious";
 * only a spec that is untracked/dirty, or whose last commit is NEWER than the report, is red.
 * `git log -1 --format=%ct` is the evidence — never the file mtime (checkout rewrites it).
 *
 * task-272 / D-1648（2026-11-16）: 所有子进程调用显式 timeout（值按 internal/A03-xihe/docs/
 * test-timeout-budget.md 分档，实测见常量注释）；子进程「超时 / 启动错误 / 信号杀死」必须
 * 显式失败（E_SELFTEST_CHILD_*），git 失败不得吞成「git = ok」。只加 timeout 会把响亮挂起
 * 变成静默假绿（D-1644②），故 catch 错误传播同批收口；判据强度不变。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * task-272 / D-1648：子进程超时一律显式、动态可配（test-timeout-budget.md §1.4），
 * 非法值 fail-fast（§2.1 模式：不静默回落默认值——「我设了却没生效」比「没设」更难查）。
 * 分档与实测（2026-11-16，本机，5/3 轮）：
 *   - git 一次性查询：§1.2 默认 ≤10s（实测 rev-parse 11–23ms / status -uall 46–79ms）；
 *   - selftest 子门运行：§1.2 默认 ≤10s（实测单child 448–479ms，约 20 倍余量）；
 *   - pwsh 进程数探针：§2 监控/巡检档 ≤5s、上限 10s（实测 358–779ms）——原 20s 超该档上限，下调。
 * env 覆盖上限：git/selftest 30s（§2 test 档上限；>10s 属外部进程启动豁免，§1.3），探针 10s（该档上限）。
 */
function timeoutFromEnv(name, defaultMs, capMs) {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return defaultMs;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0 || value > capMs) {
        throw new Error(
            `E_MOCK_TIMEOUT_CONFIG: ${name} must be a positive integer <= ${capMs} (ms), got ${JSON.stringify(raw)}`,
        );
    }
    return value;
}
// timeout-exempt: external-process（git/子 node 启动在慢机器上可超 10s；仅 env 覆盖可达，上限 30s）
const GIT_TIMEOUT_MS = timeoutFromEnv("XIHE_MOCK_GIT_TIMEOUT_MS", 10_000, 30_000);
const SELFTEST_CHILD_TIMEOUT_MS = timeoutFromEnv("XIHE_MOCK_SELFTEST_TIMEOUT_MS", 10_000, 30_000);
const PROBE_TIMEOUT_MS = timeoutFromEnv("XIHE_MOCK_PROBE_TIMEOUT_MS", 5_000, 10_000);

/**
 * PLAN-0739: resolve the A03 checkout the caller is actually in (primary checkout or
 * linked worktree) instead of guessing it from this file's location. `mise` runs tasks at
 * the repo root, and every other entry point passes `--report`/`--baseline` explicitly.
 */
function resolveRepoRoot() {
    try {
        return execFileSync("git", ["rev-parse", "--show-toplevel"], {
            cwd: process.cwd(),
            encoding: "utf8",
            timeout: GIT_TIMEOUT_MS,
        }).trim();
    } catch {
        return path.resolve(HERE, "..");
    }
}

function parseArgs(argv) {
    const repoRoot = resolveRepoRoot();
    const out = {
        repoRoot,
        report: path.join(repoRoot, "packages/ui/e2e/.mock-report.json"),
        baseline: path.join(repoRoot, "packages/ui/e2e/mock-baseline.json"),
        allowDrift: false,
        allowStaleReport: false,
        // task-179：改动面（判据 ① 的输入）、flaky 历史（判据 ④ 的输入）、环境证据采集开关。
        changedSpecs: null,
        flakyHistory: null,
        noFlakyHistory: false,
        noProbeProcs: false,
        workers: process.env.XIHE_E2E_WORKERS ?? null,
        selftest: false,
        // task-250（用户裁定「丙」）：只自动更新 expected/skipped 计数；失败必须为 0 才允许写。
        writeBaseline: false,
        noWriteBaseline: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--report") out.report = path.resolve(argv[++i]);
        else if (arg === "--baseline") out.baseline = path.resolve(argv[++i]);
        else if (arg === "--allow-drift") out.allowDrift = true;
        else if (arg === "--allow-stale-report") out.allowStaleReport = true;
        else if (arg === "--changed-specs") {
            out.changedSpecs = argv[++i].split(",").map(normalizePath).filter(Boolean);
        } else if (arg === "--flaky-history") out.flakyHistory = path.resolve(argv[++i]);
        else if (arg === "--no-flaky-history") out.noFlakyHistory = true;
        else if (arg === "--no-probe-procs") out.noProbeProcs = true;
        else if (arg === "--workers") out.workers = argv[++i];
        else if (arg === "--selftest") out.selftest = true;
        else if (arg === "--write-baseline") out.writeBaseline = true;
        else if (arg === "--no-write-baseline") out.noWriteBaseline = true;
        else throw new Error("unknown argument: " + arg);
    }
    if (!out.flakyHistory) {
        out.flakyHistory = path.join(path.dirname(out.report), ".mock-flaky-history.json");
    }
    return out;
}

function readJson(file, label) {
    if (!fs.existsSync(file)) {
        throw new Error(`missing ${label}: ${file}`);
    }
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
        throw new Error(`cannot parse ${label} ${file}: ${error.message}`);
    }
}

/** Normalise a skip title: drop Playwright's retry prefix and padding. */
function normalizeTitle(value) {
    return String(value ?? "")
        .replace(/^\[retry\]#?\d+\s*/, "")
        .trim();
}

/** Repo-relative POSIX path: 判据 ① 要拿报告里的 file 和 git 里的路径对齐。 */
function normalizePath(value) {
    return String(value ?? "")
        .split(path.sep)
        .join("/")
        .replace(/^\.\//, "");
}

/**
 * task-211：从 `sourceRun` 文本里抽 `expected/skipped/failed/flaky` 四个数（没有就是 `null`）。
 *
 * 为什么要有这个：标尺文件里 `counts` 是**机器比对**用的现值，`sourceRun` 是**给人看**的出处。
 * 两处各写一个数、又没有任何东西保证它们一致 ⇒ 只读 `sourceRun` 的人必然读成「标尺自相矛盾」
 * （2026-11-13 的 291 vs 288 就是这样被误读成笔误的，实际 291 是 `$countsDerivation` 里的有据推导）。
 */
export function parseCountsFromSourceRun(sourceRun) {
    const text = String(sourceRun ?? "");
    const pick = (label) => {
        const match = new RegExp("\\b" + label + "\\s*(?:=|:)?\\s*(\\d+)", "i").exec(text);
        return match ? Math.trunc(Number(match[1])) : null;
    };
    return {
        expected: pick("expected"),
        skipped: pick("skipped"),
        failed: pick("failed"),
        flaky: pick("flaky"),
    };
}

/**
 * task-211：标尺**自洽**检查（`counts.expected` ↔ `sourceRun` 文本）。
 *
 * 三态：
 * - `ok`：两处一致，或 `sourceRun` 里根本没有可解析的 expected（历史夹具没有该字段）；
 * - `warn`：两处不一致，但文件里有 `$countsDerivation` ⇒ **有据推导**，打印它并放行（不放松比对语义）；
 * - `error`：两处不一致且**没有** derivation ⇒ 标尺内部矛盾，必须红（否则谁手改 `counts` 都没人拦）。
 */
export function inspectBaselineCounts(baseline, baselinePath = "(baseline)") {
    const declared = Math.trunc(Number(baseline?.counts?.expected ?? NaN));
    const derivation =
        typeof baseline?.$countsDerivation === "string" ? baseline.$countsDerivation.trim() : "";
    const fromSource = parseCountsFromSourceRun(baseline?.sourceRun).expected;
    if (!Number.isFinite(declared)) {
        return {
            status: "error",
            lines: [
                "E_MOCK_BASELINE_COUNTS_MISSING: " + baselinePath + " has no counts.expected",
                "  标尺必须有机器比对的现值；缺了它，比对会退化成「什么都不比」。",
            ],
        };
    }
    if (fromSource === null) {
        return {
            status: "warn",
            lines: [
                "[check-mock-baseline] MOCK_BASELINE_COUNTS_NOT_EVALUATED: 自洽轴未评估（不等于一致）：" +
                    baselinePath +
                    " 的 sourceRun 无法交叉核对（counts.expected=" +
                    declared +
                    "）",
            ],
        };
    }
    if (fromSource === declared) {
        // Lead 2026-11-15：日志里「没判」与「判了且一致」**绝不能被读成同一件事**（`空转=不判` ≠ `空转 0`）。
        // 所以通过也要留一行明确写着「自洽轴通过」，而不是静默。
        return {
            status: "ok",
            lines: [
                "[check-mock-baseline] MOCK_BASELINE_COUNTS_CONSISTENT: 自洽轴通过：counts.expected=" +
                    declared +
                    " 与 sourceRun 里的 expected 一致",
            ],
        };
    }
    if (derivation) {
        return {
            status: "warn",
            lines: [
                "[check-mock-baseline] MOCK_BASELINE_COUNTS_DERIVED: counts.expected=" +
                    declared +
                    " 与 sourceRun 里的 expected=" +
                    fromSource +
                    " 不同，但文件带 $countsDerivation（有据推导，放行；比对语义不变）",
                "  derivation: " + derivation.slice(0, 400) + (derivation.length > 400 ? "…" : ""),
            ],
        };
    }
    return {
        status: "error",
        lines: [
            "E_MOCK_BASELINE_SELF_INCONSISTENT: " +
                baselinePath +
                " 的 counts.expected=" +
                declared +
                "，但同一文件的 sourceRun 写 expected=" +
                fromSource,
            "  标尺自身的两个数必须能对上：要么把 sourceRun 写成「现值见 $countsDerivation」式的交叉引用，",
            "  要么补一条 `$countsDerivation`（写清 [实测]/[推导]、哪次运行、报告路径），要么重跑全量后同批更新两处。",
            "  禁止只改其中一个数 —— 那会让每一次比对都不可信。",
        ],
    };
}
export function summarizeReport(report) {
    const stats = report?.stats ?? {};
    const expected = Math.trunc(Number(stats.expected ?? 0));
    const failed = Math.trunc(Number(stats.unexpected ?? 0));
    const flaky = Math.trunc(Number(stats.flaky ?? 0));
    const skipped = Math.trunc(Number(stats.skipped ?? 0));
    const skipNames = [];
    const flakyCases = [];
    /** task-250：写基线被拒绝时要把 failed 清单摆出来 —— 只说「failed=3」不给人可核对的对象。 */
    const failedCases = [];
    const walk = (suite) => {
        const file = typeof suite?.file === "string" ? normalizePath(suite.file) : null;
        for (const spec of suite?.specs ?? []) {
            // task-179: flaky 必须连**文件名**一起拿出来 —— 判据 ① 判的是
            // 「本轮 flaky 用例 ∩ 本轮改到的 spec 文件」，只留标题无法落地。
            const tests = spec?.tests ?? [];
            if (tests.some((test) => test?.status === "flaky")) {
                flakyCases.push({ title: normalizeTitle(spec?.title), file });
            }
            if (
                tests.some(
                    (test) =>
                        test?.status === "unexpected" ||
                        (test?.status === "expected" && test?.expectedStatus === "failed"),
                )
            ) {
                failedCases.push({ title: normalizeTitle(spec?.title), file });
            }
        }
        for (const spec of suite?.specs ?? []) {
            // PLAN-0739: the JSON reporter emits one result even for skipped tests (status
            // "skipped"), so "no results" never matched. Judge the plan, not result count.
            const skipped =
                (spec?.tests ?? []).length > 0 &&
                (spec?.tests ?? []).every(
                    (test) => test?.status === "skipped" || test?.expectedStatus === "skipped",
                );
            if (skipped) {
                skipNames.push(normalizeTitle(spec?.title));
            }
        }
        for (const child of suite?.suites ?? []) walk(child);
    };
    for (const file of report?.suites ?? []) walk(file);
    return { expected, failed, flaky, skipped, skipNames, flakyCases, failedCases };
}

/**
 * task-179（Lead 裁定 2026-11-13）：`expected`/`skipped`/`failed` 仍**精确比对**；
 * `flaky` **移出精确比对**，改由 `evaluateFlakyPolicy` 的四条正交判据处理。
 *
 * 为什么不改成「≤ 基线」：那允许有人把基线写成 flaky=5，一次采样就把偶发固化成永久许可，
 * 从此外面 5 条沉默 flaky 永远看不见（Lead 原话：把噪声写进合同）。精确比对 flaky 又会在
 * 并发 lane 下周期性假红（实测同树两轮：0 flaky / 5 flaky）。所以换成：
 * 基线 flaky 恒 0（门主动拒收非零基线）+ 改动面交集判红 + 改动面外只 WARN（逐条点名 +
 * 环境证据）+ 连续 ≥3 轮升级并要求立 BL。
 */
export function compareWithBaseline(summary, baseline) {
    const problems = [];
    const counts = baseline?.counts ?? {};
    for (const field of ["expected", "skipped", "failed"]) {
        const expectedValue = Math.trunc(Number(counts[field] ?? 0));
        if (summary[field] !== expectedValue) {
            problems.push(`${field}: baseline=${expectedValue} actual=${summary[field]}`);
        }
    }
    const registered = new Set((baseline?.skipNames ?? []).map(normalizeTitle));
    const actual = new Set(summary.skipNames);
    const unregistered = [...actual].filter((name) => !registered.has(name));
    const retired = [...registered].filter((name) => !actual.has(name));
    for (const name of unregistered) problems.push(`skip unregistered: ${name}`);
    for (const name of retired) problems.push(`skip no longer present: ${name}`);
    return { problems, unregistered, retired };
}

/**
 * task-48（2026-11-11）：**拒收子集报告**。
 *
 * 判据两道，任一命中即认定「输入不合格」（exit 2），而不是当 drift（exit 1）——
 * 因为拿 5 文件子集去和全量基线比，得到的差异既不是回归也不是修好的证据。
 *   ① 文件是分文件约定里的子集名（`.mock-report.subset.json`）；
 *   ② 用例总数不足基线的 50%（实测：全量 317 条 vs 单文件/5 文件子集 60 量级）。
 */
export function rejectSubsetReport(reportPath, summary, baseline) {
    if (reportPath.endsWith(".subset.json")) {
        return `子集报告不能用来判基线：${reportPath}`;
    }
    const baselineTotal =
        Math.trunc(Number(baseline?.counts?.expected ?? 0)) +
        Math.trunc(Number(baseline?.counts?.skipped ?? 0));
    const actualTotal = summary.expected + summary.skipped;
    if (baselineTotal > 0 && actualTotal < baselineTotal * 0.5) {
        return (
            `报告只覆盖 ${actualTotal} 条用例，不足基线 ${baselineTotal} 条的 50% ` +
            `（${reportPath}）：这看起来是一次子集跑`
        );
    }
    return null;
}

function iso(seconds) {
    return new Date(seconds * 1000).toISOString();
}

/**
 * D-1039 ②（2026-11-12）：**陈旧报告**判据（两级）。
 *
 * 一级（naive）：报告 mtime < 任一个 mock spec 的 mtime ⇒ 只记「可疑」，**不判红**。
 *   单独用它在本仓实测会假红 8 条 —— checkout/编辑会重写 mtime，但文件内容与提交都比报告旧。
 * 二级（定性）：可疑 spec 满足任一条 ⇒ 判红：
 *   - `git status --porcelain -z --untracked-files=all` 里有记录（untracked / dirty / staged）；
 *   - 该文件 `git log -1 --format=%ct` 的提交时间 **晚于** 报告 mtime。
 * 判据只看提交时间，**不看文件 mtime**（mtime 会被 checkout 改写，那正是伪影的来源）。
 * git 不可用（非仓库/无 git）⇒ 退化为一级判据并显式点名，不静默放行。
 *
 * @returns {{suspicious: Array, culprits: Array, artifacts: Array, reportMtimeSec: number|null, newest: object|null, gitAvailable: boolean}}
 */
export function detectStaleReport({ repoRoot, reportPath }) {
    const result = {
        suspicious: [],
        culprits: [],
        artifacts: [],
        reportMtimeSec: null,
        newest: null,
        gitAvailable: true,
    };
    let reportStat;
    try {
        reportStat = fs.statSync(reportPath);
    } catch {
        return result;
    }
    result.reportMtimeSec = Math.trunc(reportStat.mtimeMs / 1000);
    const specDir = path.join(repoRoot, "packages/ui/e2e/mock");
    const specs = [];
    const walk = (current) => {
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const abs = path.join(current, entry.name);
            if (entry.isDirectory()) walk(abs);
            else if (entry.isFile() && entry.name.endsWith(".spec.ts")) specs.push(abs);
        }
    };
    walk(specDir);
    if (specs.length === 0) return result;
    const rel = (abs) => path.relative(repoRoot, abs).split(path.sep).join("/");
    const dirtyPaths = new Set();
    try {
        const raw = execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
            cwd: repoRoot,
            encoding: "utf8",
            timeout: GIT_TIMEOUT_MS,
        });
        for (const entry of raw.split("\0").filter(Boolean)) {
            dirtyPaths.add(entry.slice(3).split(path.sep).join("/"));
        }
    } catch {
        result.gitAvailable = false;
    }
    const commitTime = (relPath) => {
        try {
            const raw = execFileSync("git", ["log", "-1", "--format=%ct", "--", relPath], {
                cwd: repoRoot,
                encoding: "utf8",
                timeout: GIT_TIMEOUT_MS,
            }).trim();
            const value = Number(raw);
            return Number.isFinite(value) && value > 0 ? value : null;
        } catch {
            return null;
        }
    };
    for (const abs of specs) {
        let stat;
        try {
            stat = fs.statSync(abs);
        } catch {
            continue;
        }
        const mtimeSec = Math.trunc(stat.mtimeMs / 1000);
        if (!result.newest || mtimeSec > result.newest.mtimeSec) {
            result.newest = { file: rel(abs), mtimeSec };
        }
        if (mtimeSec <= result.reportMtimeSec) continue;
        const relPath = rel(abs);
        const entry = { file: relPath, mtimeSec };
        result.suspicious.push(entry);
        if (!result.gitAvailable) {
            result.culprits.push({
                ...entry,
                reason: "git 不可用，无法区分「内容新」与「纯 mtime 伪影」（一级判据退化）",
            });
            continue;
        }
        if (dirtyPaths.has(relPath)) {
            result.culprits.push({ ...entry, reason: "未提交（untracked / dirty / staged）" });
            continue;
        }
        const committedAt = commitTime(relPath);
        if (committedAt === null) {
            result.culprits.push({ ...entry, reason: "git 查不到提交时间（未跟踪或路径未入库）" });
            continue;
        }
        if (committedAt > result.reportMtimeSec) {
            result.culprits.push({
                ...entry,
                reason: `提交时间 ${iso(committedAt)} 晚于报告 ${iso(result.reportMtimeSec)}`,
            });
            continue;
        }
        result.artifacts.push({ ...entry, commitSec: committedAt });
    }
    return result;
}

/**
 * task-179 判据 ① 的输入：**本轮改到的 spec 文件**（两个来源取并集，且都在输出里点名，
 * 因为「改动面」是判据的关键前提，前提不清就等于判据不清）：
 *   ① 工作树：`git status --porcelain` 里的 dirty / untracked `.spec.ts`（还没提交的改动）；
 *   ② 提交面：基线文件最后一次提交 .. HEAD 之间改过的 `.spec.ts`（已提交但基线没跟上的改动）。
 * git 不可用 ⇒ `gitAvailable=false`，判据 ① 退化为「只认 ①」，并在 WARN 里显式说明，不静默放行。
 */
export function resolveChangedSpecs({ repoRoot, baselinePath }) {
    const specs = new Set();
    const dirty = [];
    const sinceBaseline = [];
    const result = { specs: [], dirty, sinceBaseline, baselineCommit: null, gitAvailable: true };
    const git = (args) =>
        execFileSync("git", args, {
            cwd: repoRoot,
            encoding: "utf8",
            maxBuffer: 32 * 1024 * 1024,
            timeout: GIT_TIMEOUT_MS,
        }).trim();
    try {
        const raw = execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
            cwd: repoRoot,
            encoding: "utf8",
            timeout: GIT_TIMEOUT_MS,
        });
        for (const entry of raw.split("\0").filter(Boolean)) {
            const rel = normalizePath(entry.slice(3));
            if (!rel.endsWith(".spec.ts")) continue;
            dirty.push(rel);
            specs.add(rel);
        }
    } catch {
        result.gitAvailable = false;
    }
    if (result.gitAvailable) {
        try {
            const commit = git(["log", "-1", "--format=%H", "--", baselinePath]);
            if (commit) {
                result.baselineCommit = commit;
                // 基线文件与 lane 的 spec 改动**通常落在同一个提交**（本轮 base 就是这样：
                // 基线 json 与 5 个 spec 同在 ff865ed6b）⇒ 只看 commit..HEAD 会得到空集，
                // 判据 ① 就等于失效。所以把**基线那一提交自己的 diff**也并进来。
                const ownChange = git([
                    "show",
                    "--name-only",
                    "--format=",
                    commit,
                    "--",
                    "packages/ui/e2e",
                ]);
                const changes = git([
                    "log",
                    "--format=",
                    "--name-only",
                    "".concat(commit, "..HEAD"),
                    "--",
                    "packages/ui/e2e",
                ]);
                for (const line of ownChange.split(/\r?\n/)) {
                    const rel = normalizePath(line);
                    if (!rel.endsWith(".spec.ts")) continue;
                    sinceBaseline.push(rel);
                    specs.add(rel);
                }
                for (const line of changes.split(/\r?\n/)) {
                    const rel = normalizePath(line);
                    if (!rel.endsWith(".spec.ts")) continue;
                    sinceBaseline.push(rel);
                    specs.add(rel);
                }
            }
        } catch (error) {
            // task-272 / D-1648：git **失败**（非零退出 / 启动错误 / 超时）≠「基线未入库 / 无历史」——
            // 后者是 git 成功但输出为空（不抛异常），走上面的 if (commit) 分支，gitAvailable 保持 true。
            // 失败必须显式降级为「只认工作树」并记录原因（basis 里点名），不得吞成「git = ok」：
            // 那会让判据 ① 悄悄丢掉提交面改动集，flaky 落在已提交 spec 里时被当「改动面外」放行（假绿）。
            result.gitAvailable = false;
            result.gitError = String(error?.message ?? error);
        }
    }
    // 只认 e2e 车道内的 spec：mock 报告只可能包含 e2e 用例，把 `src/**/*.spec.ts`
    // （单测）混进「改动面」只会制造噪声，不会增加判据强度。
    const e2eOnly = (rel) => rel.startsWith("packages/ui/e2e/");
    result.dirty = result.dirty.filter(e2eOnly);
    result.sinceBaseline = result.sinceBaseline.filter(e2eOnly);
    result.specs = [...specs].filter(e2eOnly).sort();
    return result;
}

/** 环境证据用到的并发进程数。取不到就报 `unknown`，不编数字。 */
function probeProcessCounts() {
    const count = (name) => {
        try {
            const out = execFileSync(
                "pwsh",
                [
                    "-NoProfile",
                    "-Command",
                    "@(Get-Process -Name ".concat(name, " -ErrorAction SilentlyContinue).Count"),
                ],
                // task-272：监控/巡检档 ≤5s、上限 10s（test-timeout-budget.md §2）；原 20s 超上限。
                { encoding: "utf8", timeout: PROBE_TIMEOUT_MS },
            ).trim();
            const value = Number(out);
            return Number.isFinite(value) ? value : null;
        } catch {
            return null;
        }
    };
    const java = count("java");
    const node = count("node");
    if (java === null && node === null) return null;
    return { java, node };
}

/** 树指纹：HEAD sha + porcelain 行数（漂移判据的常用锚，WARN 里必须带）。 */
function treeFingerprint(repoRoot) {
    try {
        const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
            cwd: repoRoot,
            encoding: "utf8",
            timeout: GIT_TIMEOUT_MS,
        }).trim();
        const porcelain = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
            cwd: repoRoot,
            encoding: "utf8",
            timeout: GIT_TIMEOUT_MS,
        });
        const lines = porcelain.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
        return { head, dirty: lines };
    } catch {
        return { head: "unknown", dirty: null };
    }
}

export function formatEnvEvidence(env) {
    const procs = env?.procs
        ? "java=".concat(env.procs.java, "/node=").concat(env.procs.node)
        : "unknown";
    return [
        "head=".concat(env?.head ?? "unknown"),
        "porcelain=".concat(env?.dirty ?? "unknown"),
        "port=".concat(env?.port ?? "unknown"),
        "workers=".concat(env?.workers ?? "unknown"),
        "procs=".concat(procs),
    ].join(" ");
}

/**
 * task-179 判据 ②③④（纯函数，便于 selftest 与单测直接喂夹具）：
 *   ① 改动面内 flaky ⇒ error `E_MOCK_FLAKY_IN_CHANGED_SPEC`（exit 1，本次改动可疑）；
 *   ② 改动面外 flaky ⇒ WARN **逐条**打印用例名 + 文件 + 该轮环境证据（只打数字的 WARN 等于没有 WARN）；
 *   ④ 同一用例名连续 ≥3 轮出现 ⇒ error `E_MOCK_FLAKY_PERSISTENT`（真不稳定不许被「环境性」解释吃掉）。
 * 返回值里同时给出本轮的 history entry，调用方决定是否落盘。
 */
export function evaluateFlakyPolicy({ flakyCases, changedSpecs, history, env }) {
    const errors = [];
    const warnings = [];
    const changed = new Set((changedSpecs?.specs ?? []).map(normalizePath));
    const cases = (flakyCases ?? []).filter((item) => item?.title);
    const inChanged = cases.filter((item) => item.file && changed.has(normalizePath(item.file)));
    const outside = cases.filter((item) => !(item.file && changed.has(normalizePath(item.file))));
    const evidence = formatEnvEvidence(env);
    if (cases.length > 0) {
        const basis = [
            "changed = ".concat(changed.size, " spec file(s) [dirty + since-baseline]"),
            "baseline commit = ".concat(changedSpecs?.baselineCommit ?? "unknown"),
            "git = ".concat(
                changedSpecs?.gitAvailable === false
                    ? "unavailable(① 退化为只认工作树)" +
                          (changedSpecs?.gitError ? ": " + changedSpecs.gitError : "")
                    : "ok",
            ),
        ].join("; ");
        if (inChanged.length > 0) {
            errors.push({
                code: "E_MOCK_FLAKY_IN_CHANGED_SPEC",
                lines: [
                    "".concat(
                        inChanged.length,
                        " flaky case(s) inside the changed spec files ⇒ this change is suspect",
                    ),
                    ...inChanged.map((item) =>
                        "flaky: ".concat(item.title, "（").concat(item.file, "）"),
                    ),
                    "  ".concat(basis),
                    "  ".concat(evidence),
                ],
            });
        }
        for (const item of outside) {
            warnings.push(
                "[WARN] MOCK_FLAKY_OUTSIDE_CHANGED_SPEC: "
                    .concat(item.title, "（")
                    .concat(item.file ?? "file-unknown", "）"),
            );
            warnings.push("       env: ".concat(evidence));
        }
        if (outside.length > 0) {
            warnings.push("       basis: ".concat(basis));
        }
        // task-225：**环境性 flaky 的最常见来源要给出来**（原来只报用例名与环境证据，
        // 读的人得自己想到「是不是并发把产物目录清了」）。这是一条**线索**，不是判定：
        // 命中它不等于这条 flaky 一定是环境性的 —— 改动面内那条判据照旧会红（此处不放松）。
        warnings.push(
            "       可能原因（提示，不作判定）：多个 Playwright 进程共用同一 artifact 目录 ⇒ " +
                "后启动者在开跑时清空 test-results/，先启动者写 trace 时 ENOENT，" +
                "第二次重试跑绿 ⇒ 被 retries 静默吸收成 flaky（task-224 / D-1599）。" +
                "并发跑时给每个 lane 设 XIHE_MOCK_OUTPUT_DIR（DEV-020 §3.6 / §3.3）。",
        );
    }
    const runs = Array.isArray(history) ? history.slice() : [];
    const titles = [...new Set(cases.map((item) => item.title))];
    const streak = [];
    for (const title of titles) {
        let count = 1;
        for (let i = runs.length - 1; i >= 0; i -= 1) {
            const runTitles = (runs[i]?.flaky ?? []).map(normalizeTitle);
            if (!runTitles.includes(title)) break;
            count += 1;
        }
        if (count >= 3) streak.push({ title, runs: count });
    }
    if (streak.length > 0) {
        errors.push({
            code: "E_MOCK_FLAKY_PERSISTENT",
            lines: [
                "".concat(
                    streak.length,
                    " flaky case(s) appeared in >=3 consecutive runs ⇒ file a BL",
                ),
                ...streak.map((item) =>
                    "flaky: ".concat(item.title, "（连续 ").concat(item.runs, " 轮）"),
                ),
            ],
        });
    }
    const entry = {
        at: new Date().toISOString(),
        head: env?.head ?? "unknown",
        flaky: titles,
    };
    return { errors, warnings, inChanged, outside, streak, entry, evidence };
}

/**
 * 追加一轮 flaky 历史（保留最近 `maxRuns` 轮；文件本身 gitignored）。
 * **幂等**：同一份报告被复查（人工再跑一次门）不算新一轮 —— 否则 `--gate` 跑两次就能把
 * 「连续 3 轮」凑出来，判据 ④ 就成了可被反复调用伪造的判据。判重键 = 报告的 mtime 指纹。
 */
export function appendFlakyHistory(file, entry, maxRuns = 20) {
    let history = [];
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (Array.isArray(parsed)) history = parsed;
    } catch {
        history = [];
    }
    const last = history[history.length - 1];
    const sameReport =
        last &&
        entry?.report &&
        last?.report &&
        last.report.mtimeMs === entry.report.mtimeMs &&
        last.report.expected === entry.report.expected &&
        last.report.skipped === entry.report.skipped &&
        last.report.flaky === entry.report.flaky;
    if (sameReport) history[history.length - 1] = entry;
    else history.push(entry);
    const trimmed = history.slice(-maxRuns);
    try {
        fs.writeFileSync(file, JSON.stringify(trimmed, null, 2) + "\n");
    } catch {
        // 写不进去不该让门变红（历史只是判据 ④ 的输入）；下一次读不到就从 1 开始计数。
    }
    return trimmed;
}
/**
 * task-179 卡面要求的 `--selftest`：四条判据各自的正负例，**全部用夹具报告，不起浏览器**。
 * 判据核心是那对阴性对照 ——
 *   ① 改动面内 flaky ⇒ E_MOCK_FLAKY_IN_CHANGED_SPEC + exit 1；
 *   ② **同一份报告**把该 spec 移出改动面 ⇒ WARN（带用例名与环境证据）+ **exit 0**。
 * 只证明「环境性 flaky 放过了」不够，还要证明「改动面内的 flaky 不会被放过」。
 */
/** selftest 逐例结果（`assertCase` 需要回看刚跑的那一例）。 */
let selftestCases = [];


// ---------------- task-250：基线模型「丙」的写路径 ----------------
//
// 用户裁定（2026-11-15）：**只自动更新 expected / skipped 计数（跟随实际收集数）；failed 必须为 0 才允许写**。
// 两条语义都在：计数永不漂（不等人工抄），红永不被吸收（failed≠0 直接拒写）。
//
// 为什么写在这里而不是另起一个生成器：比对与写入必须用**同一份** summarizeReport 结果，
// 否则「拿 A 跑次的计数去判、用 B 跑次的计数去写」就是 D-1611 的混跑次错误 —— 一个文件里没有这个缝。

const BASELINE_WRITE_MODEL =
    "task-250 模型丙：只自动更新 expected/skipped；failed!==0 拒写";

/** 本轮报告覆盖到的 spec 文件（相对 packages/ui），排序后稳定。 */
export function collectedSpecFiles(report) {
    const files = new Set();
    for (const suite of report?.suites ?? []) {
        const file = typeof suite?.file === "string" ? normalizePath(suite.file) : null;
        if (file) files.add(file);
    }
    return [...files].sort();
}

/** spec 指纹 = 每个 spec 的内容 sha256 按路径排序拼起来再 sha256 ⇒ 同一批 spec 恒同值。 */
export function specFingerprint({ repoRoot, report }) {
    const uiRoot = path.join(repoRoot, "packages/ui");
    const files = collectedSpecFiles(report);
    const rows = [];
    for (const rel of files) {
        let digest = "(missing)";
        try {
            digest = createHash("sha256").update(fs.readFileSync(path.join(uiRoot, rel))).digest("hex");
        } catch {
            // 报告里的 spec 已被删/改名：保留可追溯的 "(missing)"，不要静默当成没这个文件
        }
        rows.push(rel + ":" + digest);
    }
    return { files: files.length, sha256: createHash("sha256").update(rows.join("\n")).digest("hex") };
}

/** 采集时刻取自**报告本身**（stats.startTime）；退路用报告文件 mtime —— 都不用 now()，否则幂等必坏。 */
export function reportCollectedAt(report, reportPath) {
    const start = report?.stats?.startTime;
    if (typeof start === "string" && start.trim()) {
        const at = new Date(start);
        if (!Number.isNaN(at.getTime())) return at.toISOString();
    }
    return new Date(fs.statSync(reportPath).mtimeMs).toISOString();
}

function headCommit(repoRoot) {
    try {
        return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
            cwd: repoRoot,
            encoding: "utf8",
            timeout: GIT_TIMEOUT_MS,
        }).trim();
    } catch {
        return "(unavailable)";
    }
}

/** sourceRun：人可回溯到具体跑次（命令 + 采集时刻 + HEAD + spec sha256 + 收集数）。 */
export function buildSourceRunText({ summary, fingerprint, collectedAt, head, reportPath, repoRoot }) {
    const rel = normalizePath(path.relative(repoRoot, reportPath));
    return (
        BASELINE_WRITE_MODEL +
        " ｜ 命令 mise run test:mock ｜ 采集 " + collectedAt +
        " ｜ HEAD " + head +
        " ｜ specs sha256 " + fingerprint.sha256.slice(0, 16) + "（" + fingerprint.files + " 文件）" +
        " ｜ expected=" + summary.expected + " skipped=" + summary.skipped +
        " failed=" + summary.failed + " flaky=" + summary.flaky +
        " ｜ report " + rel
    );
}

/** 只改 counts 四数 + sourceRun + generatedAt；其余键（$comment / skipNames / 推导说明）原样保留。 */
export function applyBaselineCounts({ baseline, summary, sourceRun, collectedAt }) {
    const next = { ...baseline };
    next.counts = {
        expected: summary.expected,
        skipped: summary.skipped,
        failed: summary.failed,
        flaky: 0,
    };
    // task-272 同批 lint 收口：原条件含恒真析取项（e2b489152 引入，no-constant-condition 红）；
    // 语义不变——本来就无条件写 sourceRun。
    next.sourceRun = sourceRun;
    if (typeof baseline?.generatedAt === "string") next.generatedAt = collectedAt.slice(0, 10);
    return next;
}

/** 内容不变就不写（连跑两次字节相同）；返回是否真的落盘。 */
export function writeBaselineIfChanged(file, next) {
    const text = JSON.stringify(next, null, 4) + "\n";
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (current === text) return { changed: false, text };
    fs.writeFileSync(file, text, "utf8");
    return { changed: true, text };
}

/**
 * 模型「丙」的**默认行为**：一次 gate 运行里，只要 failed=0，就地把 expected/skipped 跟到实际收集数。
 *
 * 为什么默认就写、而不是等人加 flag：丙的判据原话是「只**自动**更新 expected/skipped 计数」——
 * 若还要人手加 flag，291 vs 544 那种落后 253 条的状态会原样重现（没人会为一个数字专门跑一次命令）。
 * 反过来，failed≠0 时这里一个字都不动 ⇒ 红永远进不了基线。
 *
 * 返回更新后的基线对象（未变则原样返回），后续比对必须用它 —— 否则「写进文件了，但这一次比对
 * 还是拿旧数判红」，两个读数互相打脸。
 */
export function maybeAutoUpdateCounts({ options, report, summary, baseline }) {
    if (summary.failed !== 0) {
        console.log(
            "[check-mock-baseline] 计数自动跟随**跳过**：failed=" + summary.failed +
                " ≠ 0（丙：红不入基线；基线文件未改动）",
        );
        return { baseline, changed: false };
    }
    const fingerprint = specFingerprint({ repoRoot: options.repoRoot, report });
    const collectedAt = reportCollectedAt(report, options.report);
    const sourceRun = buildSourceRunText({
        summary,
        fingerprint,
        collectedAt,
        head: headCommit(options.repoRoot),
        reportPath: options.report,
        repoRoot: options.repoRoot,
    });
    const next = applyBaselineCounts({ baseline, summary, sourceRun, collectedAt });
    const before = baseline?.counts ?? {};
    const countsSame =
        Number(before.expected) === next.counts.expected &&
        Number(before.skipped) === next.counts.skipped &&
        Number(before.failed) === next.counts.failed &&
        Number(before.flaky) === next.counts.flaky;
    if (countsSame && baseline?.sourceRun === sourceRun) {
        console.log(
            "[check-mock-baseline] 计数已是实际值：expected=" + summary.expected +
                " / skipped=" + summary.skipped + "（未写）",
        );
        return { baseline, changed: false };
    }
    const result = writeBaselineIfChanged(options.baseline, next);
    console.log(
        "[check-mock-baseline] MOCK_BASELINE_COUNTS_UPDATED（丙：只动计数，failed=0）" +
            (result.changed ? "" : "（字节相同，未写）"),
    );
    for (const field of ["expected", "skipped", "failed", "flaky"]) {
        const from = Number.isFinite(Number(before[field])) ? Number(before[field]) : "-";
        if (String(from) !== String(next.counts[field])) {
            console.log("  " + field + ": " + from + " → " + next.counts[field]);
        }
    }
    console.log("  sourceRun: " + sourceRun);
    return { baseline: next, changed: result.changed };
}

export function runWriteBaseline({ options, report, summary, baseline }) {
    // ② 守卫：failed !== 0 ⇒ 拒写 + 把失败清单摆出来（只说「failed=3」不给人可核对的对象）
    if (summary.failed !== 0) {
        console.error(
            "E_MOCK_BASELINE_WRITE_REFUSED: failed=" + summary.failed + " ≠ 0 ⇒ 拒绝写基线（模型丙：红永不被吸收）",
        );
        for (const item of summary.failedCases ?? []) {
            console.error("  failed: " + (item.file ?? "?") + " :: " + item.title);
        }
        console.error("  基线文件未改动：" + options.baseline);
        return 2;
    }
    const fingerprint = specFingerprint({ repoRoot: options.repoRoot, report });
    const collectedAt = reportCollectedAt(report, options.report);
    const sourceRun = buildSourceRunText({
        summary,
        fingerprint,
        collectedAt,
        head: headCommit(options.repoRoot),
        reportPath: options.report,
        repoRoot: options.repoRoot,
    });
    const before = baseline?.counts ?? {};
    const next = applyBaselineCounts({ baseline, summary, sourceRun, collectedAt });
    const result = writeBaselineIfChanged(options.baseline, next);
    console.log("[check-mock-baseline] --write-baseline（" + BASELINE_WRITE_MODEL + "）");
    for (const field of ["expected", "skipped", "failed", "flaky"]) {
        const from = Number.isFinite(Number(before[field])) ? Number(before[field]) : "-";
        console.log("  " + field + ": " + from + " → " + next.counts[field]);
    }
    console.log("  sourceRun: " + sourceRun);
    // skipNames 名单仍由人登记（丙只动计数）：差集只 WARN，不写、不判红
    const registered = new Set((baseline?.skipNames ?? []).map(normalizeTitle));
    const actual = new Set(summary.skipNames);
    const unregistered = [...actual].filter((name) => !registered.has(name));
    const retired = [...registered].filter((name) => !actual.has(name));
    if (unregistered.length > 0) {
        console.log("  WARN skip 名单未收录 " + unregistered.length + " 条（丙只动计数，名单仍手工登记）：");
        for (const name of unregistered.slice(0, 10)) console.log("    + " + name);
    }
    if (retired.length > 0) {
        console.log("  WARN skip 名单已不存在的 " + retired.length + " 条（同上，不自动删）：");
        for (const name of retired.slice(0, 10)) console.log("    - " + name);
    }
    console.log(result.changed ? "  已写入 " + options.baseline : "  字节相同 ⇒ 未写（幂等）");
    return 0;
}

/**
 * task-272 / D-1648②：子进程的**基础设施失败**（超时 / 启动错误 / 信号杀死）必须显式分类。
 * 只加 timeout 而不看 result.error/signal，会把「响亮挂起」变成「exit=null 恰好撞断言」的
 * 静默假绿族（D-1644②）——这里把失败原因写成明确错误码，selftest 逐例强制红。
 * 返回 null = 子进程正常跑完（退出码可能非 0，那由用例断言判，不属于基础设施失败）。
 * 与 scripts/run-with-timeout.mjs 的分类口径一致（ETIMEDOUT / error / status===null）。
 */
export function classifyChildFailure(result, timeoutMs) {
    if (result?.error) {
        if (result.error.code === "ETIMEDOUT") {
            return (
                "E_SELFTEST_CHILD_TIMEOUT: child exceeded " + timeoutMs +
                "ms and was killed（超时是失败上界，不是等待；test-timeout-budget.md §1.1）"
            );
        }
        return "E_SELFTEST_CHILD_SPAWN: failed to start child: " + result.error.message;
    }
    if (result?.status === null || result?.status === undefined) {
        return "E_SELFTEST_CHILD_KILLED: child terminated by signal " + (result?.signal ?? "unknown") + " without an exit code";
    }
    return null;
}

function runSelftest() {
    selftestCases = [];
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mock-baseline-selftest-"));
    const self = fileURLToPath(import.meta.url);
    const baseReport = (flakyTitles, flakyFile, stats) => ({
        suites: [
            {
                file: flakyFile,
                specs: flakyTitles.map((title) => ({
                    title,
                    tests: [
                        {
                            status: "flaky",
                            expectedStatus: "passed",
                            results: [{ status: "timedOut" }, { status: "passed" }],
                        },
                    ],
                })),
                suites: [
                    {
                        file: "e2e/mock/other.spec.ts",
                        specs: [
                            {
                                title: "registered skip A",
                                tests: [
                                    {
                                        status: "skipped",
                                        expectedStatus: "skipped",
                                        results: [{ status: "skipped" }],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        ],
        stats,
    });
    const run = (name, { report, baseline, extra = [], history = null }) => {
        const dir = fs.mkdtempSync(path.join(tmpRoot, "case-"));
        const reportFile = path.join(dir, "report.json");
        const baselineFile = path.join(dir, "baseline.json");
        const historyFile = path.join(dir, "history.json");
        fs.writeFileSync(reportFile, JSON.stringify(report));
        fs.writeFileSync(baselineFile, JSON.stringify(baseline));
        if (history) fs.writeFileSync(historyFile, JSON.stringify(history));
        // task-272：显式 timeout（§1.2 默认 10s，实测单 child ~450ms）。Windows 注意：
        // spawnSync 的 timeout 杀的是子进程本身而非整棵子树（run-with-timeout.mjs 同款限制）——
        // 子门自己的 git/pwsh 调用也都有 timeout，故孤儿进程有界；挂住夹具本身不起孙进程。
        const result = spawnSync(
            process.execPath,
            [
                self,
                "--report",
                reportFile,
                "--baseline",
                baselineFile,
                "--flaky-history",
                historyFile,
                "--no-probe-procs",
                ...extra,
            ],
            { encoding: "utf8", timeout: SELFTEST_CHILD_TIMEOUT_MS },
        );
        const childFailure = classifyChildFailure(result, SELFTEST_CHILD_TIMEOUT_MS);
        let output = (result.stdout ?? "") + (result.stderr ?? "");
        if (childFailure) output += "\n[selftest] " + childFailure + "\n";
        selftestCases.push({ name, exit: result.status, output, childFailure });
        return { exit: result.status, output, baselineFile, reportFile };
    };
    const cleanBaseline = {
        counts: { expected: 283, skipped: 1, failed: 0, flaky: 0 },
        skipNames: ["registered skip A"],
    };
    const flakyStats = { expected: 283, skipped: 1, unexpected: 0, flaky: 1 };
    try {
        // ① 改动面内 flaky ⇒ 必须红（exit 1）
        const inside = run("① 改动面内 flaky ⇒ exit 1", {
            report: baseReport(["flaky case A"], "e2e/mock/chat.spec.ts", flakyStats),
            baseline: cleanBaseline,
            extra: ["--changed-specs", "e2e/mock/chat.spec.ts"],
        });
        assertCase(inside.exit === 1 && /E_MOCK_FLAKY_IN_CHANGED_SPEC/.test(inside.output), "①");
        // ② 阴性对照：同一份报告移出改动面 ⇒ 必须 WARN + exit 0
        const outside = run("② 移出改动面 ⇒ WARN + exit 0", {
            report: baseReport(["flaky case A"], "e2e/mock/chat.spec.ts", flakyStats),
            baseline: cleanBaseline,
            extra: ["--changed-specs", "e2e/mock/unrelated.spec.ts"],
        });
        assertCase(
            outside.exit === 0 &&
                /MOCK_FLAKY_OUTSIDE_CHANGED_SPEC/.test(outside.output) &&
                /flaky case A/.test(outside.output) &&
                /head=/.test(outside.output) &&
                /procs=/.test(outside.output) &&
                // task-225：环境性 flaky 要给线索（并发共用产物目录），否则读到 WARN 的人不知道去查哪里。
                /可能原因/.test(outside.output) &&
                /XIHE_MOCK_OUTPUT_DIR/.test(outside.output),
            "②",
        );
        // ③ 基线 flaky 非 0 ⇒ 必须被门主动拒收（exit 2）
        const badBaseline = run("③ 基线 flaky=2 ⇒ exit 2", {
            report: baseReport([], "e2e/mock/chat.spec.ts", {
                expected: 284,
                skipped: 1,
                unexpected: 0,
                flaky: 0,
            }),
            baseline: {
                counts: { expected: 283, skipped: 1, failed: 0, flaky: 2 },
                skipNames: ["registered skip A"],
            },
        });
        assertCase(
            badBaseline.exit === 2 && /E_MOCK_BASELINE_FLAKY_NONZERO/.test(badBaseline.output),
            "③",
        );
        // ④ 连续 3 轮 ⇒ 升级（exit 1）
        const persistent = run("④ 连续 3 轮 ⇒ exit 1", {
            report: baseReport(["flaky case A"], "e2e/mock/chat.spec.ts", flakyStats),
            baseline: cleanBaseline,
            extra: ["--changed-specs", "e2e/mock/unrelated.spec.ts"],
            history: [
                { at: "2026-11-13T00:00:00.000Z", head: "aaa", flaky: ["flaky case A"] },
                { at: "2026-11-13T01:00:00.000Z", head: "bbb", flaky: ["flaky case A"] },
            ],
        });
        assertCase(persistent.exit === 1 && /E_MOCK_FLAKY_PERSISTENT/.test(persistent.output), "④");
        // ⑤ 模型丙（task-250）：计数漂移不再判红，而是**就地跟随实际收集数**
        const drift = run("⑤ 计数漂移 ⇒ 自动跟随 + exit 0（丙）", {
            report: baseReport([], "e2e/mock/chat.spec.ts", {
                expected: 280,
                skipped: 1,
                unexpected: 0,
                flaky: 0,
            }),
            baseline: cleanBaseline,
        });
        const driftBaseline = JSON.parse(fs.readFileSync(drift.baselineFile, "utf8"));
        assertCase(
            drift.exit === 0 &&
                /MOCK_BASELINE_COUNTS_UPDATED/.test(drift.output) &&
                driftBaseline.counts.expected === 280 &&
                /expected: 283 → 280/.test(drift.output),
            "⑤",
        );
        // ⑤' 阴性对照：同一份漂移但 failed≠0 ⇒ 自动跟随被拒（文件不动）+ 仍按 drift 红
        // 这条是丙的边界：**计数可以跟，红不可以**。
        const redReport = baseReport([], "e2e/mock/chat.spec.ts", {
            expected: 280,
            skipped: 1,
            unexpected: 1,
            flaky: 0,
        });
        redReport.suites[0].specs.unshift({
            title: "red case",
            tests: [{ status: "unexpected", expectedStatus: "passed", results: [{ status: "failed" }] }],
        });
        const driftRed = run("⑤' 漂移 + failed≠0 ⇒ 拒跟随且红", {
            report: redReport,
            baseline: cleanBaseline,
        });
        const driftRedBaseline = JSON.parse(fs.readFileSync(driftRed.baselineFile, "utf8"));
        assertCase(
            driftRed.exit === 1 &&
                /E_MOCK_BASELINE_DRIFT/.test(driftRed.output) &&
                /计数自动跟随\*\*跳过\*\*/.test(driftRed.output) &&
                driftRedBaseline.counts.expected === 283,
            "⑤'",
        );
        // ⑥ 回归保护：子集报告仍被拒收
        const subsetDir = fs.mkdtempSync(path.join(tmpRoot, "case-"));
        const subsetReport = path.join(subsetDir, "report.subset.json");
        const subsetBaseline = path.join(subsetDir, "baseline.json");
        fs.writeFileSync(
            subsetReport,
            JSON.stringify(
                baseReport([], "e2e/mock/chat.spec.ts", {
                    expected: 5,
                    skipped: 1,
                    unexpected: 0,
                    flaky: 0,
                }),
            ),
        );
        fs.writeFileSync(subsetBaseline, JSON.stringify(cleanBaseline));
        const subset = spawnSync(
            process.execPath,
            [self, "--report", subsetReport, "--baseline", subsetBaseline, "--no-probe-procs"],
            { encoding: "utf8", timeout: SELFTEST_CHILD_TIMEOUT_MS },
        );
        const subsetFailure = classifyChildFailure(subset, SELFTEST_CHILD_TIMEOUT_MS);
        let subsetOutput = (subset.stdout ?? "") + (subset.stderr ?? "");
        if (subsetFailure) subsetOutput += "\n[selftest] " + subsetFailure + "\n";
        selftestCases.push({
            name: "⑥ 子集报告 ⇒ exit 2",
            exit: subset.status,
            output: subsetOutput,
            childFailure: subsetFailure,
        });
        assertCase(subset.status === 2 && /E_MOCK_REPORT_SCOPE/.test(subsetOutput), "⑥");
        // ⑦ task-211：counts 与 sourceRun 不一致且**没有** $countsDerivation ⇒ 必须红（exit 1，点名两处数字）
        const inconsistent = run("⑦ 标尺内部矛盾（--no-write-baseline）⇒ exit 1", {
            report: baseReport([], "e2e/mock/chat.spec.ts", {
                expected: 283,
                skipped: 1,
                unexpected: 0,
                flaky: 0,
            }),
            // task-250：这三条钉的是「关掉计数自动跟随」时的硬红语义（丙默认会把它重写掉）。
            extra: ["--no-write-baseline"],
            baseline: {
                ...cleanBaseline,
                sourceRun: "task-174：expected 281 / skipped 1 / failed 0 / flaky 0",
            },
        });
        assertCase(
            inconsistent.exit === 1 &&
                /E_MOCK_BASELINE_SELF_INCONSISTENT/.test(inconsistent.output) &&
                /counts\.expected=283/.test(inconsistent.output) &&
                /sourceRun 写 expected=281/.test(inconsistent.output),
            "⑦",
        );
        // ⑧ 同一份数字，但带 $countsDerivation ⇒ WARN 并引用它，放行（exit 0）
        const derived = run("⑧ 有 $countsDerivation（--no-write-baseline）⇒ WARN + exit 0", {
            report: baseReport([], "e2e/mock/chat.spec.ts", {
                expected: 283,
                skipped: 1,
                unexpected: 0,
                flaky: 0,
            }),
            extra: ["--no-write-baseline"],
            baseline: {
                ...cleanBaseline,
                sourceRun: "task-174：expected 281 / skipped 1 / failed 0 / flaky 0",
                $countsDerivation:
                    "[推导] 示例：281 → 283 = 本批新增 2 条（单 spec 全绿，全量未跑）",
            },
        });
        assertCase(
            derived.exit === 0 &&
                /MOCK_BASELINE_COUNTS_DERIVED/.test(derived.output) &&
                /281 → 283/.test(derived.output),
            "⑧",
        );
        // ⑨ 阴性对照：两处一致 ⇒ 不得出现任何一致性告警
        const consistent = run("⑨ 两处一致 ⇒ 明确「自洽轴通过」+ exit 0", {
            report: baseReport([], "e2e/mock/chat.spec.ts", {
                expected: 283,
                skipped: 1,
                unexpected: 0,
                flaky: 0,
            }),
            baseline: {
                ...cleanBaseline,
                sourceRun: "task-174：expected 283 / skipped 1 / failed 0 / flaky 0",
            },
        });
        assertCase(
            consistent.exit === 0 &&
                /MOCK_BASELINE_COUNTS_CONSISTENT/.test(consistent.output) &&
                /自洽轴通过/.test(consistent.output) &&
                !/自洽轴未评估/.test(consistent.output) &&
                !/SELF_INCONSISTENT/.test(consistent.output) &&
                !/MOCK_BASELINE_COUNTS_DERIVED/.test(consistent.output) &&
                // task-225 阴性对照：没有 flaky 就**不许**出现「可能原因」那行（提示只在有 flaky 时打印）。
                !/可能原因/.test(consistent.output),
            "⑨",
        );
        // ⑩ 历史夹具没有 sourceRun ⇒ 只 WARN「无法交叉核对」，不得红
        const noSource = run("⑩ 无 sourceRun（--no-write-baseline）⇒ WARN + exit 0", {
            report: baseReport([], "e2e/mock/chat.spec.ts", {
                expected: 283,
                skipped: 1,
                unexpected: 0,
                flaky: 0,
            }),
            extra: ["--no-write-baseline"],
            baseline: cleanBaseline,
        });
        // Lead 2026-11-15：日志里「没判」与「判了且一致」必须是两句不同的话 ——
        // ⑨ 与 ⑩ 互为阴性对照：⑨ 必含「自洽轴通过」且不含「未评估」，⑩ 反之。
        assertCase(
            noSource.exit === 0 &&
                /MOCK_BASELINE_COUNTS_NOT_EVALUATED/.test(noSource.output) &&
                /自洽轴未评估/.test(noSource.output) &&
                !/自洽轴通过/.test(noSource.output),
            "⑩",
        );
        // ---------------- task-250（模型丙）：写基线的四个判据（负例 / 正例 / 幂等 / 纠错） ----------------
        // 用**同一个目录**连续跑，才能断言「文件字节变没变」；--allow-stale-report 只隔离队友在途的 spec 噪声，
        // 写路径真正要守的是「failed=0 才写」与「字节相同才不写」。
        const writeDir = fs.mkdtempSync(path.join(tmpRoot, "write-"));
        const writeReport = path.join(writeDir, "report.json");
        const writeBaseline = path.join(writeDir, "baseline.json");
        const writeHistory = path.join(writeDir, "history.json");
        const writeCase = (name, exit, output, ok, childFailure = null) => {
            // task-272 / D-1648：与 assertCase 同口径——基础设施失败恒红。
            selftestCases.push({ name, exit, output, ok: Boolean(ok) && !childFailure, childFailure });
        };
        const runWrite = (flags = ["--write-baseline"]) => {
            const result = spawnSync(
                process.execPath,
                [
                    self,
                    "--report",
                    writeReport,
                    "--baseline",
                    writeBaseline,
                    "--flaky-history",
                    writeHistory,
                    "--no-probe-procs",
                    "--allow-stale-report",
                    ...flags,
                ],
                { encoding: "utf8", timeout: SELFTEST_CHILD_TIMEOUT_MS },
            );
            const childFailure = classifyChildFailure(result, SELFTEST_CHILD_TIMEOUT_MS);
            let output = (result.stdout ?? "") + (result.stderr ?? "");
            if (childFailure) output += "\n[selftest] " + childFailure + "\n";
            return { status: result.status, output, childFailure };
        };
        const writeReportJson = (stats, specs) => {
            fs.writeFileSync(
                writeReport,
                JSON.stringify({
                    suites: [{ file: "e2e/mock/chat.spec.ts", specs, suites: [] }],
                    stats,
                }),
            );
        };
        const readBaselineFile = () => fs.readFileSync(writeBaseline, "utf8");
        const seedBaseline = () => {
            fs.writeFileSync(
                writeBaseline,
                JSON.stringify({
                    counts: { expected: 283, skipped: 1, failed: 0, flaky: 0 },
                    skipNames: ["registered skip A"],
                }),
            );
        };

        // ⑪ 负例：failed≠0 ⇒ 拒写 + 点名 failed 清单 + **文件字节不变**
        seedBaseline();
        const refusedBefore = readBaselineFile();
        writeReportJson(
            { expected: 300, skipped: 2, unexpected: 2, flaky: 0 },
            [
                {
                    title: "red case A",
                    tests: [{ status: "unexpected", expectedStatus: "passed", results: [{ status: "failed" }] }],
                },
                {
                    title: "red case B",
                    tests: [{ status: "unexpected", expectedStatus: "passed", results: [{ status: "failed" }] }],
                },
                {
                    title: "registered skip A",
                    tests: [{ status: "skipped", expectedStatus: "skipped", results: [{ status: "skipped" }] }],
                },
            ],
        );
        const refused = runWrite();
        const refusedOut = refused.output;
        writeCase(
            "⑪ failed≠0 ⇒ 拒写 + 列 failed 清单 + 文件不变",
            refused.status,
            refusedOut,
            refused.status === 2 &&
                /E_MOCK_BASELINE_WRITE_REFUSED/.test(refusedOut) &&
                /red case A/.test(refusedOut) &&
                /red case B/.test(refusedOut) &&
                readBaselineFile() === refusedBefore,
            refused.childFailure,
        );

        // ⑫ 正例：failed=0 ⇒ 计数跟随实际收集数，sourceRun 可回溯
        seedBaseline();
        writeReportJson(
            { expected: 300, skipped: 2, unexpected: 0, flaky: 0 },
            [
                {
                    title: "registered skip A",
                    tests: [{ status: "skipped", expectedStatus: "skipped", results: [{ status: "skipped" }] }],
                },
            ],
        );
        const written = runWrite();
        const writtenOut = written.output;
        const afterFirst = JSON.parse(readBaselineFile());
        writeCase(
            "⑫ failed=0 ⇒ 写计数 + sourceRun 带命令/时刻/HEAD/sha256/收集数",
            written.status,
            writtenOut,
            written.status === 0 &&
                afterFirst.counts.expected === 300 &&
                afterFirst.counts.skipped === 2 &&
                afterFirst.counts.failed === 0 &&
                afterFirst.counts.flaky === 0 &&
                /命令 mise run test:mock/.test(afterFirst.sourceRun) &&
                /HEAD [0-9a-f]{7,}/.test(afterFirst.sourceRun) &&
                /specs sha256 [0-9a-f]{16}/.test(afterFirst.sourceRun) &&
                /expected=300/.test(afterFirst.sourceRun) &&
                /skipped=2/.test(afterFirst.sourceRun),
            written.childFailure,
        );

        // ⑬ 幂等：同一跑次连写两次 ⇒ 字节相同（第二次必须说「字节相同」）
        const firstBytes = readBaselineFile();
        const again = runWrite();
        const againOut = again.output;
        writeCase(
            "⑬ 同跑次连写两次 ⇒ 字节相同",
            again.status,
            againOut,
            again.status === 0 && /字节相同/.test(againOut) && readBaselineFile() === firstBytes,
            again.childFailure,
        );

        // ⑭ 纠错：手改 expected=9999（failed 仍为 0）⇒ 下次运行纠正回实际值，且字节复原
        const tampered = JSON.parse(firstBytes);
        tampered.counts.expected = 9999;
        fs.writeFileSync(writeBaseline, JSON.stringify(tampered, null, 4) + "\n");
        const corrected = runWrite([]);
        const correctedOut = corrected.output;
        const afterCorrect = JSON.parse(readBaselineFile());
        writeCase(
            "⑭ 手改 expected=9999 ⇒ 下次运行纠正回实际值",
            corrected.status,
            correctedOut,
            corrected.status === 0 &&
                afterCorrect.counts.expected === 300 &&
                /9999 → 300/.test(correctedOut) &&
                readBaselineFile() === firstBytes,
            corrected.childFailure,
        );
        // ⑮ 默认模式（不加任何旗标）下 failed≠0 ⇒ 文件一个字节都不动，且明说「跳过」
        const beforeFifteen = readBaselineFile();
        writeReportJson(
            { expected: 300, skipped: 2, unexpected: 1, flaky: 0 },
            [
                {
                    title: "red case C",
                    tests: [{ status: "unexpected", expectedStatus: "passed", results: [{ status: "failed" }] }],
                },
            ],
        );
        const plainRed = runWrite([]);
        const plainRedOut = plainRed.output;
        writeCase(
            "⑮ 默认模式 failed≠0 ⇒ 不写 + 明说跳过 + 文件不变",
            plainRed.status,
            plainRedOut,
            plainRed.status === 1 &&
                /计数自动跟随\*\*跳过\*\*/.test(plainRedOut) &&
                readBaselineFile() === beforeFifteen,
            plainRed.childFailure,
        );

    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
    const failed = selftestCases.filter((item) => !item.ok);
    for (const item of selftestCases) {
        const mark = item.ok ? "PASS" : "FAIL";
        console.log(`[selftest] ${mark} ${item.name} (exit=${item.exit})`);
    }
    if (failed.length > 0) {
        for (const item of failed)
            console.error(`[selftest] output of ${item.name}:\n${item.output}`);
        console.error(`[selftest] ${failed.length} case(s) failed`);
        return 1;
    }
    console.log(`[selftest] OK: ${selftestCases.length} case(s)`);
    return 0;
}

function assertCase(condition, label) {
    const item = selftestCases.pop();
    // task-272 / D-1648：子进程基础设施失败（超时/启动错误/被杀）⇒ 恒红，
    // 不允许被「断言恰好成立」盖过去（只强化，不放松）。
    item.ok = Boolean(condition) && !item.childFailure;
    selftestCases.push(item);
    if (!item.ok) console.error(`[selftest] FAIL ${label}: ${item.name}`);
}
function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(`[check-mock-baseline] ${error.message}`);
        return 2;
    }
    if (options.selftest) return runSelftest();
    let report;
    let baseline;
    try {
        report = readJson(options.report, "report");
        baseline = readJson(options.baseline, "baseline");
    } catch (error) {
        console.error(`[check-mock-baseline] ${error.message}`);
        return 2;
    }
    const summary = summarizeReport(report);
    // task-179 判据 ③（基线不变量）：基线 flaky 必须恒为 0，门**主动拒收**非零基线 ——
    // 否则前三条判据都能被「改基线消红」绕过去。这是输入不合格（exit 2），不是 drift。
    const baselineFlaky = Math.trunc(Number(baseline?.counts?.flaky ?? 0));
    if (baselineFlaky !== 0) {
        console.error(
            `E_MOCK_BASELINE_FLAKY_NONZERO: baseline ${options.baseline} declares counts.flaky=${baselineFlaky}`,
        );
        console.error(
            "  基线 flaky 恒为 0（task-179 判据 ③）：偶发不能被写成永久许可；" +
                "若某轮确有 flaky，让它走「改动面交集 / 可见性 / 连续 3 轮升级」三条判据，" +
                "而不是把数字抄进基线。",
        );
        return 2;
    }
    // 50% 启发式的分母来自基线计数 —— 标尺自身矛盾（counts 与 sourceRun 对不上）时那个数
    // 根本不可信（实测：把 expected 手改成 9999 后，一份 302 条的合法报告被当成子集拒掉，exit 2）。
    // 所以：文件名那道门恒生效；分母只在标尺自洽时才用。
    const countsTrustworthy = inspectBaselineCounts(baseline, options.baseline).status !== "error";
    const baselineForScope = options.writeBaseline || !countsTrustworthy ? { counts: { expected: 0, skipped: 0 } } : baseline;
    const subsetProblem = options.report.endsWith(".subset.json")
        ? `子集报告不能用来算基线：${options.report}`
        : rejectSubsetReport(options.report, summary, baselineForScope);
    if (subsetProblem) {
        console.error(`E_MOCK_REPORT_SCOPE: ${subsetProblem}`);
        console.error(
            "  run the full lane (`mise run test:mock`) and re-check; " +
                "subset runs write .mock-report.subset.json (task-48)",
        );
        return 2;
    }
    const staleness = detectStaleReport({ repoRoot: options.repoRoot, reportPath: options.report });
    if (staleness.culprits.length > 0) {
        const lines = [
            `报告 mtime=${iso(staleness.reportMtimeSec)}；mock spec 最新 mtime=${iso(staleness.newest?.mtimeSec ?? staleness.reportMtimeSec)}（${staleness.newest?.file ?? "n/a"}）`,
            `一级（mtime）可疑 ${staleness.suspicious.length} 条；二级（定性）判红 ${staleness.culprits.length} 条：`,
        ];
        for (const culprit of staleness.culprits) {
            lines.push(
                `stale: ${culprit.file}（spec mtime=${iso(culprit.mtimeSec)}）— ${culprit.reason}`,
            );
        }
        if (options.allowStaleReport) {
            console.log(
                `[check-mock-baseline] stale report accepted (--allow-stale-report): ${staleness.culprits.length} item(s)`,
            );
            for (const line of lines) console.log(`  ${line}`);
        } else {
            console.error(
                `E_STALE_REPORT: ${staleness.culprits.length} spec(s) newer than the report (${options.report})`,
            );
            for (const line of lines) console.error(`  ${line}`);
            console.error(
                "  re-run the full lane (`mise run test:mock`) and re-check; --allow-stale-report accepts deliberately",
            );
            return 2;
        }
    } else if (staleness.suspicious.length > 0) {
        console.log(
            `[check-mock-baseline] ${staleness.suspicious.length} spec(s) newer by mtime but clean and committed before the report ⇒ checkout mtime artifacts (not red)`,
        );
    }
    // task-250（模型丙）：写基线走独立出口 —— 输入合格性（子集/陈旧/flaky 基线）已经在上面判完了，
    // 这里只负责「跟随计数」与「failed=0 才写」，不再走 drift 比对。
    if (options.writeBaseline) return runWriteBaseline({ options, report, summary, baseline });

    // 丙的默认行为：failed=0 ⇒ 计数就地跟随实际收集数（--no-write-baseline 可退出该行为）。
    let effectiveBaseline = baseline;
    if (!options.noWriteBaseline) {
        effectiveBaseline = maybeAutoUpdateCounts({ options, report, summary, baseline }).baseline;
    }

    // task-250：自洽轴（task-211）挪到「计数自动跟随」之后 —— 丙的判据是「计数永远跟实际值」，
    // 所以「counts 与 sourceRun 不一致」在 failed=0 时会被这次运行当场重写掉，不该再当硬红；
    // 只有 --no-write-baseline（或 failed≠0 不写）时，它才回到原来的硬红语义。
    // task-211：标尺自洽（counts.expected ↔ sourceRun 文本）。
    // 红/黄/绿三态见 `inspectBaselineCounts`：无 derivation 的不一致必须红，有 derivation 才 WARN 放行。
    const baselineConsistency = inspectBaselineCounts(effectiveBaseline, options.baseline);
    if (baselineConsistency.status === "error" && !options.writeBaseline) {
        for (const line of baselineConsistency.lines) console.error(line);
        return 1;
    }
    // ok 态也要打印（`MOCK_BASELINE_COUNTS_CONSISTENT: 自洽轴通过`）——静默会被读成「没判」。
    for (const line of baselineConsistency.lines) console.log(line);
    // task-250：写基线的模式下，**不能用基线的计数**去判「这是不是子集跑」——
    // 模型丙的前提正是「基线数字可能落后几百条」，拿它当分母会把一份全量报告判成子集
    // （实测：把 expected 手改成 9999 后，一份 302 条的合法报告被 50% 启发式拒掉）。
    // 写模式只保留与计数无关的那道：文件名是 .subset.json 就不是全量跑。
    const { problems } = compareWithBaseline(summary, effectiveBaseline);
    const line =
        `[check-mock-baseline] expected=${summary.expected} skipped=${summary.skipped} ` +
        `failed=${summary.failed} flaky=${summary.flaky} skips=${summary.skipNames.length}`;
    console.log(line);

    // ---- task-179：flaky 四条正交判据（精确比对里已经没有 flaky 了）----
    const procs = options.noProbeProcs ? null : probeProcessCounts();
    const env = {
        ...treeFingerprint(options.repoRoot),
        port: process.env.XIHE_UI_PORT ?? null,
        workers: options.workers ?? null,
        procs,
    };
    const changedSpecs = options.changedSpecs
        ? {
              specs: options.changedSpecs,
              dirty: options.changedSpecs,
              sinceBaseline: [],
              baselineCommit: "--changed-specs(cli override)",
              gitAvailable: true,
          }
        : resolveChangedSpecs({ repoRoot: options.repoRoot, baselinePath: options.baseline });
    let history = [];
    try {
        const parsed = JSON.parse(fs.readFileSync(options.flakyHistory, "utf8"));
        if (Array.isArray(parsed)) history = parsed;
    } catch {
        history = [];
    }
    const policy = evaluateFlakyPolicy({
        flakyCases: summary.flakyCases,
        changedSpecs,
        history,
        env,
    });
    // 报告指纹：同一份报告复查不重复计轮（见 appendFlakyHistory 的幂等说明）。
    policy.entry.report = {
        mtimeMs: Math.trunc(fs.statSync(options.report).mtimeMs),
        expected: summary.expected,
        skipped: summary.skipped,
        flaky: summary.flaky,
    };
    if (!options.noFlakyHistory) appendFlakyHistory(options.flakyHistory, policy.entry);
    for (const warning of policy.warnings) console.log(warning);
    for (const error of policy.errors) {
        console.error(`${error.code}:`);
        for (const detail of error.lines) console.error(`  ${detail}`);
    }

    if (problems.length > 0) {
        if (options.allowDrift) {
            console.log(
                `[check-mock-baseline] drift accepted (--allow-drift): ${problems.length} item(s)`,
            );
            for (const problem of problems) console.log(`  drift: ${problem}`);
            return policy.errors.length > 0 ? 1 : 0;
        }
        console.error(
            `E_MOCK_BASELINE_DRIFT: ${problems.length} difference(s) vs ${options.baseline}`,
        );
        for (const problem of problems) console.error(`  drift: ${problem}`);
        console.error(
            `  update e2e/mock-baseline.json only after triage; use --allow-drift to accept deliberately`,
        );
        return 1;
    }
    if (policy.errors.length > 0) return 1;
    console.log("[check-mock-baseline] OK");
    return 0;
}

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
    process.exit(main());
}
