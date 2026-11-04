// PLAN-0648（Lead 2026-11-04 批准）：kill-guard 的门测试——根治"陈旧 state PID 复用误杀"。
//
// 两层断言：
//   1) 纯判定（isOwnedE2ePid）：三信号各自的命中/不命中、端口块外不认领；
//   2) 真进程（stopPidIfOwned + 真实 query）：**伪造一个 foreign pid 进 state ⇒ 拒绝杀、
//      进程仍活着**；本 worktree 路径命中的 pid ⇒ 放行（kill 走 spy，断言被调用）。
//
// 运行：mise run test:cli（清单由 scripts/test-wiring.test.mjs 强制登记）。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
    E2E_PORT_MAX,
    E2E_PORT_MIN,
    isOwnedE2ePid,
    queryListeningPids,
    queryPidIdentity,
    stopPidIfOwned,
} from "./kill-guard.mjs";

const PROJECT_DIR = process.cwd(); // test:cli 从仓库根跑，cwd 即本 worktree
const FAKE_PORTS = [27001, 27002]; // e2e 块内的假端口（测试里没人监听）

test("纯判定：三信号任一命中即 owned", () => {
    // ① 命令行带 worktree 路径（CP jar / UI vite / fake fixture 都是这个形态）
    assert.deepEqual(
        isOwnedE2ePid({
            pid: 100,
            commandLine: `java -jar ${PROJECT_DIR}\\packages\\control-plane\\target\\control-plane-0.1.0.jar`,
            projectDir: PROJECT_DIR,
        }),
        { owned: true, reason: "path-in-projectDir" },
    );
    // ①' 可执行路径在 worktree 内（runtime exe 形态）
    assert.equal(
        isOwnedE2ePid({
            pid: 104,
            commandLine: "",
            executablePath: `${PROJECT_DIR}\\packages\\runtime\\target\\debug\\xihe-runtime.exe`,
            projectDir: PROJECT_DIR,
        }).owned,
        true,
    );
    // docker compose -p 会剥掉 runId 的连字符：两种形态都要命中
    assert.equal(
        isOwnedE2ePid({
            pid: 101,
            commandLine: `docker compose -p xihe-e2e-host-host-1793-x-a036 down`,
            runId: "host-1793-x-a036",
        }).owned,
        true,
    );
    assert.equal(
        isOwnedE2ePid({
            pid: 102,
            commandLine: `docker compose -p xihe-e2e-host-host1793xa036 down`,
            runId: "host-1793-x-a036",
        }).owned,
        true,
    );
    // ③ argv 无任何路径的 agent（`-m xihe_agent.main`）只能靠端口认领
    assert.deepEqual(
        isOwnedE2ePid({
            pid: 103,
            commandLine: `"C:\\uv\\python.exe" -m xihe_agent.main`,
            listeningPids: [103],
        }),
        { owned: true, reason: "listening-on-e2e-port" },
    );
});

test("纯判定：foreign 进程三信号全不命中 → 拒绝", () => {
    const foreign = isOwnedE2ePid({
        pid: 200,
        commandLine: `"C:\\Program Files\\nodejs\\node.exe" -e setInterval(()=>{},1000)`,
        executablePath: "C:\\Program Files\\nodejs\\node.exe",
        projectDir: PROJECT_DIR,
        runId: "host-1793-x-a036",
        listeningPids: [999], // 别人的 pid，不是 200
    });
    assert.deepEqual(foreign, { owned: false, reason: "no-identity-match" });
});

test("纯判定：e2e 端口块外的监听不认领（dev/stack-slot 端口永远不算身份）", async () => {
    assert.equal(E2E_PORT_MIN, 27000);
    assert.equal(E2E_PORT_MAX, 29999);
    // 12633/12643 是 dev/stack-slot 端口：块外 → 直接过滤、不查询、返回 []
    assert.deepEqual(await queryListeningPids([12633, 12643, 80]), []);
    // 块内但没人监听 → 同样 []
    assert.deepEqual(await queryListeningPids([FAKE_PORTS[0]]), []);
});

test("真进程：foreign pid 进 state → 拒绝杀且进程仍活着", async () => {
    // 一个与本 worktree 无关的进程（argv 无 projectDir、无 runId、不监听假端口）
    const foreign = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        stdio: "ignore",
        windowsHide: true,
    });
    assert.ok(foreign.pid, "foreign child must start");
    try {
        const killed = [];
        const result = await stopPidIfOwned({
            pid: foreign.pid,
            name: "foreign",
            projectDir: PROJECT_DIR,
            runId: "host-0000-x-dead",
            ports: FAKE_PORTS,
            kill: async (pid) => {
                killed.push(pid);
            },
        });
        assert.equal(result.outcome, "refused", JSON.stringify(result));
        assert.deepEqual(killed, [], "kill must NOT be called for a foreign pid");
        // 进程必须还活着（拒绝 = 没杀）
        assert.doesNotThrow(() => process.kill(foreign.pid, 0));
    } finally {
        // 清理的是自己刚 spawn 的子进程（本测试自己的资源）
        try {
            process.kill(foreign.pid);
        } catch {
            // already gone
        }
    }
});

test("真进程：argv 带本 worktree 路径 → 放行（kill spy 被调用）", async () => {
    const owned = spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)", PROJECT_DIR],
        { stdio: "ignore", windowsHide: true },
    );
    assert.ok(owned.pid, "owned child must start");
    try {
        const killed = [];
        const result = await stopPidIfOwned({
            pid: owned.pid,
            name: "owned",
            projectDir: PROJECT_DIR,
            runId: "host-0000-x-live",
            ports: FAKE_PORTS,
            kill: async (pid) => {
                killed.push(pid);
            },
        });
        assert.equal(result.outcome, "killed", JSON.stringify(result));
        assert.deepEqual(killed, [owned.pid], "kill must be called exactly for this pid");
    } finally {
        try {
            process.kill(owned.pid);
        } catch {
            // already gone
        }
    }
});

test("真进程：已消失的 pid → absent，不调 kill", async () => {
    const dead = spawn(process.execPath, ["-e", "setTimeout(()=>{},1)"], {
        stdio: "ignore",
        windowsHide: true,
    });
    await new Promise((resolve) => dead.once("exit", resolve));
    const killed = [];
    const result = await stopPidIfOwned({
        pid: dead.pid,
        name: "dead",
        projectDir: PROJECT_DIR,
        ports: FAKE_PORTS,
        kill: async (pid) => {
            killed.push(pid);
        },
    });
    assert.equal(result.outcome, "absent", JSON.stringify(result));
    assert.deepEqual(killed, [], "kill must NOT be called for an absent pid");
});

test("queryPidIdentity 对活进程返回非空命令行", async () => {
    const probe = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        stdio: "ignore",
        windowsHide: true,
    });
    try {
        const identity = await queryPidIdentity(probe.pid);
        assert.ok(identity, "identity must be queryable for a live pid");
        assert.match(identity.commandLine, /setInterval/);
    } finally {
        try {
            process.kill(probe.pid);
        } catch {
            // already gone
        }
    }
});
