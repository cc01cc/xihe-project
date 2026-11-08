#!/usr/bin/env node
/**
 * lane-sync-hot.mjs — develop 前进后「lane 同步 + 热更新判定」一条命令（卡 task-256）
 *
 * 口径锚点 = one 私有层 `internal/A03-xihe/docs/dev-hot-loop.md` §11（:135-141，2026-11-08 固化）：
 *   ① lane 不会自动同步：develop 合并后 lane 只 `behind=N`；必须在 lane worktree 里
 *      `git merge develop`（**禁 reset/rebase**；冲突即停报 Lead）。
 *   ② 热更新取决于「栈跑哪个 checkout」：`dev-stack --cwd <lane>` 起的栈才看得到 lane 源码。
 *   ③ 变更分类决定恢复路径：仅 `.java` ≤4 ⇒ `dev-hot-cp --javac`（实测 1.9–2.4 s + devtools
 *      重启 7.2–11.8 s ≈ 8 s）；混合/资源 ⇒ mvn 模块增量 8.8–16.4 s；含 `pom.xml` / 依赖 /
 *      `db/migration` / `application*.properties` ⇒ **必须 dev-stack stop/start**（per-sha 新构建根 2–3 min）。
 *   ④ 验证边界：窗口 / 候选树 / 证据栈（stack-1）作者禁写 ⇒ 本脚本**不碰证据栈**。
 *
 * 本脚本只做「判定 + 执行 + 计时」，**不复制 §11 的口径实现**：编译交给
 * `scripts/dev-hot-cp.mjs`（javac 单文件 / mvn 模块增量），重启由 devtools 自己完成；
 * 重启日志只做**就绪探针**（显式 timeout + 轮询，不裸 sleep；见 `internal/A03-xihe/docs/test-timeout-budget.md`）。
 *
 * 硬边界（全部在动 index/ref 之前判定）：
 *   - **主检出零写入**：只接受 linked worktree（`--git-dir` ≠ `--git-common-dir`）；主检出直接
 *     `E_PRIMARY_CHECKOUT` 退出。只读主检出 HEAD 做前后对比，作为「未写入」证据。
 *   - 不 push、不 reset、不 rebase、不 checkout --、不 clean；冲突**不自动 abort**（§11-1 冲突即停报 Lead），
 *     只打印 `git merge --abort` 恢复命令。
 *   - 不自己 start 栈：lane 的栈没在跑（无 lease / 端口不在听）⇒ 合并照做、hot 步骤显式跳过并以
 *     exit 3 退出（**不执行** `dev-stack start`）。
 *   - 窗口期（`xh-window list --json` 的 `active` > 0）⇒ `E_WINDOW_ACTIVE` 拒绝（dry-run 也拒）。
 *   - `stack-1` 是证据栈 ⇒ 拒绝（dev 循环用 stack-2；证据栈热编请直接用 dev-hot-cp 的显式声明开关）。
 *
 * 用法 / 参数 / 判据 / 退出码的**唯一来源**是下方 `HELP`（`--help` 打印的就是它）。
 * stdout 是分段中文日志 + 末行 `[lane-sync] summary {...}`（JSON，供自动化/测试断言）。
 *
 * 为什么 --dry-run 默认 true（卡面把选择权留给实现，按安全性定）：
 *   两步都是不可静默撤销的（`git merge` 写 lane；热编写正在跑栈的 classes），默认「执行」意味着
 *   一次手滑就动了别人 lane 的状态 ⇒ 默认只读计划 + 显式 `--apply` 才执行（同 xh-commit「先证明再动 ref」）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { cpBuildRoot, readPointer } from "./lib/cp-build-dir.mjs";
import { leasePath, readStackLease } from "./lib/stack-lease.mjs";
import { deriveStack } from "./lib/stack-ports.mjs";

/** 脚本所在 lane 的根（lane 里 scripts/ 的上一级；测试用 --repo 覆盖） */
const SCRIPT_ROOT = dirname(import.meta.dirname);

export const EXIT = Object.freeze({ OK: 0, REFUSE: 1, USAGE: 2, FOLLOWUP: 3 });

/** devtools 重启实测 7.2–11.8 s（dev-hot-loop §4/§10）⇒ 默认 30 s；上限 120 s（boot 档上限，不设分钟级） */
export const DEFAULT_TIMEOUT_S = 30;
export const MAX_TIMEOUT_S = 120;

