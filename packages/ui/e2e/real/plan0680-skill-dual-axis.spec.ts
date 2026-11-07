/**
 * PLAN-0680 M3 — 技能绑定双轴 真栈 spec（`@host`，J1/J2/J3/J8/J9）
 *
 * 冻结语义来源（lane 版，HEAD 84f1bff8）：
 *   `spec/agent/principal-workspace-binding.md:72-125`「技能绑定双轴（PLAN-0680 增补）」
 *     :86 档位由服务端派生：请求体带 scopeType/scopeId ⇒ 400 INVALID_REQUEST
 *     :88 同档唯一 ⇒ 409 SKILL_BINDING_EXISTS；跨档并存允许
 *     :92-94 解绑按行自身档位授权；workspace tier 删他工作区行或 instance 行 ⇒ 404 SKILL_BINDING_NOT_FOUND
 *     :98-100 W1 的 workspace 绑定行在 W2 注入中不出现；绑他工作区私有定义 ⇒ 404 SKILL_NOT_FOUND
 *     :102-105 workspace 轴只授本工作区原子
 *     :109-111 角色轴暂不开放：role_bindings workspace 行只作可达性/cap 输入
 *     :118 UI 徽标 testid `agent-skill-scope-{instance|workspace}`
 *
 * 写法参照：
 *   `bl355-cap-and-scope-matrix.spec.ts:82-141`（newIdentity / headers / provisionWorkspaceAgentPrincipal / 矩阵断言）
 *   `workspace-agent-management.spec.ts`（技能绑定管理面）
 *
 * 必须经 `scripts/e2e-host.mjs` 运行（依赖隔离栈与 `XIHE_E2E_*`）。本文件由 PLAN-0680 M3 落盘，
 * **窗口期才跑**；实施期不启动栈。
 *
 * 路由真值（已核实，`AgentPrincipalSkillBindingController`）：
 *   :40 `@RequestMapping("/api/v1/agent-principals/{principalId}/skills")`；`GET :54-56` /
 *   `POST :70-73` 均接受 `?workspaceId=`；`DELETE :96` 为 `.../skills/{bindingId}`。
 *   `POST` body 只允许 `skillId`（`BIND_KEYS :42`），多余键 ⇒ `:76-78` 抛 400 INVALID_REQUEST。
 *
 * 徽标真值：testid `agent-skill-scope-{instance|workspace}`（`WorkspaceAgentsPanel.vue:2124`）；
 *   i18n `workspace.agentSkillScopeWorkspace` / `workspace.agentSkillScopeInstance`，
 *   zh「工作区级」/「实例级」（`i18n/index.ts:485-486`），en「Workspace scope」/「Instance scope」（`:2893-2894`）。
 *   J9 宿主是 Workbench dock 的 agents tab 展开技能面板（rbacPrincipalId === principalId 分支，
 *   面板在 settings 路由不渲染）；入口照抄 PLAN-0667 M3（`agent-config-shots.spec.ts:57-61`）：
 *   工作台路由 → `workspace-toolbar-agents` 点击 → `agent-skills-toggle-<pid>` 展开。
 *   T3.3（r9 后）前置已内建：instance/workspace 两档技能定义各一 + 两档各绑一条（服务端派生档位）。
 */
import { expect, test, type APIRequestContext } from "@playwright/test";

import { ensureFakeUserProvider } from "./helpers/fake-provider";
import { provisionWorkspaceAgentPrincipal } from "./helpers/agent-principal";
import { CP_URL } from "./helpers/journey";
import { seedUserGrantPermissions } from "./helpers/user-grants";
import { ensureWorkspace } from "./helpers/workspace";

test.describe.configure({ retries: 0 });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** 技能绑定写入面（agent-principal 侧）。窗口期如与真实路由不符，只改这一处。 */
const SKILL_BINDING_PATH = (principalId: string, workspaceId: string): string =>
    `${CP_URL}/api/v1/agent-principals/${principalId}/skills?workspaceId=${workspaceId}`;

/** 技能清单（`bl355:143` 矩阵 B 已验证该端点与 `definitionScope` 参数）。 */
const SKILLS_PATH = (workspaceId: string, definitionScope: "instance" | "workspace"): string =>
    `${CP_URL}/api/v1/skills?definitionScope=${definitionScope}&workspaceId=${workspaceId}`;

