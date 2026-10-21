// L0 self-check for the PLAN-0532 evaluation MCP fixture.
//
// Starts the fixture on an ephemeral port (never the shared 12630-12634 range),
// then exercises: health -> initialize -> tools/list -> tools/call(always_failing)
// -> /__eval/state. Exits non-zero on the first failed assertion.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "mcp-fixture-server.mjs");

const port = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
        const assigned = probe.address().port;
        probe.close(() => resolve(assigned));
    });
});

const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, XIHE_EVAL_MCP_PORT: String(port) },
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

try {
    const health = await fetch(`${base}/health`);
    assert(health.ok, `health status ${health.status}`);

    const init = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2026-07-28",
                capabilities: {},
                clientInfo: { name: "plan-0532-smoke", version: "0.1.0" },
            },
        }),
    });
    assert(init.ok, `initialize status ${init.status}`);
    const sessionId = init.headers.get("mcp-session-id");
    assert(Boolean(sessionId), "initialize must return mcp-session-id");
    const initBody = await init.json();
    assert(initBody.result?.protocolVersion === "2026-07-28", "protocolVersion mismatch");

    const list = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "mcp-session-id": sessionId,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    assert(list.ok, `tools/list status ${list.status}`);
    const tools = (await list.json()).result?.tools ?? [];
    const names = tools.map((tool) => tool.name);
    assert(names.includes("always_failing"), `always_failing missing from ${names.join(",")}`);
    assert(!names.includes("apply_patch"), "fixture must not fake the system apply_patch tool");

    const calls = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const call = await fetch(`${base}/mcp`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                "mcp-session-id": sessionId,
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 10 + attempt,
                method: "tools/call",
                params: { name: "always_failing", arguments: { attempt } },
            }),
        });
        assert(call.ok, `tools/call status ${call.status}`);
        const result = (await call.json()).result;
        assert(result?.isError === true, `call ${attempt} must be isError`);
        calls.push(result);
    }
    assert(
        calls[0].content[0].text !== calls[1].content[0].text,
        "failure payloads must be reproducible but per-call distinct (attempt counter)",
    );

    const state = await (await fetch(`${base}/__eval/state`)).json();
    assert(state.toolsListed === 1, `toolsListed=${state.toolsListed}`);
    assert(state.alwaysFailingCalls === 2, `alwaysFailingCalls=${state.alwaysFailingCalls}`);
    assert(state.calls === 2, `calls=${state.calls}`);

    console.log(
        JSON.stringify(
            {
                ok: true,
                port,
                tools: names,
                toolsListed: state.toolsListed,
                calls: state.calls,
                alwaysFailingCalls: state.alwaysFailingCalls,
            },
            null,
            2,
        ),
    );
} finally {
    child.kill();
}
