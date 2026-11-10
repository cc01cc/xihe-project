#!/usr/bin/env node
/**
 * check-api-types-drift.test.mjs -- 漂移门正负例（task-73）
 *
 * 跑法: node --test A03-xihe/scripts/check-api-types-drift.test.mjs
 *
 * 夹具全部落在 one/.tmp 下（gitignored），测试不碰 packages/ui。
 * 其中 F5 是**必红夹具**：门必须能红，且红必须能归因到断言种类（EXACT / HAND_TO_GEN / GEN_TO_HAND）。
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  WORKSPACE_ROOT,
  classify,
  extractGeneratedSchemaNames,
  extractHandwrittenTypes,
  isLiteralUnion,
  parseTscOutput,
  runMain,
  topLevelProps,
} from "./check-api-types-drift.mjs";

const TMP = resolve(WORKSPACE_ROOT, ".tmp", "xh", "api-type-drift-test");
let seq = 0;

const HANDWRITTEN = [
  "export interface Alpha { id: string; name: string | null }",
  "export interface Beta { id: string }",
  "export type Status = 'a' | 'b';",
  "export type Gamma = { kind: string };",
  "",
].join("\n");

const GENERATED = [
  "export interface components {",
  "  schemas: {",
  "    Alpha: { id: string; name: string | null };",
  "    Beta: { id: string };",
  "    Status: { value: 'a' | 'b' };",
  "  };",
  "}",
  "",
].join("\n");

function makeFixture(opts = {}) {
  seq += 1;
  const dir = join(TMP, "f" + seq);
  mkdirSync(join(dir, "handwritten"), { recursive: true });
  if (opts.handwritten !== null) writeFileSync(join(dir, "handwritten", "api.ts"), opts.handwritten ?? HANDWRITTEN, "utf8");
  if (opts.generated !== null) writeFileSync(join(dir, "openapi.d.ts"), opts.generated ?? GENERATED, "utf8");
  writeFileSync(join(dir, "tsconfig.ui.json"), JSON.stringify({ compilerOptions: { strict: true } }, null, 1), "utf8");
  writeFileSync(join(dir, "stub-empty.txt"), "", "utf8");
  if (opts.baseline !== undefined && opts.baseline !== null) writeFileSync(join(dir, "baseline.json"), opts.baseline, "utf8");
  return {
    dir,
    args(extra = []) {
      return [
        "--handwritten", join(dir, "handwritten"),
        "--generated", join(dir, "openapi.d.ts"),
        "--baseline", join(dir, "baseline.json"),
        "--ui-tsconfig", join(dir, "tsconfig.ui.json"),
        "--workdir", join(dir, "work"),
        "--json",
        ...extra,
      ];
    },
  };
}

function runGate(args) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  let code;
  try { code = runMain(args); } finally { process.stdout.write = orig; }
  const out = chunks.join("");
  let json = null;
  try { json = JSON.parse(out); } catch { /* 非 json 分支 */ }
  return { code, out, json };
}

test.after(() => { rmSync(TMP, { recursive: true, force: true }); });

test("isLiteralUnion: 纯字面量联合才排除（含 null 也算）", () => {
  assert.equal(isLiteralUnion("'a' | 'b'"), true);
  assert.equal(isLiteralUnion("'a' | null"), true);
  assert.equal(isLiteralUnion("{ x: 1 }"), false);
  assert.equal(isLiteralUnion("Foo"), false);
  assert.equal(isLiteralUnion("keyof typeof X"), false);
});

test("extractHandwrittenTypes: interface/type 都能抽，字面量联合有 body", () => {
  const types = extractHandwrittenTypes(HANDWRITTEN);
  assert.deepEqual(types.map((t) => t.name).sort(), ["Alpha", "Beta", "Gamma", "Status"]);
  assert.equal(isLiteralUnion(types.find((t) => t.name === "Status").body), true);
  assert.equal(isLiteralUnion(types.find((t) => t.name === "Gamma").body), false);
});

