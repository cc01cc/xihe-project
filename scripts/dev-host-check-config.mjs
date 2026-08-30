#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const envDevPath = path.join(projectRoot, ".env.dev");
const configImportPath = path.join(projectRoot, "config.import.local.jsonc");

function readEnvDev() {
  if (!fs.existsSync(envDevPath)) {
    return {};
  }
  const content = fs.readFileSync(envDevPath, "utf8");
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
    const parsed = JSON.parse(stripped);
    const flat = {};
    for (const [domain, values] of Object.entries(parsed ?? {})) {
      if (values && typeof values === "object" && !Array.isArray(values)) {
        for (const [key, value] of Object.entries(values)) {
          flat[key] = value;
        }
      }
    }
    return flat;
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

const envDev = readEnvDev();
const configImport = readConfigImport();
const defaultProvider = configImport?.defaultProvider ?? envDev.XIHE_LLM_PROVIDER ?? "unknown";
const deepseekKey = configImport?.deepseekApiKey ?? envDev.XIHE_DEEPSEEK_API_KEY ?? "";
const xiaomiKey = configImport?.xiaomiApiKey ?? envDev.XIHE_MIMO_API_KEY ?? envDev.XIAOMI_API_KEY ?? "";

console.log("Config source resolution");
console.log(`  defaultProvider : ${defaultProvider}`);
console.log(`  deepseekKey     : ${resolveMasked(deepseekKey) || "(empty)"}`);
console.log(`  xiaomiKey       : ${resolveMasked(xiaomiKey) || "(empty)"}`);
console.log(`  envDevExists    : ${fs.existsSync(envDevPath)}`);
console.log(`  configImportExists : ${fs.existsSync(configImportPath)}`);
