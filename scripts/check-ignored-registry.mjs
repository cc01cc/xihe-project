#!/usr/bin/env node
/**
 * check-ignored-registry.mjs — task-612 / task-616：runtime 的 #[ignore] 必须逐条有归属。
 *
 * 判据（三件）：
 *   ① 实测标注数 == 登记条数（多一条未登记即红）
 *   ② unowned == 0 —— 每条必须落在 env / bl / tier:* / helper 之一
 *   ③ 登记表里 tier:* 的条目必须真的出现在对应 mise 任务的显式列名里，反之亦然
 *
 * 用法：
 *   node scripts/check-ignored-registry.mjs --check      # 对账，任一判据不满足即 exit 1
 *   node scripts/check-ignored-registry.mjs --list      # 只列实测条目
 *   node scripts/check-ignored-registry.mjs --selftest  # 解析器自测（6 例）
 *
 * 口径：只认 packages/runtime 下所有 .rs 里真标注的 #[ignore]（注释文字不算）。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const REGISTRY = path.join(REPO, "packages/runtime/tests-ignored-registry.json");
const MISE = path.join(REPO, "mise.toml");
const CATEGORIES = ["env", "bl", "tier:functional", "tier:isolated", "tier:heavy", "helper"];
const TIER_KEYS = ["functional", "isolated", "heavy", "mxc"];

function measuredEntries(repoRoot) {
  const out = execFileSync("git", ["-C", repoRoot, "grep", "-n", "#\\[ignore", "--", "packages/runtime/**/*.rs"], { encoding: "utf8", maxBuffer: 1 << 26 });
  const entries = [];
  for (const raw of out.split("\n").filter(Boolean)) {
    const a = raw.indexOf(":");
    const b = raw.indexOf(":", a + 1);
    const file = raw.slice(0, a);
    const line = Number(raw.slice(a + 1, b));
    const text = raw.slice(b + 1).trim();
    if (text.startsWith("//") || text.startsWith("*")) continue;
    const src = readFileSync(path.join(repoRoot, file), "utf8").split("\n");
    let name = "?";
    for (let i = line; i < Math.min(src.length, line + 8); i += 1) {
      const m = src[i].match(/fn\s+([A-Za-z0-9_]+)/);
      if (m) { name = m[1]; break; }
    }
    entries.push({ name, file: file.replace("packages/runtime/", ""), line });
  }
  return entries;
}

function miseTiers(miseFile) {
  const text = readFileSync(miseFile, "utf8");
  const lines = text.split("\n");
  const tiers = new Map();
  let current = null;
  for (const line of lines) {
    const head = line.match(/^\[tasks\."test:runtime:lib:ignored:([a-z]+)"\]/);
    if (head) { current = head[1]; tiers.set(current, new Set()); continue; }
    if (line.startsWith("[")) { current = null; continue; }
    if (!current) continue;
    const exact = line.match(/--exact\s+([A-Za-z0-9_:]+)/);
    if (exact) tiers.get(current).add(exact[1].split("::").pop());
  }
  return tiers;
}

function loadRegistry(file = REGISTRY) {
  const reg = JSON.parse(readFileSync(file, "utf8"));
  const problems = [];
  if (reg.schema !== "runtime-ignored-registry/1") problems.push("schema 不是 runtime-ignored-registry/1");
  const seen = new Set();
  for (const e of reg.entries ?? []) {
    if (!e.name || !e.file) problems.push("条目缺 name/file: " + JSON.stringify(e));
    if (!CATEGORIES.includes(e.category)) problems.push("类别非法 (" + e.name + "): " + e.category + " —— 只接受 env/bl/tier:*/helper，unowned 是缺陷");
    if (e.category === "bl" && !e.ref) problems.push("bl 类必须带 BL 号 (" + e.name + ")");
    if (e.category?.startsWith("tier:") && e.tier !== "test:runtime:lib:ignored:" + e.category.slice(5)) problems.push("tier 字段与类别不一致 (" + e.name + ")");
    if (e.category === "bl" && e.tier && !TIER_KEYS.includes(e.tier.split(":").pop())) problems.push("tier 字段指向未知档 (" + e.name + "): " + e.tier);
    if (e.category === "helper" && !e.note) problems.push("helper 必须写清由谁调用 (" + e.name + ")");
    if (seen.has(e.name)) problems.push("条目重名: " + e.name);
    seen.add(e.name);
  }
  return { reg, problems };
}

