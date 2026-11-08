// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
/**
 * BL-355 / BL-356 现状矩阵补测（`@host`）—— 把 `bl355-bl356-status-statement.md` 里 4 个
 * "未实测"格补成实测：
 *
 *  A. 绑 `WS_VIEWER` / `WS_EDITOR` / `WS_OWNER` ⇒ 期望 **409 `ROLE_BINDING_EXCEEDS_CAP`**
 *     （同一段 cap 求值：`AgentPrincipalRoleBindingService:279-304`；`WS_OWNER` 另带
 *     `workspace:admin` 能力原子，所以必须实测而非纯推断）。
 *  B. `GET /api/v1/skills?definitionScope=workspace&workspaceId=…` ⇒ **200 且列出**刚导入的 2 个
 *     workspace 私有技能（`SkillController:73-87`）。
 *  C. **HUMAN responder 提交** ⇒ 该 run 的 `chat_runs.agent_principal_id` **IS NULL**
 *     （`ChatSubmissionService:191-200`：human id 永不落库，且不能留 agent 戳）。
 *  D. continuation 的 principal 继承 —— **本文件不覆盖**：`POST /chat/runs/{sourceRunId}/continue`
 *     要求 source run 处于 `ambiguous`/`CP_RESTARTED`（`openapi.yaml:1633-1640`），真栈没有确定性
 *     构造手段（需故障注入）；保持"未实测"并在文档里写明卡点。
 *
 * 必须经 `scripts/e2e-host.mjs` 运行（依赖 runner 注入的 `XIHE_E2E_PG_*` 与隔离栈/库）。
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
import { LONG_TIMEOUT_MS } from "../timeouts";

test.describe.configure({ retries: 0 });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TERMINAL = /^(succeeded|failed|cancelled|ambiguous)$/u;
/** `SystemAccessRoleCatalog`：三个系统工作区角色。VIEWER 已在 BL-355 实测，串行补 EDITOR/OWNER。 */
const WORKSPACE_ROLES = [
    // VIEWER/EDITOR：原子都在 cap 之外 ⇒ 撞 cap 门（ROLE_BINDING_EXCEEDS_CAP）
    {
        name: "WS_VIEWER",
        id: "00000000-0000-4000-8000-000000000006",
        code: "ROLE_BINDING_EXCEEDS_CAP",
    },
    {
        name: "WS_EDITOR",
        id: "00000000-0000-4000-8000-000000000005",
        code: "ROLE_BINDING_EXCEEDS_CAP",
    },
    // OWNER：带 MANAGE_WORKSPACE_AGENTS / workspace:admin —— **更早的**禁授原子门先拒
    // （AgentPrincipalRoleBindingService:161 requireBindableAtoms 在 :168 cap 之前）⇒ 错误码不同
    {
        name: "WS_OWNER",
        id: "00000000-0000-4000-8000-000000000004",
        code: "AGENT_PRINCIPAL_FORBIDDEN_ATOMS",
    },
];

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

interface Identity {
    email: string;
    password: string;
    userId: string;
    accessToken: string;
    workspaceId: string;
}

/** 注册（自带凭据便于按 email 查 userId）+ 建 direct_attach 工作区 + fake provider。 */
async function newIdentity(request: APIRequestContext, label: string): Promise<Identity> {
    const nonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
    const email = `${label}-${nonce}@test.com`;
    const password = process.env.XIHE_E2E_PASSWORD ?? "XhE2e!bl355matrix1";
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
    const userId =
        body.id ??
        body.userId ??
        body.user?.id ??
        queryIsolatedPostgres(`SELECT id FROM users WHERE email = '${email}' LIMIT 1`);
    expect(userId, "应能定位注册用户").toMatch(UUID);
    return { email, password, userId, accessToken: body.accessToken, workspaceId };
}

test("@host BL-355 矩阵 A：绑三个系统工作区角色均 409（两个 cap 门 / 一个禁授原子门）", async ({
    request,
}) => {
    const identity = await newIdentity(request, "bl355-roles");
    const headers = {
        Authorization: `Bearer ${identity.accessToken}`,
        "Content-Type": "application/json",
        "X-Workspace-Id": identity.workspaceId,
    };
    const observed: Array<{ role: string; status: number; code: string }> = [];
    for (const role of WORKSPACE_ROLES) {
        // 每个角色用**新主体**（首绑后才能走到角色绑定），否则前一次的 409 状态会互相干扰
        const principalId = await provisionWorkspaceAgentPrincipal(
            request,
            { accessToken: identity.accessToken, workspaceId: identity.workspaceId },
            {
                name: `AgentBl355${role.name.replace("_", "")}${Date.now().toString(36)}`,
                actions: ["read"],
            },
        );
        const bind = await request.post(
            `${CP_URL}/api/v1/agent-principals/${principalId}/roles?workspaceId=${identity.workspaceId}`,
            { headers, data: { roleId: role.id } },
        );
        const text = await bind.text();
        const code = (JSON.parse(text) as { code?: string }).code ?? "";
        observed.push({ role: role.name, status: bind.status(), code });
        expect(bind.status(), `绑 ${role.name} 应 409，实际 ${bind.status()}：${text}`).toBe(409);
        expect(text, `绑 ${role.name} 应命中 ${role.code}，实际：${text}`).toContain(role.code);
    }
    console.log(`[bl355-roles] OK observed=${JSON.stringify(observed)}`);
});