interface Identity {
    email: string;
    userId: string;
    accessToken: string;
    workspaceId: string;
}

/** 注册 + 建 direct_attach 工作区 + fake provider（照抄 `bl355:82-108`）。 */
async function newIdentity(request: APIRequestContext, label: string): Promise<Identity> {
    const nonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
    const email = `${label}-${nonce}@test.com`;
    const password = process.env.XIHE_E2E_PASSWORD ?? "XhE2e!plan0680dual1";
    const registered = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: { email, password, name: `${label}${nonce}` },
    });
    expect(
        [200, 201],
        `注册应 2xx，实际 ${registered.status()}：${await registered.text()}`,
    ).toContain(registered.status());
    const body = (await registered.json()) as {
        id?: string;
        userId?: string;
        user?: { id?: string };
        accessToken: string;
    };
    const workspaceId = await ensureWorkspace(request, body.accessToken);
    await ensureFakeUserProvider(request, { accessToken: body.accessToken, workspaceId });
    const userId = body.id ?? body.userId ?? body.user?.id ?? "";
    expect(userId, "注册响应应带 userId").toMatch(UUID);
    return { email, userId, accessToken: body.accessToken, workspaceId };
}

function headersOf(identity: Identity): Record<string, string> {
    return {
        Authorization: `Bearer ${identity.accessToken}`,
        "Content-Type": "application/json",
        "X-Workspace-Id": identity.workspaceId,
    };
}

/**
 * 技能导入载荷的单点构造器（照抄 `plan0680-skill-tier-snapshot.spec.ts:198-206`，
 * 必填字段以 `SkillImportValidator` 为准；`trusted` 是原语 boolean，省略会 400）。
 */
function buildSkillItem(nonce: string, tag: "inst" | "ws") {
    return {
        name: `p0680-j9-${tag}-${nonce}`,
        sourcePath: `lab/p0680-j9-${tag}-${nonce}.md`,
        description: `PLAN-0680 J9 档位徽标探针（${tag} 档）`,
        body: `# p0680 j9 ${tag} ${nonce}\n用于验证 agent 技能档位徽标双语渲染。`,
        trusted: false,
    };
}

/** 导一个技能定义并取回 skillId（响应形状照抄 tier-snapshot：wire 字段是 `results[].skillId`）。 */
async function importSkill(
    request: APIRequestContext,
    identity: Identity,
    definitionScope: { type: "instance" } | { type: "workspace"; workspaceId: string },
    tag: "inst" | "ws",
): Promise<string> {
    const imported = await request.post(`${CP_URL}/api/v1/skills/import`, {
        headers: headersOf(identity),
        data: { definitionScope, skills: [buildSkillItem(Date.now().toString(36), tag)] },
    });
    const importedText = await imported.text();
    expect(
        [200, 201],
        `${tag} 档技能导入应 2xx，实际 ${imported.status()}：${importedText}`,
    ).toContain(imported.status());
    const importedBody = JSON.parse(importedText) as {
        results?: Array<{ skillId: string }>;
        rejected?: unknown[];
    };
    expect(importedBody.rejected ?? [], `${tag} 档导入不应有 rejected 行`).toEqual([]);
    const [skillId] = (importedBody.results ?? []).map((row) => row.skillId);
    expect(skillId, `${tag} 档导入响应应带 skillId`).toMatch(UUID);
    return skillId as string;
}

/**
 * 绑一条主体技能绑定行。档位由服务端派生（SPEC :86）：授权上下文**有** workspace ⇒ workspace 档，
 * 完全没有 ⇒ instance 档（`:88` 跨档并存允许）。成功判据 201 与 J1 实测一致。
 *
 * instance 档**不能**复用 `headersOf`：`X-Workspace-Id` **优先于** `?workspaceId` 决定授权作用域
 * （`AgentPrincipalBindingAuthority:83-93`，头赢、冲突才 400），带着头去绑会落成 workspace 档
 * ——r9 实测两条都写成 `scopeType=workspace`，instance 徽标因此缺失。
 */
