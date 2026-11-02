import { readFileSync } from "node:fs";
import path from "node:path";
import { generateE2EPassword } from "./helpers/password";
import { test, expect } from "@playwright/test";
import { ensureWorkspace } from "./helpers/workspace";
import { dockerFrozenIncluded, dockerFrozenReason } from "./helpers/docker-frozen";

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;

// Single-source stdio fixture (e2e/fixtures/fake-stdio-mcp.mjs), consumed as
// `node -e` source text: the Runtime spawns stdio servers from a workspace cwd,
// where a repo-relative fixture path would not resolve. Mode "echo-arg" makes
// tools/call echo the text argument back (the second inlined copy, plan0366,
// uses mode "echo" for a constant answer).
const FIXTURE_SCRIPT = readFileSync(
    path.resolve(process.cwd(), "e2e/fixtures/fake-stdio-mcp.mjs"),
    "utf8",
);

test.describe("@host MCP — stdio session (PLAN-0347)", () => {
    test("stdio tools/list is visible but public user calls fail closed", async ({ request }) => {
        test.skip(
            !dockerFrozenIncluded,
            dockerFrozenReason(
                "a stdio MCP server is exec'd inside the workspace sandbox: tools/list is visible to the owner while public-user calls fail closed",
            ),
        );
        const register = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `mcp-session-${Date.now()}@test.com`,
                password: SHARED_PASSWORD,
                name: "McpSession",
            },
        });
        expect(
            register.ok(),
            `register failed: ${register.status()} ${await register.text()}`,
        ).toBeTruthy();
        const auth = await register.json(),
            authToken: string = auth.accessToken,
            wsId = await ensureWorkspace(request, auth.accessToken);

        const userHeaders = {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
        };

        // 1) 配置 stdio server（generation 乐观锁；servers 为 name→config 映射）
        const current = await request.get(`${CP_URL}/api/v1/workspaces/${wsId}/stdio-servers`, {
            headers: userHeaders,
        });
        expect(current.ok(), `stdio-servers read failed: ${current.status()}`).toBeTruthy();
        const { generation } = await current.json();
        const put = await request.put(`${CP_URL}/api/v1/workspaces/${wsId}/stdio-servers`, {
            headers: userHeaders,
            data: {
                generation,
                servers: {
                    "e2e-stdio": { command: "node", args: ["-e", FIXTURE_SCRIPT, "echo-arg"] },
                },
            },
        });
        expect(
            put.ok(),
            `stdio-servers write failed: ${put.status()} ${await put.text()}`,
        ).toBeTruthy();

        // 2) 经 CP MCP 端点 tools/list（惰性建会话；轮询窗口内首次调用也成立）
        const mcpHeaders = {
            ...userHeaders,
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2026-07-28",
            "X-Workspace-Id": wsId,
        };
        const init = await request.post(`${CP_URL}/api/v1/mcp`, {
            headers: mcpHeaders,
            data: {
                jsonrpc: "2.0",
                method: "initialize",
                id: 1,
                params: {
                    protocolVersion: "2026-07-28",
                    capabilities: {},
                    clientInfo: { name: "xihe-e2e", version: "0.1.0" },
                },
            },
        });
        expect(init.status(), `initialize failed: ${init.status()} ${await init.text()}`).toBe(200);
        const sessionId = init.headers()["mcp-session-id"];
        const sessionHeaders = sessionId
            ? { ...mcpHeaders, "mcp-session-id": sessionId }
            : mcpHeaders;
        if (sessionId) {
            await request.post(`${CP_URL}/api/v1/mcp`, {
                headers: sessionHeaders,
                data: { jsonrpc: "2.0", method: "notifications/initialized" },
            });
        }

        const list = await request.post(`${CP_URL}/api/v1/mcp`, {
            headers: sessionHeaders,
            data: { jsonrpc: "2.0", method: "tools/list", id: 2, params: {} },
        });
        expect(list.status(), `tools/list failed: ${list.status()} ${await list.text()}`).toBe(200);
        const listed = await list.json(),
            tools = listed?.result?.tools ?? [];
        expect(JSON.stringify(tools)).toContain("e2e_echo");

        // Public user callers may execute only workspace file tools. e2e_echo is
        // listed for discovery but must be denied before the stdio tool is invoked.
        const call = await request.post(`${CP_URL}/api/v1/mcp`, {
            headers: sessionHeaders,
            data: {
                jsonrpc: "2.0",
                method: "tools/call",
                id: 3,
                params: { name: "e2e_echo", arguments: { text: "ping" } },
            },
        });
        const deniedText = await call.text();
        expect(call.status(), deniedText).toBe(403);
        const denied = JSON.parse(deniedText) as { code?: string; detail?: string };
        expect(denied.code).toBe("FORBIDDEN");
        expect(denied.detail).toBe("Tool execution is not permitted");
    });
});
