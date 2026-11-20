#!/usr/bin/env node
/**
 * check-gate-registry.mjs — 门的注册制（task-104 / D-1843 / task-103 台账）
 *
 * 一句话：文档面与门脚本面必须先登记，才允许存在；新目录出现而未登记 ⇒ W。
 *
 * 为什么需要：scripts/check-md-tables.mjs:83 的 DEFAULT_ROOTS = ["AGENTS.md","internal","docs","tools","plans"]
 * 是硬编码五根 —— 新目录（例：A03-xihe/spec）天然无门。判据的「存放位置」与「执行位置」脱钩，
 * 靠人记得改常量的制度不可持续（task-103 台账 §4：审计器自己也只扫每仓 scripts/，internal/ 21 个门型脚本从未入账）。
 *
 * 本门做三件事，全部 report-only：
 *   ① 语料面：发现的「应受门约束的目录」与登记面做双向差集（未登记 ⇒ W；登记了但不在 ⇒ W；登记了但无门 ⇒ W）；
 *   ② 门脚本目录：workspace scripts/、每仓 scripts/、每仓 packages 下各包 scripts/、internal 下每仓 scripts/，未登记 ⇒ W；
 *   ③ 同名任务：跨仓 mise 任务同名（后者覆盖前者）⇒ W；登记面 miseTasks.allow 可确认（降为 ACK，不进硬 W）。
 *
 * 硬边界（卡面 task-104）：report-only；不得 import 进 validate；不改任何既有门的判据；接 mise 前先问 LEAD。
 *
 * 退出码：0 = 无硬 W（或纯 report）；1 = 有硬 W 且显式 --enforce；2 = ERROR（登记面缺失/不可解析，fail-closed）。
 *
 * 用法：
 *   node A03-xihe/scripts/check-gate-registry.mjs
 *   node A03-xihe/scripts/check-gate-registry.mjs --json
 *   node A03-xihe/scripts/check-gate-registry.mjs --enforce
 *   node A03-xihe/scripts/check-gate-registry.mjs --selftest
 *   node A03-xihe/scripts/check-gate-registry.mjs --root <dir> --registry <file>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");
export const WORKSPACE_ROOT = path.resolve(REPO_ROOT, "..");
export const DEFAULT_REGISTRY = path.join(HERE, "gate-registry.json");

/**
 * 门型脚本定义（task-103 台账 §1.2 的同一份定义；本文件不许再造第二套）。
 * 注意：scripts/audit-gate-executors.mjs:115 的 GATE_PREFIXES 只有 check/gate/verify/assert/ensure 五前缀
 * 加 2 个 EXTRA_GATES —— 那是审计器的门族允许表，不是本定义；两者差集正是 task-103 的「110 vs 74」。
 */
export const GATE_SCRIPT_PREFIXES = ["check", "test", "lint", "validate", "audit", "scan", "verify", "gate"];
export const GATE_SCRIPT_EXTRA = ["i18n-scan.mjs"];
const GATE_SCRIPT_RE = new RegExp("^(" + GATE_SCRIPT_PREFIXES.join("|") + ")[-.][\\w.-]*\\.(mjs|js|cjs|sh|ps1|py)$");
const TEST_FILE_RE = /[.](test|selftest)[.](mjs|js|cjs)$/;

export const isGateScriptName = (name) =>
  !TEST_FILE_RE.test(name) && (GATE_SCRIPT_EXTRA.includes(name) || GATE_SCRIPT_RE.test(name));

const DOC_DIRS_AT_WORKSPACE = ["docs", "internal", "plans", "tools"];
const DOC_DIRS_AT_REPO = ["docs", "spec", "plans"];
const SKIP_DIRS = new Set(["node_modules", "target", "dist", "build", ".xihe-stacks", "tmp", "logs", "test-results", "Temp", "coverage"]);
/** 非语料噪声：含空格/百分号/非 ASCII 的一级目录（%SystemDrive%、NVIDIA Corporation 之类宿主残留） */
const isJunkDirName = (name) => /[\s%]/.test(name) || /[^\x21-\x7E]/.test(name);

