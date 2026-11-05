/**
 * PLAN-0678 V3 技能正向（`@host`）：**instance 作用域导入 2 个技能 → 绑到主体 → 跑一次真 chat →
 * `chat_runs.skills_snapshot` 里必须冻结这 2 项**（含反向对照）。
 *
 * 为什么必须 **instance 作用域**：主体技能绑定恒写 `scope_type='instance'/scope_id=null`
 * （`AgentPrincipalSkillBindingController:35-37`），而
 * `AgentPrincipalSkillBindingService:39/110` 明确"workspace-private 技能定义不可绑，答 400
 * `SKILL_DEFINITION_OUT_OF_SCOPE`" ⇒ 工作区私有技能只能导入/列出，**不能进主体快照**。
 * 因此本 spec 在隔离库里给注册用户授 **`SUPER_ADMIN`**（`role_bindings` 一行）后**重新登录**，
 * 再用新 token 做 instance 导入。**这是"绕过 API 的提权"，仅对 `XIHE_E2E_PG_*` 指向的隔离库执行，
 * 随栈销毁** —— 报告里必须单列这一句（与 `0673` lab 的处理同口径）。
 *
 * 顺序按 `BL-352` 的教训（先首绑，再绑技能/建会话）：
 *   ① 注册（自带凭据，便于 ④b 重新登录）→ 建 direct_attach 工作区 ⇒ OWNER
 *   ② 建 agent 主体（带 `X-Workspace-Id`）⇒ 201
 *   ③ 首绑 `PUT /workspaces/{ws}/agents/{pid}` ⇒ 200（BL-349 修复后必过）
 *   ④b psql 授 `SUPER_ADMIN` → `POST /auth/login` 取新 token
 *   ⑤ `POST /api/v1/skills/import`（**instance 作用域**，2 个技能）⇒ 200，拿 2 个 skillId
 *   ⑥ `POST /api/v1/agent-principals/{pid}/skills?workspaceId={ws}` ×2 ⇒ 201 ×2
 *   ⑦ `POST /workspaces/{ws}/sessions`（agentPrincipalId）⇒ 201
 *   ⑧ SSE + `POST /api/v1/chat` ⇒ 202，轮询 `chat_runs.status` 到终态
 *   ⑨ 判据：`skills_snapshot` 非 `{}`、恰好含这 2 个 skillId、`agent_principal_id = pid`
 *   ⑩ 反向对照：解绑其中一个 ⇒ 再跑一次 ⇒ 快照只剩 1 项
 *
 * 判据不过就报"未验证 + 原因"，**不改断言凑绿**。必须经 `scripts/e2e-host.mjs` 运行。
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "@playwright/test";

import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";
import { ensureFakeUserProvider } from "./helpers/fake-provider";
import { CP_URL, getRootBranchId } from "./helpers/journey";
import { ensureWorkspace } from "./helpers/workspace";

test.describe.configure({ retries: 0 });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** chat run 终态（与 capacity/checkpoint 系列 spec 同一口径）。 */
const TERMINAL = /^(succeeded|failed|cancelled|ambiguous)$/u;
/** `V87__dynamic_access_roles.sql:40-58` 的实例超管角色。 */
const SUPER_ADMIN_ROLE_ID = "00000000-0000-4000-8000-000000000001";

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
        { encoding: "utf8", timeout: 15_000, windowsHide: true },
    ).trim();
}

interface ChatRunRow {
    id: string;
    status: string;
    agentPrincipalId: string | null;
    skillsSnapshot: string;
}

/** 取某会话最近一次 run 的关键列（一次查询拿全，避免多次轮询漂移）。 */
function latestRun(sessionId: string): ChatRunRow | null {
    const raw = queryIsolatedPostgres(
        `SELECT json_build_object('id', id, 'status', status, 'agentPrincipalId', agent_principal_id, ` +
            `'skillsSnapshot', skills_snapshot::text)::text FROM chat_runs ` +
            `WHERE session_id = '${sessionId}'::uuid ORDER BY created_at DESC LIMIT 1`,
    );
    if (!raw) return null;
    return JSON.parse(raw) as ChatRunRow;
}

