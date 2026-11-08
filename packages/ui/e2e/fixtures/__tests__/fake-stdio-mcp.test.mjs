// fixture 自测：fake-stdio-mcp（stdio JSON-RPC，无监听；启停 + 主路径 + 错误/边界）。
//
// 生产方式与真实 spec 一致：把源码当文本交给 `node -e`（Runtime 在 workspace cwd 里 spawn，
// 仓库相对路径在那边不存在），本测试也从源码读入而不是直接执行文件路径。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SOURCE = readFileSync(
    fileURLToPath(new URL("../fake-stdio-mcp.mjs", import.meta.url)),
    "utf8",
);
const RESPONSE_TIMEOUT_MS = 2_000;

/** 起 stdio 子进程（与 spec 相同的 node -e 形态），返回请求/关闭助手。 */
function openStdioServer(mode) {
    const child = spawn(process.execPath, ["-e", SOURCE, mode], {
        stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    let buffer = "";
    const pending = new Map();
    let nextId = 1;
    child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            const message = JSON.parse(line);
            const resolve = pending.get(message.id);
            if (resolve) {
                pending.delete(message.id);
                resolve(message);
            }
        }
    });

    function request(method, params) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`stdio fixture 未回复 ${method}（stderr: ${stderr}）`));
            }, RESPONSE_TIMEOUT_MS);
            pending.set(id, (message) => {
                clearTimeout(timer);
                resolve(message);
            });
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });
    }

    function notify(method, params) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    }

    function raw(text) {
        child.stdin.write(text);
    }

    async function close() {
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
            `stdio fixture 进程未退出（exitCode=${child.exitCode} signal=${child.signalCode}）`,
        );
    }

    return { child, request, notify, raw, close };
}

describe("fake-stdio-mcp（fixture 自测）", () => {
    it("无监听：源码不含 createServer / listen（stdio-only fixture）", () => {
        assert.equal(SOURCE.includes("createServer"), false, "stdio fixture 不得建 HTTP server");
        assert.equal(SOURCE.includes("listen("), false, "stdio fixture 不得监听端口");
    });

    it("主路径：initialize → tools/list → tools/call（mode=echo-arg）", async () => {
        const server = openStdioServer("echo-arg");
        try {
            const init = await server.request("initialize", {});
            assert.equal(init.jsonrpc, "2.0");
            assert.equal(init.result.protocolVersion, "2025-11-25");
            assert.deepEqual(init.result.capabilities, { tools: {} });
            assert.equal(init.result.serverInfo.name, "xihe-e2e");

            const tools = await server.request("tools/list", {});
            assert.equal(tools.result.tools.length, 1);
            assert.equal(tools.result.tools[0].name, "e2e_echo");
            assert.equal(tools.result.tools[0].inputSchema.properties.text.type, "string");

            const call = await server.request("tools/call", {
                name: "e2e_echo",
                arguments: { text: "hello fixture" },
            });
            assert.equal(call.result.content[0].type, "text");
            assert.equal(call.result.content[0].text, "echo:hello fixture");
        } finally {
            await server.close();
        }
    });

    it("mode=echo 回常量 echo；notifications/initialized 不回包", async () => {
        const server = openStdioServer("echo");
        try {
            server.notify("notifications/initialized", {});
            const call = await server.request("tools/call", { name: "e2e_echo", arguments: {} });
            assert.equal(call.result.content[0].text, "echo");
        } finally {
            await server.close();
        }
    });

    it("错误/边界：坏 JSON 行被忽略、未知方法 -32601，后续请求仍通", async () => {
        const server = openStdioServer("echo");
        try {
            server.raw("this is not json\n");
            const unknown = await server.request("bogus/method", {});
            assert.equal(unknown.error.code, -32601);
            assert.equal(unknown.error.message, "method not found");
            const list = await server.request("tools/list", {});
            assert.equal(list.result.tools[0].name, "e2e_echo", "坏行不得打断后续请求");
        } finally {
            await server.close();
        }
    });
});
