#!/usr/bin/env node
/**
 * XH host 服务启动器（PLAN-0533 方案 A）。
 *
 * 职责：读 XIHE_STACK_ID（或 --stack N）→ 调 workspace SSOT 的 deriveStack()
 * → 只补缺省 env（不覆盖已存在的 env）→ 以派生后的环境启动原命令。
 *
 * 用法：
 *   node scripts/stack-run.mjs <pg|cp|agent|runtime|ui|watch|dev-host>
 *   node scripts/stack-run.mjs env-json [--stack N]   给 PowerShell 脚本用的派生值 JSON
 *   node scripts/stack-run.mjs slots-json            全部已登记栈槽位（给 preflight）
 *
 * 契约：本文件不定义端口，全部来自 `<one>/scripts/ports.mjs` 的 deriveStack()。
 * 它必须能同时在主 checkout 与 .worktrees/<name> 下工作，因此 one 根目录按
 * 「向上找到 config/ports.mjs」解析，而不是写死相对层级。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");

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

const oneRoot = findOneRoot(projectRoot);
if (!oneRoot) {
  console.error("[stack] ERROR: cannot locate the one workspace root (config/ports.mjs not found above " + projectRoot + ")");
  process.exit(2);
}

const { DEFAULT_STACK_ID, STACK_IDS, deriveStack, normalizeStackArg, stackEnvDefaults } = await import(
  pathToFileURL(join(oneRoot, "scripts", "ports.mjs")).href
);

function readStackArg(args) {
  const inline = args.find((arg) => arg.startsWith("--stack="));
  if (inline) return inline.slice("--stack=".length);
  const index = args.indexOf("--stack");
  if (index >= 0) return args[index + 1];
  return undefined;
}

function resolveStack(args) {
  const raw = readStackArg(args) ?? process.env.XIHE_STACK_ID ?? DEFAULT_STACK_ID;
  return deriveStack(normalizeStackArg(raw));
}

function quoteArg(value) {
  const text = String(value);
  return /[\s"]/u.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function launch({ command, args, cwd, env }) {
  const isWindows = process.platform === "win32";
  const direct = command === process.execPath || /\.exe$/i.test(command);
  const child = isWindows && !direct
    ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", [command, ...args].map(quoteArg).join(" ")], {
        cwd,
        env,
        stdio: "inherit",
        windowsHide: false,
      })
    : spawn(command, args, { cwd, env, stdio: "inherit", windowsHide: false });

  child.once("error", (error) => {
    console.error(`[stack] ERROR: failed to launch ${command}: ${error.message}`);
    process.exit(1);
  });
  child.once("exit", (code, signal) => {
    if (signal) {
      console.error(`[stack] ${command} terminated by ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 0);
  });
}

function describeTarget(target, derived) {
  const ports = derived.ports;
  console.error(
    `[stack] ${derived.stackId} target=${target} ui=${ports.ui} cp=${ports.cp} agent=${ports.agent} runtime=${ports.runtime} pg=${ports.postgres}`
    + ` compose=${derived.composeProject} db=${derived.database} log=${derived.logDir}`,
  );
}

const targets = {
  pg: () => ({ command: "docker", args: ["compose", "up", "-d", "--wait", "postgres"], cwd: projectRoot }),
  cp: () => ({ command: "mvn", args: ["spring-boot:run"], cwd: join(projectRoot, "packages", "control-plane") }),
  agent: () => ({ command: "uv", args: ["run", "python", "-m", "xihe_agent.main"], cwd: join(projectRoot, "packages", "agent") }),
  runtime: () => ({ command: "cargo", args: ["run", "--bin", "xihe-runtime"], cwd: join(projectRoot, "packages", "runtime") }),
  ui: () => ({
    command: process.execPath,
    args: [join(projectRoot, "scripts", "dev-ui-host.mjs"), "--mode", "dev", "--host", "127.0.0.1", "--strictPort"],
    cwd: join(projectRoot, "packages", "ui"),
  }),
  watch: () => ({ command: process.execPath, args: [join(projectRoot, "scripts", "dev-host-watch.mjs")], cwd: projectRoot }),
  "dev-host": () => ({ command: "mise", args: ["run", "dev:host"], cwd: projectRoot }),
};

const [target, ...rest] = process.argv.slice(2);

if (!target || target === "--help" || target === "-h") {
  console.log("usage: stack-run.mjs <pg|cp|agent|runtime|ui|watch|dev-host> [--stack N]");
  console.log("       stack-run.mjs env-json [--stack N]");
  console.log("       stack-run.mjs slots-json");
  process.exit(target ? 0 : 2);
}

let derived;
try {
  derived = resolveStack(rest);
} catch (error) {
  console.error(`[stack] ERROR: ${error.message}`);
  process.exit(2);
}

if (target === "env-json") {
  process.stdout.write(`${JSON.stringify(derived, null, 2)}\n`);
  process.exit(0);
}

if (target === "slots-json") {
  process.stdout.write(`${JSON.stringify(STACK_IDS.map((id) => deriveStack(id)), null, 2)}\n`);
  process.exit(0);
}

const factory = targets[target];
if (!factory) {
  console.error(`[stack] ERROR: unknown target ${JSON.stringify(target)}; expected ${Object.keys(targets).join(", ")}`);
  process.exit(2);
}

const env = { ...process.env, ...stackEnvDefaults(derived, process.env) };

// The agent's httpx builds URLPatterns from NO_PROXY; a bracketed IPv6 entry such
// as `[::1]` is parsed as a URL and aborts startup (`Invalid port: ':1]'`).
// Drop only those malformed entries; keep the rest of the bypass list and the
// outbound proxies.
if (target === "agent") {
  for (const key of ["NO_PROXY", "no_proxy"]) {
    if (typeof env[key] === "string" && /[[\]]/.test(env[key])) {
      env[key] = env[key]
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry && !/[[\]]/.test(entry))
        .join(",");
    }
  }
}

describeTarget(target, derived);

// T3.3: PostgreSQL must belong to this stack's compose project and listen on the
// derived port. A stale container from another project on the same port would
// otherwise silently serve the wrong database.
if (target === "pg") {
  const up = spawnSync("docker", ["compose", "up", "-d", "--wait", "postgres"], {
    cwd: projectRoot,
    env,
    stdio: "inherit",
  });
  if (up.status !== 0) {
    console.error(`[stack] ERROR: docker compose up postgres failed (exit ${up.status ?? "null"})`);
    process.exit(up.status ?? 1);
  }
  const container = spawnSync("docker", ["compose", "ps", "-q", "postgres"], { cwd: projectRoot, env, encoding: "utf8" });
  const id = (container.stdout ?? "").trim().split(/\r?\n/)[0];
  if (!id) {
    console.error(`[stack] ERROR: ${derived.stackId} postgres container not found after compose up`);
    process.exit(2);
  }
  const owner = spawnSync(
    "docker",
    ["inspect", "--format", '{{index .Config.Labels "com.docker.compose.project"}}', id],
    { encoding: "utf8" },
  ).stdout.trim();
  const published = spawnSync("docker", ["port", id, "5432/tcp"], { encoding: "utf8" }).stdout;
  const portMatches = published
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line.endsWith(`:${derived.ports.postgres}`));
  if (owner !== derived.composeProject || !portMatches) {
    console.error(
      `[stack] ERROR: postgres ownership mismatch for ${derived.stackId}: container=${id} project=${owner || "(none)"} expected=${derived.composeProject}`
      + ` port=${derived.ports.postgres} published=${published.trim().replace(/\s+/g, " ") || "(none)"}`,
    );
    process.exit(2);
  }
  // Every stack owns `xihe_<n>`, including stack-1 (2026-10-20 user ruling).
  // A fresh volume only creates the container's default DB, so create the
  // stack DB on first use.
  const exists = spawnSync(
    "docker",
    ["exec", id, "psql", "-U", "xihe", "-d", "postgres", "-tAc", `SELECT 1 FROM pg_database WHERE datname='${derived.database}'`],
    { encoding: "utf8" },
  );
  if (exists.status !== 0) {
    console.error(`[stack] ERROR: cannot inspect databases in ${id}: ${(exists.stderr ?? "").trim()}`);
    process.exit(2);
  }
  if (!(exists.stdout ?? "").trim()) {
    const created = spawnSync("docker", ["exec", id, "createdb", "-U", "xihe", derived.database], { encoding: "utf8" });
    if (created.status !== 0) {
      console.error(`[stack] ERROR: createdb ${derived.database} failed: ${(created.stderr ?? "").trim()}`);
      process.exit(2);
    }
    console.log(`[stack] created database ${derived.database} in ${derived.stackId}`);
  }

  console.log(`[stack] postgres OK: ${derived.stackId} project=${derived.composeProject} port=${derived.ports.postgres} db=${derived.database}`);
  process.exit(0);
}

launch({ ...factory(), env });
