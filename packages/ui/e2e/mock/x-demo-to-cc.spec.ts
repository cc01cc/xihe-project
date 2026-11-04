/**
 * X 展示级截图（PLAN-0659 / task-15）：TO/CC 多主体能力。
 *
 * 口径（Lead 2026-11-04 插单）：
 *  - Chrome Beta 有头单窗口、**1440×900**、亮色、画面干净；产物目录 `XIHE_E2E_DEMO_DIR`。
 *  - 数据 = **真组件 + mock 数据**（`packages/ui/AGENTS.md` 宣传配图稿流程）；页面由 **12630
 *    主检出 develop 树**渲染（不新起栈、不写任何 CP 数据）。
 *  - 命名产品化：工作区「产品交付线」、会话「接口评审与排期」、主体 `陆星`/`Reviewer`/`Planner`/
 *    `林小满`（受邀同事，只出现在成员面板）。
 *  - 默认跳过；只有 `XIHE_E2E_DEMO=1` 时执行。
 *
 * 诚实限制（写进 HTML）：TO/CC 是本地发送态（BL-239，刷新不保留）；受邀人类读面仍在完善
 * （BL-237）；durable 历史无 `participantId`（BL-197 ①），actor 徽标只在**实时态**可见。
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";

const DEMO = process.env.XIHE_E2E_DEMO === "1";
const SHOT_DIR = process.env.XIHE_E2E_DEMO_DIR ?? "";
const SESSION_ID = "8f2c1a6e-4b7d-4c2a-9e51-3a6f0d7b2c11";
const CHILD_A = "c1a5f0d2-6e3b-4a91-8d77-2f4c9b6e1a33";
const CHILD_B = "d4b7e1c8-9a25-4f60-b3d1-7c8e2a5f0b44";
const RUN_A = "a1f3c9d2-5e64-4b18-9c07-3d2e8f4a6b11";
const RUN_B = "b7e2d4a1-8c39-4f52-a6d0-5e1b9c3f7a22";

const OWNER = { id: "part-owner", principal: "user-lu", name: "陆星" };
const LIN = { id: "part-lin", principal: "user-lin", name: "林小满" };
const REVIEWER = { id: "part-reviewer", principal: "agent-reviewer", name: "Reviewer" };
const PLANNER = { id: "part-planner", principal: "agent-planner", name: "Planner" };
const SUMMARIZER = { id: "part-summarizer", principal: "agent-summarizer", name: "Summarizer" };
const TESTER = { id: "part-tester", principal: "agent-tester", name: "Tester" };

function participant(
    id: string,
    principalId: string,
    displayName: string,
    kind: "HUMAN" | "AGENT",
    role: "PRIMARY" | "MEMBER",
    orderIndex: number,
    extra: Record<string, unknown> = {},
) {
    return {
        participantId: id,
        principalId,
        principalKind: kind,
        displayName,
        role,
        orderIndex,
        wakePolicy: kind === "AGENT" ? "ALL_MESSAGES" : "MENTION",
        respondPolicy: kind === "AGENT" ? "ALWAYS" : "WHEN_MENTIONED",
        source: kind === "AGENT" ? "workspace" : null,
        disabledAt: null,
        selfOwned: kind === "AGENT" ? true : id === OWNER.id,
        defaultModelProvider: kind === "AGENT" ? "openai" : null,
        defaultModelName: kind === "AGENT" ? "gpt-5" : null,
        ...extra,
    };
}

const ROSTER = [
    participant(OWNER.id, OWNER.principal, OWNER.name, "HUMAN", "PRIMARY", 10),
    participant(LIN.id, LIN.principal, LIN.name, "HUMAN", "MEMBER", 20),
    participant(REVIEWER.id, REVIEWER.principal, REVIEWER.name, "AGENT", "MEMBER", 40),
    participant(PLANNER.id, PLANNER.principal, PLANNER.name, "AGENT", "MEMBER", 50),
    participant(SUMMARIZER.id, SUMMARIZER.principal, SUMMARIZER.name, "AGENT", "MEMBER", 60),
    participant(TESTER.id, TESTER.principal, TESTER.name, "AGENT", "MEMBER", 70),
];

/**
 * 演示运行时补丁（initt 脚本）：
 *  - 亮色主题 + 干净布局（文件树收起、右栏关闭）；
 *  - 会话 SSE 常驻开流；`POST /chat` 由本地应答 202 并按轮次推 `token`/`tool_call`/`done`，
 *    事件都盖 `runId` + `participantId`（= 本次发送主体，模拟 CP 语义）；
 *  - workspace 事件流常开（避免「文件事件重连中」）。
 */
