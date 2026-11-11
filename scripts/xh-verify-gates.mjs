#!/usr/bin/env node
/**
 * xh-verify-gates — 一条命令跑完验证窗的「门集」（D-772 授权，task-37）。
 * 用法：node scripts/xh-verify-gates.mjs --list|--only=a,b|--skip=c|--fast|--evidence=<path>
 *   --list                 列出可用门（id / SSOT 来源 / 命令 / class / 说明），退出码 0
 *   --only=a,b / --skip=c  只跑 / 跳过指定门（名称 = 门 id，见 --list）；未知 id ⇒ 用法错误 exit 2
 *   --fast                 只跑 class=fast 的轻门（<60s/门，实施中自查用；L2 重门不跑）
 *   --evidence=<path>      落 JSON 证据（每条门的 name/cmd/exit/durationMs/status/skipReason + 汇总）
 *   --strict               门前置不满足时从 SKIP 降级为 FAIL（窗口里宁可红，不要「假绿」）
 *   --since=<ISO8601>      本轮开始时间（默认=本轮启动时刻；用来判报告是否新鲜）
 *   --run-id=<id>          本轮 runId（默认随机生成，也可用 XH_GATE_RUN_ID）；用来绑报告归属
 *   --window=<VW-id>       绑定本轮所属窗口（也可用 XH_WINDOW_ID）；四象限规则：
 *     ① 窗存在 + --run-id 缺省     ⇒ 采用窗 id，输出 window=<VW-id>
 *     ② 窗存在 + --run-id == 窗 id ⇒ 允许，输出 window=<VW-id>
 *     ③ 窗存在 + --run-id != 窗 id ⇒ exit 2，点名两个值（不许拿别轮的报告判本轮）
 *     ④ 窗不存在 + 无 --run-id     ⇒ 自生成，输出 window=none
 *     ⑤ 窗不存在 + 给了 --run-id   ⇒ **不覆盖调用方的值**，仍输出 window=none + 提示「不具窗内效力」
 *   为什么第 ④/⑤ 象限必须显式打 window=none：VW-20261111-09/-10 之前的所有证据都没有窗 id，
 *   若省略该字段或打 '-'，将来会被当成窗内证据引用。**none 是一个断言，不是缺失。**
 *   为什么⑤不覆盖用户值：显式标识属于调用方，工具不改写；「不具窗内效力」由 window=none 表达。
 *   例：node scripts/xh-verify-gates.mjs --fast      # 实施中自查（不含 L2 重门）
 *
 * **输入可信度（BL-528，`check:mock-baseline`）**：不只看报告文件是否存在，还要过三道校验——
 * ①新鲜度（报告 `stats.startTime`/mtime ≥ 本轮 `--since`）②runId/commit 绑定（报告声明的
 * runId 必须等于本轮 runId、commit 必须是 `HEAD`）③归属（报告路径与 `config.rootDir` 必须属于
 * 当前 checkout，并打印所用路径）。不满足默认 **SKIP + 原因**（`stale-report` / `foreign-run` /
 * `foreign-commit` / `foreign-path`），`--strict` 时降级为 **FAIL**。
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
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..");

/** 默认门集：验证窗（W-##）用的那批门。只登记 task 名 + class，命令一律由 SSOT 解析。 */
export const DEFAULT_GATES = [
  { id: "check:types", kind: "mise", class: "fast" },
  { id: "lint:ui", kind: "mise", class: "fast" },
  { id: "check:openapi", kind: "mise", class: "fast" },
  // task-27（task-14 A′）：doc ↔ contract（生成器 --check）此前不在任何门清单里；
  // 需 PyYAML，解释器缺失时按 SKIP 处理（见 PRECONDITIONS["check:api-docs"]）。
  { id: "check:api-docs", kind: "mise", class: "fast" },
  { id: "check:a11y-refs", kind: "mise", class: "fast" },
  { id: "test:ui", kind: "mise", class: "full" },
  { id: "check:mock-baseline", kind: "mise", class: "fast" },
  { id: "test:mock", kind: "mise", class: "full" },
  { id: "check:e2e-bypass", kind: "mise", class: "fast" },
  { id: "check:ports", kind: "mise", class: "fast" },
  { id: "check:event-keys", kind: "mise", class: "fast" },
  // task-27（task-14 A′）：文档链接门也此前不在门清单里（docs/ 与 spec 引用漂移靠人守）。
  { id: "lint:links", kind: "mise", class: "fast" },
  { id: "test:cp:executed", kind: "mise", class: "full" },
  { id: "lint:log-secrets", kind: "mise", class: "fast" },
  // task-105：把梯次实际在跑、但 DEFAULT_GATES 手写表漏登记的门补齐（原为 B 类漂移）。
  { id: "lint:scripts", kind: "mise", class: "fast" },
  { id: "lint:i18n", kind: "mise", class: "fast" },
  { id: "lint:e2e", kind: "mise", class: "fast" },
  { id: "test:e2e:fixtures", kind: "mise", class: "fast" },
  { id: "check:a11y-refs:enforce", kind: "mise", class: "fast" },
  { id: "lint:cp", kind: "mise", class: "fast" },
  { id: "lint:agent", kind: "mise", class: "fast" },
  { id: "lint:runtime", kind: "mise", class: "fast" },
  { id: "test:agent", kind: "mise", class: "full" },
  { id: "docs:api:html", kind: "mise", class: "fast" },
  { id: "test:runtime:lib", kind: "mise", class: "fast" },
  { id: "check:branch-scope", kind: "mise", class: "fast" },
  { id: "test:cp", kind: "mise", class: "full" },
];

