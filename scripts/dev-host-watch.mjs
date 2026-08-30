import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const logsDir = path.join(projectRoot, "logs");
const hostLogFile = path.join(logsDir, "host.log");
const pollIntervalMs = 15_000;
const startupGraceMs = 120_000;

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}
const logStream = fs.createWriteStream(hostLogFile, { flags: "a" });

const services = [
  { name: "cp", url: "http://127.0.0.1:12631/actuator/health" },
  { name: "agent", url: "http://127.0.0.1:12632/internal/v1/agent/health" },
  { name: "runtime", url: "http://127.0.0.1:12633/health" },
  { name: "ui", url: "http://127.0.0.1:12630/" },
];

let stackProcess = null;
let stackStartedAt = 0;
let restartInFlight = false;
let restartCount = 0;
let stopping = false;
const observedHealthyServices = new Set();
const previousHealth = new Map();

function lifecycle(event, fields = {}) {
  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, "_")}`)
    .join(" ");
  const line = `[LIFECYCLE] service=dev-host event=${event}${suffix ? ` ${suffix}` : ""}`;
  console.log(line);
  logStream.write(`${new Date().toISOString()} ${line}\n`);
}

async function checkService(service) {
  const startedAt = Date.now();
  try {
    const response = await fetch(service.url, {
      signal: AbortSignal.timeout(3_000),
    });
    return {
      ...service,
      healthy: response.ok,
      status: response.status,
      responseMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ...service,
      healthy: false,
      status: 0,
      responseMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function startStack() {
  const command = process.platform === "win32" ? "mise.exe" : "mise";
  const child = spawn(command, ["run", "dev:host"], {
    cwd: projectRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });

  child.stdout?.on("data", (chunk) => {
    process.stdout.write(chunk);
    logStream.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
    logStream.write(chunk);
  });

  stackProcess = child;
  stackStartedAt = Date.now();
  observedHealthyServices.clear();
  lifecycle("stack_start", { pid: child.pid ?? "unknown", restartCount });

  child.once("error", (error) => {
    lifecycle("stack_error", { error: error.message });
    if (!stopping && !restartInFlight) {
      void restartStack("spawn_error");
    }
  });

  child.once("exit", (code, signal) => {
    if (stackProcess !== child) {
      return;
    }
    lifecycle("stack_exit", { code: code ?? "null", signal: signal ?? "none" });
    if (!stopping && !restartInFlight) {
      void restartStack("stack_exit");
    }
  });
}

function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopStack() {
  const child = stackProcess;
  stackProcess = null;
  if (!child || child.exitCode !== null) {
    return;
  }

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
  } else {
    child.kill("SIGTERM");
  }
  await waitForExit(child);
}

async function restartStack(reason) {
  if (restartInFlight || stopping) {
    return;
  }
  restartInFlight = true;
  lifecycle("stack_restart_begin", { reason, restartCount: restartCount + 1 });
  await stopStack();
  const backoffMs = Math.min(2_000 * 2 ** restartCount, 30_000);
  restartCount += 1;
  await delay(backoffMs);
  if (!stopping) {
    startStack();
    lifecycle("stack_restart_complete", { reason, backoffMs });
  }
  restartInFlight = false;
}

async function pollHealth() {
  const results = await Promise.all(services.map(checkService));
  const down = [];

  for (const result of results) {
    const previous = previousHealth.get(result.name);
    if (previous !== result.healthy) {
      lifecycle("health_change", {
        service: result.name,
        from: previous === undefined ? "unknown" : previous ? "up" : "down",
        to: result.healthy ? "up" : "down",
        status: result.status,
        responseMs: result.responseMs,
      });
    }
    previousHealth.set(result.name, result.healthy);

    if (result.healthy) {
      observedHealthyServices.add(result.name);
    } else {
      down.push(result);
    }
  }

  if (down.length === 0) {
    restartCount = 0;
    return;
  }

  const withinGrace = Date.now() - stackStartedAt < startupGraceMs;
  const knownFailure = down.some((service) => observedHealthyServices.has(service.name));
  if (!withinGrace || knownFailure) {
    lifecycle("health_failure", { services: down.map((service) => service.name).join(",") });
    await restartStack("health_failure");
  }
}

function stopPostgres() {
  lifecycle("postgres_stop_begin");
  const result = spawnSync("docker", ["compose", "stop", "postgres"], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  lifecycle("postgres_stop_complete", { code: result.status ?? "null" });
}

async function shutdown(reason, exitCode = 0) {
  if (stopping) {
    return;
  }
  stopping = true;
  lifecycle("watch_stop", { reason });
  await stopStack();
  stopPostgres();
  process.exit(exitCode);
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

startStack();
lifecycle("watch_start", { pollIntervalMs, startupGraceMs });

while (!stopping) {
  await delay(pollIntervalMs);
  if (!stopping) {
    await pollHealth();
  }
}