async function installDemoRuntime(page: Page, workspaceId: string): Promise<void> {
    await page.addInitScript(
        ({ workspaceId, runIds, participants }) => {
            localStorage.setItem("xihe-theme", "light");
            // 导航面板 240 + 文件树收起 40 + 主列 640 + dock 480 = 1400 < 1440：
            // pinned dock 不挤压主列，也不会出现页面级横向滚动条。
            localStorage.setItem(
                "xihe-layout-global",
                JSON.stringify({ navOpen: true, navWidth: 240 }),
            );
            localStorage.setItem(
                `xihe-layout-ws:${workspaceId}`,
                JSON.stringify({
                    treeCollapsed: true,
                    treeWidth: 240,
                    dockCollapsed: true,
                    // 派单图/成员面板在 360 宽下会横向裁切长名字（如「接口契约梳理」），
                    // 演示图统一用产品允许的 dock 上限 480（DAG 画布 448 + p-2 才放得下）。
                    dockWidth: 480,
                    dockTabs: [],
                    activeDockTab: null,
                    dockMode: "pinned",
                    dockModeManual: true,
                }),
            );
            const enc = (s: string) => new TextEncoder().encode(s);
            const originalFetch = window.fetch.bind(window);
            const rounds = [
                {
                    tokens: ["三段风险已核对：游标边界、幂等键复用，", "这两处需与 Planner 确认。"],
                    toolCall: { tool: "exec_command", toolCallId: "tc-contract", arguments: { command: "npm run test:e2e -- --grep contract" } },
                },
                {
                    tokens: ["收到。契约确认后 3 个工作日联调，", "另留 2 天缓冲。"],
                    toolCall: { tool: "exec_command", toolCallId: "tc-plan", arguments: { command: "npm run plan:check" } },
                },
            ];
            let chatController: ReadableStreamDefaultController<Uint8Array> | null = null;
            let roundIndex = 0;
            const push = (name: string, data: unknown) => {
                try {
                    chatController?.enqueue(enc(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
                } catch {
                    /* stream closed */
                }
            };
            window.fetch = async (input, init) => {
                const request = typeof input === "string" ? null : (input as Request);
                const url = typeof input === "string" ? input : request!.url;
                const method = init?.method ?? request?.method ?? "GET";
                if (url.includes("/api/v1/events") && !url.includes("/workspaces/")) {
                    const stream = new ReadableStream<Uint8Array>({
                        start(controller) {
                            chatController = controller;
                            controller.enqueue(enc("retry: 1000\n\n"));
                        },
                    });
                    return new Response(stream, {
                        status: 200,
                        headers: { "Content-Type": "text/event-stream" },
                    });
                }
                if (url.includes("/api/v1/workspaces/") && url.includes("/events")) {
                    const stream = new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(enc("retry: 1000\n\n"));
                        },
                    });
                    return new Response(stream, {
                        status: 200,
                        headers: { "Content-Type": "text/event-stream" },
                    });
                }
                if (url.endsWith("/api/v1/chat") && method === "POST") {
                    const body = JSON.parse(String(init?.body ?? "{}")) as {
                        sessionId: string;
                        asParticipantId?: string;
                    };
                    const runId = runIds[Math.min(roundIndex, runIds.length - 1)];
                    const participantId = body.asParticipantId ?? participants.owner;
                    const round = rounds[Math.min(roundIndex, rounds.length - 1)];
                    roundIndex += 1;
                    setTimeout(() => {
                        for (const token of round.tokens) {
                            push("token", { content: token, runId, participantId });
                        }
                        if (round.toolCall) {
                            push("tool_call", {
                                tool: round.toolCall.tool,
                                toolCallId: round.toolCall.toolCallId,
                                arguments: round.toolCall.arguments ?? {},
                                run_id: runId,
                                runId,
                                participantId,
                            });
                            push("tool_result", {
                                tool: round.toolCall.tool,
                                toolCallId: round.toolCall.toolCallId,
                                result: "ok · 12 tests passed",
                                status: "succeeded",
                                run_id: runId,
                                runId,
                                participantId,
                            });
                        }
                        push("done", { runId, outcome: "success" });
                    }, 180);
                    return new Response(
                        JSON.stringify({
                            origin: "user_submission",
                            status: "accepted",
                            sessionId: body.sessionId,
                            runId,
                            messageId: crypto.randomUUID(),
                        }),
                        { status: 202, headers: { "Content-Type": "application/json" } },
                    );
                }
                return originalFetch(input, init);
            };
        },
        {
            workspaceId,
            runIds: [RUN_A, RUN_B],
            participants: {
                owner: OWNER.id,
                lin: LIN.id,
                reviewer: REVIEWER.id,
                planner: PLANNER.id,
            },
        },
    );
}