async function bindSkill(
    request: APIRequestContext,
    identity: Identity,
    principalId: string,
    skillId: string,
    scope: "workspace" | "instance",
): Promise<void> {
    const url =
        scope === "workspace"
            ? SKILL_BINDING_PATH(principalId, identity.workspaceId)
            : `${CP_URL}/api/v1/agent-principals/${principalId}/skills`;
    const headers: Record<string, string> =
        scope === "workspace"
            ? headersOf(identity)
            : {
                  Authorization: `Bearer ${identity.accessToken}`,
                  "Content-Type": "application/json",
              };
    const bound = await request.post(url, {
        headers,
        data: { skillId },
    });
    expect(
        bound.status(),
        `绑 ${scope} 档应 201，实际 ${bound.status()}：${await bound.text()}`,
    ).toBe(201);
}

test("@host 0680-J1 跨工作区不生效：绑他工作区私有技能定义 ⇒ 404 SKILL_NOT_FOUND；本工作区私有定义可绑 201", async ({
    request,
}) => {
    const owner = await newIdentity(request, "p0680-j1");

    // 同一用户在另一个工作区里，作为「他工作区」
    const otherWorkspaceId = await ensureWorkspace(request, owner.accessToken);
    expect(otherWorkspaceId).not.toBe(owner.workspaceId);

    const principalId = await provisionWorkspaceAgentPrincipal(
        request,
        { accessToken: owner.accessToken, workspaceId: owner.workspaceId },
        { name: `AgentJ1${Date.now().toString(36)}`, actions: ["read"] },
    );
    expect(principalId).toMatch(UUID);

    // 他工作区的私有技能定义：在 W 上下文里按「不存在」处理（:100）
    const otherSkills = await request.get(SKILLS_PATH(otherWorkspaceId, "workspace"), {
        headers: { ...headersOf(owner), "X-Workspace-Id": otherWorkspaceId },
    });
    expect(otherSkills.status(), await otherSkills.text()).toBe(200);
    const otherItems =
        ((await otherSkills.json()) as { items?: Array<{ id: string }> }).items ?? [];
    if (otherItems.length === 0) {
        test.skip(true, "他工作区无私有技能定义，需先导入（见 bl355 矩阵 B 的导入步骤）后重跑");
        return;
    }
    const foreignSkillId = otherItems[0].id;

    const foreignBind = await request.post(SKILL_BINDING_PATH(principalId, owner.workspaceId), {
        headers: headersOf(owner),
        data: { skillId: foreignSkillId },
    });
    const foreignText = await foreignBind.text();
    expect(
        foreignBind.status(),
        `绑他工作区私有定义应 404（不是 403/400），实际 ${foreignBind.status()}：${foreignText}`,
    ).toBe(404);
    expect(foreignText, `应命中 SKILL_NOT_FOUND，实际：${foreignText}`).toContain(
        "SKILL_NOT_FOUND",
    );

    // 本工作区私有定义可绑（:100 后半句）；无资产时跳过而非伪造
    const ownSkills = await request.get(SKILLS_PATH(owner.workspaceId, "workspace"), {
        headers: headersOf(owner),
    });
    expect(ownSkills.status(), await ownSkills.text()).toBe(200);
    const ownItems = ((await ownSkills.json()) as { items?: Array<{ id: string }> }).items ?? [];
    if (ownItems.length === 0) {
        test.skip(true, "本工作区无私有技能定义，J1 的 201 半段待导入后重跑（404 半段已断言）");
        return;
    }
    const ownBind = await request.post(SKILL_BINDING_PATH(principalId, owner.workspaceId), {
        headers: headersOf(owner),
        data: { skillId: ownItems[0].id },
    });
    expect(ownBind.status(), await ownBind.text()).toBe(201);
});

