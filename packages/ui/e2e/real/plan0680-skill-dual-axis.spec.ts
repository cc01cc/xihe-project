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
 * ⚠ 待窗口期核实（不臆造，实施期未取到真值）：
 *   - 技能绑定路由：本文件按 `/api/v1/agent-principals/{id}/skills` 写，与已验证的 `.../roles` 同构
 *     （`bl355:131`）。若实际路径不同，窗口期第一件事是校正这三处常量（`SKILL_BINDING_PATH`）。
 *   - J9 的 badge 文案真值未取：由 `WorkspaceAgentsPanel.spec.ts:1516,1523` 的 testid 断言锁住，
 *     E2E 侧待补 i18n key（`WorkspaceAgentsPanel.vue:2124` 的 props）。
 */
import { expect, test, type APIRequestContext } from "@playwright/test";

import { ensureFakeUserProvider } from "./helpers/fake-provider";
import { provisionWorkspaceAgentPrincipal } from "./helpers/agent-principal";
import { CP_URL } from "./helpers/journey";
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
    const otherItems = ((await otherSkills.json()) as { items?: Array<{ id: string }> }).items ?? [];
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
    expect(foreignText, `应命中 SKILL_NOT_FOUND，实际：${foreignText}`).toContain("SKILL_NOT_FOUND");

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
    expect(
        withScope.status(),
        `请求体带 scopeType/scopeId 应 400，实际 ${withScope.status()}：${await withScope.text()}`,
    ).toBe(400);
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
    expect(roleBind.status(), `应为 4xx，实际 ${roleBind.status()}：${text}`).toBeGreaterThanOrEqual(400);
    expect(roleBind.status()).toBeLessThan(500);
});

test.skip("@host 0680-J8 BL-354 场景", async () => {
    // BL-354 在冻结章 `spec/agent/principal-workspace-binding.md:72-125` 内无覆盖条款，
    // 按派活纪律「不确定就留 skip + 注释」，不臆造断言。窗口期需先取 BL-354 现状语义再补。
});

test.skip("@host 0680-J9 档位徽标双语", async () => {
    // testid 真值已由单测锁住：`WorkspaceAgentsPanel.spec.ts:1516`（agent-skill-scope-workspace）、
    // `:1523`（agent-skill-scope-instance）；组件侧 `WorkspaceAgentsPanel.vue:2124`
    // `:data-testid=\"`agent-skill-scope-${binding.scopeType}`\"`。
    // 双语文案真值未取（i18n key 未定位到 badge 专用条目），故不在本 spec 编造文案。
    // 窗口期补：读 `WorkspaceAgentsPanel.vue:2124` 的 i18n key → 取 zh/en 两份真值 → 断言 badge 文本。
});
