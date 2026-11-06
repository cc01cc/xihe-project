// PLAN-0648 e2e 门测试：fake-llm `mode=chain` 自测（纯 fixture，不起 XH 栈，秒级）。
//
// 为什么单独立这个门：chain 的状态机（会话游标 / 重试重放 / 耗尽回落）是**测试夹具自身**
// 的逻辑，出错时在真栈上的表现是"工具莫名不出现"，排障成本极高。这里直接用 node:test
// 拉起 fake server 打几轮 chat/completions，把状态机钉死。
//
// 运行：pnpm run test:e2e:fixtures   （无需 Docker / 无需 XH 栈 / 无需浏览器）
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

const SERVER = "e2e/fixtures/fake-llm-server.mjs";
const PORT = Number(process.env.XIHE_FAKE_LLM_TEST_PORT ?? "13999");
const BASE = `http://127.0.0.1:${PORT}/openai/v1`;
const READY_TIMEOUT_MS = 5_000;

/** @param {string[]} messages */
async function chat(messages) {
    const response = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: "Bearer sk-fake-openai-key",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "fake-openai", messages, stream: true }),
    });
    const body = await response.text();
    const toolCalls = [...body.matchAll(/"name":\s*"(\w+)"/g)].map((match) => match[1]);
    return {
        status: response.status,
        toolCalls,
        hasProse: body.includes('"content"'),
    };
}

/** @param {object[]} messages */
const sys = { role: "system", content: "you are the e2e fixture agent" };

function startServer(mode) {
    return spawn(process.execPath, [SERVER], {
        env: { ...process.env, XIHE_FAKE_LLM_PORT: String(PORT), XIHE_FAKE_LLM_MODE: mode },
        stdio: ["ignore", "pipe", "pipe"],
    });
}

