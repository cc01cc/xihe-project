// L0 self-check for the PLAN-0540 deterministic fake LLM.
//
// Starts the fixture on an ephemeral port, then exercises SSE tool-call turns,
// the same-prompt-to-same-call loop shape, a text task, the missing-tool guard
// and /__eval/state. Exits non-zero on the first failed assertion.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "fake-llm-server.mjs");

const port = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
        const assigned = probe.address().port;
        probe.close(() => resolve(assigned));
    });
});

const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, XIHE_EVAL_LLM_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
let ready = false;
child.stdout.on("data", (chunk) => {
    if (chunk.includes("listening")) ready = true;
});
child.stderr.on("data", (chunk) => process.stderr.write(`[fixture] ${chunk}`));

const base = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 10_000;
while (!ready && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
}
if (!ready) {
    child.kill();
    console.error("FAIL fixture did not report readiness");
    process.exit(1);
}

function assert(condition, message) {
    if (!condition) {
        child.kill();
        console.error(`FAIL ${message}`);
        process.exit(1);
    }
}

function parseSse(text) {
    const chunks = [];
    for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") {
            chunks.push({ done: true });
            continue;
        }
        chunks.push(JSON.parse(payload));
    }
    return chunks;
}

const tools = [
    {
        type: "function",
        function: {
            name: "mcp__eval_fixture__always_failing",
            description: "always fails",
            parameters: {
                type: "object",
                properties: { attempt: { type: "number" } },
            },
        },
    },
];

async function chat(body) {
    const resp = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    assert(resp.ok, `chat status ${resp.status}`);
    return body.stream ? parseSse(await resp.text()) : resp.json();
}

const failurePrompt = "Keep calling the tool named always_failing until it succeeds.";

try {
    const health = await (await fetch(`${base}/health`)).json();
    assert(health.status === "ok", "health status");

    const models = await (await fetch(`${base}/v1/models`)).json();
    assert(models.data?.[0]?.id === "eval-fake-model", "models list must expose eval-fake-model");

    const turn1 = await chat({
        model: "eval-fake-model",
        stream: true,
        tools,
        messages: [{ role: "user", content: failurePrompt }],
    });
    const call1 = turn1.find((c) => c.choices?.[0]?.delta?.tool_calls)?.choices[0].delta
        .tool_calls[0];
    assert(call1?.function?.name === "mcp__eval_fixture__always_failing", "namespaced tool name");
    assert(call1.index === 0, "tool call index must default to 0");
    assert(turn1.at(-1)?.done === true, "SSE must end with [DONE]");
    assert(
        turn1.some((c) => c.choices?.[0]?.finish_reason === "tool_calls"),
        "SSE must report finish_reason tool_calls",
    );

    const turn2 = await chat({
        model: "eval-fake-model",
        stream: true,
        tools,
        messages: [
            { role: "user", content: failurePrompt },
            {
                role: "assistant",
                content: null,
                tool_calls: [
                    {
                        id: call1.id,
                        type: "function",
                        function: call1.function,
                    },
                ],
            },
            { role: "tool", tool_call_id: call1.id, content: "isError: true" },
        ],
    });
    const call2 = turn2.find((c) => c.choices?.[0]?.delta?.tool_calls)?.choices[0].delta
        .tool_calls[0];
    assert(call2?.function?.name === call1.function.name, "second turn keeps the same tool");
    assert(
        call2?.function?.arguments === call1.function.arguments,
        "identical arguments keep the loop shape",
    );
    assert(call2.id !== call1.id, "each tool call needs a fresh id");

    const instruction = await chat({
        model: "eval-fake-model",
        stream: true,
        messages: [
            {
                role: "user",
                content: "Return a JSON object with exactly the fields name (string) and ok (boolean).",
            },
        ],
    });
    const text = instruction
        .filter((c) => c.choices?.[0]?.delta?.content)
        .map((c) => c.choices[0].delta.content)
        .join("");
    assert(text === '{"name":"eval","ok":true}', `instruction text=${text}`);
    assert(
        instruction.some((c) => c.choices?.[0]?.finish_reason === "stop"),
        "text turn must finish with stop",
    );

    const missing = await chat({
        model: "eval-fake-model",
        stream: false,
        tools: [],
        messages: [{ role: "user", content: failurePrompt }],
    });
    assert(
        missing.choices?.[0]?.finish_reason === "stop",
        "missing tool must fall back to text",
    );

    const state = await (await fetch(`${base}/__eval/state`)).json();
    assert(state.chatCompletions === 4, `chatCompletions=${state.chatCompletions}`);
    assert(state.streamRequests === 3, `streamRequests=${state.streamRequests}`);
    assert(state.nonStreamRequests === 1, `nonStreamRequests=${state.nonStreamRequests}`);
    assert(state.toolCallsIssued === 2, `toolCallsIssued=${state.toolCallsIssued}`);
    assert(state.toolMissing === 1, `toolMissing=${state.toolMissing}`);
    assert(state.textResponses === 2, `textResponses=${state.textResponses}`);
    assert(state.toolResultsSeen === 1, `toolResultsSeen=${state.toolResultsSeen}`);
    assert(state.lastPromptKind === "failure_budget", `lastPromptKind=${state.lastPromptKind}`);

    console.log(
        JSON.stringify(
            {
                ok: true,
                port,
                chatCompletions: state.chatCompletions,
                toolCallsIssued: state.toolCallsIssued,
                toolMissing: state.toolMissing,
                toolNamesSeen: state.toolNamesSeen,
            },
            null,
            2,
        ),
    );
} finally {
    child.kill();
}
