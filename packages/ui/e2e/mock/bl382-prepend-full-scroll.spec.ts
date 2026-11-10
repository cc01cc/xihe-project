// timeout-exempt: 真·1200 条全展开（BL-382 prepend 路径）后逐条复验四风险；多轮滚动采样按设计超默认 10s 预算
/**
 * PLAN-0753 M4 / BL-382 prepend 路径 —— 真·1200 条全展开后的窗口化复验（task-190）。
 *
 * 与 bl482-long-transcript-scroll.spec.ts 的分工：那份验的是「产品保留最近 500 条」状态下的窗口；
 * 本份点「加载更早」把折叠的更早段真的 prepend 进表，然后复验四风险。
 *
 * ⚠️ 现状（BL-556，2026-11-10 实测）：折叠场景下 prepend 净效果为零 —— 500 上限（PLAN-0670 M2d.3）
 * 与 loadOlderMessages 对抗，prepend 进表的行当帧被 trim 丢回，视口内容不变、阅读位置漂移。
 * 本 spec 的 test1/test2 即该缺陷的复现基线（修复前红、修复后绿），test3 是对照（≤500 条正常）。
 *
 * ⚠️ 路由注册顺序（实测踩坑）：setupMockAuth 与 setupMockSessions 内部都会注册 sessions 通配路由，
 * 窄路由必须最后注册（Playwright 后注册者优先），否则静默回落通用夹具。
 */
import { expect, test } from "@playwright/test";
import { ChatPage } from "../page-objects/ChatPage";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { collectPageFailures, expectNoPageFailures } from "./helpers/page-failures";
import type { PageFailures } from "./helpers/page-failures";
import { FONT_ORIGIN_FAILURE, stubSessionProjections } from "./helpers/session-projections";
import { EXPECT_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const SESSION_ID = "bl382-prepend-full";
const TOTAL = 1_200;
const RETAINED = 500;
const OLDEST_RETAINED = TOTAL - RETAINED;
const CURSOR = "mock-page-1";
const EVIDENCE_DIR = process.env.XH_0753_EVIDENCE_DIR;
const FOLD_BANNER_TEXT = `更早的 ${TOTAL - RETAINED} 条消息已折叠`;
const MESSAGES_PATH = (sessionId: string) => `/api/v1/sessions/${sessionId}/messages`;

interface ScrollSample {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    renderedRows: number;
    topSpacer: number;
    bottomSpacer: number;
}

/** 视口几何 + 窗口化读数（渲染行数 / 上下占位）。 */
async function readSample(page: import("@playwright/test").Page): Promise<ScrollSample> {
    return page.evaluate(() => {
        const viewport = document.querySelector<HTMLElement>(
            '[data-testid="message-scroller-viewport"]',
        );
        if (!viewport) throw new Error("viewport missing");
        const spacerHeight = (testId: string): number => {
            const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
            return element ? Number.parseFloat(element.style.height || "0") || 0 : 0;
        };
        return {
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            clientHeight: viewport.clientHeight,
            renderedRows: document.querySelectorAll('[data-testid="run-group-body"]').length,
            topSpacer: spacerHeight("virtual-top-spacer"),
            bottomSpacer: spacerHeight("virtual-bottom-spacer"),
        };
    });
}

/** 视口内"最靠上"的可见行 id（prepend 保位判据的锚点）。 */
async function readFirstVisibleRow(page: import("@playwright/test").Page): Promise<string | null> {
    return page.evaluate(() => {
        const viewport = document.querySelector<HTMLElement>(
            '[data-testid="message-scroller-viewport"]',
        );
        if (!viewport) return null;
        const viewportTop = viewport.getBoundingClientRect().top;
        let best: { id: string; offset: number } | null = null;
        for (const element of document.querySelectorAll<HTMLElement>(
            '[data-slot="message-scroller-item"]',
        )) {
            const rect = element.getBoundingClientRect();
            if (rect.bottom <= viewportTop) continue;
            const offset = rect.top - viewportTop;
            if (best === null || offset < best.offset) {
                best = { id: element.dataset.messageId ?? "", offset };
            }
        }
        return best ? best.id : null;
    });
}

/** 锚点行的"顶部相对视口顶"偏移（px）；null = 行不在 DOM。 */
async function readRowOffset(
    page: import("@playwright/test").Page,
    id: string,
): Promise<number | null> {
    return page.evaluate((target) => {
        const viewport = document.querySelector<HTMLElement>(
            '[data-testid="message-scroller-viewport"]',
        );
        const row = Array.from(
            document.querySelectorAll<HTMLElement>('[data-slot="message-scroller-item"]'),
        ).find((element) => element.dataset.messageId === target);
        if (!viewport || !row) return null;
        return row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    }, id);
}

async function settle(page: import("@playwright/test").Page): Promise<void> {
    await page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
    );
}

