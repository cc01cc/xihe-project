/**
 * PLAN-0680 T3.1 — 技能绑定双轴 **快照 tier 成功链**真栈 spec（`@host`）
 *
 * 对应任务：`tasks.md:32` T3.1「host E2E 单 spec（成功链）：J1 + J2（绑定 → run →
 *   快照 tier 三字段 → 解绑 → 快照少一项）」。
 * 对应判据：`verify.md:14` **V2「快照落双轴 tier」**——
 *   该 run `skills_snapshot.items[]` 含该 skill 且 `tier.scopeType='workspace'`、
 *   `tier.subjectType='agent_principal'`（host E2E 断言快照 JSON）；解绑后快照少一项。
 *   判据原文期望（`verify.md:16`）：`tier={subjectType:'agent_principal',
 *   scopeType:'workspace', definitionScopeType:…}`。
 *
 * 为什么必须有这条：现有 `plan0680-skill-dual-axis.spec.ts` 覆盖 J1/J2/J3/J8/J9，
 *   但**没有任何一条读 `skills_snapshot`**——绑定写入面绿了不等于 run 时真的把
 *   双轴 tier 冻结进快照。tier 三字段是本 PLAN 的核心产物，只能靠跑真 chat 验证。
 *
 * 栈前条件（窗口期缺一不可）：
 *   1. 隔离栈经 `scripts/e2e-host.mjs` 启动，注入 `XIHE_E2E_PG_CONTAINER` /
 *      `XIHE_E2E_PG_DATABASE` / `XIHE_E2E_PG_USER`（读 `chat_runs` 用 psql 直连隔离库，
 *      与 `plan0678-skills-positive.spec.ts` 同口径）。
 *   2. CP `/actuator/health` == 200，Agent 已就绪（chat 会真派发到 fake provider）。
 *   3. `ensureFakeUserProvider` 能在新注册身份上装好 fake provider（本 spec 自建身份，
 *      不依赖预置种子用户）。
 *   4. instance 作用域技能导入需要 SUPER_ADMIN 授权——本 spec 走 API 导入 + 主体绑定，
 *      **不提权 psql 写 grants**（那是 0678 的绕过手法，0680 不接管）；若窗口实测
 *      该身份无 `MANAGE_SKILL_LIBRARY`，本 spec 的导入段会 403，届时按实测改种子，
 *      **不改断言凑绿**。
 *
 * 运行（窗口期）：`mise run test:e2e:host -- --spec packages/ui/e2e/real/plan0680-skill-tier-snapshot.spec.ts`
 * 实施期不启栈、不跑浏览器；本文件只保证 `--list` 通过。
 *
 * 冻结语义来源：`spec/agent/principal-workspace-binding.md:72-125`「技能绑定双轴（PLAN-0680 增补）」
 *   `:74-84` 档位由服务端派生（workspace 上下文 ⇒ `workspace(caller.workspaceId)`）；
 *   `:118` UI 徽标 testid；tier 三字段的 wire 形状见 `docs/api/openapi.yaml`
 *   `AgentPrincipalSkillBindingView` 与 `chat_runs.skills_snapshot` 的 items schema。
 */
import { execFileSync } from "node:child_process";

import { expect, test, type APIRequestContext } from "@playwright/test";

import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";
import { agentName } from "./helpers/agent-name";
import { ensureFakeUserProvider } from "./helpers/fake-provider";
import { CP_URL, getRootBranchId } from "./helpers/journey";
import { openSessionSse } from "./helpers/sse";
import { ensureWorkspace } from "./helpers/workspace";

test.describe.configure({ retries: 0 });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** chat run 终态（与 capacity/checkpoint 系列 spec 同一口径）。 */
const TERMINAL = /^(succeeded|failed|cancelled|ambiguous)$/u;

/** 技能绑定写入面（agent-principal 侧）。 */
const SKILL_BINDING_PATH = (principalId: string, workspaceId: string): string =>
    `${CP_URL}/api/v1/agent-principals/${principalId}/skills?workspaceId=${workspaceId}`;

