#!/usr/bin/env node
// dev:host 自动导入 config.import.local.jsonc（与 dev:full 的 dev-all.sh 同语义）。
//
// 触发条件（缺一即跳过，不报错）：
//   1. 项目根存在 config.import.local.jsonc；
//   2. OS 环境变量 XIHE_DEV_ADMIN_PASSWORD 已设置（禁止写入脚本/git/日志/plan）。
//
// 语义：等 CP ready → 以该密码登录 admin@xihe.local → POST /api/v1/config/import。
// 若 admin 登录 401（常见于旧随机密码种子的存量库），报错并提示先执行
// `mise run reset-admin` 把同一密码写入库后重试。密钥永不打印，只打印脱敏摘要。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const importPath = path.join(projectRoot, "config.import.local.jsonc");
const cpPort = process.env.XIHE_CP_PORT ?? "12631";
const cpBase = `http://127.0.0.1:${cpPort}`;
const adminEmail = "admin@xihe.local";
const adminPassword = process.env.XIHE_DEV_ADMIN_PASSWORD ?? "";
const READY_TIMEOUT_MS = Number(process.env.XIHE_DEV_IMPORT_READY_TIMEOUT_MS ?? "120000");

function stripJsonc(text) {
  // 状态机：只处理字符串之外的内容——剥离 // 行注释与 /* */ 块注释、
  // 丢弃尾逗号（标准 JSONC 行为）。字符串内容（含 URL、中文标点）原样保留。
  let out = "";
  let i = 0;
  let inStr = false;
  let esc = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (esc) {
        esc = false;
      } else if (c === "\\") {
        esc = true;
      } else if (c === '"') {
        inStr = false;
      }
      i += 1;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) {
        j += 1;
      }
      if (text[j] === "}" || text[j] === "]") {
        i += 1; // 尾逗号：丢弃
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

function masked(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "(empty)";
  }
  if (value.length <= 8) {
    return "****";
  }
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

async function waitForCp() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      const response = await fetch(`${cpBase}/actuator/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // CP 尚未启动，继续等待。
    }
    if (Date.now() >= deadline) {
      throw new Error(`CP 未在 ${READY_TIMEOUT_MS}ms 内 ready`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function main() {
  if (!fs.existsSync(importPath)) {
    console.log("[dev-host:import-config] skip: config.import.local.jsonc 不存在");
    return;
  }
  if (!adminPassword) {
    console.log(
      "[dev-host:import-config] skip: 未设置 XIHE_DEV_ADMIN_PASSWORD（仅经 OS 环境变量注入）。"
      + " 如需 dev:host 自动导入，请设置后重启；或在 UI Settings 中手动配置。",
    );
    return;
  }
  console.log("[dev-host:import-config] 等待 CP ready ...");
  await waitForCp();
  console.log("[dev-host:import-config] CP ready，开始导入");

  const login = await fetch(`${cpBase}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  if (!login.ok) {
    console.error(
      "[dev-host:import-config] admin 登录失败"
      + ` (HTTP ${login.status})：存量库可能是旧随机密码种子。`
      + " 请先执行 `mise run reset-admin` 把同一密码写入库后重试（reset-admin 支持 -Password 显式指定）。",
    );
    process.exitCode = 1;
    return;
  }
  const { accessToken } = await login.json();
  if (!accessToken) {
    console.error("[dev-host:import-config] 登录响应缺少 accessToken");
    process.exitCode = 1;
    return;
  }

  let body;
  try {
    body = JSON.parse(stripJsonc(fs.readFileSync(importPath, "utf8")));
  } catch (error) {
    console.error(`[dev-host:import-config] 本地文件不是合法 JSONC：${error.message}（文件：${importPath}）`);
    process.exitCode = 1;
    return;
  }
  const imported = await fetch(`${cpBase}/api/v1/config/import`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!imported.ok) {
    console.error(
      `[dev-host:import-config] 导入失败 (HTTP ${imported.status}): ${(await imported.text()).slice(0, 500)}`,
    );
    process.exitCode = 1;
    return;
  }
  const llm = body["llm-provider"] ?? {};
  console.log("[dev-host:import-config] 导入成功：");
  console.log(`  domains          : ${Object.keys(body).join(", ")}`);
  console.log(`  defaultProvider  : ${llm.defaultProvider ?? "(unset)"}`);
  console.log(`  deepseekApiKey   : ${masked(llm.deepseekApiKey)}`);
  console.log(`  openaiApiKey     : ${masked(llm.openaiApiKey)}`);
  console.log(`  xiaomiApiKey     : ${masked(llm.xiaomiApiKey)}`);
}

main().catch((error) => {
  console.error(`[dev-host:import-config] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