/** 等表几何稳定（连续两次采样 scrollHeight 一致）。 */
async function waitScrollHeightStable(
    page: import("@playwright/test").Page,
): Promise<ScrollSample> {
    let previous = await readSample(page);
    for (let round = 0; round < 20; round += 1) {
        await settle(page);
        const current = await readSample(page);
        if (current.scrollHeight === previous.scrollHeight) return current;
        previous = current;
    }
    return previous;
}

async function scrollToOffset(
    page: import("@playwright/test").Page,
    offset: number,
): Promise<void> {
    await page.evaluate((target) => {
        const viewport = document.querySelector<HTMLElement>(
            '[data-testid="message-scroller-viewport"]',
        );
        if (!viewport) throw new Error("viewport missing");
        viewport.dispatchEvent(
            new WheelEvent("wheel", {
                bubbles: true,
                deltaY: target < viewport.scrollTop ? -1 : 1,
            }),
        );
        viewport.scrollTop = target;
        viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, offset);
    await settle(page);
}

/** 造一页消息（id/文本按 index 生成，时间戳递增）。 */
function makePage(sessionId: string, count: number, offset: number) {
    return Array.from({ length: count }, (_, index) => {
        const globalIndex = offset + index;
        return {
            id: `bl382-msg-${globalIndex}`,
            sessionId,
            role: globalIndex % 2 === 0 ? "USER" : "ASSISTANT",
            content:
                `bl382-row-${globalIndex}` +
                (globalIndex % 7 === 0 ? " · " + "长行内容 ".repeat(30) : ""),
            createdAt: new Date(Date.now() - (TOTAL - globalIndex) * 60_000).toISOString(),
        };
    });
}

/** 注册会话 + 参与者桩（内容不生效：分页路由最后覆盖）。 */
async function setupSessionFixture(
    page: import("@playwright/test").Page,
    sessionId: string,
    title: string,
): Promise<void> {
    await setupMockSessions(page, {
        sessions: [{ id: sessionId, title }],
        messages: {
            [sessionId]: [
                {
                    id: `${sessionId}-placeholder`,
                    sessionId,
                    role: "USER",
                    content: `${sessionId}-placeholder`,
                    createdAt: new Date().toISOString(),
                },
            ],
        },
    });
    await stubSessionProjections(page, sessionId);
    await page.route(`**/api/v1/sessions/${sessionId}/participants`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                participants: [],
                capabilities: { view: false, manage: false, mention: false, speakAs: false },
            }),
        });
    });
}

/** 窄路由：首屏（全量）与 before 页（更早段）。必须最后注册。 */
async function installPaginationRoutes(
    page: import("@playwright/test").Page,
    sessionId: string,
    firstScreen: unknown[],
    olderPage: unknown[],
    firstCursor: string | null,
    firstTruncated: boolean,
    olderCursor: string | null,
    olderTruncated: boolean,
): Promise<void> {
    const path = MESSAGES_PATH(sessionId);
    await page.route(
        (url) => url.hostname === "localhost" && url.pathname.endsWith(path),
        async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    messages: firstScreen,
                    nextCursor: firstCursor,
                    truncated: firstTruncated,
                }),
            });
        },
    );
    await page.route(
        (url) =>
            url.hostname === "localhost" &&
            url.pathname.endsWith(path) &&
            url.searchParams.has("before"),
        async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    messages: olderPage,
                    nextCursor: olderCursor,
                    truncated: olderTruncated,
                }),
            });
        },
    );
}

