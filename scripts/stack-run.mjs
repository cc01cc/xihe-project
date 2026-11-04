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
 * 契约：本文件不定义端口，全部来自仓库内 `scripts/lib/stack-ports.mjs` 的
 * deriveStack()（PLAN-0612：端口事实源归 A03，不再向上查找 one 工作区）。
 */
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHostRoot } from "./host-root.mjs";
import {
  buildInfoPath,
  cpTargetDir,
  evaluateCpFreshness,
  gitHead,
  shortSha,
  writeBuildInfo,
} from "./lib/cp-build-info.mjs";
import { cpBuildRoot, resolveCpTargetDir, writePointer } from "./lib/cp-build-dir.mjs";
import { applySetToEnv, applyUrlSyncToEnv, parseStackSetArgs } from "./lib/stack-set.mjs";
import { cargoTargetForStack } from "./lib/stack-cargo-target.mjs";
import { recordedServiceAlive, sweepOrphanProcesses } from "./lib/stack-orphan.mjs";
import { DEFAULT_STACK_ID, STACK_IDS, deriveStack, normalizeStackArg, stackEnvDefaults } from "./lib/stack-ports.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");

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

function resolveStackHostRoot(derived, env = process.env) {
  const source = env.XIHE_WORKSPACE_HOST_ROOT ?? derived.hostRoot;
  const resolved = resolveHostRoot(projectRoot, source);
  if (!resolved.value) {
    console.error(
      `[stack] ERROR: XIHE_WORKSPACE_HOST_ROOT resolved empty (source=${JSON.stringify(source)}, stack=${derived.stackId})`,
    );
    process.exit(2);
  }
  if (resolved.wasRelative) {
    console.error(
      `[stack] host root: ${JSON.stringify(source)} -> ${resolved.value} (resolved against ${projectRoot})`,
    );
  }
  return resolved.value;
}

function quoteArg(value) {
  const text = String(value);
  return /[\s"]/u.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function launch({ command, args, cwd, env }) {
  const isWindows = process.platform === "win32";
  const direct = command === process.execPath || /\.exe$/i.test(command);
  // Windows: a console child of a console-less parent (agent runner, detached
  // E2E, CI) otherwise pops a new terminal window for every service. Interactive
  // dev can opt back in with XIHE_DEV_SHOW_CONSOLE=1.
  const hideWindow = process.env.XIHE_DEV_SHOW_CONSOLE !== "1";
  const child = isWindows && !direct
    ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", [command, ...args].map(quoteArg).join(" ")], {
        cwd,
        env,
        stdio: "inherit",
        windowsHide: hideWindow,
      })
    : spawn(command, args, { cwd, env, stdio: "inherit", windowsHide: hideWindow });

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

/** Same launcher shape as `launch()`, but blocking — used by the CP freshness rebuild. */
function runToolSync(command, args, options) {
  const isWindows = process.platform === "win32";
  const direct = command === process.execPath || /\.exe$/i.test(command);
  return isWindows && !direct
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", [command, ...args].map(quoteArg).join(" ")], options)
    : spawnSync(command, args, options);
}

function describeBuildVerdict(verdict, head) {
  return (
    `file=${verdict.file} commit=${shortSha(verdict.fileCommit) || "(none)"}`
    + ` built=${verdict.builtAt || "(none)"} dirty=${verdict.dirty === null ? "?" : verdict.dirty}`
    + ` head=${shortSha(head.commit) || "(unknown)"} verdict=${verdict.status}`
  );
}

function describeTarget(target, derived, hostRoot) {
  const ports = derived.ports;
  console.error(
    `[stack] ${derived.stackId} target=${target} ui=${ports.ui} cp=${ports.cp} agent=${ports.agent} runtime=${ports.runtime} pg=${ports.postgres}`
    + ` compose=${derived.composeProject} db=${derived.database} log=${derived.logDir} hostRoot=${hostRoot}`,
  );
}

