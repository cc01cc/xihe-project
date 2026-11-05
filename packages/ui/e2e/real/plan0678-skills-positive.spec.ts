/**
 * PLAN-0678 V3 技能正向（`@host`）：**工作区作用域导入 2 个技能 → 绑到主体 → 跑一次真 chat →
 * `chat_runs.skills_snapshot` 里必须冻结这 2 项**。
 *
 * 为什么走工作区作用域：`SkillController.importSkills` 的授权是
 * `guard.canWriteDefinitionScope(scope.type(), scope.id())` —— `definitionScope.type = "workspace"`
 * 时只需要"对该工作区有写权限"，**不需要 instance 管理员**（LAB 里造 admin 是多余步骤）。
 *
 * 顺序按 `BL-352` 的教训（先首绑再建会话/绑技能）：
 *   ① 注册 journey 用户（helper 内建 direct_attach + hostPath 的工作区）⇒ 自己是 OWNER
 *   ② 建 agent 主体（带 `X-Workspace-Id`）⇒ 201
 *   ③ 首绑 `PUT /workspaces/{ws}/agents/{pid}` ⇒ 200（BL-349 修复后必过）
 *   ④ `POST /api/v1/skills/import`（workspace 作用域，2 个技能）⇒ 200，拿 2 个 skillId
 *   ⑤ `POST /api/v1/agent-principals/{pid}/skills?workspaceId={ws}` ×2（body 只许 `skillId`）⇒ 201 ×2
 *   ⑥ `POST /workspaces/{ws}/sessions`（agentPrincipalId）⇒ 201
 *   ⑦ SSE 订阅 + `POST /api/v1/chat` ⇒ 202，轮询 `chat_runs.status` 到终态
 *   ⑧ 断言 `skills_snapshot`：非 `{}`，恰好含这 2 个 skillId，且 run 的 `agent_principal_id = pid`
 *   ⑨ 反向对照：解绑其中一个 ⇒ 再跑一次 run ⇒ 快照只剩 1 项（证明快照随绑定变化，不是常量）
 *
 * 判据不过就报"未验证 + 原因"，**不改断言凑绿**。
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
import { CP_URL, getRootBranchId, registerJourneyUser } from "./helpers/journey";

test.describe.configure({ retries: 0 });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** chat run 终态（与 capacity/checkpoint 系列 spec 同一口径）。 */
const TERMINAL = /^(succeeded|failed|cancelled|ambiguous)$/u;

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

test("@host PLAN-0678 V3 技能正向：工作区导入 2 技能 → 绑定 → chat run 快照冻结 2 项（含反向对照）", async ({
    request,
}) => {
    // ① 注册（helper 内建 direct_attach + hostPath 工作区）⇒ OWNER
    const owner = await registerJourneyUser(request, "p0678-skills");
    const workspaceId = owner.workspaceId;
    const headers = { ...owner.headers, "X-Workspace-Id": workspaceId };
    // chat 需要可用 provider（BL-346 教训：没有 READY 连接时 POST /sessions 解析不到 profile）
    await ensureFakeUserProvider(request, {
        accessToken: owner.authToken,
        workspaceId,
    });

    // ②③ 建主体 + 首绑（首绑必须先于任何"绑定类端点"，BL-352 门 1）
    const principalId = await provisionWorkspaceAgentPrincipal(
        request,
        { accessToken: owner.authToken, workspaceId },
        { name: `AgentP0678Skills${Date.now().toString(36)}`, actions: ["read"] },
    );
    expect(principalId).toMatch(UUID);

    // ④ 导入 2 个技能（workspace 作用域 ⇒ 只需工作区写权限）
    const imported = await request.post(`${CP_URL}/api/v1/skills/import`, {
        headers,
        data: { definitionScope: { type: "workspace", workspaceId }, skills: SKILLS },
    });
    const importedText = await imported.text();
    expect(
        imported.status(),
        `skills/import 应 200，实际 ${imported.status()}：${importedText}` +
            "；若 403 且 code=MANAGE_SKILL_LIBRARY ⇒ 停手报 Lead（需 psql 提权配方，不要改断言）",
    ).toBe(200);
    const importedBody = JSON.parse(importedText) as {
        results?: Array<{ skillId: string; name: string; action: string }>;
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

    // ⑤ 绑 2 个技能（一次一个，body 只许 skillId）
    const bindingIds: string[] = [];
    for (const skillId of skillIds) {
        const bind = await request.post(
            `${CP_URL}/api/v1/agent-principals/${principalId}/skills?workspaceId=${workspaceId}`,
            { headers, data: { skillId } },
        );
        const bindText = await bind.text();
        expect(
            bind.status(),
            `绑定技能 ${skillId} 应 201，实际 ${bind.status()}：${bindText}`,
        ).toBe(201);
        bindingIds.push((JSON.parse(bindText) as { id?: string }).id ?? "");
    }

    // ⑥ 建会话（agentPrincipalId 必须显式携带）
    const sessionId = await createSessionWithPrincipal(
        request,
        { accessToken: owner.authToken, workspaceId },
        { principalId, title: "PLAN-0678 V3 skills positive", workspaceId },
    );

    // ⑦ 跑第一次 run（绑 2 个技能）
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

    // ⑧ 判据 1/3：快照非空、恰好含这 2 个 skillId、run 归属正确
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

    // ⑨ 反向对照：解绑 beta ⇒ 再跑一次 ⇒ 快照只剩 1 项（证明快照随绑定变化，不是常量）
    const betaSkillId = skillIds[1];
    const betaBindingId = bindingIds[1];
    const unbind = await request.delete(
        `${CP_URL}/api/v1/agent-principals/${principalId}/skills/${betaBindingId}?workspaceId=${workspaceId}`,
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
            `snapshot1Bytes=${snapshot.length} snapshot2Bytes=${snapshot2.length}`,
    );
});