test("extractGeneratedSchemaNames: 只取 schemas 顶层名；无锚点返回 null", () => {
  assert.deepEqual(extractGeneratedSchemaNames(GENERATED), ["Alpha", "Beta", "Status"]);
  assert.equal(extractGeneratedSchemaNames("export interface components {}"), null);
});

test("parseTscOutput: 行号能归因到断言 id，对不上归 OTHER", () => {
  const map = { 10: { kind: "EXACT", name: "Alpha" } };
  const f = parseTscOutput("gate.ts(10,5): error TS2344: boom\ngate.ts(99,1): error TS2344: x\n", map);
  assert.equal(f.length, 2);
  assert.equal(f[0].kind, "EXACT");
  assert.equal(f[0].id, "EXACT:Alpha");
  assert.equal(f[1].kind, "OTHER");
});

test("classify: 新红 / 基线内 / 基线过期三分", () => {
  const current = [{ id: "EXACT:A" }, { id: "EXACT:B" }];
  const baseline = { failures: [{ id: "EXACT:B" }, { id: "EXACT:C" }] };
  const r = classify(current, baseline);
  assert.deepEqual(r.newRed.map((f) => f.id), ["EXACT:A"]);
  assert.deepEqual(r.knownRed.map((f) => f.id), ["EXACT:B"]);
  assert.deepEqual(r.staleBaseline, ["EXACT:C"]);
});

test("F1 缺生成物 => exit 2（不是 0）", () => {
  const fx = makeFixture({ generated: null });
  const r = runGate(fx.args());
  assert.equal(r.code, 2);
  assert.equal(r.json.state, "unknown");
  assert.equal(r.json.reason, "E_NO_ARTIFACT");
});

test("F2 手写目录扫不到文件 => exit 2", () => {
  const fx = makeFixture({ handwritten: null });
  const r = runGate(fx.args());
  assert.equal(r.code, 2);
  assert.equal(r.json.reason, "E_NO_SOURCE");
});

test("F3 生成物没有 schemas 锚点 => exit 2", () => {
  const fx = makeFixture({ generated: "export type X = 1;\n" });
  const r = runGate(fx.args());
  assert.equal(r.code, 2);
  assert.equal(r.json.reason, "E_BAD_ARTIFACT");
});

test("F4 同名对为 0（全是字面量联合）=> exit 2，不许当绿", () => {
  const fx = makeFixture({
    handwritten: "export type Status = 'a' | 'b';\n",
  });
  const r = runGate(fx.args());
  assert.equal(r.code, 2);
  assert.equal(r.json.reason, "E_NO_PAIRS");
});

test("F5 必红夹具：两条 tsc 报错 => exit 1 且能归因到种类", () => {
  const fx = makeFixture({});
  const emit = runGate(fx.args(["--emit-only"]));
  assert.equal(emit.code, 0);
  const probe = readFileSync(join(fx.dir, "work", "gate.ts"), "utf8").split("\n");
  const lineOf = (needle) => probe.findIndex((l) => l.includes(needle)) + 1;
  const exactLine = lineOf("type EXACT_Alpha ");
  const handLine = lineOf("type HAND_TO_GEN_Beta ");
  assert.ok(exactLine > 0 && handLine > 0, "probe 里应有 EXACT_Alpha / HAND_TO_GEN_Beta 断言");
  writeFileSync(
    join(fx.dir, "stub-red.txt"),
    "gate.ts(" + exactLine + ",7): error TS2344: Type 'Alpha' does not satisfy the constraint 'true'.\n" +
      "gate.ts(" + handLine + ",7): error TS2344: Type 'Beta' does not satisfy the constraint 'true'.\n",
    "utf8",
  );
  const r = runGate(fx.args(["--tsc-stub", join(fx.dir, "stub-red.txt")]));
  assert.equal(r.code, 1);
  assert.equal(r.json.state, "drift");
  assert.equal(r.json.counts.newRed, 2);
  assert.deepEqual(r.json.newRed.map((f) => f.id).sort(), ["EXACT:Alpha", "HAND_TO_GEN:Beta"]);
  assert.equal(r.json.tscStub, true, "stub 必须自曝，不能伪装成真跑");
});

