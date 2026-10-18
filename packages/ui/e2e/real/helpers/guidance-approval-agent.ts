// PLAN-0530: shared approval-agent fixture for Guidance UI host specs.
// Extracted from guidance-consume.spec.ts so both spec files can reuse it.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;

function seedApprovalGrant(userId: string, workspaceId: string) {
    const container = process.env.XIHE_E2E_PG_CONTAINER,
        database = process.env.XIHE_E2E_PG_DATABASE,
        dbUser = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !dbUser) {
        throw new Error(
            "isolated PostgreSQL fixture metadata is unavailable; run through e2e-host",
        );
    }
    const permissions = JSON.stringify([
        { actionClass: "CREATE_ACCOUNT", resource: "*" },
        { actionClass: "CREATE_TEMPLATE", resource: "*" },
        { actionClass: "MANAGE_WORKSPACE_AGENTS", resource: workspaceId },
        { actionClass: "delete", resource: "*" },
        { actionClass: "write", resource: "*" },
    ]).replaceAll("'", "''");
    execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        [
            "exec",
            container,
            "psql",
            "-X",
            "-A",
            "-t",
            "-U",
            dbUser,
            "-d",
            database,
            "-c",
            `INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source, read_state) ` +
                `VALUES (gen_random_uuid(), 'user', '${userId}'::uuid, 'user', '${userId}'::uuid, ` +
                `'${permissions}'::jsonb, 'direct', 'read')`,
        ],
        { encoding: "utf8", timeout: 15_000, windowsHide: true },
    );
}

export async function createApprovalAgent(
    request: APIRequestContext,
    options: {
        userId: string;
        workspaceId: string;
        headers: Record<string, string>;
    },
): Promise<string> {
    const { userId, workspaceId, headers } = options;
    seedApprovalGrant(userId, workspaceId);
    const roleId = randomUUID(),
        templateId = randomUUID(),
        templateWrite = await request.put(`${CP_URL}/api/v1/config/user/agent-templates`, {
            headers,
            data: {
                roles: JSON.stringify([
                    {
                        id: roleId,
                        name: "Guidance E2E Role",
                        permissions: [
                            { actionClass: "delete", resource: "*" },
                            { actionClass: "write", resource: "*" },
                        ],
                    },
                ]),
                templates: JSON.stringify([
                    {
                        id: templateId,
                        name: "Guidance E2E Agent",
                        description: "PLAN-0529/0530 host guidance fixture",
                        systemPrompt: "Use only the Workspace tools provided by CP.",
                        toolMode: "workspace",
                        provider: "openai",
                        model: "fake-openai",
                        roleId,
                    },
                ]),
            },
        });
    expect(templateWrite.status(), await templateWrite.text()).toBe(200);
    const principalResponse = await request.post(`${CP_URL}/api/v1/agent-principals`, {
        headers,
        data: { name: "Guidance E2E Agent", templateId },
    });
    expect(principalResponse.status(), await principalResponse.text()).toBe(201);
    const principalId = ((await principalResponse.json()) as { principalId: string }).principalId,
        bind = await request.put(
            `${CP_URL}/api/v1/workspaces/${workspaceId}/agents/${principalId}`,
            {
                headers,
                data: {
                    permissions: [
                        { actionClass: "delete", resource: "*" },
                        { actionClass: "write", resource: "*" },
                    ],
                },
            },
        );
    expect(bind.status(), await bind.text()).toBe(200);
    return principalId;
}
