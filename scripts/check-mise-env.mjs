#!/usr/bin/env node
/**
 * check-mise-env — env 变量登记门（task-131 v1 report-only → task-273 v2 fail-closed）。
 * 判据：properties 里出现的 XIHE_* 环境变量，未在内建白名单且未在 AGENTS.md /
 * xc-cross-cutting-checklist 登记 ⇒ WARN；**v2 起 WARN 非空 ⇒ exit 1**（v1 恒 exit 0，
 * 于是"永远绿"、红只可能来自崩溃 —— 这正是它被误当"环境问题"的机制，见 task-272/273）。
 *
 * 退出码：0 = 无 WARN（PASS）/ 1 = 有未登记变量（fail-closed）/ 崩溃保持非 0（fail-closed，不许绿着死）。
 * 自测：`node scripts/check-mise-env.mjs --selftest`（内置 fixture，2 例：WARN 非空 ⇒ 1 / WARN 为空 ⇒ 0）。
 * 注：本脚本刻意不带同名 `.test.mjs` —— `scripts/test-wiring.test.mjs` 要求每个 `*.test.mjs` 都被
 * 某个 mise 任务真的执行，而 `mise.toml` 不在本卡写面；故自测内建在脚本里，不新增需接线的测试文件。
 */
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), ".."); // = <A03 仓库根>
// ONE = one 工作区根 = A03 仓库根的**父目录**（退 1 级）。曾写成 "..","..",".." ⇒ 退到盘根，
// 于是 `.agents/...` 解析成 `H:\.agents\...` 直接 ENOENT（task-272；别按层数猜根，按语义只退一级）。
const ONE = resolve(ROOT, "..");

/** 内建白名单：门禁/基线类变量，语义即「基础设施」，免登记。 */
const WHITELIST = new Set([
  "XIHE_CP_PORT", "XIHE_PG_PORT", "XIHE_LOG_LEVEL", "XIHE_LOG_LEVEL_CP", "XIHE_LOG_DIR",
  "XIHE_CP_API_TOKEN", "XIHE_ENV",
]);

function collectPropsFiles(dir, acc = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    // packages 目录不存在 ⇒ 交给上层 fail-closed（不许"扫不到文件 = 全部登记"）
    throw new Error(`[check-mise-env] 无法扫描 ${dir}`);
  }
  for (const name of names) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) collectPropsFiles(p, acc);
    else if (name.endsWith(".properties")) acc.push(p);
  }
  return acc;
}

/**
 * 纯计算：扫 properties + 查登记 ⇒ 计数与未登记清单（不打印、不退出）。selftest 直接复用同一路径。
 * @returns {{ fileCount: number, found: Map<string,string>, missing: Array<{name:string, loc:string}> }}
 */
function runGate(root = ROOT, one = ONE) {
  const files = collectPropsFiles(join(root, "packages"));
  const found = new Map(); // name -> first location
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\$\{(XIHE_[A-Z0-9_]+)/g)) {
        const name = m[1];
        if (WHITELIST.has(name)) continue;
        // 用 relative 而不是 `f.replace(ROOT + "/", "")`：Windows 的 join 产出反斜杠，
        // 硬编码 "/" 永远替换不中 ⇒ 会把机器绝对路径打进门禁输出（task-272）。
        if (!found.has(name)) found.set(name, `${relative(root, f)}:${i + 1}`);
      }
    });
  }
  const ag = readFileSync(join(root, "AGENTS.md"), "utf8");
  const xc = readFileSync(join(one, ".agents/skills/xc-cross-cutting-checklist/SKILL.md"), "utf8");
  const missing = [];
  for (const [name, loc] of [...found.entries()].sort()) {
    if (ag.includes(name) || xc.includes(name)) continue;
    missing.push({ name, loc });
  }
  return { fileCount: files.length, found, missing };
}

/** 退出码决策（task-273 唯一改动点：WARN 非空 ⇒ 1）。 */
function exitCodeFor(missingCount) {
  return missingCount > 0 ? 1 : 0;
}