/** 这些门需要 `packages/ui` 的依赖；worktree 里通常没有 node_modules ⇒ 显式 SKIP 并给原因。 */
const NEEDS_UI_DEPS = new Set(["check:types", "lint:ui", "test:ui", "test:mock"]);

/**
 * 输入前置门：缺输入/输入不可信时**显式 SKIP 并说明补齐方式**（绝不静默通过，也不把「缺输入」
 * 误报成产品红）。语义区分：缺输入/输入不可信 = SKIP；命令跑了但判据不满足 = FAIL。
 *
 * BL-528：`check:mock-baseline` 原先只查「报告文件存在」，于是**别的窗口留下的旧报告**照样判绿
 * （W-24 实测：槽里躺着 17 分钟前的报告）。现在它必须过三道校验，见 `checkMockBaselineReport()`。
 */
const PRECONDITIONS = {
  "lint:log-secrets": {
    evaluate: ({ repoRoot }) =>
      existsSync(join(repoRoot, "logs"))
        ? { ok: true }
        : { ok: false, code: "missing-input", reason: "缺少 logs/（本 worktree 无运行日志；在窗口里用主检出的 logs/ 或先起栈产生日志再跑）" },
  },
  "check:mock-baseline": {
    evaluate: (ctx) => checkMockBaselineReport(ctx),
  },
  // task-27：`check:api-docs` 要 PyYAML。解释器缺失 = **环境缺输入 ⇒ SKIP**（写明补齐方式），
  // 不折成产品红；`--strict` 时由 planGates 降级为 FAIL（窗口里不允许假绿）。
  // 候选顺序与 `A03-xihe/scripts/gen-api-docs.mjs` 一致：XH_PYTHON → .venv/Scripts/python.exe → .venv/bin/python。
  "check:api-docs": {
    evaluate: ({ repoRoot }) => {
      const candidates = [
        process.env.XH_PYTHON,
        join(repoRoot, "packages", "agent", ".venv", "Scripts", "python.exe"),
        join(repoRoot, "packages", "agent", ".venv", "bin", "python"),
      ].filter(Boolean);
      const hit = candidates.find((p) => existsSync(p));
      return hit
        ? { ok: true, python: hit }
        : {
            ok: false,
            code: "missing-input",
            reason:
              "找不到带 PyYAML 的 Python 解释器（候选 XH_PYTHON / packages/agent/.venv/Scripts/python.exe / .venv/bin/python 全缺）" +
              " ⇒ 本 checkout 跑不了 check:api-docs：在主检出跑，或带 XH_PYTHON=<主检出>/packages/agent/.venv/Scripts/python.exe 重跑（exit 2 是环境，不是产品红）",
          };
    },
  },
};

