/**
 * PLAN-0498 T4.1/T4.2/T4.3 —— 凭据管理器 UI 全链路（真实浏览器 + 真实 CP/Agent 进程）。
 *
 * 前置条件（缺一不可）：
 *  1. 栈必须以 `--llm-mode=credential_acquire` 启动（复用 0497 的确定性 acquire 模式：
 *     fake LLM 按 `XIHE-E2E-ACQUIRE <credentialId>` 标记产出 acquire_credential tool call）。
 *  2. 必须是隔离栈（scripts/e2e-host.mjs 注入 XIHE_E2E_PG_*）：durable 明文扫描直接查
 *     该轮隔离库；非隔离栈整体 skip。
 *
 * 覆盖：
 *  - T4.1 主流程：UI 登记（token/lease + token/reveal）→ 角色凭据区块（含 precheck 天花板）
 *    → UI 绑定 Agent → 租约 use（manual ask → 审批 → 交付）→ UI reveal（step-up 一次性展示）；
 *  - T4.2 错误路径：天花板警告阻止保存、reveal 错误密码内联、reveal 限流（5 次/15 分钟）、
 *    删除引用报告（绑定后引用可查）；
 *  - T4.3 证据：关键步骤截图 + 脱敏断言（durable 表/页面/投影无明文）。
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";
import {
    awaitLatestChatRunCompleted,
    ensureAgentWorkspaceBinding,
    evidenceDir,
    getRootBranchId,
    sendChat,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";
import { createWorkspaceSessionWithPrincipal } from "./helpers/agent-principal";
import { seedUserGrant } from "./helpers/user-grants";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? "mock";
const EVIDENCE_DIR = evidenceDir("plan-0498-credential-manager");

test.describe.configure({ mode: "serial", retries: 0 });

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

function sqlLiteral(value: string): string {
    return value.replaceAll("'", "''");
}

/**
 * Exact-atom ceilings for the UI-created credentials (lease use + reveal) are appended to the
 * existing row once their server-generated ids are known.
 */
function appendCredentialAtoms(
    userId: string,
    atoms: Array<{ actionClass: string; resource: string }>,
) {
    const extra = JSON.stringify(atoms).replaceAll("'", "''");
    psql(
        `UPDATE grants SET permissions = permissions || '${extra}'::jsonb ` +
            `WHERE subject_type = 'user' AND subject_id = '${userId}'::uuid`,
    );
}

/** Any durable table carrying a delivered/revealed plaintext is an I5 breach. */
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
        "context_events",
        "context_projections",
    ];
    const leaking: string[] = [];
    for (const table of tables) {
        const hits = Number(
            psql(
                `select count(*) from ${table} t where position('${sqlLiteral(secret)}' in to_jsonb(t)::text) > 0`,
            ),
        );
        if (hits > 0) leaking.push(`${table}:${hits}`);
    }
    return leaking;
}

function leaseRows(credentialId: string): string {
    return psql(
        `select count(*) || '/' || coalesce(sum(case when redeemed_at is not null then 1 else 0 end), 0) ` +
            `from credential_leases where credential_id = '${credentialId}'`,
    );
}

function credentialEventTypes(credentialId: string): string {
    return psql(
        `select coalesce(string_agg(event_type, ','), '') from credential_events ` +
            `where credential_id = '${credentialId}'`,
    );
}

