#!/usr/bin/env node
/**
 * task-304：`packages/ui` 的 html 入口必须声明双配色。
 *
 * 为什么需要这条门：`<meta name="color-scheme" content="light dark" />` 不负责主题（主题由
 * `:root{color-scheme}` 与 `xihe-theme` 决定，task-294/304 已动态实测），它负责的是 **UA 默认配色**——
 * 滚动条、焦点环、日期选择器、autofill、Canvas/CanvasText 这类浏览器原生件在 CSS 生效前/之外的取色。
 * 缺了这一行，原生件在深色下仍是浅色。
 *
 * 判据为什么是「全有」而不是「多数有」：2026-11-13 实测这一族 6 份 html 里 4 份有、2 份没有，
 * 于是「这行是不是必须」只能靠人记。改成 6/6 之后，它可以是一条机器检查（本脚本）。
 *
 * 现状：**report-only**（默认恒 exit 0）。不并入 `mise.toml` —— 改 mise 本身是窗口类（W2，
 * 实测 13m21s 一个窗），且「加一条没人跑的门等于没有门」（`D-1074`）。接线点见证据包
 * `internal/A03-xihe/evidence/2026-11-13-config-domain-selects/README.md` §5。
 *
 * 用法：
 *   node scripts/check-ui-entry-color-scheme.mjs            # 报告，exit 0
 *   node scripts/check-ui-entry-color-scheme.mjs --enforce  # 缺失即 exit 1（接线后再开）
 *   node scripts/check-ui-entry-color-scheme.mjs --json
 *   node scripts/check-ui-entry-color-scheme.mjs --selftest
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..");
const UI_ROOT = join(REPO_ROOT, "packages", "ui");
const SKIP_DIRS = new Set(["node_modules", "dist", ".vite", "coverage", "test-results", "playwright-report"]);

const WANTED = '<meta name="color-scheme" content="light dark"';

/** 单份文本的判定：只认 head 里的这一行，且 内容 必须是 light dark */
export function judge(html) {
  const metas = [...html.matchAll(/<meta\b[^>]*name=["\']color-scheme["\'][^>]*>/gi)].map((m) => m[0]);
  if (metas.length === 0) return { ok: false, reason: "missing", meta: null };
  // 重复声明本身是错的：多份 meta 内容不同时浏览器行为不一致，也说明有人在别处又加了一份
  if (metas.length > 1) return { ok: false, reason: "duplicate", meta: metas };
  const meta = metas[0];
  const content = (meta.match(/content=["\']([^"\']*)["\']/i) || [])[1] || "";
  const norm = content.trim().replace(/\s+/g, " ").toLowerCase();
  if (norm !== "light dark") return { ok: false, reason: "wrong-content:" + norm, meta };
  if (!/\/>|>\s*$/.test(meta)) return { ok: false, reason: "unterminated", meta };
  if (meta.indexOf("/>", meta.length - 3) === -1 && !/\s\/>/.test(meta)) {
    // self-closing 不是硬要求（HTML5 允许），这里只提示，不判失败
  }
  return { ok: true, reason: "ok", meta };
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (name.endsWith(".html")) acc.push(full);
  }
  return acc;
}

function scan() {
  const files = walk(UI_ROOT).sort();
  return files.map((abs) => {
    const rel = relative(REPO_ROOT, abs).split(sep).join("/");
    const html = readFileSync(abs, "utf8");
    return { file: rel, bytes: Buffer.byteLength(html), ...judge(html) };
  });
}

function selftest() {
  const cases = [
    { name: "标准写法", html: '<head><meta charset="utf-8" /><meta name="color-scheme" content="light dark" /></head>', ok: true },
    { name: "缺失", html: '<head><meta charset="utf-8" /></head>', ok: false, reason: "missing" },
    { name: "顺序颠倒", html: '<meta content="light dark" name="color-scheme" />', ok: true },
    { name: "多余空格", html: '<meta name="color-scheme" content="light  dark" />', ok: true },
    { name: "只写 light", html: '<meta name="color-scheme" content="light" />', ok: false, reason: "wrong-content:light" },
    { name: "重复声明", html: '<meta name="color-scheme" content="light dark" /><meta name="color-scheme" content="dark" />', ok: false, reason: "duplicate" },
    { name: "大小写与引号", html: '<META NAME="color-scheme" CONTENT="Light Dark">', ok: true },
  ];
  let bad = 0;
  for (const c of cases) {
    const r = judge(c.html);
    const ok = r.ok === c.ok && (c.ok || !c.reason || String(r.reason).startsWith(c.reason));
    if (!ok) bad++;
    console.log((ok ? "[PASS] " : "[FAIL] ") + c.name + " -> ok=" + r.ok + " reason=" + r.reason);
  }
  console.log(bad === 0 ? "selftest: " + cases.length + "/" + cases.length + " 通过" : "selftest: " + bad + " 条失败");
  return bad === 0 ? 0 : 1;
}

const argv = new Set(process.argv.slice(2));
if (argv.has("--selftest")) process.exit(selftest());

const rows = scan();
const missing = rows.filter((r) => !r.ok);
if (argv.has("--json")) {
  console.log(JSON.stringify({ checked: rows.length, ok: rows.length - missing.length, missing }, null, 1));
} else {
  console.log("ui-entry-color-scheme: 检查 " + rows.length + " 份 html（packages/ui 下，跳过 node_modules/dist 等）");
  for (const r of rows) console.log("  " + (r.ok ? "OK  " : "MISS") + " " + r.file + (r.ok ? "" : "  <- " + r.reason));
  console.log(missing.length === 0
    ? "结果: " + rows.length + "/" + rows.length + " 全部声明 <meta name=\"color-scheme\" content=\"light dark\" />"
    : "结果: " + (rows.length - missing.length) + "/" + rows.length + " 合规，缺 " + missing.length + " 份: " + missing.map((m) => m.file).join(", "));
  console.log("（report-only：不并入 mise，缺失不阻断；--enforce 才 exit 1）");
}
process.exit(argv.has("--enforce") && missing.length > 0 ? 1 : 0);
