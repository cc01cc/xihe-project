/**
 * PLAN-0497 T2.2 —— acquire_credential 真实链路（CP + Agent 进程）。
 *
 * 前置条件（缺一不可）：
 *  1. 栈必须以 `--llm-mode=credential_acquire` 启动，例如
 *     `node scripts/e2e-host.mjs --persistent --llm-mode=credential_acquire`；
 *     fake LLM 只在非 `mock` 模式启动，且只有 `credential_acquire` 模式会按用户消息里的
 *     `XIHE-E2E-ACQUIRE <credentialId>` 标记产出**确定性**的 acquire_credential tool call。
 *  2. 必须是隔离栈（`XIHE_E2E_PG_CONTAINER` 等由 scripts/e2e-host.mjs 注入）：durable
 *     明文扫描直接查该轮隔离库；非隔离栈整体 skip，绝不误查 dev 库。
 *
 * 断言口径（V2/V5 的真实进程半）：
 *  - 闭环：manual ask 配置下工具调用挂起 → UI 审批 → 交付 → 运行以 "Acquired." 成功收尾；
 *  - 明文只进 Agent 进程内存：UI 页面、messages projection、隔离库所有 durable 表
 *    （messages / approval_requests / mcp_invocations / credential_leases /
 *    credential_events / credentials / audit_logs / chat_runs / context_events /
 *    context_projections）均不含明文；
 *  - 租约单次消费：credential_leases 恰好 1 行且已 redeemed，credential_events 有
 *    lease_issued + lease_redeemed。
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";
import {
    awaitLatestChatRunCompleted,
    ensureAgentWorkspaceBinding,
    getRootBranchId,
    sendChat,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";
import { createWorkspaceSessionWithPrincipal } from "./helpers/agent-principal";
import { seedUserGrant } from "./helpers/user-grants";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? "mock";

// Single serial test: the Agent keeps one process-level MCP workspace binding
// (PLAN-262), so register + approve must share one workspace/browser session.
test.describe.configure({ mode: "serial", retries: 0 });

// The durable plaintext scan needs the isolated PostgreSQL fixture; the dev DB
// must never be scanned for a secret. Everything is injected by e2e-host.
const PG_CONTAINER = process.env.XIHE_E2E_PG_CONTAINER ?? "";
const PG_DATABASE = process.env.XIHE_E2E_PG_DATABASE ?? "";
const PG_USER = process.env.XIHE_E2E_PG_USER ?? "";

function psql(sql: string): string {
    if (!PG_CONTAINER || !PG_DATABASE || !PG_USER) {
        throw new Error(
            "isolated PostgreSQL fixture metadata is unavailable; run through scripts/e2e-host.mjs",
        );
    }
    return execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        [
            "exec",
            PG_CONTAINER,
            "psql",
            "-X",
            "-A",
            "-t",
            "-U",
            PG_USER,
            "-d",
            PG_DATABASE,
            "-c",
            sql,
        ],
        { encoding: "utf8", timeout: 20_000, windowsHide: true },
    ).trim();
}

async function provisionCredentialAgent(
    request: APIRequestContext,
    options: {
        workspaceId: string;
        headers: Record<string, string>;
        name: string;
        credentialId: string;
    },
): Promise<string> {
    const { workspaceId, headers, name, credentialId } = options;
    const roleId = randomUUID(),
        templateId = randomUUID();
    const credentialAtom = {
        actionClass: "credential_use",
        resource: `credential:${credentialId}`,
    };
    const templateWrite = await request.put(`${CP_URL}/api/v1/config/user/agent-templates`, {
        headers,
        data: {
            roles: JSON.stringify([
                { id: roleId, name: `${name} Role`, permissions: [credentialAtom] },
            ]),
            templates: JSON.stringify([
                {
                    id: templateId,
                    name,
                    description: "Bounded Agent fixture for Host credential acquisition",
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
        data: { name, templateId },
    });
    expect(principalResponse.status(), await principalResponse.text()).toBe(201);
    const principalId = ((await principalResponse.json()) as { principalId: string }).principalId;

    const bindResponse = await request.put(
        `${CP_URL}/api/v1/workspaces/${workspaceId}/agents/${principalId}`,
        { headers, data: { permissions: [credentialAtom] } },
    );
    expect(bindResponse.status(), await bindResponse.text()).toBe(200);
    return principalId;
}

function leaseCount(credentialId: string): number {
    return Number(
        psql(`select count(*) from credential_leases where credential_id = '${credentialId}'`),
    );
}

function leaseRedeemed(credentialId: string): boolean {
    return (
        psql(
            `select coalesce(redeemed_at is not null, false) from credential_leases ` +
                `where credential_id = '${credentialId}' order by created_at desc limit 1`,
        ) === "t"
    );
}

function credentialEventTypes(credentialId: string): string {
    return psql(
        `select coalesce(string_agg(event_type, ','), '') from credential_events ` +
            `where credential_id = '${credentialId}'`,
    );
}

/** Any durable table carrying the delivered plaintext is an I5 breach. */
function tablesLeakingSecret(secret: string): string[] {
    const tables = [
        "messages",
        "approval_requests",
        "mcp_invocations",
        "credential_leases",
        "credential_events",
        "credentials",
        "audit_logs",
        "chat_runs",
        // Wave review: tool.result 的 durable 落点（context_events.payload）与其投影
        // 是交付链路的直接落库面，必须纳入 V2 明文扫描。
        "context_events",
        "context_projections",
    ];
    const leaking: string[] = [];
    for (const table of tables) {
        const hits = Number(
            psql(
                `select count(*) from ${table} t where position('${secret}' in to_jsonb(t)::text) > 0`,
            ),
        );
        if (hits > 0) leaking.push(`${table}:${hits}`);
    }
    return leaking;
}

