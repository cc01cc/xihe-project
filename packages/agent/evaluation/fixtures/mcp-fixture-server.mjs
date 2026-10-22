// PLAN-0532 evaluation-only MCP fixture (remote HTTP, host mode).
//
// Purpose: give the PLAN-0511 evaluation runner a deterministic tool surface so
// `failure_budget.no_repeat.v1` is evaluated for real instead of being reported
// `not_evaluated(no_tool_surface)`.
//
// Scope: evaluation/test only. It is never registered by production code and it
// has no side effects outside its own in-memory counters. It speaks the same
// wire shape as `packages/ui/e2e/fixtures/fake-mcp-server.mjs` (MCP 2026-07-28:
// initialize / tools/list / tools/call over JSON-RPC POST).
//
// Tools exposed:
//   always_failing - returns a deterministic error on every call, which drives
//                    the Agent loop-detection cascade to RUN_NO_PROGRESS.
//
// `apply_patch` is deliberately NOT exposed here: it is an existing system tool
// (Gateway-public, require_approval), so the denied-mutation task must prove the
// tool exists through the system tool list, not through a look-alike fixture.
//
// Env:
//   XIHE_EVAL_MCP_PORT          listen port (default 12761; never 12630-12634)
//   XIHE_EVAL_MCP_BIND          bind address (default 127.0.0.1)
//   XIHE_EVAL_MCP_ACCESS_TOKEN  optional Bearer token; empty = no auth
//
// Control (read-only evidence):
//   GET /__eval/state -> { toolsListed, calls, alwaysFailingCalls, rejectedAuth }

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const port = Number(process.env.XIHE_EVAL_MCP_PORT ?? 12761);
const bind = process.env.XIHE_EVAL_MCP_BIND ?? "127.0.0.1";
const accessToken = process.env.XIHE_EVAL_MCP_ACCESS_TOKEN ?? "";

const sessions = new Map();
const state = {
    toolsListed: 0,
    calls: 0,
    alwaysFailingCalls: 0,
    rejectedAuth: 0,
};

const TOOLS = [
    {
        name: "always_failing",
        description:
            "Deterministic failure fixture: every call returns an error. Evaluation use only.",
        inputSchema: {
            type: "object",
            properties: { attempt: { type: "number" } },
            additionalProperties: true,
        },
    },
];

function json(response, status, body, headers = {}) {
    response.writeHead(status, { "Content-Type": "application/json", ...headers });
    response.end(JSON.stringify(body));
}

function authorized(request) {
    if (!accessToken) return true;
    return request.headers.authorization === `Bearer ${accessToken}`;
}

function readBody(request) {
    return new Promise((resolve, reject) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            body += chunk;
        });
        request.on("end", () => resolve(body));
        request.on("error", reject);
    });
}

function toolResult(body) {
    if (body.method === "initialize") {
        return {
            protocolVersion: "2026-07-28",
            capabilities: { tools: {} },
            serverInfo: { name: "xihe-eval-fixture", version: "0.1.0" },
        };
    }
    if (body.method === "tools/list") {
        state.toolsListed += 1;
        return { tools: TOOLS, resultType: "complete", cacheScope: "private", ttlMs: 0 };
    }
    if (body.method === "tools/call") {
        const name = body.params?.name;
        state.calls += 1;
        if (name === "always_failing") {
            state.alwaysFailingCalls += 1;
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            error: "always_failing",
                            detail: "deterministic failure (evaluation fixture)",
                            attempt: state.alwaysFailingCalls,
                        }),
                    },
                ],
                isError: true,
            };
        }
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ error: "unknown_tool", tool: String(name ?? "") }),
                },
            ],
            isError: true,
        };
    }
    return undefined;
}

const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${bind}:${port}`);

    if (url.pathname === "/health") {
        return json(response, 200, { status: "ok", pid: process.pid });
    }
    if (url.pathname === "/__eval/state") {
        if (request.method !== "GET") return json(response, 405, { error: "method_not_allowed" });
        return json(response, 200, { ...state });
    }
    if (url.pathname !== "/mcp") {
        return json(response, 404, { error: "not_found" });
    }
    if (!authorized(request)) {
        state.rejectedAuth += 1;
        return json(
            response,
            401,
            { error: "invalid_token" },
            { "WWW-Authenticate": "Bearer" },
        );
    }

    if (request.method === "GET") {
        const sessionId = request.headers["mcp-session-id"];
        if (sessionId && !sessions.has(sessionId)) {
            return json(response, 404, { error: "unknown_session" });
        }
        const nextEventId = `ready-${sessions.get(sessionId)?.nextEventNumber ?? 1}`;
        if (sessionId) {
            const session = sessions.get(sessionId);
            session.lastEventId = nextEventId;
            session.nextEventNumber = (session.nextEventNumber ?? 1) + 1;
        }
        response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Last-Event-ID": nextEventId,
        });
        response.write(
            `id: ${nextEventId}\nevent: ready\ndata: {"protocolVersion":"2026-07-28"}\n\n`,
        );
        return response.end();
    }

    if (request.method === "DELETE") {
        sessions.delete(request.headers["mcp-session-id"]);
        return json(response, 200, { jsonrpc: "2.0", result: { disconnected: true } });
    }

    if (request.method !== "POST") {
        return json(response, 405, { error: "method_not_allowed" });
    }

    let body;
    try {
        body = JSON.parse(await readBody(request));
    } catch {
        return json(response, 400, { error: "invalid_json" });
    }
    if (!body || typeof body !== "object" || !body.id) {
        // Notification: accepted without a response body.
        return response.end();
    }

    const sessionId = request.headers["mcp-session-id"] ?? `eval-${randomUUID()}`;
    if (body.method !== "initialize" && !sessions.has(sessionId)) {
        return json(response, 404, {
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32001, message: "session_required" },
        });
    }
    if (body.method === "initialize") {
        sessions.set(sessionId, { lastEventId: null, nextEventNumber: 1 });
    }

    const result = toolResult(body);
    if (!result) {
        return json(response, 400, {
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: "method_not_found" },
        });
    }
    return json(
        response,
        200,
        { jsonrpc: "2.0", id: body.id, result },
        { "mcp-session-id": sessionId },
    );
});

server.listen(port, bind, () => {
    console.log(`[eval-mcp-fixture] listening on ${bind}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => server.close(() => process.exit(0)));
}
