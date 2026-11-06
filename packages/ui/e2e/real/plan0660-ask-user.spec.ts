/**
 * PLAN-0660 T5.23 — ask_user 真栈浏览器验收（串行门控骨架）。
 *
 * 状态（2026-11-06）：**骨架，未实跑，待窗口**。本文件只把「agent 提问 → 用户端不刷新即出现
 * 卡片 → 作答 → agent 继续」的驱动与判据写死，等 T5.18–T5.22（UI 车道）合入并拿到实际
 * `data-testid` 后，再在窗口内真跑并把结果落 `.local/evidence/plan-0660/acceptance/`。
 *
 * 为什么必须门控：真栈套件跑一轮 10–25 分钟且要占 PG/端口/浏览器，默认 suite 里放一条
 * 未实现完的用例只会制造假绿/假红。因此与 `mention-cursor-badge.spec.ts` 同构：
 *   - `XIHE_E2E_ASK_USER=1` 才执行，否则整组 skip（仍会打印 skip 原因，计数可见）；
 *   - 不进 `@host` grep（本文件无 `@host` 标签）⇒ `mise run test:e2e:host` 默认轮次不选它，
 *     只有显式 `--batch` / 显式 spec 路径才运行。
 *
 * 驱动链（夹具侧已就位，见同分支两个夹具文件）：
 *   - `e2e/fixtures/chain-scripts.mjs` 新增链 `ask-user` = `["ask_user", "text"]`；
 *   - `e2e/fixtures/fake-llm-server.mjs` 新增 `mode=ask_user`：一轮首次请求发 `ask_user`
 *     工具调用，问题正文取同轮 user 消息里的 `XIHE-E2E-ASK <text>` 标记；人类作答后
 *     续请求（last role = tool）返回 prose `Answer received.`（agent 继续的断言点）。
 *   - 链按会话激活：首条消息里写 `XIHE-E2E-CHAIN ask-user`，**不需要**改 runner 的
 *     `--llm-mode`（success 起步即可），也不会干扰同栈其它 spec。
 *
 * 运行前提（窗口内，按顺序）：
 *   1) `node scripts/e2e-host.mjs --persistent --llm-mode=success`   # 隔离 host 栈（含 fake LLM）
 *   2) 另开终端：`XIHE_E2E_ASK_USER=1 node scripts/e2e-host.mjs --batch=plan0660-ask-user e2e/real/plan0660-ask-user.spec.ts`
 *      （`XIHE_ASK_USER_DIR` / `XIHE_ASK_USER_CARD_*` 可选，见下）
 *   3) `node scripts/e2e-host.mjs --teardown`
 *
 * 覆盖与判据（对 `plans/PLAN-0660-xh-wake-notify-gate/verify.md`）：
 *   - V8：提问卡在不刷新页面的前提下出现（page 不做任何 reload/navigation，断言导航计数）；
 *          作答后 durable 投影 `state=answered`、`answer` 回显、`settledAt` 非空；agent 继续输出
 *          `Answer received.`（fake LLM 的 followUp 只在回答推回 Agent 之后才可能被请求）。
 *   - V8 附带：`user_questions` 行状态转储（psql，前后各一次）与截图；
 *   - V11 半边：作答后 `pendingCount` 归零（徽标归零的权威投影侧证据；DOM 徽标半边见
 *          `e2e/real/mention-cursor-badge.spec.ts`，两 spec 同窗口一起跑）。
 * 判据「同一 questionId 仅一次 pending 推送」(V9) 与 SSE 帧级证据不在本 spec 内：hint 帧要
 * 从 CP 日志/用户通道观察，见 T5.24 runbook §3（本 spec 只把「未刷新即出现卡片」作为
 * 用户通道投递成功的行为级证据）。
 *
 * 回填状态（2026-11-06，T5.23 写侧）：testid **已按 T5.18–T5.22 的实现回填**，来源是
 *   `src/features/workspace/components/UserQuestionCard.vue`（卡片/输入框/提交/状态）与
 *   `UserQuestionsEntry.vue`（侧边栏入口与展开面板）；对照表见
 *   `.local/evidence/plan-0660/acceptance/t523-testid-map.md`。五个都保留 `XIHE_ASK_USER_*`
 *   env 覆盖，实现再改时不必改码即可先探一次。
 *
 * 与真实组件对齐后的两处结构性修正（判据只收紧、不放松）：
 *   - 卡片**挂在侧边栏入口的展开面板里**（`UserQuestionsEntry`，`v-if="hasPending"` 才占位），
 *     所以断言前必须先等入口出现（这本身就是「hint 把投影刷成 pending」的证据）并点开它。
 *   - 结案后投影归零 ⇒ `hasPending` 转 false ⇒ 入口与卡片**一起离开 DOM**，因此「结案态」的
 *     可观察事实是**消失**，不是 `data-state="answered"`。原稿把后者当断言点，在真栈永不成立
 *     （列表只拉 `state=pending`，零态不占位）；`answered/expired/cancelled` 三态的渲染只在
 *     「结案行仍在列表里」时才可见，属组件单测覆盖面。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { workspaceChatPath } from "../../src/lib/routes";
import {
    CP_URL,
    awaitLatestChatRunCompleted,
    ensureAgentWorkspaceBinding,
    ensureChatReady,
    registerJourneyUser,
    seedPage,
    sendChat,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";
import { agentName } from "./helpers/agent-name";

/** 门控：只有窗口显式打开时才跑（默认 suite 里恒 skip，不计入假绿）。 */
const ENABLED = process.env.XIHE_E2E_ASK_USER === "1";