const targets = {
  pg: () => ({ command: "docker", args: ["compose", "up", "-d", "--wait", "postgres"], cwd: projectRoot }),
  cp: (effectiveEnv) => ({
    command: "mvn",
    // -Dxihe.target.dir：把 CP 的构建输出（target/）放到快卷上。
    // 背景：H: 是 ReFS，每文件写 56-170ms，CP 冷编译在 H: 上要 ~8 分钟；C: 上 ~15s。
    // BL-253 L3：值来自本脚本的派生（每栈每 commit 一个目录），显式 env 仍最优先。
    args: [
      "spring-boot:run",
      ...(effectiveEnv.XIHE_CP_TARGET_DIR
        ? ["-Dxihe.target.dir=" + effectiveEnv.XIHE_CP_TARGET_DIR]
        : []),
    ],
    cwd: join(projectRoot, "packages", "control-plane"),
  }),
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
  console.log("usage: stack-run.mjs <pg|cp|agent|runtime|ui|watch|dev-host> [--stack N] [--set KEY=VALUE ...]");
  console.log("       stack-run.mjs cp [--no-rebuild] [--stack N]");
  console.log("       stack-run.mjs env-json [--stack N]");
  console.log("       stack-run.mjs slots-json");
  console.log("       --set accepts only XIHE_CP_PORT / XIHE_AGENT_PORT / XIHE_RUNTIME_PORT (1..65535),");
  console.log("       injected into the subprocess env of the target that consumes the key.");
  console.log("       cp gate (PLAN-0662): compares classes/META-INF/build-info.properties `commit` with");
  console.log("       git HEAD; stale/missing ⇒ rebuild from HEAD. --no-rebuild keeps the old classes (WARN).");
  process.exit(target ? 0 : 2);
}

let derived;
try {
  derived = resolveStack(rest);
} catch (error) {
  console.error(`[stack] ERROR: ${error.message}`);
  process.exit(2);
}

// PLAN-0574 M4: `--set KEY=VALUE` bootstrap overrides. The base env (OS env +
// derived stack defaults) is assembled first so the parser can tell launcher
// derived connection URLs (re-pointed to the new port) from user-provided ones
// (kept, with a warning). Every check runs before anything is launched; an
// unsupported key/value/target combination exits without starting a process,
// and error messages never echo the provided value.
const baseEnv = { ...process.env, ...stackEnvDefaults(derived, process.env) };
// PLAN-0656 R1: every non-default stack gets its own cargo target so its
// `cargo run --bin xihe-runtime` never overwrites the binary another stack is
// executing (BL-221: `os error 5` on the shared target-dir). CARGO_TARGET_DIR
// outranks `.cargo/config.toml`; the default stack and any pre-set override keep
// their current behavior unchanged.
const cargoTargetDir = cargoTargetForStack({ stackId: derived.stackId, projectRoot, env: baseEnv });
if (cargoTargetDir) baseEnv.CARGO_TARGET_DIR = cargoTargetDir;
const hostRootResolved = resolveStackHostRoot(derived, baseEnv);
baseEnv.XIHE_WORKSPACE_HOST_ROOT = hostRootResolved;

let setValues = {};
let setWarnings = [];
let setUrlSyncs = [];
try {
  ({ values: setValues, warnings: setWarnings, urlSyncs: setUrlSyncs } = parseStackSetArgs({
    args: rest,
    target,
    env: baseEnv,
    userEnv: process.env,
  }));
} catch (error) {
  console.error(`[stack] ERROR: ${error.message}`);
  process.exit(2);
}

if (target === "env-json") {
  const hostRootResolved = resolveStackHostRoot(derived);
  const env = {
    ...stackEnvDefaults(derived, process.env),
    XIHE_WORKSPACE_HOST_ROOT: hostRootResolved,
    ...(cargoTargetDir ? { CARGO_TARGET_DIR: cargoTargetDir } : {}),
  };
  process.stdout.write(`${JSON.stringify({ ...derived, env, hostRootResolved, cargoTargetDir: cargoTargetDir ?? null }, null, 2)}\n`);
  process.exit(0);
}

if (target === "slots-json") {
  process.stdout.write(`${JSON.stringify(STACK_IDS.map((id) => {
    const stack = deriveStack(id);
    return { ...stack, hostRootResolved: resolveStackHostRoot(stack, {}) };
  }), null, 2)}\n`);
  process.exit(0);
}

const factory = targets[target];
if (!factory) {
  console.error(`[stack] ERROR: unknown target ${JSON.stringify(target)}; expected ${Object.keys(targets).join(", ")}`);
  process.exit(2);
}

const env = baseEnv;

