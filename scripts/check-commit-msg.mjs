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
 *   node scripts/check-commit-msg.mjs --range a632de77..HEAD --report-only # 只打印永不失败（mise 任务用）
 *
 * 退出码：0 通过 / 1 违规 / 2 用法错误
 *
 * 规则（2026-11-06 起）：
 *  - 首行 `<type>(<scope>): <摘要>`；type ∈ feat|fix|docs|test|chore|refactor|perf|build|ci|style|revert
 *  - **摘要显示宽度 ≤72 列**（CJK/全角记 2 列）⇒ 约 ≤36 个汉字；merge 提交 ≤100 列
 *  - 首行不带 emoji、不以句号结尾、不以"更新/修改/调整"这类空词开头
 *  - 空行分隔 body；body 每行 ≤100 列（超过只 warn）
 *  - 非 merge 提交：subject 或 body 必须出现 `PLAN-\d{4}` / `BL-\d{3}` / `D-\d{3}`
 *  - 历史提交豁免：默认只校验 `--since`（默认 `1dd57056`）之后的提交；`--file` 模式不豁免
 */
import { execSync } from "node:child_process";
import fs from "node:fs";

const TYPES = new Set(["feat", "fix", "docs", "test", "chore", "refactor", "perf", "build", "ci", "style", "revert"]);
const SUBJECT_MAX = 72;
const MERGE_MAX = 100;
const BODY_MAX = 100;
const DEFAULT_SINCE = "1dd57056";
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

const argv = process.argv.slice(2);
const get = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const json = argv.includes("--json");
const reportOnly = argv.includes("--report-only");
const stats = argv.includes("--stats");
const file = get("--file");
const range = get("--range");
const since = get("--since") ?? DEFAULT_SINCE;

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
  let raw;
  try {
    raw = execSync(`git log ${span} --pretty=format:%H%x1f%B%x1e`, { encoding: "utf8" });
  } catch (e) {
    console.error(`git log ${span} 失败：${e.message}`);
    process.exit(2);
  }
  const entries = raw.split("\x1e").map((s) => s.trim()).filter(Boolean);
  if (!entries.length) {
    console.log(`[PASS] ${span} 内没有提交（或全部豁免）`);
  }
  let errCount = 0;
  let warnCount = 0, violating = 0;
  const byCode = {};
  for (const e of entries) {
    const [sha, ...rest] = e.split("\x1f");
    const res = checkMessage(rest.join("\x1f"));
    if (res.errors.length) { errCount += res.errors.length; violating++; }
    warnCount += res.warns.length;
    for (const x of res.errors) byCode[x.code] = (byCode[x.code] ?? 0) + 1;
    if (!stats) print(`${sha.slice(0, 8)}`, res, json);
  }
  if (stats) {
    const rate = entries.length ? (violating / entries.length) * 100 : 0;
    console.log(JSON.stringify({ span, commits: entries.length, violating, rate: Number(rate.toFixed(1)), errors: errCount, warns: warnCount, byCode }, null, 2));
  } else if (entries.length) {
    console.log(`\n共 ${entries.length} 条，错误 ${errCount}，警告 ${warnCount}`);
  }
  bad = reportOnly ? 0 : errCount ? 1 : 0;
}
process.exit(bad);
