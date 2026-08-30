import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const uiRoot = path.join(projectRoot, "packages", "ui");
const logsDir = path.join(projectRoot, "logs");
const logFile = path.join(logsDir, "ui.log");

fs.mkdirSync(logsDir, { recursive: true });
const logStream = fs.createWriteStream(logFile, { flags: "a" });
const viteEntry = path.join(uiRoot, "node_modules", "vite", "bin", "vite.js");
const child = spawn(process.execPath, [viteEntry, ...process.argv.slice(2)], {
  cwd: uiRoot,
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
  windowsHide: false,
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
