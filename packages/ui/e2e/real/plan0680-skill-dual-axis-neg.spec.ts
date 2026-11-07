/**
 * PLAN-0680 T3.2 — 技能绑定双轴 **跨工作区负例**真栈 spec（`@host`）
 *
 * 对应任务：`tasks.md:33` T3.2「host E2E 负例：J3 跨工作区不生效 + J8 BL-354 场景注记」。
 * 对应判据：
 *   - `verify.md:18` **V3「跨工作区负例」**：W1 的 workspace 技能/绑定行**不出现在 W2 注入**；
 *     对 W2 私有定义绑定 ⇒ **404 `SKILL_NOT_FOUND`**（非旧 400）。
 *     判据原文（`verify.md:20`）：契约测试断 404 `SKILL_NOT_FOUND` 且不泄露存在性；
 *     E2E 断 W2 的 `skills_snapshot` 不含 W1 workspace 行/skill。
 *     V3 的「404 半」已由 `AgentPrincipalSkillBindingContractTest
 *     #otherWorkspacePrivateDefinitionIsNotFoundUnderOwnWorkspaceContext` 在 L0 闭合
 *     （`evidence/t4-local-l0.md` §1）；**本文件负责「注入半」**——即隔离在**运行期**
 *     是否真的成立，而不是只在写入面被拒。
 *   - `verify.md:38` **V8「BL-354 不可判定」**：continuation 场景的快照断言标记为
 *     **不可判定**，不得当成绿。本文件用 `test.fixme` 承载该注记（下方 §J8），
 *     理由写在注释里，窗口期若 BL-354 关闭则取消 fixme 并补断言。
 *
 * 为什么必须有这条：写入面 404 只能证明「绑不上」，证明不了「别的 workspace 的
 *   绑定行不会漏进本 workspace 的注入」。后者要靠真跑 chat 读快照才能证伪。
 *   J1（`plan0680-skill-dual-axis.spec.ts:89`）测的是「绑他 ws 私有定义 ⇒ 404」，
 *   与本文件的「注入不越界」是**两个方向**，不能互相替代。
 *
 * 栈前条件（窗口期缺一不可）：
 *   1. 隔离栈经 `scripts/e2e-host.mjs` 启动，注入 `XIHE_E2E_PG_CONTAINER` /
 *      `XIHE_E2E_PG_DATABASE` / `XIHE_E2E_PG_USER`（读 `chat_runs.skills_snapshot`）。
 *   2. CP + Agent 就绪，`ensureFakeUserProvider` 可为自建身份装 fake provider。
 *   3. 需**两个互相隔离的工作区**（W1/W2）各自有自己的登记用户：本 spec 用两次
 *      `newIdentity` 自建，W2 用户对 W1 **非成员**——这是「跨工作区」的前提，
 *      若窗口期的隔离栈把两者拉进同一实例管理员身份，本 spec 的前置断言会先红。
 *   4. workspace 私有技能定义需要 W1 用户具备 `MANAGE_SKILL_LIBRARY`（workspace 档）；
 *      若窗口实测 403，按实测改种子，**不改断言凑绿**。
 *
 * 运行（窗口期）：`mise run test:e2e:host -- --spec packages/ui/e2e/real/plan0680-skill-dual-axis-neg.spec.ts`
 * 实施期不启栈、不跑浏览器；本文件只保证 `--list` 通过。文件名沿用
 * `verify.md:19` 已经写死的 `plan0680-skill-dual-axis-neg.spec.ts`，不要再起别名。
 *
 * 冻结语义来源：`spec/agent/principal-workspace-binding.md:98-100`——
 *   「W1 的 workspace 绑定行在 W2 注入中不出现；绑他工作区私有定义 ⇒ 404 SKILL_NOT_FOUND」。
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
const TERMINAL = /^(succeeded|failed|cancelled|ambiguous)$/u;
const SKILL_BINDING_PATH = (principalId: string, workspaceId: string): string =>
    `${CP_URL}/api/v1/agent-principals/${principalId}/skills?workspaceId=${workspaceId}`;
interface Identity {
    email: string;
    userId: string;
    accessToken: string;
    workspaceId: string;
}
/** 注册 + 建 direct_attach 工作区 + fake provider（与同族 spec 同一实现）。 */
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
/** 直连隔离库读 `chat_runs`；快照无等价公开读端点。 */
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
    tier?: { subjectType?: string; scopeType?: string; definitionScopeType?: string };
}
function latestSnapshot(sessionId: string): { id: string; status: string; items: SnapshotItem[] } {
    const raw = queryIsolatedPostgres(
        `SELECT json_build_object('id', id, 'status', status, 'snap', skills_snapshot::text)::text ` +
            `FROM chat_runs WHERE session_id = '${sessionId}'::uuid ` +
            `ORDER BY created_at DESC LIMIT 1`,
    );
    if (!raw) {
        return { id: "", status: "", items: [] };
    }
    const row = JSON.parse(raw) as { id: string; status: string; snap: string };
    let items: SnapshotItem[] = [];
    if (row.snap && row.snap !== "{}") {
        const parsed = JSON.parse(row.snap) as { items?: SnapshotItem[] };
        if (Array.isArray(parsed.items)) items = parsed.items;
    }
    return { id: row.id, status: row.status, items };
}
/** 严格轮询到终态（不用固定 sleep，见 packages/ui/AGENTS.md「新 E2E 禁止固定 sleep」）。 */
async function waitForSnapshot(sessionId: string): Promise<{
    id: string;
    status: string;
    items: SnapshotItem[];
}> {
    const deadline = Date.now() + 60_000;
    let last = latestSnapshot(sessionId);
    while (Date.now() < deadline) {
        last = latestSnapshot(sessionId);
        if (last.id && TERMINAL.test(last.status)) return last;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(last.status, "run 应到终态（超时则窗口期查 Agent 是否卡住）").toMatch(TERMINAL);
    return last;
}
async function sendChat(
    request: APIRequestContext,
    identity: Identity,
    sessionId: string,
    content: string,
): Promise<void> {
    const headers = headersOf(identity);
    const branchId = await getRootBranchId(request, sessionId, headers);
    // `openSessionSse(sessionId, token, extraHeaders)` 返回关闭函数，不是带 close() 的句柄
    const closeSse = await openSessionSse(sessionId, identity.accessToken);
    const chat = await request.post(`${CP_URL}/api/v1/chat`, {
        headers,
        data: { sessionId, branchId, content, toolMode: "chat" },
    });
    expect(chat.status(), await chat.text()).toBe(202);
    closeSse();
}
test("@host 0680-T3.2a 注入不越界：W1 的 workspace 技能与绑定行不出现在 W2 的 skills_snapshot", async ({
    request,
}) => {
    // 两个互相隔离的身份 ⇒ 两个独立工作区，W2 对 W1 非成员（跨工作区前提）
    const w1 = await newIdentity(request, "p0680-neg-w1");
    const w2 = await newIdentity(request, "p0680-neg-w2");
    expect(w1.workspaceId, "两个身份必须落在不同工作区，否则本 spec 前提不成立").not.toBe(
        w2.workspaceId,
    );
    const w1Principal = await provisionWorkspaceAgentPrincipal(request, w1, {
            name: agentName("P0680NegW1", Date.now()),
            actions: ["read"],
        });
    const w2Principal = await provisionWorkspaceAgentPrincipal(request, w2, {
            name: agentName("P0680NegW2", Date.now()),
            actions: ["read"],
        });
    // ① W1 导入一个 **workspace 作用域**私有技能定义（这是跨工作区隔离的被测对象）
    const nonce = Date.now().toString(36);
    const skillName = `p0680-neg-w1-${nonce}`;
    const imported = await request.post(`${CP_URL}/api/v1/skills/import`, {
        headers: headersOf(w1),
        data: {
            definitionScope: { type: "workspace", workspaceId: w1.workspaceId },
            skills: [
                {
                    name: skillName,
                    description: "PLAN-0680 T3.2 跨工作区隔离探针（W1 私有）",
                    body: `# ${skillName}\n只应在 W1 生效，不得出现在 W2 注入。`,
                    trusted: false,
                  },
            ],
        },
    });
    expect(
        [200, 201],
        `W1 私有技能导入应 2xx，实际 ${imported.status()}：${await imported.text()}`,
    ).toContain(imported.status());
    const importedBody = (await imported.json()) as {
        skills?: Array<{ id?: string }>;
        ids?: string[];
        id?: string;
    };
    const w1SkillId = importedBody.skills?.[0]?.id ?? importedBody.ids?.[0] ?? importedBody.id;
    expect(w1SkillId, "导入响应应带 skillId").toMatch(UUID);
    // ② 绑到 W1 的 principal（写入面成功，隔离要看运行期）
    const bound = await request.post(SKILL_BINDING_PATH(w1Principal, w1.workspaceId), {
        headers: headersOf(w1),
        data: { skillId: w1SkillId },
    });
    expect(
        [200, 201],
        `W1 主体绑定应 2xx，实际 ${bound.status()}：${await bound.text()}`,
    ).toContain(bound.status());
    // ③ W2 跑一次 chat
    const w2Session = await createSessionWithPrincipal(request, w2, {
            principalId: w2Principal,
            workspaceId: w2.workspaceId,
            title: "PLAN-0680 T3.2 cross-workspace isolation",
        });
    await sendChat(request, w2, w2Session, "PLAN-0680 T3.2 isolation probe");
    const w2Snap = await waitForSnapshot(w2Session);
    // ④ V3 注入半：W2 的快照既不含 W1 的 skillId、也不含其名字、更不该有 W1 workspace tier 行
    expect(
        w2Snap.items.some((item) => item.skillId === w1SkillId),
        `W2 的 skills_snapshot 不应含 W1 私有技能 ${w1SkillId}（跨工作区泄漏）`,
    ).toBe(false);
    expect(
        w2Snap.items.some((item) => item.name === skillName),
        `W2 的 skills_snapshot 不应含 W1 私有技能名 ${skillName}`,
    ).toBe(false);
    expect(
        w2Snap.items.some(
            (item) =>
                item.tier?.scopeType === "workspace" &&
                item.tier?.definitionScopeType === "workspace",
        ),
        "W2 不应拿到任何 workspace×workspace 档技能（本用例里唯一来源是 W1）",
    ).toBe(false);
    // ⑤ 反向对照：W1 自己跑，同一 skill 必须出现——证明 ③④ 的「不出现」不是因为压根没生效
    const w1Session = await createSessionWithPrincipal(request, w1, {
            principalId: w1Principal,
            workspaceId: w1.workspaceId,
            title: "PLAN-0680 T3.2 positive control",
        });
    await sendChat(request, w1, w1Session, "PLAN-0680 T3.2 positive control");
    const w1Snap = await waitForSnapshot(w1Session);
    expect(
        w1Snap.items.some((item) => item.skillId === w1SkillId),
        `正向对照失败：W1 自己的快照里应含 ${w1SkillId}，否则 W2 的「不含」无意义`,
    ).toBe(true);
});
test("@host 0680-T3.2b 对 W2 私有定义绑定 ⇒ 404 SKILL_NOT_FOUND（非旧 400，且不泄露存在性）", async ({
    request,
}) => {
    const w1 = await newIdentity(request, "p0680-404-w1");
    const w2 = await newIdentity(request, "p0680-404-w2");
    const w1Principal = await provisionWorkspaceAgentPrincipal(request, w1, {
            name: agentName("P0680Neg404", Date.now()),
            actions: ["read"],
        });
    // W2 的私有定义
    const nonce = Date.now().toString(36);
    const imported = await request.post(`${CP_URL}/api/v1/skills/import`, {
        headers: headersOf(w2),
        data: {
            definitionScope: { type: "workspace", workspaceId: w2.workspaceId },
            skills: [
                {
                    name: `p0680-404-w2-${nonce}`,
                    description: "PLAN-0680 T3.2 404 探针（W2 私有）",
                    body: `# p0680-404-w2-${nonce}`,
                    trusted: false,
                },
            ],
        },
    });
    expect([200, 201], await imported.text()).toContain(imported.status());
    const importedBody = (await imported.json()) as {
        skills?: Array<{ id?: string }>;
        ids?: string[];
        id?: string;
    };
    const w2SkillId = importedBody.skills?.[0]?.id ?? importedBody.ids?.[0] ?? importedBody.id;
    expect(w2SkillId, "导入响应应带 skillId").toMatch(UUID);
    // W1（在 W1 上下文里）去绑 W2 的私有定义 ⇒ 必须 404，不是 400
    const refused = await request.post(SKILL_BINDING_PATH(w1Principal, w1.workspaceId), {
        headers: headersOf(w1),
        data: { skillId: w2SkillId },
    });
    expect(
        refused.status(),
        `绑他工作区私有定义应 404（旧 400 SKILL_DEFINITION_OUT_OF_SCOPE 已在本面退役），` +
            `实际 ${refused.status()}：${await refused.text()}`,
    ).toBe(404);
    const problem = (await refused.json()) as { code?: string };
    expect(
        problem.code,
        "404 的 code 必须是 SKILL_NOT_FOUND——与「技能不存在」不可区分才不泄露存在性",
    ).toBe("SKILL_NOT_FOUND");
    // 防退化：不得再出现退役码
    expect(
        problem.code,
        "旧码 SKILL_DEFINITION_OUT_OF_SCOPE 已在本面退役，不应被任何路径返回",
    ).not.toBe("SKILL_DEFINITION_OUT_OF_SCOPE");
});
/**
 * §J8 — BL-354 场景注记（`verify.md:38` V8「BL-354 不可判定」）。
 *
 * 为什么是 `test.fixme` 而不是写死断言：BL-354 未关闭前，continuation（后续轮次）
 * 场景下 `skills_snapshot` 的取值语义**没有冻结结论**——快照是每轮重算还是沿用首轮，
 * 决定了「解绑后再续接」到底应该「少一项」还是「保持原样」。两种都可能被解释成
 * 正确实现，此时写任何断言都是把未定语义钉成绿，属假绿。
 *
 * 关闭条件：BL-354 关闭 + design/verify 写明 continuation 语义后，取消 fixme，
 * 按冻结语义补断言，并把 `verify.md:38` 的 V8 一并判过。
 */
test.fixme(
    "@host 0680-T3.2c J8 BL-354 continuation 场景快照语义（不可判定，待 BL-354 关闭）",
    async () => {
        // 意图（BL-354 关闭后照此实现）：
        //   1. 绑定 skillA → 跑首轮 → 断快照含 skillA
        //   2. 解绑 skillA → 在同一会话里发第二轮（continuation，不新建 session）
        //   3. 断言：快照按冻结语义要么「少一项」（每轮重算）要么「保持原样」（沿用首轮）
        //   4. 两种语义各写什么断言，等 design 裁定；现在写死任一种都会变成假绿
        expect(true, "本用例当前不可判定，见上方注释与 BL-354").toBe(true);
    },
);