function main() {
  const { fileCount, found, missing } = runGate();
  console.log(`[check-mise-env] properties 扫描 ${fileCount} 个文件，XIHE_* 变量 ${found.size} 个（白名单 ${WHITELIST.size} 个）`);
  for (const m of missing) console.log(`  WARN 未登记：${m.name} @ ${m.loc}`);
  console.log(
    missing.length
      ? `[check-mise-env] v2 fail-closed：${missing.length} 条 WARN ⇒ exit 1（登记到 xc-cross-cutting-checklist §env 变量登记 或 AGENTS.md，确属基础设施再进白名单）`
      : "[check-mise-env] PASS：无未登记变量",
  );
  process.exitCode = exitCodeFor(missing.length);
}

/** 内置自测：临时造 one/a03 两级树（与 task-272 的 `.tmp` fixture 同形），跑两份 properties 断言退出码。 */
function selftest() {
  const fx = mkdtempSync(join(tmpdir(), "check-mise-env-selftest-"));
  const fxOne = join(fx, "one");
  const fxA03 = join(fxOne, "a03");
  const results = []; // [name, ok, detail]
  try {
    mkdirSync(join(fxA03, "scripts"), { recursive: true });
    mkdirSync(join(fxA03, "packages"), { recursive: true });
    mkdirSync(join(fxOne, ".agents", "skills", "xc-cross-cutting-checklist"), { recursive: true });
    const script = join(fxA03, "scripts", "check-mise-env.mjs");
    copyFileSync(SELF, script);
    writeFileSync(join(fxA03, "AGENTS.md"), "# fixture AGENTS.md\n");
    writeFileSync(
      join(fxOne, ".agents", "skills", "xc-cross-cutting-checklist", "SKILL.md"),
      "# fixture xc\n\n- `XIHE_FX_REGISTERED` | fixture 已登记 | x\n",
    );
    const props = join(fxA03, "packages", "fx.properties");

    // 例 1：1 条未登记 ⇒ exit 1（fail-closed 生效）
    writeFileSync(props, "a.registered=${XIHE_FX_REGISTERED}\nb.unregistered=${XIHE_FX_UNREGISTERED}\nc.white=${XIHE_PG_PORT}\n");
    const red = spawnSync(process.execPath, [script], { encoding: "utf8" });
    results.push(["WARN 非空 ⇒ exit 1", red.status === 1 && (red.stdout ?? "").includes("1 条 WARN"), `exit=${red.status}`]);
    // 附带钉住 task-272 的第二处修复：WARN 的 loc 必须是仓库相对路径，不得含盘符
    const loc = /WARN 未登记：XIHE_FX_UNREGISTERED @ ([^\r\n]+)/.exec(red.stdout ?? "");
    results.push([
      "WARN loc 仍是相对路径（无盘符）",
      Boolean(loc) && !/^[A-Za-z]:/.test(loc[1]) && loc[1].startsWith("packages"),
      loc ? loc[1] : "未匹配到 WARN 行",
    ]);

    // 例 2：全部已登记（含白名单变量） ⇒ exit 0（不许把"没扫到问题"误翻成红）
    writeFileSync(props, "a.registered=${XIHE_FX_REGISTERED}\nc.white=${XIHE_PG_PORT}\n");
    const green = spawnSync(process.execPath, [script], { encoding: "utf8" });
    results.push(["WARN 为空 ⇒ exit 0", green.status === 0 && (green.stdout ?? "").includes("PASS"), `exit=${green.status}`]);
  } finally {
    rmSync(fx, { recursive: true, force: true });
  }
  const failed = results.filter(([, ok]) => !ok);
  for (const [name, ok, detail] of results) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}  (${detail})`);
  console.log(`[check-mise-env] selftest ${results.length - failed.length}/${results.length} 通过`);
  return failed.length ? 1 : 0;
}

if (process.argv.includes("--selftest")) {
  process.exitCode = selftest();
} else if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    [
      "check-mise-env.mjs — env 变量登记门（task-131 v1 → task-273 v2 fail-closed）",
      "",
      "用法: node scripts/check-mise-env.mjs [--selftest] [--help]",
      "",
      "  --selftest  跑内置 fixture（WARN 非空 ⇒ exit 1 / WARN 为空 ⇒ exit 0）",
      "",
      "退出码: 0 无未登记变量 / 1 有未登记变量（fail-closed）",
    ].join("\n"),
  );
} else {
  main();
}