const readdirSafe = (p) => {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
};
const exists = (p) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};
const toPosix = (p) => p.split(path.sep).join("/");

/** git 仓 = 含 .git 的一级目录（.git 可为目录或 worktree 指针文件） */
export function discoverRepos(root) {
  return readdirSafe(root)
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
    .filter((e) => exists(path.join(root, e.name, ".git")))
    .map((e) => e.name)
    .sort();
}

/** 门脚本目录：workspace scripts/、每仓 scripts/、每仓各包 scripts/、internal 下每仓 scripts/ */
export function discoverGateScriptDirs(root, repos) {
  const out = [];
  const add = (rel) => {
    const files = readdirSafe(path.join(root, rel)).filter((e) => e.isFile() && isGateScriptName(e.name)).map((e) => e.name);
    if (files.length > 0) out.push({ root: toPosix(rel), kind: "gate-scripts", files: files.sort() });
  };
  add("scripts");
  for (const repo of repos) {
    add(repo + "/scripts");
    for (const pkg of readdirSafe(path.join(root, repo, "packages"))) if (pkg.isDirectory()) add(repo + "/packages/" + pkg.name + "/scripts");
    add("internal/" + repo + "/scripts");
  }
  return out.sort((a, b) => a.root.localeCompare(b.root));
}

/** 文档语料根：存在即进候选（存在性 = 应受约束；归哪个门由登记面说明） */
export function discoverDocRoots(root, repos) {
  const out = [];
  for (const rel of DOC_DIRS_AT_WORKSPACE) if (exists(path.join(root, rel))) out.push({ root: rel, kind: "doc-corpus" });
  for (const repo of repos)
    for (const rel of DOC_DIRS_AT_REPO) if (exists(path.join(root, repo, rel))) out.push({ root: toPosix(repo + "/" + rel), kind: "doc-corpus" });
  return out.sort((a, b) => a.root.localeCompare(b.root));
}

/**
 * workspace 一级目录（非 git 仓、非跳过名单、非已知语料/门目录）。
 * 目的：抓到「新目录出现但没登记」这一半 —— 名字白名单（docs/internal/plans/tools）只管已知的，
 * 新出现的 research/ 这类根本不在白名单里，靠名字枚举永远抓不到。
 */
export function discoverWorkspaceDirs(root, repos, docRoots, gateDirs) {
  const known = new Set([...docRoots.map((d) => d.root), ...gateDirs.map((d) => d.root)]);
  return readdirSafe(root)
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name) && !isJunkDirName(e.name) && !repos.includes(e.name))
    .map((e) => e.name)
    .filter((name) => !known.has(name) && !exists(path.join(root, name, ".git")))
    .map((name) => ({ root: name, kind: "workspace-dir" }))
    .sort((a, b) => a.root.localeCompare(b.root));
}

/** mise 任务名：只解析 [tasks."x"] / [tasks.x] 头（不引 TOML 依赖，够判同名） */
export function parseMiseTasks(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*\[tasks(?:\.("([^"]+)"|([A-Za-z0-9_-]+)))?\]\s*$/);
    if (m && (m[2] || m[3])) names.push(m[2] || m[3]);
  }
  return names;
}

/** 跨仓同名任务（机制见 task-103 §6.3：任务名唯一，后加载者覆盖前者） */
export function discoverTaskConflicts(root, repos) {
  const files = [];
  const at = (rel) => {
    const abs = path.join(root, rel);
    if (exists(abs)) files.push({ rel: toPosix(rel), names: parseMiseTasks(abs) || [] });
  };
  at("mise.toml");
  for (const repo of repos) at(repo + "/mise.toml");
  const owner = new Map();
  for (const f of files)
    for (const name of f.names) {
      if (!owner.has(name)) owner.set(name, []);
      owner.get(name).push(f.rel);
    }
  const conflicts = [];
  for (const [name, where] of owner) if (where.length > 1) conflicts.push({ task: name, files: where.sort() });
  return conflicts.sort((a, b) => a.task.localeCompare(b.task));
}

