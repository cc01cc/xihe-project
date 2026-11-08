// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
/**
 * BL-317 / D-198 —— 移动端成员面板（最小版）：390×844 从**溢出菜单**进 `members`、
 * 入口徽标 = 服务端未读和、三处命中区域 ≥44×44、写能力投影正确。
 *
 * 为什么入口是溢出菜单：桌面那条 `workspace-toolbar-members` 在 `max-md` 下是 hidden
 * （`WorkspaceToolbar.vue` 的桌面 action cluster 是 `max-md:hidden`），移动端真正可达的是
 * `workspace-toolbar-more-mobile` 溢出菜单 —— 调研（`.local/evidence/bl-317-mobile-research.md`
 * §4-#1）里 5 个有移动端代码的参考仓也是同一形态：**入口在菜单、面板独占一屏**。
 *
 * 判据（与 Lead 验收单一一对应）：
 * 1. 390×844：溢出菜单 → members 项 → aux sheet 打开且 `mobile-aux-tab-members[aria-selected=true]`；
 * 2. 入口徽标 = **mock 服务端 `readCursor.mentionCount` 之和**（3），非 `>=0` 恒真断言；
 * 3. EDITOR 下推进控件可点 → PATCH body = 哨兵；VIEWER 下 `disabled` + 只读文案 + **零 PATCH**；
 * 4. 三处命中区域 ≥44×44（溢出菜单入口 / sheet tab / 推进控件），390 无横向溢出、sheet 滚到顶。
 *
 * 写域纪律：本文件名带 `bl317-` 前缀；**只用自己的路由桩**（participants / cursor），
 * 复用 `helpers/*` 的既有导出（`setupMockAuth`/`setupMockSessions`/page-failures/session-projections），
 * 不修改 helpers、不修改其它 mock spec。
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { collectPageFailures, expectNoPageFailures } from "./helpers/page-failures";
import type { PageFailures } from "./helpers/page-failures";
import { FONT_ORIGIN_FAILURE, stubSessionProjections } from "./helpers/session-projections";
import { EXPECT_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const WORKSPACE_ID = "workspace-1";
const SESSION_ID = "bl317-session";
const OWNER_PARTICIPANT_ID = "part-bl317-owner";
const AGENT_PARTICIPANT_ID = "part-bl317-agent";
/** 与 `src/composables/api.ts#PARTICIPANT_CURSOR_ADVANCE_TO_LATEST` 一致（改了要同批改这里）。 */
const CURSOR_ADVANCE_TO_LATEST = 9_007_199_254_740_991;
/** 服务端给的未读提及数（入口徽标必须等于它，而不是恒 0）。 */
const SERVER_MENTION_COUNT = 3;
/** D-198 移动端验收视口。 */
const MOBILE_VIEWPORT = { width: 390, height: 844 };
/** 触摸命中区域下限（Lead 决策 2）。 */
const MIN_TOUCH = 44;

const CAPABILITIES = { view: true, manage: true, mention: true, speakAs: false };

interface WireCursor {
    lastReadEventSeq: number;
    mentionCount: number;
    updatedAt: string;
}

interface LaneState {
    /** 收到的 cursor PATCH body（判据：VIEWER 必须为 0 条）。 */
    cursorRequests: Array<Record<string, unknown>>;
    /** cursor PATCH 的响应：采纳后徽标归零。 */
    cursorBody: WireCursor;
    participantsRequests: number;
}

function cursorOf(mentionCount: number, lastReadEventSeq = 10): WireCursor {
    return { lastReadEventSeq, mentionCount, updatedAt: "2026-11-05T00:00:00.000Z" };
}

/** 两条参与者：本人 HUMAN（有未读）+ 我方 AGENT（无游标）。 */
function roster(mentionCount: number) {
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
            principalId: "agent-bl317",
            displayName: "Agent Bl317",
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
    ];
}

