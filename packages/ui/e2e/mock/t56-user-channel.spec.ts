// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
/**
 * PLAN-0660 T5.6 —— user-channel（`GET /api/v1/user-events`）+ 已读游标推进的**产品 UI 路径**
 * （mock lane：无栈、无 CP、无 docker、无真实后端）。
 *
 * 为什么要这条 spec：T5.6 之前的"证据"是在 spec 里直接 `page.evaluate(fetch PATCH …)` —— 那证明的是
 * CP 端点存在，不是产品路径存在。这里断言的才是产品路径：登录壳订阅 user-channel、帧流进
 * `sessionParticipants` store、控件调用新增的 api client。
 *
 * 断言编号（与 lane-t56 回报 ⑥ 一一对应）：
 *  1. 挂载即订阅：`GET /api/v1/user-events` 带 `Authorization: Bearer` + `Accept: text/event-stream`，
 *     且整壳恰好 1 条连接（不是匿名轮询、不是每个面板一条）。
 *  2. `participant_notified` → 名单重读 → 徽标按**服务端**值更新，且页面没有重载。
 *     **没接线必红**：不订阅 user-channel 时不会有第二次 `GET …/participants`，徽标也停在旧值。
 *  3. `participant-cursor-advance` 只出现在**本人 HUMAN** 行（他人行、我拥有的 AGENT 行都没有）。
 *  4. 点击控件 → `PATCH …/participants/{id}/cursor` body = 哨兵 `9007199254740991`
 *     （= `PARTICIPANT_CURSOR_ADVANCE_TO_LATEST`，上限由 CP 夹取）；成功后徽标消失且
 *     **不额外 GET 名单**（本地采用服务端返回的游标）。**控件只在本地改状态 / 没接 api 时必红**。
 *  5. `403 CURSOR_SELF_ONLY` → 本地化文案可见，徽标与 GET 次数都不变（失败不改本地状态）。
 *  6. 预算：整段导航生命周期恰好 1 条连接；登出（SPA 跳 `/login`）时连接被 abort（挂载/卸载成对）。
 *  7. 窄桌面 1280×720：行内无横向溢出、控件 box 完全落在视口内（不裁切）。
 *     ⚠️ 移动 390×844 的同类检查**当前不适用**：`WorkspaceWorkbench.vue:499` 在 `isMobile` 时把
 *     `members-open` 固定为 false（移动 aux 面只有 changes/monitor），成员面板在移动端不可达。
 *     移动端入口若将来放开，请在本文件补一个 `test.use({ viewport: { width: 390, height: 844 } })` 块。
 *
 * 夹具口径（沿用 mock lane 既有做法，见 `e2e/mock/coding-loop.spec.ts`）：
 * - 参与者名单：`page.route` 桩 `GET /api/v1/sessions/{id}/participants`，返回**严格信封**
 *   `{participants, capabilities}`；名单放在一个可变的 `state.roster` 里，用例改它即可模拟
 *   "CP 派生的未读数变了"。**必须注册在 `setupMockAuth`/`setupMockSessions` 之后**（Playwright
 *   后注册的路由优先，两者都有 `**\/api/v1/**` 兜底）。
 * - user-channel：Stub **SSE 必须能逐帧推送**，`route.fulfill` 只能一次性给完整 body，所以按
 *   coding-loop 的既有写法用 `addInitScript` 覆盖 `window.fetch`，把推帧句柄挂到
 *   `window.__t56PushUserChannel`（不连 CP；也不影响其它 URL —— 非 user-events 请求原样交回）。
 *
 * 待跑（浏览器窗口在 lane-e2e 手里，本文只过静态门）：
 *   `pnpm exec playwright test --config e2e/playwright.config.ts e2e/mock/t56-user-channel.spec.ts`
 * 预期：7 个用例全绿（前 6 个无 skip），且 Console 无 error/pageerror。
 */
import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import type { MatrixParticipant } from "./helpers/session-matrix";
import { collectPageFailures, expectNoPageFailures } from "./helpers/page-failures";
import type { PageFailures } from "./helpers/page-failures";
import { FONT_ORIGIN_FAILURE, stubSessionProjections } from "./helpers/session-projections";
import { LONG_TIMEOUT_MS } from "../timeouts";

