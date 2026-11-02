/**
 * Shared fake stdio MCP server for host E2E — single source of truth for the
 * stdio fixture that used to be inlined twice (and had already drifted) in
 * e2e/real/mcp-stdio.spec.ts and e2e/real/plan0366-mcp-status-job-cancel.spec.ts.
 *
 * Consumed as SOURCE TEXT, not executed by path: the Runtime spawns stdio
 * servers with a workspace cwd, so a repo-relative fixture path would not
 * resolve there. Specs embed this file via `node -e`:
 *
 *   import { readFileSync } from "node:fs";
 *   import path from "node:path";
 *   const FIXTURE_SCRIPT = readFileSync(
 *       path.resolve(process.cwd(), "e2e/fixtures/fake-stdio-mcp.mjs"),
 *       "utf8",
 *   );
 *   servers: { "e2e-stdio": { command: "node", args: ["-e", FIXTURE_SCRIPT, "echo-arg"] } }
 *
 * Mode (first user arg under `node -e`; see the argv probe note below):
 *   "echo-arg" -> tools/call answers `echo:<text argument>`  (mcp-stdio.spec.ts)
 *   "echo"     -> tools/call answers the constant `echo`      (plan0366)
 *
 * Byte-compatibility notes (identical wire behavior to both inlined copies):
 * - initialize advertises protocolVersion "2025-11-25". That pinned version is
 *   what the existing assertions tolerate; bumping the advertised version is a
 *   deliberate, separate change (the 2026-11-02 new-protocol-only ruling binds
 *   product coverage, not what this fixture chooses to answer).
 * - Newline-delimited JSON-RPC over stdio (MCP stdio base transport).
 *
 * argv probe (Node 24, 2026-11-02): `node -e "..." alpha beta` yields
 * process.argv = [node, "alpha", "beta"], so the mode flag is process.argv[1].
 * Keep this file dependency-free and side-effect-free at import time.
 */
const MODE = process.argv[1] || "echo";

let buffered = "";
process.stdin.on("data", (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        handleLine(line);
    }
});

function reply(message) {
    process.stdout.write(JSON.stringify(message) + "\n");
}

function handleLine(line) {
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        return;
    }
    if (message.method === "initialize") {
        reply({
            jsonrpc: "2.0",
            id: message.id,
            result: {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "xihe-e2e", version: "0" },
            },
        });
    } else if (message.method === "notifications/initialized") {
        // Client lifecycle notification: nothing to answer.
    } else if (message.method === "tools/list") {
        reply({
            jsonrpc: "2.0",
            id: message.id,
            result: {
                tools: [
                    {
                        name: "e2e_echo",
                        description: "echo",
                        inputSchema: {
                            type: "object",
                            properties: { text: { type: "string" } },
                        },
                    },
                ],
            },
        });
    } else if (message.method === "tools/call") {
        const text = MODE === "echo-arg" ? message.params?.arguments?.text || "" : "";
        reply({
            jsonrpc: "2.0",
            id: message.id,
            result: {
                content: [{ type: "text", text: MODE === "echo-arg" ? "echo:" + text : "echo" }],
            },
        });
    } else {
        reply({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "method not found" },
        });
    }
}
