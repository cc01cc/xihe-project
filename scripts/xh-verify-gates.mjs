#!/usr/bin/env node
/**
 * xh-verify-gates — 一条命令跑完验证窗的「门集」（D-772 授权，task-37）。
 * 用法：node scripts/xh-verify-gates.mjs --list|--only=a,b|--skip=c|--fast|--evidence=<path>
 *   --list                 列出可用门（id / SSOT 来源 / 命令 / class / 说明），退出码 0
 *   --only=a,b / --skip=c  只跑 / 跳过指定门（名称 = 门 id，见 --list）；未知 id ⇒ 用法错误 exit 2
 *   --fast                 只跑 class=fast 的轻门（<60s/门，实施中自查用；L2 重门不跑）
 *   --evidence=<path>      落 JSON 证据（每条门的 name/cmd/exit/durationMs/status/skipReason + 汇总）
 *   例：node scripts/xh-verify-gates.mjs --fast      # 实施中自查（不含 L2 重门）
 *
 * 门清单**不硬编码命令**：默认门表只登记 task 名 + class，真正的命令与说明从 SSOT
 * （`mise.toml` 的 `[tasks."<name>"]`，或 `package.json` 的 `scripts`）解析；SSOT 里缺该门 ⇒ SKIP 并写明原因。
 * 判定：任一 FAIL ⇒ 总 exit 非 0；SKIP 不吞（必须带 skipReason，并计入汇总）。
 * **SKIP vs FAIL 语义**：缺输入/缺依赖/显式跳过 = SKIP（写明补齐方式）；命令真跑了而判据不满足 = FAIL。
 *
 * **class 口径（验证分级）**：`fast` = 单门 <60 s、无浏览器/无 Maven，可随时跑（`--fast`）；
 * `full` = **L2 全量门**，只能在验证窗口内跑（`test:ui` ~150 s、`test:mock` 浏览器整套、
 * `test:cp:executed` 需 Maven 编译+Surefire）。L2 触发点仍按 workspace 白名单三条，不因本脚本放宽。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..");

/** 默认门集：验证窗（W-##）用的那批门。只登记 task 名 + class，命令一律由 SSOT 解析。 */
export const DEFAULT_GATES = [
  { id: "check:types", kind: "mise", class: "fast" },
  { id: "lint:ui", kind: "mise", class: "fast" },
  { id: "check:openapi", kind: "mise", class: "fast" },
  { id: "check:a11y-refs", kind: "mise", class: "fast" },
  { id: "test:ui", kind: "mise", class: "full" },
  { id: "check:mock-baseline", kind: "mise", class: "fast" },
  { id: "test:mock", kind: "mise", class: "full" },
  { id: "check:e2e-bypass", kind: "mise", class: "fast" },
  { id: "check:ports", kind: "mise", class: "fast" },
  { id: "check:event-keys", kind: "mise", class: "fast" },
  { id: "test:cp:executed", kind: "mise", class: "full" },
  { id: "lint:log-secrets", kind: "mise", class: "fast" },
];

/** 这些门需要 `packages/ui` 的依赖；worktree 里通常没有 node_modules ⇒ 显式 SKIP 并给原因。 */
const NEEDS_UI_DEPS = new Set(["check:types", "lint:ui", "test:ui", "test:mock"]);

/**
 * 输入前置门：缺输入时**显式 SKIP 并说明怎么补齐**（绝不静默通过，也不把「缺输入」误报成产品红）。
 * 语义区分：缺输入 = SKIP；命令跑了但判据不满足 = FAIL。
 */
const PRECONDITIONS = {
  "lint:log-secrets": {
    ready: (root) => existsSync(join(root, "logs")),
    reason: "缺少 logs/（本 worktree 无运行日志；在窗口里用主检出的 logs/ 或先起栈产生日志再跑）",
  },
  "check:mock-baseline": {
    ready: (root) => existsSync(join(root, "packages", "ui", "e2e", ".mock-report.json")),
    reason: "缺少 packages/ui/e2e/.mock-report.json（先跑 test:mock 产出报告，再跑本门；属 L2 窗口流程）",
  },
};