/** Playwright JSON 报告里可能出现「本轮身份」的字段名（不同 reporter / 自定义 metadata 都兼容）。 */
const REPORT_RUN_ID_KEYS = ["runId", "run_id", "XIHE_E2E_RUN_ID"];
const REPORT_COMMIT_KEYS = ["commit", "gitHead", "head", "headCommit", "XIHE_E2E_EXPECT_CP_COMMIT"];

/**
 * `check:mock-baseline` 输入可信度校验（BL-528）：**新鲜度 / runId+commit 绑定 / 归属**三道，缺一不可。
 *
 * 单看「文件存在」= 假绿通道：旧报告在、计数也过，但被测的不是本轮代码。所以：
 * 1. **新鲜度**：报告时间必须 ≥ 本轮 `since`（`stats.startTime` 优先，退文件 mtime）；否则 `stale-report`。
 * 2. **绑定**：报告里若有 runId/commit 字段，必须等于本轮 runId / `HEAD`；不一致 ⇒ `stale-report`/`foreign-run`。
 *    （报告没有这些字段时退化为「新鲜度 + 归属」判定，并在结论里写明 —— 不假装校验过。）
 * 3. **归属**：报告路径必须在当前 checkout 内（`config.rootDir` 若存在也必须等于它），打印所用路径。
 *
 * @param {{repoRoot: string, since: number, runId?: string|null, head?: string|null, reportPath?: string, readFile?: Function, statFile?: Function}} ctx
 * @returns {{ok: true, path: string, mtimeIso: string, binding: string} | {ok: false, code: string, reason: string, path?: string}}
 */