function validateRegistry(reg) {
  const problems = [];
  if (!reg || typeof reg !== "object" || Array.isArray(reg)) return ["登记面顶层必须是对象"];
  for (const key of ["docRoots", "gateScriptDirs"]) {
    if (!Array.isArray(reg[key])) {
      problems.push("缺少数组字段 " + key);
      continue;
    }
    for (const [i, e] of reg[key].entries()) {
      if (!e || typeof e.root !== "string" || e.root.length === 0) problems.push(key + "[" + i + "] 缺少 root");
      else if (e.gates !== undefined && !Array.isArray(e.gates)) problems.push(key + "[" + i + "] gates 必须是数组");
    }
  }
  if (!reg.miseTasks || !Array.isArray(reg.miseTasks.allow)) problems.push("miseTasks.allow 必须是数组");
  return problems;
}

export function loadRegistry(file) {
  if (!exists(file)) return { registry: null, error: "E_REGISTRY_MISSING", detail: "登记面不存在：" + toPosix(file) };
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { registry: null, error: "E_REGISTRY_UNREADABLE", detail: String((error && error.message) || error) };
  }
  let reg;
  try {
    reg = JSON.parse(raw);
  } catch (error) {
    return { registry: null, error: "E_REGISTRY_INVALID_JSON", detail: String((error && error.message) || error) };
  }
  const problems = validateRegistry(reg);
  if (problems.length > 0) return { registry: null, error: "E_REGISTRY_SHAPE", detail: problems.join("；") };
  return { registry: reg, error: null, detail: null };
}

