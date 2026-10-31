#!/usr/bin/env node
/**
 * PLAN-0612 M2：跨平台 POSIX shell 启动器（替代历史 mise 任务里硬编码的 Git Bash 绝对路径）。
 *
 * 为什么不是直接写 `bash`：Windows 上 PATH 里的 `bash` 很可能是 **WSL** 的启动器
 * （`C:\WINDOWS\system32\bash.exe`），它拿到 Windows 相对路径会把 cwd 变成
 * `/mnt/h/.../H:/...`，导致 `git` 直接报 "not a git repository"。仓库里的 `.sh`
 * 脚本（`scripts/mise/*.sh`、`scripts/check-doc-links-entry.sh`）是 **Git Bash/MSYS**
 * 语义，必须用 Git Bash 跑。
 *
 * 解析顺序（不写死任何机器路径）：
 * 1. `git --exec-path` → `<Git>/mingw64/libexec/git-core` → `<Git>/bin/bash.exe`；
 * 2. PATH 上的 `bash`（仅当 `uname -s` 表明是 MINGW/MSYS/CYGWIN）；
 * 3. 非 Windows：`bash` / `sh`。
 * 都不可用时打印明确错误并以退出码 2 结束（不静默降级到 WSL bash）。
 *
 * 用法：node scripts/mise/run-posix.mjs <script.sh> [args...]
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: node scripts/mise/run-posix.mjs <script.sh> [args...]");
  process.exit(2);
}

const isWindows = process.platform === "win32";

function isMsysShell(shell) {
  if (!shell) return false;
  const probe = spawnSync(shell, ["-c", "uname -s"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (probe.status !== 0 || !probe.stdout) return false;
  return /(MINGW|MSYS|CYGWIN)/i.test(probe.stdout);
}

function gitBashCandidate() {
  const probe = spawnSync("git", ["--exec-path"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  if (probe.status !== 0 || !probe.stdout) return null;
  const execPath = probe.stdout.trim();
  if (!execPath) return null;
  // <Git>/mingw64/libexec/git-core -> <Git>/bin/bash.exe
  const candidate = resolve(execPath, "..", "..", "..", "bin", "bash.exe");
  return existsSync(candidate) ? candidate : null;
}

function pickShell() {
  if (isWindows) {
    const candidate = gitBashCandidate();
    if (candidate && isMsysShell(candidate)) return candidate;
    if (isMsysShell("bash")) return "bash";
    return null;
  }
  for (const shell of ["bash", "sh"]) {
    const probe = spawnSync(shell, ["-c", "exit 0"], { timeout: 10_000 });
    if (probe.status === 0) return shell;
  }
  return null;
}

const shell = pickShell();
if (!shell) {
  console.error(
    "[run-posix] ERROR: no POSIX shell found. On Windows install Git for Windows (Git Bash) " +
      "and make sure `git --exec-path` works; `bash` on PATH may be WSL and is not accepted.",
  );
  process.exit(2);
}

const child = spawn(shell, args, { stdio: "inherit", windowsHide: true, cwd: process.cwd() });
child.once("error", (error) => {
  console.error(`[run-posix] ERROR: failed to launch ${shell}: ${error.message}`);
  process.exit(2);
});
child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`[run-posix] ${shell} terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
