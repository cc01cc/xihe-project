// PLAN-0648（Lead 2026-11-04 批准，根治"陈旧 state PID 复用误杀"）：
// `e2e-host --teardown` 此前按 state.pids **盲杀**（taskkill /T /F，不验身份）——
// state 过期后 PID 被系统复用给别的栈/别的 lane 的进程，teardown 就会越界杀人
// （2026-11-04 两次事故：stack-1 四服务与另一条 e2e 栈同签名死亡）。
//
// 本模块给 teardown 加**身份门**：杀之前先证明这个 pid 属于"本 worktree 的 e2e 栈"，
// 证明不了就拒绝（leak 比误杀安全——下次 preflight 的端口扫描会把残留报出来）。
//
// 三个正交身份信号，任一命中即 owned：
//   ① 命令行/可执行路径包含 projectDir —— runtime exe、CP jar、UI vite、fake-* fixture
//      的 argv 都带 worktree 路径；
//   ② 命令行包含 runId（连字符剥除后比对）—— `docker compose -p xihe-e2e-host-<runId>`
//      的 project 名会把 runId 的 `-` 全去掉（host-1793-x-a036 → host1793x a036），
//      所以两种形态都要比；
//   ③ 该 pid 正监听 state.ports 里的端口 —— agent 的 argv 只有 `-m xihe_agent.main`
//      不带任何路径，只能靠端口认领（端口段本身限定 27000-29999 的 e2e 块）。

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const IS_WINDOWS = process.platform === "win32";

/** e2e 端口块（与 e2e-preflight.mjs 的 27000-29999 口径一致）。 */
export const E2E_PORT_MIN = 27000;
export const E2E_PORT_MAX = 29999;

/** Windows 路径归一（反斜杠 + 小写）用于包含比较。 */
export function normalizeForMatch(value) {
    return String(value ?? "")
        .replaceAll("/", "\\")
        .toLowerCase();
}

/**
 * 纯判定：这个 pid 是否属于本 worktree 的 e2e 栈。
 * @param {{pid?: number, commandLine?: string, executablePath?: string,
 *          projectDir?: string, runId?: string, listeningPids?: number[]}} input
 * @returns {{owned: boolean, reason: string}}
 */
export function isOwnedE2ePid({
    pid,
    commandLine = "",
    executablePath = "",
    projectDir = "",
    runId = "",
    listeningPids = [],
} = {}) {
    const cmd = String(commandLine ?? "").toLowerCase();
    const exe = normalizeForMatch(executablePath);
    const dir = normalizeForMatch(projectDir);
    if (dir && (cmd.includes(dir) || (exe && exe.startsWith(dir)))) {
        return { owned: true, reason: "path-in-projectDir" };
    }
    if (runId) {
        const raw = String(runId).toLowerCase();
        const flat = raw.replaceAll("-", "");
        if ((raw && cmd.includes(raw)) || (flat && cmd.includes(flat))) {
            return { owned: true, reason: "runId-in-cmdline" };
        }
    }
    if (Number.isInteger(pid) && Array.isArray(listeningPids) && listeningPids.includes(pid)) {
        return { owned: true, reason: "listening-on-e2e-port" };
    }
    return { owned: false, reason: "no-identity-match" };
}

/** 查询 pid 的命令行/可执行路径；进程已消失返回 null。 */
export async function queryPidIdentity(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (IS_WINDOWS) {
        const filter = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { [string]$_.CommandLine + [char]24 + [string]$_.ExecutablePath })`;
        try {
            const { stdout } = await execFileAsync("powershell.exe", [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                filter,
            ]);
            const raw = String(stdout ?? "").trim();
            if (!raw) return null;
            const [commandLine = "", executablePath = ""] = raw.split(String.fromCharCode(24));
            return { commandLine, executablePath };
        } catch {
            return null;
        }
    }
    try {
        const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
        return { commandLine: raw.replaceAll("\0", " ").trim(), executablePath: "" };
    } catch {
        return null;
    }
}

/** 查询"正在监听给定端口"的 pid 列表；端口先夹到 e2e 块内（块外端口一律不认领）。 */
export async function queryListeningPids(ports = []) {
    const valid = [...new Set(ports.map(Number))].filter(
        (port) => Number.isInteger(port) && port >= E2E_PORT_MIN && port <= E2E_PORT_MAX,
    );
    if (valid.length === 0) return [];
    if (IS_WINDOWS) {
        const list = valid.join(",");
        const ps = `(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(${list}) } | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { [string]$_ }) -join ','`;
        try {
            const { stdout } = await execFileAsync("powershell.exe", [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                ps,
            ]);
            return String(stdout ?? "")
                .split(",")
                .map((value) => Number(value.trim()))
                .filter((value) => Number.isInteger(value) && value > 0);
        } catch {
            return [];
        }
    }
    try {
        const { stdout } = await execFileAsync("sh", [
            "-c",
            `for p in ${valid.join(" ")}; do fuser -n tcp $p 2>/dev/null; done | tr ' ' '\\n' | sort -u | tr '\\n' ' '`,
        ]);
        return String(stdout ?? "")
            .split(/\s+/)
            .map((value) => Number(value.trim()))
            .filter((value) => Number.isInteger(value) && value > 0);
    } catch {
        return [];
    }
}

/**
 * 身份门 + 杀：证明 owned 才 kill，否则拒绝（不杀）。
 * kill/query 均可注入（测试用 spy / 假数据；生产走上面两个 query）。
 * @returns {Promise<{outcome: 'killed'|'refused'|'absent', name: string, pid: number, reason: string}>}
 */
export async function stopPidIfOwned({
    pid,
    name = "process",
    projectDir = "",
    runId = "",
    ports = [],
    kill,
    queryPid = queryPidIdentity,
    queryListening = queryListeningPids,
}) {
    const identity = await queryPid(pid);
    if (!identity) return { outcome: "absent", name, pid, reason: "process-not-found" };
    const listeningPids = await queryListening(ports);
    const verdict = isOwnedE2ePid({
        pid,
        commandLine: identity.commandLine,
        executablePath: identity.executablePath,
        projectDir,
        runId,
        listeningPids,
    });
    if (!verdict.owned) {
        const preview = String(identity.commandLine ?? "").slice(0, 160);
        console.log(
            `[e2e-host] refused to kill foreign pid=${pid} name=${name} (${verdict.reason}) cmd=${preview}`,
        );
        return { outcome: "refused", name, pid, reason: verdict.reason };
    }
    await kill(pid);
    console.log(`[e2e-host] stopped persistent ${name} (pid=${pid}) via ${verdict.reason}`);
    return { outcome: "killed", name, pid, reason: verdict.reason };
}