/** 等窗口化生效（spacer 出现）。 */
async function waitForVirtualization(page: import("@playwright/test").Page): Promise<void> {
    await expect(page.locator('[data-testid="virtual-top-spacer"]')).toHaveCount(1, {
        timeout: LONG_TIMEOUT_MS,
    });
}

test.describe("PLAN-0753 M4 / BL-382：真·1200 条全展开 prepend 路径复验", () => {
    let failures: PageFailures;

    test.beforeEach(async ({ page }) => {
        failures = collectPageFailures(page);
        await setupMockAuth(page);
        // 顺序：fixture 先（注册会话 + 通配路由），窄路由后（覆盖通配）。
        await setupSessionFixture(page, SESSION_ID, "BL-382 Full Transcript");
        await installPaginationRoutes(
            page,
            SESSION_ID,
            makePage(SESSION_ID, TOTAL, 0),
            makePage(SESSION_ID, OLDEST_RETAINED, 0),
            CURSOR,
            true,
            null,
            false,
        );
    });

    test.afterEach(() => {
        expectNoPageFailures(failures, [FONT_ORIGIN_FAILURE]);
    });

    test("prepend 全展开后：保位 / 贴底 / 上滚单调 / 窗口有界 逐条复验", async ({
        page,
    }, testInfo) => {
        // timeout-exempt: 连点 20 次分页 + 每次几何稳定等待
        test.setTimeout(60_000); // timeout-exempt: 千条级多轮滚动采样 + 几何稳定等待
        const chat = new ChatPage(page);
        await chat.goto(SESSION_ID);
        await expect(chat.scrollerViewport).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await waitForVirtualization(page);

        const shot = async (name: string): Promise<void> => {
            const path = EVIDENCE_DIR
                ? `${EVIDENCE_DIR}/bl382-full-${name}.png`
                : testInfo.outputPath(`bl382-full-${name}.png`);
            await page.screenshot({ path });
        };

        // —— 起点：保留 500 条 + 折叠横幅 ——
        const before = await readSample(page);
        await expect(page.getByText(FOLD_BANNER_TEXT, { exact: false }).first()).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        const loadOlderButton = page.locator('[data-testid="load-older-messages"]');
        await expect(loadOlderButton).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });

        // —— ① prepend 保位：加载前抓锚点，加载后同一行仍在原视觉位置（Δ ≤ 2px） ——
        const anchorBefore = await readFirstVisibleRow(page);
        const anchorOffsetBefore = await readRowOffset(page, anchorBefore ?? "");
        expect(anchorBefore, "prepend 前必须能读到锚点行").toBeTruthy();
        expect(anchorOffsetBefore, "prepend 前必须能读到锚点偏移").not.toBeNull();

        const preClick = await readSample(page);
        await loadOlderButton.click();
        await settle(page);
        const postClick = await waitScrollHeightStable(page);
        await shot("after-prepend");

        const anchorOffsetAfter = await readRowOffset(page, anchorBefore ?? "");
        expect(anchorOffsetAfter, `prepend 后锚点行 ${anchorBefore} 必须仍在 DOM`).not.toBeNull();
        const anchorDelta = Math.abs((anchorOffsetAfter ?? 0) - (anchorOffsetBefore ?? 0));
        expect(
            anchorDelta,
            `prepend 保位失败：锚点行 ${anchorBefore} 偏移 ${anchorOffsetBefore}px → ${anchorOffsetAfter}px（Δ=${anchorDelta}，期望 ≤2）`,
        ).toBeLessThanOrEqual(2);

        // 折叠被消费：更早段进入表（scrollHeight 明显增长）。
        expect(
            postClick.scrollHeight,
            `prepend 未落地：scrollHeight ${preClick.scrollHeight} → ${postClick.scrollHeight}`,
        ).toBeGreaterThan(preClick.scrollHeight + 1_000);

        // —— ② 贴底跟随：加载后仍贴底（末行可见、下占位 ≈0） ——
        const afterPrepend = await readSample(page);
        expect(afterPrepend.bottomSpacer, "prepend 后仍应贴底").toBeLessThan(2);
        await expect(
            page.getByText(`bl382-row-${TOTAL - 1}`, { exact: false }).first(),
        ).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });

        // —— ③ 上滚单调不增 + 到顶（真·全量：表顶 = row-0） ——
        const STEP_PX = 4_000;
        const samples: ScrollSample[] = [];
        let current = await readSample(page);
        let guard = 0;
        while (current.scrollTop > 8 && guard < 80) {
            guard += 1;
            samples.push(current);
            await scrollToOffset(page, Math.max(0, current.scrollTop - STEP_PX));
            current = await readSample(page);
        }
        samples.push(current);
        let violations = 0;
        const settleJumps: number[] = [];
        for (let index = 1; index < samples.length; index += 1) {
            const drift = samples[index].scrollTop - samples[index - 1].scrollTop;
            if (drift > 8) {
                if (drift <= 64 && samples[index].scrollTop > 1_000 && settleJumps.length === 0) {
                    settleJumps.push(drift);
                } else {
                    violations += 1;
                }
            }
        }
        expect(
            violations,
            `prepend 全展开后上滚违规回跳=${violations}（容忍抖动=${settleJumps.join(",") || "无"}）：` +
                samples.map((sample) => Math.round(sample.scrollTop)).join(" → "),
        ).toBe(0);
        const maxRendered = Math.max(
            ...samples.map((sample) => sample.renderedRows),
            before.renderedRows,
        );
        expect(maxRendered, `全展开后渲染行数=${maxRendered}（总 ${TOTAL}）`).toBeLessThan(
            TOTAL / 4,
        );
        expect(current.scrollTop, "prepend 全展开后仍应能到顶").toBeLessThan(8);
        await expect(page.getByText("bl382-row-0", { exact: false }).first()).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await shot("top-full");

        // —— 证据 JSON ——
        if (EVIDENCE_DIR) {
            await import("node:fs/promises").then((fsModule) =>
                fsModule.writeFile(
                    `${EVIDENCE_DIR}/bl382-prepend-full-samples.json`,
                    JSON.stringify(
                        {
                            sessionId: SESSION_ID,
                            total: TOTAL,
                            retained: RETAINED,
                            oldestRetained: OLDEST_RETAINED,
                            before,
                            anchorBefore,
                            anchorOffsetBefore,
                            anchorOffsetAfter,
                            anchorDelta,
                            preClick,
                            postClick,
                            afterPrepend,
                            scrollUpSamples: samples,
                            maxRendered,
                            settleJumps,
                        },
                        null,
                        2,
                    ),
                ),
            );
        }
    });

    // timeout-exempt: 连点 20 次分页 + 每次几何稳定等待，按设计超默认 30s 预算
    test("真实 CP 分页形态：首屏 500 + 每页 50，连点必须让更早段进入可读范围（BL-556）", async ({
        page,
    }, testInfo) => {
        test.setTimeout(60_000); // timeout-exempt: 连点 20 次分页 + 几何稳定等待
        const realisticSession = "bl382-prepend-realistic";
        const realisticAll = Array.from({ length: TOTAL }, (_, index) => ({
            id: `bl382-real-${index}`,
            sessionId: realisticSession,
            role: index % 2 === 0 ? "USER" : "ASSISTANT",
            content: `bl382-real-row-${index}`,
            createdAt: new Date(Date.now() - (TOTAL - index) * 60_000).toISOString(),
        }));
        const firstScreen = realisticAll.slice(TOTAL - RETAINED);
        await setupSessionFixture(page, realisticSession, "BL-382 Realistic");
        // 窄路由必须在 fixture 之后注册（否则被 sessions 通配路由吞掉）。
        await installPaginationRoutes(
            page,
            realisticSession,
            firstScreen,
            [],
            "real-cursor-700",
            true,
            null,
            false,
        );
        const path = MESSAGES_PATH(realisticSession);
        await page.route(
            (url) =>
                url.hostname === "localhost" &&
                url.pathname.endsWith(path) &&
                url.searchParams.has("before"),
            async (route) => {
                const cursor = Number(
                    route.request().url().split("before=").pop()?.split("-").pop() ?? "700",
                );
                const end = Math.max(0, cursor);
                const start = Math.max(0, end - 50);
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        messages: realisticAll.slice(start, end),
                        nextCursor: start > 0 ? `real-cursor-${start}` : null,
                        truncated: start > 0,
                    }),
                });
            },
        );

        const chat = new ChatPage(page);
        await chat.goto(realisticSession);
        await expect(chat.scrollerViewport).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await waitForVirtualization(page);

        const samples: Array<{
            click: number;
            scrollHeight: number;
            renderedRows: number;
            banner: boolean;
        }> = [];
        for (let click = 0; click < 20; click += 1) {
            const button = page.locator('[data-testid="load-older-messages"]');
            if ((await button.count()) === 0) break;
            await button.click();
            await settle(page);
            const sample = await readSample(page);
            samples.push({
                click,
                scrollHeight: sample.scrollHeight,
                renderedRows: sample.renderedRows,
                banner: (await page.getByText("更早的", { exact: false }).count()) > 0,
            });
        }

        if (EVIDENCE_DIR) {
            await import("node:fs/promises").then((fsModule) =>
                fsModule.writeFile(
                    `${EVIDENCE_DIR}/bl382-realistic-samples.json`,
                    JSON.stringify(samples, null, 2),
                ),
            );
            await page.screenshot({
                path: `${EVIDENCE_DIR}/bl382-realistic-after-paging.png`,
            });
        } else {
            await page.screenshot({
                path: testInfo.outputPath("bl382-realistic-after-paging.png"),
            });
        }

        // BL-556 缺陷断言（修复前红、修复后绿）：连点必须让「更早段」真正进入可读范围。
        const first = samples[0];
        const last = samples.at(-1);
        const grew = (last?.scrollHeight ?? 0) - (first?.scrollHeight ?? 0);
        const bannerStillShown = samples.some((sample) => sample.banner);
        expect(
            grew > 5_000 && !bannerStillShown,
            `BL-556 未修复：连点 ${samples.length} 次后 scrollHeight 仅增 ${grew}px，` +
                `折叠横幅仍在=${bannerStillShown}（样本=${JSON.stringify(samples)}）`,
        ).toBe(true);
    });

    // timeout-exempt: 小表 prepend 对照需等几何稳定，按设计超默认 30s 预算
    test("对照：≤500 条（不折叠）时 prepend 正常（缺陷只在折叠场景）", async ({ page }) => {
        // timeout-exempt: 小表 prepend 对照需等几何稳定
        test.setTimeout(60_000);
        const smallSession = "bl382-prepend-small";
        const smallAll = Array.from({ length: 500 }, (_, index) => ({
            id: `bl382-small-${index}`,
            sessionId: smallSession,
            role: index % 2 === 0 ? "USER" : "ASSISTANT",
            content: `bl382-small-row-${index}`,
            createdAt: new Date(Date.now() - (500 - index) * 60_000).toISOString(),
        }));
        await setupSessionFixture(page, smallSession, "BL-382 Small");
        await installPaginationRoutes(
            page,
            smallSession,
            smallAll.slice(100),
            smallAll.slice(0, 100),
            "small-cursor",
            true,
            null,
            false,
        );

        const chat = new ChatPage(page);
        await chat.goto(smallSession);
        await expect(chat.scrollerViewport).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        const before = await readSample(page);
        const button = page.locator('[data-testid="load-older-messages"]');
        await expect(button).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await button.click();
        await settle(page);
        const after = await waitScrollHeightStable(page);

        // 期望：prepend 100 条 ⇒ scrollHeight 明显增长且不再折叠。
        expect(after.scrollHeight, "小表 prepend 应落地").toBeGreaterThan(
            before.scrollHeight + 2_000,
        );
        expect(await page.getByText("更早的", { exact: false }).count(), "小表折叠应耗尽").toBe(0);
    });
});
