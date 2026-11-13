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
 *        [--allow-drift] [--allow-stale-report]
 * Exit 0 = match; 1 = drift; 2 = missing/unparsable inputs, or a stale report (`E_STALE_REPORT`).
 *
 * D-1039 ②（2026-11-12）: a report *file* turns this gate blind — comparing against a report
 * generated before the specs it claims to cover reports "no drift" for tests nobody ran.
 * Two-tier criterion (the naive "report mtime < newest spec mtime" alone red-lights 8 pure
 * checkout-mtime artifacts, measured 2026-11-12): the naive layer only marks "suspicious";
 * only a spec that is untracked/dirty, or whose last commit is NEWER than the report, is red.
 * `git log -1 --format=%ct` is the evidence — never the file mtime (checkout rewrites it).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

export function summarizeReport(report) {
    const stats = report?.stats ?? {};
    const expected = Math.trunc(Number(stats.expected ?? 0));
    const failed = Math.trunc(Number(stats.unexpected ?? 0));
    const flaky = Math.trunc(Number(stats.flaky ?? 0));
    const skipped = Math.trunc(Number(stats.skipped ?? 0));
    const skipNames = [];
    const flakyCases = [];
    const walk = (suite) => {
        const file = typeof suite?.file === "string" ? normalizePath(suite.file) : null;
        for (const spec of suite?.specs ?? []) {
            // task-179: flaky 必须连**文件名**一起拿出来 —— 判据 ① 判的是
            // 「本轮 flaky 用例 ∩ 本轮改到的 spec 文件」，只留标题无法落地。
            const tests = spec?.tests ?? [];
            if (tests.some((test) => test?.status === "flaky")) {
                flakyCases.push({ title: normalizeTitle(spec?.title), file });
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
    return { expected, failed, flaky, skipped, skipNames, flakyCases };
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
        }).trim();
    try {
        const raw = execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
            cwd: repoRoot,
            encoding: "utf8",
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
        } catch {
            // 基线未入库 / 无历史 ⇒ 只剩工作树来源，`baselineCommit` 留 null，WARN 里点名。
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
                { encoding: "utf8", timeout: 20000 },
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
        }).trim();
        const porcelain = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
            cwd: repoRoot,
            encoding: "utf8",
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
                changedSpecs?.gitAvailable === false ? "unavailable(① 退化为只认工作树)" : "ok",
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
            { encoding: "utf8" },
        );
        const output = (result.stdout ?? "") + (result.stderr ?? "");
        selftestCases.push({ name, exit: result.status, output });
        return { exit: result.status, output };
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
                /procs=/.test(outside.output),
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
        // ⑤ 回归保护：expected/skipped 精确比对没被削弱
        const drift = run("⑤ expected 漂移 ⇒ exit 1", {
            report: baseReport([], "e2e/mock/chat.spec.ts", {
                expected: 280,
                skipped: 1,
                unexpected: 0,
                flaky: 0,
            }),
            baseline: cleanBaseline,
        });
        assertCase(drift.exit === 1 && /E_MOCK_BASELINE_DRIFT/.test(drift.output), "⑤");
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
            { encoding: "utf8" },
        );
        const subsetOutput = (subset.stdout ?? "") + (subset.stderr ?? "");
        selftestCases.push({
            name: "⑥ 子集报告 ⇒ exit 2",
            exit: subset.status,
            output: subsetOutput,
        });
        assertCase(subset.status === 2 && /E_MOCK_REPORT_SCOPE/.test(subsetOutput), "⑥");
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
    item.ok = Boolean(condition);
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
    const subsetProblem = rejectSubsetReport(options.report, summary, baseline);
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
    const { problems } = compareWithBaseline(summary, baseline);
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
