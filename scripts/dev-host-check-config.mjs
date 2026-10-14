#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
// PLAN-0307 T3.3: read the full committed chain (.env → .env.dev → .env.local);
// real keys now live in the gitignored .env.local instead of .env.dev.
const envChainPaths = [".env", ".env.dev", ".env.local"].map((name) => path.join(projectRoot, name));
const configImportPath = path.join(projectRoot, "config.import.local.jsonc");

function readEnvChain() {
  const merged = {};
  for (const envPath of envChainPaths) {
    if (!fs.existsSync(envPath)) {
      continue;
    }
    Object.assign(merged, parseEnvFile(envPath));
  }
  return merged;
}

function parseEnvFile(envPath) {
  const content = fs.readFileSync(envPath, "utf8");
  const result = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function readConfigImport() {
  if (!fs.existsSync(configImportPath)) {
    return null;
  }
  const raw = fs.readFileSync(configImportPath, "utf8");
  const stripped = raw.replace(/^[\s]*\/\/.*$/gm, "");
  try {
    return JSON.parse(stripped);
  } catch {
    return { __parseError: true, raw };
  }
}

function resolveMasked(value) {
  if (typeof value !== "string") {
    return value;
  }
  if (value.length <= 8) {
    return value;
  }
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function parseProfileValue(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "object") {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const env = readEnvChain();
const configImport = readConfigImport();
// PLAN-0504: the llm-provider default identity is the whole `profile` unit
// (providerId/connectionKey/model); legacy defaultProvider/*Model/*ApiBase keys
// are retired and would be rejected by the CP schema on import.
const llmProvider = configImport?.["llm-provider"] ?? {};
const profile = parseProfileValue(llmProvider.profile);
const profileLabel = profile
  ? `${profile.providerId ?? "?"}/${profile.connectionKey ?? "?"}/${profile.model ?? "?"}`
  : "(unset)";
const deepseekKey = env.XIHE_DEEPSEEK_API_KEY ?? "";
const xiaomiKey = env.XIHE_XIAOMI_API_KEY ?? "";

console.log("Config source resolution");
console.log(`  defaultProfile  : ${profileLabel}`);
console.log(`  envProvider     : ${env.XIHE_LLM_PROVIDER ?? "(unset)"}（env 兜底/离线路径）`);
console.log(`  deepseekKey     : ${resolveMasked(deepseekKey) || "(empty)"}`);
console.log(`  xiaomiKey       : ${resolveMasked(xiaomiKey) || "(empty)"}`);
console.log(`  envChain        : ${envChainPaths.filter((p) => fs.existsSync(p)).map((p) => path.basename(p)).join(" + ") || "(none)"}`);
console.log(`  configImportExists : ${fs.existsSync(configImportPath)}`);