function check(repoRoot, registryFile, miseFile = MISE) {
  const measured = measuredEntries(repoRoot);
  const { reg, problems } = loadRegistry(registryFile);
  const entries = reg.entries ?? [];
  const registered = new Map(entries.map((e) => [e.name, e]));
  const seen = new Set();
  const fresh = [];
  for (const m of measured) { if (!registered.has(m.name)) fresh.push(m); seen.add(m.name); }
  const missing = [...registered.keys()].filter((n) => !seen.has(n));
  const dupNames = measured.map((m) => m.name).filter((n, i, a) => a.indexOf(n) !== i);
  const countProblems = [];
  if (measured.length !== registered.size) countProblems.push("E_COUNT_MISMATCH 实测标注 " + measured.length + " 条 ≠ 登记 " + registered.size + " 条（同名多条也算不等）");
  for (const d of new Set(dupNames)) countProblems.push("E_DUPLICATE_ANNOTATION " + d + " 被标注了多次 —— 同一测试两条 ignore");
  const unowned = entries.filter((e) => e.category === "unowned" || !CATEGORIES.includes(e.category)).map((e) => e.name);
  const byCat = {};
  for (const c of CATEGORIES) byCat[c] = entries.filter((e) => e.category === c).length;
  const tierProblems = [];
  let tiers = new Map();
  try { tiers = miseTiers(miseFile); } catch { tierProblems.push("E_MISE_UNREADABLE 读不到 mise.toml"); }
  for (const e of entries.filter((x) => x.category?.startsWith("tier:"))) {
    const key = e.category.slice(5);
    const set = tiers.get(key);
    if (!set) tierProblems.push("E_TIER_MISSING mise 里没有 ignored 档 " + key + "（" + e.name + "）");
    else if (!set.has(e.name)) tierProblems.push("E_TIER_NOT_ENROLLED " + e.name + " 声明在 " + key + " 档，但该档的 --exact 列名里没有它");
  }
  for (const [key, set] of tiers) {
    for (const name of set) {
      const e = registered.get(name);
      if (!e) tierProblems.push("E_TIER_UNREGISTERED mise 档 " + key + " 跑了 " + name + "，但登记表里没有它");
      else if (e.tier === "test:runtime:lib:ignored:" + key) continue;
      else if (e.category !== "tier:" + key) tierProblems.push("E_TIER_MISMATCH " + name + " 在 mise 的 " + key + " 档，登记表却写 " + e.category);
    }
  }
  const lines = [];
  lines.push("ignored=" + measured.length + " registered=" + registered.size + " unowned=" + unowned.length);
  lines.push("分类: " + CATEGORIES.map((c) => c + "=" + byCat[c]).join(" ") + " (合计 " + CATEGORIES.reduce((a, c) => a + byCat[c], 0) + ")");
  for (const p of problems) lines.push("E_REGISTRY " + p);
  for (const p of countProblems) lines.push(p);
  for (const f of fresh) lines.push("E_UNREGISTERED_IGNORE " + f.name + " (" + f.file + ":" + f.line + ") —— 新增 ignore 没有登记");
  for (const m of missing) lines.push("E_STALE_ENTRY " + m + " —— 登记了但源码里没有这个 ignore");
  for (const n of unowned) lines.push("E_UNOWNED " + n + " —— 既不在 env/bl，也不在任何 mise 档，也不是 helper");
  for (const p of tierProblems) lines.push(p);
  const ok = problems.length === 0 && fresh.length === 0 && missing.length === 0 && unowned.length === 0 && tierProblems.length === 0 && countProblems.length === 0;
  lines.push(ok ? "OK 条数相等 / 每条有归属 / tier 与 mise 一致" : "FAIL " + (fresh.length + missing.length + unowned.length + tierProblems.length + problems.length + countProblems.length) + " 处");
  return { ok, text: lines.join("\n"), byCat, unowned };
}