// BL-318：用例 5 故意桩 `403 CURSOR_SELF_ONLY`（验"别人的游标不能推进"的本地化文案），
// 逐条放行游标端点；本文件已有自己的 `expectNoPageFailures` 断言，公共门禁的 allow 也要同步。
test.use({
    mockAllow: [...DEFAULT_MOCK_ALLOW, "participants/[^/]+/cursor"],
});

const WORKSPACE_ID = "workspace-1";
const SESSION_ID = "t56-session";
const OWNER_PARTICIPANT_ID = "part-t56-owner";
const AGENT_PARTICIPANT_ID = "part-t56-agent";
const MEMBER_PARTICIPANT_ID = "part-t56-member";

/** 与 `src/composables/api.ts#PARTICIPANT_CURSOR_ADVANCE_TO_LATEST` 必须一致（改了要同批改这里）。 */
const CURSOR_ADVANCE_TO_LATEST = 9_007_199_254_740_991;

const CAPABILITIES = { view: true, manage: true, mention: true, speakAs: false };

interface WireCursor {
    lastReadEventSeq: number;
    mentionCount: number;
    updatedAt: string;
}

type WireParticipant = MatrixParticipant & { readCursor?: WireCursor | null };

interface T56LaneState {
    /** 服务端"当前"名单；用例直接改它，下一次 GET 就会带上新值。 */
    roster: WireParticipant[];
    /** `GET …/participants` 次数（"hint 是否真的驱动了重读"的判据）。 */
    participantsRequests: number;
    /** 收到的 cursor PATCH body（判据：必须带哨兵值）。 */
    cursorRequests: Array<Record<string, unknown>>;
    /** cursor PATCH 的响应：200 = 采纳 `cursorBody`；403 走 `CURSOR_SELF_ONLY`。 */
    cursorStatus: number;
    cursorBody: WireCursor;
}

interface UserChannelSnapshot {
    connections: Array<{ aborted: boolean }>;
    requests: Array<{ url: string; authorization: string; accept: string }>;
    /** 文档启动次数：>1 说明发生了整页重载（第 2 条要排除"靠刷新才更新"）。 */
    boots: number;
}

function cursorOf(mentionCount: number, lastReadEventSeq = 4): WireCursor {
    return {
        lastReadEventSeq,
        mentionCount,
        updatedAt: "2026-11-05T00:00:00.000Z",
    };
}

/**
 * 三人名单：本人 HUMAN（`selfOwned`）、他人 HUMAN、**我拥有的 AGENT**（`selfOwned` 但主体是
 * AGENT ⇒ 游标不属于它，控件不该出现）。
 */
function rosterWithMentionCount(mentionCount: number): WireParticipant[] {
    return [
        {
            participantId: OWNER_PARTICIPANT_ID,
            principalKind: "HUMAN",
            principalId: "user-1",
            displayName: "Owner One",
            role: "MEMBER",
            orderIndex: 20,
            wakePolicy: "MENTION",
            respondPolicy: "WHEN_MENTIONED",
            disabledAt: null,
            selfOwned: true,
            readCursor: cursorOf(mentionCount),
        },
        {
            participantId: AGENT_PARTICIPANT_ID,
            principalKind: "AGENT",
            principalId: "agent-alpha",
            displayName: "Agent Alpha",
            role: "PRIMARY",
            orderIndex: 10,
            wakePolicy: "ALL_MESSAGES",
            respondPolicy: "ALWAYS",
            source: "workspace",
            disabledAt: null,
            selfOwned: true,
            defaultModelProvider: "openai",
            defaultModelName: "fake-openai",
            readCursor: null,
        },
        {
            participantId: MEMBER_PARTICIPANT_ID,
            principalKind: "HUMAN",
            principalId: "user-2",
            displayName: "Member Two",
            role: "MEMBER",
            orderIndex: 30,
            wakePolicy: "MENTION",
            respondPolicy: "WHEN_MENTIONED",
            disabledAt: null,
            selfOwned: false,
            readCursor: null,
        },
    ];
}

