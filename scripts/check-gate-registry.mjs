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
 * 本门做四件事，全部 report-only：
 *   ① 语料面：发现的「应受门约束的目录」与登记面做双向差集（未登记 ⇒ W；登记了但不在 ⇒ W；登记了但无门 ⇒ W）；
 *   ② 门脚本目录：workspace scripts/、每仓 scripts/、每仓 packages 下各包 scripts/、internal 下每仓 scripts/，未登记 ⇒ W；
 *   ③ 同名任务：跨仓 mise 任务同名（后者覆盖前者）⇒ W；登记面 miseTasks.allow 可确认（降为 ACK，不进硬 W）。
 *   ④ 数量字段：gateScriptDirs[].discoveredCount 与 discoverGateScriptDirs() 实数比对，漂移/缺字段 ⇒ 软 W（task-717；不改退出码语义）。
 *
 * 硬边界（卡面 task-104）：report-only；不得 import 进 validate；不改任何既有门的判据；接 mise 前先问 LEAD。
 *
 * 退出码：0 = 无硬 W（或纯 report）；1 = 有硬 W 且显式 --enforce，或显式 --strict-counts 时 discoveredCount 漂移/unknown；
 *         2 = ERROR（登记面缺失/不可解析，fail-closed）。
 *
 * 用法：
 *   node A03-xihe/scripts/check-gate-registry.mjs
 *   node A03-xihe/scripts/check-gate-registry.mjs --json
 *   node A03-xihe/scripts/check-gate-registry.mjs --enforce
 *   node A03-xihe/scripts/check-gate-registry.mjs --enforce --strict-counts
 *   node A03-xihe/scripts/check-gate-registry.mjs --selftest
 *   node A03-xihe/scripts/check-gate-registry.mjs --write-counts
 *   node A03-xihe/scripts/check-gate-registry.mjs --write-counts --strict-counts
 *   node A03-xihe/scripts/check-gate-registry.mjs --help
 *   node A03-xihe/scripts/check-gate-registry.mjs --root <dir> --registry <file>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
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
/** 数量漂移的单命令修复（在 workspace 根执行；只改 discoveredCount 一个字段）。 */
export const COUNT_REPAIR_COMMAND = "node A03-xihe/scripts/check-gate-registry.mjs --write-counts";
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

  /**
   * discoveredCount 漂移（task-717）：登记面是派生字段，文件实数是 SSOT。
   * 该字段当前只是可见性数据 ⇒ 默认只出软 W（不进 --enforce、不改既有退出码语义）。
   * 缺字段或非整数判 unknown，不按 0 处理（0 会伪装成「核对通过且无脚本」）。
   */
  const counts = { total: 0, matched: 0, drifted: 0, unknown: 0, skipped: 0 };
  for (const e of registry.gateScriptDirs) {
    counts.total += 1;
    const registered = e.discoveredCount;
    if (!Number.isInteger(registered) || registered < 0) {
      counts.unknown += 1;
      warnings.push({
        code: "W_DISCOVERED_COUNT_UNKNOWN",
        root: e.root,
        kind: "gate-scripts",
        detail:
          (registered === undefined ? "登记面缺 discoveredCount（unknown，不是 0）" : "discoveredCount 不是非负整数（unknown）：" + JSON.stringify(registered)) +
          "；修复：" + COUNT_REPAIR_COMMAND,
      });
      continue;
    }
    const actual = gateDirs.find((d) => d.root === e.root);
    if (!actual) {
      counts.skipped += 1;
      continue;
    }
    if (registered !== actual.files.length) {
      counts.drifted += 1;
      warnings.push({
        code: "W_DISCOVERED_COUNT_DRIFT",
        root: e.root,
        kind: "gate-scripts",
        registered,
        actual: actual.files.length,
        detail: "E_DISCOVERED_COUNT_DRIFT " + e.root + " 登记=" + registered + " 实数=" + actual.files.length + "；修复：" + COUNT_REPAIR_COMMAND,
      });
    } else counts.matched += 1;
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
  return { ok: hard.length === 0, errors, warnings, registry, counts, discovered: { repos, docRoots, workspaceDirs, gateDirs, conflicts } };
}