export const HELP = [
  "lane-sync-hot.mjs — develop 前进后「lane 同步 + 热更新」一条命令（task-256）",
  "",
  "用法：",
  "  node scripts/lane-sync-hot.mjs [--lane <槽位> | --repo <dir>] [--stack <N>] [--dry-run | --apply]",
  "                                 [--merge] [--no-hot] [--range <A..B>] [--timeout <秒>]",
  "                                 [--trigger-file <名字>] [--window-script <路径>]",
  "  node scripts/lane-sync-hot.mjs --help",
  "",
  "参数：",
  "  --lane <槽位>      池表槽位名（如 m3-a13）；按祖先目录的 .worktrees/<槽位> 解析（不解析池表文档）。",
  "                     省略时 = 本脚本所在 lane（scriptRoot）；解析不到 ⇒ E_LANE_UNRESOLVED",
  "  --repo <dir>       显式 lane 路径（必须是 linked worktree）；给定时优先于 --lane（测试/专用）",
  "  --stack <N>        目标栈（默认 2 = dev 栈；1..8）。stack-1 是证据栈 ⇒ 拒绝（E_EVIDENCE_STACK）",
  "  --dry-run          只打印门禁/分类/分段计划，不合并、不编译（默认值；与 --apply 互斥）",
  "  --apply            关闭 dry-run：真的执行。与 --dry-run 同时给 ⇒ E_USAGE",
  "  --merge            允许步骤② git merge develop（不写 reset/rebase）。--apply 且无 --range 时必须给；",
  "                     dry-run 下表示「计划里包含合并」",
  "  --no-hot           只同步（合并），跳过编译/热更新（无栈演练或只想拿 merge 用）",
  "  --range <A..B>     显式热更新区间（跳过 merge）；用于「已合并但想重刷某段改动」",
  "  --timeout <秒>     等 devtools 重启日志的上限（默认 30；env XIHE_LANE_SYNC_RESTART_TIMEOUT_S；",
  "                     上限 120；超上限截断并 WARN —— 不设分钟级，见 test-timeout-budget.md）",
  "  --trigger-file <.reloadtrigger>",
  "                     转发给 dev-hot-cp：栈用 trigger 模式时必须传（classpath 内纯文件名）",
  "  --window-script <路径>",
  "                     窗口台账脚本覆盖（默认向上找 internal/A03-xihe/scripts/xh-window.mjs）",
  "  --help, -h         打印本帮助后 exit 0",
  "",
  "执行顺序（判据全部在动 ref 之前）：",
  "  ⓪ 校验：lane 存在 / top-level 匹配 / 是 linked worktree（主检出拒绝）/ 分支非 detached /",
  "     窗口台账 active=0 / git status --porcelain -uall 干净 / develop 存在",
  "  ① 干净校验失败 ⇒ E_DIRTY（打印脏文件；ref 不动）",
  "  ② git merge --no-edit develop（仅 --apply --merge 且未给 --range；冲突 ⇒ E_MERGE_CONFLICT，",
  "     不自动 abort，打印 git merge --abort 恢复命令交 Lead）",
  "  ③ 分类（merge base..develop 或 before..after 的实际 diff）：pom / db-migration /",
  "     application*.properties ⇒ restart；CP 仅 java ≤4 ⇒ javac；java>4 / 删除的 java / CP 资源 ⇒ mvn；",
  "     runtime / agent / ui / docs 记为 followup（不自动动它们的进程）",
  "  ④ 执行：javac ⇒ dev-hot-cp --once --javac --git-range <range>（失败自动回退 mvn 并 WARN）；",
  "     mvn ⇒ dev-hot-cp --once；restart ⇒ 只打印 dev-stack stop/start（stop/start 归 Lead/栈 owner）",
  "  ⑤ 等 devtools 重启：轮询 lane 的 CP 日志新增行，命中 Restart complete / Started ... in ... 即完成；",
  "     超时 ⇒ WARN + exit 3（不裸 sleep）",
  "  ⑥ 输出墙钟分段（merge / 编译 / 重启 / 总）与退出码；并读主检出 HEAD 前后对比作为「零写入」证据",
  "",
  "退出码：0 成功（含 dry-run 计划通过）；1 拒绝（ref 未动）；2 用法错误；",
  "        3 已合并但还需人工动作（起栈 / dev-stack restart / runtime·agent 重启 / 重启日志超时）",
  "",
  "错误码：E_USAGE / E_LANE_UNRESOLVED / E_LANE_MISSING / E_LANE_TOPLEVEL / E_PRIMARY_CHECKOUT /",
  "        E_DETACHED / E_WINDOW_ACTIVE / E_WINDOW_UNKNOWN / E_DIRTY / E_DEVELOP_MISSING /",
  "        E_EVIDENCE_STACK / E_MERGE_CONFLICT / E_STACK_FOREIGN / E_STACK_TRANSITION /",
  "        E_STACK_POINTER / E_STACK_DOWN / E_COMPILE_FAILED / E_TOOL_MISSING / E_GIT / E_GIT_SPAWN / E_UNEXPECTED",
].join("\n");

/** 守卫拒绝/用法错误的统一载体（code 用于测试与报告定位） */
export class Refuse extends Error {
  constructor(code, message, extra = {}, { usage = false } = {}) {
    super(message);
    this.name = "Refuse";
    this.code = code;
    this.extra = extra;
    this.usage = usage;
  }
}

/** git status --porcelain -uall → [{status, path}]（含 ?? 未跟踪；不解析引号路径，够判定） */
export function parsePorcelain(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2).trim() || line.slice(0, 1);
    const path = line.slice(3).trim();
    if (path) out.push({ status, path });
  }
  return out;
}

/**
 * git diff --name-status（新行格式或 -z NUL 格式）→ [{status, path}]。
 * rename/copy 拆成「旧路径删除 + 新路径新增」两个条目（分类器只需这两个事实）。
 */
export function parseNameStatus(text) {
  const raw = String(text ?? "");
  if (!raw.trim()) return [];
  const changes = [];
  if (raw.includes("\u0000")) {
    const parts = raw.split("\u0000");
    for (let i = 0; i < parts.length; ) {
      const token = parts[i];
      if (!token) {
        i += 1;
        continue;
      }
      const status = token[0];
      if ((status === "R" || status === "C") && parts[i + 1] !== undefined && parts[i + 2] !== undefined) {
        changes.push({ status: "D", path: parts[i + 1] });
        changes.push({ status: "A", path: parts[i + 2] });
        i += 3;
      } else {
        if (parts[i + 1] !== undefined) changes.push({ status, path: parts[i + 1] });
        i += 2;
      }
    }
    return changes;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    if (fields.length === 2) changes.push({ status: fields[0][0], path: fields[1] });
    else if (fields.length >= 3) {
      changes.push({ status: "D", path: fields[1] });
      changes.push({ status: "A", path: fields[2] });
    }
  }
  return changes;
}

