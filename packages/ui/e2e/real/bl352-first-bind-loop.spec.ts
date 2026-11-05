/**
 * BL-352 真栈复核 · 首绑闭环探针（`@host`）。
 *
 * 要回答的问题（`0673` 在 lab 里撞了三道门后提出的）：**"给 agent 主体加工作区角色"的正确顺序是什么？
 * 顺序错了会得到什么错？** 本 spec 把它写成一条**可执行**的顺序证明：
 *
 *   ① `POST /api/v1/agent-principals`（带 `X-Workspace-Id`）⇒ 201（instance 面建主体）
 *   ② `PUT /api/v1/workspaces/{ws}/agents/{pid}`           ⇒ 200（**首绑**：写 `workspace_agents`
 *      + 默认 `WS_EDITOR` 绑定；结构化默认绑定不受 cap 门约束）
 *   ③ `POST /api/v1/agent-principals/{pid}/roles?workspaceId={ws}` ⇒ 201（绑第 2 个角色；
 *      此时 cap 已存在，roles 端点才可用）
 *   负例：在 ② 之前先打 ③ ⇒ **必须被拒**（证明"roles 不能当首绑入口"是设计而非 bug）。
 *
 * 为什么 ③ 必须先于 ② 会失败（引用 BL-352；代码依据）：
 *   - `AgentPrincipalRoleBindingService.bind()` 会走 `atomPolicy.assertWithinCap(...)`；
 *   - cap 由 `AgentPrincipalService.resolveCapFor(pid, ws)` 求得，而它第一步就是
 *     `requireActiveWorkspaceBinding(...)`（`AgentPrincipalService:661-671`）——
 *     没有 `workspace_agents` 行且该工作区没有 **workspace 作用域**角色绑定时直接拒绝；
 *   - 因此"先加角色"在 cap 求值阶段就被拦下，`ROLE_BINDING_EXCEEDS_CAP` 的比较**根本走不到**。
 *
 * ⚠️ 两个**待实测确认**的点（写在本文件里，避免下一手重新踩）：
 *   1. **负例实际错误码**：按当前代码应是 **403 `FORBIDDEN`**（detail:
 *      "Agent principal holds no role binding for this Workspace"），**不是** 409
 *      `ROLE_BINDING_EXCEEDS_CAP`。本 spec 按 403 断言；若实测为 409，说明 cap 解析在无绑定时的
 *      行为与读码不一致 ⇒ 按实测更新本断言并回报 Lead。
 *   2. **正例第 ③ 步能否 201**：cap = `bindingPermissions ∩ principalEffectiveAtoms`。若 ② 只授
 *      `{read,*}`，则 cap 只有 `read`；而系统工作区角色（`WS_VIEWER`/`WS_EDITOR`/`WS_OWNER`）都带
 *      `USE_WORKSPACE_RUNTIME`（`SystemAccessRoleCatalog:196-204`）⇒ 会 **409 EXCEEDS_CAP**。
 *      第 ③ 步先用 `WS_VIEWER` 试；若 409，说明"二绑需要更宽的 ② 权限，而更宽的权限又受主体自身
 *      原子集限制"——那就是 BL-352 需要裁定/改产品的地方，失败信息里会点名。
 *
 * 必须经 `scripts/e2e-host.mjs` 运行（依赖 runner 注入的 `XIHE_*` 与隔离 DB/栈）。
 */
import { expect, test } from "@playwright/test";

import { CP_URL, registerJourneyUser } from "./helpers/journey";

test.describe.configure({ retries: 0 });

/** 系统工作区角色：Viewer（只读 + use-workspace-runtime），用作"第 2 个角色"。 */
const WS_VIEWER_ROLE_ID = "00000000-0000-4000-8000-000000000006";

