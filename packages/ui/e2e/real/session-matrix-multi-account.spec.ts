// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
/**
 * PLAN-0658 R1 @host — 多人类账户矩阵（**从未真栈验过**的最高价值场景）。
 *
 * 真栈实测结论（2026-11-04，本 spec 首跑 + CP 源码核对）：
 *  - **会话本体读面是 owner-only**（BL-237）：`SessionController.get` 与
 *    `MessageController.listMessages` 都先走
 *    `SessionService.requireCurrent(sessionId, userId, workspaceId)`，而它按
 *    `id AND user_id AND workspace_id AND archived=false` 过滤（`SessionService:261`）——
 *    受邀人类参与者拿到的就是 `404 SESSION_NOT_FOUND`；
 *  - **参与者名册读面是多人类感知的**：`SessionParticipantService.requireVisibleSession`
 *    允许 owner / 受邀 HUMAN 参与者 / 可管理该工作区者，其余 403 `SESSION_ACCESS_DENIED`；
 *  - **人类参与者唤醒**（BL-238，T4.1 起已修复）：旧实现 wake 用 owner 身份走 `authorizeAsParticipant`，
 *    必然 `PARTICIPANT_CAP_DENIED` + `UnexpectedRollbackException`（BL-214 是其症状）；现按「人=通知」投递。
 *  两条都曾是 B 类（授权/通知语义变更），当时本 lane 不动产品、缺口项以 `test.fixme` 记录期望；
 *  现状（2026-11-07）：BL-237 已由 R1-a2〔PLAN-0668 转正〕、BL-238 已由 T4.1 打开 fixme 覆盖并转绿。
 *
 * 覆盖：
 *  1. R1-a 双账户互见 —— A（owner）发送后**A 的** messages 读面可见（wire + durable）；
 *  2. R1-a2〔PLAN-0668 转正〕B（受邀参与者）应能读同一会话消息；
 *  3. R1-b〔T4.1 打开 fixme · BL-238 已修复〕@ 对方 → 人类参与者收到 durable 通知（notify-only）；
 *  4. R1-c 抄送对方 → 202 + B 收到旁听通知（cursor 前进；cc 不走 wake 授权，故可达）；
 *  5. R1-d 旁观者（同工作区 VIEWER，非参与者）403 SESSION_ACCESS_DENIED；外部账户
 *     在租户层就被拦（403 WORKSPACE_FORBIDDEN）；
 *  6. R1-e〔PLAN-0668 转正〕B 登录后 UI 看到消息气泡；R1-a2n 负向矩阵。
 *
 * 硬约束（xh-host-e2e-pitfalls）：serial + retries 0；无固定 sleep；断言只认用户可感知结果与
 * 产品权威读面（messages/participants API），不做 in-page 绕过。
 *
 * SSE 门：`POST /api/v1/chat` 要求会话已有活跃 SSE 订阅（DEV-014），否则 409
 * `SSE_SUBSCRIPTION_REQUIRED`。本 spec 在 beforeAll 起一条订阅并保活到 afterAll。
 */
import {
    expect,
    test,
    type APIRequestContext,
    type APIResponse,
    type Page,
} from "@playwright/test";
import { CP_URL, getRootBranchId } from "./helpers/journey";
import { ensureWorkspace } from "./helpers/workspace";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";
import { agentName } from "./helpers/agent-name";
import { openSessionSse } from "./helpers/sse";
import { workspaceChatPath } from "../../src/lib/routes";
import { LONG_TIMEOUT_MS } from "../timeouts";

const NONCE = Date.now().toString(36);
const PASSWORD = process.env.XIHE_E2E_PASSWORD ?? "XhE2e!matrix1";
const FAKE_LLM_PORT = process.env.XIHE_FAKE_LLM_PORT ?? "";
const FAKE_LLM_MODEL = "fake-openai";
const FAKE_LLM_API_KEY = "sk-fake-openai-key";

interface Account {
    token: string;
    userId: string;
    /** Real login credentials (BL-237 seed fix: use the product login path in UI tests). */
    email: string;
    /** 加工作区成员按 username 寻址（`POST /workspaces/{id}/members`）。 */
    username: string;
    /** 人类参与者的 echo displayName（PLAN-0684/D-183：= 账号 username；@ 提及按 displayName 解析，见 MentionParser）。 */
    displayName: string;
    workspaceId: string;
    headers: Record<string, string>;
}

