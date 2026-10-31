import { expect, type APIRequestContext } from "@playwright/test";

import { CP_URL } from "./journey";

/**
 * PLAN-0591 capability gate: the catalog declares
 * `custom-openai-compatible.capability.tools = false`, so the default
 * mock-lane binding cannot dispatch a request that carries MCP tools
 * (`LLM_TOOL_ROUTE_UNSUPPORTED` before the transport attempt opens). Bind the
 * built-in `openai` provider row (`capability.tools = true`) against the fake
 * LLM instead, which keeps workspace-tool chats working in the mock lane.
 *
 * Shared by the specs that need real workspace-tool runs
 * (plan-0348-session-workspace-isolation, session-branch).
 */
interface ConnectionView {
    id: string;
    providerId: string;
    revision: number;
    enabled: boolean;
    status: string;
    operation?: string;
    manualModels?: string[];
}

export interface ChatIdentity {
    authToken: string;
    workspaceId: string;
}

export async function bindToolCapableChat(
    request: APIRequestContext,
    ctx: ChatIdentity,
    sessionId: string,
    modelName: string,
): Promise<string> {
    const headers = {
        Authorization: `Bearer ${ctx.authToken}`,
        "Content-Type": "application/json",
        "X-Workspace-Id": ctx.workspaceId,
    };
    const baseUrl = `http://127.0.0.1:${process.env.XIHE_FAKE_LLM_PORT}/openai/v1`;
    const list = (await (
        await request.get(`${CP_URL}/api/v1/provider-connections`, { headers })
    ).json()) as { connections?: ConnectionView[] };
    let connection = (list.connections ?? []).find(
        (item) =>
            item.enabled &&
            item.status === "READY" &&
            item.operation === "chat" &&
            item.providerId === "openai",
    );
    if (!connection) {
        const created = await request.post(`${CP_URL}/api/v1/provider-connections`, {
            headers,
            data: {
                providerId: "openai",
                apiTypeId: "openai-chat-completions",
                apiTypeVersion: 1,
                apiKey: "sk-fake-openai-key",
                connectionKey: `e2e-tools-${ctx.workspaceId.slice(0, 8)}`,
                label: "E2E tool-capable chat",
                scope: "USER",
                modelDiscovery: "manual",
                manualModels: [modelName],
                baseUrl,
            },
        });
        expect(created.ok(), `connection create ${created.status()}: ${await created.text()}`).toBe(
            true,
        );
        connection = (await created.json()) as ConnectionView;
        const verified = await request.post(
            `${CP_URL}/api/v1/provider-connections/${connection.id}/verify`,
            { headers },
        );
        expect(verified.ok(), `verify ${verified.status()}: ${await verified.text()}`).toBe(true);
        connection = ((await verified.json()) as { connection: ConnectionView }).connection;
        expect(connection.status, "tool-capable connection must be READY").toBe("READY");
    }
    if (!(connection.manualModels ?? []).includes(modelName)) {
        const patched = await request.patch(
            `${CP_URL}/api/v1/provider-connections/${connection.id}`,
            {
                headers,
                data: {
                    manualModels: [...(connection.manualModels ?? []), modelName],
                    expectedRevision: connection.revision,
                },
            },
        );
        expect(patched.ok(), `models ${patched.status()}: ${await patched.text()}`).toBe(true);
        connection = (await patched.json()) as ConnectionView;
    }
    const bound = await request.patch(`${CP_URL}/api/v1/sessions/${sessionId}`, {
        headers,
        data: {
            providerConnectionId: connection.id,
            modelProvider: "openai",
            modelName,
            connectionRevision: connection.revision,
        },
    });
    expect(bound.ok(), `bind ${bound.status()}: ${await bound.text()}`).toBe(true);
    return connection.id;
}