/**
 * 装好这条 lane 的三个面：登录/会话夹具、参与者名单（可变 + 计数）、cursor PATCH、user-channel。
 * 返回**可变 state**：用例改 `state.roster` 就能模拟服务端派生未读数变化。
 */
async function setupT56Lane(page: Page): Promise<T56LaneState> {
    const state: T56LaneState = {
        roster: rosterWithMentionCount(3),
        participantsRequests: 0,
        cursorRequests: [],
        cursorStatus: 200,
        cursorBody: cursorOf(0, 42),
    };

    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "T5.6 user channel" }] });
    // 聊天列挂载后会拉这三个侧投影；不桩就是真 404 + console error（夹具缺口，不是产品缺陷）。
    await stubSessionProjections(page, SESSION_ID);

    // 参与者名单：严格信封；读 `state.roster`，因此用例改完再被 GET 就能观察到变化。
    await page.route(`**/api/v1/sessions/${SESSION_ID}/participants`, async (route) => {
        state.participantsRequests += 1;
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ participants: state.roster, capabilities: CAPABILITIES }),
        });
    });

    // 已读游标：记录请求体（判据 = 哨兵值），200 时回服务端夹取后的游标，403 时回 Problem。
    await page.route(`**/api/v1/sessions/${SESSION_ID}/participants/*/cursor`, async (route) => {
        state.cursorRequests.push(route.request().postDataJSON() as Record<string, unknown>);
        if (state.cursorStatus === 200) {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(state.cursorBody),
            });
            return;
        }
        await route.fulfill({
            status: state.cursorStatus,
            contentType: "application/problem+json",
            body: JSON.stringify({
                status: state.cursorStatus,
                code: "CURSOR_SELF_ONLY",
                detail: "The read cursor can only be advanced by its own human participant",
                requestId: "t56-e2e",
            }),
        });
    });

    // user-channel 的**可推帧** SSE 桩（沿用 coding-loop 形状：覆盖 window.fetch）。
    await page.addInitScript(() => {
        const scope = window as unknown as Record<string, unknown>;
        const encode = (value: string) => new TextEncoder().encode(value);
        const frame = (name: string, data: unknown) =>
            `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

        scope.__t56Boots = ((scope.__t56Boots as number | undefined) ?? 0) + 1;
        const connections: Array<{
            controller: ReadableStreamDefaultController<Uint8Array>;
            aborted: boolean;
        }> = [];
        const requests: Array<{ url: string; authorization: string; accept: string }> = [];
        scope.__t56UserChannel = { connections, requests };
        scope.__t56PushUserChannel = (name: string, payload: unknown) => {
            for (const connection of connections) {
                if (!connection.aborted) {
                    connection.controller.enqueue(encode(frame(name, payload)));
                }
            }
        };

        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
            // `fetch` 第一参数三态：string / Request / URL（URL 用 href，它没有 url 属性）。
            const url =
                typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (!url.includes("/api/v1/user-events")) return originalFetch(input, init);

            const headers = new Headers(
                init?.headers ?? (input instanceof Request ? input.headers : undefined),
            );
            requests.push({
                url,
                authorization: headers.get("authorization") ?? "",
                accept: headers.get("accept") ?? "",
            });

            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    const connection = { controller, aborted: false };
                    connections.push(connection);
                    controller.enqueue(
                        encode(frame("connected", { serverTime: "2026-11-05T00:00:00.000Z" })),
                    );
                    // `dispose()` 会 abort 在途 fetch：这条记录就是"挂载/卸载成对"的证据。
                    init?.signal?.addEventListener("abort", () => {
                        connection.aborted = true;
                        try {
                            controller.close();
                        } catch {
                            // 重复 close 是唯一可能的抛点：连接已关闭，忽略（不是吞异常路径）。
                        }
                    });
                },
            });
            return new Response(body, {
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
            });
        };
    });

    return state;
}

async function readUserChannel(page: Page): Promise<UserChannelSnapshot> {
    return page.evaluate(() => {
        const scope = window as unknown as Record<string, unknown>;
        const channel = scope.__t56UserChannel as
            | {
                  connections: Array<{ aborted: boolean }>;
                  requests: Array<{ url: string; authorization: string; accept: string }>;
              }
            | undefined;
        return {
            connections: (channel?.connections ?? []).map((connection) => ({
                aborted: connection.aborted,
            })),
            requests: channel?.requests ?? [],
            boots: (scope.__t56Boots as number | undefined) ?? 0,
        };
    });
}

async function pushUserChannelFrame(page: Page, name: string, payload: unknown): Promise<void> {
    await page.evaluate(
        ({ eventName, data }) => {
            const push = (window as unknown as Record<string, unknown>).__t56PushUserChannel as
                | ((name: string, payload: unknown) => void)
                | undefined;
            if (!push) throw new Error("user-channel pusher is not installed");
            push(eventName, data);
        },
        { eventName: name, data: payload },
    );
}

/** 进会话 → 打开 dock 的 `members` tab（工具条入口，桌面布局）。 */
async function openMembersPanel(page: Page): Promise<void> {
    await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`);
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await page.getByTestId("workspace-toolbar-members").click();
    await expect(page.getByTestId("dock-tab-members")).toHaveAttribute("aria-selected", "true", {
        timeout: LONG_TIMEOUT_MS,
    });
    await expect(page.getByTestId("session-participants-panel")).toBeVisible({
        timeout: LONG_TIMEOUT_MS,
    });
}

