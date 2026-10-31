#!/usr/bin/env node
/**
 * XH 并行 host 栈的端口事实源（PLAN-0612 M1）。
 *
 * 为什么在本仓库：XH 必须能被单独 clone 后启动（用户 2026-10-31/11-01 裁定
 * 「XH 不应依赖 ONE，必须严格剥离」）。历史实现从 `<one>/scripts/ports.mjs`
 * 向上查找并 import，单独 clone 时找不到即 `exit 2`，发生在任何服务启动之前。
 * 自 PLAN-0612 起：**端口默认值与派生规则归 A03**；`one/` 只保留端口**分配文档**
 * （项目 → 端口段），不再作为本模块的运行时依赖。
 *
 * 契约：
 * - 本文件不读环境变量、不探活、不启动任何进程（纯数据 + 纯函数）。
 * - 修改 `STACK_PORTS` 属端口契约变更：必须同批更新 `one/` 的端口分配文档与
 *   `spec/stack-contract.md`，并跑 `node --test scripts/lib/stack-ports.test.mjs`。
 * - stack-1 的端口必须与 `.env.dev` 的 XIHE_*_PORT 基线逐项相等（回归门）。
 */

/** stack-1 起各栈的显式端口（不用公式，逐段登记，见 spec/stack-contract.md §2）。 */
export const STACK_PORTS = Object.freeze({
  "stack-1": Object.freeze({ ui: 12630, cp: 12631, agent: 12632, runtime: 12633, postgres: 12634 }),
  "stack-2": Object.freeze({ ui: 12640, cp: 12641, agent: 12642, runtime: 12643, postgres: 12644 }),
  "stack-3": Object.freeze({ ui: 12650, cp: 12651, agent: 12652, runtime: 12653, postgres: 12654 }),
  "stack-4": Object.freeze({ ui: 12660, cp: 12661, agent: 12662, runtime: 12663, postgres: 12664 }),
  "stack-5": Object.freeze({ ui: 12700, cp: 12701, agent: 12702, runtime: 12703, postgres: 12704 }),
  "stack-6": Object.freeze({ ui: 12710, cp: 12711, agent: 12712, runtime: 12713, postgres: 12714 }),
  "stack-7": Object.freeze({ ui: 12730, cp: 12731, agent: 12732, runtime: 12733, postgres: 12734 }),
  "stack-8": Object.freeze({ ui: 12740, cp: 12741, agent: 12742, runtime: 12743, postgres: 12744 }),
});

export const STACK_IDS = Object.freeze(Object.keys(STACK_PORTS));
export const DEFAULT_STACK_ID = "stack-1";

/**
 * 纯函数：stack id → 全部端口与派生值。非法/未登记 id 抛错（显式失败，不猜）。
 * stack-1 的结果必须与 .env.dev 的默认值逐项相等（不变式 I1）。
 */
export function deriveStack(stackId = DEFAULT_STACK_ID) {
  if (typeof stackId !== "string" || !Object.hasOwn(STACK_PORTS, stackId)) {
    throw new Error(`invalid XIHE_STACK_ID ${JSON.stringify(stackId)}; expected one of ${STACK_IDS.join(", ")}`);
  }
  const index = Number(stackId.slice("stack-".length));
  const ports = { ...STACK_PORTS[stackId] };
  const isDefault = index === 1;
  const suffix = String(index);
  const database = `xihe_${suffix}`;
  const derived = {
    stackId,
    index,
    base: ports.ui,
    ports,
    composeProject: isDefault ? "a03-xihe" : `xihe-stack-${suffix}`,
    containerPrefix: isDefault ? "xihe-workspace-ws_" : `xihe-ws-s${suffix}-ws_`,
    database,
    hostRoot: isDefault ? ".xihe-workspaces" : `.xihe-stacks/${suffix}/workspaces`,
    logDir: isDefault ? "logs" : `.xihe-stacks/${suffix}/logs`,
    runtimeStateDir: isDefault ? ".xihe-state" : `.xihe-stacks/${suffix}/state`,
  };
  derived.env = {
    XIHE_STACK_ID: stackId,
    XIHE_UI_PORT: String(ports.ui),
    XIHE_CP_PORT: String(ports.cp),
    XIHE_AGENT_PORT: String(ports.agent),
    XIHE_RUNTIME_PORT: String(ports.runtime),
    XIHE_PG_PORT: String(ports.postgres),
    XIHE_CP_URL: `http://localhost:${ports.cp}`,
    XIHE_CP_BASE_URL: `http://localhost:${ports.cp}`,
    XIHE_AGENT_URL: `http://localhost:${ports.agent}/internal/v1/agent/chat`,
    XIHE_RUNTIME_URL: `http://localhost:${ports.runtime}`,
    XIHE_CP_DATASOURCE_URL: `jdbc:postgresql://localhost:${ports.postgres}/${database}`,
    XIHE_PG_DSN: `postgresql+psycopg://xihe:@localhost:${ports.postgres}/${database}`,
    XIHE_WORKSPACE_HOST_ROOT: derived.hostRoot,
    XIHE_LOG_DIR: derived.logDir,
    XIHE_RUNTIME_STATE_DIR: derived.runtimeStateDir,
    XIHE_COMPOSE_PROJECT: derived.composeProject,
    // 沙箱容器命名/标签：模块只读这两个派生值，不读 XIHE_STACK_ID（不变式 I6）。
    XIHE_SANDBOX_CONTAINER_PREFIX: derived.containerPrefix,
    XIHE_SANDBOX_STACK_ID: stackId,
    POSTGRES_DB: database,
  };
  return derived;
}

/**
 * 只补缺省：返回需要在启动子进程前注入的 env 子集；已存在的键一律不覆盖。
 * e2e-host.mjs 会显式注入 XIHE_UI_PORT/XIHE_CP_BASE_URL/XIHE_LOG_DIR（B4），
 * 无条件覆盖会破坏它的隔离。
 */
export function stackEnvDefaults(derived, env = process.env) {
  const applied = {};
  for (const [key, value] of Object.entries(derived.env)) {
    if (env[key] === undefined || env[key] === "") applied[key] = value;
  }
  return applied;
}

/** `--stack 2` / `--stack=stack-2` → `stack-2`。 */
export function normalizeStackArg(raw) {
  if (raw === undefined) return DEFAULT_STACK_ID;
  const value = String(raw).trim();
  return /^\d+$/.test(value) ? `stack-${value}` : value;
}