let owner: Account;
let member: Account;
let bystander: Account;
let outsider: Account;
let sessionId = "";
let principalId = "";
let rootBranchId = "";
let memberParticipantId = "";
let closeSse: (() => void) | null = null;

test.describe.configure({ mode: "serial", retries: 0 });

/** RFC 9457 problem body 的稳定码（断言只认 code，不认 status 猜语义）。 */
async function problemCode(response: APIResponse): Promise<string> {
    try {
        const body = JSON.parse(await response.text()) as { code?: string };
        return body.code ?? "";
    } catch {
        return "";
    }
}

async function registerAccount(request: APIRequestContext, label: string): Promise<Account> {
    const email = `${label}-${NONCE}-${Math.floor(Math.random() * 10000)}@test.com`;
    const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: { email, password: PASSWORD, name: label },
    });
    expect(response.status(), `register ${label}: ${await response.text()}`).toBe(201);
    const auth = (await response.json()) as { accessToken: string; user: { id: string } };
    const workspaceId = await ensureWorkspace(request, auth.accessToken);
    // 两个身份面别靠猜：登录响应的 user 视图不带 username（PLAN-0565 裁定 #7 由 email 派生）；
    // `POST /members` 按 **username** 寻址，@ 提及按参与者 echo **displayName** 解析
    // （MentionParser）。PLAN-0684/D-183 起 HUMAN echo displayName = 账号 username（单源，
    // user.name 不再参与投影）。`/auth/me` 是二者唯一的权威读面。
    const me = await request.get(`${CP_URL}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    expect(me.status(), "GET /api/v1/auth/me").toBe(200);
    const profile = (await me.json()) as { username?: string; name?: string };
    expect(profile.username, `username resolved for ${label}`).toBeTruthy();
    return {
        token: auth.accessToken,
        userId: auth.user.id,
        email,
        username: profile.username!,
        displayName: profile.username!,
        workspaceId,
        headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            "Content-Type": "application/json",
            "X-Workspace-Id": workspaceId,
        },
    };
}

/**
 * PLAN-0668 BL-299 前置（R1-e/R8-3 seed 修复）：走**产品真实登录**而不是假 storage seed。
 * 假 seed（`xihe-user.id="e2e-member"`、无 refresh token）与真实登录不等价，导致读面验证永远红。
 */
async function loginMemberInBrowser(page: Page): Promise<void> {
    await page.goto("/login");
    const boxes = page.getByRole("textbox");
    await boxes.nth(0).fill(member.email);
    await boxes.nth(1).fill(PASSWORD);
    // 某些浏览器/动画下 Enter 不触发提交（Playwright 实测），直接 requestSubmit。
    await page
        .locator("form")
        .first()
        .evaluate((form) => (form as HTMLFormElement).requestSubmit());
    await page.waitForURL(/\/workspace/, { timeout: LONG_TIMEOUT_MS });
}

/** 以某账户身份访问 owner 的 workspace（跨工作区成员需要显式上下文头）。 */
function inWorkspace(account: Account, workspaceId: string): Record<string, string> {
    return {
        Authorization: `Bearer ${account.token}`,
        "Content-Type": "application/json",
        "X-Workspace-Id": workspaceId,
    };
}

function messagesPath(branchId: string): string {
    return `${CP_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/messages?branchId=${encodeURIComponent(branchId)}`;
}

function participantsPath(): string {
    return `${CP_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/participants`;
}

/** B 的未读提及/通知游标（durable 投递证据：@ 与 cc 都会推进它）。 */
async function memberMentionCount(request: APIRequestContext): Promise<number> {
    const response = await request.get(participantsPath(), {
        headers: inWorkspace(member, owner.workspaceId),
    });
    if (!response.ok()) return -1;
    const payload = (await response.json()) as {
        participants?: Array<{
            participantId: string;
            readCursor?: { mentionCount?: number } | null;
        }>;
    };
    const mine = (payload.participants ?? []).find(
        (row) => row.participantId === memberParticipantId,
    );
    return mine?.readCursor?.mentionCount ?? 0;
}

test.describe("@host PLAN-0658 R1 多人类账户", () => {
    test.beforeAll(async ({ request }) => {
        expect(FAKE_LLM_PORT, "needs XIHE_FAKE_LLM_PORT (runner fake LLM)").not.toBe("");
        owner = await registerAccount(request, "r1-owner");
        member = await registerAccount(request, "r1-member");
        bystander = await registerAccount(request, "r1-bystander");
        outsider = await registerAccount(request, "r1-outsider");

        // 成员加入 owner 的工作区：member = EDITOR（会话参与者），bystander = VIEWER
        // （同工作区旁观者，**不**入会话）—— 后者才是"旁观者不可见"的判据。
        for (const [account, role] of [
            [member, "EDITOR"],
            [bystander, "VIEWER"],
        ] as const) {
            const add = await request.post(
                `${CP_URL}/api/v1/workspaces/${owner.workspaceId}/members`,
                {
                    headers: owner.headers,
                    // PLAN-0565: 规范角色 OWNER/EDITOR/VIEWER（legacy MEMBER 已废）
                    data: { username: account.username, role },
                },
            );
            expect(add.status(), `add ${role} member: ${add.status()} ${await add.text()}`).toBe(
                201,
            );
        }

        // owner 的 fake provider 连接（会话创建解析用；T1.1 同款配方）。
        const created = await request.post(`${CP_URL}/api/v1/provider-connections`, {
            headers: owner.headers,
            data: {
                providerId: "openai",
                apiTypeId: "openai-chat-completions",
                apiTypeVersion: 1,
                apiKey: FAKE_LLM_API_KEY,
                connectionKey: `r1-${NONCE}`,
                label: `R1 fake LLM (${NONCE})`,
                scope: "USER",
                modelDiscovery: "manual",
                manualModels: [FAKE_LLM_MODEL],
                baseUrl: `http://127.0.0.1:${FAKE_LLM_PORT}/openai/v1`,
            },
        });
        expect(created.status(), await created.text()).toBe(201);
        const connectionId = ((await created.json()) as { id: string }).id;
        const verified = await request.post(
            `${CP_URL}/api/v1/provider-connections/${connectionId}/verify`,
            { headers: owner.headers },
        );
        expect(verified.ok(), await verified.text()).toBe(true);

        principalId = await provisionWorkspaceAgentPrincipal(
            request,
            { accessToken: owner.token, workspaceId: owner.workspaceId },
            {
                name: agentName("R1", NONCE),
                actions: [],
                defaultModelProvider: "openai",
                defaultModelName: FAKE_LLM_MODEL,
            },
        );
        sessionId = await createSessionWithPrincipal(
            request,
            { accessToken: owner.token, workspaceId: owner.workspaceId },
            { principalId, title: `r1-matrix-${NONCE}` },
        );
        rootBranchId = await getRootBranchId(request, sessionId, owner.headers);

        // B 作为 HUMAN 参与人入会话（被 @ 才应答）。
        const participant = await request.post(participantsPath(), {
            headers: owner.headers,
            data: {
                principalKind: "HUMAN",
                principalId: member.userId,
                role: "MEMBER",
                wakePolicy: "MENTION",
                respondPolicy: "WHEN_MENTIONED",
            },
        });
        expect(
            participant.status(),
            `add participant: ${participant.status()} ${await participant.text()}`,
        ).toBe(201);
        memberParticipantId = ((await participant.json()) as { participantId: string })
            .participantId;

        // 产品门（DEV-014）：`POST /api/v1/chat` 先校验 `hasEmitter(sessionId)`，
        // 没有活跃订阅即 409 SSE_SUBSCRIPTION_REQUIRED —— 整条 spec 保活一条订阅。
        closeSse = await openSessionSse(sessionId, owner.token, {
            "X-Workspace-Id": owner.workspaceId,
        });
    });

    test.afterAll(() => {
        closeSse?.();
        closeSse = null;
    });

    test("R1-a 双账户互见：A 发送后 owner 读面可见（wire + durable）", async ({ request }) => {
        const content = `R1 互见 ${NONCE}`;
        const sent = await request.post(`${CP_URL}/api/v1/chat`, {
            headers: owner.headers,
            data: {
                sessionId,
                branchId: rootBranchId,
                content,
            },
        });
        expect(sent.status(), await sent.text()).toBe(202);
        const body = (await sent.json()) as { runId?: string };
        expect(body.runId ?? "", "run accepted").not.toBe("");

        await expect
            .poll(
                async () => {
                    const response = await request.get(messagesPath(rootBranchId), {
                        headers: owner.headers,
                    });
                    if (!response.ok()) return `http-${response.status()}`;
                    const payload = (await response.json()) as
                        | Array<{ content?: string }>
                        | { messages?: Array<{ content?: string }> };
                    const rows = Array.isArray(payload) ? payload : (payload.messages ?? []);
                    return rows.some((row) => row.content?.includes(content))
                        ? "visible"
                        : "not-yet";
                },
                { timeout: LONG_TIMEOUT_MS, intervals: [500, 1_000] },
            )
            .toBe("visible");
    });

    // BL-237（2026-11-04 登记，B 类待裁定）：会话读面 owner-only，名册读面却多人类感知。
    // `SessionController.get` / `MessageController.listMessages` 都先 `SessionService.requireCurrent`
    // （`SessionService:261`），按 `session.user_id = 调用者` 过滤 ⇒ 受邀参与者拿到
    // 404 SESSION_NOT_FOUND；而 `SessionParticipantService.requireVisibleSession` 已允许
    // owner/受邀 HUMAN/管理者读名册 ⇒「被 @ 到却看不到消息」。
    // 本项记录**期望行为**：读面加参与者分支后无需改断言即可转绿。
    test("R1-a2 受邀参与者应能读会话消息（BL-237：requireCurrent owner-only）", async ({
        request,
    }) => {
        const response = await request.get(messagesPath(rootBranchId), {
            headers: inWorkspace(member, owner.workspaceId),
        });
        expect(response.status(), "受邀参与者的消息读面").toBe(200);
        const payload = (await response.json()) as
            | Array<{ content?: string }>
            | { messages?: Array<{ content?: string }> };
        const rows = Array.isArray(payload) ? payload : (payload.messages ?? []);
        expect(
            rows.some((row) => row.content?.includes(`R1 互见 ${NONCE}`)),
            "参与者应能看到自己被通知的会话内容",
        ).toBe(true);
    });

    // PLAN-0668 D5：读面负向矩阵（与 R1-a2 同 describe，API 级）。实现已由 M1 的
    // SessionReadAccess.requireReadable 收敛；这里只钉"不可见一律 not-区分 404 / 未登录 401"。
    test("R1-a2n 非参与者/跨工作区/未登录均不可读消息（not-区分）", async ({ request }) => {
        // 1) 同 workspace 的 VIEWER 旁观者（不是 Session participant）
        const bystanderRead = await request.get(messagesPath(rootBranchId), {
            headers: inWorkspace(bystander, owner.workspaceId),
        });
        expect(bystanderRead.status(), "非参与者消息读面").toBe(404);
        expect(await problemCode(bystanderRead), "非参与者错误码").toBe("SESSION_NOT_FOUND");

        // 2) 跨工作区：member 用自己 workspace 的上下文读 owner workspace 的 Session
        const crossWorkspace = await request.get(messagesPath(rootBranchId), {
            headers: inWorkspace(member, member.workspaceId),
        });
        expect(crossWorkspace.status(), "跨工作区消息读面").toBe(404);
        expect(await problemCode(crossWorkspace), "跨工作区错误码").toBe("SESSION_NOT_FOUND");

        // 3) 未登录（不带 Authorization）
        const unauthenticated = await request.get(messagesPath(rootBranchId));
        expect(unauthenticated.status(), "未登录消息读面").toBe(401);
        expect(await problemCode(unauthenticated), "未登录错误码").toBe("AUTHORIZATION_REQUIRED");
    });
    // BL-238（2026-11-04 登记，B 类待裁定）：@ 人类参与者**永远叫不醒对方**。
    // `WakeFanOutService.runSerial` → `WakeDispatchService.fire()` 用
    // `authorizeAsParticipant(session.getUserId(), …, 参与人 id)` 做唤醒授权，即拿**会话 owner
    // 的身份**判断"能否以该参与者身份发言"；D23-08 对人类参与者的规则是"以别人身份发言 =
    // 冒充"⇒ 必然 `PARTICIPANT_CAP_DENIED`，`fire` 捕获后返回 refused，**`notifyHuman`
    // （人=通知：`wake_dispatch` notify，读面上表现为派生未读 +1 —— V112 起没有 `mention_count`
    // 列）根本走不到**。更糟的是捕获发生在
    // `@Transactional` 外层方法里、内层事务已被标记 rollback-only，实测 CP 记
    // `wake_handoff_dropped reason=UnexpectedRollbackException`（round
    // `wake:mention:d87ba33c…`：recipients=1 started=0 deferred=0 dropped=1），整轮 fan-out
    // 直接中断。BL-214（派生未读恒 0）是这条链的**症状**，不是独立缺陷。
    test("R1-b @ 对方：B 的提及游标累计（BL-238：wake 授权用 owner 身份 ⇒ 人类参与者恒 refused）", async ({
        request,
    }) => {
        const before = await memberMentionCount(request);
        expect(before, "B 作为受邀参与者可读名册（view=true）").toBeGreaterThanOrEqual(0);

        // @ 按 displayName 解析（MentionParser：@ 后接参与者 echo displayName + 边界；
        // PLAN-0684/D-183 起 echo displayName = 账号 username）。
        const sent = await request.post(`${CP_URL}/api/v1/chat`, {
            headers: owner.headers,
            data: {
                sessionId,
                branchId: rootBranchId,
                content: `@${member.displayName} 请看这条 ${NONCE}`,
            },
        });
        expect(sent.status(), await sent.text()).toBe(202);

        await expect
            .poll(() => memberMentionCount(request), {
                timeout: LONG_TIMEOUT_MS,
                intervals: [500, 1_000],
            })
            .toBeGreaterThan(before);
    });

    test("R1-c 抄送对方：cc 受理且 B 收到旁听通知（durable）", async ({ request }) => {
        const before = await memberMentionCount(request);
        const sent = await request.post(`${CP_URL}/api/v1/chat`, {
            headers: owner.headers,
            data: {
                sessionId,
                branchId: rootBranchId,
                content: `R1 CC ${NONCE}`,
                cc: [memberParticipantId],
            },
        });
        expect(sent.status(), await sent.text()).toBe(202);

        // 旁听语义（PLAN-0630 D30-14）：通知信号推进派生未读（`wake_dispatch` notify；V112 起无
        // `mention_count` 列），但不额外起 run。
        await expect
            .poll(() => memberMentionCount(request), {
                timeout: LONG_TIMEOUT_MS,
                intervals: [500, 1_000],
            })
            .toBeGreaterThan(before);
    });

    test("R1-d 旁观者/外部账户都读不到会话", async ({ request }) => {
        // 同工作区 VIEWER 但不是会话参与者：名册读面按能力原子拒绝（403 + 稳定码）。
        const byParticipant = await request.get(participantsPath(), {
            headers: inWorkspace(bystander, owner.workspaceId),
        });
        expect(byParticipant.status(), "bystander participants HTTP").toBe(403);
        expect(await problemCode(byParticipant), "bystander participants code").toBe(
            "SESSION_ACCESS_DENIED",
        );

        // 会话/消息读面 fail-closed 到 404（不暴露会话是否存在）。
        const bystanderMessages = await request.get(messagesPath(rootBranchId), {
            headers: inWorkspace(bystander, owner.workspaceId),
        });
        expect(bystanderMessages.status(), "bystander messages HTTP").toBe(404);
        expect(await problemCode(bystanderMessages)).toBe("SESSION_NOT_FOUND");
        const bystanderSession = await request.get(
            `${CP_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}`,
            { headers: inWorkspace(bystander, owner.workspaceId) },
        );
        expect(bystanderSession.status(), "bystander session HTTP").toBe(404);

        // 非同工作区账户更早被租户层拦下（连会话上下文都拿不到）。
        const outsiderParticipants = await request.get(participantsPath(), {
            headers: inWorkspace(outsider, owner.workspaceId),
        });
        expect(outsiderParticipants.status(), "outsider participants HTTP").toBe(403);
        expect(await problemCode(outsiderParticipants)).toBe("WORKSPACE_FORBIDDEN");
    });

    // BL-237 下游表现（同 R1-a2）：UI 的消息投影走 `GET /sessions/{id}/messages`，读面被
    // owner-only gate 挡住 ⇒ 受邀参与者登录后看不到会话内容（页签/输入框可能仍在）。
    // 读面放开即转绿。
    test("R1-e B 登录后 UI 可见消息气泡（BL-237 下游：消息投影被 owner-only gate 挡住）", async ({
        page,
    }) => {
        // 真实登录（BL-237 seed 修复）：假 storage seed 与真实登录不等价，会让本 spec 永远红。
        await loginMemberInBrowser(page);
        await page.goto(workspaceChatPath(owner.workspaceId, sessionId));
        await expect(page.getByTestId("chat-input"), "member composer mounts").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await expect(
            page.getByText(`R1 互见 ${NONCE}`, { exact: true }),
            "message bubble visible to the second human",
        ).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    });
});