/** 核心：登记面 × 发现面 双向差集 + 同名任务冲突。纯函数，selftest 直接调。 */
export function evaluate({ root, registryPath }) {
  const errors = [];
  const warnings = [];
  const loaded = loadRegistry(registryPath);
  if (!loaded.registry) {
    errors.push({ code: loaded.error, detail: loaded.detail });
    return { ok: false, errors, warnings, registry: null, discovered: null };
  }
  const registry = loaded.registry;
  const repos = discoverRepos(root);
  const docRoots = discoverDocRoots(root, repos);
  const gateDirs = discoverGateScriptDirs(root, repos);
  const conflicts = discoverTaskConflicts(root, repos);
  const workspaceDirs = discoverWorkspaceDirs(root, repos, docRoots, gateDirs);

  const regDoc = new Map(registry.docRoots.map((e) => [e.root, e]));
  const regGate = new Map(registry.gateScriptDirs.map((e) => [e.root, e]));

  for (const d of [...docRoots, ...workspaceDirs])
    if (!regDoc.has(d.root)) warnings.push({ code: "W_UNREGISTERED_ROOT", root: d.root, kind: d.kind, detail: "目录存在但未在登记面声明" });
  for (const d of gateDirs)
    if (!regGate.has(d.root)) warnings.push({ code: "W_UNREGISTERED_ROOT", root: d.root, kind: "gate-scripts", detail: "门脚本目录（" + d.files.length + " 个门型脚本）未在登记面声明" });

  const seen = new Set([...docRoots, ...workspaceDirs, ...gateDirs].map((d) => d.root));
  for (const [rel, e] of regDoc) {
    if (!seen.has(rel) || !exists(path.join(root, rel))) warnings.push({ code: "W_STALE_ROOT", root: rel, kind: "doc-corpus", detail: "登记面声明了但目录不存在（收编 or 删登记）" });
    const gates = e.gates || [];
    if (gates.length === 0) {
      if (typeof e.gap === "string" && e.gap.length > 0)
        warnings.push({ code: "W_UNCOVERED_ROOT_ACK", root: rel, kind: "doc-corpus", detail: "登记了但无门覆盖（已记账：" + e.gap + "）" });
      else if (typeof e.exempt === "string" && e.exempt.length > 0)
        warnings.push({ code: "W_UNCOVERED_ROOT_EXEMPT", root: rel, kind: "doc-corpus", detail: "登记为非文档语料，不需门覆盖（" + e.exempt + "）" });
      else warnings.push({ code: "W_UNCOVERED_ROOT", root: rel, kind: "doc-corpus", detail: "登记了但没有任何门覆盖 ⇒ 新目录天然无门（卡面 task-104 背景即此形态）；无门时须用 gap（记账）或 exempt（判定不需门）" });
    }
    for (const gate of gates) if (!exists(path.join(root, gate))) warnings.push({ code: "W_MISSING_GATE_SCRIPT", root: rel, kind: "doc-corpus", detail: "登记的门脚本不存在：" + gate });
  }
  for (const [rel, e] of regGate) {
    if (!seen.has(rel) || !exists(path.join(root, rel))) warnings.push({ code: "W_STALE_ROOT", root: rel, kind: "gate-scripts", detail: "登记面声明了但该门脚本目录不存在（收编 or 删登记）" });
    for (const gate of e.gates || []) if (!exists(path.join(root, gate))) warnings.push({ code: "W_MISSING_GATE_SCRIPT", root: rel, kind: "gate-scripts", detail: "登记的聚合门脚本不存在：" + gate });
  }

  const allowed = new Set(registry.miseTasks.allow.map((e) => e.task));
  for (const c of conflicts) {
    const dirs = c.files.map((x) => path.posix.dirname(x));
    const chained = dirs.some((a, i) =>
      dirs.some((b, j) => {
        if (i === j || a === b) return false;
        if (a === "." || b === ".") return true;
        return a.startsWith(b + "/") || b.startsWith(a + "/");
      }),
    );
    if (!chained) {
      warnings.push({ code: "W_SAME_NAME_TASK_SIBLING", task: c.task, files: c.files, detail: "同名任务在兄弟仓（mise 只加载 cwd 祖先链，兄弟仓永不共载 ⇒ 不构成遮蔽）" });
      continue;
    }
    const base = { code: "W_SAME_NAME_TASK", task: c.task, files: c.files, detail: "同名任务在祖先链上：mise 任务名唯一，后加载者覆盖前者（task-103 §6.3）" };
    warnings.push(allowed.has(c.task) ? { ...base, code: "W_SAME_NAME_TASK_ACK", detail: base.detail + "；登记面已确认" } : base);
  }

  const hard = warnings.filter(isHardWarn);
  return { ok: hard.length === 0, errors, warnings, registry, discovered: { repos, docRoots, workspaceDirs, gateDirs, conflicts } };
}

/** 软告警码：只记录、不进硬 W（不阻断 --enforce）。硬 W = 需要人裁定「登记 or 收编」。 */
export const SOFT_CODES = new Set(["W_SAME_NAME_TASK_ACK", "W_SAME_NAME_TASK_SIBLING", "W_UNCOVERED_ROOT_ACK", "W_UNCOVERED_ROOT_EXEMPT"]);
export const isHardWarn = (w) => !SOFT_CODES.has(w.code);

export function exitCodeFor(result, opts) {
  const enforce = Boolean(opts && opts.enforce);
  if (result.errors.length > 0) return 2;
  const hard = result.warnings.filter(isHardWarn);
  return enforce && hard.length > 0 ? 1 : 0;
}

const fmt = (w) => "  " + w.code + " " + (w.root || w.task || "") + (w.kind ? " [" + w.kind + "]" : "") + " — " + w.detail + (w.files ? "（" + w.files.join(" vs ") + "）" : "");