const basename = (p) => p.split("/").pop() ?? "";
const CP = "packages/control-plane/";
const CP_MAIN_JAVA = "packages/control-plane/src/main/java/";
const CP_MAIN_RES = "packages/control-plane/src/main/resources/";
const CONFIG_RE = /^application(?:-[A-Za-z0-9_-]+)?\.(?:properties|yml|yaml)$/i;

/** 单个路径 → 分类桶（桶名即 §11③ 的判据词汇：pom / migration / config / java / …） */
export function bucketOf(path) {
  const p = String(path).split("\\").join("/");
  if (basename(p) === "pom.xml") return "pom";
  if (p.includes("db/migration/")) return "migration";
  if (CONFIG_RE.test(basename(p))) return "config";
  if (p.startsWith(CP_MAIN_JAVA) && p.endsWith(".java")) return "cp-java";
  if (p.startsWith(CP_MAIN_RES)) return "cp-resource";
  if (p.startsWith(CP)) return "cp-test";
  if (p.startsWith("packages/runtime/")) return "runtime";
  if (p.startsWith("packages/agent/")) return "agent";
  if (p.startsWith("packages/ui/")) return "ui";
  if (p.startsWith("docs/") || p.endsWith(".md") || p.startsWith("scripts/")) return "docs";
  if (p === "mise.toml" || p.startsWith("config/") || p.startsWith(".github/")) return "tooling";
  return "other";
}

/**
 * 变更分类（纯函数，单测主面）。
 * cpAction：none | javac | mvn | restart（优先级与理由见 HELP ③ / dev-hot-loop §11③）。
 */
export function classifyChanges(changes) {
  const bucketNames = ["pom", "migration", "config", "cp-java", "cp-resource", "cp-test", "runtime", "agent", "ui", "docs", "tooling", "other"];
  const buckets = new Map(bucketNames.map((name) => [name, []]));
  const files = [];
  for (const change of changes ?? []) {
    if (!change || !change.path) continue;
    const path = String(change.path).split("\\").join("/");
    const status = String(change.status ?? "M")[0];
    const bucket = bucketOf(path);
    const entry = { status, path, bucket };
    files.push(entry);
    buckets.get(bucket).push(entry);
  }
  const counts = {};
  for (const [name, list] of buckets) counts[name] = list.length;

  const cpJava = buckets.get("cp-java");
  const cpJavaChanged = cpJava.filter((entry) => entry.status !== "D");
  const cpResource = buckets.get("cp-resource");
  const reasons = [];
  let cpAction = "none";
  if (counts.pom > 0 || counts.migration > 0 || counts.config > 0) {
    cpAction = "restart";
    if (counts.pom > 0) reasons.push("pom.xml " + counts.pom + " 个（依赖/插件变更）⇒ 必须 dev-stack stop/start（per-sha 新构建根，2–3 min）");
    if (counts.migration > 0) reasons.push("db/migration " + counts.migration + " 个 ⇒ 必须 dev-stack stop/start（新构建根 + 迁移）");
    if (counts.config > 0) reasons.push("application 配置 " + counts.config + " 个 ⇒ 必须 dev-stack stop/start（启动期读配置）");
  } else if (cpJava.some((entry) => entry.status === "D")) {
    cpAction = "mvn";
    reasons.push("有删除的 .java ⇒ javac 单文件模式不处理删除，走 mvn 整模块增量");
  } else if (cpJavaChanged.length > 4) {
    cpAction = "mvn";
    reasons.push("CP java 变更 " + cpJavaChanged.length + " 个 > 4 ⇒ §11③ 走 mvn 模块增量（8.8–16.4 s）");
  } else if (cpResource.length > 0) {
    cpAction = "mvn";
    reasons.push("CP 资源变更 " + cpResource.length + " 个 ⇒ javac 不处理资源，走 mvn");
  } else if (cpJavaChanged.length > 0) {
    cpAction = "javac";
    reasons.push("仅 java " + cpJavaChanged.length + " 个（≤4）⇒ javac 单文件（实测 1.9–2.4 s）+ devtools 重启（7.2–11.8 s）");
  } else if (counts["cp-test"] > 0) {
    reasons.push("CP 测试文件 " + counts["cp-test"] + " 个 ⇒ 不进 main classes，无需热编（测试按需自行跑）");
  }

  const followups = [];
  if (counts.runtime > 0) followups.push({ kind: "runtime", count: counts.runtime, action: "cargo 增量编译 + 换进程（runtime 无进程内热更）" });
  if (counts.agent > 0) followups.push({ kind: "agent", count: counts.agent, action: "Agent 无代码热载（main.py reload=False）⇒ 需重启 agent 子进程" });
  if (counts.ui > 0) followups.push({ kind: "ui", count: counts.ui, action: "UI 由 Vite HMR 自行生效（不重建、不重启栈）" });
  if (counts.docs > 0 || counts.tooling > 0) followups.push({ kind: "docs", count: counts.docs + counts.tooling, action: "文档/工具配置变更，无运行时动作" });
  if (counts.other > 0) followups.push({ kind: "other", count: counts.other, action: "未归类路径（人工确认）" });

  return {
    changes: files.length,
    files,
    buckets: counts,
    cpAction,
    reasons,
    followups,
    javacFiles: cpJavaChanged.map((entry) => entry.path),
  };
}