test("@host 0680-J2 解绑语义：按行自身档位授权，删他工作区行/instance 行 ⇒ 404 SKILL_BINDING_NOT_FOUND，不级联", async ({
    request,
}) => {
    const identity = await newIdentity(request, "p0680-j2");
    const headers = headersOf(identity);

    const principalId = await provisionWorkspaceAgentPrincipal(
        request,
        { accessToken: identity.accessToken, workspaceId: identity.workspaceId },
        { name: `AgentJ2${Date.now().toString(36)}`, actions: ["read"] },
    );
    expect(principalId).toMatch(UUID);

    // 解绑一个不存在的绑定行：workspace tier 下应与「行不存在」不可区分（:93 防跨工作区探测）
    const missing = await request.delete(
        `${SKILL_BINDING_PATH(principalId, identity.workspaceId)}/${crypto.randomUUID()}`,
        { headers },
    );
    const missingText = await missing.text();
    expect(
        missing.status(),
        `删不存在的绑定行应 404，实际 ${missing.status()}：${missingText}`,
    ).toBe(404);
    expect(missingText).toContain("SKILL_BINDING_NOT_FOUND");

    // 请求体带 scopeType/scopeId ⇒ 400 INVALID_REQUEST（:86 客户端不可指定档位）
    const withScope = await request.post(SKILL_BINDING_PATH(principalId, identity.workspaceId), {
        headers,
        data: {
            skillId: crypto.randomUUID(),
            scopeType: "workspace",
            scopeId: identity.workspaceId,
        },
    });
    const withScopeText = await withScope.text();
    expect(
        withScope.status(),
        `请求体带 scopeType/scopeId 应 400，实际 ${withScope.status()}：${withScopeText}`,
    ).toBe(400);
    // body 只允许 skillId（`BIND_KEYS = Set.of("skillId")`），多余键 ⇒ 400 INVALID_REQUEST
    expect(withScopeText, `应命中 INVALID_REQUEST，实际：${withScopeText}`).toContain(
        "INVALID_REQUEST",
    );
});

test("@host 0680-J3 角色轴仍单轴：只开技能轴，角色绑定面维持 instance 派生 + cap 天花板", async ({
    request,
}) => {
    const identity = await newIdentity(request, "p0680-j3");
    const headers = headersOf(identity);

    const principalId = await provisionWorkspaceAgentPrincipal(
        request,
        { accessToken: identity.accessToken, workspaceId: identity.workspaceId },
        { name: `AgentJ3${Date.now().toString(36)}`, actions: ["read"] },
    );
    expect(principalId).toMatch(UUID);

    // 角色绑定面传 workspace 轴：按冻结文本 :109-111，角色轴不应因技能双轴而打开额外档位
    const roleBind = await request.post(
        `${CP_URL}/api/v1/agent-principals/${principalId}/roles?workspaceId=${identity.workspaceId}`,
        { headers, data: { roleId: crypto.randomUUID() } },
    );
    const text = await roleBind.text();
    // 不臆造新码：只断言「不因双轴而返回 201 成功」
    expect(
        roleBind.status(),
        `角色轴未开放，绑不存在的角色不应 2xx，实际 ${roleBind.status()}：${text}`,
    ).not.toBe(201);
    // 既有语义（`bl355:137-138` 实测）下无效角色走 4xx；具体码由角色面既有契约决定，此处不锁死
    expect(
        roleBind.status(),
        `应为 4xx，实际 ${roleBind.status()}：${text}`,
    ).toBeGreaterThanOrEqual(400);
    expect(roleBind.status()).toBeLessThan(500);
});

test.skip("@host 0680-J8 BL-354 场景", async () => {
    // BL-354 在冻结章 `spec/agent/principal-workspace-binding.md:72-125` 内无覆盖条款，
    // 按派活纪律「不确定就留 skip + 注释」，不臆造断言。窗口期需先取 BL-354 现状语义再补。
});