async function setupLane(
    page: Page,
    options: { workspaceRole?: "OWNER" | "EDITOR" | "VIEWER" } = {},
): Promise<LaneState> {
    const state: LaneState = {
        cursorRequests: [],
        cursorBody: cursorOf(0, 42),
        participantsRequests: 0,
    };

    const role = options.workspaceRole ?? "EDITOR";
    // `canWrite` 按 CP 权威语义给：VIEWER ⇒ false（`auth.canWriteWorkspace` 的既有投影）。
    await setupMockAuth(page, { workspace: { workspaceRole: role, canWrite: role !== "VIEWER" } });
    await setupMockSessions(page, {
        sessions: [{ id: SESSION_ID, title: "BL-317 mobile members" }],
    });
    // 聊天列挂载后会拉 derived-state / follow-ups / commands：用公共桩（不手写、不复制别家 spec）。
    await stubSessionProjections(page, SESSION_ID);

    await page.route(`**/api/v1/sessions/${SESSION_ID}/participants`, async (route) => {
        state.participantsRequests += 1;
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                participants: roster(SERVER_MENTION_COUNT),
                capabilities: CAPABILITIES,
            }),
        });
    });

    await page.route(`**/api/v1/sessions/${SESSION_ID}/participants/*/cursor`, async (route) => {
        state.cursorRequests.push(route.request().postDataJSON() as Record<string, unknown>);
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(state.cursorBody),
        });
    });

    return state;
}