/** SSE 订阅保活 + `POST /api/v1/chat`（产品门：无订阅 ⇒ 409 SSE_SUBSCRIPTION_REQUIRED）。 */
async function sendChat(
    request: APIRequestContext,
    headers: Record<string, string>,
    sessionId: string,
    principalId: string,
    content: string,
): Promise<void> {
    const branchId = await getRootBranchId(request, sessionId, headers);
    const sse = await fetch(`${CP_URL}/api/v1/events?sessionId=${sessionId}`, { headers });
    expect(sse.ok, `SSE subscription failed: HTTP ${sse.status}`).toBe(true);
    const reader = sse.body?.getReader();
    const chat = fetch(`${CP_URL}/api/v1/chat`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
            sessionId,
            branchId,
            content,
            agentPrincipalId: principalId,
            toolMode: "chat",
        }),
    });
    if (reader) {
        // 先读掉一个 chunk，确保订阅已挂上再派发；随后即可停读（CP 只要求 emitter 存在）。
        await reader.read().catch(() => ({ value: undefined, done: true }));
        await reader.cancel().catch(() => {});
    }
    const response = await chat;
    const body = await response.text();
    expect(response.ok, `POST /api/v1/chat 应 2xx，实际 ${response.status}：${body}`).toBe(true);
}

const SKILLS = [
    {
        name: "lab-skill-alpha",
        description: "V3 正向构造 A",
        body: "# alpha\n用于验证 skills_snapshot 的绑定项。",
        sourcePath: "lab/alpha.md",
        trusted: false,
    },
    {
        name: "lab-skill-beta",
        description: "V3 正向构造 B",
        body: "# beta\n用于验证 skills_snapshot 的绑定项。",
        sourcePath: "lab/beta.md",
        trusted: false,
    },
];