/** 解析 `mise.toml` 的 `[tasks."<name>"]` 段：拿到 description 与首条 run（只用于展示，不直接执行）。 */
export function parseMiseTasks(toml) {
  const tasks = new Map();
  let current = null;
  for (const raw of String(toml ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const header = line.match(/^\[tasks\."?([^\]"]+)"?\]$/);
    if (header) {
      current = { name: header[1], description: "", run: "" };
      tasks.set(current.name, current);
      continue;
    }
    if (!current) continue;
    if (/^\[/.test(line)) {
      current = null;
      continue;
    }
    const desc = line.match(/^description\s*=\s*"(.*)"$/);
    if (desc && !current.description) current.description = desc[1];
    const run = line.match(/^run\s*=\s*"(.*)"$/);
    if (run && !current.run) current.run = run[1];
  }
  return tasks;
}

/** 解析 `package.json` 的 scripts（kind=pkg 的门用）。 */
export function parsePkgScripts(json) {
  try {
    const parsed = JSON.parse(String(json ?? "{}"));
    return new Map(Object.entries(parsed.scripts ?? {}).map(([k, v]) => [k, String(v)]));
  } catch {
    return new Map();
  }
}

/**
 * 把门表解析成可执行计划：每条门拿到 cmd / source / description，或一个明确 skipReason。
 * @param {{gates?: Array<{id: string, kind?: string, pkgDir?: string}>, miseTasks: Map<string, {description: string, run: string}>, pkgScripts?: Map<string, string>, repoRoot?: string}} input
 */
export function planGates({ gates = DEFAULT_GATES, miseTasks, pkgScripts = new Map(), repoRoot = REPO_ROOT }) {
  return gates.map((gate) => {
    const kind = gate.kind ?? "mise";
    if (kind === "mise") {
      const task = miseTasks.get(gate.id);
      if (!task) {
        return {
          ...gate,
          cmd: `mise run ${gate.id}`,
          source: "mise.toml",
          description: "",
          skipReason: `mise.toml 里没有 [tasks."${gate.id}"]（SSOT 缺该门，需先登记任务）`,
        };
      }
      if (!task.run) {
        return {
          ...gate,
          cmd: `mise run ${gate.id}`,
          source: "mise.toml",
          description: task.description,
          skipReason: `mise.toml 的 [tasks."${gate.id}"] 没有 run 行（任务定义不完整）`,
        };
      }
      if (NEEDS_UI_DEPS.has(gate.id) && !existsSync(join(repoRoot, "packages", "ui", "node_modules"))) {
        return {
          ...gate,
          cmd: `mise run ${gate.id}`,
          source: "mise.toml",
          description: task.description,
          skipReason: "缺少 packages/ui/node_modules（worktree 未装依赖；在主检出或先 `mise run setup:ui` 再跑）",
        };
      }
      const precondition = PRECONDITIONS[gate.id];
      if (precondition && !precondition.ready(repoRoot)) {
        return {
          ...gate,
          cmd: `mise run ${gate.id}`,
          source: "mise.toml",
          description: task.description,
          skipReason: precondition.reason,
        };
      }
      return { ...gate, cmd: `mise run ${gate.id}`, source: "mise.toml", description: task.description };
    }
    // kind === "pkg"：id 形如 `pkg:<script>`，pkgDir 缺省为仓库根的 package.json
    const scriptName = gate.script ?? gate.id.replace(/^pkg:/, "");
    const dir = gate.pkgDir ? join(repoRoot, gate.pkgDir) : repoRoot;
    const cmdText = pkgScripts.get(scriptName);
    if (!cmdText) {
      return {
        ...gate,
        cmd: `pnpm --dir ${gate.pkgDir ?? "."} run ${scriptName}`,
        source: "package.json",
        description: "",
        skipReason: `package.json（${gate.pkgDir ?? "仓库根"}）里没有 scripts["${scriptName}"]`,
      };
    }
    return {
      ...gate,
      script: scriptName,
      cmd: `pnpm --dir ${gate.pkgDir ?? "."} run ${scriptName}`,
      source: "package.json",
      description: cmdText,
      pkgDirAbs: dir,
    };
  });
}

/** 默认 runner：按门的 kind 调 `mise run` 或 `pnpm run`，输出直通（窗口里要能实时看）。 */
export function defaultRunner({ gate, repoRoot = REPO_ROOT, env = process.env }) {
  const startedAt = Date.now();
  const isPkg = (gate.kind ?? "mise") === "pkg";
  const bin = isPkg ? "pnpm" : env.XH_MISE_BIN || "mise";
  const args = isPkg ? ["--dir", gate.pkgDir ?? ".", "run", gate.script] : ["run", gate.id];
  const res = spawnSync(bin, args, {
    cwd: isPkg ? repoRoot : repoRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  return {
    exit: typeof res.status === "number" ? res.status : res.error ? 127 : 1,
    durationMs: Date.now() - startedAt,
    error: res.error ? res.error.message : null,
  };
}

/**
 * 跑门：SKIP 的门不调用 runner（但必须留下 skipReason）。
 * @param {{planned: returnType<typeof planGates>, runner?: Function, repoRoot?: string, env?: object, onResult?: Function}} input
 */
export function runGates({ planned, runner = defaultRunner, repoRoot = REPO_ROOT, env = process.env, onResult }) {
  const results = [];
  for (const gate of planned) {
    if (gate.skipReason) {
      const row = { name: gate.id, cmd: gate.cmd, exit: null, durationMs: 0, status: "SKIP", skipReason: gate.skipReason };
      results.push(row);
      onResult?.(row, results.length - 1, planned.length);
      continue;
    }
    const out = runner({ gate, repoRoot, env });
    const row = {
      name: gate.id,
      cmd: gate.cmd,
      exit: out.exit,
      durationMs: out.durationMs ?? 0,
      status: out.exit === 0 ? "PASS" : "FAIL",
      skipReason: null,
      ...(out.error ? { error: out.error } : {}),
    };
    results.push(row);
    onResult?.(row, results.length - 1, planned.length);
  }
  return results;
}

/** 汇总：任一 FAIL ⇒ exitCode 1；SKIP 计入并保留原因。 */
export function summarize(results) {
  const count = (s) => results.filter((r) => r.status === s).length;
  const fail = count("FAIL");
  return {
    total: results.length,
    pass: count("PASS"),
    fail,
    skip: count("SKIP"),
    exitCode: fail > 0 ? 1 : 0,
    skipped: results.filter((r) => r.status === "SKIP").map((r) => ({ name: r.name, skipReason: r.skipReason })),
  };
}

/** 解析 CLI 参数（不认识的参数 ⇒ null，由调用方转用法错误）。 */
export function parseArgs(argv) {
  const opts = { list: false, only: null, skip: null, evidence: null, help: false, fast: false };
  for (const arg of argv) {
    if (arg === "--list") opts.list = true;
    else if (arg === "--fast") opts.fast = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("--only=")) opts.only = arg.slice(7).split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith("--skip=")) opts.skip = arg.slice(7).split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith("--evidence=")) opts.evidence = arg.slice(11);
    else return null;
  }
  return opts;
}

export function helpText() {
  return [
    "xh-verify-gates — 一条命令跑完验证窗门集（门清单由 mise.toml / package.json 解析，不硬编码命令）",
    "  node scripts/xh-verify-gates.mjs --list",
    "  node scripts/xh-verify-gates.mjs --fast          # 实施中自查：只跑 <60s 轻门",
    "  node scripts/xh-verify-gates.mjs --skip=test:mock --evidence=.local/evidence/gates.json",
  ].join("\n");
}

function gitCommit(repoRoot) {
  const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  return res.status === 0 ? String(res.stdout ?? "").trim() : null;
}

/** 主流程（可测试）：返回 { exitCode, results, summary }。 */
export function main(argv = process.argv.slice(2), deps = {}) {
  const {
    repoRoot = REPO_ROOT,
    readFile = (p) => readFileSync(p, "utf8"),
    writeFile = (p, t) => writeFileSync(p, t, "utf8"),
    runner = defaultRunner,
    gates = DEFAULT_GATES,
    env = process.env,
    log = (s) => process.stdout.write(`${s}\n`),
    now = () => new Date(),
  } = deps;

  const opts = parseArgs(argv);
  if (!opts) {
    log("用法错误：未知参数。\n" + helpText());
    return { exitCode: 2, results: [], summary: null };
  }
  if (opts.help) {
    log(helpText());
    return { exitCode: 0, results: [], summary: null };
  }

  const miseToml = existsSync(join(repoRoot, "mise.toml")) ? readFile(join(repoRoot, "mise.toml")) : "";
  const pkgJson = existsSync(join(repoRoot, "package.json")) ? readFile(join(repoRoot, "package.json")) : "{}";
  const miseTasks = parseMiseTasks(miseToml);
  const pkgScripts = parsePkgScripts(pkgJson);

  // 门表：默认门（mise）+ 目录里登记的 pkg 门（若 gates 里带 kind:"pkg"）；--fast 只保留轻门
  const selected = [];
  for (const gate of gates) {
    if (opts.only && !opts.only.includes(gate.id)) continue;
    if (opts.fast && (gate.class ?? "fast") === "full") continue;
    selected.push(gate);
  }

  const known = gates.map((g) => g.id);
  const unknown = [...(opts.only ?? []), ...(opts.skip ?? [])].filter((id) => !known.includes(id));
  if (unknown.length) {
    log(`用法错误：未知门 id：${unknown.join(", ")}\n可用门：${known.join(", ")}`);
    return { exitCode: 2, results: [], summary: null };
  }

  const planned = planGates({ gates: selected, miseTasks, pkgScripts, repoRoot }).map((gate) =>
    opts.skip?.includes(gate.id) ? { ...gate, skipReason: "显式 --skip（调用方指定跳过）" } : gate,
  );

  if (opts.list) {
    log(`可用门 ${planned.length} 个（来源：mise.toml / package.json；class: fast=<60s 可随时跑 / full=L2 窗口内跑）`);
    for (const gate of planned) {
      const state = gate.skipReason ? `SKIP: ${gate.skipReason}` : "ready";
      log(`  ${gate.id.padEnd(22)} [${(gate.class ?? "fast").padEnd(4)}] ${gate.cmd.padEnd(34)} ${state}`);
      if (gate.description) log(`  ${" ".repeat(28)} ${gate.description.slice(0, 140)}`);
    }
    return { exitCode: 0, results: [], summary: null };
  }

  log(`xh-verify-gates: ${planned.length} 门${opts.fast ? "（--fast：仅轻门）" : ""}（repo=${repoRoot}）`);
  const startedAt = now();
  const results = runGates({
    planned,
    runner,
    repoRoot,
    env,
    onResult: (row, idx, total) => {
      const ms = `${row.durationMs}ms`;
      if (row.status === "SKIP") log(`[${idx + 1}/${total}] ${row.name} — SKIP (${row.skipReason})`);
      else log(`[${idx + 1}/${total}] ${row.name} — ${row.status} (${ms}${row.status === "FAIL" ? `, exit=${row.exit}` : ""})`);
    },
  });
  const summary = summarize(results);
  const finishedAt = now();

  log("");
  log(`汇总：${summary.total} 门 → PASS ${summary.pass} / FAIL ${summary.fail} / SKIP ${summary.skip}（exit=${summary.exitCode}）`);
  for (const s of summary.skipped) log(`  SKIP ${s.name}: ${s.skipReason}`);
  if (summary.fail) {
    log(`  失败门：${results.filter((r) => r.status === "FAIL").map((r) => `${r.name}(exit=${r.exit})`).join(", ")}`);
  }

  if (opts.evidence) {
    const evidence = {
      schemaVersion: 1,
      tool: "xh-verify-gates",
      generatedAt: finishedAt.toISOString(),
      startedAt: startedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      repoRoot,
      commit: gitCommit(repoRoot),
      only: opts.only,
      skip: opts.skip,
      fast: opts.fast,
      gates: results,
      summary,
    };
    const target = resolve(repoRoot, opts.evidence);
    writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`);
    log(`证据已写入 ${target}`);
  }

  return { exitCode: summary.exitCode, results, summary };
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href;
if (invokedDirectly) {
  const { exitCode } = main();
  process.exit(exitCode);
}