interface Identity {
    email: string;
    userId: string;
    accessToken: string;
    workspaceId: string;
}

/** 注册 + 建 direct_attach 工作区 + fake provider（照抄 `plan0680-skill-dual-axis.spec.ts:57-79`）。 */
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
 * 直连隔离库读 `chat_runs`（照抄 `plan0678-skills-positive.spec.ts:52-66`）。
 * 快照是 CP 写入的 durable 记录，没有等价的公开读端点；不经此路无法断言 tier。
 */
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

interface SnapshotItem {
    skillId?: string;
    name?: string;
    tier?: {
        subjectType?: string;
        scopeType?: string;
        definitionScopeType?: string;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

interface ChatRunRow {
    id: string;
    status: string;
    skillsSnapshot: string;
}

/** 取某会话最近一次 run 的关键列（一次查询拿全，避免多次轮询漂移）。 */
function latestRun(sessionId: string): ChatRunRow | null {
    const raw = queryIsolatedPostgres(
        `SELECT json_build_object('id', id, 'status', status, ` +
            `'skillsSnapshot', skills_snapshot::text)::text FROM chat_runs ` +
            `WHERE session_id = '${sessionId}'::uuid ORDER BY created_at DESC LIMIT 1`,
    );
    if (!raw) return null;
    return JSON.parse(raw) as ChatRunRow;
}

/** `skills_snapshot` 的 items 数组；`{}` 表示未捕获，不是「空清单」。 */
function snapshotItems(snapshot: string): SnapshotItem[] {
    const parsed = JSON.parse(snapshot) as { items?: SnapshotItem[] };
    return Array.isArray(parsed.items) ? parsed.items : [];
}

/** 同 `plan0678:sendChat`：先挂 SSE 再派发 chat（CP 要求订阅存在）。 */
async function sendChat(
    request: APIRequestContext,
    identity: Identity,
    sessionId: string,
    content: string,
): Promise<void> {
    const headers = headersOf(identity);
    const branchId = await getRootBranchId(request, sessionId, headers);
    // `openSessionSse(sessionId, token, extraHeaders)` 返回的是关闭函数，不是带 close() 的句柄
    const closeSse = await openSessionSse(sessionId, identity.accessToken);
    const chat = await request.post(`${CP_URL}/api/v1/chat`, {
        headers,
        data: { sessionId, branchId, content, toolMode: "chat" },
    });
    expect(chat.status(), await chat.text()).toBe(202);
    closeSse();
}

/** 轮询 `chat_runs.status` 到终态并返回该行。 */
async function waitForRun(sessionId: string): Promise<ChatRunRow> {
    const deadline = Date.now() + 60_000;
    let row: ChatRunRow | null = null;
    while (Date.now() < deadline) {
        row = latestRun(sessionId);
        if (row && TERMINAL.test(row.status)) return row;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(row, "chat_runs 里应能查到该会话的 run").not.toBeNull();
    expect(row!.status, "run 应到终态").toMatch(TERMINAL);
    return row!;
}

test("@host 0680-T3.1 快照落双轴 tier：绑定 → run → skills_snapshot.items[].tier 三字段 → 解绑 → 快照少一项", async ({
    request,
}) => {
    const identity = await newIdentity(request, "p0680-tier");
    const principalId = await provisionWorkspaceAgentPrincipal(request, identity, {
        name: agentName("P0680Tier", Date.now()),
        actions: ["read"],
    });
    expect(principalId, "主体 id 应为 UUID").toMatch(UUID);

    // ① 导入一个 instance 作用域技能（绑定面只接受 instance 定义，见 SPEC :92-94）
    const nonce = Date.now().toString(36);
    const imported = await request.post(`${CP_URL}/api/v1/skills/import`, {
        headers: headersOf(identity),
        data: {
            definitionScope: { type: "instance" },
            skills: [
                {
                    name: `p0680-tier-${nonce}`,
                    description: "PLAN-0680 T3.1 快照 tier 探针",
                    body: `# p0680 tier probe ${nonce}\n用于验证 skills_snapshot.items[].tier 三字段。`,
                    trusted: false,
                  },
            ],
        },
    });
    expect(
        [200, 201],
        `技能导入应 2xx，实际 ${imported.status()}：${await imported.text()}`,
    ).toContain(imported.status());
    const importedBody = (await imported.json()) as {
        skills?: Array<{ id?: string }>;
        ids?: string[];
        id?: string;
    };
    const skillId = importedBody.skills?.[0]?.id ?? importedBody.ids?.[0] ?? importedBody.id;
    expect(skillId, "导入响应应带 skillId").toMatch(UUID);

    // ② 绑到主体（workspace 上下文 ⇒ 服务端派生 workspace 档，body 只允许 skillId）
    const bound = await request.post(SKILL_BINDING_PATH(principalId, identity.workspaceId), {
        headers: headersOf(identity),
        data: { skillId },
    });
    const boundText = await bound.text();
    expect([200, 201], `主体技能绑定应 2xx，实际 ${bound.status()}：${boundText}`).toContain(
        bound.status(),
    );
    const bindingId = (JSON.parse(boundText) as { id?: string; bindingId?: string }).id ??
        (JSON.parse(boundText) as { bindingId?: string }).bindingId;
    expect(bindingId, "绑定响应应带 bindingId").toMatch(UUID);

    // ③ 建会话 + 跑一次真 chat
    const sessionId = await createSessionWithPrincipal(request, identity, {
        principalId,
        workspaceId: identity.workspaceId,
        title: "PLAN-0680 T3.1 tier snapshot",
    });
    await sendChat(request, identity, sessionId, "PLAN-0680 T3.1 tier probe run");

    const run = await waitForRun(sessionId);
    expect(run.status, "本条断言要求 run 成功，否则快照不产生").toBe("succeeded");
    expect(
        run.skillsSnapshot,
        "skills_snapshot 不应是 {}（{} 只表示未捕获）",
    ).not.toBe("{}");

    // ④ V2 核心：tier 三字段
    const items = snapshotItems(run.skillsSnapshot);
    const hit = items.find((item) => item.skillId === skillId);
    expect(hit, `快照 items 应含刚绑的 skill ${skillId}`).toBeDefined();
    expect(hit!.tier, "快照项应带 tier 对象").toBeDefined();
    expect(hit!.tier!.subjectType, "tier.subjectType 应为 agent_principal").toBe(
        "agent_principal",
    );
    expect(hit!.tier!.scopeType, "tier.scopeType 应为 workspace（服务端派生，非请求体）").toBe(
        "workspace",
    );
    expect(
        hit!.tier!.definitionScopeType,
        "tier.definitionScopeType 应为 instance（技能定义本身是实例级）",
    ).toBe("instance");
    const countBeforeUnbind = items.length;

    // ⑤ 解绑 → 再跑 → 快照少一项（T3.1 的另一半）
    const deleted = await request.delete(
        `${SKILL_BINDING_PATH(principalId, identity.workspaceId)}/${String(bindingId)}`,
        { headers: headersOf(identity) },
    );
    const deletedText = await deleted.text();
    expect(
        deleted.status(),
        `解绑应 204，实际 ${deleted.status()}：${deletedText}`,
    ).toBe(204);

    await sendChat(request, identity, sessionId, "PLAN-0680 T3.1 tier probe run 2");
    const run2 = await waitForRun(sessionId);
    expect(run2.id, "第二次 run 应是新行").not.toBe(run.id);
    const items2 = snapshotItems(run2.skillsSnapshot);
    expect(items2.length, "解绑后快照应比前一次少一项").toBe(countBeforeUnbind - 1);
    expect(
        items2.some((item) => item.skillId === skillId),
        "解绑后的快照不应再含该 skill",
    ).toBe(false);
});
