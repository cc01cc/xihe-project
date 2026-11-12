#!/usr/bin/env node
/**
 * check-commit-msg.mjs — A03 commit message 规范校验（宽度感知）
 *
 * 背景（2026-11-06 用户提问"commit message 是不是越来越狂野"）：实测最近 100 条提交
 * 标题**显示宽度**中位 85、p90 114、最大 162（CJK 记 2 列），71/100 超过 72 列。
 * 旧规则只写在 skill 的 bash 片段里、按**字符数**算 72 ⇒ 中文可以写到 72 个汉字（144 列），
 * 而且没人真的跑那段脚本。本脚本把它变成可执行门禁。
 *
 * 用法：
 *   node scripts/check-commit-msg.mjs --file .git/COMMIT_EDITMSG      # commit-msg hook 用
 *   node scripts/check-commit-msg.mjs --range develop~5..develop     # 复查最近若干条
 *   node scripts/check-commit-msg.mjs --range 1dd57056..HEAD --json
 *   node scripts/check-commit-msg.mjs --range a632de77..HEAD --stats     # 观察窗统计（翻阻断判据）
 *   node scripts/check-commit-msg.mjs --range a632de77..HEAD --enforce   # 显式阻断口径（默认即阻断；
 *       mise run check:commit-msg 走这条，并已是 validate 的依赖，见 D-216）
 *   node scripts/check-commit-msg.mjs --range 1dd57056..HEAD --report-only # 只打印、永不失败（回归/观察用）
 *   node scripts/check-commit-msg.mjs --range HEAD --strict   # ✗ 未知参数 ⇒ exit 2 + usage，不再静默忽略
 *
 * 退出码：0 通过 / 1 违规 / 2 用法错误（含**未知参数**、参数缺值、`--report-only` 与 `--enforce` 同给）
 *         / 2 `git log` 读取失败（fail-closed：读不到提交就报错，**绝不**当成"没提交 ⇒ 通过"）
 *
 * 规则（2026-11-06 起）：
 *  - 首行 `<type>(<scope>): <摘要>`；type ∈ feat|fix|docs|test|chore|refactor|perf|build|ci|style|revert
 *  - **摘要显示宽度 ≤72 列**（CJK/全角记 2 列）⇒ 约 ≤36 个汉字；merge 提交 ≤100 列
 *  - 首行不带 emoji、不以句号结尾、不以"更新/修改/调整"这类空词开头
 *  - 空行分隔 body；body 每行 ≤100 列（超过只 warn）
 *  - 非 merge 提交：subject 或 body 必须出现 `PLAN-\d{4}` / `BL-\d{3}` / `D-\d{3}`
 *  - 历史提交豁免：默认只校验 `--since`（默认 `1dd57056`）之后的提交；`--file` 模式不豁免
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

const TYPES = new Set(["feat", "fix", "docs", "test", "chore", "refactor", "perf", "build", "ci", "style", "revert"]);
const SUBJECT_MAX = 72;
const MERGE_MAX = 100;
const BODY_MAX = 100;
const DEFAULT_SINCE = "1dd57056";
// oxlint-disable-next-line no-misleading-character-class -- U+FE0F（变体选择符）必须留在字符类里：这条正则的用途就是拦首行 emoji，去掉它会让 ✅ / ⚠️ 这类「基字符 + VS16」序列漏检
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
const EMPTY_WORD = /^(更新|修改|调整|优化|处理|完善|整理)/;

/** 显示宽度：CJK / 全角 / 韩文 / 假名 记 2 列 */
const width = (s) =>
  [...s].reduce((n, ch) => n + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1), 0);