test("@host BL-352 首绑闭环：建主体 → 首绑 → 加第 2 角色（并证明顺序错会被拒）", async ({
    request,
}) => {
    const owner = await registerJourneyUser(request, "bl352-loop-owner");
    const workspaceId = owner.workspaceId;
    const nonce = Date.now().toString(36);
    const name = `AgentBl352Loop${nonce}`;
    const headers = { ...owner.headers, "X-Workspace-Id": workspaceId };

    // ── ① 建主体（instance 面，带工作区上下文）──────────────────────────────────────────
    const created = await request.post(`${CP_URL}/api/v1/agent-principals`, {
        headers,
        data: { name },
    });
    expect(
        created.status(),
        `① 建主体应 201，实际 ${created.status()}：${await created.text()}`,
    ).toBe(201);
    const { principalId } = (await created.json()) as { principalId: string };
    expect(principalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);

    // ── 负例：② 之前先打 ③ ⇒ 必须被拒（证明 roles 不能当首绑入口）──────────────────────
    // 期望 403 FORBIDDEN（detail: "Agent principal holds no role binding for this Workspace"）。
    // 若这里实测到 409 ROLE_BINDING_EXCEEDS_CAP，说明"无绑定时 cap 求值"的行为与读码不同，
    // 先别改断言硬凑——把实际值回报 Lead 再定。
    const earlyBind = await request.post(
        `${CP_URL}/api/v1/agent-principals/${principalId}/roles?workspaceId=${workspaceId}`,
        { headers, data: { roleId: WS_VIEWER_ROLE_ID } },
    );
    const earlyBindText = await earlyBind.text();
    expect(
        earlyBind.status(),
        `负例（先加角色后首绑）应被拒 403 FORBIDDEN（cap 求值阶段就拒绝）；` +
            `实际 ${earlyBind.status()}：${earlyBindText}` +
            "；若实际是 409 ROLE_BINDING_EXCEEDS_CAP，请按实测更新本断言并回报 Lead（BL-352）",
    ).toBe(403);
    expect(
        earlyBindText,
        `负例拒绝理由应指向"该工作区没有角色绑定"（BL-352 设计：roles 不是首绑入口）；实际：${earlyBindText}`,
    ).toContain("role binding");

    // ── ② 首绑：PUT 工作区 agent 绑定 ⇒ 200（写 workspace_agents + 默认工作区角色）────────
    const bound = await request.put(
        `${CP_URL}/api/v1/workspaces/${workspaceId}/agents/${principalId}`,
        {
            headers,
            data: { permissions: [{ actionClass: "read", resource: "*" }] },
        },
    );
    expect(
        bound.status(),
        `② 首绑（PUT /workspaces/{ws}/agents/{pid}）应 200；实际 ${bound.status()}：${await bound.text()}` +
            "；403 ROLE_NOT_GRANTABLE 的 detail 若含 MEMORY_WRITE_SELF ⇒ BL-349 回退（查 V129/V130 与 seed）",
    ).toBe(200);

    // ── ③ 加第 2 个角色 ⇒ 201（cap 已存在，roles 端点此时可用）──────────────────────────
    const secondRole = await request.post(
        `${CP_URL}/api/v1/agent-principals/${principalId}/roles?workspaceId=${workspaceId}`,
        { headers, data: { roleId: WS_VIEWER_ROLE_ID } },
    );
    const secondRoleText = await secondRole.text();
    expect(
        secondRole.status(),
        `③ 首绑之后再加角色应 201；实际 ${secondRole.status()}：${secondRoleText}` +
            "；若是 409 ROLE_BINDING_EXCEEDS_CAP ⇒ 说明 ② 只授了 {read,*} 的 cap 撑不住系统工作区角色" +
            "（WS_VIEWER 带 USE_WORKSPACE_RUNTIME，见 SystemAccessRoleCatalog:196-204），" +
            "而放宽 ② 的权限又受主体自身原子集限制 ⇒ 属 BL-352 需裁定的产品口径，不要在这里放宽断言",
    ).toBe(201);

    // 闭环输出：一行结论，便于复核报告直接引用
    console.log(
        `[bl352-loop] OK principal=${principalId} workspace=${workspaceId} cp=${CP_URL} ` +
            `earlyBind=${earlyBind.status()} firstBind=200 secondRole=201`,
    );
});