/** 打开移动端溢出菜单（入口族：`workspace-toolbar-more-mobile`）。 */
async function openOverflowMenu(page: Page): Promise<void> {
    await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`);
    const more = page.getByTestId("workspace-toolbar-more-mobile");
    await expect(more).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await more.click();
    await expect(page.getByTestId("workspace-toolbar-more-menu")).toBeVisible({
        timeout: LONG_TIMEOUT_MS,
    });
}

/** 溢出菜单 → members → aux sheet 的 members 页（返回时面板已可见）。 */
async function openMobileMembers(page: Page): Promise<void> {
    await openOverflowMenu(page);
    const entry = page.getByTestId("workspace-toolbar-more-members");
    await expect(entry).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await entry.click();
    await expect(page.getByTestId("mobile-changes-sheet")).toBeVisible({
        timeout: LONG_TIMEOUT_MS,
    });
    await expect(page.getByTestId("mobile-aux-tab-members")).toHaveAttribute(
        "aria-selected",
        "true",
        { timeout: LONG_TIMEOUT_MS },
    );
    await expect(page.getByTestId("session-participants-panel")).toBeVisible({
        timeout: LONG_TIMEOUT_MS,
    });
    await expect(page.getByTestId("participants-list")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
}

/** 命中区域断言：`boundingBox()` 实测 ≥44×44（不靠肉眼、不靠 class 文本）。 */
async function expectTouchTarget(page: Page, testId: string): Promise<void> {
    const box = await page.getByTestId(testId).boundingBox();
    if (!box) throw new Error(`${testId} has no layout box at 390×844`);
    expect(box.height, `${testId} height ≥ ${MIN_TOUCH}px`).toBeGreaterThanOrEqual(MIN_TOUCH);
    expect(box.width, `${testId} width ≥ ${MIN_TOUCH}px`).toBeGreaterThanOrEqual(MIN_TOUCH);
}

test.describe("BL-317 移动端成员面板（390×844）", () => {
    let failures: PageFailures;

    test.use({ viewport: MOBILE_VIEWPORT });

    test.beforeEach(({ page }) => {
        failures = collectPageFailures(page);
    });
    test.afterEach(() => {
        expectNoPageFailures(failures, [FONT_ORIGIN_FAILURE]);
    });

    test("溢出菜单入口：徽标 = 服务端未读和，EDITOR 可推进已读", async ({ page }) => {
        const state = await setupLane(page);
        await openOverflowMenu(page);

        // 溢出菜单面板必须完整落在 390 内（实测曾是 x=-61：菜单被裁掉且页面不产生横向滚动，
        // 等于成员项点不到 —— 见 `WorkspaceToolbar.vue` 的 `left-0` 注释）。
        const menuBox = await page.getByTestId("workspace-toolbar-more-menu").boundingBox();
        if (!menuBox) throw new Error("overflow menu has no layout box at 390×844");
        expect(menuBox.x, "overflow menu not clipped on the left").toBeGreaterThanOrEqual(0);
        expect(
            menuBox.x + menuBox.width,
            "overflow menu not clipped on the right",
        ).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);

        // 入口 44×44（决策 2 的三处之一）。
        await expectTouchTarget(page, "workspace-toolbar-more-members");

        // 徽标值 == mock 服务端 `readCursor.mentionCount` 之和（3），不是恒真断言。
        await expect(page.getByTestId("workspace-toolbar-more-members-badge")).toHaveText(
            `@${SERVER_MENTION_COUNT}`,
            { timeout: LONG_TIMEOUT_MS },
        );
        // 不只靠视觉：aria-label 里必须带出数量。
        await expect(page.getByTestId("workspace-toolbar-more-members")).toHaveAttribute(
            "aria-label",
            new RegExp(String(SERVER_MENTION_COUNT)),
        );

        await page.getByTestId("workspace-toolbar-more-members").click();
        await expect(page.getByTestId("session-participants-panel")).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });

        // 面板内徽标同样是服务端值（同一份 store）。
        await expect(
            page.getByTestId(`participant-mention-badge-${OWNER_PARTICIPANT_ID}`),
        ).toHaveText(`@${SERVER_MENTION_COUNT}`);

        // 推进控件：EDITOR 可点 → PATCH 哨兵 → 徽标按响应游标归零。
        const advance = page.getByTestId("participant-cursor-advance");
        await expect(advance).toBeEnabled();
        await advance.click();
        await expect.poll(() => state.cursorRequests.length, { timeout: LONG_TIMEOUT_MS }).toBe(1);
        expect(state.cursorRequests[0]).toEqual({ lastReadEventSeq: CURSOR_ADVANCE_TO_LATEST });
        await expect(
            page.getByTestId(`participant-mention-badge-${OWNER_PARTICIPANT_ID}`),
        ).toHaveCount(0, { timeout: LONG_TIMEOUT_MS });
    });

    test("VIEWER：推进控件点击前即 disabled，点击不产生 PATCH", async ({ page }) => {
        const state = await setupLane(page, { workspaceRole: "VIEWER" });
        await openMobileMembers(page);

        // 只读 ≠ 看不到状态：面板内徽标仍在。
        await expect(
            page.getByTestId(`participant-mention-badge-${OWNER_PARTICIPANT_ID}`),
        ).toHaveText(`@${SERVER_MENTION_COUNT}`);

        const advance = page.getByTestId("participant-cursor-advance");
        await expect(advance).toBeDisabled();
        await expect(advance).toHaveAttribute("title", /只读|read-only/i);

        await advance.click({ force: true });
        await expect
            .poll(() => state.cursorRequests.length, { timeout: EXPECT_TIMEOUT_MS })
            .toBe(0);
    });

    test("三处命中区域 ≥44×44；390 无横向溢出且 sheet 滚到顶", async ({ page }) => {
        await setupLane(page);
        await openOverflowMenu(page);
        // ① 溢出菜单里的 members 项（菜单点完就关，所以必须在点击**之前**量）
        await expectTouchTarget(page, "workspace-toolbar-more-members");

        await page.getByTestId("workspace-toolbar-more-members").click();
        await expect(page.getByTestId("participants-list")).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });

        // ② sheet 的三个 tab（逐个量，别只看 members）
        for (const tab of ["monitor", "changes", "members"]) {
            await expectTouchTarget(page, `mobile-aux-tab-${tab}`);
        }
        // ③ 推进控件
        await expectTouchTarget(page, "participant-cursor-advance");

        // 横向不溢出：页面 + 行。
        const pageSize = await page.evaluate(() => ({
            scroll: document.documentElement.scrollWidth,
            client: document.documentElement.clientWidth,
        }));
        expect(pageSize.scroll, "page must not overflow horizontally").toBeLessThanOrEqual(
            pageSize.client + 1,
        );
        const row = await page
            .locator(`[data-testid="participant-row-${OWNER_PARTICIPANT_ID}"]`)
            .evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
        expect(row.scroll, "row must not overflow horizontally").toBeLessThanOrEqual(
            row.client + 1,
        );

        // sheet 打开后是"到顶"状态（不是停在上次的滚动位置）。
        expect(
            await page.getByTestId("mobile-changes-sheet").evaluate((element) => element.scrollTop),
            "sheet opens at the top",
        ).toBe(0);
        // 第一行必须落在视口内（可读，不被裁切）。
        const firstRow = await page
            .locator(`[data-testid="participant-row-${OWNER_PARTICIPANT_ID}"]`)
            .boundingBox();
        if (!firstRow) throw new Error("owner row has no layout box");
        expect(firstRow.y).toBeGreaterThanOrEqual(0);
        expect(firstRow.y + firstRow.height).toBeLessThanOrEqual(MOBILE_VIEWPORT.height);

        // tab 仍可切换（members ↔ monitor），切回后成员面板还在。
        await page.getByTestId("mobile-aux-tab-monitor").click();
        await expect(page.getByTestId("mobile-aux-tab-monitor")).toHaveAttribute(
            "aria-selected",
            "true",
        );
        await page.getByTestId("mobile-aux-tab-members").click();
        await expect(page.getByTestId("session-participants-panel")).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
    });
});
