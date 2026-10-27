import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";
import { createWorkspaceSessionWithPrincipal } from "./helpers/agent-principal";
import {
    ensureAgentWorkspaceBinding,
    ensureChatBinding,
    seedPage,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";
import type { JourneyContext } from "./helpers/journey";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`,
    LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? "mock";

// Java UUID.nameUUIDFromBytes (v3/MD5), matching CP's builtin request template id.
function nameUuidFromBytes(name: string): string {
    const bytes = Buffer.from(createHash("md5").update(name, "utf8").digest());
    bytes[6] = ((bytes[6] & 0x0f) | 0x30) as number;
    bytes[8] = ((bytes[8] & 0x3f) | 0x80) as number;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function bindBuiltinRequestTemplate(
    request: APIRequestContext,
    sessionId: string,
    headers: Record<string, string>,
): Promise<void> {
    const sessionResponse = await request.get(`${CP_URL}/api/v1/sessions/${sessionId}`, {
        headers,
    });
    expect(sessionResponse.status(), await sessionResponse.text()).toBe(200);
    const session = (await sessionResponse.json()) as { providerConnectionId?: string };
    expect(
        session.providerConnectionId,
        "Session must be Provider-bound by ensureChatBinding",
    ).toBeTruthy();
    const listResponse = await request.get(`${CP_URL}/api/v1/provider-connections`, { headers });
    expect(listResponse.status(), await listResponse.text()).toBe(200);
    const list = (await listResponse.json()) as {
            connections: Array<{ id: string; revision: number }>;
        },
        connection = list.connections.find((item) => item.id === session.providerConnectionId);
    expect(connection, "bound connection must appear in provider list").toBeTruthy();
    const binding = await request.patch(
        `${CP_URL}/api/v1/sessions/${sessionId}/api-request-template`,
        {
            headers,
            data: {
                layer: "instance",
                templateId: nameUuidFromBytes("api-request-templates:openai-chat-completions@1"),
                version: 1,
                connectionRevision: connection!.revision,
            },
        },
    );
    expect(binding.status(), await binding.text()).toBe(200);
}

test.describe.configure({ mode: "serial", retries: 0 });

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

async function createApprovalAgent(
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
                        description: "PLAN-0529 host guidance consumption fixture",
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

async function runSnapshot(
    request: APIRequestContext,
    runId: string,
    headers: Record<string, string>,
) {
    const response = await request.get(`${CP_URL}/api/v1/chat/runs/${runId}/guidance`, { headers });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()) as {
        items: Array<{ id: string; sequence: number; status: string }>;
    };
}

test("@host guidance is consumed after an approved tool batch", async ({ page, request }) => {
    test.skip(LLM_MODE !== "approval", "requires deterministic approval tool-call fixture");
    test.setTimeout(180_000);

    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword(),
        register = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: { email: `guidance-e2e-${Date.now()}@test.com`, password, name: "GuidanceE2E" },
        });
    expect([200, 201], await register.text()).toContain(register.status());
    const authBody = (await register.json()) as { accessToken: string; workspaceId: string },
        authHeaders = {
            Authorization: `Bearer ${authBody.accessToken}`,
            "Content-Type": "application/json",
        },
        me = await request.get(`${CP_URL}/api/v1/auth/me`, { headers: authHeaders });
    expect(me.status(), await me.text()).toBe(200);
    const userId = ((await me.json()) as { id: string }).id,
        principalId = await createApprovalAgent(request, {
            userId,
            workspaceId: authBody.workspaceId,
            headers: authHeaders,
        });

    // Match approval.spec.ts: Agent workspace binding is process-scoped, and
    // creating the Session through the Workspace UI binds the API template.
    await ensureAgentWorkspaceBinding(authBody.workspaceId);
    await waitForControlPlaneAgentReady(request, authHeaders);
    seedPage(page, {
        authToken: authBody.accessToken,
        workspaceId: authBody.workspaceId,
    } as JourneyContext);
    await page.goto(`/workspace/${authBody.workspaceId}`, { waitUntil: "load" });
    const sessionId = await createWorkspaceSessionWithPrincipal(page, principalId),
        textarea = page.locator("textarea");
    await expect(textarea).toBeVisible({ timeout: 20_000 });
    const sent = page.waitForResponse(
        (response) =>
            response.url().endsWith("/api/v1/chat") && response.request().method() === "POST",
    );
    await textarea.fill("please delete README.md");
    await page.getByTestId("chat-send-button").click();
    const chatResponse = await sent;
    expect(chatResponse.status(), await chatResponse.text()).toBe(202);
    const runId = ((await chatResponse.json()) as { runId: string }).runId;
    expect(runId).toBeTruthy();

    // Approval stalls the run at a stable active boundary. Submit Guidance while
    // awaiting_approval, then approve: tool result completes and the next model
    // call must pre-inject and consume it.
    const modal = page.locator('[data-testid="modal-content"]');
    await expect(modal).toBeVisible({ timeout: 60_000 });
    await expect(modal.locator("text=README.md")).toBeVisible();
    const guidance = await request.post(`${CP_URL}/api/v1/chat/runs/${runId}/guidance`, {
        headers: { ...authHeaders, "Idempotency-Key": `guidance-e2e-${randomUUID()}` },
        data: { content: "After the approved deletion, briefly confirm the result." },
    });
    expect(guidance.status(), await guidance.text()).toBe(201);

    await modal.locator('[data-testid="approval-approve"]').click();
    await expect(modal).toBeHidden({ timeout: 20_000 });

    let consumed: { id: string; sequence: number; status: string } | undefined;
    for (let poll = 0; poll < 120; poll += 1) {
        const view = await runSnapshot(request, runId, authHeaders);
        consumed = view.items.find((item) => item.status === "consumed");
        if (consumed) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(consumed, "the real Agent must consume Guidance at the next model call").toBeTruthy();
    expect(consumed?.sequence).toBe(1);

    // The approval fixture may request a second tool after the injected model
    // call. Reject it to terminalize the run and keep teardown deterministic.
    if (await modal.isVisible().catch(() => false)) {
        await modal.locator('[data-testid="approval-reject"]').click();
        await expect(modal).toBeHidden({ timeout: 20_000 });
    }

    const finalView = await runSnapshot(request, runId, authHeaders);
    expect(finalView.items).toHaveLength(1);
    expect(finalView.items[0].status).toBe("consumed");
});