test.describe("PLAN-0660 T5.6 — user-channel 与已读游标的产品 UI 路径", () => {
    let failures: PageFailures;
    /** 逐条放行"有意为之"的错误信号（目前只有第 5 条故意桩出来的 403）。 */
    let allowFailures: RegExp[];

    test.beforeEach(({ page }) => {
        failures = collectPageFailures(page);
        allowFailures = [];
    });
    test.afterEach(() => {
        // 唯一无条件放行的是外部字体请求（离线环境信号，与本 lane 判据无关）。
        expectNoPageFailures(failures, [FONT_ORIGIN_FAILURE, ...allowFailures]);
    });

    test("1) 登录壳挂载即订阅 user-channel（Bearer + text/event-stream，恰好 1 条）", async ({
        page,
    }) => {
        await setupT56Lane(page);
        await openMembersPanel(page);

        await expect
            .poll(async () => (await readUserChannel(page)).requests.length, {
                timeout: LONG_TIMEOUT_MS,
            })
            .toBe(1);
        const channel = await readUserChannel(page);
        expect(channel.requests[0].url, "user channel wire path").toContain("/api/v1/user-events");
        expect(channel.requests[0].authorization, "authenticated, not anonymous").toBe(
            "Bearer mock-token",
        );
        expect(channel.requests[0].accept).toBe("text/event-stream");
        expect(channel.connections, "one subscription for the whole shell").toHaveLength(1);
    });

    test("2) participant_notified → 名单重读 → 徽标按服务端值更新（且页面不重载）", async ({
        page,
    }) => {
        const state = await setupT56Lane(page);
        await openMembersPanel(page);

        const badge = page.getByTestId(`participant-mention-badge-${OWNER_PARTICIPANT_ID}`);
        await expect(badge, "initial CP-derived unread").toContainText("3");
        const bootsBefore = (await readUserChannel(page)).boots;
        const getsBefore = state.participantsRequests;

        // 服务端派生未读数变了（别人 @ 了我）。客户端只该"重读"，不该自己 +1。
        state.roster = rosterWithMentionCount(7);
        await pushUserChannelFrame(page, "participant_notified", {
            sessionId: SESSION_ID,
            participantId: OWNER_PARTICIPANT_ID,
        });

        // 判据：徽标变成服务端的新值（hint 没接线时永远停在 3）。
        await expect(badge, "the hint must drive a roster re-read").toContainText("7", {
            timeout: LONG_TIMEOUT_MS,
        });
        expect(
            state.participantsRequests,
            "the hint must reach `sessionParticipants.onUserChannelHint` (⇒ a GET)",
        ).toBeGreaterThan(getsBefore);
        expect((await readUserChannel(page)).boots, "no full page reload").toBe(bootsBefore);
    });

    test("3) participant-cursor-advance 只出现在本人的 HUMAN 行", async ({ page }) => {
        await setupT56Lane(page);
        await openMembersPanel(page);

        await expect(page.getByTestId("participant-cursor-advance")).toHaveCount(1);
        await expect(
            page
                .locator(`[data-testid="participant-row-${OWNER_PARTICIPANT_ID}"]`)
                .getByTestId("participant-cursor-advance"),
            "own human row carries the control",
        ).toBeVisible();
        // 我拥有的 AGENT（selfOwned=true 但主体 AGENT）与他人 HUMAN 都不该有。
        await expect(
            page
                .locator(`[data-testid="participant-row-${AGENT_PARTICIPANT_ID}"]`)
                .getByTestId("participant-cursor-advance"),
        ).toHaveCount(0);
        await expect(
            page
                .locator(`[data-testid="participant-row-${MEMBER_PARTICIPANT_ID}"]`)
                .getByTestId("participant-cursor-advance"),
        ).toHaveCount(0);
    });

    test("4) 控件 → PATCH 哨兵；成功后徽标消失且不额外 GET 名单", async ({ page }) => {
        const state = await setupT56Lane(page);
        await openMembersPanel(page);
        await expect(
            page.getByTestId(`participant-mention-badge-${OWNER_PARTICIPANT_ID}`),
        ).toBeVisible();
        const getsBefore = state.participantsRequests;

        const patchRequest = page.waitForRequest(
            (request) => request.method() === "PATCH" && request.url().includes("/cursor"),
            { timeout: LONG_TIMEOUT_MS },
        );
        await page.getByTestId("participant-cursor-advance").click();
        const request = await patchRequest;

        expect(request.url()).toContain(
            `/api/v1/sessions/${SESSION_ID}/participants/${OWNER_PARTICIPANT_ID}/cursor`,
        );
        // 上限由 CP 夹取：前端只发哨兵，不自己算会话最大 sequence。
        expect(request.postDataJSON(), "advance-to-latest sentinel").toEqual({
            lastReadEventSeq: CURSOR_ADVANCE_TO_LATEST,
        });

        // 徽标来自响应里的 mentionCount=0 ⇒ 立即消失；且**没有**重拉整份名单。
        await expect(
            page.getByTestId(`participant-mention-badge-${OWNER_PARTICIPANT_ID}`),
            "badge derives from the server cursor",
        ).toHaveCount(0, { timeout: LONG_TIMEOUT_MS });
        expect(
            state.participantsRequests,
            "adopting the PATCH response must not refetch the roster",
        ).toBe(getsBefore);
        expect(state.cursorRequests, "exactly one PATCH").toHaveLength(1);
    });

    test("5) 403 CURSOR_SELF_ONLY → 本地化文案，本地状态不变", async ({ page }) => {
        const state = await setupT56Lane(page);
        state.cursorStatus = 403;
        // 这条用例**故意**让 PATCH 回 403：它是产品要正确处理的分支，不是环境故障，
        // 所以只放行 cursor 端点上的失败信号（`afterEach` 的其它判据照旧生效）。
        allowFailures = [/\/participants\/[^/]+\/cursor/];
        await openMembersPanel(page);

        const badge = page.getByTestId(`participant-mention-badge-${OWNER_PARTICIPANT_ID}`);
        await expect(badge).toContainText("3");
        const getsBefore = state.participantsRequests;

        await page.getByTestId("participant-cursor-advance").click();

        // 可读文案（本地化，不是 CP 英文 detail）。
        await expect(page.getByTestId("participants-error-detail")).toContainText(
            /只能推进你自己的已读位置|only advance your own read position/i,
            { timeout: LONG_TIMEOUT_MS },
        );
        // 失败不改本地状态：徽标还是服务端的 3，也没多拉名单。
        await expect(badge).toContainText("3");
        expect(state.participantsRequests, "a refused advance must not refetch").toBe(getsBefore);
        expect(state.cursorRequests, "the PATCH was attempted once").toHaveLength(1);
    });

    test("6) 生命周期恰好 1 条连接；登出时连接被 abort（挂载/卸载成对）", async ({ page }) => {
        await setupT56Lane(page);
        await openMembersPanel(page);
        await expect
            .poll(async () => (await readUserChannel(page)).connections.length, {
                timeout: LONG_TIMEOUT_MS,
            })
            .toBe(1);

        // 开关成员面板不新建连接（订阅属于壳，不属于面板）。
        await page.getByTestId("workspace-toolbar-members").click();
        await expect(page.getByTestId("session-participants-panel")).toBeHidden({
            timeout: LONG_TIMEOUT_MS,
        });
        await page.getByTestId("workspace-toolbar-members").click();
        await expect(page.getByTestId("session-participants-panel")).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        expect((await readUserChannel(page)).connections, "still exactly one").toHaveLength(1);

        // 登出入口：全局条常驻（`App.vue:65` 的 `GlobalRail`），footer 的登出按钮
        // `global-rail-logout`（`GlobalRail.vue:110`，截至 `a813ffab01d2`）在任何视口都存在；
        // 面板版 `sidebar-logout`（`Sidebar.vue:279`）只在工作区面板展开时才有 ——
        // 所以这里取全局条那条，而不是指望面板是展开的。
        // 两条入口共用同一个 `auth.logout()` → 同一个 SPA 跳转 → 同一个壳卸载路径。
        await page.getByTestId("global-rail-logout").click();

        // 登出后的落点由路由守卫决定：mock 车道里是 `/onboarding?redirect=…`（不是 `/login`），
        // 关键是**离开了登录后的壳**（AppLayout 卸载）——所以断言"壳里的元素消失"而不是某个具体 URL。
        await expect(page, "left the authenticated shell").toHaveURL(
            /\/(login|onboarding|register)/,
            { timeout: LONG_TIMEOUT_MS },
        );
        await expect(
            page.getByTestId("workspace-toolbar-members"),
            "the authenticated shell is gone",
        ).toHaveCount(0);
        const afterLogout = await readUserChannel(page);
        // 防真空通过：`[].every()` 也是 true，所以先钉住"仍是同一文档 + 恰好 1 条连接"。
        // （若登出变成整页重载，records 会被重置为空数组，那就什么也证明不了。）
        expect(afterLogout.boots, "logout must be an SPA transition, not a reload").toBe(1);
        expect(afterLogout.connections, "same single subscription is still recorded").toHaveLength(
            1,
        );
        await expect
            .poll(
                async () => {
                    const channel = await readUserChannel(page);
                    return channel.connections.length === 1 && channel.connections[0].aborted;
                },
                { timeout: LONG_TIMEOUT_MS },
            )
            .toBe(true);
    });
});

