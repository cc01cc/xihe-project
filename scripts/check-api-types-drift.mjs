#!/usr/bin/env node
/**
 * check-api-types-drift.mjs -- 手写 UI 类型 vs openapi.yaml 生成物 漂移门（task-73）
 *
 * 对同名类型逐对发三条 tsc 断言，把红按断言前缀归因：
 *   EXACT_<N>       手写 == 生成（双向严格相等）
 *   HAND_TO_GEN_<N> 手写 extends 生成  -- 危险方向：UI 以为必有，契约说可空/可缺
 *   GEN_TO_HAND_<N> 生成 extends 手写  -- UI 丢了服务器在发的字段（功能面缺失、不报错）
 *
 * 判据出处：internal/A03-xihe/docs/ui-type-drift.md §6（task-242 原型：70 对 / 210 断言 / 1.4 s /
 * 44 红 / 32 条危险方向）。本脚本把原型正式化，不重写判据。
 *
 * 退出码（对齐本仓三态纪律：读不出 != ok => unknown，不许当绿）：
 *   0 = 绿；1 = 红（有新红，或基线条目转绿未收缩）；2 = 判不了（缺生成物 / 输入为空 / tsc 缺失或崩 / 基线坏）
 *
 * 四条铁律（改这个门之前先读）：
 *   ① 缺生成物 => exit 2，不是 0（分母恒 0 的门等于没有门，shard-report 事故 5af988e0）
 *   ② 扫不到文件 => exit 2（oxlint 对 gitignored 路径静默绿，第八族事故）
 *   ③ 纯字面量联合必须排除并计数打印（67 个假红会让人不再看这个门）
 *   ④ 门必须能失败：selftest 有必红夹具，且提交证据里贴红输出
 *
 * 本门不写仓库：probe/tsconfig 落 --workdir（默认 one/.tmp/xh/api-type-drift，gitignored）；
 * 基线只有显式 --update-baseline 才会被重写（同 tmp-signals.mjs）。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const WORKSPACE_ROOT = resolve(SCRIPT_DIR, "..", "..");

export const DEFAULT_HANDWRITTEN = "A03-xihe/packages/ui/src/types";
export const DEFAULT_GENERATED = "A03-xihe/packages/ui/src/types/generated/openapi.d.ts";
export const DEFAULT_BASELINE = "A03-xihe/scripts/api-type-drift-baseline.json";
export const DEFAULT_UI_TSCONFIG = "A03-xihe/packages/ui/tsconfig.json";
export const DEFAULT_TSC = "A03-xihe/packages/ui/node_modules/typescript/bin/tsc";
export const DEFAULT_WORKDIR = ".tmp/xh/api-type-drift";
export const KINDS = ["EXACT", "HAND_TO_GEN", "GEN_TO_HAND"];

/** 纯字面量联合： a | b | null。生成器把 enum 内联到宿主属性 => 这类「仅手写有」是假缺失。 */
export function isLiteralUnion(body) {
  const t = body.replace(/\s+/gu, " ").trim();
  if (t === "") return false;
  if (/[{}]/u.test(t)) return false;
  if (/\b(extends|keyof|typeof|infer)\b/u.test(t)) return false;
  const parts = t.split("|").map((s) => s.trim());
  if (parts.length === 0) return false;
  return parts.every((s) => s === "null" || s === "undefined" || /^['"].*['"]$/u.test(s));
}

/** 抽 export type|interface NAME 的声明体（花括号/分号配平，零依赖）。 */
export function extractHandwrittenTypes(source) {
  const out = [];
  // interface 可以带 extends 子句（`export interface X extends Y {`）—— 漏了这类会静默少算（实测漏 2/205）
  const re = /export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*(?:extends\s+[^{=]*?)?\s*(=|\{)/gu;
  let m;
  while ((m = re.exec(source)) !== null) {
    const name = m[1];
    const from = m.index + m[0].length;
    let i = from;
    let body;
    if (m[2] === "{") {
      let depth = 1;
      while (i < source.length && depth > 0) {
        const ch = source[i];
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
        i += 1;
      }
      body = source.slice(from, i);
    } else {
      let depth = 0;
      while (i < source.length) {
        const ch = source[i];
        if (ch === "{" || ch === "(" || ch === "[") depth += 1;
        else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
        else if (ch === ";" && depth === 0) break;
        i += 1;
      }
      body = source.slice(from, i);
    }
    out.push({ name, body });
  }
  return out;
}

/** 从 openapi-typescript 产物抽 schemas 顶层名；找不到锚点返回 null（调用方判 2）。 */
export function extractGeneratedSchemaNames(source) {
  const anchor = /schemas:\s*\{/u.exec(source);
  if (!anchor) return null;
  const names = [];
  let depth = 1;
  let i = anchor.index + anchor[0].length;
  let atKey = true;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "{") { depth += 1; atKey = false; }
    else if (ch === "}") { depth -= 1; atKey = false; }
    else if (ch === ";") atKey = true;
    else if (atKey && /[A-Za-z_$]/u.test(ch)) {
      const km = /^("?)([A-Za-z_$][\w$]*)\1\s*:/u.exec(source.slice(i));
      if (km) {
        if (depth === 1) names.push(km[2]);
        atKey = false;
        i += km[0].length;
        continue;
      }
      atKey = false;
    }
    i += 1;
  }
  return names;
}

/** 抽生成物里每个 schema 的声明体（顶层属性名提示用；tsc 仍是权威，这只是解释）。 */
export function extractGeneratedSchemaBodies(source) {
  const anchor = /schemas:\s*\{/u.exec(source);
  const out = new Map();
  if (!anchor) return out;
  let i = anchor.index + anchor[0].length;
  let depth = 1;
  let atKey = true;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "{") { depth += 1; atKey = false; }
    else if (ch === "}") { depth -= 1; atKey = false; }
    else if (ch === ";") atKey = true;
    else if (atKey && /[A-Za-z_$]/u.test(ch)) {
      const km = /^("?)([A-Za-z_$][\w$]*)\1\s*:\s*/u.exec(source.slice(i));
      if (km) {
        const name = km[2];
        const from = i + km[0].length;
        let j = from;
        let d = 0;
        while (j < source.length) {
          const c = source[j];
          if (c === "{" || c === "(" || c === "[") d += 1;
          else if (c === "}" || c === ")" || c === "]") {
            if (d === 0) break;
            d -= 1;
          } else if (c === ";" && d === 0) break;
          j += 1;
        }
        if (depth === 1) out.set(name, source.slice(from, j));
        atKey = false;
        i = j;
        continue;
      }
      atKey = false;
    }
    i += 1;
  }
  return out;
}

/** 顶层属性名（只扫 depth 1，够做「缺哪个字段」提示）。 */
export function topLevelProps(body) {
  const out = [];
  const src = String(body || "");
  // body 是「花括号内部的内容」：depth 从 1 起算，跳过可能存在的开头 {
  let depth = 1;
  let i = 0;
  const open = src.indexOf("{");
  if (open >= 0 && src.slice(0, open).trim() === "") i = open + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "{" || ch === "(" || ch === "[") { depth += 1; i += 1; continue; }
    if (ch === "}" || ch === ")" || ch === "]") { depth -= 1; i += 1; continue; }
    if (depth === 1 && /[A-Za-z_$]/u.test(ch)) {
      const m = /^([A-Za-z_$][\w$]*)(\?)?\s*:/u.exec(src.slice(i));
      if (m) {
        out.push({ name: m[1], optional: Boolean(m[2]) });
        i += m[0].length;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

export function parseTscOutput(text, lineMap) {
  const failures = [];
  for (const raw of text.split(/\r?\n/u)) {
    const m = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s*(.*)$/u.exec(raw.trim());
    if (!m) continue;
    const lineNo = Number(m[2]);
    const hit = lineMap[lineNo];
    failures.push({
      kind: hit ? hit.kind : "OTHER",
      id: hit ? hit.kind + ":" + hit.name : "OTHER:line" + lineNo,
      code: m[4],
      message: m[5],
    });
  }
  return failures;
}

export function classify(current, baseline) {
  const baseSet = new Set((baseline.failures || []).map((f) => f.id));
  const curSet = new Set(current.map((f) => f.id));
  return {
    newRed: current.filter((f) => !baseSet.has(f.id)),
    knownRed: current.filter((f) => baseSet.has(f.id)),
    staleBaseline: [...baseSet].filter((id) => !curSet.has(id)),
  };
}

export function collectHandwritten(target) {
  const abs = resolve(WORKSPACE_ROOT, target);
  if (!existsSync(abs)) return { files: [], types: [] };
  const files = [];
  const walk = (q) => {
    const st = statSync(q);
    if (st.isDirectory()) {
      for (const e of readdirSync(q)) {
        if (e === "generated" || e.startsWith(".")) continue;
        walk(join(q, e));
      }
    } else if (/\.ts$/u.test(q) && !/\.test\.ts$/u.test(q)) files.push(q);
  };
  walk(abs);
  const types = [];
  for (const f of files) for (const t of extractHandwrittenTypes(readFileSync(f, "utf8"))) types.push(t);
  return { files, types };
}

/** 生成器版本：数字对不上时第一件事就是核它（原型钉的是 7.13.0）。 */
export function readGeneratorVersion() {
  const pkg = resolve(WORKSPACE_ROOT, "A03-xihe/packages/ui/package.json");
  if (!existsSync(pkg)) return "unknown(no package.json)";
  try {
    const j = JSON.parse(readFileSync(pkg, "utf8"));
    return (j.devDependencies && j.devDependencies["openapi-typescript"]) || (j.dependencies && j.dependencies["openapi-typescript"]) || "unknown(not installed)";
  } catch {
    return "unknown(unparsable package.json)";
  }
}

export function runMain(argv) {
  const opts = {
    handwritten: DEFAULT_HANDWRITTEN, generated: DEFAULT_GENERATED, baseline: DEFAULT_BASELINE,
    uiTsconfig: DEFAULT_UI_TSCONFIG, tsc: DEFAULT_TSC, workdir: DEFAULT_WORKDIR,
    json: false, emitOnly: false, updateBaseline: false, tscStub: null, exclude: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => argv[(i += 1)];
    if (a === "--handwritten") opts.handwritten = val();
    else if (a === "--generated") opts.generated = val();
    else if (a === "--baseline") opts.baseline = val();
    else if (a === "--ui-tsconfig") opts.uiTsconfig = val();
    else if (a === "--tsc") opts.tsc = val();
    else if (a === "--workdir") opts.workdir = val();
    else if (a === "--tsc-stub") opts.tscStub = val();
    else if (a === "--exclude") opts.exclude.push(val());
    else if (a === "--emit-only") opts.emitOnly = true;
    else if (a === "--update-baseline") opts.updateBaseline = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--selftest") {
      const t = spawnSync(process.execPath, ["--test", join(SCRIPT_DIR, "check-api-types-drift.test.mjs")], { stdio: "inherit" });
      return t.status === 0 ? 0 : 1;
    }
    else if (a === "--help" || a === "-h") { process.stdout.write(helpText()); return 0; }
    else { process.stderr.write("未知参数: " + a + "（--help 看用法）\n"); return 2; }
  }
  return run(opts);
}

function helpText() {
  return [
    "check-api-types-drift.mjs -- UI 手写类型 vs openapi.yaml 生成物 漂移门（task-73）",
    "",
    "用法: node scripts/check-api-types-drift.mjs [选项]",
    "",
    "  --handwritten <path>  手写类型文件或目录（默认 " + DEFAULT_HANDWRITTEN + "）",
    "  --generated <path>    生成物（默认 " + DEFAULT_GENERATED + "；由 task-39 产出）",
    "  --baseline <path>     已知红基线（默认 " + DEFAULT_BASELINE + "）",
    "  --ui-tsconfig <path>  生成 probe tsconfig 时 extends 的 UI tsconfig",
    "  --tsc <path>          tsc 可执行文件（默认 " + DEFAULT_TSC + "）",
    "  --workdir <dir>       probe/tsconfig 落点（默认 " + DEFAULT_WORKDIR + "，gitignored）",
    "  --exclude <Name>      额外排除某个同名对（可重复；理由写进基线的 exclude[].reason）",
    "  --emit-only           只生成 probe，不跑 tsc（selftest / 排障）",
    "  --tsc-stub <file>     用文件内容冒充 tsc 输出（仅 selftest；打印 WARN 且 JSON 带 tscStub:true）",
    "  --update-baseline     用当前红重写基线（只许缩小；门从不自动写仓库）",
    "  --json                机器可读输出",
    "  --selftest            跑本门的正负例自测（= node --test check-api-types-drift.test.mjs）",
    "",
    "退出码: 0 绿 / 1 红（新红或基线过期）/ 2 判不了（缺生成物、输入为空、tsc 缺失或崩、基线坏）",
  ].join("\n") + "\n";
}

function run(opts) {
  const emit = (payload, human) => {
    process.stdout.write(opts.json ? JSON.stringify(payload, null, 1) + "\n" : human.join("\n") + "\n");
  };
  const bail = (reason, detail) => {
    emit({ ok: false, state: "unknown", reason, detail, exitCode: 2 }, [
      "[api-type-drift] 判不了（exit 2）: " + reason,
      "  " + detail,
      "  => 缺输入或环境坏了不是「没漂移」。修好输入再跑，别把这条当绿。",
    ]);
    return 2;
  };
  const generatedAbs = resolve(WORKSPACE_ROOT, opts.generated);
  if (!existsSync(generatedAbs)) {
    return bail("E_NO_ARTIFACT", "生成物不存在: " + opts.generated + "（由 task-39 产出；未产出前本门无法判定，不是绿）");
  }
  const generatedNames = extractGeneratedSchemaNames(readFileSync(generatedAbs, "utf8"));
  if (generatedNames === null) return bail("E_BAD_ARTIFACT", "生成物里找不到 schemas: { 锚点: " + opts.generated + "（生成器版本或输出形态变了？）");
  if (generatedNames.length === 0) return bail("E_EMPTY_GENERATED", "生成物 schemas 为空: " + opts.generated);

  const { files, types } = collectHandwritten(opts.handwritten);
  if (files.length === 0) return bail("E_NO_SOURCE", "扫不到任何手写类型文件: " + opts.handwritten);
  if (types.length === 0) return bail("E_EMPTY_SOURCE", "手写类型里没有 export type/interface: " + opts.handwritten);

  const genSet = new Set(generatedNames);
  const excludedLiteral = [];
  const excludedExplicit = [];
  const pairs = [];
  const seen = new Set();
  const genBodies = extractGeneratedSchemaBodies(readFileSync(generatedAbs, "utf8"));
  const handBody = new Map();
  for (const t of types) {
    if (seen.has(t.name) || !genSet.has(t.name)) continue;
    if (opts.exclude.includes(t.name)) { excludedExplicit.push(t.name); continue; }
    if (isLiteralUnion(t.body)) { excludedLiteral.push(t.name); continue; }
    seen.add(t.name);
    handBody.set(t.name, t.body);
    pairs.push(t.name);
  }
  pairs.sort();
  if (pairs.length === 0) {
    return bail("E_NO_PAIRS", "同名对为 0（手写 " + types.length + " / 生成 schema " + generatedNames.length + " / 排除字面量联合 " + excludedLiteral.length + "）=> 分母为 0 不能判绿");
  }

  const workdirAbs = resolve(WORKSPACE_ROOT, opts.workdir);
  mkdirSync(workdirAbs, { recursive: true });
  const handAbs = resolve(WORKSPACE_ROOT, opts.handwritten);
  const handEntry = statSync(handAbs).isDirectory() ? join(handAbs, "api.ts") : handAbs;
  const handImport = relative(workdirAbs, handEntry).replace(/\\/gu, "/").replace(/\.ts$/u, ".js");
  const genImport = relative(workdirAbs, generatedAbs).replace(/\\/gu, "/").replace(/\.d\.ts$|\.ts$/u, ".js");
  const lines = ["// 由 scripts/check-api-types-drift.mjs 生成，勿手改"];
  const lineMap = {};
  for (const name of pairs) lines.push("import type { " + name + " } from \"" + handImport + "\";");
  lines.push("import type { components } from \"" + genImport + "\";");
  lines.push("type Assert<T extends true> = T;");
  lines.push("type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;");
  lines.push("type Gen<K extends keyof components[\"schemas\"]> = components[\"schemas\"][K];");
  for (const name of pairs) {
    const push = (kind, text) => {
      lines.push(text);
      lineMap[lines.length] = { kind, name };
    };
    push("EXACT", "type EXACT_" + name + " = Assert<Eq<" + name + ", Gen<\"" + name + "\">>>;");
    push("HAND_TO_GEN", "type HAND_TO_GEN_" + name + " = Assert<" + name + " extends Gen<\"" + name + "\"> ? true : false>;");
    push("GEN_TO_HAND", "type GEN_TO_HAND_" + name + " = Assert<Gen<\"" + name + "\"> extends " + name + " ? true : false>;");
  }
  const probePath = join(workdirAbs, "gate.ts");
  writeFileSync(probePath, lines.join("\n") + "\n", "utf8");
  const tsconfigPath = join(workdirAbs, "tsconfig.gate.json");
  writeFileSync(tsconfigPath, JSON.stringify({
    extends: relative(workdirAbs, resolve(WORKSPACE_ROOT, opts.uiTsconfig)).replace(/\\/gu, "/"),
    compilerOptions: { noEmit: true, skipLibCheck: true, incremental: false, composite: false },
    include: ["gate.ts"],
  }, null, 1) + "\n", "utf8");

  const stats = {
    handwrittenFiles: files.length, handwrittenTypes: types.length, generatedSchemas: generatedNames.length,
    pairs: pairs.length, assertions: pairs.length * KINDS.length,
    excludedLiteralUnion: excludedLiteral.length, excludedExplicit,
    generatorVersion: readGeneratorVersion(),
    probe: relative(WORKSPACE_ROOT, probePath).replace(/\\/gu, "/"),
  };
  if (opts.emitOnly) {
    emit({ ok: true, state: "emitted", stats, exitCode: 0 }, ["[api-type-drift] 已生成 probe（--emit-only）", JSON.stringify(stats, null, 1)]);
    return 0;
  }

  let tscOut = "";
  if (opts.tscStub) {
    const stubAbs = resolve(WORKSPACE_ROOT, opts.tscStub);
    if (!existsSync(stubAbs)) return bail("E_BAD_STUB", "--tsc-stub 文件不存在: " + opts.tscStub);
    tscOut = readFileSync(stubAbs, "utf8");
  } else {
    const tscAbs = resolve(WORKSPACE_ROOT, opts.tsc);
    if (!existsSync(tscAbs)) return bail("E_TSC_MISSING", "找不到 tsc: " + opts.tsc + "（先装 UI 依赖，或 --tsc 指定）");
    const r = spawnSync(process.execPath, [tscAbs, "-p", tsconfigPath], { cwd: WORKSPACE_ROOT, encoding: "utf8" });
    if (r.error) return bail("E_TSC_CRASH", String(r.error.message || r.error));
    if (r.status !== 0 && r.status !== 1 && r.status !== 2) {
      return bail("E_TSC_CRASH", "tsc 退出码 " + r.status + ": " + String(r.stdout || "").slice(0, 300) + String(r.stderr || "").slice(0, 300));
    }
    tscOut = String(r.stdout || "") + String(r.stderr || "");
  }

  const current = parseTscOutput(tscOut, lineMap);
  const other = current.filter((f) => f.kind === "OTHER");
  if (current.length > 0 && other.length === current.length) {
    return bail("E_GATE_BROKEN", "tsc 只报与断言无关的错误 => 门本身不干净，不能判红也不能判绿:\n" + tscOut.slice(0, 500));
  }

  let baseline = { failures: [] };
  const baselineAbs = resolve(WORKSPACE_ROOT, opts.baseline);
  if (existsSync(baselineAbs)) {
    try { baseline = JSON.parse(readFileSync(baselineAbs, "utf8")); }
    catch (e) { return bail("E_BAD_BASELINE", "基线不是合法 JSON: " + opts.baseline + " (" + e.message + ")"); }
    if (!Array.isArray(baseline.failures)) return bail("E_BAD_BASELINE", "基线缺 failures 数组: " + opts.baseline);
  }
  const { newRed, knownRed, staleBaseline } = classify(current, baseline);
  const byKind = Object.fromEntries(KINDS.map((k) => [k, current.filter((f) => f.kind === k).length]));
  const human = [
    "[api-type-drift] " + (newRed.length === 0 && staleBaseline.length === 0 ? "绿" : "红") + "（生成物 " + opts.generated + "）" + (opts.tscStub ? "  WARN --tsc-stub 生效（仅 selftest）" : ""),
    "  同名对 " + stats.pairs + " / 断言 " + stats.assertions + "（手写 " + stats.handwrittenTypes + " 类型 · 生成 " + stats.generatedSchemas + " schema）",
    "  排除字面量联合 " + stats.excludedLiteralUnion + " 个（生成器把 enum 内联到宿主属性 => 假缺失，不算红）" + (excludedExplicit.length ? " · 显式排除 " + excludedExplicit.join(",") : ""),
    "  本轮红 " + current.length + "（EXACT " + byKind.EXACT + " / HAND_TO_GEN " + byKind.HAND_TO_GEN + " / GEN_TO_HAND " + byKind.GEN_TO_HAND + "）· 基线内 " + knownRed.length + " · 新红 " + newRed.length + " · 基线过期 " + staleBaseline.length,
  ];
  const fieldHint = (f) => {
    const name = f.id.split(":")[1];
    const hand = topLevelProps(handBody.get(name));
    const gen = topLevelProps(genBodies.get(name));
    const handSet = new Set(hand.map((x) => x.name));
    const genSet2 = new Set(gen.map((x) => x.name));
    const missing = gen.filter((x) => !handSet.has(x.name)).map((x) => x.name + (x.optional ? "?" : ""));
    const extra = hand.filter((x) => !genSet2.has(x.name)).map((x) => x.name + (x.optional ? "?" : ""));
    const bits = [];
    if (missing.length) bits.push("生成有手写缺[" + missing.slice(0, 6).join(",") + (missing.length > 6 ? ",..." : "") + "]");
    if (extra.length) bits.push("手写有生成无[" + extra.slice(0, 6).join(",") + (extra.length > 6 ? ",..." : "") + "]");
    return bits.length ? "  · 提示(文本级,非权威): " + bits.join(" / ") : "";
  };
  for (const f of newRed.slice(0, 20)) human.push("  x [新红] " + f.kind + " " + f.id.split(":")[1] + " -> " + f.code + " " + f.message.slice(0, 110) + fieldHint(f));
  if (newRed.length > 20) human.push("  ... 还有 " + (newRed.length - 20) + " 条新红（--json 取全量）");
  for (const id of staleBaseline.slice(0, 10)) human.push("  ! [基线过期] " + id + " 已转绿 => 基线只许缩小，请 --update-baseline 收缩");
  if (staleBaseline.length > 10) human.push("  ... 还有 " + (staleBaseline.length - 10) + " 条基线过期");

  if (opts.updateBaseline) {
    const payload = {
      reviewedAt: new Date().toISOString().slice(0, 10),
      generatedFrom: "internal/A03-xihe/docs/ui-type-drift.md §6（task-242 原型）+ scripts/check-api-types-drift.mjs",
      note: "由 --update-baseline 生成；只许缩小（转绿条目必须删）。exclude 每条必须有 reason。",
      stats: { pairs: stats.pairs, assertions: stats.assertions, excludedLiteralUnion: stats.excludedLiteralUnion },
      exclude: (baseline.exclude || []).concat(excludedExplicit.map((name) => ({ name, reason: "TODO 填理由：说明这个同名对为什么不算漂移" }))),
      failures: current.filter((f) => f.kind !== "OTHER").map((f) => ({ id: f.id, kind: f.kind, code: f.code, message: f.message.slice(0, 300) })),
    };
    writeFileSync(baselineAbs, JSON.stringify(payload, null, 1) + "\n", "utf8");
    human.push("  => 已重写基线（" + current.length + " 条）: " + opts.baseline);
    emit({ ok: true, state: "baseline-updated", stats, failures: current.length, exitCode: 0 }, human);
    return 0;
  }

  const red = newRed.length > 0 || staleBaseline.length > 0;
  emit({
    ok: !red, state: red ? "drift" : "clean", tscStub: Boolean(opts.tscStub), stats, byKind,
    counts: { current: current.length, known: knownRed.length, newRed: newRed.length, staleBaseline: staleBaseline.length },
    newRed, staleBaseline, exitCode: red ? 1 : 0,
  }, human);
  return red ? 1 : 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = runMain(process.argv.slice(2));