test("@host BL-356 矩阵 B：workspace 私有技能可导入且可列出（200 + 2 项）", async ({ request }) => {
    const identity = await newIdentity(request, "bl356-list");
    const headers = {
        Authorization: `Bearer ${identity.accessToken}`,
        "Content-Type": "application/json",
        "X-Workspace-Id": identity.workspaceId,
    };
    const skills = [
        {
            name: "lab-ws-skill-one",
            description: "workspace 私有技能 1",
            body: "# one\n仅用于列出验证。",
            sourcePath: "lab/ws-one.md",
            trusted: false,
        },
        {
            name: "lab-ws-skill-two",
            description: "workspace 私有技能 2",
            body: "# two\n仅用于列出验证。",
            sourcePath: "lab/ws-two.md",
            trusted: false,
        },
    ];
    const imported = await request.post(`${CP_URL}/api/v1/skills/import`, {
        headers,
        data: { definitionScope: { type: "workspace", workspaceId: identity.workspaceId }, skills },
    });
    const importedText = await imported.text();
    expect(
        imported.status(),
        `workspace 导入应 200，实际 ${imported.status()}：${importedText}`,
    ).toBe(200);
    const importedIds = (
        (JSON.parse(importedText) as { results?: Array<{ skillId: string }> }).results ?? []
    ).map((row) => row.skillId);
    expect(importedIds).toHaveLength(2);

    const listed = await request.get(
        `${CP_URL}/api/v1/skills?definitionScope=workspace&workspaceId=${identity.workspaceId}`,
        { headers },
    );
    const listedText = await listed.text();
    expect(
        listed.status(),
        `列出 workspace 技能应 200，实际 ${listed.status()}：${listedText}`,
    ).toBe(200);
    const items = (JSON.parse(listedText) as { items?: Array<{ skillId: string }> }).items ?? [];
    for (const skillId of importedIds) {
        expect(
            items.map((item) => item.skillId),
            `列表应含 ${skillId}；实际：${JSON.stringify(items.map((item) => item.skillId))}`,
        ).toContain(skillId);
    }
    console.log(`[bl356-list] OK imported=${importedIds.join(",")} listed=${items.length} items`);
});

test("@host BL-354 矩阵 C：HUMAN responder 提交 ⇒ run 的 agent_principal_id IS NULL", async ({
    request,
}) => {
    const identity = await newIdentity(request, "bl354-human");
    const headers = {
        Authorization: `Bearer ${identity.accessToken}`,
        "Content-Type": "application/json",
        "X-Workspace-Id": identity.workspaceId,
    };
    const principalId = await provisionWorkspaceAgentPrincipal(
        request,
        { accessToken: identity.accessToken, workspaceId: identity.workspaceId },
        { name: `AgentBl354Human${Date.now().toString(36)}`, actions: ["read"] },
    );
    const sessionId = await createSessionWithPrincipal(
        request,
        { accessToken: identity.accessToken, workspaceId: identity.workspaceId },
        { principalId, title: "BL-354 human responder", workspaceId: identity.workspaceId },
    );

    // 会话参与者里找 HUMAN（PRIMARY 由服务端创建，不自己造）
    const participants = await request.get(`${CP_URL}/api/v1/sessions/${sessionId}/participants`, {
        headers,
    });
    const participantsText = await participants.text();
    expect(
        participants.status(),
        `列出参与者应 200，实际 ${participants.status()}：${participantsText}`,
    ).toBe(200);
    // 注意：会话用 agentPrincipalId 创建时，PRIMARY 是 **AGENT**，参与者里没有 HUMAN
    // （实测：`{"participants":[{principalKind:"AGENT", role:"PRIMARY"}]}`）⇒ 需要自己加一个 HUMAN。
    const added = await request.post(`${CP_URL}/api/v1/sessions/${sessionId}/participants`, {
        headers,
        data: {
            principalKind: "HUMAN",
            principalId: identity.userId,
            role: "MEMBER",
            respondPolicy: "ALWAYS",
        },
    });
    const addedText = await added.text();
    expect(added.status(), `加入 HUMAN 参与者应 201，实际 ${added.status()}：${addedText}`).toBe(
        201,
    );
    const humanParticipantId = (JSON.parse(addedText) as { participantId?: string; id?: string })
        .participantId;
    expect(humanParticipantId, `参与者视图应含 participantId：${addedText}`).toMatch(UUID);

    // SSE + 以 HUMAN 身份提交
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
            content: "BL-354 human responder submission",
            asParticipantId: humanParticipantId,
            toolMode: "chat",
        }),
    });
    if (reader) {
        await reader.read().catch(() => ({ value: undefined, done: true }));
        await reader.cancel().catch(() => {});
    }
    const response = await chat;
    const body = await response.text();
    expect(response.ok, `人类身份提交应 2xx，实际 ${response.status}：${body}`).toBe(true);

    // 轮询到终态后读 agent_principal_id（期望 NULL）
    let row: { status: string; agentPrincipalId: string | null } | null = null;
    await expect
        .poll(
            () => {
                const raw = queryIsolatedPostgres(
                    `SELECT json_build_object('status', status, 'agentPrincipalId', agent_principal_id)::text ` +
                        `FROM chat_runs WHERE session_id = '${sessionId}'::uuid ORDER BY created_at DESC LIMIT 1`,
                );
                row = raw
                    ? (JSON.parse(raw) as { status: string; agentPrincipalId: string | null })
                    : null;
                return row && TERMINAL.test(row.status) ? row.status : "running";
            },
            { timeout: LONG_TIMEOUT_MS, intervals: [500, 1_000, 2_000] },
        )
        .toMatch(TERMINAL);
    expect(
        row!.agentPrincipalId,
        `HUMAN responder 的 run 不应带 agent 戳（ChatSubmissionService:191-200）；实际：${row!.agentPrincipalId}`,
    ).toBeNull();
    console.log(
        `[bl354-human] OK session=${sessionId} human=${humanParticipantId} status=${row!.status} agentPrincipalId=NULL`,
    );
});
