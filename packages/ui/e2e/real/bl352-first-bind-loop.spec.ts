/**
 * BL-352 真栈复核 · 首绑闭环探针（`@host`）。
 *
 * 要回答的问题（`0673` 在 lab 里撞了三道门后提出的）：**"给 agent 主体加工作区角色"的正确顺序是什么？
 * 顺序错了会得到什么错？** 本文件把它写成一条**可执行**的顺序证明：
 *
 *   ① `POST /api/v1/agent-principals`（带 `X-Workspace-Id`）⇒ 201（instance 面建主体）
 *   ② `PUT /api/v1/workspaces/{ws}/agents/{pid}`           ⇒ 200（**首绑**：写 `workspace_agents`
 *      + 结构化默认绑定；默认绑定不受 cap 门约束）
 *   ③ `POST /api/v1/agent-principals/{pid}/roles?workspaceId={ws}` ⇒ **看第 2 条**
 *   负例：在 ② 之前先打 ③ ⇒ **403 FORBIDDEN**（证明"roles 不能当首绑入口"是设计而非 bug）
 *
 * ── 两个已由 Lead 确认的结论（2026-11-06，读码 + 实测一致）─────────────────────────────
 *
 * 1. **负例的错误码是 403，不是 409**。
 *    `AgentPrincipalRoleBindingService.bind()` 第 168 行 `atomPolicy.assertWithinCap(...)` 内部会调
 *    `AgentPrincipalService.resolveCapFor(pid, ws)`，而它**第一个动作**就是
 *    `requireActiveWorkspaceBinding(...)`（`AgentPrincipalService:661-671`）：该工作区既无
 *    `workspace_agents` 行、也无 **workspace 作用域**角色绑定时直接
 *    `403 FORBIDDEN「Agent principal holds no role binding for this Workspace」`。
 *    ⇒ **cap 求值的第一个动作就是"绑定前置"，所以 `ROLE_BINDING_EXCEEDS_CAP` 的比较根本走不到。**
 *    （新建主体只有 instance 作用域默认角色 `bindInstanceRoles`，而 `roleBoundPrincipalIds` 只查
 *    `scope_type='workspace'`（`:520-527`）⇒ 首绑前必然没有 workspace 绑定。）
 *
 * 2. **首绑之后加"系统工作区角色"恒 409 `ROLE_BINDING_EXCEEDS_CAP`（产品现状 = BL-355，待裁定）**。
 *    cap = `retainCovered(bindingPermissions, principalEffectiveAtoms)`（`AgentPrincipalService:602-614`），
 *    即角色原子必须**同时**出现在「② 授的权限」与「主体自身原子集」里；
 *    而 `WS_VIEWER` = `read` + `USE_WORKSPACE_RUNTIME`（`SystemAccessRoleCatalog:196-204`）、
 *    `WS_EDITOR`/`WS_OWNER` 更多，主体默认 instance 角色 `AGENT_USER` 的 `BASE_ATOMS`
 *    （`:78-83`）= `read/write/delete/exec/network` **不含** `USE_WORKSPACE_RUNTIME`
 *    ⇒ 任何系统工作区角色都超 cap。
 *    **本 spec 明确断言这个 409**：它是"产品缺口的存在性证明"，不是"测试没写对"。
 *    **禁止**为了让它 201 去放宽 ② 的权限集或改断言——那等于把产品缺口塞进测试。
 *
 * 第 2 个用例（可选正向面）：② 一次性授满 `BASE_ATOMS`（cap 覆盖五原子）后，尝试绑
 * `AGENT_USER`（原子集恰为 `BASE_ATOMS`，`:217-220`）⇒ 期望 201。这是"能否找到**原子集 ⊆ cap**
 * 的系统角色"的探针：若它也失败，正好是 `BL-355` 的补强证据（**不自建自定义角色**，避免污染测试数据）。
 *
 * 必须经 `scripts/e2e-host.mjs` 运行（依赖 runner 注入的 `XIHE_*` 与隔离栈/库）。
 */
import { expect, test, type APIRequestContext } from "@playwright/test";

import { CP_URL, registerJourneyUser } from "./helpers/journey";

test.describe.configure({ retries: 0 });

/** 系统工作区角色：Viewer（`read` + `USE_WORKSPACE_RUNTIME`）⇒ 超出 cap 的典型样本。 */
const WS_VIEWER_ROLE_ID = "00000000-0000-4000-8000-000000000006";
/** agent 默认 instance 角色：原子集恰为 BASE_ATOMS，是唯一"可能 ⊆ cap"的系统角色。 */
const AGENT_USER_ROLE_ID = "00000000-0000-4000-8000-000000000008";
/** ② 用：授满 BASE_ATOMS，使 cap 覆盖五原子。 */
const BASE_ATOM_PERMISSIONS = ["read", "write", "delete", "exec", "network"].map((actionClass) => ({
    actionClass,
    resource: "*",
}));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

async function createPrincipal(
    request: APIRequestContext,
    headers: Record<string, string>,
): Promise<string> {
    const created = await request.post(`${CP_URL}/api/v1/agent-principals`, {
        headers,
        data: { name: `AgentBl352${Date.now().toString(36)}` },
    });
    expect(
        created.status(),
        `① 建主体应 201，实际 ${created.status()}：${await created.text()}`,
    ).toBe(201);
    const { principalId } = (await created.json()) as { principalId: string };
    expect(principalId).toMatch(UUID);
    return principalId;
}