/** 证据落点：默认 A03-xihe/.local/evidence/plan-0660/acceptance/ask-user；可用 env 覆盖。 */
const OUT =
    process.env.XIHE_ASK_USER_DIR ??
    join(process.cwd(), "..", "..", ".local", "evidence", "plan-0660", "acceptance", "ask-user");

/**
 * testid：全部取自真实实现（`UserQuestionCard.vue` / `UserQuestionsEntry.vue`），
 * 对照表见 `.local/evidence/plan-0660/acceptance/t523-testid-map.md`。
 */
const CARD_TESTID = process.env.XIHE_ASK_USER_CARD_TESTID ?? "user-question-card";
const ANSWER_INPUT_TESTID = process.env.XIHE_ASK_USER_INPUT_TESTID ?? "user-question-input";
const ANSWER_SUBMIT_TESTID = process.env.XIHE_ASK_USER_SUBMIT_TESTID ?? "user-question-submit";
/** 侧边栏入口（`hasPending` 才渲染）与其展开面板 —— 卡片挂在这个面板里，必须先展开。 */
const SIDEBAR_ENTRY_TESTID =
    process.env.XIHE_ASK_USER_SIDEBAR_ENTRY_TESTID ?? "sidebar-user-questions";
const SIDEBAR_LIST_TESTID = process.env.XIHE_ASK_USER_SIDEBAR_LIST_TESTID ?? "user-questions-list";
const SIDEBAR_BADGE_TESTID = process.env.XIHE_ASK_USER_BADGE_TESTID ?? "user-questions-badge";

/** 作答正文（同时作为投影回显断言值）。 */
const ANSWER_TEXT = "继续 T5.23";

const FAKE_LLM_PORT = process.env.XIHE_FAKE_LLM_PORT ?? "12680";
const FAKE_LLM_BASE = `http://127.0.0.1:${FAKE_LLM_PORT}/openai/v1`;
const FAKE_MODEL = "fake-openai";
const FAKE_CONNECTION_KEY = "default";

interface UserQuestionView {
    id: string;
    sessionId: string;
    runId: string;
    state: "pending" | "answered" | "expired" | "cancelled";
    prompt: string;
    answer?: string | null;
    expiresAt?: string | null;
    createdAt: string;
    firstDeliveredAt?: string | null;
    settledAt?: string | null;
}

interface UserQuestionListResponse {
    items: UserQuestionView[];
    pendingCount: number;
}

test.describe.configure({ retries: 0 });