async function stubBoundSession(page: Page): Promise<void> {
    const now = "2026-11-04T14:00:00.000Z";
    // 会话行必须带 `providerConnectionId`（C1：hasBinding 只认会话行）——否则发送前会触发
    // bind-defaults，弹出「已自动绑定 openai · fake-openai」toast，演示图就脏了。
    const bound = {
        id: SESSION_ID,
        title: "接口评审与排期",
        workspaceId: "workspace-1",
        agentPrincipalId: REVIEWER.principal,
        providerConnectionId: "conn-demo",
        modelProvider: "openai",
        modelName: "gpt-5",
        connectionRevision: 1,
        contextTemplateLayer: "workspace",
        contextTemplateId: "产品交付默认模板",
        contextTemplateVersion: 3,
        createdAt: now,
        updatedAt: now,
        archived: false,
    };
    await page.route(/\/api\/v1\/(?:workspaces\/[^/]+\/)?sessions(\?.*)?$/, async (route) => {
        if (route.request().method() !== "GET") {
            await route.fallback();
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessions: [bound] }),
        });
    });
    await page.route(`**/api/v1/sessions/${SESSION_ID}`, async (route) => {
        if (route.request().method() !== "GET") {
            await route.fallback();
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(bound),
        });
    });
    // 请求模板摘要（会话设置条里显示名字而不是「模板未绑定」黄标）。
    await page.route(/\/api\/v1\/config\/api-request-templates(\?.*)?$/, async (route) => {
        if (route.request().method() !== "GET") {
            await route.fallback();
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                templates: [
                    {
                        id: "tpl-delivery-default",
                        name: "产品交付默认模板",
                        layer: "workspace",
                        version: 3,
                        apiTypeId: "openai-chat",
                        apiTypeVersion: 1,
                    },
                ],
            }),
        });
    });
    await page.route(`**/api/v1/sessions/${SESSION_ID}/participants`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                participants: ROSTER,
                capabilities: { view: true, manage: true, mention: true, speakAs: true },
            }),
        });
    });
    await page.route(`**/api/v1/sessions/${SESSION_ID}/derived-state`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                sessionId: SESSION_ID,
                activeChildren: [],
                terminalNotices: [],
            }),
        });
    });
    // run 摘要（run 头的状态/耗时）；两条 run 都是已完成。
    await page.route(`**/api/v1/chat/sessions/${SESSION_ID}/runs*`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                sessionId: SESSION_ID,
                page: 0,
                size: 100,
                runs: [
                    {
                        runId: RUN_A,
                        sessionId: SESSION_ID,
                        origin: "user_submission",
                        status: "succeeded",
                        terminalOutcome: "success",
                        errorCode: null,
                        createdAt: "2026-11-04T14:02:00.000Z",
                        terminalAt: "2026-11-04T14:02:06.400Z",
                        waitingOnRunId: null,
                        waitingToolCallId: null,
                    },
                    {
                        runId: RUN_B,
                        sessionId: SESSION_ID,
                        origin: "user_submission",
                        status: "succeeded",
                        terminalOutcome: "success",
                        errorCode: null,
                        createdAt: "2026-11-04T14:03:00.000Z",
                        terminalAt: "2026-11-04T14:03:04.200Z",
                        waitingOnRunId: null,
                        waitingToolCallId: null,
                    },
                ],
            }),
        });
    });
}

