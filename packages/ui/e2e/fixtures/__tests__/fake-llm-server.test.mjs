// fixture 自测：fake-llm-server（启停 + 主路径 + 错误/边界，端口 0）。
//
// 门禁：`mise run test:e2e:fixtures`（= node --test "e2e/fixtures/__tests__/*.test.mjs"）。
// 与 chain-scripts.test.mjs 的分工：那条钉 `mode=chain` 状态机；这里只钉「进程能起停、
// port 0 能服务、main path 通、坏请求有明确状态码」，不重复覆盖 chain/reasoning 的语义。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../fake-llm-server.mjs", import.meta.url));
const READY_TIMEOUT_MS = 5_000;

/** 起 fake-llm 于 port 0（真实端口从 ready 行读）；返回 child 与 port promise。 */
function startServer(env = {}) {
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
            () =>
                reject(new Error(`fake-llm 未在 ${READY_TIMEOUT_MS}ms 内就绪: ${stdout}${stderr}`)),
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
        child.once("exit", (code, signal) => {
            clearTimeout(timer);
            reject(new Error(`fake-llm 提前退出 code=${code} signal=${signal}: ${stderr}`));
        });
    });
    return { child, ready, stderr: () => stderr };
}

/** 停服并证明进程真的走了（SIGTERM → 2s 内退出，否则 SIGKILL 兜底再断言）。 */
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
        `fake-llm 进程未退出（exitCode=${child.exitCode} signal=${child.signalCode}）`,
    );
}

/** port 0 自测的核心断言：关掉后该端口不得再有人监听。 */
async function assertPortClosed(port) {
    await assert.rejects(
        fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) }),
        /fetch failed|ECONNREFUSED/,
        `fake-llm 关闭后端口 ${port} 仍在监听`,
    );
}

describe("fake-llm-server（fixture 自测）", () => {
    /** @type {ReturnType<typeof startServer>} */
    let server;
    let port;
    let base;

    before(async () => {
        server = startServer();
        port = await server.ready;
        base = `http://127.0.0.1:${port}/openai/v1`;
    });

    after(async () => {
        await stopServer(server);
        await assertPortClosed(port);
    });

    it("起在 port 0 的真实端口，且进程活着（未在测试中途退出）", () => {
        assert.ok(Number.isInteger(port) && port > 0, `port 0 应绑定真实端口，实际 ${port}`);
        assert.equal(server.child.exitCode, null);
        assert.equal(server.child.signalCode, null);
    });

    it("主路径：/health、/models、chat completions（带 provider/model echo）", async () => {
        const health = await fetch(`http://127.0.0.1:${port}/health`);
        assert.equal(health.status, 200);
        assert.deepEqual(await health.json(), { status: "ok", mode: "success" });

        const models = await fetch(`${base}/models`, {
            headers: { Authorization: "Bearer sk-fake-openai-key" },
        });
        assert.equal(models.status, 200);
        const modelsBody = await models.json();
        assert.ok(
            modelsBody.data.some((entry) => entry.id === "fake-openai"),
            `/models 应包含 fake-openai，实际 ${JSON.stringify(modelsBody)}`,
        );

        const chat = await fetch(`${base}/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: "Bearer sk-fake-openai-key",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "fake-openai",
                messages: [{ role: "user", content: "hello fixture" }],
                stream: true,
            }),
        });
        assert.equal(chat.status, 200);
        const text = await chat.text();
        assert.ok(
            text.includes("openai fake model=fake-openai"),
            `SSE 应回显 provider/model，实际 ${text}`,
        );
        assert.ok(text.includes("data: [DONE]"), "SSE 必须以 [DONE] 结束");
    });

    it("错误/边界：无 token 401、跨 provider 401、未知路径 404、坏 JSON 400", async () => {
        const unauthorized = await fetch(`${base}/models`);
        assert.equal(unauthorized.status, 401);
        assert.match(JSON.stringify(await unauthorized.json()), /invalid fake credentials/i);

        const wrongProviderKey = await fetch(`http://127.0.0.1:${port}/deepseek/v1/models`, {
            headers: { Authorization: "Bearer sk-fake-openai-key" },
        });
        assert.equal(wrongProviderKey.status, 401, "openai key 不得过 deepseek 的校验");

        const unknownPath = await fetch(`http://127.0.0.1:${port}/openai/nope`, {
            headers: { Authorization: "Bearer sk-fake-openai-key" },
        });
        assert.equal(unknownPath.status, 404);

        const badJson = await fetch(`${base}/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: "Bearer sk-fake-openai-key",
                "Content-Type": "application/json",
            },
            body: "{not json",
        });
        assert.equal(badJson.status, 400);
        assert.match(JSON.stringify(await badJson.json()), /invalid JSON/);
    });
});
