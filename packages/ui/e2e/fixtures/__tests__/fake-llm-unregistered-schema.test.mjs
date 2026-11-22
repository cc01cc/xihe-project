// task-724 C1：fake-LLM `unregistered_schema` 模式的夹具自检。
//
// 判据不是「能回一段话」，而是：
//   ① 首轮响应确实发出一个工具名不在注册表内的 tool_call（稳定的探针名）；
//   ② tool 结果后的续请求返回固定 prose，让 spec 能区分「闩住持久化」与「run 崩掉」。
// 关闭该模式（普通 success）时 ① 必不成立，因此 spec 的负控会 FAIL 而非静默 PASS。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../fake-llm-server.mjs", import.meta.url));
const PROBE = "xihe_e2e_unregistered_schema_probe";
const READY_TIMEOUT_MS = 5_000;

function startServer(env) {
    const child = spawn(process.execPath, [SERVER], {
        env: { ...process.env, XIHE_FAKE_LLM_PORT: "0", ...env },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    const ready = new Promise((resolve, reject) => {
        let stdout = "";
        const timer = setTimeout(
            () => reject(new Error(`fake-llm 未就绪: ${stdout}${stderr}`)),
            READY_TIMEOUT_MS,
        );
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
            const match = stdout.match(/ready port=(\d+)/);
            if (match) {
                clearTimeout(timer);
                resolve(Number(match[1]));
            }
        });
        child.once("error", reject);
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
}

async function chat(port, messages) {
    const response = await fetch(`http://127.0.0.1:${port}/openai/v1/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: "Bearer sk-fake-openai-key",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "fake-openai", messages, stream: true }),
    });
    assert.equal(response.status, 200);
    return response.text();
}

async function collectSseToolCalls(text) {
    const calls = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        const payload = JSON.parse(line.slice("data: ".length));
        for (const call of payload.choices?.[0]?.delta?.tool_calls ?? []) calls.push(call);
    }
    return calls;
}

describe("fake-llm unregistered_schema（task-724 C1 负控夹具）", () => {
    /** @type {ReturnType<typeof startServer>} */
    let server;
    let port;

    before(async () => {
        server = startServer({ XIHE_FAKE_LLM_MODE: "unregistered_schema" });
        port = await server.ready;
    });

    after(async () => {
        await stopServer(server);
    });

    it("首轮发未注册工具名的 tool_call（稳定探针名）", async () => {
        const text = await chat(port, [{ role: "user", content: "please run the probe" }]);
        const calls = await collectSseToolCalls(text);
        assert.equal(calls.length, 1, `应恰好一个 tool_call，实际 ${JSON.stringify(calls)}`);
        assert.equal(calls[0].function.name, PROBE);
        assert.equal(calls[0].function.arguments, JSON.stringify({ probe: "unregistered_schema" }));
    });

    it("tool 结果后的续请求返回固定 prose（不是第二次 tool_call）", async () => {
        const text = await chat(port, [
            { role: "user", content: "please run the probe" },
            {
                role: "tool",
                tool_call_id: "call-unregistered-schema-e2e-1",
                content: "Error: not a valid tool",
            },
        ]);
        const calls = await collectSseToolCalls(text);
        assert.equal(calls.length, 0, "续请求不得再发 tool_call");
        assert.match(text, /UNREGISTERED_SCHEMA_TOOL_RESULT_SEEN/);
    });

    it("普通 success 模式不产生该探针（负控的证伪半边）", async () => {
        const plain = startServer({ XIHE_FAKE_LLM_MODE: "success" });
        const plainPort = await plain.ready;
        try {
            const text = await chat(plainPort, [{ role: "user", content: "plain turn" }]);
            assert.doesNotMatch(text, new RegExp(PROBE));
            assert.equal((await collectSseToolCalls(text)).length, 0);
        } finally {
            await stopServer(plain);
        }
    });
});