/** 软告警码：只记录、不进硬 W（不阻断 --enforce）。硬 W = 需要人裁定「登记 or 收编」。 */
export const SOFT_CODES = new Set([
  "W_SAME_NAME_TASK_ACK",
  "W_SAME_NAME_TASK_SIBLING",
  "W_UNCOVERED_ROOT_ACK",
  "W_UNCOVERED_ROOT_EXEMPT",
  // task-717：discoveredCount 仍只是可见性数据，升级为硬 W 需 Lead 另批（会改既有门退出码语义）。
  "W_DISCOVERED_COUNT_DRIFT",
  "W_DISCOVERED_COUNT_UNKNOWN",
]);
export const isHardWarn = (w) => !SOFT_CODES.has(w.code);

/** --strict-counts 只升级这两类数量告警；其余软 W 仍不阻断。 */
export const STRICT_COUNT_CODES = new Set(["W_DISCOVERED_COUNT_DRIFT", "W_DISCOVERED_COUNT_UNKNOWN"]);

export function exitCodeFor(result, opts) {
  const enforce = Boolean(opts && opts.enforce);
  const strictCounts = Boolean(opts && opts.strictCounts);
  if (result.errors.length > 0) return 2;
  const hard = result.warnings.filter(isHardWarn);
  if (enforce && hard.length > 0) return 1;
  if (strictCounts && result.warnings.some((w) => STRICT_COUNT_CODES.has(w.code))) return 1;
  return 0;
}

export const HELP_TEXT = `[check-gate-registry] 用法

  node A03-xihe/scripts/check-gate-registry.mjs [--json] [--verbose] [--enforce] [--strict-counts]
  node A03-xihe/scripts/check-gate-registry.mjs --write-counts [--strict-counts]
  node A03-xihe/scripts/check-gate-registry.mjs --selftest
  node A03-xihe/scripts/check-gate-registry.mjs --help

默认行为（report-only）：
  - 发现面与登记面的差集、同名任务、discoveredCount 漂移都只报告；退出码恒 0（ERROR 形状问题仍为 2）。

--enforce：
  - 既有语义不变：只把「硬 W」升为 exit 1；discoveredCount 漂移/unknown 仍是软 W，不会被它顺带升级。

--strict-counts：
  - 仅在显式给出时生效：W_DISCOVERED_COUNT_DRIFT / W_DISCOVERED_COUNT_UNKNOWN ⇒ exit 1。
  - 不带该开关时，这两类仍是软 W，退出码与接线前逐字节一致（真实仓当前 11/11 一致 ⇒ exit 0）。
  - 与 --enforce 独立，可单用，也可同用。

--write-counts：
  - file → registry，只覆盖 gateScriptDirs[].discoveredCount，不重排 JSON、不改其他字段。
  - 写回成功且不带 --strict-counts ⇒ exit 0（旧行为）。
  - 写回成功且同批带 --strict-counts ⇒ 写完再判一次；仍漂移/unknown ⇒ exit 1，已修好 ⇒ 0。
  - 写回失败（无法安全定位/校验失败）⇒ exit 2。

--selftest：
  - 跑内建夹具（含默认 / --enforce / --strict-counts 三态），全绿 exit 0。
`;

const leadingSpaces = (line) => line.match(/^\s*/)[0].length;
const ROOT_LINE_RE = /^(\s*)"root"\s*:\s*("(?:[^"\\]|\\.)*")\s*,?\s*$/;
const COUNT_LINE_RE = /^(\s*"discoveredCount"\s*:\s*)(-?\d+)(\s*,?\s*)$/;

/**
 * 单命令修复（task-717）：file → registry，只覆盖 gateScriptDirs[].discoveredCount。
 * 不做整份 JSON 重排：按行定位 gateScriptDirs 段，只替换数字/插入缺失字段；
 * 任何无法安全定位的形态都 fail-closed，不退回「整份 stringify」。
 */