function selftest() {
  const mk = (ignores, entries, miseBody) => {
    const root = mkdtempSync(path.join(tmpdir(), "t616-fx-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
    mkdirSync(path.join(root, "packages/runtime/src"), { recursive: true });
    writeFileSync(path.join(root, "packages/runtime/src/fake.rs"), ignores.join("\n") + "\n", { encoding: "utf8" });
    execFileSync("git", ["-C", root, "add", "-A"]);
    const regFile = path.join(root, "reg.json");
    writeFileSync(regFile, JSON.stringify({ schema: "runtime-ignored-registry/1", entries }), "utf8");
    const miseFile = path.join(root, "mise.toml");
    writeFileSync(miseFile, miseBody ?? "", "utf8");
    return { root, regFile, miseFile };
  };
  const two = ["#[ignore = \"a\"]", "#[test]", "fn alpha() {}", "#[ignore = \"b\"]", "#[test]", "fn beta() {}"];
  const tierMise = (names) => "[tasks.\"test:runtime:lib:ignored:heavy\"]\n  run = [\n" + names.map((n) => "    \"x --exact mod::" + n + "\"").join(",\n") + "\n  ]\n";
  const fixtures = [
    { name: "全部登记且 tier 一致 ⇒ 绿", ignores: two, entries: [{ name: "alpha", file: "src/fake.rs", category: "tier:heavy", tier: "test:runtime:lib:ignored:heavy" }, { name: "beta", file: "src/fake.rs", category: "helper", note: "called by alpha" }], mise: tierMise(["alpha"]), expect: true },
    { name: "新增未登记 ⇒ 红", ignores: two, entries: [{ name: "alpha", file: "src/fake.rs", category: "helper", note: "n" }], mise: "", expect: false },
    { name: "登记了但源码没有 ⇒ 红", ignores: two, entries: [{ name: "alpha", file: "src/fake.rs", category: "helper", note: "n" }, { name: "beta", file: "src/fake.rs", category: "helper", note: "n" }, { name: "gone", file: "src/fake.rs", category: "helper", note: "n" }], mise: "", expect: false },
    { name: "注释里的 #[ignore] 不算 ⇒ 绿", ignores: ["// #[ignore] 注释", "#[test]", "fn alpha() {}"], entries: [], mise: "", expect: true },
    { name: "unowned 类别必须红（unowned=0 是判据）", ignores: two, entries: [{ name: "alpha", file: "src/fake.rs", category: "unowned" }, { name: "beta", file: "src/fake.rs", category: "helper", note: "n" }], mise: "", expect: false },
    { name: "tier 声明与 mise 列名不一致 ⇒ 红", ignores: two, entries: [{ name: "alpha", file: "src/fake.rs", category: "tier:heavy", tier: "test:runtime:lib:ignored:heavy" }, { name: "beta", file: "src/fake.rs", category: "helper", note: "n" }], mise: tierMise(["beta"]), expect: false },
  ];
  let pass = 0;
  for (const fx of fixtures) {
    const { root, regFile, miseFile } = mk(fx.ignores, fx.entries, fx.mise);
    let r;
    try { r = check(root, regFile, miseFile); } catch (err) { r = { ok: false, text: String(err.message) }; }
    const good = r.ok === fx.expect;
    if (good) pass += 1; else console.log("FAIL " + fx.name + " -> " + r.text.replace(/\n/g, " | "));
  }
  console.log("selftest " + pass + "/" + fixtures.length);
  return pass === fixtures.length;
}

const argv = process.argv.slice(2);
if (argv.includes("--selftest")) process.exit(selftest() ? 0 : 1);
if (argv.includes("--list")) {
  for (const e of measuredEntries(REPO)) console.log(e.name + " " + e.file + ":" + e.line);
  process.exit(0);
}
if (!argv.includes("--check")) {
  console.error("用法: --check | --list | --selftest");
  process.exit(2);
}
const res = check(REPO);
console.log(res.text);
process.exit(res.ok ? 0 : 1);