/** 内建自测：5 例（含 fail-closed 与「新目录未登记 ⇒ W」） */
export function selftest() {
  const cases = [];
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gate-registry-selftest-"));
  const mk = (rel, content) => {
    const p = path.join(base, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (content !== undefined) fs.writeFileSync(p, content);
    return p;
  };
  const reg = (name, body) => mk(name, JSON.stringify(body, null, 1));
  try {
    const r1 = path.join(base, "case1");
    mk("case1/docs/a.md", "# a\n");
    mk("case1/scripts/check-x.mjs", "\n");
    const reg1 = reg("reg1.json", {
      docRoots: [{ root: "docs", gates: ["scripts/check-x.mjs"], owner: "t" }],
      gateScriptDirs: [{ root: "scripts", gates: [], owner: "t" }],
      miseTasks: { allow: [] },
    });
    const e1 = evaluate({ root: r1, registryPath: reg1 });
    cases.push({ name: "① 已登记且全覆盖 ⇒ 0 硬 W", ok: e1.errors.length === 0 && exitCodeFor(e1) === 0 && exitCodeFor(e1, { enforce: true }) === 0, detail: "warnings=" + e1.warnings.length + " exit=" + exitCodeFor(e1) });

    const r2 = path.join(base, "case2");
    mk("case2/docs/a.md", "# a\n");
    mk("case2/spec/new.md", "# new\n");
    const reg2 = reg("reg2.json", {
      docRoots: [{ root: "docs", gates: [], owner: "t" }],
      gateScriptDirs: [],
      miseTasks: { allow: [] },
    });
    const e2 = evaluate({ root: r2, registryPath: reg2 });
    const unreg = e2.warnings.filter((w) => w.code === "W_UNREGISTERED_ROOT" && w.root === "spec");
    cases.push({ name: "② 新目录未登记 ⇒ W_UNREGISTERED_ROOT（默认 exit 0）", ok: unreg.length === 1 && exitCodeFor(e2) === 0, detail: "spec 命中=" + unreg.length + " exit=" + exitCodeFor(e2) });
    cases.push({ name: "③ 同上 + --enforce ⇒ exit 1", ok: exitCodeFor(e2, { enforce: true }) === 1, detail: "exit=" + exitCodeFor(e2, { enforce: true }) });

    const e4 = evaluate({ root: path.join(base, "case2"), registryPath: path.join(base, "nope.json") });
    cases.push({ name: "④ 登记面缺失 ⇒ E_REGISTRY_MISSING + exit 2（fail-closed）", ok: e4.errors.length === 1 && e4.errors[0].code === "E_REGISTRY_MISSING" && exitCodeFor(e4) === 2, detail: "code=" + (e4.errors[0] && e4.errors[0].code) + " exit=" + exitCodeFor(e4) });

    const r5 = path.join(base, "case5");
    mk("case5/mise.toml", '[tasks."lint:scripts"]\nrun = "a"\n');
    mk("case5/R1/.git/HEAD", "ref: x\n");
    mk("case5/R1/mise.toml", '[tasks."lint:scripts"]\nrun = "b"\n');
    mk("case5/R1/docs/a.md", "# a\n");
    const reg5 = reg("reg5.json", {
      docRoots: [{ root: "R1/docs", gates: [], owner: "t" }],
      gateScriptDirs: [],
      miseTasks: { allow: [] },
    });
    const e5 = evaluate({ root: r5, registryPath: reg5 });
    const conflict = e5.warnings.filter((w) => w.code === "W_SAME_NAME_TASK" && w.task === "lint:scripts");
    const reg5b = reg("reg5b.json", {
      docRoots: [{ root: "R1/docs", gates: [], owner: "t" }],
      gateScriptDirs: [],
      miseTasks: { allow: [{ task: "lint:scripts" }] },
    });
    const e5b = evaluate({ root: r5, registryPath: reg5b });
    const ack = e5b.warnings.filter((w) => w.code === "W_SAME_NAME_TASK_ACK" && w.task === "lint:scripts");
    cases.push({ name: "⑤ 跨仓同名任务 ⇒ W（allow 后降 ACK）", ok: conflict.length === 1 && ack.length === 1, detail: "冲突=" + conflict.length + " ack=" + ack.length });

    const r6 = path.join(base, "case6");
    mk("case6/R1/.git/HEAD", "ref: x\n");
    mk("case6/R1/mise.toml", '[tasks."build"]\nrun = "a"\n');
    mk("case6/R2/.git/HEAD", "ref: x\n");
    mk("case6/R2/mise.toml", '[tasks."build"]\nrun = "b"\n');
    mk("case6/docs/a.md", "# a\n");
    const reg6 = reg("reg6.json", { docRoots: [{ root: "docs", gates: [], gap: "T-1" }], gateScriptDirs: [], miseTasks: { allow: [] } });
    const e6 = evaluate({ root: r6, registryPath: reg6 });
    const sib = e6.warnings.filter((w) => w.code === "W_SAME_NAME_TASK_SIBLING" && w.task === "build");
    cases.push({ name: "⑥ 兄弟仓同名 ⇒ SIBLING（非硬 W，--enforce 仍 0）；无门但有 gap ⇒ ACK", ok: sib.length === 1 && exitCodeFor(e6, { enforce: true }) === 0 && e6.warnings.some((w) => w.code === "W_UNCOVERED_ROOT_ACK"), detail: "sibling=" + sib.length + " enforceExit=" + exitCodeFor(e6, { enforce: true }) });

    const failed = cases.filter((c) => !c.ok);
    console.log("[check-gate-registry --selftest]");
    for (const c of cases) console.log((c.ok ? "  PASS " : "  FAIL ") + c.name + " | " + c.detail);
    console.log("[check-gate-registry --selftest] " + (cases.length - failed.length) + "/" + cases.length + " pass；临时根 " + base);
    return { ok: failed.length === 0, cases };
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function main(argv) {
  const has = (flag) => argv.includes(flag);
  const value = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (has("--selftest")) {
    const r = selftest();
    process.exit(r.ok ? 0 : 1);
  }
  const root = path.resolve(value("--root") || WORKSPACE_ROOT);
  const registryPath = path.resolve(value("--registry") || DEFAULT_REGISTRY);
  const result = evaluate({ root, registryPath });
  const code = exitCodeFor(result, { enforce: has("--enforce") });
  if (has("--json")) {
    console.log(JSON.stringify({ root: toPosix(root), registry: toPosix(registryPath), exit: code, ...result }, null, 1));
    process.exit(code);
  }
  console.log("[check-gate-registry] 语料面登记制（report-only，task-104）");
  console.log("  根：" + toPosix(root) + "；登记面：" + toPosix(registryPath));
  if (result.discovered) {
    console.log("  发现：doc 根 " + result.discovered.docRoots.length + " 个 / workspace 一级目录 " + result.discovered.workspaceDirs.length + " 个 / 门脚本目录 " + result.discovered.gateDirs.length + " 个 / 跨仓同名任务 " + result.discovered.conflicts.length + " 个");
    console.log("  登记：doc 根 " + result.registry.docRoots.length + " 个 / 门脚本目录 " + result.registry.gateScriptDirs.length + " 个 / 已确认同名任务 " + result.registry.miseTasks.allow.length + " 个");
  }
  for (const e of result.errors) console.log("  ERROR " + e.code + " — " + e.detail);
  const silent = has("--verbose") ? new Set() : new Set(["W_SAME_NAME_TASK_SIBLING"]);
  const collapsed = new Map();
  for (const w of result.warnings) {
    if (silent.has(w.code)) {
      collapsed.set(w.code, [...(collapsed.get(w.code) || []), w.task]);
      continue;
    }
    console.log(fmt(w));
  }
  for (const [code, tasks] of collapsed) console.log("  " + code + " ×" + tasks.length + " — 兄弟仓同名任务（mise 只加载 cwd 祖先链，兄弟仓永不共载 ⇒ 不构成遮蔽）；--verbose 展开：" + tasks.join(" "));
  const hard = result.warnings.filter(isHardWarn);
  console.log("[check-gate-registry] 汇总：ERROR " + result.errors.length + " / W " + hard.length + " / ACK " + (result.warnings.length - hard.length) + " ⇒ exit " + code + (code === 0 && hard.length > 0 ? "（report-only：加 --enforce 才阻断）" : ""));
  process.exit(code);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main(process.argv.slice(2));