test("@host PLAN-0678 V3 技能正向：instance 导入 2 技能 → 绑定 → chat run 快照冻结（含反向对照）", async ({
    request,
}) => {
    // ① 注册（自持凭据，供 ④b 重新登录）+ 工作区
    const nonce = Date.now().toString(36);
    const email = `p0678-skills-${nonce}@test.com`;
    const password = process.env.XIHE_E2E_PASSWORD ?? "XhE2e!p0678skills1";
    const registered = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: { email, password, name: `p0678skills${nonce}` },
    });
    expect(
        [200, 201],
        `注册应 2xx，实际 ${registered.status()}：${await registered.text()}`,
    ).toContain(registered.status());
    const regBody = (await registered.json()) as {
        id?: string;
        userId?: string;
        accessToken: string;
        user?: { id?: string };
    };
    const workspaceId = await ensureWorkspace(request, regBody.accessToken);
    await ensureFakeUserProvider(request, { accessToken: regBody.accessToken, workspaceId });

    // ②③ 建主体 + 首绑（首绑必须先于任何"绑定类端点"，BL-352 门 1）
    const principalId = await provisionWorkspaceAgentPrincipal(
        request,
        { accessToken: regBody.accessToken, workspaceId },
        { name: `AgentP0678Skills${nonce}`, actions: ["read"] },
    );
    expect(principalId).toMatch(UUID);

    // ④b 隔离库授予 SUPER_ADMIN（绕过 API 的提权，仅本隔离库、随栈销毁），再重新登录取新 token
    const userId =
        regBody.id ??
        regBody.userId ??
        regBody.user?.id ??
        queryIsolatedPostgres(`SELECT id FROM users WHERE email = '${email}' LIMIT 1`);
    expect(userId, `应能定位注册用户（注册响应 id 或按 identifier 查库）`).toMatch(UUID);
    queryIsolatedPostgres(
        `INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type, scope_id, granted_by) ` +
            `VALUES (gen_random_uuid(), '${SUPER_ADMIN_ROLE_ID}', 'user', '${userId}', 'instance', NULL, NULL) ` +
            `ON CONFLICT DO NOTHING`,
    );
    // 关键：`RequesterAuthority.holdsActionAtom` 读的是**物化后的 `grants` 表**
    // （`RequesterAuthority` 依赖 `AuthorizationGrantRepository`），插 `role_bindings` 不会自动物化，
    // 所以还需要直接写一行 instance 作用域的 MANAGE_SKILL_LIBRARY grant
    //（JSON 形状 `{actionClass, resource}`，见 `GrantIntersectionEvaluator.PermissionAtom`）。
    queryIsolatedPostgres(
        `INSERT INTO grants (id, subject_type, subject_id, permissions, source, scope_type, scope_id) ` +
            `VALUES (gen_random_uuid(), 'user', '${userId}', ` +
            `'[{"actionClass":"MANAGE_SKILL_LIBRARY","resource":"*"}]'::jsonb, 'role', 'instance', NULL)`,
    );
    const granted = queryIsolatedPostgres(
        `SELECT count(*) FROM grants WHERE subject_id = '${userId}'::uuid ` +
            `AND permissions::text LIKE '%MANAGE_SKILL_LIBRARY%' AND scope_type = 'instance'`,
    );
    expect(
        granted,
        `instance 作用域 MANAGE_SKILL_LIBRARY grant 应存在（实际 count=${granted}）`,
    ).toBe("1");

    const login = await request.post(`${CP_URL}/api/v1/auth/login`, {
        // PLAN-0565 ruling #7: 登录字段是 `identifier`（email 或 username），不是 `email`
        data: { identifier: email, password },
    });
    const loginText = await login.text();
    expect(login.status(), `重新登录应 200，实际 ${login.status()}：${loginText}`).toBe(200);
    const { accessToken } = JSON.parse(loginText) as { accessToken: string };
    const headers = {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Workspace-Id": workspaceId,
    };

    // ⑤ instance 作用域导入 2 个技能（workspace 私有技能不可绑主体，见头注释）
    const imported = await request.post(`${CP_URL}/api/v1/skills/import`, {
        headers,
        data: { definitionScope: { type: "instance" }, skills: SKILLS },
    });
    const importedText = await imported.text();
    expect(
        imported.status(),
        `skills/import（instance 作用域）应 200，实际 ${imported.status()}：${importedText}` +
            "；若 403 MANAGE_SKILL_LIBRARY ⇒ SUPER_ADMIN 原子集不含该原子，停手报 Lead（不要自行再加行）",
    ).toBe(200);
    const importedBody = JSON.parse(importedText) as {
        results?: Array<{ skillId: string; name: string }>;
        rejected?: unknown[];
    };
    const skillIds = (importedBody.results ?? []).map((row) => row.skillId);
    expect(
        importedBody.rejected ?? [],
        `导入不应有 rejected 行：${JSON.stringify(importedBody.rejected)}`,
    ).toHaveLength(0);
    expect(
        skillIds,
        `应导入 2 个技能，实际 results=${JSON.stringify(importedBody.results)}`,
    ).toHaveLength(2);
    for (const id of skillIds) expect(id).toMatch(UUID);

    // ⑥ 绑 2 个技能（一次一个，body 只许 skillId）
    const bindingIds: string[] = [];
    for (const skillId of skillIds) {
        const bind = await request.post(
            `${CP_URL}/api/v1/agent-principals/${principalId}/skills?workspaceId=${workspaceId}`,
            { headers, data: { skillId } },
        );
        const bindText = await bind.text();
        expect(
            bind.status(),
            `绑定技能 ${skillId} 应 201，实际 ${bind.status()}：${bindText}` +
                "；若 400 SKILL_DEFINITION_OUT_OF_SCOPE ⇒ 说明 skillId 不是 instance 作用域定义" +
                "（绑定恒为 instance 作用域，见 AgentPrincipalSkillBindingService:39/110）",
        ).toBe(201);
        const bound = JSON.parse(bindText) as { bindingId?: string };
        expect(
            bound.bindingId,
            `绑定响应应含 bindingId（toView 字段名），实际：${bindText}`,
        ).toMatch(UUID);
        bindingIds.push(bound.bindingId as string);
    }

    // ⑦ 建会话（agentPrincipalId 必须显式携带）
    const sessionId = await createSessionWithPrincipal(
        request,
        { accessToken, workspaceId },
        { principalId, title: "PLAN-0678 V3 skills positive", workspaceId },
    );

    // ⑧ 第一次 run（绑 2 个技能）
    await sendChat(request, headers, sessionId, principalId, "PLAN-0678 V3 skills positive run");
    let run: ChatRunRow | null = null;
    await expect
        .poll(
            () => {
                const row = latestRun(sessionId);
                run = row;
                return row && TERMINAL.test(row.status) ? row.status : "running";
            },
            { timeout: 120_000, intervals: [500, 1_000, 2_000] },
        )
        .toMatch(TERMINAL);

    // ⑨ 判据 1/3：快照非空、恰好含这 2 个 skillId、run 归属正确
    expect(run, "chat_runs 里应能查到该会话的 run").not.toBeNull();
    const snapshot = run!.skillsSnapshot;
    expect(snapshot, "skills_snapshot 不应是 {}（{} 只表示未捕获）").not.toBe("{}");
    for (const skillId of skillIds) {
        expect(snapshot, `快照应含 skillId ${skillId}；实际：${snapshot}`).toContain(skillId);
    }
    expect(
        snapshot.match(/"skillId"/gu)?.length ?? 0,
        `快照应恰好含 2 个技能项；实际：${snapshot}`,
    ).toBe(2);
    expect(run!.agentPrincipalId, "run 应归属本次主体（BL-354 台账项）").toBe(principalId);

    // ⑩ 反向对照：解绑 beta ⇒ 再跑一次 ⇒ 快照只剩 1 项
    const betaSkillId = skillIds[1];
    const unbind = await request.delete(
        `${CP_URL}/api/v1/agent-principals/${principalId}/skills/${bindingIds[1]}?workspaceId=${workspaceId}`,
        { headers },
    );
    expect(unbind.status(), `解绑技能应 204，实际 ${unbind.status()}：${await unbind.text()}`).toBe(
        204,
    );

    await sendChat(request, headers, sessionId, principalId, "PLAN-0678 V3 skills positive run 2");
    let run2: ChatRunRow | null = null;
    await expect
        .poll(
            () => {
                const row = latestRun(sessionId);
                run2 = row;
                return row && row.id !== run!.id && TERMINAL.test(row.status)
                    ? row.status
                    : "running";
            },
            { timeout: 120_000, intervals: [500, 1_000, 2_000] },
        )
        .toMatch(TERMINAL);
    const snapshot2 = run2!.skillsSnapshot;
    expect(snapshot2, `解绑后快照应只含 1 项；实际：${snapshot2}`).toContain(skillIds[0]);
    expect(snapshot2, `解绑后快照不应再含 ${betaSkillId}；实际：${snapshot2}`).not.toContain(
        betaSkillId,
    );

    console.log(
        `[p0678-skills] OK workspace=${workspaceId} principal=${principalId} session=${sessionId} ` +
            `run=${run!.id} run2=${run2!.id} skills=${skillIds.join(",")} ` +
            `snapshot1Bytes=${snapshot.length} snapshot2Bytes=${snapshot2.length} ` +
            `grantedSuperAdmin=${granted}`,
    );
    // 证据：把两次快照原文打出来，供 .local/evidence 归档直接引用（1028 字节量级，不刷屏）
    console.log(`[p0678-skills] snapshot1=${snapshot}`);
    console.log(`[p0678-skills] snapshot2=${snapshot2}`);
    );
});