test("@host BL-352 首绑闭环：顺序错 ⇒ 403；首绑 ⇒ 200；再绑系统角色 ⇒ 409 caps（BL-355）", async ({
    request,
}) => {
    const owner = await registerJourneyUser(request, "bl352-loop-owner");
    const workspaceId = owner.workspaceId;
    const headers = { ...owner.headers, "X-Workspace-Id": workspaceId };

    // ① 建主体
    const principalId = await createPrincipal(request, headers);

    // 负例：② 之前先打 ③ ⇒ 403 FORBIDDEN（cap 求值第一步是"绑定前置"，所以不是 409）
    const earlyBind = await request.post(
        `${CP_URL}/api/v1/agent-principals/${principalId}/roles?workspaceId=${workspaceId}`,
        { headers, data: { roleId: WS_VIEWER_ROLE_ID } },
    );
    const earlyBindText = await earlyBind.text();
    expect(
        earlyBind.status(),
        `负例（先加角色、后首绑）应 403 FORBIDDEN（cap 求值第一步 ` +
            `requireActiveWorkspaceBinding 就拒绝）；实际 ${earlyBind.status()}：${earlyBindText}`,
    ).toBe(403);
    expect(
        earlyBindText,
        `负例理由应指向"该工作区没有角色绑定"（BL-352 设计：roles 不是首绑入口）；实际：${earlyBindText}`,
    ).toContain("role binding");

    // ② 首绑 ⇒ 200
    const bound = await request.put(
        `${CP_URL}/api/v1/workspaces/${workspaceId}/agents/${principalId}`,
        { headers, data: { permissions: [{ actionClass: "read", resource: "*" }] } },
    );
    expect(
        bound.status(),
        `② 首绑应 200；实际 ${bound.status()}：${await bound.text()}；` +
            "若 403 ROLE_NOT_GRANTABLE 且 detail 含 MEMORY_WRITE_SELF ⇒ BL-349 回退（查 V129/V130 与 seed）",
    ).toBe(200);

    // ③ 首绑之后再绑系统工作区角色 ⇒ 409 ROLE_BINDING_EXCEEDS_CAP（= BL-355 的存在性证明）
    const secondRole = await request.post(
        `${CP_URL}/api/v1/agent-principals/${principalId}/roles?workspaceId=${workspaceId}`,
        { headers, data: { roleId: WS_VIEWER_ROLE_ID } },
    );
    const secondRoleText = await secondRole.text();
    expect(
        secondRole.status(),
        `③ 首绑后绑 WS_VIEWER 应 409（cap 天花板）；实际 ${secondRole.status()}：${secondRoleText}`,
    ).toBe(409);
    expect(secondRoleText, `③ 应命中 ROLE_BINDING_EXCEEDS_CAP；实际：${secondRoleText}`).toContain(
        "ROLE_BINDING_EXCEEDS_CAP",
    );
    // 断言消息把产品缺口写进"通过路径"，避免后来者误以为这是测试问题：
    // cap 天花板：AGENT_USER 缺 USE_WORKSPACE_RUNTIME ⇒ 系统工作区角色不可授予（BL-355，待产品裁定）
    console.log(
        `[bl352-loop] OK principal=${principalId} workspace=${workspaceId} cp=${CP_URL} ` +
            `earlyBind=${earlyBind.status()} firstBind=200 systemRole=${secondRole.status()}(ROLE_BINDING_EXCEEDS_CAP)`,
    );
});

test("@host BL-352 可选正向面：cap 覆盖 BASE_ATOMS 后能否授予 AGENT_USER", async ({ request }) => {
    // 这条探"原子集 ⊆ cap 的系统角色是否存在"：
    // ② 授满五原子 ⇒ cap = BASE_ATOMS；AGENT_USER 的原子集恰为 BASE_ATOMS ⇒ 若产品允许，应 201。
    // 若它失败，说明**连唯一的候选系统角色也授不了** ⇒ BL-355 的补强证据（不要自建角色绕过）。
    const owner = await registerJourneyUser(request, "bl352-positive-owner");
    const workspaceId = owner.workspaceId;
    const headers = { ...owner.headers, "X-Workspace-Id": workspaceId };

    const principalId = await createPrincipal(request, headers);
    const bound = await request.put(
        `${CP_URL}/api/v1/workspaces/${workspaceId}/agents/${principalId}`,
        { headers, data: { permissions: BASE_ATOM_PERMISSIONS } },
    );
    expect(
        bound.status(),
        `② 首绑（授满 BASE_ATOMS）应 200；实际 ${bound.status()}：${await bound.text()}`,
    ).toBe(200);

    const grant = await request.post(
        `${CP_URL}/api/v1/agent-principals/${principalId}/roles?workspaceId=${workspaceId}`,
        { headers, data: { roleId: AGENT_USER_ROLE_ID } },
    );
    const grantText = await grant.text();
    expect(
        grant.status(),
        `cap 覆盖 BASE_ATOMS 后授予 AGENT_USER（原子集 = BASE_ATOMS）应 201；` +
            `实际 ${grant.status()}：${grantText}。` +
            "若仍被拒 ⇒ 不存在「原子集 ⊆ cap 的系统角色」 ⇒ BL-355 补强证据（不得自建自定义角色绕过）",
    ).toBe(201);
});
