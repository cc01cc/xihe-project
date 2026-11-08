// fixture 自测：fake-mcp-server（启停 + 主路径 + 错误/边界，端口 0）。
//
// 门禁：`mise run test:e2e:fixtures`（= node --test "e2e/fixtures/__tests__/*.test.mjs"）。
// 覆盖范围刻意最小：只证明「能起在 port 0、session 贯穿 initialize→tools/list→tools/call、
// 坏请求有明确状态码、关掉后无监听」；checkpoint-resume / mutation 状态机不在本文件重复。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../fake-mcp-server.mjs", import.meta.url));
const TOKEN = "fixture-access-token";
const READY_TIMEOUT_MS = 5_000;

function startServer(env = {}) {
    const child = spawn(process.execPath, [SERVER], {
        env: { ...process.env, XIHE_FAKE_MCP_PORT: "0", XIHE_FAKE_MCP_ACCESS_TOKEN: TOKEN, ...env },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    const ready = new Promise((resolve, reject) => {
        let stdout = "";
        const timer = setTimeout(
            () =>
                reject(new Error(`fake-mcp 未在 ${READY_TIMEOUT_MS}ms 内就绪: ${stdout}${stderr}`)),
            READY_TIMEOUT_MS,
        );
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
            const match = stdout.match(/listening on (\d+)/);
            if (match) {
                clearTimeout(timer);
                resolve(Number(match[1]));
            }
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            clearTimeout(timer);
            reject(new Error(`fake-mcp 提前退出 code=${code} signal=${signal}: ${stderr}`));
        });
    });
    return { child, ready };
}

async function stopServer(server) {
    const { child } = server;
    if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
            once(child, "exit"),
            new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
    }
    if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
    }
    assert.ok(
        child.exitCode !== null || child.signalCode !== null,
        `fake-mcp 进程未退出（exitCode=${child.exitCode} signal=${child.signalCode}）`,
    );
}

async function assertPortClosed(port) {
    await assert.rejects(
        fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) }),
        /fetch failed|ECONNREFUSED/,
        `fake-mcp 关闭后端口 ${port} 仍在监听`,
    );
}

describe("fake-mcp-server（fixture 自测）", () => {
    /** @type {ReturnType<typeof startServer>} */
    let server;
    let port;
    let base;

    /** JSON-RPC over POST /mcp（Authorization 固定，可带 mcp-session-id）。 */
    function rpc(body, sessionId) {
        return fetch(base, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${TOKEN}`,
                "Content-Type": "application/json",
                ...(sessionId ? { "mcp-session-id": sessionId } : {}),
            },
            body: JSON.stringify(body),
        });
    }

    before(async () => {
        server = startServer();
        port = await server.ready;
        base = `http://127.0.0.1:${port}/mcp`;
    });

    after(async () => {
        await stopServer(server);
        await assertPortClosed(port);
    });

    it("起在 port 0 的真实端口，且进程活着", () => {
        assert.ok(Number.isInteger(port) && port > 0, `port 0 应绑定真实端口，实际 ${port}`);
        assert.equal(server.child.exitCode, null);
        assert.equal(server.child.signalCode, null);
    });

    it("主路径：initialize 发 session → tools/list → tools/call → GET SSE", async () => {
        const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
        assert.equal(init.status, 200);
        const sessionId = init.headers.get("mcp-session-id");
        assert.ok(sessionId, "initialize 必须回 mcp-session-id");
        const initBody = await init.json();
        assert.equal(initBody.result.protocolVersion, "2026-07-28");
        assert.equal(initBody.result.serverInfo.name, "fake-remote");

        const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, sessionId);
        assert.equal(list.status, 200);
        const listBody = await list.json();
        assert.ok(
            listBody.result.tools.some((tool) => tool.name === "remote_echo"),
            `tools/list 应含 remote_echo，实际 ${JSON.stringify(listBody)}`,
        );

        const call = await rpc(
            {
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: { name: "remote_echo", arguments: { text: "hello fixture" } },
            },
            sessionId,
        );
        assert.equal(call.status, 200);
        const callBody = await call.json();
        assert.equal(callBody.result.content[0].text, "hello fixture");
        assert.equal(callBody.result.isError, false);

        const sse = await fetch(base, {
            headers: { Authorization: `Bearer ${TOKEN}`, "mcp-session-id": sessionId },
        });
        assert.equal(sse.status, 200);
        assert.match(sse.headers.get("content-type") ?? "", /text\/event-stream/);
        const sseText = await sse.text();
        assert.ok(sseText.includes("event: ready"), `SSE 应含 ready 事件，实际 ${sseText}`);
    });

    it("错误/边界：无 token 401、未知路径 404、缺 session 404、未知方法 400", async () => {
        const noToken = await fetch(base, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        });
        assert.equal(noToken.status, 401);
        assert.equal(noToken.headers.get("www-authenticate"), "Bearer");

        const unknownPath = await fetch(`http://127.0.0.1:${port}/nope`);
        assert.equal(unknownPath.status, 404);

        const noSession = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        assert.equal(noSession.status, 404);
        assert.equal((await noSession.json()).error.message, "session_required");

        const init = await rpc({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} });
        const sessionId = init.headers.get("mcp-session-id");
        const unknownMethod = await rpc(
            { jsonrpc: "2.0", id: 4, method: "bogus/method" },
            sessionId,
        );
        assert.equal(unknownMethod.status, 400);
        assert.equal((await unknownMethod.json()).error.code, -32601);
    });
});