test.describe("PLAN-0660 T5.6 — 窄桌面不溢出（7）", () => {
    // 移动 390×844 不适用：`WorkspaceWorkbench.vue:499` 在 isMobile 时 members-open 恒 false，
    // 成员面板在移动端不可达（详见文件头）。这里用窄桌面替代，保证多一个按钮后行不被裁切。
    test.use({ viewport: { width: 1280, height: 720 } });

    let failures: PageFailures;
    test.beforeEach(({ page }) => {
        failures = collectPageFailures(page);
    });
    test.afterEach(() => {
        expectNoPageFailures(failures, [FONT_ORIGIN_FAILURE]);
    });

    test("7) 1280×720 下推进控件不裁切、行内无横向溢出", async ({ page }) => {
        await setupT56Lane(page);
        await openMembersPanel(page);

        const button = page.getByTestId("participant-cursor-advance");
        await expect(button).toBeVisible();
        const overflow = await page
            .locator(`[data-testid="participant-row-${OWNER_PARTICIPANT_ID}"]`)
            .evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
        expect(overflow.scroll, "row must not overflow horizontally").toBeLessThanOrEqual(
            overflow.client + 1,
        );

        const box = await button.boundingBox();
        if (!box) throw new Error("the advance control has no layout box at 1280×720");
        expect(box.x, "not clipped on the left").toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, "not clipped on the right").toBeLessThanOrEqual(1280);
    });
});
