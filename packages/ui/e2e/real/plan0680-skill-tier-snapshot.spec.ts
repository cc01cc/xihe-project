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
 *   4. **【D-67 supersede】instance 作用域技能导入需要 instance admin**（`SkillImportService:80-92`
 *      实证：`instance ⇒ instance admin`，否则 403 `SKILL_IMPORT_FORBIDDEN`）。
 *      **403 是正确产品行为，不是缺陷**；0680 的被测面是**绑定 / 快照 / 层级**，不是导入授权。
 *      因此本 spec 在**隔离库**落一行授权种子作为**夹具前置**：
 *      `role_bindings(SUPER_ADMIN, instance)` + **`grants`（`MANAGE_SKILL_LIBRARY`@`*`,
 *      `source=role`, instance）** —— 后者才是真正生效的物化授权（`RequesterAuthority`
 *      读 `grants`，只写前者仍 403，`host-e2e` 坑表 §19），随后重新 `POST /auth/login` 取新 token。
 *      **为什么不是"绕过被测面"**：CP 无 role-binding/grant 的 HTTP 写面（openapi 仅
 *      `/api/v1/roles*` 只读目录）；`DataSeeder` 的 admin 依赖 `XIHE_DEV_ADMIN_PASSWORD`
 *      而隔离栈未注入 ⇒ 无正常路径可授。
 *      **本 spec 的授权种子仅属夹具前置，不改被测断言**；**不改断言凑绿**（此句仍然有效）。
 *      种子只对 `XIHE_E2E_PG_*` 指向的隔离库执行，库名以 `xihe-e2e` 前缀 **断言防呆**
 *      （不匹配直接 fail，绝不触碰 stack-1 的 `xihe_1`），随栈销毁。
 *
 * 运行（窗口期，`--spec` 不合法——spec 是**位置参数**，cwd = `packages/ui`）：
 *   `mise run test:e2e:host -- --report-name=plan0680-t3-1 --expect-tests=1 e2e/real/plan0680-skill-tier-snapshot.spec.ts`
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

/** `V87__dynamic_access_roles.sql:40-58` 的实例超管角色（照抄 `plan0678-skills-positive.spec.ts:50`）。 */
const SUPER_ADMIN_ROLE_ID = "00000000-0000-4000-8000-000000000001";

/**
 * **【D-67 夹具前置】** 在隔离库把受测身份提到 instance admin，并重新登录取新 token。
 *
 * - **为什么要直写 DB**：CP 无 role-binding / grant 的 HTTP 写面（`openapi.yaml` 只有
 *   `/api/v1/roles*` 只读目录）；`DataSeeder` 的 `admin@xihe.local` 依赖隔离栈未注入的
 *   `XIHE_DEV_ADMIN_PASSWORD` ⇒ 没有正常路径可授。**403 本身是正确产品行为**
 *   （`SkillImportService:80-92`：`instance ⇒ instance admin`），0680 的被测面是
 *   **绑定 / 快照 / 层级**，不是导入授权。
 * - **为什么两行缺一不可**：`role_bindings` 只是角色绑定记录；`RequesterAuthority
 *   .holdsActionAtom` 读的是**物化后的 `grants` 表**，只写前者仍会 403
 *   `SKILL_IMPORT_FORBIDDEN`（`host-e2e` 坑表 §19）。
 * - **安全边界（D-67 边界 1）**：库名**必须**以 `xihe_e2e` 前缀断言通过，否则直接 fail ——
 *   绝不触碰 stack-1 的 `xihe_1`。种子随隔离栈销毁。
 * - **不改被测断言**：本函数只准备前置数据，断言（`tier.definitionScopeType === "instance"`、
 *   200 判据、三字段）一字不动。
 */