function checkMessage(raw) {
  const errors = [];
  const warns = [];
  const text = raw.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const lines = text.split("\n");
  const subject = lines[0] ?? "";
  const body = lines.slice(1).join("\n").trim();
  const isMerge = /^merge(\(|:)/.test(subject) || /^Merge (branch|remote-tracking)/.test(subject);

  // 1. 首行格式
  let m;
  if (isMerge) {
    // 接受三种：`merge(<target>): <摘要>` / `merge: <摘要>` / git 默认 `Merge branch 'x' into y`
    m = subject.match(/^(merge(?:\([A-Za-z0-9._/-]+\))?): (.+)$/) || subject.match(/^Merge (?:branch|remote-tracking branch|pull request) .+$/);
    if (!m) errors.push({ code: "E_SUBJECT_FORMAT", message: "merge 提交应为 `merge(<target>): <摘要>` 或 git 默认的 `Merge branch '<src>' into <dst>`" });
  } else {
    m = subject.match(/^([a-z]+)(?:\(([A-Za-z0-9._/-]+)\))?(!)?: (.+)$/);
    if (!m) {
      errors.push({ code: "E_SUBJECT_FORMAT", message: "首行应为 `<type>(<scope>): <摘要>`（scope 可省）" });
    } else {
      if (!TYPES.has(m[1])) errors.push({ code: "E_BAD_TYPE", message: `type \`${m[1]}\` 不在白名单：${[...TYPES].join("|")}` });
      if (!m[4] || !m[4].trim()) errors.push({ code: "E_EMPTY_SUBJECT", message: "摘要是空的" });
    }
  }

  // 2. 宽度（宽度感知，这是旧规则缺的那一条）
  const limit = isMerge ? MERGE_MAX : SUBJECT_MAX;
  const w = width(subject);
  if (w > limit) {
    errors.push({
      code: "E_SUBJECT_TOO_WIDE",
      message: `首行显示宽度 ${w} 列 > ${limit} 列（CJK 记 2 列；约 ${Math.floor(limit / 2)} 个汉字）。请把细节移到 body。`,
    });
  }

  // 3. 首行杂项
  if (EMOJI.test(subject)) errors.push({ code: "E_EMOJI", message: "首行不要带 emoji（终端/CI 里不可靠）" });
  if (/[。.]$/.test(subject)) errors.push({ code: "E_TRAILING_PERIOD", message: "首行不要以句号结尾" });
  const afterColon = subject.includes(": ") ? subject.slice(subject.indexOf(": ") + 2) : "";
  if (afterColon && EMPTY_WORD.test(afterColon)) {
    errors.push({ code: "E_VAGUE_SUBJECT", message: "摘要不要以「更新/修改/调整/优化/处理/完善/整理」开头，要写清到底改了什么" });
  }

  // 4. 空行分隔
  if (body && lines[1] !== "") warns.push({ code: "W_NO_BLANK_LINE", message: "首行与 body 之间应空一行（部分工具会把它当首行续写）" });

  // 5. body 行宽
  if (body) {
    const wide = lines.slice(1).filter((l) => width(l) > BODY_MAX).length;
    if (wide) warns.push({ code: "W_BODY_TOO_WIDE", message: `body 有 ${wide} 行超过 ${BODY_MAX} 列` });
  }

  // 6. 引用要求
  if (!isMerge) {
    const refs = /(PLAN-\d{4}|BL-\d{3}|D-\d{3})/;
    if (!refs.test(subject) && !refs.test(body)) {
      warns.push({ code: "W_NO_REF", message: "未引用 PLAN-####/BL-###/D-###；如确无关联（纯 chore）可忽略" });
    }
  }

  return { subject, width: w, limit, isMerge, errors, warns };
}

function print(file, res, json) {
  if (json) {
    console.log(JSON.stringify({ file, ...res, ok: res.errors.length === 0 }, null, 2));
    return;
  }
  const tag = res.errors.length ? "FAIL" : "PASS";
  console.log(`[${tag}] ${file}  首行 ${res.width}/${res.limit} 列${res.isMerge ? "（merge）" : ""}`);
  console.log(`        ${res.subject}`);
  for (const e of res.errors) console.log(`  ✗ ${e.code}: ${e.message}`);
  for (const w of res.warns) console.log(`  · ${w.code}: ${w.message}`);
}

/**
 * 参数解析：**白名单 + 硬拒未知参数**。
 *
 * 为什么不能再用 `argv.includes("--xxx")` 逐个探测（2026-11-08 实测缺陷）：
 * 未知参数会被**静默丢掉**，命令照常 PASS。最坏的一种是拼错取值参数 ——
 * `--rang develop..HEAD` 不报错，直接回落到 `--since 1dd57056..HEAD`，
 * 于是**校验的提交集换了一批却仍然报绿**（JSON 里 `span` 会诚实地写着
 * `1dd57056..HEAD`，但没人会去看）。门禁的结论只有在"参数真的按预期生效"时
 * 才有意义，所以这里 fail-closed：认不出的参数一律 exit 2，绝不进入校验流程。
 */
const BOOLEAN_FLAGS = new Map([
  ["--json", "json"],
  ["--report-only", "reportOnly"],
  ["--stats", "stats"],
  ["--enforce", "enforce"],
]);
const VALUE_FLAGS = new Map([
  ["--file", "file"],
  ["--range", "range"],
  ["--since", "since"],
]);
const USAGE =
  "用法: node scripts/check-commit-msg.mjs [--file <路径>] [--range <a..b>] [--since <sha>] [--json] [--stats] [--report-only | --enforce]";

function parseArgs(argv) {
  const opts = { json: false, reportOnly: false, stats: false, enforce: false, file: undefined, range: undefined, since: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const boolKey = BOOLEAN_FLAGS.get(arg);
    if (boolKey) {
      opts[boolKey] = true;
      continue;
    }
    const valKey = VALUE_FLAGS.get(arg);
    if (valKey) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { error: `参数缺值: ${arg}` };
      }
      opts[valKey] = value;
      i++;
      continue;
    }
    return { error: arg.startsWith("-") ? `未知参数: ${arg}` : `未知位置参数: ${arg}` };
  }
  // 两个方向相反的闸同时给 ⇒ 谁赢都说不清，保持 fail-closed：
  // `--report-only` 永不失败、`--enforce` 显式阻断，二者互斥。
  if (opts.reportOnly && opts.enforce) return { error: "参数冲突: --report-only 与 --enforce 不能同时给" };
  return { opts };
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.error) {
  console.error(parsed.error);
  console.error(USAGE);
  process.exit(2);
}
const { json, reportOnly, stats, file, range, enforce } = parsed.opts;
const since = parsed.opts.since ?? DEFAULT_SINCE;

