import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const uiRoot = path.join(projectRoot, "packages", "ui");
// PLAN-0533: log dir and port come from the derived stack env; defaults keep stack-1 unchanged.
const logsDir = path.resolve(projectRoot, process.env.XIHE_LOG_DIR || "logs");
const logFile = path.join(logsDir, "ui.log");

fs.mkdirSync(logsDir, { recursive: true });
const logStream = fs.createWriteStream(logFile, { flags: "a" });
const viteEntry = path.join(uiRoot, "node_modules", "vite", "bin", "vite.js");
const forwarded = process.argv.slice(2);
const explicitPort = forwarded.some((arg) => arg === "--port" || arg.startsWith("--port="));
if (!explicitPort) {
  forwarded.push("--port", process.env.XIHE_UI_PORT || "12630");
}
const child = spawn(process.execPath, [viteEntry, ...forwarded], {
  cwd: uiRoot,
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
  // Windows: a console child of a console-less parent (agent runner, detached
  // E2E) otherwise pops a new terminal window. Interactive dev can opt back in
  // with XIHE_DEV_SHOW_CONSOLE=1.
  windowsHide: process.env.XIHE_DEV_SHOW_CONSOLE !== "1",
});

function write(chunk, target) {
  target.write(chunk);
  logStream.write(chunk);
}

child.stdout?.on("data", (chunk) => write(chunk, process.stdout));
child.stderr?.on("data", (chunk) => write(chunk, process.stderr));

let stopping = false;
function stop(signal) {
  if (stopping || child.exitCode !== null) return;
  stopping = true;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
  } else {
    child.kill(signal);
  }
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

child.once("error", (error) => {
  write(`${error.stack ?? error.message}\n`, process.stderr);
});
child.once("exit", (code, signal) => {
  logStream.end();
  process.exit(code ?? (signal ? 1 : 0));
});