async function stubDelegation(page: Page): Promise<void> {
    const now = "2026-11-04T14:00:00.000Z";
    const session = (id: string, title: string, parent: string | null, spawnedAt: string | null) => ({
        id,
        title,
        createdAt: now,
        updatedAt: now,
        workspaceId: "workspace-1",
        agentPrincipalId: REVIEWER.principal,
        kind: parent ? "SPAWN" : null,
        spawnedFromSessionId: parent,
        spawnedAt,
        archived: false,
    });
    await page.route(/\/api\/v1\/(?:workspaces\/[^/]+\/)?sessions(\?.*)?$/, async (route) => {
        if (route.request().method() !== "GET") {
            await route.fallback();
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                sessions: [
                    session(SESSION_ID, "接口评审与排期", null, null),
                    session(CHILD_A, "契约梳理", SESSION_ID, "2026-11-04T14:01:00.000Z"),
                    session(CHILD_B, "用例补齐", SESSION_ID, "2026-11-04T14:02:00.000Z"),
                ],
            }),
        });
    });
    await page.route(`**/api/v1/sessions/${SESSION_ID}/derived-state`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                sessionId: SESSION_ID,
                activeChildren: [
                    { childSessionId: CHILD_A, runId: RUN_A, name: "契约梳理", status: "running" },
                ],
                terminalNotices: [
                    {
                        childSessionId: CHILD_B,
                        runId: RUN_B,
                        name: "用例补齐",
                        state: "success",
                        terminalAt: "2026-11-04T14:03:00.000Z",
                    },
                ],
            }),
        });
    });
    await page.route(`**/api/v1/sessions/${SESSION_ID}/delegation-usage`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                rootSessionId: SESSION_ID,
                usedSessions: 2,
                maxCount: 5,
                currentDepth: 0,
                maxDepth: 3,
                principalId: REVIEWER.principal,
                principalName: REVIEWER.name,
                policySource: "subject",
                disabled: false,
            }),
        });
    });
}

async function openSession(page: Page): Promise<void> {
    await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
    await expect(page.getByTestId("chat-input"), "composer mounts").toBeVisible({ timeout: 20_000 });
}

/** 演示图只接受"稳定态"：run 已终态、toast 已消失、工具卡不再「执行中」、右栏已关。 */
async function settle(page: Page): Promise<void> {
    // 流式态 composer 的按钮 testid 是 `chat-stop-button`，终态才回到 `chat-send-button`。
    await expect(page.getByTestId("chat-stop-button"), "run 已终态").toHaveCount(0, {
        timeout: 25_000,
    });
    await expect(page.getByTestId("chat-send-button")).toHaveCount(1, { timeout: 25_000 });
    await expect(page.locator("[data-sonner-toast]"), "toast 已消失").toHaveCount(0, {
        timeout: 20_000,
    });
    await expect(page.getByText("执行中"), "工具卡不再执行中").toHaveCount(0, { timeout: 20_000 });
    const closePanel = page.getByRole("button", { name: "关闭此面板" });
    if ((await closePanel.count()) > 0) await closePanel.first().click();
    const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
    }));
    if (overflow.scrollWidth > overflow.innerWidth) {
        console.log(`[demo] HORIZONTAL_OVERFLOW ${JSON.stringify(overflow)}`);
    }
    await page.waitForTimeout(300);
}

async function shot(page: Page, name: string): Promise<void> {
    const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        const scrollers = Array.from(document.querySelectorAll<HTMLElement>("*"))
            .filter((element) => element.scrollWidth > element.clientWidth + 1)
            .slice(0, 4)
            .map(
                (element) =>
                    `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 40)}:` +
                    `${element.scrollWidth}>${element.clientWidth}`,
            );
        return {
            doc: `${doc.scrollWidth}>${doc.clientWidth}`,
            scrollers,
        };
    });
    console.log(`[demo] ${name} overflow=${JSON.stringify(overflow)}`);
    await page.screenshot({ path: join(SHOT_DIR, name), scale: "css" });
}

async function pickTo(page: Page, name: string): Promise<void> {
    const field = page.getByTestId("speak-as-input");
    await field.fill(name);
    await expect(page.getByTestId("speak-as-menu")).toBeVisible({ timeout: 10_000 });
    await field.press("Enter");
    await expect(page.getByTestId("speak-as-chip").first()).toContainText(name);
}