test.describe("PLAN-0660 T5.23 ask_user 真栈全链（窗口门控骨架）", () => {
    test.skip(!ENABLED, "只有 XIHE_E2E_ASK_USER=1 时执行（需 host 隔离栈窗口，见文件头 runbook）");

    test("提问 → 不刷新出现卡片 → 作答 → 结案，agent 继续（V8/V11 投影侧）", async ({
        page,
        request,
    }) => {
        test.skip(
            !process.env.XIHE_FAKE_LLM_PORT,
            "requires the isolated host-E2E stack (scripts/e2e-host.mjs injects XIHE_FAKE_LLM_PORT)",
        );
        test.setTimeout(900_000);
        mkdirSync(OUT, { recursive: true });
        const observed: Record<string, unknown> = {
            plan: "PLAN-0660",
            task: "T5.23 ask_user full chain",
            cardTestIds: {
                card: CARD_TESTID,
                input: ANSWER_INPUT_TESTID,
                submit: ANSWER_SUBMIT_TESTID,
            },
            steps: {} as Record<string, unknown>,
        };
        const steps = observed.steps as Record<string, unknown>;
        const persist = (): void => {
            writeFileSync(
                join(OUT, "ask-user-observed.json"),
                JSON.stringify({ ...observed, observedAt: new Date().toISOString() }, null, 2),
            );
        };

        // ── 夹具：用户 + workspace + AGENT principal + 会话，并把 chat 绑到 fake LLM ──
        const ctx = await registerJourneyUser(request, "plan0660-ask-user");
        const wsId = ctx.workspaceId;
        const headers = { ...ctx.headers, "X-Workspace-Id": wsId };
        await ensureFakeProvider(request, { accessToken: ctx.authToken, workspaceId: wsId });
        await ensureAgentWorkspaceBinding(wsId);
        await waitForControlPlaneAgentReady(request, headers);

        const auth = { accessToken: ctx.authToken, workspaceId: wsId };
        const principalId = await provisionWorkspaceAgentPrincipal(request, auth, {
            name: agentName("AskUser", Date.now()),
            actions: ["read"],
            systemPrompt: "You are the PLAN-0660 ask_user acceptance agent.",
        });
        const sessionId = await createSessionWithPrincipal(request, auth, {
            principalId,
            title: "PLAN-0660 T5.23 ask_user acceptance",
            workspaceId: wsId,
        });
        steps["sessionId"] = sessionId;
        persist();

        await seedPage(page, ctx);
        await page.goto(workspaceChatPath(wsId, sessionId));
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 });
        await ensureChatReady(page);

        // V8 的「不刷新」判据：此后不再 reload/goto，主 frame 导航计数必须停在 1（初次 goto）。
        let navigations = 0;
        page.on("framenavigated", (frame) => {
            if (frame === page.mainFrame()) navigations += 1;
        });

        // ── 1) 发消息触发 ask_user（fake LLM 链按会话激活，无需改 runner --llm-mode）──
        const questionText = `T5.23 验收问题：请确认继续（${Date.now()}）`;
        await sendChat(
            page,
            `XIHE-E2E-CHAIN ask-user XIHE-E2E-ASK ${questionText}  请按工具提示回答。`,
        );

        // ── 2) 用户端不刷新即出现提问卡（hint 投递成功的行为级证据）──
        // 第一层：侧边栏入口出现 —— `UserQuestionsEntry` 用 `v-if="hasPending"` 占位，
        // 所以「它出现」等价于「投影已被 hint 刷成 pending」，比直接等卡片更早、更贴近通道语义。
        const sidebarEntry = page.getByTestId(SIDEBAR_ENTRY_TESTID);
        await expect(
            sidebarEntry,
            `sidebar questions entry ${SIDEBAR_ENTRY_TESTID} must appear without reload`,
        ).toBeVisible({ timeout: 180_000 });
        await expect(page.getByTestId(SIDEBAR_BADGE_TESTID)).toHaveText(/^\d+$/);

        // 第二层：展开后卡片在列表里（卡片不在顶层，必须点开入口）。
        if ((await sidebarEntry.getAttribute("aria-expanded")) !== "true") {
            await sidebarEntry.click();
        }
        await expect(page.getByTestId(SIDEBAR_LIST_TESTID)).toBeVisible({ timeout: 30_000 });

        const card = page.getByTestId(CARD_TESTID);
        await expect(card, `ask card ${CARD_TESTID} must appear without reload`).toBeVisible({
            timeout: 30_000,
        });
        // 两态（未刷新即 pending、且可提交）—— 用真实属性断言，别靠"看见输入框"推断。
        await expect(card).toHaveAttribute("data-state", "pending");
        await expect(card).toHaveAttribute("data-submittable", "true");
        await page.screenshot({ path: join(OUT, "ask-card-pending.png"), scale: "css" });

        // ── 3) durable 投影（pending）与行状态转储 ──
        let pendingList: UserQuestionListResponse | null = null;
        await expect
            .poll(
                async () => {
                    const response = await request.get(
                        `${CP_URL}/api/v1/user-questions?state=pending`,
                        { headers },
                    );
                    if (!response.ok()) return `HTTP ${response.status()}`;
                    const body = (await response.json()) as UserQuestionListResponse;
                    pendingList = body;
                    return body.items.some((item) => item.sessionId === sessionId)
                        ? "found"
                        : "missing";
                },
                { timeout: 60_000, intervals: [500, 1_000, 2_000] },
            )
            .toBe("found");
        const question = pendingList!.items.find((item) => item.sessionId === sessionId);
        expect(question, "a pending question for this session must be listed").toBeTruthy();
        const questionId = question!.id;
        expect(question!.state).toBe("pending");
        expect(question!.prompt).toContain("T5.23");
        steps["questionId"] = questionId;
        steps["pendingCount"] = pendingList!.pendingCount;
        steps["deliveredAt"] = question!.firstDeliveredAt ?? null;
        writeFileSync(join(OUT, "projection-pending.json"), JSON.stringify(question, null, 2));
        steps["rowBeforeAnswer"] = psqlRow(questionId);
        persist();

        // ── 4) 作答（UI 卡片正文）──
        // 卡片与 CP 投影必须是同一行：`data-question-id` 等于刚才列表里拿到的那条。
        await expect(card).toHaveAttribute("data-question-id", questionId);
        const answerInput = page.getByTestId(ANSWER_INPUT_TESTID);
        await expect(answerInput, "answer input inside the card").toBeVisible({ timeout: 30_000 });
        await answerInput.fill(ANSWER_TEXT);
        await page.getByTestId(ANSWER_SUBMIT_TESTID).click();

        // ── 5) 结案：投影 answered + answer/settledAt，且卡片不再可编辑（输入框消失）──
        await expect
            .poll(
                async () => {
                    const response = await request.get(
                        `${CP_URL}/api/v1/user-questions/${questionId}`,
                        { headers },
                    );
                    if (!response.ok()) return `HTTP ${response.status()}`;
                    return ((await response.json()) as UserQuestionView).state;
                },
                { timeout: 60_000, intervals: [500, 1_000, 2_000] },
            )
            .toBe("answered");
        const settledResponse = await request.get(`${CP_URL}/api/v1/user-questions/${questionId}`, {
            headers,
        });
        expect(settledResponse.ok(), await settledResponse.text()).toBe(true);
        const settled = (await settledResponse.json()) as UserQuestionView;
        expect(settled.state).toBe("answered");
        expect(settled.answer).toBe(ANSWER_TEXT);
        expect(
            settled.settledAt,
            "settledAt must be stamped on the answered transition",
        ).toBeTruthy();
        writeFileSync(join(OUT, "projection-answered.json"), JSON.stringify(settled, null, 2));
        // 结案态的可观察事实是**入口与卡片一起离开 DOM**：投影归零 ⇒ `hasPending` 转 false ⇒
        // `v-if` 卸载整个 `UserQuestionsEntry`。这里不要等 `data-state="answered"` —— 列表只拉
        // `state=pending`、零态不占位，那一态在真栈不可能出现（四态渲染由组件单测覆盖）。
        await expect(
            answerInput,
            "the answered card must no longer offer an editable input",
        ).toHaveCount(0, {
            timeout: 60_000,
        });
        await expect(card, "the whole entry leaves the DOM once nothing is pending").toHaveCount(
            0,
            { timeout: 60_000 },
        );
        await page.screenshot({ path: join(OUT, "ask-entry-cleared.png"), scale: "css" });

        // V11 投影侧：同一 filter 下 pendingCount 归零（徽标归零的权威来源）。
        const afterListResponse = await request.get(
            `${CP_URL}/api/v1/user-questions?state=pending`,
            { headers },
        );
        expect(afterListResponse.ok(), await afterListResponse.text()).toBe(true);
        const afterList = (await afterListResponse.json()) as UserQuestionListResponse;
        expect(afterList.pendingCount, "pendingCount must return to zero after the answer").toBe(0);
        steps["pendingCountAfterAnswer"] = afterList.pendingCount;
        steps["rowAfterAnswer"] = psqlRow(questionId);

        // ── 6) agent 继续：fake LLM 的 followUp prose 只会在回答推回 Agent 后才被请求 ──
        await expect(
            page.getByText("Answer received.").first(),
            "agent must continue after the answer",
        ).toBeVisible({
            timeout: 180_000,
        });
        await awaitLatestChatRunCompleted(request, headers, wsId);
        steps["continued"] = true;

        // ── 7) 「不刷新」判据与终态证据 ──
        expect(
            navigations,
            "no reload/navigation while waiting for the card or answering",
        ).toBeLessThanOrEqual(1);
        await page.screenshot({ path: join(OUT, "ask-card-continued.png"), scale: "css" });
        persist();
    });
});