async function escalateToInstanceAdmin(
    request: APIRequestContext,
    identity: Identity,
): Promise<Identity> {
    const database = process.env.XIHE_E2E_PG_DATABASE ?? "";
    expect(
        database.startsWith("xihe_e2e"),
        `D-67 边界：授权种子只允许落在隔离库，当前 XIHE_E2E_PG_DATABASE=${JSON.stringify(database)}`,
    ).toBe(true);

    // ① 角色绑定记录（缺它则 ② 的语义无处挂靠）
    queryIsolatedPostgres(
        `INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type, scope_id, granted_by) ` +
            `VALUES (gen_random_uuid(), '${SUPER_ADMIN_ROLE_ID}', 'user', '${identity.userId}', 'instance', NULL, NULL) ` +
            `ON CONFLICT DO NOTHING`,
    );
    // ② 真正生效的物化授权：instance 作用域的 MANAGE_SKILL_LIBRARY（JSON 形状见
    //    `GrantIntersectionEvaluator.PermissionAtom`：`{actionClass, resource}`）
    queryIsolatedPostgres(
        `INSERT INTO grants (id, subject_type, subject_id, permissions, source, scope_type, scope_id) ` +
            `VALUES (gen_random_uuid(), 'user', '${identity.userId}', ` +
            `'[{"actionClass":"MANAGE_SKILL_LIBRARY","resource":"*"}]'::jsonb, 'role', 'instance', NULL)`,
    );
    const granted = queryIsolatedPostgres(
        `SELECT count(*) FROM grants WHERE subject_id = '${identity.userId}'::uuid ` +
            `AND permissions::text LIKE '%MANAGE_SKILL_LIBRARY%' AND scope_type = 'instance'`,
    );
    expect(
        granted,
        `instance 作用域 MANAGE_SKILL_LIBRARY grant 应存在（实际 count=${granted}）`,
    ).toBe("1");

    // ③ 重新登录取新 token（token 里的权限面在签发时固化，旧 token 拿不到新 grant）
    const password = process.env.XIHE_E2E_PASSWORD ?? "XhE2e!plan0680dual1";
    const login = await request.post(`${CP_URL}/api/v1/auth/login`, {
        // 登录字段是 `identifier`（email 或 username），不是 `email`（PLAN-0565 裁定 #7）
        data: { identifier: identity.email, password },
    });
    const loginText = await login.text();
    expect(login.status(), `提权后重新登录应 200，实际 ${login.status()}：${loginText}`).toBe(200);
    const { accessToken } = JSON.parse(loginText) as { accessToken: string };
    expect(accessToken, "重新登录应返回 accessToken").toBeTruthy();
    return { ...identity, accessToken };
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
    // 【D-67 夹具前置】先注册身份，再在隔离库提权到 instance admin 并换新 token。
    // 这段只准备前置数据；下面所有断言（200 判据 / tier 三字段 / 解绑少一项）一字未动。
    const identity = await escalateToInstanceAdmin(
        request,
        await newIdentity(request, "p0680-tier"),
    );
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
    // 响应形状**照抄既有通过写法** `plan0678-skills-positive.spec.ts:219-232`：
    // CP `SkillController.importResponse()` 的 wire 字段是 `results[].skillId`
    //（`Outcome(UUID skillId, String name, String action, int version, …)`），
    // 不是 `skills[].id` / `ids[]` / `id` —— 那是凭想象的猜测，实测 `undefined`。
    const importedBody = (await imported.json()) as {
        results?: Array<{ skillId: string; name?: string }>;
        rejected?: Array<{ sourcePath?: string; code?: string; detail?: string }>;
    };
    const skillIds = (importedBody.results ?? []).map((row) => row.skillId);
    expect(
        importedBody.rejected ?? [],
        `导入不应有 rejected 行：${JSON.stringify(importedBody.rejected)}`,
    ).toEqual([]);
    expect(
        skillIds.length,
        `应导入 1 个技能，实际 results=${JSON.stringify(importedBody.results)}`,
    ).toEqual(1);
    const [skillId] = skillIds;
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
