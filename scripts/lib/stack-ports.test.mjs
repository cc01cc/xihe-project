#!/usr/bin/env node
/**
 * PLAN-0612 M1 回归：A03 内置端口表必须与约定表逐项一致。
 *
 * 这份期望值是**冻结契约**（对应 one 侧端口分配文档与 `spec/stack-contract.md §2`）：
 * - 8 个 stack × 5 个端口（ui/cp/agent/runtime/postgres），逐段显式登记；
 * - 派生值（compose project / 库名 / host root / 日志目录 / 运行时状态目录）；
 * - `.env.dev` 的 stack-1 基线必须与内置表一致（改端口时两侧同批更新）。
 *
 * 跑法：`node --test scripts/lib/stack-ports.test.mjs`
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DEFAULT_STACK_ID,
  STACK_IDS,
  deriveStack,
  normalizeStackArg,
  stackEnvDefaults,
} from "./stack-ports.mjs";

const EXPECTED = {
  "stack-1": { ui: 12630, cp: 12631, agent: 12632, runtime: 12633, postgres: 12634 },
  "stack-2": { ui: 12640, cp: 12641, agent: 12642, runtime: 12643, postgres: 12644 },
  "stack-3": { ui: 12650, cp: 12651, agent: 12652, runtime: 12653, postgres: 12654 },
  "stack-4": { ui: 12660, cp: 12661, agent: 12662, runtime: 12663, postgres: 12664 },
  "stack-5": { ui: 12700, cp: 12701, agent: 12702, runtime: 12703, postgres: 12704 },
  "stack-6": { ui: 12710, cp: 12711, agent: 12712, runtime: 12713, postgres: 12714 },
  "stack-7": { ui: 12730, cp: 12731, agent: 12732, runtime: 12733, postgres: 12734 },
  "stack-8": { ui: 12740, cp: 12741, agent: 12742, runtime: 12743, postgres: 12744 },
};

test("STACK_IDS 覆盖 8 个显式槽位", () => {
  assert.deepEqual([...STACK_IDS], Object.keys(EXPECTED));
  assert.equal(DEFAULT_STACK_ID, "stack-1");
});

test("8 个 stack × 5 端口逐项一致", () => {
  for (const [stackId, expectedPorts] of Object.entries(EXPECTED)) {
    const derived = deriveStack(stackId);
    assert.deepEqual(derived.ports, expectedPorts, `${stackId} ports`);
    assert.equal(derived.base, expectedPorts.ui, `${stackId} base=ui`);
    assert.equal(derived.index, Number(stackId.slice("stack-".length)), `${stackId} index`);
  }
});

test("派生路径：stack-1 用仓库根目录名，stack-2..8 用 .xihe-stacks/<n>", () => {
  const s1 = deriveStack("stack-1");
  assert.equal(s1.composeProject, "a03-xihe");
  assert.equal(s1.containerPrefix, "xihe-workspace-ws_");
  assert.equal(s1.database, "xihe_1");
  assert.equal(s1.hostRoot, ".xihe-workspaces");
  assert.equal(s1.logDir, "logs");
  assert.equal(s1.runtimeStateDir, ".xihe-state");

  for (const stackId of ["stack-2", "stack-3", "stack-8"]) {
    const n = stackId.slice("stack-".length);
    const derived = deriveStack(stackId);
    assert.equal(derived.composeProject, `xihe-stack-${n}`, `${stackId} composeProject`);
    assert.equal(derived.containerPrefix, `xihe-ws-s${n}-ws_`, `${stackId} containerPrefix`);
    assert.equal(derived.database, `xihe_${n}`, `${stackId} database`);
    assert.equal(derived.hostRoot, `.xihe-stacks/${n}/workspaces`, `${stackId} hostRoot`);
    assert.equal(derived.logDir, `.xihe-stacks/${n}/logs`, `${stackId} logDir`);
    assert.equal(derived.runtimeStateDir, `.xihe-stacks/${n}/state`, `${stackId} runtimeStateDir`);
  }
});

test("env 派生值（URL / DSN / compose / sandbox）与端口一一对应", () => {
  const derived = deriveStack("stack-3");
  assert.equal(derived.env.XIHE_STACK_ID, "stack-3");
  assert.equal(derived.env.XIHE_UI_PORT, "12650");
  assert.equal(derived.env.XIHE_CP_PORT, "12651");
  assert.equal(derived.env.XIHE_AGENT_PORT, "12652");
  assert.equal(derived.env.XIHE_RUNTIME_PORT, "12653");
  assert.equal(derived.env.XIHE_PG_PORT, "12654");
  assert.equal(derived.env.XIHE_CP_URL, "http://localhost:12651");
  assert.equal(derived.env.XIHE_CP_BASE_URL, "http://localhost:12651");
  assert.equal(derived.env.XIHE_AGENT_URL, "http://localhost:12652/internal/v1/agent/chat");
  assert.equal(derived.env.XIHE_RUNTIME_URL, "http://localhost:12653");
  assert.equal(derived.env.XIHE_CP_DATASOURCE_URL, "jdbc:postgresql://localhost:12654/xihe_3");
  assert.equal(derived.env.XIHE_PG_DSN, "postgresql+psycopg://xihe:@localhost:12654/xihe_3");
  assert.equal(derived.env.XIHE_COMPOSE_PROJECT, "xihe-stack-3");
  assert.equal(derived.env.XIHE_SANDBOX_CONTAINER_PREFIX, "xihe-ws-s3-ws_");
  assert.equal(derived.env.XIHE_SANDBOX_STACK_ID, "stack-3");
  assert.equal(derived.env.POSTGRES_DB, "xihe_3");
});

test("normalizeStackArg：数字 / 完整 id / 缺省", () => {
  assert.equal(normalizeStackArg("1"), "stack-1");
  assert.equal(normalizeStackArg("3"), "stack-3");
  assert.equal(normalizeStackArg("stack-4"), "stack-4");
  assert.equal(normalizeStackArg(undefined), "stack-1");
  assert.equal(normalizeStackArg(" 7 "), "stack-7");
});

test("非法 stack id 显式失败（不猜默认值）", () => {
  for (const bad of ["stack-0", "stack-9", "stack-x", "", null, 1]) {
    assert.throws(() => deriveStack(bad), /invalid XIHE_STACK_ID/, `must reject ${JSON.stringify(bad)}`);
  }
});

test("stackEnvDefaults 只补缺省，不覆盖已有 env", () => {
  const derived = deriveStack("stack-2");
  const applied = stackEnvDefaults(derived, { XIHE_CP_PORT: "19999", XIHE_PG_PORT: "" });
  assert.equal(applied.XIHE_CP_PORT, undefined, "existing value must not be overwritten");
  assert.equal(applied.XIHE_PG_PORT, "12644", "empty value counts as missing");
  assert.equal(applied.XIHE_UI_PORT, "12640");
});

test("`.env.dev` 的 stack-1 端口基线与内置表一致", () => {
  const envDev = readFileSync(new URL("../../.env.dev", import.meta.url), "utf8");
  const keys = ["XIHE_UI_PORT", "XIHE_CP_PORT", "XIHE_AGENT_PORT", "XIHE_RUNTIME_PORT", "XIHE_PG_PORT"];
  const parsed = {};
  for (const line of envDev.split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || !keys.includes(match[1])) continue;
    parsed[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  const s1 = deriveStack("stack-1");
  assert.deepEqual(parsed, {
    XIHE_UI_PORT: String(s1.ports.ui),
    XIHE_CP_PORT: String(s1.ports.cp),
    XIHE_AGENT_PORT: String(s1.ports.agent),
    XIHE_RUNTIME_PORT: String(s1.ports.runtime),
    XIHE_PG_PORT: String(s1.ports.postgres),
  });
});