/** V8 要求的 `user_questions` 行状态转储（host 栈的隔离 PG，由 runner 注入连接信息）。 */
function psqlRow(questionId: string): string {
    const container = process.env.XIHE_E2E_PG_CONTAINER,
        database = process.env.XIHE_E2E_PG_DATABASE,
        dbUser = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !dbUser) {
        return "unavailable: XIHE_E2E_PG_* not injected (run through scripts/e2e-host.mjs)";
    }
    const sql =
        "select id::text, state, coalesce(answer,'<null>'), " +
        "coalesce(settled_at::text,'<null>'), coalesce(first_delivered_at::text,'<null>') " +
        `from user_questions where id = '${questionId}'`;
    return execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        ["exec", container, "psql", "-X", "-A", "-t", "-U", dbUser, "-d", database, "-c", sql],
        { encoding: "utf8", timeout: 20_000, windowsHide: true },
    ).trim();
}

/** 把 chat 绑到会走 `chain` 模式激活的 fake LLM（与 plan0665 的真实链路夹具同构）。 */
async function ensureFakeProvider(
    request: import("@playwright/test").APIRequestContext,
    auth: { accessToken: string; workspaceId: string },
): Promise<void> {
    const headers = {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
    };
    const created = await request.post(`${CP_URL}/api/v1/provider-connections`, {
        headers,
        data: {
            providerId: "openai",
            apiTypeId: "openai-chat-completions",
            apiTypeVersion: 1,
            apiKey: "sk-fake-openai-key",
            connectionKey: FAKE_CONNECTION_KEY,
            label: "PLAN-0660 ask_user fake LLM",
            scope: "USER",
            modelDiscovery: "manual",
            manualModels: [FAKE_MODEL],
            baseUrl: FAKE_LLM_BASE,
        },
    });
    expect(
        created.ok(),
        `provider connection create ${created.status()}: ${await created.text()}`,
    ).toBe(true);
    const connection = (await created.json()) as { id: string };
    const verified = await request.post(
        `${CP_URL}/api/v1/provider-connections/${connection.id}/verify`,
        { headers },
    );
    expect(verified.ok(), `provider connection verify: ${await verified.text()}`).toBe(true);
    const profile = await request.put(`${CP_URL}/api/v1/config/user/llm-provider`, {
        headers,
        data: {
            profile: JSON.stringify({
                providerId: "openai",
                connectionKey: FAKE_CONNECTION_KEY,
                model: FAKE_MODEL,
            }),
        },
    });
    expect(profile.status(), `user llm profile write: ${await profile.text()}`).toBe(200);
}
