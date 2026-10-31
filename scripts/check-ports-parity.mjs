#!/usr/bin/env node
/**
 * PLAN-0612 T1.4-adjacent：端口分配**对照**（A03 事实源 vs ONE 分配文档）。
 *
 * 为什么单独一个门：A03 运行时不依赖 ONE（`scripts/lib/stack-ports.mjs` 是事实源），
 * 但"事实源"与 one 的端口**分配文档/编排镜像**仍需防止漂移。本脚本只在 ONE 存在时
 * 做逐项比对；ONE 不存在时**显式 skip**（不是失败），保证单独 clone 可运行。
 *
 * 比较内容：
 * 1. 8 stack × 5 端口：A03 `STACK_PORTS` vs one `config/ports.mjs#projects.xihe.stackSlots`；
 * 2. 派生字段：A03 `deriveStack()` vs one `scripts/ports.mjs#deriveStack()`
 *    （base/ports/composeProject/containerPrefix/database/hostRoot/logDir/runtimeStateDir/env）；
 * 3. `.env.dev` 的 stack-1 端口基线 vs A03 内置表（仓库内自洽性）。
 *
 * 用法：node scripts/check-ports-parity.mjs [--json]
 * 退出码：0 = 一致或 skip；1 = 发现漂移（打印逐项差异）。
 *
 * 注：不提供任何"one 根目录定位开关"（PLAN-0612 决策 #1 已否决该逃逸口）；ONE 根目录
 * 只按"从本仓库向上查找 config/ports.mjs"解析，找不到即 skip。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const args = process.argv.slice(2);
const json = args.includes("--json");

function findOneRoot(start) {
  let current = resolve(start);
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(current, "config", "ports.mjs")) && existsSync(join(current, "scripts", "ports.mjs"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function parseEnvPorts(filePath) {
  if (!existsSync(filePath)) return {};
  const keys = ["XIHE_UI_PORT", "XIHE_CP_PORT", "XIHE_AGENT_PORT", "XIHE_RUNTIME_PORT", "XIHE_PG_PORT"];
  const parsed = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || !keys.includes(match[1])) continue;
    parsed[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return parsed;
}

const { STACK_IDS, deriveStack } = await import(pathToFileURL(join(scriptDir, "lib", "stack-ports.mjs")).href);

const envDevPorts = parseEnvPorts(join(projectRoot, ".env.dev"));
const envPortDiffs = [];
for (const [key, expected] of Object.entries(deriveStack("stack-1").env)) {
  if (!key.endsWith("_PORT")) continue;
  if (!(key in envDevPorts)) {
    envPortDiffs.push(`.env.dev missing ${key} (expected ${expected})`);
  } else if (envDevPorts[key] !== expected) {
    envPortDiffs.push(`.env.dev ${key}=${envDevPorts[key]} != built-in ${expected}`);
  }
}

const oneRoot = findOneRoot(projectRoot);
if (!oneRoot || !existsSync(join(oneRoot, "config", "ports.mjs"))) {
  const reason = `no ONE workspace (config/ports.mjs) found above ${projectRoot}`;
  const result = {
    ok: envPortDiffs.length === 0,
    skipped: true,
    reason: `${reason}; ONE parity comparison skipped (A03 runs standalone)`,
    envDevPortDiffs: envPortDiffs,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    console.log(`[ports-parity] SKIP: ${result.reason}`);
    for (const diff of envPortDiffs) console.log(`[ports-parity] DIFF: ${diff}`);
    console.log(`[ports-parity] env.dev self-consistency: ${envPortDiffs.length === 0 ? "ok" : "drift"}`);
  }
  process.exit(result.ok ? 0 : 1);
}

const oneConfig = await import(pathToFileURL(join(oneRoot, "config", "ports.mjs")).href);
const onePorts = await import(pathToFileURL(join(oneRoot, "scripts", "ports.mjs")).href);
const slots = oneConfig.ports?.projects?.xihe?.stackSlots;
if (!Array.isArray(slots)) {
  console.error(`[ports-parity] ERROR: ${join(oneRoot, "config", "ports.mjs")} has no projects.xihe.stackSlots`);
  process.exit(1);
}

const diffs = [];
const rows = [];
for (const stackId of STACK_IDS) {
  const a03 = deriveStack(stackId);
  const one = onePorts.deriveStack(stackId);
  for (const field of [
    "ports",
    "base",
    "composeProject",
    "containerPrefix",
    "database",
    "hostRoot",
    "logDir",
    "runtimeStateDir",
    "env",
  ]) {
    const left = JSON.stringify(a03[field]);
    const right = JSON.stringify(one[field]);
    if (left !== right) diffs.push(`${stackId}.${field}: a03=${left} one=${right}`);
  }
  const slot = slots.find((entry) => entry.id === stackId);
  if (!slot) {
    diffs.push(`${stackId}: missing from one stackSlots`);
  } else if (JSON.stringify(slot.ports) !== JSON.stringify(a03.ports)) {
    diffs.push(`${stackId}.oneStackSlots: ${JSON.stringify(slot.ports)} != ${JSON.stringify(a03.ports)}`);
  }
  rows.push({ stackId, ports: a03.ports });
}

const result = {
  ok: diffs.length === 0 && envPortDiffs.length === 0,
  skipped: false,
  oneRoot,
  stacksChecked: rows.length,
  diffs,
  envDevPortDiffs: envPortDiffs,
  rows,
};
if (json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  console.log(`[ports-parity] one root: ${oneRoot}`);
  console.log(`[ports-parity] stacks checked: ${rows.length} × 5 ports + derived fields`);
  for (const row of rows) {
    console.log(`  ${row.stackId}: ui=${row.ports.ui} cp=${row.ports.cp} agent=${row.ports.agent} runtime=${row.ports.runtime} pg=${row.ports.postgres}`);
  }
  for (const diff of [...diffs, ...envPortDiffs]) console.log(`[ports-parity] DIFF: ${diff}`);
  console.log(`[ports-parity] ${result.ok ? "OK (no drift)" : `FAIL (${diffs.length + envPortDiffs.length} diff(s))`}`);
}
process.exit(result.ok ? 0 : 1);
