#!/usr/bin/env node
/**
 * check-mise-env — env 变量登记门（task-131，Lead 裁定 A：v1 report-only）。
 * 判据：properties 里出现的 XIHE_* 环境变量，未在内建白名单且未在 AGENTS.md /
 * xc-cross-cutting-checklist 登记 ⇒ WARN（v1 不 fail；存量清 0 后由 Lead 裁定转 fail-closed）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // = <A03 仓库根>
// ONE = one 工作区根 = A03 仓库根的**父目录**（退 1 级）。曾写成 "..","..",".." ⇒ 退到盘根，
// 于是 `.agents/...` 解析成 `H:\.agents\...` 直接 ENOENT（task-272；别按层数猜根，按语义只退一级）。
const ONE = resolve(ROOT, "..");

/** 内建白名单：门禁/基线类变量，语义即「基础设施」，免登记。 */
const WHITELIST = new Set([
  "XIHE_CP_PORT", "XIHE_PG_PORT", "XIHE_LOG_LEVEL", "XIHE_LOG_LEVEL_CP", "XIHE_LOG_DIR",
  "XIHE_CP_API_TOKEN", "XIHE_ENV",
]);

function collectPropsFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) collectPropsFiles(p, acc);
    else if (name.endsWith(".properties")) acc.push(p);
  }
  return acc;
}

function main() {
  const files = collectPropsFiles(join(ROOT, "packages"));
  const found = new Map(); // name -> first location
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\$\{(XIHE_[A-Z0-9_]+)/g)) {
        const name = m[1];
        if (WHITELIST.has(name)) continue;
        // 用 relative 而不是 `f.replace(ROOT + "/", "")`：Windows 的 join 产出反斜杠，
        // 硬编码 "/" 永远替换不中 ⇒ 会把机器绝对路径打进门禁输出（task-272）。
        if (!found.has(name)) found.set(name, `${relative(ROOT, f)}:${i + 1}`);
      }
    });
  }
  const ag = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
  const xc = readFileSync(join(ONE, ".agents/skills/xc-cross-cutting-checklist/SKILL.md"), "utf8");
  const missing = [];
  for (const [name, loc] of [...found.entries()].sort()) {
    if (ag.includes(name) || xc.includes(name)) continue;
    missing.push({ name, loc });
  }
  console.log(`[check-mise-env] properties 扫描 ${files.length} 个文件，XIHE_* 变量 ${found.size} 个（白名单 ${WHITELIST.size} 个）`);
  for (const m of missing) console.log(`  WARN 未登记：${m.name} @ ${m.loc}`);
  console.log(
    missing.length
      ? `[check-mise-env] v1 report-only：${missing.length} 条 WARN（exit 0；存量清 0 后转 fail-closed）`
      : "[check-mise-env] PASS：无未登记变量",
  );
}
main();