// 显式历史豁免白名单（每条必须带 reason）：用于"合入时才发现违规、且已进 develop 不可改写"的既成事实。
// 禁止批量塞历史提交；新增条目须在台账留痕。
const ALLOWLIST = new Map();
{
  const p = new URL("./commit-msg-allowlist.json", import.meta.url);
  if (fs.existsSync(p)) {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const e of parsed.entries ?? []) ALLOWLIST.set(e.sha, e);
  }
}

/**
 * 逐条**流式**读 `git log <span>` 并回调（task-286）。
 *
 * 病根：原实现 `execSync('git log ...', { encoding: "utf8" })` 用的是 Node 默认
 * `maxBuffer` = 1 MiB；而 `a632de77..HEAD` 实测 **1476 条 / 1 265 619 B（1.21 MiB）**
 * ⇒ `spawnSync … ENOBUFS` ⇒ 门**没检查任何一条**就 `exit 2`（fail-closed，方向对，但等于
 * 这条 validate 依赖长期跑不动）。
 *
 * 为什么**不**改成 `maxBuffer: N`：git 单条消息长度没有上限，"N 多大才够"只能靠
 * "按当前提交数 × 单条实测上限"外推 —— 那不是证明，只是把同一类故障推后（本仓历史
 * 增速下 1 MiB 阈值就是被推着推着撞穿的）。改为按 `--pretty` 自带的记录分隔符
 * U+001E 分帧流式处理：内存只与**单条消息**大小有关（实测最大 3 506 B），与提交数无关，
 * 且没有可撞穿的固定阈值。
 *
 * 语义与旧实现逐项对齐：同样的 `%H%x1f%B%x1e` 格式、同样的 `\x1e` 分帧、同样的
 * `\x1f` 切 sha/正文；git 失败时抛出（调用方打印 `git log <span> 失败：…` 并 exit 2，
 * 与旧实现同一条 fail-closed 路径）。
 *
 * @returns {Promise<number>} 实际回调的提交条数
 */
async function forEachRangeEntry(span, onEntry) {
  const child = spawn("git", ["log", span, "--pretty=format:%H%x1f%B%x1e"], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
  let leftover = "";
  let count = 0;
  const consume = (frame) => {
    const entry = frame.trim();
    if (!entry) return;
    const [sha, ...rest] = entry.split("\x1f");
    count += 1;
    onEntry(sha, rest.join("\x1f"));
  };
  for await (const chunk of child.stdout) {
    leftover += chunk;
    const frames = leftover.split("\x1e");
    leftover = frames.pop() ?? "";
    for (const frame of frames) consume(frame);
  }
  consume(leftover);
  const code = await closed;
  if (code !== 0) throw new Error(stderr.trim().split("\n")[0] || `git 退出码 ${code}`);
  return count;
}

let bad = 0;
if (file) {
  if (!fs.existsSync(file)) {
    console.error(`找不到文件：${file}`);
    process.exit(2);
  }
  const res = checkMessage(fs.readFileSync(file, "utf8"));
  print(file, res, json);
  bad = res.errors.length ? 1 : 0;
} else {
  const span = range ?? `${since}..HEAD`;
  let errCount = 0;
  let warnCount = 0, violating = 0, commits = 0;
  const byCode = {};
  const checkOne = (sha, message) => {
    commits += 1;
    const res = checkMessage(message);
    const allow = ALLOWLIST.get(sha) ?? ALLOWLIST.get(sha.slice(0, 8));
    if (allow) {
      for (const x of res.errors) {
        res.warns.push({ code: "W_GRANDFATHERED", message: `${x.code} 已豁免（${x.message}）：${allow.reason}` });
      }
      res.errors.length = 0;
    }
    if (res.errors.length) { errCount += res.errors.length; violating++; }
    warnCount += res.warns.length;
    for (const x of res.errors) byCode[x.code] = (byCode[x.code] ?? 0) + 1;
    if (!stats) print(`${sha.slice(0, 8)}`, res, json);
  };
  try {
    await forEachRangeEntry(span, checkOne);
  } catch (e) {
    console.error(`git log ${span} 失败：${e.message}`);
    process.exit(2);
  }
  if (!commits) {
    console.log(`[PASS] ${span} 内没有提交（或全部豁免）`);
  }
  if (stats) {
    const rate = commits ? (violating / commits) * 100 : 0;
    console.log(JSON.stringify({ span, commits, violating, rate: Number(rate.toFixed(1)), errors: errCount, warns: warnCount, byCode }, null, 2));
  } else if (commits) {
    console.log(`\n共 ${commits} 条，错误 ${errCount}，警告 ${warnCount}`);
  }
  // 默认即阻断；`--report-only` 是唯一的"永不失败"出口，`--enforce` 只是把这个默认
  // 显式写出来（解析器保证两者不会同时出现，所以这里不必再判"谁赢"）。
  const blocking = enforce || !reportOnly;
  bad = blocking && errCount ? 1 : 0;
}
process.exit(bad);
