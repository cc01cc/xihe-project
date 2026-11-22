#!/usr/bin/env node
// task-848：L2 分阶段执行器 —— 让「只重跑失败步」从口头口径变成可执行机制。
//
// 事实（Lead 实测，run2..run12 共 14 组日志）：每组 head 都不同，而 W3 要求证据 head 与当前
// HEAD 同源，于是每合一批卡就从 build 重跑全量（build 32 s / test 662 s / typecheck 12 s /
// lint 25 s / host 1707 s / host-approval 85 s ≈ 42 min，host 占 68%）。run10 失败在 test、
// run11 在 lint、run12 在 host —— 每次都把前面已通过的段重新付一遍。
//
// 本文件只做调度与缓存，不改变任何门的语义：命中缓存的前提是**同一个 git HEAD** + **同一条命令**
// + **上次 exit=0**，三者缺一即重跑。收口仍要求六步全绿（--only 只服务实施期定位）。
//
// 跑法：
//   node scripts/run-l2-stages.mjs                       # 六步全跑，失败即停
//   node scripts/run-l2-stages.mjs --from test           # 从 test 起（build 命中缓存则跳过）
//   node scripts/run-l2-stages.mjs --only build,test     # 仅实施期定位用
//   node scripts/run-l2-stages.mjs --list                # 打印阶段顺序与命令
//
// 缓存：<evidence-dir>/.cache/<head>.json，逐节点 record `{key, command, exit, seconds, log}`。
// key = sha256(命令 argv JSON)，故改命令（如 host 的 --output 目录）即自然失效。
//
// 结果文件名（W3 契约）：只有**六步全跑**才写 `run<N>-results.json`；`--only` / `--from`
// 的缺步跑写 `run<N>-partial-<slug>.json`。xh-mvp-verify 的 findLatestRun 只认
// `^run(\d+)-results\.json$`，部分跑若占规范名会把 W3 判成 UNMEASURED（缺步骤记录）。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ONE_ROOT = path.resolve(REPO_ROOT, "..");
const DEFAULT_EVIDENCE_DIR = path.join(
  ONE_ROOT,
  "internal/A03-xihe/evidence/2026-11-22-l2-full",
);

export const STAGE_ORDER = [
  "build",
  "test",
  "typecheck",
  "lint",
  "host-e2e",
  "host-approval",
];

// 与 .tmp/run13-l2.ps1 保持一致（含 host 的 batch/output），改动须同步 runbook。
export const STAGE_COMMANDS = {
  build: ["mise", "run", "build"],
  test: ["mise", "run", "test"],
  typecheck: ["mise", "run", "typecheck"],
  lint: ["mise", "run", "lint"],
  "host-e2e": [
    "mise",
    "run",
    "test:e2e:host",
    "--",
    "--batch=real-full",
    "--output",
    "test-results/lane-run13",
  ],
  "host-approval": [
    "mise",
    "run",
    "test:e2e:host",
    "--",
    "--batch=approval",
    "--output",
    "test-results/lane-run13-approval",
  ],
};

function usage(exitCode = 0) {
  const lines = [
    "用法: node scripts/run-l2-stages.mjs [选项]",
    "",
    "  --only a,b,c       只跑这些阶段（按给定顺序；默认六步全跑）",
    "  --from <stage>     从该阶段起跑后续（缓存命中的前序阶段自动跳过）",
    "  --run <n>          结果编号（默认取下一个未占用的规范编号）",
    "  --out <file>       结果 JSON 路径；部分跑不得占用 run<n>-results.json",
    "  --cache-dir <dir>  缓存目录（默认 <evidence-dir>/.cache）",
    "  --log-dir <dir>    每步日志目录（默认 <evidence-dir>）",
    "  --evidence-dir <d> 证据根（默认 internal/A03-xihe/evidence/2026-11-22-l2-full）",
    "  --restart-stack    有 host 步需要真跑时，先 dev-stack stop/start --stack 2 --with-pg",
    "  --require-clean    A03 worktree 有未提交改动则直接退出（W3 取证建议开）",
    "  --head <sha>       反证钩子：覆盖 head（默认 git rev-parse HEAD），仅用于缓存失效验证",
    "  --set-cmd s=cmd    反证钩子：覆盖某阶段本次命令（可重复），仅用于真实分支反证",
    "  --list             打印阶段顺序与命令",
    "  --help             本帮助",
    "",
    `阶段顺序: ${STAGE_ORDER.join(" -> ")}`,
  ];
  console.log(lines.join("\n"));
  process.exitCode = exitCode;
}

