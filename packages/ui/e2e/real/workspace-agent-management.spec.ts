// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { isSessionCreateRequest } from "./helpers/agent-principal";
import { CP_URL, registerJourneyUser, seedPage } from "./helpers/journey";
import { ensureFakeUserProvider } from "./helpers/fake-provider";
import {
    replaceUserGrantPermissions,
    replaceWorkspaceRole,
    seedUserGrantPermissions,
} from "./helpers/user-grants";
import { LONG_TIMEOUT_MS } from "../timeouts";
import { chooseRekaOption } from "./helpers/reka-select";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEMPLATE_PROMPT = "Answer using only the scoped workspace material.";
const PROVIDER_SECRET_SENTINEL = "e2e-provider-secret-sentinel-0374";

test.describe.configure({ retries: 0 });

function queryIsolatedPostgres(sql: string): string {
    const container = process.env.XIHE_E2E_PG_CONTAINER,
        database = process.env.XIHE_E2E_PG_DATABASE;
    const user = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !user) {
        throw new Error(
            "isolated Postgres fixture metadata is unavailable; run through scripts/e2e-host.mjs",
        );
    }
    return execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        ["exec", container, "psql", "-X", "-A", "-t", "-U", user, "-d", database, "-c", sql],
        { encoding: "utf8", timeout: LONG_TIMEOUT_MS, windowsHide: true },
    ).trim();
}

function requireUuid(value: string): string {
    if (!UUID_PATTERN.test(value))
        throw new Error("Expected a UUID for an isolated database fixture");
    return value;
}

function scalarCount(sql: string): number {
    const value = queryIsolatedPostgres(sql);
    if (!/^\d+$/.test(value)) throw new Error(`Expected a scalar count, received: ${value}`);
    return Number(value);
}