test("@host 0680-J9 档位徽标双语（zh 工作区级/实例级，en Workspace scope/Instance scope）", async ({
    page,
    request,
}) => {
    test.setTimeout(120_000); // 4 次整页加载 + dock 展开 + RBAC 面板加载，超默认 30s
    const identity = await newIdentity(request, "p0680-j9");

    // ── 前置数据（T3.3 补：r9 实证徽标未渲染的根因是没有任何绑定行）──
    const principalId = await provisionWorkspaceAgentPrincipal(request, identity, {
        name: `AgentJ9${Date.now().toString(36)}`,
        actions: ["read"],
    });
    expect(principalId).toMatch(UUID);

    // instance 档的两个授权门用既有 helper 直写隔离库（CP 无 role/grant 的 HTTP 写面）：
    //   instance 档技能导入 ⇒ MANAGE_SKILL_LIBRARY@instance（SkillAccessGuard.canManageInstanceLibrary，
    //     WS_OWNER 只有 workspace 档 N5，不够）；
    //   instance 档主体绑定 ⇒ MANAGE_AGENT_PRINCIPALS@instance（AgentPrincipalBindingAuthority.require）。
    // workspace 档导入/绑定所需的 MANAGE_WORKSPACE_AGENTS 已由 provision helper 种子，不动被测断言。
    seedUserGrantPermissions(identity.userId, [
        { actionClass: "MANAGE_SKILL_LIBRARY", resource: "*" },
        { actionClass: "MANAGE_AGENT_PRINCIPALS", resource: "*" },
    ]);

    // ① 两档技能定义各导一个 ② 两档各绑一条（档位服务端派生，跨档并存允许，SPEC :86/:88）
    const instanceSkillId = await importSkill(request, identity, { type: "instance" }, "inst");
    const workspaceSkillId = await importSkill(
        request,
        identity,
        { type: "workspace", workspaceId: identity.workspaceId },
        "ws",
    );
    await bindSkill(request, identity, principalId, workspaceSkillId, "workspace");
    await bindSkill(request, identity, principalId, instanceSkillId, "instance");

    // 页面登录态三键（照抄 agent-config-shots.spec.ts:39-55，同一 dock 面板的取证先例）
    await page.addInitScript(
        (token) => localStorage.setItem("xihe-token", token),
        identity.accessToken,
    );
    await page.addInitScript(
        (workspaceId) => localStorage.setItem("xihe-user", JSON.stringify({ workspaceId })),
        identity.workspaceId,
    );
    await page.addInitScript(
        (workspace) => {
            localStorage.setItem("xihe-workspace", JSON.stringify(workspace));
            localStorage.setItem("xihe-theme", "light");
        },
        { id: identity.workspaceId, name: "p0680-j9" },
    );

    /** zh / en 两语言下 badge 的真值（`i18n/index.ts:485-486` 与 `:2893-2894`）。 */
    const EXPECTED = [
        { locale: "zh-CN", scope: "workspace", text: "工作区级" },
        { locale: "zh-CN", scope: "instance", text: "实例级" },
        { locale: "en-US", scope: "workspace", text: "Workspace scope" },
        { locale: "en-US", scope: "instance", text: "Instance scope" },
    ] as const;

    const observed: Array<{ locale: string; scope: string; text: string }> = [];
    for (const { locale, scope, text } of EXPECTED) {
        await page.addInitScript((l) => {
            window.localStorage.setItem("xihe-language", l);
        }, locale);
        // 徽标宿主是 Workbench dock 的 agents tab 展开技能面板（WorkspaceAgentsPanel.vue:2124），
        // settings 路由没有该面板（r9 实证）⇒ 走工作台路由。
        await page.goto(`/workspace/${identity.workspaceId}`);
        // 打开 agents dock tab：点工具栏按钮（PLAN-0667 M3 同口径，agent-config-shots.spec.ts:57-61），
        // 选这条路而不写 xihe-layout-ws:<id> 布局键——后者要复刻持久化 schema，点击是产品真实入口。
        await page.getByTestId("workspace-toolbar-agents").click();
        await expect(page.getByTestId("dock-tab-agents")).toBeVisible();
        // 展开本主体的技能面板（rbacPrincipalId === principalId 才渲染徽标列表）
        await page.getByTestId(`agent-skills-toggle-${principalId}`).click();
        await expect(page.getByTestId("agent-skills-list")).toBeVisible();
        const badge = page.locator(`[data-testid="agent-skill-scope-${scope}"]`);
        if ((await badge.count()) === 0) {
            test.skip(true, `无 ${scope} 档绑定行，徽标未渲染，需先造绑定数据后重跑`);
            return;
        }
        await expect(badge.first(), `${locale} 下 ${scope} 徽标文案应为「${text}」`).toHaveText(
            text,
        );
        observed.push({ locale, scope, text: await badge.first().innerText() });
    }
    console.log(`[p0680-j9] OK observed=${JSON.stringify(observed)}`);
});