function parseArgs(argv) {
  const opts = {
    only: null,
    from: null,
    run: null,
    out: null,
    cacheDir: null,
    logDir: null,
    evidenceDir: DEFAULT_EVIDENCE_DIR,
    restartStack: false,
    requireClean: false,
    head: null,
    setCmds: {},
  };
  const need = (i, name) => {
    if (i + 1 >= argv.length) {
      console.error(`E_USAGE: ${name} 需要参数`);
      usage(2);
      throw new Error("usage");
    }
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        usage(0);
        throw new Error("help");
      case "--list":
        for (const name of STAGE_ORDER) {
          console.log(`${name}\t${STAGE_COMMANDS[name].join(" ")}`);
        }
        throw new Error("list");
      case "--only":
        opts.only = need(i, arg).split(",").map((s) => s.trim()).filter(Boolean);
        i += 1;
        break;
      case "--from":
        opts.from = need(i, arg).trim();
        i += 1;
        break;
      case "--run":
        opts.run = Number.parseInt(need(i, arg), 10);
        i += 1;
        break;
      case "--out":
        opts.out = path.resolve(need(i, arg));
        i += 1;
        break;
      case "--cache-dir":
        opts.cacheDir = path.resolve(need(i, arg));
        i += 1;
        break;
      case "--log-dir":
        opts.logDir = path.resolve(need(i, arg));
        i += 1;
        break;
      case "--evidence-dir":
        opts.evidenceDir = path.resolve(need(i, arg));
        i += 1;
        break;
      case "--restart-stack":
        opts.restartStack = true;
        break;
      case "--require-clean":
        opts.requireClean = true;
        break;
      case "--head":
        opts.head = need(i, arg).trim();
        i += 1;
        break;
      case "--set-cmd": {
        const pair = need(i, arg);
        const at = pair.indexOf("=");
        if (at <= 0) {
          console.error(`E_USAGE: --set-cmd 期望 stage=command，收到 ${pair}`);
          usage(2);
          throw new Error("usage");
        }
        opts.setCmds[pair.slice(0, at)] = pair.slice(at + 1);
        i += 1;
        break;
      }
      default:
        console.error(`E_USAGE: 未知参数 ${arg}`);
        usage(2);
        throw new Error("usage");
    }
  }
  return opts;
}

function run(command, args, { cwd, logFile, shell = false }) {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "w");
  const started = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    cwd,
    shell,
    stdio: ["ignore", fd, fd],
    env: process.env,
    windowsHide: true,
  });
  closeSync(fd);
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  const exit = result.error ? 127 : (result.status ?? 1);
  return { exit, seconds: Math.round(seconds * 10) / 10, error: result.error };
}