async function waitReady() {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${BASE}/models`, {
                headers: { Authorization: "Bearer sk-fake-openai-key" },
            });
            if (response.ok) return;
        } catch {
            // server not listening yet
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("fake-llm server did not become ready");
}

// 会话第一轮：READ marker；后续轮次按 WRITE / EXEC 追加历史（模拟 agent 的多轮上下文）。
const turn1 = { role: "user", content: "turn1 XIHE-E2E-READ README.md" };
const turn2 = { role: "user", content: "turn2 XIHE-E2E-WRITE notes/wf1.md hello" };
const turn3 = { role: "user", content: "turn3 XIHE-E2E-EXEC dir" };
const assistant = { role: "assistant", content: null };
const toolResult = { role: "tool", content: "tool-output" };

describe("fake-llm mode=chain (env activation)", () => {
    /** @type {import("node:child_process").ChildProcess} */
    let server;

    before(async () => {
        server = startServer("chain:wf1-coding");
        await waitReady();
    });

    after(async () => {
        server.kill("SIGTERM");
        await Promise.race([
            once(server, "exit"),
            new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
    });

    it("serves the scripted steps in order and falls back to prose when exhausted", async () => {
        const first = await chat([sys, turn1]);
        assert.equal(first.status, 200);
        assert.deepEqual(first.toolCalls, ["read_file"], "step 1 = read_file");

        const history2 = [sys, turn1, assistant, toolResult];
        const second = await chat([...history2, turn2]);
        assert.deepEqual(second.toolCalls, ["write_file"], "step 2 = write_file");

        const history3 = [...history2, turn2, assistant, toolResult];
        const third = await chat([...history3, turn3]);
        assert.deepEqual(third.toolCalls, ["execute_command"], "step 3 = execute_command");

        const history4 = [...history3, turn3, assistant, toolResult];
        const fourth = await chat([...history4, { role: "user", content: "turn4 wrap up" }]);
        assert.deepEqual(fourth.toolCalls, [], "step 4 = plain text");
        assert.equal(fourth.hasProse, true, "step 4 must be prose");

        const fifth = await chat([
            ...history4,
            { role: "user", content: "turn4 wrap up" },
            { role: "assistant", content: "done" },
            { role: "user", content: "turn5 one more question" },
        ]);
        assert.deepEqual(fifth.toolCalls, [], "exhausted chain never emits tool calls");
        assert.equal(fifth.hasProse, true, "exhausted chain serves prose");
    });

    it("keeps a separate cursor per conversation", async () => {
        const other = await chat([
            { role: "system", content: "a different session" },
            { role: "user", content: "fresh conversation XIHE-E2E-READ X" },
        ]);
        assert.deepEqual(other.toolCalls, ["read_file"], "new session restarts at step 1");
    });

    it("replays the same step when an identical turn is retried", async () => {
        const history = [
            { role: "system", content: "retry session" },
            { role: "user", content: "retry turn A XIHE-E2E-READ A.md" },
        ];
        const served = await chat(history);
        assert.deepEqual(served.toolCalls, ["read_file"]);
        // byte-identical retry (agent-side LLM retry): must replay, not advance.
        const retried = await chat(history);
        assert.deepEqual(retried.toolCalls, ["read_file"], "retry replays the same step");
    });

    it("replays the current step across a mid-turn tool-result request", async () => {
        // 一轮用户消息 = 多个 LLM 请求（请求1 → 工具调用 → 工具结果 → 请求2）。
        // 只有新的 user 消息才推进游标；轮内续请求必须重放当前步（走 builder 的
        // followUp 分支收尾），否则一轮吃两步、链从下一轮起整体错位。
        const u1 = { role: "user", content: "turn A XIHE-E2E-READ A.md" };
        const first = await chat([sys, u1]);
        assert.deepEqual(first.toolCalls, ["read_file"], "fresh turn → step 1");

        const continuation = [
            sys,
            u1,
            { role: "assistant", content: null },
            { role: "tool", content: "file body" },
        ];
        const second = await chat(continuation);
        assert.deepEqual(
            second.toolCalls,
            [],
            "mid-turn continuation must not emit a new tool call",
        );
        assert.equal(
            second.hasProse,
            true,
            "mid-turn continuation replays step 1's followUp prose",
        );

        const nextTurn = await chat([
            ...continuation,
            { role: "user", content: "turn B XIHE-E2E-WRITE b.md hello" },
        ]);
        assert.deepEqual(nextTurn.toolCalls, ["write_file"], "next fresh turn → step 2");
    });
});

describe("fake-llm mode=chain (marker activation)", () => {
    /** @type {import("node:child_process").ChildProcess} */
    let server;

    before(async () => {
        // env 不是 chain：靠首条 user 消息里的 XIHE-E2E-CHAIN 标记按会话激活，
        // 这样同一个栈上不同 spec 可以各用各的链（不必改 runner 的 --llm-mode）。
        server = startServer("success");
        await waitReady();
    });

    after(async () => {
        server.kill("SIGTERM");
        await Promise.race([
            once(server, "exit"),
            new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
    });

    it("activates the chain from the marker and ignores requests without it", async () => {
        const plain = await chat([sys, { role: "user", content: "no marker here" }]);
        assert.deepEqual(plain.toolCalls, [], "unmarked conversation stays in success mode");
        assert.equal(plain.hasProse, true);

        const marked = await chat([
            { role: "system", content: "marker session" },
            { role: "user", content: "XIHE-E2E-CHAIN wf1-coding then XIHE-E2E-READ README.md" },
        ]);
        assert.deepEqual(marked.toolCalls, ["read_file"], "marker activates step 1");
    });
});

// PLAN-0660 T5.23：`ask-user` 链 = ask_user 工具调用 → （人类作答，真栈上 run 在此阻塞）
// → 工具结果回来后续请求返回 prose。这里把「链条目 + mode 分发 + 续请求收尾」钉死，
// 真栈 spec（`e2e/real/plan0660-ask-user.spec.ts`）才敢只依赖它。
describe("fake-llm mode=chain (ask-user script)", () => {
    /** @type {import("node:child_process").ChildProcess} */
    let server;

    before(async () => {
        // marker 激活：与真栈 spec 一致（首条 user 消息带 XIHE-E2E-CHAIN ask-user），
        // 同时验证 chain-scripts 里新条目与 ask_user 模式的分发。
        server = startServer("success");
        await waitReady();
    });

    after(async () => {
        server.kill("SIGTERM");
        await Promise.race([
            once(server, "exit"),
            new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
    });

    it("emits ask_user once, then continues with prose after the answer arrives", async () => {
        const firstTurn = {
            role: "user",
            content: "XIHE-E2E-CHAIN ask-user XIHE-E2E-ASK T5.23 请确认继续",
        };
        const asked = await chat([sys, firstTurn]);
        assert.deepEqual(asked.toolCalls, ["ask_user"], "step 1 = ask_user tool call");
        assert.equal(asked.hasProse, false, "the ask step must not emit prose yet");

        // 作答后 Agent 的续请求：同一轮 + assistant(tool_calls) + tool 结果。
        const continued = await chat([
            sys,
            firstTurn,
            { role: "assistant", content: null },
            { role: "tool", content: "继续 T5.23" },
        ]);
        assert.deepEqual(continued.toolCalls, [], "no further tool call after the answer");
        assert.equal(continued.hasProse, true, "the run continues with prose once answered");
    });
});