// CLI --set wins over the OS env and the derived stack defaults (priority:
// CLI --set > OS env > .env chain > defaults). The value travels as the
// subprocess's own environment variable, so every consumer (Spring placeholder
// or pure getenv, Agent import-time constant, Rust env::var) sees it. Derived
// connection URLs are re-pointed to the new port so the consuming side follows;
// user-provided URLs are kept and reported via warnings.
if (Object.keys(setValues).length > 0) {
  applySetToEnv(env, setValues);
  console.error(`[stack] --set injected into ${target}: ${Object.keys(setValues).map((key) => `${key}=***`).join(", ")}`);
}
if (setUrlSyncs.length > 0) {
  applyUrlSyncToEnv(env, setUrlSyncs);
  console.error(`[stack] --set re-pointed derived URLs for ${target}: ${setUrlSyncs.map((sync) => sync.key).join(", ")}`);
}
for (const warning of setWarnings) {
  console.error(`[stack] WARNING: ${warning}`);
}

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

describeTarget(target, derived, hostRootResolved);

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

function isPortListening(port, timeoutMs = 500) {
  return new Promise((done) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      done(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

// PLAN-0656 R5: `mise run dev:host` (and any direct `stack-run <service>`) launches
// services through THIS script, not through dev-stack — the R3 sweep in dev-stack never
// ran on this path, and a leftover runtime from a crashed stop blocked the port (0648
// lane, second incident). Guard every service launch the same way: if our port is busy,
// a healthy dev-stack-managed service is reported and left alone; anything else that
// matches this stack's service profile is an orphan and is swept.
const GUARDED_TARGETS = ["cp", "runtime", "agent", "ui"];
if (GUARDED_TARGETS.includes(target) && process.platform === "win32") {
  const envPort = Number(env[`XIHE_${target.toUpperCase()}_PORT`]);
  const port = Number.isInteger(envPort) && envPort > 0 ? envPort : derived.ports[target];
  if (await isPortListening(port)) {
    if (recordedServiceAlive(projectRoot, derived, target)) {
      console.error(
        `[stack] ${derived.stackId} ${target} port ${port} is already running under dev-stack; ` +
          "not killing a healthy service — use `mise run dev:stack -- status` / stop it first, or start it via dev:stack",
      );
      process.exit(2);
    }
    sweepOrphanProcesses({ derived, reason: `stack-run ${target}`, services: [target], quietWhenIdle: true });
    let freed = !(await isPortListening(port));
    const sweepDeadline = Date.now() + 3000;
    while (!freed && Date.now() < sweepDeadline) {
      await new Promise((done) => setTimeout(done, 250));
      freed = !(await isPortListening(port));
    }
    if (!freed) {
      console.error(`[stack] ${derived.stackId} ${target} port ${port} is still busy after the orphan sweep; see the WARN lines above`);
      process.exit(2);
    }
    console.error(`[stack] ${derived.stackId} ${target} port ${port} freed by the orphan sweep; continuing`);
  }
}

// PLAN-0662 L2: **the** dev-stack build freshness gate, and the only one.
//
// `mise run dev:host:start:cp`, `mise run dev:host` and the detached `dev:stack` supervisor all
// end up here (`dev-stack.mjs` spawns `stack-run.mjs cp`), so the decision lives in exactly one
// place. Before Maven boots the service we compare the stamp the previous build left in
// `classes/META-INF/build-info.properties` with `git rev-parse HEAD`:
//
//   fresh   → boot as-is (hot restart stays fast; BL-240 came from *pretending* an old tree was
//             current, not from restarting)
//   stale   → default **rebuild** from HEAD, so "restart" always means "latest"
//   missing → same as stale: a tree nobody stamped cannot be proven current
//   HEAD unknown (no git) → WARN and boot; rebuilding forever would not fix it
//
// `--no-rebuild` downgrades stale/missing to a WARN and continues — the escape hatch for
// "I know the tree is old and I need this stack up now", which must stay visible in the log.
if (target === "cp") {
  const cpDir = join(projectRoot, "packages", "control-plane"),
    head = gitHead({ cwd: projectRoot }),
    noRebuild = rest.includes("--no-rebuild");
  // BL-253 L3: derive this stack's own build dir **before** Maven runs, so two stacks never
  // compile into one directory again. Priority: explicit XIHE_CP_TARGET_DIR (rollback channel,
  // untouched) → `<root>/<stackId>/<sha12>[-dirty]`. Setting it on the effective env here is what
  // also fixes the old `dev-stack` gap: detached stacks spawn this script, so they get the same
  // derivation as `mise run dev:host:start:cp` — no second implementation, no in-checkout target/.
  const layout = resolveCpTargetDir({
    stackId: derived.stackId,
    env,
    commit: head.commit,
    dirty: head.dirty,
  });
  if (layout.source === "derived") {
    env.XIHE_CP_TARGET_DIR = layout.targetDir;
  }
  const targetDir = cpTargetDir({ projectRoot, env });
  console.error(
    `[stack] cp build dir (BL-253 L3): ${targetDir} source=${layout.source}`
    + ` stack=${derived.stackId} commit=${shortSha(head.commit) || "(unknown)"} dirty=${head.dirty}`,
  );
  if (layout.source === "unresolved") {
    console.error(
      `[stack] WARNING: ${layout.reason}; falling back to the in-checkout target/ (no isolation)`,
    );
  }
  let verdict = evaluateCpFreshness({ targetDir, headCommit: head.commit });
  console.error(`[stack] cp build-info: ${describeBuildVerdict(verdict, head)}`);
  if (verdict.status === "stale" || verdict.status === "missing") {
    if (noRebuild) {
      console.error(
        `[stack] WARNING: cp classes are not from HEAD (${verdict.reason}); --no-rebuild keeps them —`
        + " this CP may serve code that develop already fixed",
      );
    } else {
      console.error(
        `[stack] cp classes are not from HEAD (${verdict.reason}); rebuilding from HEAD`
        + " (mvn -q -DskipTests clean compile) — pass --no-rebuild to skip this",
      );
      const rebuild = runToolSync(
        "mvn",
        [
          "-q",
          "-DskipTests",
          "clean",
          "compile",
          ...(env.XIHE_CP_TARGET_DIR ? [`-Dxihe.target.dir=${env.XIHE_CP_TARGET_DIR}`] : []),
        ],
        { cwd: cpDir, env, stdio: "inherit" },
      );
      if (rebuild.status !== 0) {
        console.error(
          `[stack] ERROR: cp rebuild failed (exit ${rebuild.status ?? "null"}); refusing to boot a stale CP`,
        );
        process.exit(rebuild.status ?? 1);
      }
      // Stamp only after a successful compile: a failed build keeps the previous stamp, so the
      // next start sees stale classes instead of a false "fresh".
      if (head.commit) {
        writeBuildInfo({ targetDir, commit: head.commit, dirty: head.dirty });
        console.error(`[stack] cp rebuild OK; stamped ${buildInfoPath(targetDir)}`);
      }
      verdict = evaluateCpFreshness({ targetDir, headCommit: head.commit });
      console.error(`[stack] cp build-info after rebuild: ${describeBuildVerdict(verdict, head)}`);
    }
  } else if (verdict.status === "unverified") {
    console.error(`[stack] WARNING: cp freshness unverified (${verdict.reason}); booting as-is`);
  }
  // PLAN-0662 L1: one line in the stack log naming the build about to serve traffic.
  console.error(
    `[stack] cp.build commit=${shortSha(verdict.fileCommit) || "(none)"}`
    + ` built=${verdict.builtAt || "(none)"}`
    + ` dirty=${verdict.dirty === null ? "?" : verdict.dirty}`,
  );
  // BL-253 L3: record which dir this start uses. This is a **launcher-written fact about the last
  // start** (status + external-E2E assertion read it) — not an introspection of the running JVM.
  try {
    writePointer({
      root: layout.root ?? cpBuildRoot({ env }),
      stackId: derived.stackId,
      pointer: {
        targetDir,
        commit: verdict.fileCommit ?? head.commit ?? null,
        dirty: verdict.dirty ?? head.dirty ?? null,
        verdict: verdict.status,
        builtAt: verdict.builtAt ?? null,
        startedAt: new Date().toISOString(),
        source: layout.source,
      },
    });
  } catch (error) {
    console.error(`[stack] WARNING: could not write the cp build pointer: ${error.message}`);
  }
}

launch({ ...factory(env), env });