export function writeDiscoveredCounts({ root, registryPath }) {
  const loaded = loadRegistry(registryPath);
  if (!loaded.registry) return { ok: false, error: loaded.error, detail: loaded.detail, changed: 0, rows: [] };
  let raw;
  try {
    raw = fs.readFileSync(registryPath, "utf8");
  } catch (error) {
    return { ok: false, error: "E_REGISTRY_UNREADABLE", detail: String((error && error.message) || error), changed: 0, rows: [] };
  }
  if (raw.includes("\r\n")) return { ok: false, error: "E_REGISTRY_CRLF", detail: "登记面含 CRLF；本仓约定 LF，拒绝整份换行重写", changed: 0, rows: [] };

  const repos = discoverRepos(root);
  const realByRoot = new Map(discoverGateScriptDirs(root, repos).map((d) => [d.root, d.files.length]));
  const lines = raw.split("\n");
  const start = lines.findIndex((line) => /^\s*"gateScriptDirs"\s*:\s*\[\s*$/.test(line));
  if (start < 0) return { ok: false, error: "E_COUNT_WRITE_UNSUPPORTED", detail: "找不到 gateScriptDirs 数组", changed: 0, rows: [] };
  const sectionIndent = leadingSpaces(lines[start]);
  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (leadingSpaces(lines[i]) === sectionIndent && /^\s*\]\s*,?\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end < 0) return { ok: false, error: "E_COUNT_WRITE_UNSUPPORTED", detail: "gateScriptDirs 数组没有闭合", changed: 0, rows: [] };

  const usedRootLines = new Set();
  const edits = [];
  const rows = [];
  for (const entry of loaded.registry.gateScriptDirs) {
    const actual = realByRoot.get(entry.root);
    if (actual === undefined) continue;
    let rootIdx = -1;
    for (let i = start + 1; i < end; i += 1) {
      if (usedRootLines.has(i)) continue;
      const m = lines[i].match(ROOT_LINE_RE);
      if (!m) continue;
      let value;
      try {
        value = JSON.parse(m[2]);
      } catch {
        continue;
      }
      if (value === entry.root) {
        rootIdx = i;
        usedRootLines.add(i);
        break;
      }
    }
    if (rootIdx < 0) {
      return { ok: false, error: "E_COUNT_WRITE_UNSUPPORTED", detail: "无法在 gateScriptDirs 段唯一位置定位 root=" + entry.root, changed: 0, rows: [] };
    }
    let fieldIdx = -1;
    for (let i = rootIdx + 1; i < end; i += 1) {
      if (ROOT_LINE_RE.test(lines[i]) || /^\s*\}\s*,?\s*$/.test(lines[i])) break;
      if (COUNT_LINE_RE.test(lines[i])) {
        fieldIdx = i;
        break;
      }
    }
    if (fieldIdx >= 0) {
      const m = lines[fieldIdx].match(COUNT_LINE_RE);
      const nextLine = m[1] + actual + m[3];
      if (nextLine !== lines[fieldIdx]) {
        edits.push({ i: fieldIdx, insert: false, text: nextLine });
        rows.push({ root: entry.root, from: Number(m[2]), to: actual, inserted: false });
      }
    } else {
      const indent = " ".repeat(leadingSpaces(lines[rootIdx]));
      edits.push({ i: rootIdx + 1, insert: true, text: indent + '"discoveredCount": ' + actual + "," });
      rows.push({ root: entry.root, from: null, to: actual, inserted: true });
    }
  }

  if (edits.length === 0) return { ok: true, error: null, detail: null, changed: 0, rows: [] };
  const nextLines = lines.slice();
  for (const edit of [...edits].sort((a, b) => b.i - a.i)) {
    if (edit.insert) nextLines.splice(edit.i, 0, edit.text);
    else nextLines[edit.i] = edit.text;
  }
  const nextRaw = nextLines.join("\n");
  if (nextRaw.includes("\r")) return { ok: false, error: "E_COUNT_WRITE_UNSUPPORTED", detail: "改写结果含 CR；拒绝写入", changed: 0, rows: [] };
  const expected = JSON.parse(raw);
  for (const entry of expected.gateScriptDirs) {
    const actual = realByRoot.get(entry.root);
    if (actual !== undefined) entry.discoveredCount = actual;
  }
  let nextRegistry;
  try {
    nextRegistry = JSON.parse(nextRaw);
  } catch (error) {
    return { ok: false, error: "E_COUNT_WRITE_VERIFY", detail: "改写结果不是合法 JSON：" + String((error && error.message) || error), changed: 0, rows: [] };
  }
  if (!isDeepStrictEqual(nextRegistry, expected)) {
    return { ok: false, error: "E_COUNT_WRITE_VERIFY", detail: "改写结果除 discoveredCount 外还有差异；拒绝写入", changed: 0, rows: [] };
  }
  try {
    fs.writeFileSync(registryPath, nextRaw, "utf8");
  } catch (error) {
    return { ok: false, error: "E_REGISTRY_UNWRITABLE", detail: String((error && error.message) || error), changed: 0, rows: [] };
  }
  return { ok: true, error: null, detail: null, changed: edits.length, rows };
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

    const r7 = path.join(base, "case7");
    mk("case7/scripts/check-a.mjs", "\n");
    mk("case7/scripts/check-b.mjs", "\n");
    const reg7 = reg("reg7.json", {
      docRoots: [],
      gateScriptDirs: [{ root: "scripts", gates: [], owner: "t", discoveredCount: 2 }],
      miseTasks: { allow: [] },
    });
    const e7 = evaluate({ root: r7, registryPath: reg7 });
    const drift7 = e7.warnings.filter((w) => w.code === "W_DISCOVERED_COUNT_DRIFT");
    cases.push({
      name: "⑦ 登记 = 实数 ⇒ 无数量漂移（软 W 不阻断 --enforce）",
      ok: drift7.length === 0 && e7.counts.matched === 1 && e7.counts.drifted === 0 && exitCodeFor(e7, { enforce: true }) === 0,
      detail: "matched=" + e7.counts.matched + " drift=" + drift7.length + " enforceExit=" + exitCodeFor(e7, { enforce: true }),
    });

    const r8 = path.join(base, "case8");
    mk("case8/scripts/check-a.mjs", "\n");
    mk("case8/scripts/check-b.mjs", "\n");
    const reg8 = reg("reg8.json", {
      docRoots: [],
      gateScriptDirs: [{ root: "scripts", gates: [], owner: "t", discoveredCount: 1 }],
      miseTasks: { allow: [] },
    });
    const e8 = evaluate({ root: r8, registryPath: reg8 });
    const drift8 = e8.warnings.filter((w) => w.code === "W_DISCOVERED_COUNT_DRIFT");
    const repair8 = writeDiscoveredCounts({ root: r8, registryPath: reg8 });
    const e8b = evaluate({ root: r8, registryPath: reg8 });
    const drift8b = e8b.warnings.filter((w) => w.code === "W_DISCOVERED_COUNT_DRIFT");
    cases.push({
      name: "⑧ 登记少 1 ⇒ W_DISCOVERED_COUNT_DRIFT + repair 命令；--write-counts 单命令修复",
      ok:
        drift8.length === 1 &&
        drift8[0].detail.includes("登记=1 实数=2") &&
        drift8[0].detail.includes(COUNT_REPAIR_COMMAND) &&
        exitCodeFor(e8, { enforce: true }) === 0 &&
        repair8.ok &&
        repair8.changed === 1 &&
        drift8b.length === 0 &&
        e8b.counts.matched === 1,
      detail: "drift=" + drift8.length + " repairChanged=" + repair8.changed + " afterDrift=" + drift8b.length + " enforceExit=" + exitCodeFor(e8, { enforce: true }),
    });

    const r9 = path.join(base, "case9");
    mk("case9/scripts/check-a.mjs", "\n");
    const reg9 = reg("reg9.json", {
      docRoots: [],
      gateScriptDirs: [{ root: "scripts", gates: [], owner: "t" }],
      miseTasks: { allow: [] },
    });
    const e9 = evaluate({ root: r9, registryPath: reg9 });
    const unknown9 = e9.warnings.filter((w) => w.code === "W_DISCOVERED_COUNT_UNKNOWN");
    cases.push({
      name: "⑨ 缺 discoveredCount ⇒ unknown（不是 0，也不通过）",
      ok: unknown9.length === 1 && e9.counts.unknown === 1 && e9.counts.matched === 0 && e9.counts.drifted === 0 && unknown9[0].detail.includes("不是 0") && exitCodeFor(e9) === 0,
      detail: "unknown=" + e9.counts.unknown + " matched=" + e9.counts.matched + " exit=" + exitCodeFor(e9),
    });

    const r10 = path.join(base, "case10");
    mk("case10/scripts/check-a.mjs", "\n");
    mk("case10/scripts/check-b.mjs", "\n");
    const reg10 = reg("reg10.json", {
      docRoots: [],
      gateScriptDirs: [{ root: "scripts", gates: [], owner: "t", discoveredCount: 1 }],
      miseTasks: { allow: [] },
    });
    const e10 = evaluate({ root: r10, registryPath: reg10 });
    const defaultExit10 = exitCodeFor(e10);
    const enforceExit10 = exitCodeFor(e10, { enforce: true });
    const strictExit10 = exitCodeFor(e10, { strictCounts: true });
    cases.push({
      name: "⑩ 登记少 1：默认 / --enforce ⇒ exit 0；仅 --strict-counts ⇒ exit 1",
      ok: defaultExit10 === 0 && enforceExit10 === 0 && strictExit10 === 1,
      detail: "defaultExit=" + defaultExit10 + " enforceExit=" + enforceExit10 + " strictExit=" + strictExit10,
    });

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
  if (has("--help") || has("-h")) {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  if (has("--selftest")) {
    const r = selftest();
    process.exit(r.ok ? 0 : 1);
  }
  const root = path.resolve(value("--root") || WORKSPACE_ROOT);
  const registryPath = path.resolve(value("--registry") || DEFAULT_REGISTRY);
  if (has("--write-counts")) {
    const written = writeDiscoveredCounts({ root, registryPath });
    const strictCounts = has("--strict-counts");
    let post = null;
    let writeExit = written.ok ? 0 : 2;
    if (written.ok && strictCounts) {
      post = evaluate({ root, registryPath });
      writeExit = exitCodeFor(post, { enforce: has("--enforce"), strictCounts: true });
    }
    if (has("--json")) {
      console.log(JSON.stringify({ root: toPosix(root), registry: toPosix(registryPath), ...written, ...(post ? { postExit: writeExit, counts: post.counts } : {}) }, null, 1));
      process.exit(writeExit);
    }
    console.log("[check-gate-registry --write-counts] file → registry（只改 discoveredCount，不重排 JSON）");
    console.log("  根：" + toPosix(root) + "；登记面：" + toPosix(registryPath));
    if (!written.ok) {
      console.log("  ERROR " + written.error + " — " + written.detail);
      process.exit(2);
    }
    if (written.changed === 0) console.log("  无漂移，未写入");
    for (const row of written.rows) console.log("  " + (row.inserted ? "ADD " : "SET ") + row.root + "：" + (row.from === null ? "（缺字段）" : row.from) + " → " + row.to);
    if (strictCounts) {
      const counts = post.counts || { drifted: 0, unknown: 0 };
      console.log("[check-gate-registry --write-counts] 复核（--strict-counts）：漂移 " + counts.drifted + " / unknown " + counts.unknown + " ⇒ exit " + writeExit);
      process.exit(writeExit);
    }
    console.log("[check-gate-registry --write-counts] 写入 " + written.changed + " 处 ⇒ exit 0");
    process.exit(0);
  }
  const result = evaluate({ root, registryPath });
  const code = exitCodeFor(result, { enforce: has("--enforce"), strictCounts: has("--strict-counts") });
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
  if (result.counts)
    console.log(
      "[check-gate-registry] discoveredCount：合计 " +
        result.counts.total +
        " / 一致 " +
        result.counts.matched +
        " / 漂移 " +
        result.counts.drifted +
        " / unknown " +
        result.counts.unknown +
        (result.counts.skipped > 0 ? " / 跳过（目录缺失）" + result.counts.skipped : "") +
        "（" +
        (has("--strict-counts") ? "--strict-counts 已开：漂移/unknown ⇒ exit 1" : "默认 WARN，不进 --enforce") +
        "；修复：" +
        COUNT_REPAIR_COMMAND +
        "）",
    );
  console.log("[check-gate-registry] 汇总：ERROR " + result.errors.length + " / W " + hard.length + " / ACK " + (result.warnings.length - hard.length) + " ⇒ exit " + code + (code === 0 && hard.length > 0 ? "（report-only：加 --enforce 才阻断）" : ""));
  process.exit(code);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main(process.argv.slice(2));