async function createCredentialViaUi(
    page: Page,
    options: {
        label: string;
        tier: "lease" | "reveal";
        kind?: "token" | "key_pair";
        token?: string;
        accessKey?: string;
        secretKey?: string;
    },
): Promise<void> {
    await page.getByTestId("credentials-create-button").click();
    const dialog = page.getByTestId("credentials-create-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("credentials-create-label").fill(options.label);
    await dialog.getByTestId("credentials-create-tier").selectOption(options.tier);
    if (options.kind === "key_pair") {
        await dialog.getByTestId("credentials-create-kind").selectOption("key_pair");
        await dialog.getByTestId("credentials-create-access-key").fill(options.accessKey ?? "");
        await dialog.getByTestId("credentials-create-secret-key").fill(options.secretKey ?? "");
    } else {
        await dialog.getByTestId("credentials-create-token").fill(options.token ?? "");
    }
    await dialog.getByTestId("credentials-create-submit").click();
    await expect(dialog).toBeHidden({ timeout: 20000 });
    await expect(page.getByTestId("credentials-list")).toContainText(options.label);
}

async function openCredentialDetail(page: Page, credentialId: string): Promise<void> {
    await page.getByTestId(`credentials-row-${credentialId}`).click();
    await expect(page.getByTestId("credentials-detail-dialog")).toBeVisible();
}

test("@host credential manager — UI registration, role block, binding, lease use and reveal", async ({
    page,
    request,
}, testInfo) => {
    test.skip(
        LLM_MODE !== "credential_acquire",
        "credential manager flow requires XIHE_E2E_LLM_MODE=credential_acquire",
    );
    test.skip(!PG_CONTAINER, "requires the isolated host stack (scripts/e2e-host.mjs)");
    test.setTimeout(600000);
    mkdirSync(EVIDENCE_DIR, { recursive: true });

    const leaseSecret = `e2e-managed-lease-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const revealSecret = `e2e-managed-reveal-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const pairAccessKey = `e2e-managed-ak-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const pairSecretKey = `e2e-managed-sk-${Date.now()}-${randomUUID().slice(0, 8)}`;

    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
    const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: {
            email: `credential-manager-${Date.now()}@test.com`,
            password,
            name: "CredentialManager",
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

    seedUserGrant(userId, wsId, [
        { actionClass: "write", resource: "*" },
        { actionClass: "delete", resource: "*" },
        { actionClass: "credential_manage", resource: "credential:*" },
    ]);

    await page.addInitScript((t) => localStorage.setItem("xihe-token", t), authToken);
    await page.addInitScript(
        (raw) => localStorage.setItem("xihe-user", raw),
        JSON.stringify({ workspaceId: wsId }),
    );
    await page.addInitScript((ws) => localStorage.setItem("xihe-workspace", JSON.stringify(ws)), {
        id: wsId,
        name: "Default Workspace",
    });

    // --- T4.1 ① UI 登记：lease 档 + reveal 档 + key-pair 档各一 ---
    await page.goto("/settings/credentials", { waitUntil: "load" });
    await expect(page.getByTestId("credentials-heading")).toBeVisible({ timeout: 20000 });
    await createCredentialViaUi(page, {
        label: "e2e-managed-lease",
        tier: "lease",
        token: leaseSecret,
    });
    await createCredentialViaUi(page, {
        label: "e2e-managed-reveal",
        tier: "reveal",
        token: revealSecret,
    });
    await createCredentialViaUi(page, {
        label: "e2e-managed-pair",
        tier: "lease",
        kind: "key_pair",
        accessKey: pairAccessKey,
        secretKey: pairSecretKey,
    });
    expect(await page.content(), "列表/页面不得出现明文").not.toContain(leaseSecret);
    expect(await page.content(), "列表/页面不得出现明文").not.toContain(revealSecret);
    expect(await page.content(), "列表/页面不得出现明文").not.toContain(pairAccessKey);
    expect(await page.content(), "列表/页面不得出现明文").not.toContain(pairSecretKey);
    await page.screenshot({ path: path.join(EVIDENCE_DIR, "s1-list.png"), fullPage: true });

    const listResponse = await request.get(`${CP_URL}/api/v1/credentials`, {
        headers: authHeaders,
    });
    expect(listResponse.ok(), await listResponse.text()).toBe(true);
    const listed = (await listResponse.json()) as {
        credentials: Array<{ id: string; label: string }>;
    };
    const leaseCredentialId = listed.credentials.find(
        (item) => item.label === "e2e-managed-lease",
    )?.id;
    const revealCredentialId = listed.credentials.find(
        (item) => item.label === "e2e-managed-reveal",
    )?.id;
    expect(leaseCredentialId, "lease credential id").toBeTruthy();
    expect(revealCredentialId, "reveal credential id").toBeTruthy();

    // 精确原子天花板：lease 用 credential_use@<leaseId>，reveal 用 credential_reveal@<revealId>。
    appendCredentialAtoms(userId, [
        { actionClass: "credential_use", resource: `credential:${leaseCredentialId}` },
        { actionClass: "credential_reveal", resource: `credential:${revealCredentialId}` },
    ]);

    // --- T4.1 ② 角色凭据区块（含 T4.2 天花板警告）---
    await page.goto("/settings/config", { waitUntil: "load" });
    const panel = page.getByTestId("agent-templates-panel");
    await expect(panel).toBeVisible({ timeout: 20000 });
    await panel.getByTestId("agent-role-name").fill("E2E Credential Role");

    const roleBlock = panel.getByTestId("credential-role-block");
    await expect(roleBlock).toBeVisible();
    await roleBlock.getByTestId("credential-role-search").fill("e2e-managed");
    // 天花板用例：先附加未覆盖的 reveal 凭据（无 credential_use 覆盖）→ 保存被阻止。
    await roleBlock.getByTestId(`credential-role-option-${revealCredentialId}`).setChecked(true);
    await roleBlock.getByTestId(`credential-role-option-${leaseCredentialId}`).setChecked(true);
    await roleBlock.getByTestId("credential-role-attach").click();
    await expect(roleBlock.getByTestId("credential-role-attached")).toBeVisible();
    await panel.getByTestId("agent-role-save").click();
    const ceilingWarning = panel.getByTestId("agent-role-ceiling-warning");
    await expect(ceilingWarning, "未覆盖凭据阻止保存").toBeVisible({ timeout: 20000 });
    await expect(ceilingWarning).toContainText(revealCredentialId!);
    await page.screenshot({
        path: path.join(EVIDENCE_DIR, "s2-ceiling-warning.png"),
        fullPage: true,
    });
    await expect(
        panel.locator('[data-testid^="agent-role-"]').filter({ hasText: "E2E Credential Role" }),
    ).toHaveCount(0);

    // 移除未覆盖原子后保存成功。
    await roleBlock.getByTestId(`credential-role-remove-${revealCredentialId}`).click();
    await panel.getByTestId("agent-role-save").click();
    await expect(
        panel
            .locator('[data-testid^="agent-role-"]')
            .filter({ hasText: "E2E Credential Role" })
            .first(),
    ).toContainText("credential_use", { timeout: 20000 });
    await page.screenshot({ path: path.join(EVIDENCE_DIR, "s3-role-block.png"), fullPage: true });

    // 模板与 principal 走 API（引用 UI 保存出的 roleId），绑定在 UI 完成。
    const templatesResponse = await request.get(
        `${CP_URL}/api/v1/config/agent-templates?layer=user&includeMeta=true`,
        {
            headers: authHeaders,
        },
    );
    expect(templatesResponse.ok(), await templatesResponse.text()).toBe(true);
    const templateEntries = (await templatesResponse.json()) as {
        entries?: Record<string, string>;
    };
    const roles = JSON.parse(templateEntries.entries?.roles ?? "[]") as Array<{
        id: string;
        name: string;
    }>;
    const roleId = roles.find((role) => role.name === "E2E Credential Role")?.id;
    expect(roleId, "UI 保存的 role 必须可读").toBeTruthy();

    const templateId = randomUUID();
    const templateWrite = await request.put(`${CP_URL}/api/v1/config/user/agent-templates`, {
        headers: authHeaders,
        data: {
            roles: templateEntries.entries?.roles ?? "[]",
            templates: JSON.stringify([
                {
                    id: templateId,
                    name: `E2E Manager Agent ${Date.now()}`,
                    description: "Bounded Agent fixture for the credential manager flow",
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
        headers: authHeaders,
        data: { name: `E2E Manager Principal ${Date.now()}`, templateId },
    });
    expect(principalResponse.status(), await principalResponse.text()).toBe(201);
    const principalId = ((await principalResponse.json()) as { principalId: string }).principalId;
    const secondPrincipalResponse = await request.post(`${CP_URL}/api/v1/agent-principals`, {
        headers: authHeaders,
        data: { name: `E2E Manager Principal B ${Date.now()}`, templateId },
    });
    expect(secondPrincipalResponse.status(), await secondPrincipalResponse.text()).toBe(201);
    const secondPrincipalId = ((await secondPrincipalResponse.json()) as { principalId: string })
        .principalId;

    // 先把 principal 注册进 workspace（空 cap）使其出现在绑定列表；
    // credential_use 原子由 UI 绑定写入（本流程的验收点）。
    for (const principal of [principalId, secondPrincipalId]) {
        const capResponse = await request.put(
            `${CP_URL}/api/v1/workspaces/${wsId}/agents/${principal}`,
            { headers: authHeaders, data: { permissions: [] } },
        );
        expect(capResponse.status(), await capResponse.text()).toBe(200);
    }

    // --- T4.1 ③ UI 绑定（批量：两个 principal 一次提交；workspace cap 由绑定 API 写入）---
    await page.goto("/settings/credentials", { waitUntil: "load" });
    await openCredentialDetail(page, leaseCredentialId!);
    await page.getByTestId("credentials-tab-bindings").click();
    await expect(page.getByTestId("credential-bindings"), "生效范围文案").toContainText(
        "新建会话生效",
    );
    await page.getByTestId("credential-bind-workspace").selectOption(wsId);
    await expect(page.getByTestId(`credential-bind-agent-${principalId}`)).toBeVisible({
        timeout: 20000,
    });
    await page.getByTestId(`credential-bind-agent-${principalId}`).setChecked(true);
    await page.getByTestId(`credential-bind-agent-${secondPrincipalId}`).setChecked(true);
    await page.getByTestId("credential-bind-apply").click();
    await expect(
        page.locator(`[data-testid="credential-bind-bound"]`),
        "批量绑定后两个 principal 均有已绑定标记",
    ).toHaveCount(2, { timeout: 20000 });
    await page.screenshot({ path: path.join(EVIDENCE_DIR, "s4-bindings.png"), fullPage: true });
    await page.getByTestId("credentials-detail-close").click();

    // --- T4.2 删除引用报告（绑定后引用可查；此处只验证并取消）---
    await openCredentialDetail(page, leaseCredentialId!);
    await page.getByTestId("credentials-detail-delete").click();
    const referenceList = page.getByTestId("credentials-delete-references");
    await expect(referenceList).toBeVisible({ timeout: 20000 });
    await expect(referenceList).toContainText(principalId);
    await expect(referenceList).toContainText(secondPrincipalId);
    await page.screenshot({
        path: path.join(EVIDENCE_DIR, "s5-delete-references.png"),
        fullPage: true,
    });
    await page.getByTestId("credentials-delete-cancel").click();
    await page.getByTestId("credentials-detail-close").click();

    // --- T4.1 ④ 租约 use：manual ask → 审批 → 交付 ---
    const policyResponse = await request.put(
        `${CP_URL}/api/v1/config/workspace/approval-policy?workspaceId=${wsId}`,
        {
            headers: authHeaders,
            data: { mode: "manual", askActionClasses: JSON.stringify(["credential_use"]) },
        },
    );
    expect(policyResponse.status(), await policyResponse.text()).toBe(200);

    await ensureAgentWorkspaceBinding(wsId);
    await waitForControlPlaneAgentReady(request, {
        Authorization: `Bearer ${authToken}`,
        "X-Workspace-Id": wsId,
    });
    await page.goto("/workspace/" + wsId, { waitUntil: "load" });
    await expect(page.getByTestId("workspace-create-session")).toBeVisible({ timeout: 20000 });
    await createWorkspaceSessionWithPrincipal(page, principalId);
    await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 20000 });
    const modal = page.locator('[data-testid="modal-content"]');

    await sendChat(page, `XIHE-E2E-ACQUIRE ${leaseCredentialId}`);
    await expect(modal, "approval modal for acquire_credential").toBeVisible({ timeout: 120000 });
    await expect(modal).not.toContainText(leaseSecret);
    await modal.locator('[data-testid="approval-approve"]').click();
    await expect(modal).toBeHidden({ timeout: 20000 });
    await expect(page.locator("text=Acquired.").first()).toBeVisible({ timeout: 120000 });
    await awaitLatestChatRunCompleted(request, authHeaders, wsId);

    // --- T4.1 ⑤ UI reveal：错误密码内联 → 正确密码一次性展示 ---
    await page.goto("/settings/credentials", { waitUntil: "load" });
    await openCredentialDetail(page, revealCredentialId!);
    await page.getByTestId("credentials-detail-reveal").click();
    const revealDialog = page.getByTestId("credentials-reveal-dialog");
    await expect(revealDialog).toBeVisible();
    await revealDialog.getByTestId("credentials-reveal-password").fill("definitely-wrong-password");
    await revealDialog.getByTestId("credentials-reveal-submit").click();
    await expect(revealDialog.getByTestId("credentials-reveal-error")).toContainText("密码错误", {
        timeout: 20000,
    });
    await page.screenshot({ path: path.join(EVIDENCE_DIR, "s6-reveal-wrong-password.png") });
    await revealDialog.getByTestId("credentials-reveal-password").fill(password);
    await revealDialog.getByTestId("credentials-reveal-submit").click();
    await expect(revealDialog.getByTestId("credentials-reveal-value")).toContainText(revealSecret, {
        timeout: 20000,
    });
    await expect(revealDialog.getByTestId("credentials-reveal-countdown")).toBeVisible();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await revealDialog.getByTestId("credentials-reveal-copy").click();
    await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()), {
            timeout: 10000,
            message: "复制按钮必须把明文写入剪贴板",
        })
        .toContain(revealSecret);
    await page.screenshot({ path: path.join(EVIDENCE_DIR, "s7-reveal-value.png") });
    await revealDialog.getByTestId("credentials-reveal-close").click();
    await expect(revealDialog).toBeHidden();
    expect(await page.content(), "关闭 reveal 后页面不得再含明文").not.toContain(revealSecret);

    // --- T4.2 reveal 限流：连续错误密码 → 429 文案 ---
    await page.getByTestId("credentials-detail-reveal").click();
    await expect(revealDialog).toBeVisible();
    let rateLimited = false;
    for (let attempt = 0; attempt < 6 && !rateLimited; attempt += 1) {
        await revealDialog.getByTestId("credentials-reveal-password").fill(`wrong-${attempt}`);
        await revealDialog.getByTestId("credentials-reveal-submit").click();
        const error = revealDialog.getByTestId("credentials-reveal-error");
        await expect(error).toBeVisible({ timeout: 20000 });
        rateLimited = (await error.textContent())?.includes("过于频繁") ?? false;
    }
    expect(rateLimited, "5 次失败后必须进入限流态").toBe(true);
    await page.screenshot({ path: path.join(EVIDENCE_DIR, "s8-reveal-rate-limited.png") });
    await revealDialog.getByTestId("credentials-reveal-cancel").click();
    await page.getByTestId("credentials-detail-close").click();

    // --- T3.2 审计轨迹（lease 凭据：签发+兑换；无明文）---
    await openCredentialDetail(page, leaseCredentialId!);
    await page.getByTestId("credentials-tab-audit").click();
    const events = page.getByTestId("credential-audit-events");
    await expect(events).toContainText("租约签发", { timeout: 20000 });
    await expect(events).toContainText("租约兑换");
    await expect(events).not.toContainText(leaseSecret);
    await page.screenshot({ path: path.join(EVIDENCE_DIR, "s9-audit-trail.png"), fullPage: true });
    await page.getByTestId("credentials-detail-close").click();

    // --- V5 批量解绑：两个 principal 一次提交 → 已绑定标记消失 ---
    await openCredentialDetail(page, leaseCredentialId!);
    await page.getByTestId("credentials-tab-bindings").click();
    await page.getByTestId("credential-bind-workspace").selectOption(wsId);
    await expect(page.getByTestId(`credential-bind-agent-${principalId}`)).toBeVisible({
        timeout: 20000,
    });
    await page.getByTestId(`credential-bind-agent-${principalId}`).setChecked(true);
    await page.getByTestId(`credential-bind-agent-${secondPrincipalId}`).setChecked(true);
    await page.getByTestId("credential-bind-remove").click();
    await expect(
        page.locator(`[data-testid="credential-bind-bound"]`),
        "批量解绑后两个 principal 的标记均消失",
    ).toHaveCount(0, { timeout: 20000 });
    await page.getByTestId("credentials-detail-close").click();

    // --- I5 / V2：durable 面零明文（含 reveal 明文）---
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
        "durable message projection must not contain the lease value",
    ).not.toContain(leaseSecret);

    expect(tablesLeakingSecret(leaseSecret), "no durable table may carry the lease value").toEqual(
        [],
    );
    expect(
        tablesLeakingSecret(revealSecret),
        "no durable table may carry the reveal value",
    ).toEqual([]);

    // --- 租约语义：单次签发 + 单次兑换；reveal 留审计 ---
    expect(leaseRows(leaseCredentialId!), "1 issued / 1 redeemed").toBe("1/1");
    const leaseEvents = credentialEventTypes(leaseCredentialId!);
    expect(leaseEvents, "lease_issued recorded").toContain("lease_issued");
    expect(leaseEvents, "lease_redeemed recorded").toContain("lease_redeemed");
    expect(credentialEventTypes(revealCredentialId!), "reveal audited").toContain("revealed");

    // 视觉证据归档说明
    await testInfo.attach("evidence-dir", { body: EVIDENCE_DIR, contentType: "text/plain" });
});
