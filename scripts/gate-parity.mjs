#!/usr/bin/env node
/**
 * check-gate-parity — 门集三方对账（task-105 / D-853）。
 *
 * 三方：① 梯次（窗口实跑的门，scripts/gate-ladder.json）② SSOT 登记（xh-verify-gates.mjs 的 DEFAULT_GATES）
 *       ③ mise.toml 是否有该 task 定义。
 *
 * 三分矩阵（Lead 2026-11-11 裁定；D-847 同族：缺失必须是一个名字）：
 *   ① 梯次跑 & SSOT 登记       ⇒ ok
 *   ② 梯次跑 & SSOT 未登记     ⇒ red（除 WINDOW_ONLY 具名豁免）
 *   ③ SSOT 登记 & 梯次不跑     ⇒ red（除 NOT_IN_WINDOW 具名豁免 + 理由）
 *
 * 判定是集合差，不写死任何门名：修好某门后自动变绿，别的门漂移时仍会红。
 * 用法：node scripts/gate-parity.mjs [--json]
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_GATES } from "./xh-verify-gates.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** 只在窗口里跑、有意不进 SSOT 默认集的门（必须给命令与理由）。 */
export const WINDOW_ONLY = Object.freeze([
  { id: "check:gate-parity", cmd: "node scripts/gate-parity.mjs", why: "本判据自身：窗口收尾时跑；不进默认门集以免自指" },
]);

/** SSOT 登记、但有意不在窗口梯次里跑的门（必须给理由与代价）。 */
export const NOT_IN_WINDOW = Object.freeze([
  { id: "test:mock", why: "888s，窗 13min 涨到 28min，不值（Lead 2026-11-11）" },
  { id: "check:mock-baseline", why: "紧随 test:mock 的基线比对，无新报告即无意义" },
  { id: "check:a11y-refs", why: "被 check:a11y-refs:enforce 取代（前者警告级、后者阻断级）" },
  { id: "test:cp:executed", why: "梯次跑的是 test:cp 本体（含 zero-execution guard），本门是其子断言" },
]);

/** mise.toml 里声明的任务 id 集合。 */
export function miseTaskIds(tomlText) {
  const ids = new Set();
  for (const m of String(tomlText).matchAll(/^\[tasks\."([^"]+)"\]/gm)) ids.add(m[1]);
  return ids;
}

/** 纯函数：三分矩阵求值。 */
export function evaluateParity({ ladder, ssot, windowOnly = [], notInWindow = [] }) {
  const inLadder = new Set(ladder);
  const inSsot = new Set(ssot);
  const wo = new Set(windowOnly.map((x) => x.id));
  const niw = new Set(notInWindow.map((x) => x.id));
  const rows = [];
  for (const id of [...inLadder].sort()) {
    if (inSsot.has(id)) rows.push({ id, cell: "1-ladder-and-ssot", ok: true, why: "梯次跑 & SSOT 登记" });
    else if (wo.has(id)) rows.push({ id, cell: "2-ladder-window-only", ok: true, why: "梯次跑 & 未登记，但已具名 window-only" });
    else rows.push({ id, cell: "2-ladder-unregistered", ok: false, why: "梯次跑了但 SSOT 未登记，且不在 WINDOW_ONLY ⇒ 漂移" });
  }
  for (const id of [...inSsot].sort()) {
    if (inLadder.has(id)) continue;
    if (niw.has(id)) rows.push({ id, cell: "3-ssot-not-in-window", ok: true, why: "SSOT 登记但梯次不跑，已具名豁免" });
    else rows.push({ id, cell: "3-ssot-orphan", ok: false, why: "SSOT 登记但梯次不跑，且无 not-in-window 理由" });
  }
  const bad = rows.filter((r) => !r.ok);
  return { rows, bad, ok: bad.length === 0 };
}

function main() {
  const ladder = JSON.parse(readFileSync(resolve(ROOT, "scripts/gate-ladder.json"), "utf8")).gates;
  const ssot = DEFAULT_GATES.map((g) => g.id);
  const miseIds = miseTaskIds(readFileSync(resolve(ROOT, "mise.toml"), "utf8"));
  const r = evaluateParity({ ladder, ssot, windowOnly: WINDOW_ONLY, notInWindow: NOT_IN_WINDOW });
  if (process.argv.includes("--json")) { console.log(JSON.stringify({ ...r, ladderCount: ladder.length, ssotCount: ssot.length }, null, 2)); process.exit(r.ok ? 0 : 1); }
  console.log(`门集对账：梯次 ${ladder.length} / SSOT ${ssot.length} / mise ${miseIds.size}`);
  for (const row of r.rows) console.log(`  ${row.ok ? "OK " : "RED"} [${row.cell}] ${row.id} —— ${row.why}`);
  const noTask = ladder.filter((id) => !miseIds.has(id));
  if (noTask.length) console.log(`  note: 梯次里 ${noTask.length} 门在 mise.toml 无 task：${noTask.join(", ")}`);
  if (!r.ok) { console.error("[gate-parity] FAIL: " + r.bad.length + " 条不一致 —— " + r.bad.map((b) => b.id + "(" + b.cell + ")").join(", ")); process.exit(1); }
  console.log("[gate-parity] PASS");
}
main();