test("F6 基线覆盖全部红 => exit 0（基线内不算新红）", () => {
  const fx = makeFixture({});
  const emit = runGate(fx.args(["--emit-only"]));
  assert.equal(emit.code, 0);
  const probe = readFileSync(join(fx.dir, "work", "gate.ts"), "utf8").split("\n");
  const line = probe.findIndex((l) => l.includes("type GEN_TO_HAND_Alpha ")) + 1;
  writeFileSync(join(fx.dir, "stub-one.txt"), "gate.ts(" + line + ",7): error TS2344: known red\n", "utf8");
  writeFileSync(join(fx.dir, "baseline.json"), JSON.stringify({ failures: [{ id: "GEN_TO_HAND:Alpha" }] }), "utf8");
  const r = runGate(fx.args(["--tsc-stub", join(fx.dir, "stub-one.txt")]));
  assert.equal(r.code, 0);
  assert.equal(r.json.counts.known, 1);
  assert.equal(r.json.counts.newRed, 0);
});

test("F7 基线条目转绿未收缩 => exit 1（基线只许缩小）", () => {
  const fx = makeFixture({ baseline: JSON.stringify({ failures: [{ id: "EXACT:Alpha" }] }) });
  const r = runGate(fx.args(["--tsc-stub", join(fx.dir, "stub-empty.txt")]));
  assert.equal(r.code, 1);
  assert.deepEqual(r.json.staleBaseline, ["EXACT:Alpha"]);
});

test("F8 基线不是合法 JSON => exit 2", () => {
  const fx = makeFixture({ baseline: "{ not json" });
  const r = runGate(fx.args(["--tsc-stub", join(fx.dir, "stub-empty.txt")]));
  assert.equal(r.code, 2);
  assert.equal(r.json.reason, "E_BAD_BASELINE");
});

test("F9 tsc 缺失 => exit 2（不是绿）", () => {
  const fx = makeFixture({});
  const r = runGate(fx.args(["--tsc", join(fx.dir, "no-such-tsc.js")]));
  assert.equal(r.code, 2);
  assert.equal(r.json.reason, "E_TSC_MISSING");
});

test("F11 topLevelProps: 只取 depth 1，嵌套对象内部字段不算顶层", () => {
  const body = "{ id: string; meta?: { inner: number }; name: string | null }";
  assert.deepEqual(topLevelProps(body), [
    { name: "id", optional: false },
    { name: "meta", optional: true },
    { name: "name", optional: false },
  ]);
});

test("F12 红行必须点名真缺的字段，且不把两侧共有的字段报成缺", () => {
  const fx = makeFixture({});
  const emit = runGate(fx.args(["--emit-only"]));
  assert.equal(emit.code, 0);
  const probe = readFileSync(join(fx.dir, "work", "gate.ts"), "utf8").split("\n");
  const line = probe.findIndex((l) => l.includes("type HAND_TO_GEN_Beta ")) + 1;
  writeFileSync(join(fx.dir, "stub-beta.txt"), "gate.ts(" + line + ",7): error TS2344: nope\n", "utf8");
  // 人读输出才带字段提示 => 这条不走 --json
  const humanArgs = fx.args(["--tsc-stub", join(fx.dir, "stub-beta.txt")]).filter((a) => a !== "--json");
  const r = runGate(humanArgs);
  assert.equal(r.code, 1);
  assert.match(r.out, /HAND_TO_GEN Beta/u);
  assert.doesNotMatch(r.out, /生成有手写缺\[id\]/u, "id 两侧都有，不能报成缺");
});

test("F10 字面量联合被排除且计数可见（不是静默跳过）", () => {
  const fx = makeFixture({});
  const r = runGate(fx.args(["--tsc-stub", join(fx.dir, "stub-empty.txt")]));
  assert.equal(r.code, 0);
  assert.equal(r.json.stats.pairs, 2, "Alpha/Beta 是唯一两个真同名对");
  assert.equal(r.json.stats.excludedLiteralUnion, 1, "Status 被排除且必须计数");
  assert.equal(r.json.stats.assertions, 6);
});

