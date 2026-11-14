#!/usr/bin/env node
/**
 * check-ignored-registry.mjs — task-612：runtime 的 #[ignore] 条数与登记清单必须相等。
 *
 * 背景：mise.toml 曾写「19 条 --ignored」，实测 29 条（34 处 grep 命中里 5 处是注释）⇒ 数字不可信，
 * 而「ignored 多少条」是「有多少真链路测试没跑」的唯一代理。本脚本把它变成可跑的判据。
 *
 * 用法：
 *   node scripts/check-ignored-registry.mjs --check      # 对账，不等即 exit 1 并点名
 *   node scripts/check-ignored-registry.mjs --list       # 只列实测条目
 *   node scripts/check-ignored-registry.mjs --selftest   # 解析器自测（4 例）
 *
 * 口径：只认 packages/runtime 下所有 .rs 里**真标注**的 `#[ignore]`（注释里出现的文字不算）；
 *      条目的类别与理由以 `packages/runtime/tests-ignored-registry.json` 为准。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const REGISTRY = path.join(REPO, "packages/runtime/tests-ignored-registry.json");
const CATEGORIES = ["env", "bl", "unowned"];

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

function loadRegistry(file = REGISTRY) {
  const reg = JSON.parse(readFileSync(file, "utf8"));
  const problems = [];
  if (reg.schema !== "runtime-ignored-registry/1") problems.push("schema 不是 runtime-ignored-registry/1");
  const seen = new Set();
  for (const e of reg.entries ?? []) {
    if (!e.name || !e.file) problems.push("条目缺 name/file: " + JSON.stringify(e));
    if (!CATEGORIES.includes(e.category)) problems.push("条目类别非法 (" + e.name + "): " + e.category);
    if (e.category === "bl" && !e.ref) problems.push("bl 类条目必须带 BL 号 (" + e.name + ")");
    if (seen.has(e.name)) problems.push("条目重名: " + e.name);
    seen.add(e.name);
  }
  return { reg, problems };
}

function check(repoRoot, registryFile) {
  const measured = measuredEntries(repoRoot);
  const { reg, problems } = loadRegistry(registryFile);
  const registered = new Map((reg.entries ?? []).map((e) => [e.name, e]));
  const seen = new Set();
  const fresh = [];
  for (const m of measured) {
    if (!registered.has(m.name)) fresh.push(m);
    seen.add(m.name);
  }
  const missing = [...registered.keys()].filter((n) => !seen.has(n));
  const byCat = {};
  for (const c of CATEGORIES) byCat[c] = (reg.entries ?? []).filter((e) => e.category === c).length;
  const lines = [];
  lines.push("ignored=" + measured.length + " registered=" + registered.size + " unowned=" + byCat.unowned);
  lines.push("分类: env=" + byCat.env + " bl=" + byCat.bl + " unowned=" + byCat.unowned);
  for (const p of problems) lines.push("E_REGISTRY " + p);
  for (const f of fresh) lines.push("E_UNREGISTERED_IGNORE " + f.name + " (" + f.file + ":" + f.line + ") —— 新增 ignore 没有登记");
  for (const m of missing) lines.push("E_STALE_ENTRY " + m + " —— 登记了但源码里没有这个 ignore");
  const ok = problems.length === 0 && fresh.length === 0 && missing.length === 0;
  lines.push(ok ? "OK 条数与实测相等，且每条都有类别" : "FAIL " + (fresh.length + missing.length + problems.length) + " 处");
  return { ok, text: lines.join("\n"), measured, byCat };
}

function selftest() {
  const dir = mkdtempSync(path.join(tmpdir(), "t612-"));
  const mk = (ignores, entries) => {
    const root = mkdtempSync(path.join(tmpdir(), "t612-fx-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
    const f = path.join(root, "packages/runtime/src/fake.rs");
    execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], { input: "" });
    mkdirSync(path.join(root, "packages/runtime/src"), { recursive: true });
    writeFileSync(path.join(root, "packages/runtime/src/fake.rs"), ignores.join("\n") + "\n", { encoding: "utf8" });
    void f;
    execFileSync("git", ["-C", root, "add", "-A"]);
    const regFile = path.join(root, "reg.json");
    writeFileSync(regFile, JSON.stringify({ schema: "runtime-ignored-registry/1", entries }), "utf8");
    return { root, regFile };
  };
  const fixtures = [
    { name: "两条都登记", ignores: ["#[ignore = \"a\"]", "#[test]", "fn alpha() {}", "#[ignore = \"b\"]", "#[test]", "fn beta() {}"], entries: [{ name: "alpha", file: "src/fake.rs", category: "unowned", reason: "a" }, { name: "beta", file: "src/fake.rs", category: "unowned", reason: "b" }], expect: true },
    { name: "新增未登记必须红", ignores: ["#[ignore = \"a\"]", "#[test]", "fn alpha() {}", "#[ignore = \"n\"]", "#[test]", "fn nova() {}"], entries: [{ name: "alpha", file: "src/fake.rs", category: "unowned", reason: "a" }], expect: false },
    { name: "登记的已消失必须红", ignores: ["#[ignore = \"a\"]", "#[test]", "fn alpha() {}"], entries: [{ name: "alpha", file: "src/fake.rs", category: "unowned" }, { name: "gone", file: "src/fake.rs", category: "unowned" }], expect: false },
    { name: "注释里的 #[ignore] 不算标注", ignores: ["// #[ignore] 只是注释", "#[test]", "fn alpha() {}"], entries: [], expect: true },
    { name: "bl 类缺 BL 号必须红", ignores: ["#[ignore = \"x\"]", "#[test]", "fn alpha() {}"], entries: [{ name: "alpha", file: "src/fake.rs", category: "bl" }], expect: false },
  ];
  let pass = 0;
  for (const fx of fixtures) {
    const { root, regFile } = mk(fx.ignores, fx.entries);
    let r;
    try { r = check(root, regFile); } catch (err) { r = { ok: false, text: String(err.message) }; }
    const good = r.ok === fx.expect;
    if (good) pass += 1;
    if (!good || process.env.T612_VERBOSE) console.log((good ? "PASS " : "FAIL ") + fx.name + (good ? "" : " -> " + r.text));
  }
  console.log("selftest " + pass + "/" + fixtures.length);
  void dir;
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
