#!/usr/bin/env node
/**
 * check-surefire-skips.mjs — task-618：把「静默 skip」变成可判的红。
 *
 * 背景：Assumptions.assumeTrue 在环境不在时让测试 **skip**（surefire 认为不算失败），
 * 于是「真链路已验证」与「从来没跑过」在 exit code 上不可区分。
 * 本脚本读 surefire XML，按类断言 skipped ≤ 上限；skip 原因直接从 XML 的 <skipped> 节点里取出来打。
 *
 * 用法：
 *   node scripts/check-surefire-skips.mjs --dir <reports 目录> --class <fqcn> [--max-skipped 0] [--json]
 * 退出码：0 = skipped ≤ 上限；1 = 超限（逐条点名 skip 原因）；2 = 报告目录/类找不到（脚本或前提问题，不是产品问题）
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf("--" + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const dir = arg("dir");
const fqcn = arg("class");
const maxSkipped = Number(arg("max-skipped", "0"));
const asJson = argv.includes("--json");
if (!dir || !fqcn) { console.error("用法: --dir <reports> --class <fqcn> [--max-skipped 0] [--json]"); process.exit(2); }
if (!existsSync(dir)) { console.error("E_REPORTS_MISSING 报告目录不存在: " + dir + " —— 先跑测试，别把「没报告」当「全绿」"); process.exit(2); }
const xml = path.join(dir, "TEST-" + fqcn + ".xml");
if (!existsSync(xml)) { console.error("E_REPORT_MISSING 找不到 " + xml + " —— 该类没跑或被过滤掉了"); process.exit(2); }
const text = readFileSync(xml, "utf8");
const attr = (name) => { const m = text.match(new RegExp(name + "=\"(\\d+)\"")); return m ? Number(m[1]) : null; };
const skippedAttr = attr("skipped");
// 只读两处结构：<testsuite> 的计数属性 + 带原因的 <skipped> 节点（不试图当通用 XML 解析器）。
const testsAttr = attr("tests");
const skippedCases = [...text.matchAll(/<testcase\b[^>]*name="([^"]+)"[^>]*>\s*(?:<[^>]*>\s*)*?<skipped\b[^>]*>([\s\S]*?)<\/skipped>/g)].map((m) => ({
  name: m[1],
  reason: m[2].replace(/\s+/g, " ").trim(),
}));
const skipped = skippedAttr ?? skippedCases.length;
const testsCount = testsAttr ?? skippedCases.length;
const result = { class: fqcn, tests: testsCount, skipped, maxSkipped, skippedCases: skippedCases.map((c) => ({ name: c.name, reason: c.reason })) };
if (asJson) { console.log(JSON.stringify(result, null, 2)); } else {
  console.log("class=" + fqcn + " tests=" + testsCount + " skipped=" + skipped + " max=" + maxSkipped);
  for (const c of result.skippedCases) console.log("  SKIPPED " + c.name + " —— " + (c.reason ?? "(XML 里没有原因)"));
}
if (skipped > maxSkipped) {
  if (!asJson) console.log("FAIL 有 " + skipped + " 条被静默 skip（上限 " + maxSkipped + "）—— 环境不在不是「验证通过」");
  process.exit(1);
}
process.exit(0);