test("@host V6 Workspace Agent management uses CP grants and persists isolated caps/audit", async ({
    page,
    request,
}, testInfo) => {
    const owner = await registerJourneyUser(request, "t44-agent-owner");
    const secondOwner = await registerJourneyUser(request, "t44-agent-second-owner");
    const ownerMeResponse = await request.get(`${CP_URL}/api/v1/auth/me`, {
        headers: owner.headers,
    });
    const secondMeResponse = await request.get(`${CP_URL}/api/v1/auth/me`, {
        headers: secondOwner.headers,
    });
    expect(ownerMeResponse.ok(), await ownerMeResponse.text()).toBe(true);
    expect(secondMeResponse.ok(), await secondMeResponse.text()).toBe(true);
    const ownerUserId = requireUuid(((await ownerMeResponse.json()) as { id: string }).id);
    const secondUserId = requireUuid(((await secondMeResponse.json()) as { id: string }).id);
    const workspaceA = requireUuid(owner.workspaceId),
        workspaceB = requireUuid(secondOwner.workspaceId);

    seedUserGrantPermissions(ownerUserId, [
        { actionClass: "CREATE_ACCOUNT", resource: "*" },
        { actionClass: "CREATE_TEMPLATE", resource: "*" },
        { actionClass: "read", resource: "*" },
        { actionClass: "write", resource: "*" },
        { actionClass: "MANAGE_WORKSPACE_AGENTS", resource: workspaceA },
    ]);
    seedUserGrantPermissions(secondUserId, [
        { actionClass: "MANAGE_WORKSPACE_AGENTS", resource: workspaceB },
    ]);

    // BL-343：本 spec 的 owner 用户此前**从未配置 provider connection / llm profile**，而
    // `POST /api/v1/sessions` 在解析不出可用 profile 时会 409 `LLM_PROFILE_CONFLICT`。
    // 用既有夹具补齐（`registerJourneyUser` 不做这一步，plan0670-* 系列都是显式补的）。
    // 实测依据（BL-346 探针）：**有** ready 连接 + **无** model intent ⇒ 开会话 201；
    // 无连接时才会 409/400 —— 所以阻塞点是连接/profile，不是 model intent。
    await ensureFakeUserProvider(request, {
        accessToken: owner.authToken,
        workspaceId: owner.workspaceId,
    });

    const pageErrors: string[] = [],
        apiRequestFailures: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (failedRequest) => {
        if (failedRequest.url().startsWith(CP_URL)) {
            apiRequestFailures.push(`${failedRequest.method()} ${failedRequest.url()}`);
        }
    });
    seedPage(page, owner);

    // PLAN-0752：`/settings/policy` 仍重定向，但落点从旧配置页改为实例层默认域页。
    await page.goto("/settings/policy", { waitUntil: "load" });
    await expect(page).toHaveURL(/\/settings\/instance\/llm-provider$/);
    await expect(page.locator('a[href="/settings/policy"]')).toHaveCount(0);
    await page.screenshot({
        scale: "css",
        path: testInfo.outputPath("settings-policy-deep-link-redirect.png"),
    });
    await page.goto("/settings/user/agent-templates", { waitUntil: "load" });
    const templatePanel = page.getByTestId("agent-templates-panel");
    await expect(templatePanel).toBeVisible();

    await page.getByTestId("agent-role-name").fill("Browser Reader");
    await page.getByTestId("agent-role-add-permission").click();
    // BL-547（task-175）：权限动作是 reka Select（触发器为 button），选项文本 = 动作类名本身。
    await chooseRekaOption(page, page.getByTestId("agent-role-action-0"), /^read$/);
    await page.getByTestId("agent-role-resource-0").fill("src/*");
    await page.getByTestId("agent-role-add-permission").click();
    await chooseRekaOption(page, page.getByTestId("agent-role-action-1"), /^write$/);
    await page.getByTestId("agent-role-resource-1").fill("*");
    const roleWritePromise = page.waitForResponse(
        (response) =>
            response.url().endsWith("/api/v1/config/user/agent-templates") &&
            response.request().method() === "PUT",
    );
    await page.getByTestId("agent-role-form").getByTestId("agent-role-save").click();
    expect((await roleWritePromise).status()).toBe(200);

    await page.getByTestId("agent-template-name").fill("Browser Workspace Reader");
    await page.getByTestId("agent-template-description").fill("Template created through Settings");
    await page.getByTestId("agent-template-prompt").fill(TEMPLATE_PROMPT);
    await chooseRekaOption(page, page.getByTestId("agent-template-tool-mode"), /^workspace$/);
    await chooseRekaOption(page, page.getByTestId("agent-template-role"), "Browser Reader");
    await page.getByTestId("agent-template-provider").fill("openai");
    await page.getByTestId("agent-template-model").fill("e2e-model");
    const templateWritePromise = page.waitForResponse(
        (response) =>
            response.url().endsWith("/api/v1/config/user/agent-templates") &&
            response.request().method() === "PUT",
    );
    await page.getByTestId("agent-template-form").getByTestId("agent-template-save").click();
    expect((await templateWritePromise).status()).toBe(200);

    const templatesResponse = await request.get(`${CP_URL}/api/v1/agent-templates?layer=user`, {
        headers: owner.headers,
    });
    expect(templatesResponse.status(), await templatesResponse.text()).toBe(200);
    const visibleTemplates = (await templatesResponse.json()) as {
        templates: Array<{ id: string; name: string; roleId?: string }>;
    };
    const visibleTemplatesJson = JSON.stringify(visibleTemplates);
    expect(visibleTemplatesJson).not.toContain(owner.authToken);
    expect(visibleTemplatesJson).not.toContain(PROVIDER_SECRET_SENTINEL);
    expect(visibleTemplatesJson).not.toMatch(/"(?:secret|token|apiKey|api_key|password)"/i);
    const selectedTemplate = visibleTemplates.templates.find(
        (template) => template.name === "Browser Workspace Reader",
    );
    expect(selectedTemplate).toBeDefined();
    const templateId = requireUuid(selectedTemplate!.id);
    await expect(templatePanel.getByTestId(`agent-template-${templateId}`)).toContainText(
        "Browser Workspace Reader",
    );
    await page.screenshot({
        scale: "css",
        path: testInfo.outputPath("agent-template-created-in-settings.png"),
    });

    await page.goto(`/workspace/${workspaceA}`, { waitUntil: "load" });

    await page.getByTestId("workspace-toolbar-agents").click();
    const dialog = page.getByTestId("workspace-agent-management-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("暂无活动会话")).toHaveCount(0);

    await page.getByTestId("agent-principal-name").fill("T44PersistentAgent");
    // BL-547（task-175）：模板选择器是 reka Select；选项文本 = "模板名 · 层"。
    await chooseRekaOption(
        page,
        page.getByTestId("agent-principal-template"),
        /Browser Workspace Reader · user/,
    );
    await expect(page.getByTestId("agent-principal-create-form")).toContainText(
        "Browser Workspace Reader",
    );
    await expect(page.getByTestId("agent-principal-create-form")).toContainText(
        selectedTemplate!.roleId!,
    );
    await expect(page.getByTestId("agent-principal-create-form")).toContainText("e2e-model");
    const createResponsePromise = page.waitForResponse(
        (response) =>
            response.url().endsWith("/api/v1/agent-principals") &&
            response.request().method() === "POST",
    );
    await page.getByTestId("agent-principal-create").click();
    const createResponse = await createResponsePromise;
    expect(createResponse.status()).toBe(201);
    const createdPrincipal = (await createResponse.json()) as {
        principalId: string;
        templateId?: string;
        templateName?: string;
    };
    expect(createdPrincipal.templateId).toBe(templateId);
    expect(createdPrincipal.templateName).toBe("Browser Workspace Reader");
    expect(JSON.stringify(createdPrincipal)).not.toContain(TEMPLATE_PROMPT);
    const principalId = requireUuid(createdPrincipal.principalId);
    await expect(page.getByTestId("unbound-agent-principal")).toContainText(principalId);
    await expect(page.getByTestId("unbound-agent-principal")).toContainText(
        "Browser Workspace Reader",
    );
    await expect(page.getByTestId("unbound-agent-principal")).toContainText(templateId);
    const principalSnapshotRaw = queryIsolatedPostgres(
        `SELECT template_snapshot::text FROM agent_principals WHERE id = '${principalId}'::uuid`,
    );
    const principalSnapshot = JSON.parse(principalSnapshotRaw) as Record<string, unknown>;
    expect(principalSnapshot).toMatchObject({
        templateId,
        templateName: "Browser Workspace Reader",
        roleName: "Browser Reader",
        systemPrompt: TEMPLATE_PROMPT,
        toolMode: "workspace",
        provider: "openai",
        model: "e2e-model",
        permissions: [
            { actionClass: "read", resource: "src/*" },
            { actionClass: "write", resource: "*" },
        ],
    });
    expect(Object.keys(principalSnapshot).some((key) => /secret|token|api.?key/i.test(key))).toBe(
        false,
    );

    await page.getByTestId("agent-cap-read").check();
    await page.getByTestId("agent-resource-read").fill("src/*");
    const bindResponsePromise = page.waitForResponse(
        (response) =>
            response.url().endsWith(`/api/v1/workspaces/${workspaceA}/agents/${principalId}`) &&
            response.request().method() === "PUT",
    );
    await page.getByTestId("agent-principal-bind").click();
    expect((await bindResponsePromise).status()).toBe(200);

    const bindingA = page.getByTestId(`workspace-agent-${principalId}`);
    await expect(bindingA).toContainText("读取");
    await expect(bindingA).toContainText("src/*");
    const refreshPromise = page.waitForResponse(
        (response) =>
            response.url().endsWith(`/api/v1/workspaces/${workspaceA}/agents`) &&
            response.request().method() === "GET",
    );
    await page.getByTestId("workspace-agent-refresh").click();
    expect((await refreshPromise).status()).toBe(200);
    await expect(bindingA).toContainText("src/*");

    const bindBResponse = await request.put(
        `${CP_URL}/api/v1/workspaces/${workspaceB}/agents/${principalId}`,
        {
            headers: secondOwner.headers,
            data: { permissions: [{ actionClass: "write", resource: "docs/*" }] },
        },
    );
    expect(bindBResponse.status(), await bindBResponse.text()).toBe(200);

    // BL-343：绑定期望账本的**基线点**必须移到绑定动作之后。PLAN-0651 D-174 起，主体绑定/加角色会
    // 通过 `RoleGrantMaterializer` materialize `source='role'` 的 grants 行（`GrantSources.ROLE`）——
    // 这是新语义，不是"改能力时偷偷发授权"。原先在创建后就取基线，导致 `role:` 行一出现就判红。
    // 守卫的原意（改能力不产生 grant 行）不变：基线之后只做 UI 能力编辑，再比对账本必须逐字相同。
    const principalGrantsBefore = queryIsolatedPostgres(
        `SELECT source || ':' || permissions::text FROM grants ` +
            `WHERE subject_type = 'agent_principal' AND subject_id = '${principalId}'::uuid ORDER BY source`,
    );

    await bindingA.getByTestId(`workspace-agent-edit-cap-${principalId}`).click();
    await page.getByTestId("agent-cap-write").check();
    await page.getByTestId("agent-resource-write").fill("reports/*");
    const capSavePromise = page.waitForResponse(
        (response) =>
            response.url().endsWith(`/api/v1/workspaces/${workspaceA}/agents/${principalId}`) &&
            response.request().method() === "PUT",
    );
    await bindingA.getByTestId(`workspace-agent-save-cap-${principalId}`).click();
    expect((await capSavePromise).status()).toBe(200);
    await expect(bindingA).toContainText("reports/*");
    await page.screenshot({
        scale: "css",
        path: testInfo.outputPath("workspace-agent-cap-persisted.png"),
    });

    await page.getByTestId("workspace-agent-refresh").click();
    await expect(bindingA).toContainText("reports/*");
    const bindingBResponse = await request.get(`${CP_URL}/api/v1/workspaces/${workspaceB}/agents`, {
        headers: secondOwner.headers,
    });
    expect(bindingBResponse.status()).toBe(200);
    // BL-343：`GET /api/v1/workspaces/{id}/agents` 自 PLAN-0622 M1.2（`474c2153`）起返回**冻结封套**
    // `{agents:[…]}`（此前是裸数组）。按封套解析，不做"数组/封套都兼容"的宽松解析——宽松解析会让
    // 下次契约再变时又静默通过。
    const bindingBEnvelope = (await bindingBResponse.json()) as {
        agents: Array<{
            principalId: string;
            // 封套内成员的权限字段是 **`permissionsSnapshot`**（CP `WorkspaceAgentView` 的对外投影名，
            // 见 `AgentPrincipalService.listWorkspaceAgents`）。旧 spec 读的是 `permissions`——那是
            // **绑定请求体**的字段名，与列表响应体不同名，所以 `.permissions` 永远是 undefined。
            permissionsSnapshot: Array<{ actionClass: string; resource?: string }>;
        }>;
    };
    expect(Array.isArray(bindingBEnvelope.agents), "响应应为 {agents:[…]} 封套").toBe(true);
    const bindingB = bindingBEnvelope.agents.find((binding) => binding.principalId === principalId);
    expect(bindingB?.permissionsSnapshot).toEqual([{ actionClass: "write", resource: "docs/*" }]);
    const principalGrantsAfter = queryIsolatedPostgres(
        `SELECT source || ':' || permissions::text FROM grants ` +
            `WHERE subject_type = 'agent_principal' AND subject_id = '${principalId}'::uuid ORDER BY source`,
    );
    expect(principalGrantsAfter).toBe(principalGrantsBefore);

    await page.reload({ waitUntil: "load" });
    await page.getByTestId("workspace-toolbar-agents").click();
    const reloadedBinding = page.getByTestId(`workspace-agent-${principalId}`);
    await expect(reloadedBinding).toContainText("reports/*");

    // BL-343：这里曾经稳定红，真因是**夹具缺 provider 连接/profile**（不是产品缺陷，也不是 model intent）：
    // `registerJourneyUser` 只建用户与 workspace，不建 `provider-connections`，而 `POST /sessions`
    // 在解析不出可用 profile 时必 409 `LLM_PROFILE_CONFLICT`。实测（BL-346 探针，2026-11-06）：
    //   · 无连接 + 无 model intent ⇒ 409 LLM_PROFILE_CONFLICT
    //   · 无连接 + 有 model intent ⇒ 400 PROVIDER_REQUIRED（说明"有 intent"只是换了一道门）
    //   · **有** ready 连接 + **无** model intent ⇒ **201**（profile 从 user llm-provider 解析成功）
    // ⇒ 在测试前置里补 `ensureFakeUserProvider` 即可（见本 spec 开头），断言保持严格不变。
    const historicalSessionResponse = await request.post(`${CP_URL}/api/v1/sessions`, {
        headers: owner.headers,
        data: { title: "History before unbind", agentPrincipalId: principalId },
    });
    expect(historicalSessionResponse.status(), await historicalSessionResponse.text()).toBe(201);
    const historicalSession = (await historicalSessionResponse.json()) as { id: string };
    const historicalSessionId = requireUuid(historicalSession.id);

    const unbindButton = page.getByTestId(`workspace-agent-unbind-${principalId}`);
    await unbindButton.click();
    await expect(unbindButton).toContainText("再次点击确认解绑");
    const deleteResponsePromise = page.waitForResponse(
        (response) =>
            response.url().endsWith(`/api/v1/workspaces/${workspaceA}/agents/${principalId}`) &&
            response.request().method() === "DELETE",
    );
    await unbindButton.click();
    expect((await deleteResponsePromise).status()).toBe(204);
    // BL-343：DEV-032 正名（`1fe40636` "agent → 智能体" zh sweep）后文案变了，旧断言停在历史文案上。
    // 这里按**当前** i18n 文案断言（`i18n/index.ts` `noBoundAgent: "此工作区尚未绑定智能体"`），
    // 不做"两种文案都接受"的宽松匹配——文案再变就该再改，而不是让断言静默通过。
    // 作用域限定在**代理管理面板**内：同屏还有「诊断提示元素」与 toast 两处相同文案（UX 冗余、
    // 非缺陷），不收窄会触发 Playwright strict-mode（3 个命中）。不用 `.first()`——那是掩盖 strict 问题。
    const agentPanel = page.getByTestId("workspace-agent-management-dialog");
    await expect(agentPanel.getByText("此工作区尚未绑定智能体")).toBeVisible();

    expect(
        scalarCount(
            `SELECT count(*) FROM workspace_agents WHERE principal_id = '${principalId}'::uuid AND workspace_id = '${workspaceA}'::uuid`,
        ),
    ).toBe(0);
    expect(
        scalarCount(
            `SELECT count(*) FROM workspace_agents WHERE principal_id = '${principalId}'::uuid AND workspace_id = '${workspaceB}'::uuid`,
        ),
    ).toBe(1);
    expect(
        scalarCount(
            `SELECT count(*) FROM audit_logs WHERE action = 'agent_principal_created' AND user_id = '${ownerUserId}'::uuid AND resource_id = '${principalId}'`,
        ),
    ).toBe(1);
    const principalAudit = JSON.parse(
        queryIsolatedPostgres(
            `SELECT details::text FROM audit_logs WHERE action = 'agent_principal_created' ` +
                `AND user_id = '${ownerUserId}'::uuid AND resource_id = '${principalId}'`,
        ),
    ) as Record<string, unknown>;
    // BL-343：D-174（`51d3fa95`）"create 单 workspace 授权路径"之后，创建主体命中的原子是
    // `MANAGE_WORKSPACE_AGENTS`（审计记录的是**实际授权原子**），不再是旧的 `CREATE_ACCOUNT`。
    expect(principalAudit).toMatchObject({
        authorizationAction: "MANAGE_WORKSPACE_AGENTS",
        templateId,
        permissions: [{ actionClass: "read", resource: "src/*" }, { actionClass: "write" }],
    });
    expect(JSON.stringify(principalAudit)).not.toContain(TEMPLATE_PROMPT);
    expect(JSON.stringify(principalAudit)).not.toContain(PROVIDER_SECRET_SENTINEL);
    const templateAudit = queryIsolatedPostgres(
        `SELECT details::text FROM audit_logs WHERE action = 'agent_template_created' ` +
            `AND user_id = '${ownerUserId}'::uuid AND resource_id = '${templateId}'`,
    );
    expect(
        scalarCount(
            `SELECT count(*) FROM audit_logs WHERE action = 'agent_template_created' ` +
                `AND user_id = '${ownerUserId}'::uuid AND resource_id = '${templateId}'`,
        ),
    ).toBe(1);
    const templateAuditDetails = JSON.parse(templateAudit) as Record<string, unknown>;
    expect(templateAuditDetails).toMatchObject({
        authorizationAction: "CREATE_TEMPLATE",
        layer: "user",
        changedKeys: ["templates"],
        templateId,
        roleId: selectedTemplate!.roleId,
        permissionDiff: [
            { actionClass: "read", resource: "src/*" },
            { actionClass: "write", resource: "*" },
        ],
    });
    expect(templateAudit).not.toContain(TEMPLATE_PROMPT);
    const templateConfigAudit = queryIsolatedPostgres(
        `SELECT new_value FROM config_audit WHERE layer = 'user' AND domain = 'agent-templates' ` +
            `AND config_key = 'templates' ORDER BY changed_at DESC LIMIT 1`,
    );
    expect(templateConfigAudit).toMatch(/^present:/);
    expect(templateConfigAudit).not.toContain(TEMPLATE_PROMPT);
    expect(
        scalarCount(
            `SELECT count(*) FROM audit_logs WHERE action = 'workspace_agent_bound' AND user_id = '${ownerUserId}'::uuid AND workspace_id = '${workspaceA}'::uuid AND resource_id = '${principalId}'`,
        ),
    ).toBe(1);
    expect(
        scalarCount(
            `SELECT count(*) FROM audit_logs WHERE action = 'workspace_agent_cap_updated' AND user_id = '${ownerUserId}'::uuid AND workspace_id = '${workspaceA}'::uuid AND resource_id = '${principalId}'`,
        ),
    ).toBe(1);
    expect(
        scalarCount(
            `SELECT count(*) FROM audit_logs WHERE action = 'workspace_agent_unbound' AND user_id = '${ownerUserId}'::uuid AND workspace_id = '${workspaceA}'::uuid AND resource_id = '${principalId}'`,
        ),
    ).toBe(1);
    const bindAudit = JSON.parse(
        queryIsolatedPostgres(
            `SELECT details::text FROM audit_logs WHERE action = 'workspace_agent_bound' ` +
                `AND user_id = '${ownerUserId}'::uuid AND workspace_id = '${workspaceA}'::uuid ` +
                `AND resource_id = '${principalId}'`,
        ),
    ) as Record<string, unknown>;
    expect(bindAudit).toMatchObject({
        authorizationAction: "MANAGE_WORKSPACE_AGENTS",
        principalId,
        permissionsBefore: [],
        permissionsAfter: [{ actionClass: "read", resource: "src/*" }],
    });
    const capUpdateAudit = JSON.parse(
        queryIsolatedPostgres(
            `SELECT details::text FROM audit_logs WHERE action = 'workspace_agent_cap_updated' ` +
                `AND user_id = '${ownerUserId}'::uuid AND workspace_id = '${workspaceA}'::uuid ` +
                `AND resource_id = '${principalId}'`,
        ),
    ) as Record<string, unknown>;
    expect(capUpdateAudit).toMatchObject({
        authorizationAction: "MANAGE_WORKSPACE_AGENTS",
        principalId,
        permissionsBefore: [{ actionClass: "read", resource: "src/*" }],
        permissionsAfter: [
            { actionClass: "read", resource: "src/*" },
            { actionClass: "write", resource: "reports/*" },
        ],
    });
    const unbindAudit = JSON.parse(
        queryIsolatedPostgres(
            `SELECT details::text FROM audit_logs WHERE action = 'workspace_agent_unbound' ` +
                `AND user_id = '${ownerUserId}'::uuid AND workspace_id = '${workspaceA}'::uuid ` +
                `AND resource_id = '${principalId}'`,
        ),
    ) as Record<string, unknown>;
    expect(unbindAudit).toMatchObject({
        authorizationAction: "MANAGE_WORKSPACE_AGENTS",
        principalId,
        permissionsBefore: [
            { actionClass: "read", resource: "src/*" },
            { actionClass: "write", resource: "reports/*" },
        ],
    });
    expect(unbindAudit).not.toHaveProperty("permissionsAfter");

    // BL-343：`workspace-agent-management-dialog` 已**不是弹窗**——`WorkspaceAgentsPanel.vue:980`
    // 的注释写明「relocation. It is now the panel body, not a modal」，所以旧 spec 那套
    // `modal-content` + `Close` 按钮 + 关闭后计数为 0 的路径已不存在。改按当前结构：离开该路由后
    // 面板随之消失，并仍**严格**断言它已不在（不是把断言删掉，只是换到正确的时机）。
    await page.goto("/settings/user/agent-templates", { waitUntil: "load" });
    await expect(page.getByTestId("workspace-agent-management-dialog")).toHaveCount(0);
    const deleteTemplateButton = page.getByTestId(`agent-template-delete-${templateId}`);
    await deleteTemplateButton.click();
    await expect(deleteTemplateButton).toContainText("再次点击确认删除");
    const deleteTemplateWritePromise = page.waitForResponse(
        (response) =>
            response.url().endsWith("/api/v1/config/user/agent-templates") &&
            response.request().method() === "PUT",
    );
    await deleteTemplateButton.click();
    expect((await deleteTemplateWritePromise).status()).toBe(200);
    await expect(page.getByTestId(`agent-template-${templateId}`)).toHaveCount(0);
    const snapshotAfterTemplateDelete = JSON.parse(
        queryIsolatedPostgres(
            `SELECT template_snapshot::text FROM agent_principals WHERE id = '${principalId}'::uuid`,
        ),
    ) as Record<string, unknown>;
    expect(snapshotAfterTemplateDelete).toEqual(principalSnapshot);

    const e2eRunId = process.env.XIHE_E2E_RUN_ID;
    if (!e2eRunId) throw new Error("XIHE_E2E_RUN_ID is required for isolated log scanning");
    // BL-547（task-175）：runner 进程内重试会把 host root 改名为 <runId>-rN，原路径在重试轮
    // 直接 ENOENT。按基名匹配该 run 的全部轮次目录，每一轮的日志都扫（不削弱断言）。
    const runBase = e2eRunId.replace(/-r\d+$/, "");
    const hostRoot = resolve(process.cwd(), "../../.tmp/e2e-host");
    const logDirs = readdirSync(hostRoot)
        .filter(
            (d) =>
                d === e2eRunId ||
                (d.startsWith(runBase) && /^-r\d+$/.test(d.slice(runBase.length))),
        )
        .map((d) => resolve(hostRoot, d, "logs"))
        .filter((d) => existsSync(d));
    expect(logDirs.length, `no log dirs for run ${e2eRunId} under ${hostRoot}`).toBeGreaterThan(0);
    const logFiles = logDirs.flatMap((d) =>
        readdirSync(d)
            .filter((file) => file.endsWith(".log"))
            .map((file) => resolve(d, file)),
    );
    expect(logFiles.length).toBeGreaterThan(0);
    for (const file of logFiles) {
        const content = readFileSync(file, "utf8");
        expect(content, `${file} leaked a template prompt`).not.toContain(TEMPLATE_PROMPT);
        expect(content, `${file} leaked an owner token`).not.toContain(owner.authToken);
        expect(content, `${file} leaked a second-owner token`).not.toContain(secondOwner.authToken);
        expect(content, `${file} leaked a provider secret`).not.toContain(PROVIDER_SECRET_SENTINEL);
    }

    const attemptedSessionPosts: string[] = [];
    page.on("request", (outgoingRequest) => {
        if (isSessionCreateRequest(outgoingRequest.url(), outgoingRequest.method())) {
            attemptedSessionPosts.push(outgoingRequest.url());
        }
    });
    const emptyBindingReload = page.waitForResponse(
        (response) =>
            response.url().endsWith(`/api/v1/workspaces/${workspaceA}/agents`) &&
            response.request().method() === "GET",
    );
    await page.goto(`/workspace/${workspaceA}?newChat=1`, { waitUntil: "load" });
    expect((await emptyBindingReload).status()).toBe(200);
    // BL-343：DEV-032 正名后文案为「此工作区尚未绑定智能体」。此处页面是聊天视图（`?newChat=1`），
    // 该状态由**官方诊断提示元素** `workspace-agent-unavailable-hint` 承载（`WorkspaceView.vue:492`）——
    // 用 testid 断言比中文文案稳（文案改动不该让本断言失效），也不用 `.first()` 掩盖 strict 冲突。
    await expect(page.getByTestId("workspace-agent-unavailable-hint")).toContainText(
        "此工作区尚未绑定智能体",
    );
    expect(attemptedSessionPosts).toEqual([]);

    const unboundSessionAttempt = await request.post(`${CP_URL}/api/v1/sessions`, {
        headers: owner.headers,
        data: { title: "Must stay uncreated", agentPrincipalId: principalId },
    });
    expect(unboundSessionAttempt.status()).toBe(403);
    // History kept, no new Session: exactly the pre-unbind row survives.
    // PLAN-0689 A7 / V133：`sessions.agent_principal_id` 已被删除（V133:18 `DROP COLUMN`），会话
    // 身份改由 PRIMARY 参与者行承载 —— CP 的唯一读入口是
    // `SessionParticipantRepository.primaryPrincipalId` → `SessionViews.toView`，所以这里必须查同一张表，
    // 否则这条 case 会在 host lane 上抛 `column "agent_principal_id" does not exist`。
    // 计数仍等价于"会话数"：`uq_session_participants_primary`（V92:95-96）保证每个会话最多一行 PRIMARY，
    // `uq_session_participants_principal`（V92:90-91）保证每个 (session, principal) 最多一行。
    // 不额外过滤 `disabled_at`：view 侧的 PRIMARY 读路径同样不过滤，两处必须同口径（解绑只删
    // `workspace_agents` 绑定，不动 `session_participants`，历史行本来就该留着）。
    expect(
        scalarCount(
            `SELECT count(*) FROM session_participants ` +
                `WHERE principal_kind = 'AGENT' AND principal_id = '${principalId}'::uuid ` +
                `AND role = 'PRIMARY'`,
        ),
    ).toBe(1);
    const preservedHistory = await request.get(`${CP_URL}/api/v1/sessions/${historicalSessionId}`, {
        headers: owner.headers,
    });
    expect(preservedHistory.status()).toBe(200);
    expect(((await preservedHistory.json()) as { agentPrincipalId: string }).agentPrincipalId).toBe(
        principalId,
    );

    // ── PLAN-0610 W6/T6.1（2026-11-06 BL-343 校正）─────────────────────────────────────────────
    // create 与 bind 是**两个独立原子**，但方向与旧用例相反：
    //   · 建 agent principal 需要 **`MANAGE_WORKSPACE_AGENTS`（workspace 作用域、必须是具体 UUID）**；
    //     `AgentPrincipalService.requireCreationAction()` 注释写明这是 "the original default creation
    //     authorization"，即原始设计，不是后来收紧。
    //   · **实例级 `CREATE_ACCOUNT` 只接受 `resource:"*"`**（`PrincipalGrantActionCatalog`），管的是
    //     「建账号（用户）」，**不构成建工作区 agent 的授权**。
    // 旧用例假设「有 CREATE_ACCOUNT 就能建（201）、只是绑不了」，方向正好相反，故改写为**反向隔离**：
    //   ①④ 实例 CREATE_ACCOUNT + 工作区仅 WS_EDITOR ⇒ 建 = **403**，且错误指向 MANAGE_WORKSPACE_AGENTS；
    //   ②  工作区恢复 WS_OWNER（携带 MANAGE_WORKSPACE_AGENTS@该 ws）⇒ 建 = **201**；
    //   ③  保留「能建 ≠ 能绑」整组断言：用 ② 建出的主体，降级回 WS_EDITOR 后再绑 ⇒ 403 + 未绑定行仍在。
    // 注意：工作区角色只有 WS_OWNER / WS_EDITOR / WS_VIEWER，没有 WS_ADMIN（SystemAccessRoleCatalog）。
    replaceUserGrantPermissions(ownerUserId, [{ actionClass: "CREATE_ACCOUNT", resource: "*" }]);

    // ①/④ 实例级 CREATE_ACCOUNT 不足以建工作区 agent：WS_EDITOR 无 MANAGE_WORKSPACE_AGENTS ⇒ 403
    replaceWorkspaceRole(ownerUserId, workspaceA, "WS_EDITOR");
    await page.getByTestId("workspace-toolbar-agents").click();
    await page.getByTestId("agent-principal-name").fill("EditorWithCreateAccountCannotCreate");
    const deniedCreatePromise = page.waitForResponse(
        (response) =>
            response.url().endsWith("/api/v1/agent-principals") &&
            response.request().method() === "POST",
    );
    await page.getByTestId("agent-principal-create").click();
    const deniedCreateResponse = await deniedCreatePromise;
    expect(deniedCreateResponse.status()).toBe(403);
    expect(await deniedCreateResponse.text()).toContain("MANAGE_WORKSPACE_AGENTS");
    // 该主体确实没被建出来（错误不是"建了但没绑"）
    expect(
        scalarCount(
            `SELECT count(*) FROM agent_principals WHERE name = 'EditorWithCreateAccountCannotCreate'`,
        ),
    ).toBe(0);

    // ② 恢复工作区管理权（WS_OWNER 携带 MANAGE_WORKSPACE_AGENTS@workspaceA）⇒ 建 = 201
    replaceWorkspaceRole(ownerUserId, workspaceA, "WS_OWNER");
    await page.goto(`/workspace/${workspaceA}`, { waitUntil: "load" });
    await page.getByTestId("workspace-toolbar-agents").click();
    await page.getByTestId("agent-principal-name").fill("CreatedButNotBindable");
    const createOnlyResponsePromise = page.waitForResponse(
        (response) =>
            response.url().endsWith("/api/v1/agent-principals") &&
            response.request().method() === "POST",
    );
    await page.getByTestId("agent-principal-create").click();
    const createOnlyResponse = await createOnlyResponsePromise;
    expect(createOnlyResponse.status()).toBe(201);
    const unboundOnly = (await createOnlyResponse.json()) as { principalId: string };
    const unboundOnlyId = requireUuid(unboundOnly.principalId);

    // ③ 能建 ≠ 能绑：降级回 WS_EDITOR 后再绑同一主体 ⇒ 403（绑定需要一次独立的原子授权）
    // 注：WS_EDITOR 在 UI 上不渲染「未绑定主体」的操作面（能力位驱动的只读态），所以这一步走 API
    // 打绑定接口——断言的对象是**授权门**（403 + 指向 MANAGE_WORKSPACE_AGENTS），不是渲染细节。
    replaceWorkspaceRole(ownerUserId, workspaceA, "WS_EDITOR");
    const bindDeniedResponse = await request.put(
        `${CP_URL}/api/v1/workspaces/${workspaceA}/agents/${unboundOnlyId}`,
        {
            headers: owner.headers,
            data: { permissions: [{ actionClass: "read", resource: "src/*" }] },
        },
    );
    expect(bindDeniedResponse.status()).toBe(403);
    expect(await bindDeniedResponse.text()).toContain("MANAGE_WORKSPACE_AGENTS");
    expect(
        scalarCount(
            `SELECT count(*) FROM workspace_agents WHERE principal_id = '${unboundOnlyId}'::uuid`,
        ),
    ).toBe(0);
    expect(
        scalarCount(
            `SELECT count(*) FROM audit_logs WHERE action = 'agent_principal_created' AND user_id = '${ownerUserId}'::uuid AND resource_id = '${unboundOnlyId}'`,
        ),
    ).toBe(1);
    expect(
        scalarCount(
            `SELECT count(*) FROM audit_logs WHERE action LIKE 'workspace_agent\\_%' ESCAPE '\\' ` +
                `AND user_id = '${ownerUserId}'::uuid AND resource_id = '${unboundOnlyId}'`,
        ),
    ).toBe(0);

    // Restore the owner binding; the page must still be usable afterwards.
    replaceWorkspaceRole(ownerUserId, workspaceA, "WS_OWNER");

    expect(pageErrors).toEqual([]);
    expect(apiRequestFailures).toEqual([]);
    await page.screenshot({
        scale: "css",
        path: testInfo.outputPath("workspace-agent-unbound.png"),
    });
});