export function checkMockBaselineReport(ctx) {
  const {
    repoRoot,
    since,
    runId = null,
    head = null,
    reportPath = join(repoRoot, "packages", "ui", "e2e", ".mock-report.json"),
    readFile = (p) => readFileSync(p, "utf8"),
    statFile = (p) => statSync(p),
  } = ctx;

  if (!existsSync(reportPath)) {
    return {
      ok: false,
      code: "missing-input",
      reason: "缺少 packages/ui/e2e/.mock-report.json（先跑 test:mock 产出报告，再跑本门；属 L2 窗口流程）",
    };
  }

  // ③ 归属：路径必须落在当前 checkout 内（Windows 大小写/分隔符归一后再比）
  const norm = (p) => resolve(p).replace(/\\/g, "/").toLowerCase();
  const root = norm(repoRoot);
  const path = norm(reportPath);
  if (path !== root && !path.startsWith(`${root}/`)) {
    return { ok: false, code: "foreign-path", reason: `报告不在当前 checkout 内：${reportPath}（禁止跨槽复用）`, path: reportPath };
  }

  let report = null;
  try {
    report = JSON.parse(readFile(reportPath));
  } catch (error) {
    return { ok: false, code: "unreadable", reason: `报告无法解析（${error?.message ?? error}）：${reportPath}`, path: reportPath };
  }

  // ① 新鲜度：stats.startTime 优先（Playwright 自带），退文件 mtime
  const startedAtRaw = report?.stats?.startTime ?? report?.startTime ?? null;
  const startedAt = startedAtRaw ? Date.parse(startedAtRaw) : NaN;
  const mtimeMs = Number.isFinite(startedAt) ? startedAt : statFile(reportPath).mtimeMs;
  const mtimeIso = new Date(mtimeMs).toISOString();
  if (!Number.isFinite(mtimeMs)) {
    return { ok: false, code: "unreadable", reason: `报告没有可解析的 startTime 且读不到 mtime：${reportPath}`, path: reportPath };
  }
  if (since != null && Number.isFinite(since) && mtimeMs < since) {
    return {
      ok: false,
      code: "stale-report",
      reason: `报告时间 ${mtimeIso} 早于本轮开始 ${new Date(since).toISOString()}（${Math.round((since - mtimeMs) / 1000)}s 之前；旧报告禁止判绿）`,
      path: reportPath,
    };
  }

  // ② 绑定：报告若声明了本轮身份，就必须与本次 run/HEAD 一致
  const pick = (keys, sources) => {
    for (const source of sources) {
      for (const key of keys) {
        const value = source?.[key];
        if (typeof value === "string" && value.trim() !== "") return value.trim();
      }
    }
    return null;
  };
  const sources = [report, report?.metadata, report?.stats, report?.config];
  const reportRunId = pick(REPORT_RUN_ID_KEYS, sources);
  const reportCommit = pick(REPORT_COMMIT_KEYS, sources);

  if (runId && reportRunId && reportRunId !== runId) {
    return {
      ok: false,
      code: "foreign-run",
      reason: `runId 不匹配：报告 runId=${reportRunId}，本轮 runId=${runId}（禁止拿别轮的报告判本轮）`,
      path: reportPath,
    };
  }
  if (head && reportCommit && !head.startsWith(reportCommit) && !reportCommit.startsWith(head)) {
    return {
      ok: false,
      code: "foreign-commit",
      reason: `commit 不匹配：报告 commit=${reportCommit}，HEAD=${head}（报告不是本轮代码产生的）`,
      path: reportPath,
    };
  }
  // 归属②：报告自报的 rootDir 也要对得上（有的 reporter 会把 cwd 写进去）
  const reportRoot = typeof report?.config?.rootDir === "string" ? report.config.rootDir : null;
  if (reportRoot && norm(reportRoot) !== root) {
    return {
      ok: false,
      code: "foreign-path",
      reason: `报告 config.rootDir=${reportRoot} 不属于当前 checkout ${repoRoot}（禁止跨槽复用）`,
      path: reportPath,
    };
  }

  const bound = [reportRunId ? `runId=${reportRunId}` : null, reportCommit ? `commit=${reportCommit}` : null].filter(Boolean);
  return {
    ok: true,
    path: reportPath,
    mtimeIso,
    binding: bound.length ? bound.join(" ") : "报告无 runId/commit 字段，仅按新鲜度+归属判定",
  };
}

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
    if (line.startsWith('[')) {
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
/**
 * 四象限窗口解析（纯函数，供 --window/--run-id 绑定与自测使用）。
 * window 恒为字符串：窗 id 或 "none"（**从不返回空/"-"**）。
 */
export function resolveWindow({ activeWindowIds = [], windowId = null, runId = null } = {}) {
  const active = activeWindowIds.filter(Boolean);
  if (active.length) {
    const target = windowId ?? active[0];
    if (!active.includes(target)) return { ok: false, code: 2, message: `--window=${target} 不在当前活动窗里（active=${active.join(", ")}）` };
    if (runId && runId !== target) return { ok: false, code: 2, message: `--run-id=${runId} 与窗 ${target} 不一致：窗内跑必须相等（禁止拿别轮的报告判本轮）` };
    return { ok: true, window: target, effectiveRunId: target, note: null };
  }
  return {
    window: "none",
    ok: true,
    effectiveRunId: runId ?? null,
    note: runId
      ? `窗外临时跑（window=none）：--run-id=${runId} 保留调用方取值，不做覆盖；该轮证据不具窗内效力`
      : "窗外临时跑（window=none）：run-id 自生成，该轮证据不具窗内效力",
  };
}
export function planGates({ gates = DEFAULT_GATES, miseTasks, pkgScripts = new Map(), repoRoot = REPO_ROOT, preconditionContext = {} }) {
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
      if (precondition) {
        const verdict = precondition.evaluate({ ...preconditionContext, repoRoot });
        if (!verdict.ok) {
          const strict = Boolean(preconditionContext.strict);
          // BL-528：默认 SKIP（进汇总、必带原因）；`--strict` 时降级为 FAIL，避免「窗口里假绿」。
          return {
            ...gate,
            cmd: `mise run ${gate.id}`,
            source: "mise.toml",
            description: task.description,
            ...(strict ? { preflightFailure: `${verdict.code}: ${verdict.reason}` } : { skipReason: `${verdict.code}: ${verdict.reason}` }),
          };
        }
        return {
          ...gate,
          cmd: `mise run ${gate.id}`,
          source: "mise.toml",
          description: task.description,
          precondition: verdict,
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
    if (gate.preflightFailure) {
      // BL-528 `--strict`：前置不满足从 SKIP 降级为 FAIL（窗口里宁可红，不要假绿）
      const row = {
        name: gate.id,
        cmd: gate.cmd,
        exit: null,
        durationMs: 0,
        status: "FAIL",
        skipReason: null,
        detail: gate.preflightFailure,
      };
      results.push(row);
      onResult?.(row, results.length - 1, planned.length);
      continue;
    }
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
      ...(gate.precondition ? { precondition: gate.precondition } : {}),
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
  const opts = { list: false, only: null, skip: null, evidence: null, help: false, fast: false, strict: false, since: null, runId: null };
  for (const arg of argv) {
    if (arg === "--list") opts.list = true;
    else if (arg === "--fast") opts.fast = true;
    else if (arg === "--strict") opts.strict = true;
    else if (arg.startsWith("--since=")) opts.since = arg.slice(8);
    else if (arg.startsWith("--run-id=")) opts.runId = arg.slice(9);
  else if (arg.startsWith("--window=")) opts.window = arg.slice(9);
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
    "  node scripts/xh-verify-gates.mjs --strict        # 前置不满足 ⇒ FAIL（默认 SKIP + 原因）",
    "  node scripts/xh-verify-gates.mjs --list --window=<VW-id>   # 绑定窗口（四象限见下）",
    "  --window 四象限：① 窗存在+缺省⇒采用窗 id ② == 窗 id⇒允许 ③ != ⇒ exit 2（点名两个值）",
    "                   ④ 无窗⇒window=none（**断言不是缺失**：-09/-10 前证据无窗 id，省略会被误当窗内证据）",
    "                   ⑤ 无窗但给了 --run-id ⇒ 不覆盖调用方值，仍 window=none + 「不具窗内效力」提示",
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

  // BL-528：门的输入可信度需要「本轮身份」——开始时间 / runId / HEAD 三者一起传下去。
  // `since` 默认=本轮启动时刻（同一次 `xh-verify-gates` 里 test:mock 先跑、本门后跑 ⇒ 报告自然更新）；
  // 单独跑本门（如 `mise run check:mock-baseline`）时必须由调用方给 `--since` / `XH_GATE_SINCE`。
  const startedAtMs = Number(now());
  const sinceRaw = opts.since ?? env.XH_GATE_SINCE ?? null;
  const sinceMs = sinceRaw ? Date.parse(sinceRaw) : startedAtMs;
  if (sinceRaw && !Number.isFinite(sinceMs)) {
    log(`用法错误：--since / XH_GATE_SINCE 不是可解析的时间（${sinceRaw}）；用 ISO 8601，如 2026-11-09T21:00:00+08:00`);
    return { exitCode: 2, results: [], summary: null };
  }
  const winIds = (() => {
    try {
      const ledPath = env.XH_WINDOW_LEDGER ?? join(repoRoot, "..", "internal", "A03-xihe", "scripts", "windows.json");
      const led = JSON.parse(readFileSync(ledPath, "utf8"));
      return (led.windows ?? []).filter((w) => w.status === "active").map((w) => w.id);
    } catch { return []; }
  })();
  const winRes = resolveWindow({ activeWindowIds: winIds, windowId: opts.window ?? env.XH_WINDOW_ID ?? null, runId: opts.runId ?? env.XH_GATE_RUN_ID ?? null });
  if (!winRes.ok) { log(`用法错误：${winRes.message}`); return { exitCode: winRes.code, results: [], summary: null }; }
  const runId = winRes.effectiveRunId ?? randomUUID();
  if (winRes.note) log(winRes.note);
  log(`window=${winRes.window} run-id=${runId}`);
  // task-104 债②：把本轮 runId 注入环境，让 test:cp → mvn → surefire → 被测 runtime 继承，
  // 容器才会带 xihe.e2e.run-id 标签（workspace.rs:250 仅在 env 存在时才写）。
  // 调用方显式给值时不动（显式标识属于调用方，同 --run-id 口径）。
  if (!env.XIHE_E2E_RUN_ID) process.env.XIHE_E2E_RUN_ID = runId;
  log(`XIHE_E2E_RUN_ID=${process.env.XIHE_E2E_RUN_ID}（容器标签来源，task-104 债②）`);
  const head = gitCommit(repoRoot);

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

  const planned = planGates({
    gates: selected,
    miseTasks,
    pkgScripts,
    repoRoot,
    preconditionContext: { since: sinceMs, runId, head, strict: opts.strict },
  }).map((gate) => (opts.skip?.includes(gate.id) ? { ...gate, skipReason: "显式 --skip（调用方指定跳过）" } : gate));

  if (opts.list) {
    const ladder = (() => { try { return JSON.parse(readFileSync(join(repoRoot, "scripts/gate-ladder.json"), "utf8")).gates ?? []; } catch { return []; } })();
    log(`可用门 ${planned.length} 个（SSOT=${DEFAULT_GATES.length} 条 @ 本次读取；梯次声明 ${ladder.length} 条 @ scripts/gate-ladder.json；class: fast=<60s / full=L2 窗口内跑）`);
    for (const gate of planned) {
      const inLadder = ladder.includes(gate.id);
      const winCol = inLadder ? `window:${winRes.window}` : "window:not-in-window";
      const ssotCol = DEFAULT_GATES.some((g) => g.id === gate.id) ? "ssot:是" : "ssot:否";
      const state = gate.preflightFailure
        ? `FAIL(--strict): ${gate.preflightFailure}`
        : gate.skipReason
          ? `SKIP: ${gate.skipReason}`
          : "ready";
      log(`  ${gate.id.padEnd(22)} [${(gate.class ?? "fast").padEnd(4)}] ${winCol.padEnd(22)} ${ssotCol.padEnd(20)} ${gate.cmd.padEnd(30)} ${state}`);
      if (gate.description) log(`  ${" ".repeat(28)} ${gate.description.slice(0, 140)}`);
    }
    return { exitCode: 0, results: [], summary: null };
  }

  log(
    `xh-verify-gates: ${planned.length} 门${opts.fast ? "（--fast：仅轻门）" : ""}（repo=${repoRoot}，`
      + `runId=${runId}，since=${new Date(sinceMs).toISOString()}，HEAD=${head ? head.slice(0, 12) : "unknown"}）`,
  );
  // BL-528：把「本门用的是哪份输入」打出来（报告路径 + 时间 + 绑定），窗口证据里能复查。
  for (const gate of planned) {
    if (!gate.precondition?.ok) continue;
    log(
      `  输入校验 ${gate.id}: path=${gate.precondition.path} mtime=${gate.precondition.mtimeIso} `
        + `binding=${gate.precondition.binding}`,
    );
  }
  const startedAt = now();
  const results = runGates({
    planned,
    runner,
    repoRoot,
    env,
    onResult: (row, idx, total) => {
      const ms = `${row.durationMs}ms`;
      if (row.status === "SKIP") log(`[${idx + 1}/${total}] ${row.name} — SKIP (${row.skipReason})`);
      else if (row.detail) log(`[${idx + 1}/${total}] ${row.name} — FAIL (前置不满足, --strict: ${row.detail})`);
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
      strict: opts.strict,
      runId,
      since: new Date(sinceMs).toISOString(),
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
