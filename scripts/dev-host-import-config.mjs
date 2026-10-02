#!/usr/bin/env node
// Internal helper for the explicit `xihe config import` command.
// It is not part of the default `dev:host` startup chain.
// Credentials are passed through environment variables only and never printed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const importPath = path.resolve(
  projectRoot,
  process.env.XIHE_DEV_IMPORT_CONFIG_PATH ?? process.argv[2] ?? "config.import.local.jsonc",
);
const cpPort = process.env.XIHE_CP_PORT ?? "12631";
const cpBase = `http://127.0.0.1:${cpPort}`;
const adminEmail = process.env.XIHE_DEV_ADMIN_EMAIL ?? "admin@xihe.local";
const adminPassword = process.env.XIHE_DEV_ADMIN_PASSWORD ?? "";

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

async function assertCpReady() {
  const response = await fetch(`${cpBase}/actuator/health`, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`CP health check failed (HTTP ${response.status})`);
}

async function main() {
  if (!fs.existsSync(importPath)) {
    console.log("[dev-host:import-config] skip: config.import.local.jsonc 不存在");
    return;
  }
  if (!adminPassword) {
    console.log(
      "[dev-host:import-config] skip: 未设置 XIHE_DEV_ADMIN_PASSWORD（仅经 OS 环境变量注入）。"
      + " 显式导入请设置后运行 `mise run dev:host:import-config`，或使用 UI Settings。",
    );
    return;
  }
  console.log("[dev-host:import-config] 检查 CP ready ...");
  await assertCpReady();
  console.log("[dev-host:import-config] CP ready，开始导入");

  const login = await fetch(`${cpBase}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    signal: AbortSignal.timeout(10_000),
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
  } catch {
    console.error(`[dev-host:import-config] 本地文件不是合法 JSONC（文件：${importPath}）`);
    process.exitCode = 1;
    return;
  }
  let imported;
  try {
    imported = await fetch(`${cpBase}/api/v1/config/import`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    console.error("[dev-host:import-config] OPERATION_OUTCOME_UNKNOWN: request may have reached CP; inspect config before retrying");
    process.exitCode = 70;
    return;
  }
  if (!imported.ok) {
    if (imported.status >= 500) {
      console.error("[dev-host:import-config] OPERATION_OUTCOME_UNKNOWN: CP returned a server error; inspect config before retrying");
      process.exitCode = 70;
      return;
    }
    const problem = await imported.json().catch(() => null);
    const code = typeof problem?.code === "string" && /^[A-Z0-9_]{1,80}$/.test(problem.code)
      ? problem.code
      : "CONFIG_IMPORT_FAILED";
    console.error(`[dev-host:import-config] 导入失败 (HTTP ${imported.status}, code=${code})`);
    process.exitCode = 1;
    return;
  }
  let result;
  try {
    result = await imported.json();
  } catch {
    console.error("[dev-host:import-config] OPERATION_OUTCOME_UNKNOWN: response could not be read; inspect config before retrying");
    process.exitCode = 70;
    return;
  }
  const llm = body["llm-provider"] ?? {};
  console.log("[dev-host:import-config] 导入成功：");
  console.log(`  imported         : ${(result.imported ?? []).length}`);
  console.log(`  domains          : ${Object.keys(body).join(", ")}`);
  console.log(`  defaultProvider  : ${llm.defaultProvider ?? "(unset)"}`);
  console.log(`  deepseekApiKey   : ${llm.deepseekApiKey ? "present" : "absent"}`);
  console.log(`  openaiApiKey     : ${llm.openaiApiKey ? "present" : "absent"}`);
  console.log(`  xiaomiApiKey     : ${llm.xiaomiApiKey ? "present" : "absent"}`);
}

main().catch((error) => {
  console.error(`[dev-host:import-config] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
