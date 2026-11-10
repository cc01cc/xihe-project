// timeout-exempt: 真·1200 条全展开（BL-382 prepend 路径）后逐条复验四风险；多轮滚动采样按设计超默认 10s 预算
/**
 * PLAN-0753 M4 / BL-382 prepend 路径 —— **真·1200 条全展开**后的窗口化复验（task-190）。
 *
 * 与 bl482-long-transcript-scroll.spec.ts 的分工：那份验的是「产品保留最近 500 条」状态下的窗口；
 * 本份点「加载更早」把折叠的 700 条真的 prepend 进表（foldedCount 700 → 0），然后复验：
 * ① prepend 保位：加载前后锚点行（视口内首行）视觉偏移 Δ ≤ 2px；
 * ② 贴底跟随：加载后仍贴底（末行可见、下占位 ≈ 0）；
 * ③ 上滚单调不增：加载后上滚不回跳（容 ≤64px settle 抖动一次）；
 * ④ 窗口有界 + 零 pageError：渲染行数远小于总条数；无自触发循环。
 *
 * 分页夹具（与 CP 契约同形 { messages, nextCursor, truncated }，ChatPanel.loadOlderMessages :435-468）：
 * 首屏 = 全部 1200 条 + truncated:true + nextCursor；before 页 = 更早的 700 条 + 终止标记。
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

interface ScrollSample {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    renderedRows: number;
    topSpacer: number;
    bottomSpacer: number;
}

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
    return page.evaluate(
        (target) => {
            const viewport = document.querySelector<HTMLElement>(
                '[data-testid="message-scroller-viewport"]',
            );
            const row = Array.from(document.querySelectorAll<HTMLElement>(
                '[data-slot="message-scroller-item"]',
            )).find((element) => element.dataset.messageId === target);
            if (!viewport || !row) return null;
            return row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
        },
        id,
    );
}

async function settle(page: import("@playwright/test").Page): Promise<void> {
    await page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
    );
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
function makePage(count: number, offset: number) {
    return Array.from({ length: count }, (_, index) => {
        const globalIndex = offset + index;
        return {
            id: `bl382-msg-${globalIndex}`,
            sessionId: SESSION_ID,
            role: globalIndex % 2 === 0 ? "USER" : "ASSISTANT",
            content:
                `bl382-row-${globalIndex}` +
                (globalIndex % 7 === 0 ? " · " + "长行内容 ".repeat(30) : ""),
            createdAt: new Date(Date.now() - (TOTAL - globalIndex) * 60_000).toISOString(),
        };
    });
}

test.describe("PLAN-0753 M4 / BL-382：真·1200 条全展开 prepend 路径复验", () => {
    let failures: PageFailures;

    test.beforeEach(async ({ page }) => {
        failures = collectPageFailures(page);
        // 埋点：首屏 messages 请求与响应体（诊断窄路由是否命中）。
        page.on("response", async (response) => {
            const url = response.url();
            if (url.includes("/messages")) {
                let body = "";
                try {
                    body = (await response.text()).slice(0, 160);
                } catch {
                    body = "<unreadable>";
                }
                console.log("[bl382-debug] RESP " + url + " => " + body);
            }
        });
        await setupMockAuth(page);
        // 注入用于注册会话（消息内容不生效：窄路由在下面覆盖）。
        await setupMockSessions(page, {
            sessions: [{ id: SESSION_ID, title: "BL-382 Full Transcript" }],
            messages: {
                [SESSION_ID]: [
                    {
                        id: "bl382-placeholder",
                        sessionId: SESSION_ID,
                        role: "USER",
                        content: "bl382-placeholder",
                        createdAt: new Date().toISOString(),
                    },
                ],
            },
        });
        await stubSessionProjections(page, SESSION_ID);
        await page.route(`**/api/v1/sessions/${SESSION_ID}/participants`, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    participants: [],
                    capabilities: { view: false, manage: false, mention: false, speakAs: false },
                }),
            });
        });
        // 窄路由最后注册（覆盖 setupMockSessions 闭包内的 sessions 通配路由）。
        // ① 首屏 = 全部 1200 条 + 分页信封（truncated:true ⇒ 产品显示「加载更早」）
        await page.route(
            (url) => url.hostname === "localhost" && /\/api\/v1\/sessions\/bl382-prepend-full\/messages$/.test(url.pathname),
            async (route) => {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        messages: makePage(TOTAL, 0),
                        nextCursor: CURSOR,
                        truncated: true,
                    }),
                });
            },
        );
        // ② 翻页 = 更早的 700 条 + 终止标记（truncated:false ⇒ 入口消失）
        await page.route(
            (url) =>
                url.hostname === "localhost" &&
                /\/api\/v1\/sessions\/bl382-prepend-full\/messages$/.test(url.pathname) &&
                url.searchParams.has("before"),
            async (route) => {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        messages: makePage(OLDEST_RETAINED, 0),
                        nextCursor: null,
                        truncated: false,
                    }),
                });
            },
        );
    });

    test.afterEach(() => {
        expectNoPageFailures(failures, [FONT_ORIGIN_FAILURE]);
    });

    test("prepend 全展开后：保位 / 贴底 / 上滚单调 / 窗口有界 逐条复验", async ({ page }, testInfo) => {
        test.setTimeout(LONG_TIMEOUT_MS * 3);
        const chat = new ChatPage(page);
        await chat.goto(SESSION_ID);
        await expect(chat.scrollerViewport).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await expect(page.locator('[data-testid="virtual-top-spacer"]')).toHaveCount(1, {
            timeout: LONG_TIMEOUT_MS,
        });

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

        // —— 决定性验证：点击前后「可读集」是否真的变化 ——
        const preClick = await readSample(page);
        const preIds = await page.evaluate(() =>
            Array.from(document.querySelectorAll('[data-slot="message-scroller-item"]'))
                .map((el) => (el as HTMLElement).dataset.messageId)
                .filter(Boolean),
        );
        await loadOlderButton.click();
        await settle(page);
        await page.waitForTimeout(800);
        const postClick = await readSample(page);
        const postIds = await page.evaluate(() =>
            Array.from(document.querySelectorAll('[data-slot="message-scroller-item"]'))
                .map((el) => (el as HTMLElement).dataset.messageId)
                .filter(Boolean),
        );
        // 全表可读集（含 spacer 推断）：scrollHeight 增长量 ≈ 新增行数 × 行高
        console.log(
            "[bl382-debug] pre=" +
                JSON.stringify(preClick) +
                " post=" +
                JSON.stringify(postClick) +
                " preIds=" +
                JSON.stringify(preIds) +
                " postIds=" +
                JSON.stringify(postIds) +
                " grewPx=" +
                (postClick.scrollHeight - preClick.scrollHeight),
        );
        // 折叠被消费：更早段进入表（scrollHeight 明显增长）。
        expect(
            postClick.scrollHeight,
            `prepend 未落地：scrollHeight ${preClick.scrollHeight} → ${postClick.scrollHeight}`,
        ).toBeGreaterThan(preClick.scrollHeight + 1_000);
        await settle(page);
        await shot("after-prepend");

        const anchorOffsetAfter = await readRowOffset(page, anchorBefore ?? "");
        expect(anchorOffsetAfter, `prepend 后锚点行 ${anchorBefore} 必须仍在 DOM`).not.toBeNull();
        const anchorDelta = Math.abs((anchorOffsetAfter ?? 0) - (anchorOffsetBefore ?? 0));
        expect(
            anchorDelta,
            `prepend 保位失败：锚点行 ${anchorBefore} 偏移 ${anchorOffsetBefore}px → ${anchorOffsetAfter}px（Δ=${anchorDelta}，期望 ≤2）`,
        ).toBeLessThanOrEqual(2);

        // —— ② 贴底跟随：加载后仍贴底（末行可见、下占位 ≈0） ——
        const afterPrepend = await readSample(page);
        expect(afterPrepend.bottomSpacer, "prepend 后仍应贴底").toBeLessThan(2);
        await expect(page.getByText(`bl382-row-${TOTAL - 1}`, { exact: false }).first()).toBeVisible({
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
        const maxRendered = Math.max(...samples.map((sample) => sample.renderedRows), before.renderedRows);
        expect(maxRendered, `全展开后渲染行数=${maxRendered}（总 ${TOTAL}）`).toBeLessThan(TOTAL / 4);
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
        console.log(
            "[bl382] anchorDelta=" +
                anchorDelta +
                " maxRendered=" +
                maxRendered +
                " samples=" +
                samples.length +
                " settleJumps=" +
                (settleJumps.join(",") || "none"),
        );
    });

    test("真实 CP 分页形态：首屏 500 + 每页 50，验证「加载更早」实际行为", async ({ page }, testInfo) => {
        test.setTimeout(LONG_TIMEOUT_MS * 3);
        // 首屏 = 最近 500 条（CP 分页契约 limit=500），nextCursor 指向更早端
        // before 页 = 每页 50 条，逐页回卷
        const realisticSession = "bl382-prepend-realistic";
        const realisticAll = Array.from({ length: TOTAL }, (_, index) => ({
            id: `bl382-real-${index}`,
            sessionId: realisticSession,
            role: index % 2 === 0 ? "USER" : "ASSISTANT",
            content: `bl382-real-row-${index}`,
            createdAt: new Date(Date.now() - (TOTAL - index) * 60_000).toISOString(),
        }));
        const firstScreen = realisticAll.slice(TOTAL - RETAINED);
        await page.route(
            (url) =>
                url.hostname === "localhost" &&
                /\/api\/v1\/sessions\/bl382-prepend-realistic\/messages$/.test(url.pathname),
            async (route) => {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        messages: firstScreen,
                        nextCursor: "real-cursor-700",
                        truncated: true,
                    }),
                });
            },
        );
        await page.route(
            (url) =>
                url.hostname === "localhost" &&
                /\/api\/v1\/sessions\/bl382-prepend-realistic\/messages$/.test(url.pathname) &&
                url.searchParams.has("before"),
            async (route) => {
                const cursor = Number(url.searchParams.get("before")?.split("-").pop() ?? "700");
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
        await setupMockSessions(page, {
            sessions: [{ id: realisticSession, title: "BL-382 Realistic" }],
            messages: {
                [realisticSession]: [
                    {
                        id: "bl382-real-placeholder",
                        sessionId: realisticSession,
                        role: "USER",
                        content: "bl382-real-placeholder",
                        createdAt: new Date().toISOString(),
                    },
                ],
            },
        });
        await stubSessionProjections(page, realisticSession);
        await page.route(`**/api/v1/sessions/${realisticSession}/participants`, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    participants: [],
                    capabilities: { view: false, manage: false, mention: false, speakAs: false },
                }),
            });
        });
        const chat = new ChatPage(page);
        await chat.goto(realisticSession);
        await expect(chat.scrollerViewport).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await expect(page.locator('[data-testid="virtual-top-spacer"]')).toHaveCount(1, {
            timeout: LONG_TIMEOUT_MS,
        });
        const samples: Array<{
            click: number;
            scrollHeight: number;
            renderedRows: number;
            banner: boolean;
            firstRow: string | null;
        }> = [];
        for (let click = 0; click < 20; click += 1) {
            const button = page.locator('[data-testid="load-older-messages"]');
            if ((await button.count()) === 0) break;
            await button.click();
            await settle(page);
            await page.waitForTimeout(300);
            const sample = await page.evaluate(() => {
                const viewport = document.querySelector<HTMLElement>(
                    '[data-testid="message-scroller-viewport"]',
                );
                const first = document.querySelector<HTMLElement>('[data-slot="message-scroller-item"]');
                return {
                    scrollHeight: viewport?.scrollHeight ?? 0,
                    renderedRows: document.querySelectorAll('[data-testid="run-group-body"]').length,
                    firstRow: first?.dataset.messageId ?? null,
                };
            });
            samples.push({
                click,
                scrollHeight: sample.scrollHeight,
                renderedRows: sample.renderedRows,
                banner: (await page.getByText("更早的", { exact: false }).count()) > 0,
                firstRow: sample.firstRow,
            });
        }
        console.log("[bl382-realistic] " + JSON.stringify(samples));
        const path = EVIDENCE_DIR
            ? `${EVIDENCE_DIR}/bl382-realistic-samples.json`
            : testInfo.outputPath("bl382-realistic-samples.json");
        await import("node:fs/promises").then((fsModule) =>
            fsModule.writeFile(path, JSON.stringify(samples, null, 2)),
        );
        await page.screenshot({
            path: EVIDENCE_DIR
                ? `${EVIDENCE_DIR}/bl382-realistic-after-paging.png`
                : testInfo.outputPath("bl382-realistic-after-paging.png"),
        });
    });
    test("对照：≤500 条（不折叠）时 prepend 正常（缺陷只在折叠场景）", async ({ page }, testInfo) => {
        test.setTimeout(LONG_TIMEOUT_MS * 2);
        const smallSession = "bl382-prepend-small";
        // 400 条（<500 上限）：首屏 400 + nextCursor，before 页 100 条 ⇒ 全量 500，永不触发 trim
        const smallAll = Array.from({ length: 500 }, (_, index) => ({
            id: `bl382-small-${index}`,
            sessionId: smallSession,
            role: index % 2 === 0 ? "USER" : "ASSISTANT",
            content: `bl382-small-row-${index}`,
            createdAt: new Date(Date.now() - (500 - index) * 60_000).toISOString(),
        }));
        await setupMockSessions(page, {
            sessions: [{ id: smallSession, title: "BL-382 Small" }],
            messages: {
                [smallSession]: [
                    {
                        id: "bl382-small-placeholder",
                        sessionId: smallSession,
                        role: "USER",
                        content: "bl382-small-placeholder",
                        createdAt: new Date().toISOString(),
                    },
                ],
            },
        });
        await stubSessionProjections(page, smallSession);
        await page.route(`**/api/v1/sessions/${smallSession}/participants`, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    participants: [],
                    capabilities: { view: false, manage: false, mention: false, speakAs: false },
                }),
            });
        });
        await page.route(
            (url) =>
                url.hostname === "localhost" &&
                /\/api\/v1\/sessions\/bl382-prepend-small\/messages$/.test(url.pathname),
            async (route) => {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        messages: smallAll.slice(100),
                        nextCursor: "small-cursor",
                        truncated: true,
                    }),
                });
            },
        );
        await page.route(
            (url) =>
                url.hostname === "localhost" &&
                /\/api\/v1\/sessions\/bl382-prepend-small\/messages$/.test(url.pathname) &&
                url.searchParams.has("before"),
            async (route) => {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        messages: smallAll.slice(0, 100),
                        nextCursor: null,
                        truncated: false,
                    }),
                });
            },
        );
        const chat = new ChatPage(page);
        await chat.goto(smallSession);
        await expect(chat.scrollerViewport).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        const before = await readSample(page);
        const button = page.locator('[data-testid="load-older-messages"]');
        await expect(button).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await button.click();
        await settle(page);
        await page.waitForTimeout(800);
        const after = await readSample(page);
        console.log(
            "[bl382-small] before=" + JSON.stringify(before) + " after=" + JSON.stringify(after),
        );
        // 期望：prepend 100 条 ⇒ scrollHeight 明显增长（≥100 × 30px）且不再折叠
        expect(after.scrollHeight, "小表 prepend 应落地").toBeGreaterThan(before.scrollHeight + 2_000);
        expect(
            await page.getByText("更早的", { exact: false }).count(),
            "小表 prepend 后折叠应耗尽",
        ).toBe(0);
    });
});