async function pickCc(page: Page, name: string): Promise<void> {
    const bar = page.getByTestId("cc-bar");
    if ((await bar.count()) === 0) await page.getByTestId("cc-expand").click();
    await page.getByTestId("cc-input").fill(name);
    const menu = page.getByTestId("cc-menu");
    await expect(menu).toBeVisible({ timeout: 10_000 });
    await menu.getByRole("option").first().click();
    await expect(menu).toBeHidden({ timeout: 10_000 });
}

/** A 方案：会话成员面板常开（多主体在席）。 */
async function openMembersDock(page: Page): Promise<void> {
    if ((await page.getByTestId("dock-tab-members").count()) === 0) {
        await page.getByTestId("workspace-toolbar-members").click();
    }
    await expect(page.getByTestId("dock-tab-members")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Reviewer", { exact: true }).first()).toBeVisible({
        timeout: 15_000,
    });
}

test.describe.configure({ mode: "serial", retries: 0 });
test.use({ locale: "zh-CN" });

test.describe("X 演示截图（mock 数据 + 12630 develop 真组件）", () => {
    test.skip(!DEMO, "只有 XIHE_E2E_DEMO=1 时才出演示图");
    test.setTimeout(180_000);

    test.beforeAll(() => {
        if (!SHOT_DIR) throw new Error("XIHE_E2E_DEMO_DIR must be set");
        mkdirSync(SHOT_DIR, { recursive: true });
    });

    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page, {
            workspace: { id: "workspace-1", name: "产品交付线" },
        });
        await setupMockSessions(page, {
            sessions: [{ id: SESSION_ID, title: "接口评审与排期" }],
        });
        await stubBoundSession(page);
        await installDemoRuntime(page, "workspace-1");
    });

    test("①②③④ 投递 + 成员面板 + run 分组", async ({ page }) => {
        await openSession(page);
        // 等布局种子生效：文件树收起、右栏关闭。
        await expect(page.getByTestId("workspace-tree-expand")).toBeVisible({ timeout: 10_000 });

        // A 方案（用户裁定）：成员面板常开 = 多主体在席；TO 单选（发送）、CC 3 个。
        await openMembersDock(page);
        await pickTo(page, "Reviewer");
        await pickCc(page, "Planner");
        await pickCc(page, "Summarizer");
        await pickCc(page, "林小满");
        await page
            .getByTestId("chat-input")
            .fill("@Planner 契约我标了三处风险，Reviewer 先看第二页。");

        // ① 输入区 TO/CC chips（同框：成员面板 + 3 个 CC + TO 单选）。
        await page.getByTestId("chat-input").scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        await shot(page, "01-to-cc-chips.png");

        await page.getByTestId("chat-send-button").click();
        await expect(page.getByTestId("message-delivery")).toBeVisible({ timeout: 15_000 });
        await expect(page.getByTestId("message-delivery-to")).toContainText("发送→Reviewer");
        await expect(page.getByTestId("message-delivery-mention")).toContainText("@Planner");
        // 等 run 1 终态：完整回复 + 工具卡完成 + toast 消失 + 右栏关闭。
        await expect(page.getByText("这两处需与 Planner 确认。", { exact: false })).toBeVisible({
            timeout: 25_000,
        });
        await settle(page);

        // ② 消息头投递徽标（发送→Reviewer · @Planner · 抄送→3 人）：dock 关闭，聚焦消息本体。
        await page.getByTestId("message-delivery").first().scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        await shot(page, "02-delivery-header.png");

        // ③ 成员面板（A 方案：2 人类 + 4 agent 同框）
        await openMembersDock(page);
        await expect(page.getByTestId("dock-tab-members")).toBeVisible({ timeout: 10_000 });
        await expect(page.getByText("Reviewer", { exact: true }).first()).toBeVisible({
            timeout: 10_000,
        });
        await expect(page.getByText("Summarizer", { exact: true }).first()).toBeVisible({
            timeout: 10_000,
        });
        await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
        await page.waitForTimeout(400);
        await shot(page, "03-members-panel.png");

        // 卡主视觉（v4）：收起会话列表侧栏（用户裁定"左栏不是核心"）+ 成员面板 + 底部
        // 「发送/抄送」chips + 消息同框，2x 采集（2880×1800）；卡内按 1384×820 CSS 显示
        // （=2x 裁切 2768×1640 的 0.5 缩放，保证清晰）。
        await pickCc(page, "Planner");
        await pickCc(page, "Summarizer");
        await pickCc(page, "林小满");
        await page.getByTestId("chat-input").fill("@Planner 排期也一起看一眼。");
        await page.getByTestId("dock-tab-close-members").click();
        await page.waitForTimeout(300);

        // ④ run 分组 + actor 徽标：再以 Planner 身份发言，形成两个 run / 两个主体。
        await pickTo(page, "Planner");
        await page.getByTestId("chat-input").fill("排期按契约确认后的节奏排，别再顺延。");
        await page.getByTestId("chat-send-button").click();
        await expect(page.getByText("另留 2 天缓冲", { exact: false })).toBeVisible({
            timeout: 25_000,
        });
        await expect(page.getByTestId("run-header")).toHaveCount(2, { timeout: 20_000 });
        await expect(page.getByTestId("process-row-actor").first()).toBeVisible({
            timeout: 15_000,
        });
        const actors = await page.getByTestId("process-row-actor").count();
        const responders = await page.getByTestId("message-responder").count();
        const repeated = await page.getByText("排期按契约确认后的节奏排，别再顺延。").count();
        console.log(
            `[demo] actorBadges=${actors} responderRows=${responders} repeatedUserMsgs=${repeated}`,
        );
        await settle(page);
        // ④ 构图：贴底（run2 完整 + run1 的 actor 工具行在顶部，两个 actor 徽标同屏）。
        await page.mouse.move(720, 420);
        await page.mouse.wheel(0, 1600);
        await page.waitForTimeout(400);
        await shot(page, "04-run-grouping-actor.png");

        // 卡主视觉（v4）：两个 run 都已生成 ⇒ 聊天区有内容；成员面板 + 底部「发送/抄送」chips 同框。
        // 2x 采集（2880×1800），卡内按裁切后的 2720×1560 的 0.5 缩放显示（1360×780 CSS）。
        await openMembersDock(page);
        // ④ 之后 TO=Planner，先把发送方切回 Reviewer（Reviewer 未被选中 ⇒ 候选可见），
        // 再选 3 个抄送（Planner/Summarizer/林小满）。
        await pickTo(page, "Reviewer");
        await pickCc(page, "Planner");
        await pickCc(page, "Summarizer");
        await pickCc(page, "林小满");
        await page.getByTestId("chat-input").fill("@Planner 排期也一起看一眼。");
        // 用户裁定：会话列表侧栏"不是核心" ⇒ 采集前隐藏侧栏与导航 rail（纯展示隐藏，不改产品）。
        await page.addStyleTag({
            content:
                '[data-testid="sidebar"],[data-testid="nav-rail"]{display:none!important}',
        });
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(SHOT_DIR, "06-card-visual.png"), scale: "device" });
    });

    test("⑤ 委派 DAG", async ({ page }) => {
        await stubDelegation(page);
        await openSession(page);
        await page.getByTestId("workspace-toolbar-delegation").click();
        await expect(page.getByTestId("dock-tab-delegation")).toBeVisible({ timeout: 10_000 });
        await expect(page.getByTestId("delegation-dag")).toBeVisible({ timeout: 10_000 });
        await expect(page.getByTestId("delegation-node")).toHaveCount(3, { timeout: 15_000 });
        await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
        // PLAN-0659 T1.4 缺陷修复回归：480px 右栏下 DAG 画布不得出现横向滚动
        // （`(maxDepth+1)×COL_W` + 内边距 ≤ 可用宽度；DOM 实测，不靠肉眼）。
        const dagScroll = await page
            .getByTestId("delegation-dag")
            .locator("div.overflow-auto")
            .first()
            .evaluate((element) => ({
                scrollWidth: element.scrollWidth,
                clientWidth: element.clientWidth,
            }));
        console.log(`[demo] dagScroll=${JSON.stringify(dagScroll)}`);
        expect(
            dagScroll.scrollWidth,
            `DAG 横向滚动: ${JSON.stringify(dagScroll)}`,
        ).toBeLessThanOrEqual(dagScroll.clientWidth);
        await page.waitForTimeout(400);
        await shot(page, "05-delegation-dag.png");
    });
});