test("@host credential acquisition — manual ask, delivery, memory-only value", async ({
    page,
    request,
}) => {
    test.skip(
        LLM_MODE !== "credential_acquire",
        "credential acquisition flow requires XIHE_E2E_LLM_MODE=credential_acquire",
    );
    test.skip(!PG_CONTAINER, "requires the isolated host stack (scripts/e2e-host.mjs)");
    test.setTimeout(300000);

    const deliveredSecret = `e2e-acquire-secret-${Date.now()}-${randomUUID().slice(0, 8)}`;

    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
    const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: {
            email: `credential-acquire-${Date.now()}@test.com`,
            password,
            name: "CredentialAcquire",
        },
    });
    expect([200, 201], `register failed: ${reg.status()} ${await reg.text()}`).toContain(
        reg.status(),
    );
    const auth = await reg.json(),
        authToken: string = auth.accessToken,
        wsId: string = auth.workspaceId;
    const authHeaders = {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
    };

    const meResponse = await request.get(`${CP_URL}/api/v1/auth/me`, { headers: authHeaders });
    expect(meResponse.ok(), await meResponse.text()).toBe(true);
    const userId = ((await meResponse.json()) as { id: string }).id;

    // The credential_use ceiling is required to write the template/principal and
    // the workspace cap; credential_manage:* is required to register the credential.
    seedUserGrant(userId, wsId, [
        { actionClass: "write", resource: "*" },
        { actionClass: "delete", resource: "*" },
        { actionClass: "credential_manage", resource: "credential:*" },
        { actionClass: "credential_use", resource: "credential:*" },
    ]);

    // lease tier so the value must travel through the single-use lease channel.
    const credentialResponse = await request.post(`${CP_URL}/api/v1/credentials`, {
        headers: authHeaders,
        data: {
            ownerType: "USER",
            ownerId: userId,
            label: "e2e-acquire",
            kind: "token",
            deliveryTier: "lease",
            token: deliveredSecret,
        },
    });
    expect(credentialResponse.status(), await credentialResponse.text()).toBe(201);
    const credentialId = ((await credentialResponse.json()) as { id: string }).id;
    expect(credentialId).toBeTruthy();

    const principalId = await provisionCredentialAgent(request, {
        workspaceId: wsId,
        headers: authHeaders,
        name: `Credential Acquire ${Date.now()}`,
        credentialId,
    });

    // V5: manual ask on the credential_use action class parks the tool call.
    const policyResponse = await request.put(
        `${CP_URL}/api/v1/config/workspace/approval-policy?workspaceId=${wsId}`,
        {
            headers: authHeaders,
            data: { mode: "manual", askActionClasses: JSON.stringify(["credential_use"]) },
        },
    );
    expect(policyResponse.status(), await policyResponse.text()).toBe(200);

    // PLAN-0369: single-binding Agent — rebind before the workspace-tool chat.
    await ensureAgentWorkspaceBinding(wsId);
    await waitForControlPlaneAgentReady(request, {
        Authorization: `Bearer ${authToken}`,
        "X-Workspace-Id": wsId,
    });

    await page.addInitScript((t) => localStorage.setItem("xihe-token", t), authToken);
    await page.addInitScript(
        (raw) => localStorage.setItem("xihe-user", raw),
        JSON.stringify({ workspaceId: wsId }),
    );
    await page.addInitScript((ws) => localStorage.setItem("xihe-workspace", JSON.stringify(ws)), {
        id: wsId,
        name: "Default Workspace",
    });

    await page.goto("/workspace/" + wsId, { waitUntil: "load" });
    await expect(page.getByTestId("workspace-create-session")).toBeVisible({ timeout: 20000 });
    await createWorkspaceSessionWithPrincipal(page, principalId);
    await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 20000 });
    const modal = page.locator('[data-testid="modal-content"]');

    // The fake LLM issues acquire_credential for the id embedded in the marker.
    await sendChat(page, `XIHE-E2E-ACQUIRE ${credentialId}`);
    await expect(modal, "approval modal for acquire_credential").toBeVisible({ timeout: 120000 });
    // The approval payload must never carry the delivered value.
    await expect(modal).not.toContainText(deliveredSecret);
    await modal.locator('[data-testid="approval-approve"]').click();
    await expect(modal).toBeHidden({ timeout: 20000 });

    // Delivery happened in-memory: the run answers without echoing the value.
    await expect(page.locator("text=Acquired.").first()).toBeVisible({ timeout: 120000 });
    await awaitLatestChatRunCompleted(request, authHeaders, wsId);

    // --- I5: no durable surface may carry the plaintext ---
    expect(
        await page.content(),
        "UI projection must not contain the credential value",
    ).not.toContain(deliveredSecret);

    const sessionsRes = await request.get(`${CP_URL}/api/v1/sessions`, { headers: authHeaders });
    expect(sessionsRes.ok()).toBeTruthy();
    const sessions = (await sessionsRes.json()) as { sessions: Array<{ id: string }> };
    expect(sessions.sessions.length).toBeGreaterThan(0);
    const sid = sessions.sessions[0].id,
        branchId = await getRootBranchId(request, sid, authHeaders);
    const messagesRes = await request.get(
        `${CP_URL}/api/v1/sessions/${sid}/messages?branchId=${branchId}`,
        { headers: authHeaders },
    );
    expect(messagesRes.ok()).toBeTruthy();
    expect(
        await messagesRes.text(),
        "durable message projection must not contain the credential value",
    ).not.toContain(deliveredSecret);

    expect(tablesLeakingSecret(deliveredSecret), "no durable table may carry the value").toEqual(
        [],
    );

    // --- lease semantics: single issue, single redeem ---
    expect(leaseCount(credentialId), "exactly one lease issued for the delivery").toBe(1);
    expect(leaseRedeemed(credentialId), "the delivered lease is redeemed").toBe(true);
    const events = credentialEventTypes(credentialId);
    expect(events, "lease_issued recorded").toContain("lease_issued");
    expect(events, "lease_redeemed recorded").toContain("lease_redeemed");
});