/** 分段计划（纯函数，单测主面）：只产出「要跑什么 / 要人做什么」，不执行 */
export function buildHotPlan({ classification, stack, laneAbs, range, triggerFile = null }) {
  const steps = [];
  const manual = [];
  const hotDir = join(laneAbs, "scripts");
  const triggerArgs = triggerFile ? ["--trigger-file", triggerFile] : [];
  if (classification.cpAction === "javac") {
    steps.push({
      kind: "hot",
      mode: "javac",
      label: "javac 单文件增量（dev-hot-cp --javac --git-range）",
      argv: [join(hotDir, "dev-hot-cp.mjs"), "--stack", String(stack), "--once", "--javac", "--git-range", range, ...triggerArgs],
    });
  } else if (classification.cpAction === "mvn") {
    steps.push({
      kind: "hot",
      mode: "mvn",
      label: "mvn 模块增量（dev-hot-cp --once）",
      argv: [join(hotDir, "dev-hot-cp.mjs"), "--stack", String(stack), "--once", ...triggerArgs],
    });
  } else if (classification.cpAction === "restart") {
    manual.push("node scripts/dev-stack.mjs stop --stack " + stack + " --json");
    manual.push("node scripts/dev-stack.mjs start --stack " + stack + " --json");
  }
  for (const followup of classification.followups) {
    if (followup.kind === "runtime") {
      manual.push("node scripts/dev-hot-runtime.mjs --stack " + stack + " --once");
      manual.push("（runtime 编译后按其输出的重启命令换进程；整栈 stop/start 归 Lead/栈 owner）");
    } else if (followup.kind === "agent") {
      manual.push("node scripts/dev-stack.mjs stop --stack " + stack + " --json && node scripts/dev-stack.mjs start --stack " + stack + " --json");
    }
  }
  return {
    steps,
    manual,
    waitRestart: classification.cpAction === "javac" || classification.cpAction === "mvn",
    needsManual: manual.length > 0,
  };
}