function git(args, cwd = REPO_ROOT) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${(res.stderr || "").trim()}`);
  }
  return res.stdout.trim();
}

function commandSummary(spec) {
  if (spec.shell) return spec.command;
  return [spec.command, ...spec.args].join(" ");
}

function commandKey(spec) {
  const material = spec.shell
    ? ["shell", spec.command]
    : [spec.command, ...spec.args];
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

function readCache(file) {
  if (!existsSync(file)) return { version: 1, stages: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.stages) {
      return { version: 1, stages: {} };
    }
    return parsed;
  } catch {
    // 坏缓存只该导致重跑，不应阻断取证。
    console.error(`WARN: 缓存文件不可解析，按空缓存处理：${file}`);
    return { version: 1, stages: {} };
  }
}

function writeCache(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // 清理失败不掩盖原始错误
    }
    throw err;
  }
}

function nextRunNumber(evidenceDir) {
  if (!existsSync(evidenceDir)) return 13;
  let max = 0;
  for (const name of readdirSync(evidenceDir)) {
    const m = CANONICAL_RUN_RE.exec(name);
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return max + 1;
}

const CANONICAL_RUN_RE = /^run(\d+)-results\.json$/;

export function isFullStageSet(stages) {
  const set = new Set(stages);
  return STAGE_ORDER.every((name) => set.has(name));
}

function partialSlug(opts, stages) {
  const parts = [];
  if (opts.from) parts.push(`from-${opts.from}`);
  if (opts.only) parts.push(`only-${stages.join("-")}`);
  return parts.length ? parts.join("_") : "partial";
}

function selectStages(opts) {
  let selected = opts.only ? [...opts.only] : [...STAGE_ORDER];
  for (const name of selected) {
    if (!STAGE_ORDER.includes(name)) {
      console.error(`E_USAGE: 未知阶段 ${name}（可选：${STAGE_ORDER.join(",")}）`);
      usage(2);
      process.exit(2);
    }
  }
  if (opts.from) {
    const idx = STAGE_ORDER.indexOf(opts.from);
    if (idx < 0) {
      console.error(`E_USAGE: --from 未知阶段 ${opts.from}`);
      usage(2);
      process.exit(2);
    }
    const allowed = new Set(STAGE_ORDER.slice(idx));
    selected = selected.filter((name) => allowed.has(name));
    if (selected.length === 0) {
      console.error(`E_USAGE: --from ${opts.from} 与 --only 无交集`);
      process.exit(2);
    }
  }
  return selected;
}

function stageSpec(name, opts) {
  const override = opts.setCmds[name];
  if (override !== undefined) {
    return { command: override, args: [], shell: true, overridden: true };
  }
  const [command, ...args] = STAGE_COMMANDS[name];
  return { command, args, shell: false, overridden: false };
}

function toOneRelative(file) {
  const rel = path.relative(ONE_ROOT, file);
  return rel.split(path.sep).join("/");
}

export function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch {
    return;
  }

  const stages = selectStages(opts);
  const evidenceDir = opts.evidenceDir;
  if (!existsSync(evidenceDir)) {
    console.error(
      `E_EVIDENCE_DIR: 不存在 ${evidenceDir}（worktree 下请显式 --evidence-dir）`,
    );
    process.exitCode = 2;
    return;
  }
  const cacheDir = opts.cacheDir ?? path.join(evidenceDir, ".cache");
  const logDir = opts.logDir ?? evidenceDir;
  const runNo = opts.run ?? nextRunNumber(evidenceDir);
  const full = isFullStageSet(stages);
  const canonicalName = `run${runNo}-results.json`;
  let outFile;
  if (opts.out) {
    if (!full && CANONICAL_RUN_RE.test(path.basename(opts.out))) {
      console.error(
        `E_PARTIAL_CANONICAL: 六步不全的跑不得写 ${path.basename(opts.out)}` +
          "（会污染 W3 证据选取）；请改用 run<N>-partial-<slug>.json",
      );
      process.exitCode = 2;
      return;
    }
    outFile = opts.out;
  } else {
    outFile = full
      ? path.join(evidenceDir, canonicalName)
      : path.join(evidenceDir, `run${runNo}-partial-${partialSlug(opts, stages)}.json`);
  }

  if (opts.requireClean) {
    const dirty = git(["status", "--porcelain"]);
    if (dirty) {
      console.error("E_DIRTY: A03 worktree 有未提交改动，W3 取证要求冻结：");
      console.error(dirty);
      process.exitCode = 3;
      return;
    }
  }

  const head = opts.head ?? git(["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(head)) {
    console.error(`E_HEAD: 非法 head ${head}`);
    process.exitCode = 2;
    return;
  }

  const specs = Object.fromEntries(stages.map((name) => [name, stageSpec(name, opts)]));
  const cacheFile = path.join(cacheDir, `${head}.json`);
  const cache = readCache(cacheFile);
  cache.head = head;
  cache.version = cache.version ?? 1;

  const plan = stages.map((name) => {
    const spec = specs[name];
    const key = commandKey(spec);
    const entry = cache.stages?.[name];
    const cached = Boolean(entry && entry.exit === 0 && entry.key === key);
    return { name, spec, key, cached, entry };
  });

  const startedAt = new Date().toISOString();
  const steps = [];
  let failed = null;
  let stackRestarted = false;

  console.log(`HEAD=${head}${opts.head ? " (override)" : ""}`);
  console.log(`stages=${stages.join(",")}  cache=${toOneRelative(cacheFile)}`);
  if (!full) {
    console.log(
      `partial run: 不写 ${canonicalName}（W3 只认六步全跑结果）→ ${path.basename(outFile)}`,
    );
  }

  for (const item of plan) {
    const { name, spec, key, cached, entry } = item;
    if (cached) {
      console.log(
        `[cached] ${name}  exit=0  ${entry.seconds}s  ${commandSummary(spec)}`,
      );
      steps.push({
        name,
        exit: 0,
        verdict: "PASS",
        seconds: entry.seconds,
        cached: true,
        command: commandSummary(spec),
        log: entry.log,
      });
      continue;
    }

    if (name === "host-e2e" && opts.restartStack && !stackRestarted) {
      stackRestarted = true;
      console.log("[stack] dev-stack stop/start --stack 2 --with-pg");
      const stop = run(
        "node",
        ["scripts/dev-stack.mjs", "stop", "--stack", "2"],
        { cwd: REPO_ROOT, logFile: path.join(logDir, `run${runNo}-stack-stop.log`) },
      );
      const start = run(
        "node",
        [
          "scripts/dev-stack.mjs",
          "start",
          "--stack",
          "2",
          "--with-pg",
          "--timeout",
          "900",
        ],
        { cwd: REPO_ROOT, logFile: path.join(logDir, `run${runNo}-stack-start.log`) },
      );
      const stackSeconds = Math.round((stop.seconds + start.seconds) * 10) / 10;
      const stackExit = stop.exit !== 0 ? stop.exit : start.exit;
      steps.push({
        name: "stack",
        exit: stackExit,
        verdict: stackExit === 0 ? "PASS" : "FAIL",
        seconds: stackSeconds,
        cached: false,
        command: "node scripts/dev-stack.mjs stop/start --stack 2 --with-pg",
        log: toOneRelative(path.join(logDir, `run${runNo}-stack-start.log`)),
      });
      if (stackExit !== 0) {
        failed = "host-e2e";
        console.error(`\nSTOP at stack (exit ${stackExit}); host 步未开始。`);
        break;
      }
    }

    const logFile = path.join(logDir, `run${runNo}-${name}.log`);
    console.log(`[run]    ${name}  ${commandSummary(spec)}`);
    const result = run(spec.command, spec.args, {
      cwd: REPO_ROOT,
      logFile,
      shell: spec.shell,
    });
    if (result.error) {
      console.error(`WARN: 进程启动失败（按 exit 127 记）：${result.error.message}`);
    }
    cache.stages = cache.stages ?? {};
    cache.stages[name] = {
      key,
      command: commandSummary(spec),
      exit: result.exit,
      seconds: result.seconds,
      log: toOneRelative(logFile),
      finishedAt: new Date().toISOString(),
    };
    writeCache(cacheFile, cache);
    steps.push({
      name,
      exit: result.exit,
      verdict: result.exit === 0 ? "PASS" : "FAIL",
      seconds: result.seconds,
      cached: false,
      command: commandSummary(spec),
      log: toOneRelative(logFile),
    });
    console.log(`         -> exit=${result.exit} ${result.seconds}s`);
    if (result.exit !== 0) {
      failed = name;
      break;
    }
  }

  const finishedAt = new Date().toISOString();
  const results = {
    task: "task-848",
    run: runNo,
    head,
    headSource: opts.head ? "override" : "git",
    command: ["node scripts/run-l2-stages.mjs", ...argv].join(" "),
    mode: { only: opts.only, from: opts.from },
    partial: !full,
    stageSet: stages,
    startedAt,
    finishedAt,
    worktreeAtStart: opts.requireClean ? "clean" : "not-checked",
    complete: failed === null && stages.every((name) =>
      steps.some((s) => s.name === name && s.exit === 0),
    ),
    nextFrom: failed,
    steps,
  };
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  console.log(`results -> ${toOneRelative(outFile)}`);

  if (failed) {
    console.error(
      `\nSTOP at stage '${failed}'; later stages not run.\n` +
        `下一步应跑: node scripts/run-l2-stages.mjs --from ${failed}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log("ALL STAGES PASS");
}

main();