/** 解析 --lane 槽位：向上逐级找 <ancestor>/.worktrees/<槽位> 与 <ancestor>/A03-xihe/.worktrees/<槽位> */
export function resolveLaneBySlot(slot, starts = [SCRIPT_ROOT]) {
  if (!slot) return null;
  const dirs = [];
  for (const start of starts) {
    let dir = resolve(start);
    for (;;) {
      dirs.push(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const dir of dirs) {
    for (const rel of [".worktrees", join("A03-xihe", ".worktrees")]) {
      const candidate = join(dir, rel, slot);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** 参数解析（只认白名单；未知参数即用法错误 exit 2） */
export function parseArgs(argv) {
  const envTimeout = Number(process.env.XIHE_LANE_SYNC_RESTART_TIMEOUT_S ?? DEFAULT_TIMEOUT_S);
  const args = {
    lane: null,
    repo: null,
    stack: 2,
    dryRun: true,
    apply: false,
    merge: false,
    noHot: false,
    range: null,
    timeoutS: Number.isFinite(envTimeout) ? envTimeout : DEFAULT_TIMEOUT_S,
    triggerFile: null,
    windowScript: null,
    help: false,
  };
  const explicitDryRun = argv.includes("--dry-run");
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const need = () => {
      const value = argv[(i += 1)];
      if (value === undefined) throw new Refuse("E_USAGE", a + " 缺少取值", {}, { usage: true });
      return value;
    };
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--lane") args.lane = need();
    else if (a === "--repo") args.repo = need();
    else if (a === "--stack") args.stack = Number(need());
    else if (a.startsWith("--stack=")) args.stack = Number(a.slice("--stack=".length));
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--apply") args.apply = true;
    else if (a === "--no-dry-run") args.apply = true;
    else if (a === "--merge") args.merge = true;
    else if (a === "--no-hot") args.noHot = true;
    else if (a === "--range") args.range = need();
    else if (a === "--timeout") args.timeoutS = Number(need());
    else if (a === "--trigger-file") args.triggerFile = need();
    else if (a === "--window-script") args.windowScript = need();
    else throw new Refuse("E_USAGE", "未知参数: " + a, {}, { usage: true });
  }
  if (args.help) return args;
  if (args.apply && explicitDryRun) throw new Refuse("E_USAGE", "--dry-run 与 --apply 互斥", {}, { usage: true });
  if (args.apply) args.dryRun = false;
  if (!Number.isInteger(args.stack) || args.stack < 1 || args.stack > 8) {
    throw new Refuse("E_USAGE", "--stack 必须为 1..8（收到 " + args.stack + "）", {}, { usage: true });
  }
  if (!Number.isFinite(args.timeoutS) || args.timeoutS <= 0) {
    throw new Refuse("E_USAGE", "--timeout 必须为正数秒（收到 " + args.timeoutS + "）", {}, { usage: true });
  }
  args.timeoutClamped = Math.min(args.timeoutS, MAX_TIMEOUT_S);
  args.timeoutWarn = args.timeoutS > MAX_TIMEOUT_S;
  return args;
}

const norm = (p) => resolve(String(p)).replace(/\\/g, "/").toLowerCase();
const shortSha = (sha) => (sha ? String(sha).slice(0, 8) : null);

function runGit(repo, args, { allowFail = false } = {}) {
  const res = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new Refuse("E_GIT_SPAWN", "无法执行 git: " + res.error.message, { args });
  if (res.status !== 0) {
    if (allowFail) return { ok: false, status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
    throw new Refuse("E_GIT", "git " + args.join(" ") + " 失败（exit " + res.status + "）: " + String(res.stderr ?? "").trim(), { args, status: res.status });
  }
  return { ok: true, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}
const gitOut = (repo, args) => runGit(repo, args).stdout.toString().trim();
const gitTry = (repo, args) => {
  try {
    return { ok: true, out: gitOut(repo, args) };
  } catch (err) {
    return { ok: false, err };
  }
};

/** 校验 lane 是 linked worktree（主检出/普通仓拒绝）；返回主检出根（只读前后对比用） */
function inspectLane(repoAbs) {
  if (!existsSync(repoAbs)) throw new Refuse("E_LANE_MISSING", "lane 路径不存在: " + repoAbs);
  const inside = gitTry(repoAbs, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.out !== "true") throw new Refuse("E_LANE_MISSING", "不是 git 工作树: " + repoAbs);
  const topLevel = gitOut(repoAbs, ["rev-parse", "--show-toplevel"]);
  if (norm(topLevel) !== norm(repoAbs)) throw new Refuse("E_LANE_TOPLEVEL", "路径不是工作树顶层: " + repoAbs + "（实际 " + topLevel + "）");
  const gitDir = resolve(gitOut(repoAbs, ["rev-parse", "--path-format=absolute", "--git-dir"]));
  const commonDir = resolve(gitOut(repoAbs, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const linked = norm(gitDir) !== norm(commonDir) && norm(gitDir).startsWith(norm(commonDir) + "/");
  if (!linked) {
    throw new Refuse("E_PRIMARY_CHECKOUT", "拒绝在非 linked worktree 上执行（主检出零写入）: " + repoAbs + "；请在 lane 槽位里跑");
  }
  return { topLevel, gitDir, commonDir, mainRoot: dirname(commonDir) };
}

/** 窗口台账：active>0 ⇒ 拒绝；找不到脚本或输出不可判定 ⇒ fail-closed */
function checkWindow({ laneAbs, opts }) {
  const explicit = opts.windowScript ? resolve(opts.windowScript) : process.env.XH_WINDOW_SCRIPT ? resolve(process.env.XH_WINDOW_SCRIPT) : null;
  let scriptPath = explicit;
  if (!scriptPath) {
    for (const start of [laneAbs, SCRIPT_ROOT]) {
      let dir = resolve(start);
      for (;;) {
        for (const rel of [join("internal", "A03-xihe", "scripts", "xh-window.mjs"), join("scripts", "xh-window.mjs")]) {
          const candidate = join(dir, rel);
          if (existsSync(candidate)) {
            scriptPath = candidate;
            break;
          }
        }
        if (scriptPath) break;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      if (scriptPath) break;
    }
  }
  if (!scriptPath || !existsSync(scriptPath)) {
    throw new Refuse("E_WINDOW_UNKNOWN", "找不到窗口台账脚本（xh-window.mjs）⇒ fail-closed；可用 --window-script 指定");
  }
  const res = spawnSync(process.execPath, [scriptPath, "list", "--json"], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  let parsed = null;
  try {
    parsed = JSON.parse(String(res.stdout ?? "").trim());
  } catch {
    parsed = null;
  }
  if (res.status !== 0 || !Array.isArray(parsed?.active) || !Array.isArray(parsed?.history)) {
    throw new Refuse("E_WINDOW_UNKNOWN", "窗口台账输出不可判定（exit " + res.status + "）: " + String(res.stderr ?? res.stdout ?? "").trim().slice(0, 300));
  }
  const active = parsed.active.map((w) => ({ id: w.id, lane: w.lane, sha: w.sha ?? w.sha8 ?? null, ports: w.ports ?? null, status: w.status }));
  return { script: scriptPath, active, activeCount: active.length };
}

function portListening(port, timeoutMs) {
  return new Promise((resolvePort) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePort(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
  });
}

/** lane 的栈是否在跑：lease 存在 + projectRoot 是本 lane + CP 端口在听（不自己 start） */
async function probeStack({ laneAbs, stack }) {
  const stackId = "stack-" + stack;
  const derived = deriveStack(stackId);
  const leaseFile = leasePath(laneAbs, stackId);
  // readStackLease 返回 {lease, corrupt}（永不抛）：lease=null + corrupt=false = 这个 lane 没起过栈
  const read = readStackLease(laneAbs, stackId);
  const lease = read?.lease ?? null;
  const result = { stackId, ports: derived.ports, leaseFile, lease: null, corrupt: Boolean(read?.corrupt), leaseOwnerOk: false, transition: false, cpListening: false };
  if (!lease) return result;
  result.lease = { projectRoot: lease.projectRoot ?? null, phase: lease.phase ?? "started", cpVersion: lease.cpVersion ?? null };
  result.leaseOwnerOk = norm(lease.projectRoot ?? "") === norm(laneAbs);
  result.transition = lease.phase === "starting" || lease.phase === "stopping";
  if (result.leaseOwnerOk && !result.transition) result.cpListening = await portListening(derived.ports.cp, 1500);
  return result;
}

/** 轮询 CP 日志新增行等 devtools 重启（显式 timeout + 200 ms 轮询；不裸 sleep） */
async function waitForRestart({ logPath, fromOffset, timeoutMs }) {
  const startedAt = Date.now();
  const markers = /^(.*(?:Restart complete|Started [A-Za-z0-9_$]+ in [0-9.]+ seconds?).*)$/;
  for (;;) {
    if (existsSync(logPath)) {
      try {
        const text = readFileSync(logPath, "utf8");
        const tail = text.slice(Math.max(0, fromOffset));
        const hit = tail.split(/\r?\n/).find((line) => markers.test(line));
        if (hit) return { ok: true, waitedMs: Date.now() - startedAt, line: hit.trim() };
      } catch (err) {
        return { ok: false, waitedMs: Date.now() - startedAt, reason: "读不到 CP 日志: " + err.message, logPath };
      }
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) return { ok: false, waitedMs: elapsed, reason: timeoutMs + " ms 内没看到重启完成行（devtools 可能未触发）", logPath };
    await delay(200);
  }
}

function readHead(repo) {
  try {
    return gitOut(repo, ["rev-parse", "HEAD"]);
  } catch {
    return null;
  }
}

/** 主流程：全部分支都在「动 ref 之前」判定；任何 Refuse 都不会留下半成品 */
async function run(argv) {
  const log = (line) => process.stdout.write("[lane-sync] " + line + "\n");
  const startedAt = Date.now();
  const timings = { mergeMs: 0, compileMs: 0, restartMs: 0, totalMs: 0 };
  const summary = {
    ok: false,
    code: EXIT.REFUSE,
    lane: null,
    branch: null,
    stack: 2,
    dryRun: true,
    merge: false,
    gates: {},
    classification: null,
    plan: null,
    followups: [],
    timings,
    notes: [],
  };
  const finish = (code) => {
    timings.totalMs = Date.now() - startedAt;
    summary.ok = code === EXIT.OK;
    summary.code = code;
    log("timings: merge=" + (timings.mergeMs / 1000).toFixed(2) + "s compile=" + (timings.compileMs / 1000).toFixed(2) + "s restart=" + (timings.restartMs / 1000).toFixed(2) + "s total=" + (timings.totalMs / 1000).toFixed(2) + "s");
    log("summary " + JSON.stringify(summary));
    return code;
  };

  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      process.stdout.write(HELP + "\n");
      return EXIT.OK;
    }
    summary.stack = opts.stack;
    summary.dryRun = opts.dryRun;
    if (opts.timeoutWarn) log("WARN: --timeout " + opts.timeoutS + "s 超过上限 " + MAX_TIMEOUT_S + "s，按 " + MAX_TIMEOUT_S + "s 执行（test-timeout-budget §2）");
    if (opts.stack === 1) throw new Refuse("E_EVIDENCE_STACK", "stack-1 是证据栈（真栈/L2 证据从它取）；dev 循环用 --stack 2。证据栈热编请直接用 dev-hot-cp 的显式声明开关");

    // ── ⓪ 校验（全部只读） ──────────────────────────────────────────────
    let laneAbs = opts.repo ? resolve(opts.repo) : null;
    let laneSlot = opts.lane ?? null;
    let laneSource = "explicit --repo";
    if (!laneAbs) {
      const resolved = opts.lane ? resolveLaneBySlot(opts.lane, [SCRIPT_ROOT, process.cwd()]) : null;
      if (resolved) {
        laneAbs = resolved;
        laneSource = "slot " + opts.lane;
      } else if (!opts.lane) {
        laneAbs = SCRIPT_ROOT;
        laneSlot = basename(laneAbs);
        laneSource = "scriptRoot（省略 --lane）";
      } else {
        throw new Refuse("E_LANE_UNRESOLVED", "解析不到槽位 " + opts.lane + "（按祖先目录的 .worktrees/<槽位> 找）；请用 --repo 显式给路径");
      }
    }
    laneSlot = laneSlot ?? basename(laneAbs);
    const repoInfo = inspectLane(laneAbs);
    summary.lane = laneSlot;
    log("lane=" + laneSlot + " path=" + laneAbs + " source=" + laneSource);
    const mainHeadBefore = repoInfo.mainRoot ? readHead(repoInfo.mainRoot) : null;
    if (repoInfo.mainRoot) log("main-checkout=" + repoInfo.mainRoot + " HEAD=" + (shortSha(mainHeadBefore) ?? "(unknown)") + "（只读，未写入）");

    const window = checkWindow({ laneAbs, opts });
    summary.gates.window = { activeCount: window.activeCount, active: window.active, script: window.script };
    if (window.activeCount > 0) {
      throw new Refuse("E_WINDOW_ACTIVE", "窗口台账 active=" + window.activeCount + " ⇒ 拒绝执行（窗口期/证据栈作者禁写）: " + JSON.stringify(window.active));
    }
    log("window: active=0（" + window.script + "）");

    const branch = gitTry(laneAbs, ["symbolic-ref", "--short", "-q", "HEAD"]);
    if (!branch.ok || !branch.out) throw new Refuse("E_DETACHED", "lane 处于 detached HEAD（合并没有分支可落；先 git switch -c task/<topic>）");
    summary.branch = branch.out;
    log("branch=" + branch.out);

    const dirty = parsePorcelain(gitOut(laneAbs, ["status", "--porcelain", "-uall"]));
    summary.gates.clean = dirty.length === 0;
    if (dirty.length > 0) {
      throw new Refuse("E_DIRTY", "lane 工作树不干净（" + dirty.length + " 条），先提交/清理再同步", { dirty: dirty.slice(0, 50) });
    }
    log("clean: ok（status --porcelain -uall 空）");

    const develop = gitTry(laneAbs, ["rev-parse", "--verify", "develop^{commit}"]);
    if (!develop.ok) throw new Refuse("E_DEVELOP_MISSING", "develop ref 不存在: " + develop.err.message);
    const headSha = gitOut(laneAbs, ["rev-parse", "HEAD"]);
    const behind = Number(gitOut(laneAbs, ["rev-list", "--count", "HEAD..develop"]));
    const ahead = Number(gitOut(laneAbs, ["rev-list", "--count", "develop..HEAD"]));
    log("HEAD=" + shortSha(headSha) + " develop=" + shortSha(develop.out) + " behind=" + behind + " ahead=" + ahead);

    // ── 计划（dry-run 也走这里：分类来自 HEAD...develop 的 incoming diff） ──
    const planRange = opts.range ?? headSha + "..." + "develop";
    const plannedChanges = parseNameStatus(gitOut(laneAbs, ["diff", "--name-status", "-z", planRange]));
    const plannedClassification = classifyChanges(plannedChanges);
    summary.classification = plannedClassification;
    log("classification(incoming): changes=" + plannedClassification.changes + " cp=" + plannedClassification.cpAction + (plannedClassification.reasons.length ? " | " + plannedClassification.reasons.join("；") : ""));
    if (plannedClassification.followups.length) log("followups: " + plannedClassification.followups.map((f) => f.kind + "×" + f.count).join(" "));

    const stackProbe = await probeStack({ laneAbs, stack: opts.stack });
    summary.gates.stack = {
      stackId: stackProbe.stackId,
      lease: stackProbe.lease,
      leaseOwnerOk: stackProbe.leaseOwnerOk,
      transition: stackProbe.transition,
      cpListening: stackProbe.cpListening,
      leaseFile: stackProbe.leaseFile,
    };
    const stackReady = Boolean(stackProbe.lease && stackProbe.leaseOwnerOk && !stackProbe.transition && stackProbe.cpListening);
    log("stack: " + stackProbe.stackId + " running=" + stackReady
      + (stackProbe.lease ? " lease=" + stackProbe.leaseFile + " owner=" + (stackProbe.leaseOwnerOk ? "lane" : "FOREIGN×") : stackProbe.corrupt ? " lease=corrupt（" + stackProbe.leaseFile + " 形状不可用）" : " lease=(none)")
      + " cpPort=" + stackProbe.ports.cp + (stackProbe.cpListening ? " listening" : " not-listening"));
    if (stackProbe.lease && !stackProbe.leaseOwnerOk) {
      throw new Refuse("E_STACK_FOREIGN", "lease.projectRoot=" + stackProbe.lease.projectRoot + " ≠ lane " + laneAbs + "（栈属于别的 checkout，拒绝热编）", { lease: stackProbe.lease });
    }
    if (stackProbe.transition) throw new Refuse("E_STACK_TRANSITION", "栈正在 starting/stopping（phase=" + stackProbe.lease.phase + "），等就绪再同步");

    const plannedPlan = buildHotPlan({ classification: plannedClassification, stack: opts.stack, laneAbs, range: planRange, triggerFile: opts.triggerFile });
    summary.plan = { steps: plannedPlan.steps.map((s) => ({ mode: s.mode, label: s.label })), manual: plannedPlan.manual, waitRestart: plannedPlan.waitRestart };
    log("plan: " + (plannedPlan.steps.length ? plannedPlan.steps.map((s) => s.label).join(" → ") : "无热编步骤") + (plannedPlan.manual.length ? " | 需人工: " + plannedPlan.manual.join(" ; ") : ""));

    if (opts.dryRun) {
      const predicted = plannedClassification.cpAction === "restart" || !stackReady ? EXIT.FOLLOWUP : EXIT.OK;
      log("dry-run: 未合并、未编译（--apply 才执行）；预计退出码=" + predicted + (stackReady ? "" : "（hot 前置未满足：lane 的栈没在跑，--apply 会合并后跳过 hot）"));
      return finish(EXIT.OK);
    }

    // ── ② 合并 ─────────────────────────────────────────────────────────
    if (!opts.merge && !opts.range) throw new Refuse("E_USAGE", "--apply 需要 --merge（或 --range 指定热更新区间）", {}, { usage: true });
    let range = opts.range;
    if (!range) {
      const before = gitOut(laneAbs, ["rev-parse", "HEAD"]);
      const t0 = Date.now();
      const merged = runGit(laneAbs, ["merge", "--no-edit", "develop"], { allowFail: true });
      timings.mergeMs = Date.now() - t0;
      if (!merged.ok) {
        const conflicts = String(merged.stdout + merged.stderr).split(/\r?\n/).filter(Boolean).slice(0, 20).join(" | ");
        throw new Refuse("E_MERGE_CONFLICT", "git merge develop 冲突 ⇒ 停（未自动 abort，§11-1 冲突即停报 Lead）：" + conflicts, { lane: laneAbs, recovery: "git -C " + laneAbs + " merge --abort" });
      }
      const after = gitOut(laneAbs, ["rev-parse", "HEAD"]);
      summary.merge = { before, after, changed: before !== after };
      if (before === after) log("merge: already up to date（develop=" + shortSha(develop.out) + "，无新提交）");
      else log("merge: " + shortSha(before) + " → " + shortSha(after) + "（merge commit 已创建）");
      range = before + ".." + after;
    } else {
      log("merge: skipped（--range " + range + "）");
    }
    summary.mergeRange = range;

    // ── ③ 分类（实际 diff） ───────────────────────────────────────────
    const actualChanges = parseNameStatus(gitOut(laneAbs, ["diff", "--name-status", "-z", range]));
    const classification = classifyChanges(actualChanges);
    summary.classification = classification;
    log("classification(actual): changes=" + classification.changes + " cp=" + classification.cpAction + (classification.reasons.length ? " | " + classification.reasons.join("；") : ""));
    if (classification.followups.length) log("followups: " + classification.followups.map((f) => f.kind + "×" + f.count).join(" "));

    const plan = buildHotPlan({ classification, stack: opts.stack, laneAbs, range, triggerFile: opts.triggerFile });
    summary.plan = { steps: plan.steps.map((s) => ({ mode: s.mode, label: s.label })), manual: plan.manual, waitRestart: plan.waitRestart };

    const mainAfterMerge = repoInfo.mainRoot ? readHead(repoInfo.mainRoot) : null;
    if (repoInfo.mainRoot) {
      summary.gates.mainCheckout = { path: repoInfo.mainRoot, headBefore: mainHeadBefore, headAfter: mainAfterMerge, unchanged: mainHeadBefore === mainAfterMerge };
      log("main-checkout 复核: " + (mainHeadBefore === mainAfterMerge ? "HEAD 前后一致 " + shortSha(mainHeadBefore) + "（零写入）" : "WARN: HEAD 变了 " + shortSha(mainHeadBefore) + " → " + shortSha(mainAfterMerge)));
    }

    if (opts.noHot) {
      log("hot: skipped（--no-hot）");
      if (plan.manual.length) log("manual: " + plan.manual.join(" ; "));
      return finish(classification.cpAction === "restart" || plan.manual.some((line) => line.includes("dev-stack") || line.includes("dev-hot-runtime")) ? EXIT.FOLLOWUP : EXIT.OK);
    }

    if (classification.cpAction === "none" && plan.steps.length === 0) {
      log("hot: 无 CP 变更，无需编译");
      if (plan.manual.length) log("manual: " + plan.manual.join(" ; "));
      const needsManual = plan.manual.some((line) => line.includes("dev-stack") || line.includes("dev-hot-runtime"));
      return finish(needsManual ? EXIT.FOLLOWUP : EXIT.OK);
    }

    if (!stackReady) {
      log("hot: 跳过 —— lane 的 " + stackProbe.stackId + " 没在跑（" + (stackProbe.lease ? "CP 端口不在听" : "无 lease: " + stackProbe.leaseFile) + "）；本脚本不自己 start 栈");
      if (plan.manual.length) log("manual: " + plan.manual.join(" ; "));
      return finish(EXIT.FOLLOWUP);
    }

    const pointer = readPointer({ root: cpBuildRoot({ env: process.env }), stackId: stackProbe.stackId });
    summary.gates.stackPointer = { targetDir: pointer?.targetDir ?? null };
    if (!pointer?.targetDir || !existsSync(pointer.targetDir)) {
      throw new Refuse("E_STACK_POINTER", "找不到 " + stackProbe.stackId + " 的 .current 指针或目标目录（targetDir=" + (pointer?.targetDir ?? "(none)") + "）⇒ 无法定位 classes");
    }
    log("hot target: " + pointer.targetDir + "（发起 compile 前的日志 offset 会随后记录）");

    const cpLogPath = join(laneAbs, deriveStack(stackProbe.stackId).logDir, "cp.out.log");
    const logOffset = existsSync(cpLogPath) ? statSync(cpLogPath).size : 0;

    // ── ④ 执行热编 ─────────────────────────────────────────────────────
    let hotMode = null;
    const runStep = (step) => {
      const t0 = Date.now();
      log("run: node " + step.argv[0] + " " + step.argv.slice(1).join(" "));
      const res = spawnSync(process.execPath, step.argv, { cwd: laneAbs, stdio: "inherit", windowsHide: true, env: process.env });
      timings.compileMs += Date.now() - t0;
      return res.status === 0;
    };
    for (const step of plan.steps) {
      if (!existsSync(step.argv[0])) throw new Refuse("E_TOOL_MISSING", "找不到 " + step.argv[0] + "（lane 里没有 dev-hot-cp.mjs？）");
      const ok = runStep(step);
      if (ok) {
        hotMode = step.mode;
        continue;
      }
      if (step.mode === "javac") {
        log("WARN: javac 单文件失败 ⇒ 自动回退 mvn（dev-hot-cp --once）并重试");
        const fallback = { argv: [join(laneAbs, "scripts", "dev-hot-cp.mjs"), "--stack", String(opts.stack), "--once", ...(opts.triggerFile ? ["--trigger-file", opts.triggerFile] : [])] };
        if (!runStep(fallback)) throw new Refuse("E_COMPILE_FAILED", "javac 与 mvn 回退都失败（见上方 dev-hot-cp 输出）");
        hotMode = "mvn";
        continue;
      }
      throw new Refuse("E_COMPILE_FAILED", "热编命令失败（见上方 dev-hot-cp 输出）");
    }
    if (!hotMode) log("hot: 无 CP 变更，未编译");

    // ── ⑤ 等 devtools 重启日志 ────────────────────────────────────────
    let restart = null;
    if (plan.waitRestart && hotMode) {
      log("wait-restart: 轮询 " + cpLogPath + "（≤" + opts.timeoutClamped + "s，offset=" + logOffset + "）");
      restart = await waitForRestart({ logPath: cpLogPath, fromOffset: logOffset, timeoutMs: opts.timeoutClamped * 1000 });
      timings.restartMs = restart.waitedMs;
      summary.restart = { ok: restart.ok, waitedMs: restart.waitedMs, line: restart.line ?? null, reason: restart.reason ?? null };
      if (restart.ok) log("restart: ok（" + restart.waitedMs + " ms）：" + restart.line);
      else log("restart: WARN " + restart.reason + "（日志: " + cpLogPath + "；见 dev-hot-loop §5 坑②）");
    } else {
      log("restart: 等日志跳过（无编译或无重启预期）");
    }

    if (plan.manual.length) log("manual: " + plan.manual.join(" ; "));
    const needsManual = plan.manual.some((line) => line.includes("dev-stack") || line.includes("dev-hot-runtime"));
    if (!restart) return finish(needsManual ? EXIT.FOLLOWUP : EXIT.OK);
    if (!restart.ok) return finish(EXIT.FOLLOWUP);
    return finish(needsManual ? EXIT.FOLLOWUP : EXIT.OK);
  } catch (err) {
    const refuse = err instanceof Refuse ? err : new Refuse("E_UNEXPECTED", err && err.message ? err.message : String(err));
    log("REFUSE " + refuse.code + ": " + refuse.message);
    if (refuse.extra && Object.keys(refuse.extra).length > 0) log("extra " + JSON.stringify(refuse.extra));
    const code = refuse.usage ? EXIT.USAGE : EXIT.REFUSE;
    return finish(code);
  }
}

function mainEntry(argv) {
  return run(argv).then((code) => {
    process.exit(code);
  });
}

const isEntry = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(resolve(fileURLToPath(import.meta.url))).href;
if (isEntry) mainEntry(process.argv.slice(2));

export { run };
