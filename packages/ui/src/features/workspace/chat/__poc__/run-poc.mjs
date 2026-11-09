#!/usr/bin/env node
/**
 * BL-382 A′ POC 驱动（task-33）。
 *
 * 干什么：起一个**只跑前端**的 vite dev server → 打开真 Chromium → 在 `PocHarness.vue` 上
 * 逐项量四项风险 → 打印 JSON + PASS/FAIL。**不碰产品代码、不进 E2E 套件、不合并**。
 *
 * 用法（在 `packages/ui` 下）：`node src/features/workspace/chat/__poc__/run-poc.mjs`
 * 可选：`--headed` 看画面；`--port 12911` 指定端口；`--keep` 跑完不关浏览器（调试用）。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
    const key = process.argv[i];
    if (!key.startsWith("--")) continue;
    const next = process.argv[i + 1];
    args.set(key.slice(2), next && !next.startsWith("--") ? next : "1");
}
const headed = args.has("headed");
const keep = args.has("keep");
const port = Number(args.get("port") ?? 12911);
const BASE = `http://127.0.0.1:${port}`;
const PAGE = `${BASE}/src/features/workspace/chat/__poc__/index.html`;

function log(...rest) {
    console.log(...rest);
}

async function waitForServer(timeoutMs = 90_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            const res = await fetch(PAGE, { signal: AbortSignal.timeout(2000) });
            if (res.ok) return Date.now() - started;
        } catch {
            /* 还没起来 */
        }
        await sleep(300);
    }
    throw new Error(`vite 未在 ${timeoutMs}ms 内就绪：${PAGE}`);
}

async function main() {
    const t0 = Date.now();
    // 直接用 node 起 vite：Windows 上 spawn(`pnpm.cmd`) 在 Node 20+ 会 EINVAL（.cmd 需要 shell），
    // 而 shell 会把端口/参数再交给 cmd 解析一遍，出错信息也更难读。
    const viteBin = new URL("../../../../../node_modules/vite/bin/vite.js", import.meta.url);
    const vite = spawn(
        process.execPath,
        [
            fileURLToPath(viteBin),
            "--mode",
            "dev",
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--strictPort",
        ],
        {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            cwd: new URL("../../../../../", import.meta.url),
        },
    );
    let viteLog = "";
    vite.stdout.on("data", (chunk) => (viteLog += chunk.toString()));
    vite.stderr.on("data", (chunk) => (viteLog += chunk.toString()));
    globalThis.__pocVitePid = vite.pid;
    const killVite = () => {
        if (vite.killed) return;
        try {
            if (process.platform === "win32") {
                spawn("taskkill", ["/pid", String(vite.pid), "/T", "/F"], { stdio: "ignore" });
            } else {
                vite.kill("SIGTERM");
            }
        } catch {
            /* 已退出 */
        }
    };
    process.on("exit", killVite);

    const bootMs = await waitForServer();
    log(`[poc] vite 就绪 ${bootMs}ms（${PAGE}）`);

    const { chromium } = await import("@playwright/test");
    let browser;
    let browserLabel = "";
    // 本机没装与 @playwright/test 版本匹配的 bundled 浏览器（装的是 1243，包要 1248），
    // 且子进程 env 里没有 PROGRAMFILES（channel 探测会拼出 undefined\Program Files\…）。
    // 按工作区规则用 **Chrome Beta**（不碰 stable），显式给 executablePath 绕开探测。
    const candidates = [
        {
            label: "chrome-beta",
            options: {
                executablePath: "C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe",
            },
        },
        { label: "chrome-beta(channel)", options: { channel: "chrome-beta" } },
        { label: "bundled", options: {} },
    ];
    for (const attempt of candidates) {
        try {
            browser = await chromium.launch({ headless: !headed, ...attempt.options });
            browserLabel = attempt.label;
            break;
        } catch (error) {
            log(`[poc] 启动 ${attempt.label} 失败：${error.message.split("\n")[0]}`);
        }
    }
    if (!browser) throw new Error("没有可用浏览器（chrome-beta / bundled 都起不来）");
    log(`[poc] 浏览器：${browserLabel}`);

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    page.on("console", (message) => {
        if (message.type() === "error") pageErrors.push(message.text());
    });

    async function open(query) {
        await page.goto(`${PAGE}?${query}`, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => Boolean(window.__poc), null, { timeout: 30_000 });
        await page.evaluate(() => window.__poc.ready);
    }

    const results = { browser: browserLabel, port, scenarios: {}, pageErrors };

    // ── 风险 ①：getScrollElement 能否挂进既有 MessageScroller ───────────────────────────
    await open("rows=500&anchor=end&follow=0&auto=0&grow=0");
    const integration = await page.evaluate(async () => {
        const poc = window.__poc;
        const before = poc.state();
        await poc.scrollToOffset(4000);
        const after = poc.state();
        await poc.scrollToOffset(0);
        const back = poc.state();
        return { before, after, back };
    });
    results.scenarios.risk1 = integration;

    // ── 风险 ②：动态高度测量稳定 ────────────────────────────────────────────────────
    await open("rows=200&anchor=end&follow=0&auto=0&grow=1");
    const measurement = await page.evaluate(async () => {
        const poc = window.__poc;
        // ① 预热：先让前若干行走完 estimate → measured，否则第一轮一定"不稳"（首版就是这个假不稳）。
        for (const offset of [600, 1400, 2200, 0]) {
            await poc.scrollToOffset(offset);
            await poc.frames(3);
        }
        // ② 动态高度：把图片行滚进窗口后让它们 60→240，看库自己算的总高是否跟着涨。
        await poc.scrollToOffset(2200);
        await poc.frames(3);
        const beforeGrow = poc.state().totalSize;
        await poc.growNow();
        const afterGrow = poc.state().totalSize;
        // ③ 再预热一次（新一轮估算→实测），然后量 5 轮稳定性。
        for (const offset of [600, 1400, 2200, 0]) {
            await poc.scrollToOffset(offset);
            await poc.frames(3);
        }
        const rounds = [];
        for (let round = 0; round < 5; round += 1) {
            await poc.scrollToOffset(2000);
            await poc.frames(3);
            const state = poc.state();
            const firstItems = poc
                .virtualItems()
                .slice(0, 3)
                .map((item) => ({ index: item.index, start: item.start }));
            await poc.scrollToOffset(0);
            await poc.frames(3);
            rounds.push({
                round,
                totalSize: state.totalSize,
                firstIndex: state.renderedIndexes[0],
                firstItems,
            });
        }
        return {
            growth: { beforeGrow, afterGrow },
            rounds,
            longTasks: poc.longTasks().length,
            finalDebug: poc.debug(),
        };
    });
    results.scenarios.risk2 = measurement;

    // ── 风险 ③：anchorTo:'end' 下 prepend 保位（目标 ≤2px）────────────────────────────
    async function prependRound(query, rounds) {
        await open(query);
        return page.evaluate(async (roundCount) => {
            const poc = window.__poc;
            await poc.scrollToIndex(250);
            await poc.frames(3);
            const targetId = "m-250";
            const out = [];
            for (let round = 0; round < roundCount; round += 1) {
                const topBefore = poc.targetTop(targetId);
                // 视口偏移 = 库坐标(itemOffset) - scrollTop：目标行若滚出渲染窗口，DOM 量不到，
                // 但库坐标仍可算 —— 对照组（anchor=start）恰恰就是这种情况。
                const offsetBefore = poc.itemOffsetOfId(targetId);
                const stateBefore = poc.state();
                const viewportOffsetBefore =
                    offsetBefore === null
                        ? null
                        : Math.round((offsetBefore - stateBefore.scrollTop) * 100) / 100;
                const prependStats = await poc.prepend(30);
                await poc.frames(3);
                const topAfter = poc.targetTop(targetId);
                const offsetAfter = poc.itemOffsetOfId(targetId);
                const stateAfter = poc.state();
                const viewportOffsetAfter =
                    offsetAfter === null
                        ? null
                        : Math.round((offsetAfter - stateAfter.scrollTop) * 100) / 100;
                out.push({
                    round,
                    topBefore: topBefore === null ? null : Math.round(topBefore * 100) / 100,
                    topAfter: topAfter === null ? null : Math.round(topAfter * 100) / 100,
                    deltaPx:
                        topBefore === null || topAfter === null
                            ? null
                            : Math.round((topAfter - topBefore) * 100) / 100,
                    viewportOffsetDelta:
                        viewportOffsetBefore === null || viewportOffsetAfter === null
                            ? null
                            : Math.round((viewportOffsetAfter - viewportOffsetBefore) * 100) / 100,
                    // 对照组量不到的（目标行根本没被测量）时，用这两个增量说话：
                    // 保位成立 ⇒ scrollTop 增量 ≈ scrollHeight 增量；不保位 ⇒ scrollTop 不动而内容长高。
                    scrollHeightDelta: stateAfter.scrollHeight - stateBefore.scrollHeight,
                    scrollTopDelta: stateAfter.scrollTop - stateBefore.scrollTop,
                    firstRenderedRowIdBefore: stateBefore.firstRenderedRowId,
                    firstRenderedRowIdAfter: stateAfter.firstRenderedRowId,
                    distanceToEndBefore: stateBefore.distanceToEnd,
                    distanceToEndAfter: stateAfter.distanceToEnd,
                    hook: stateBefore.scrollElementIsViewport,
                    prependStats,
                });
            }
            return { rounds: out, finalState: poc.state() };
        }, rounds);
    }
    results.scenarios.risk3 = await prependRound("rows=500&anchor=end&follow=0&auto=0&grow=0", 3);
    results.scenarios.risk3Control = await prependRound(
        "rows=500&anchor=start&follow=0&auto=0&grow=0",
        1,
    );

    // ── 风险 ④：followOnAppend 贴底（流式追加不抖）────────────────────────────────────
    await open("rows=500&anchor=end&follow=1&auto=0&grow=0");
    results.scenarios.risk4 = await page.evaluate(async () => {
        const poc = window.__poc;
        await poc.scrollToBottom();
        await poc.frames(3);
        const atEnd = poc.state();
        const atEndDebug = poc.debug();
        const stream = await poc.appendStream(10);
        return { atEnd, atEndDebug, stream, afterDebug: poc.debug() };
    });

    // ④b：用户已上翻时不得被拽底
    await open("rows=500&anchor=end&follow=1&auto=0&grow=0");
    results.scenarios.risk4ScrolledUp = await page.evaluate(async () => {
        const poc = window.__poc;
        await poc.scrollToBottom();
        await poc.frames(2);
        const bottom = poc.state();
        await poc.scrollToOffset(Math.max(0, bottom.scrollTop - 800));
        await poc.frames(2);
        const before = poc.state();
        await poc.appendStream(3);
        const after = poc.state();
        return { before, after, scrollTopDelta: after.scrollTop - before.scrollTop };
    });

    // ④c：provider 自身 auto-scroll 打开时的冲突检查
    await open("rows=500&anchor=end&follow=1&auto=1&grow=0");
    results.scenarios.risk4WithProviderAutoScroll = await page.evaluate(async () => {
        const poc = window.__poc;
        await poc.scrollToBottom();
        await poc.frames(3);
        const atEnd = poc.state();
        const stream = await poc.appendStream(5);
        return { atEnd, stream };
    });

    results.pageErrors = pageErrors;
    results.longTasks = await page.evaluate(() => window.__poc.longTasks());
    results.totalMs = Date.now() - t0;

    if (!keep) {
        await context.close();
        await browser.close();
        killVite();
    }

    // ── 判据 ───────────────────────────────────────────────────────────────────
    const r1 = results.scenarios.risk1;
    const risk1Pass =
        r1.before.scrollElementIsViewport === true &&
        r1.before.viewportCount === 1 &&
        r1.before.scrollElementSlot === "message-scroller-viewport" &&
        JSON.stringify(r1.before.renderedIndexes) !== JSON.stringify(r1.after.renderedIndexes) &&
        r1.after.scrollTop > 3000;

    const r2 = results.scenarios.risk2;
    const sizes = r2.rounds.map((round) => round.totalSize);
    const firstIndexes = r2.rounds.map((round) => round.firstIndex);
    const firstStarts = r2.rounds.map((round) =>
        round.firstItems.map((item) => item.start).join(","),
    );
    const stableRounds = r2.rounds.filter(
        (round, index) =>
            round.totalSize === sizes[0] &&
            round.firstIndex === firstIndexes[0] &&
            firstStarts[index] === firstStarts[0],
    ).length;
    const risk2Pass =
        sizes.every((size) => size === sizes[0]) &&
        firstIndexes.every((index) => index === firstIndexes[0]) &&
        firstStarts.every((start) => start === firstStarts[0]) &&
        r2.growth.afterGrow > r2.growth.beforeGrow;

    const deltas = results.scenarios.risk3.rounds.map(
        (round) => round.viewportOffsetDelta ?? round.deltaPx,
    );
    const domDeltas = results.scenarios.risk3.rounds.map((round) => round.deltaPx);
    const maxAbsDelta = Math.max(
        ...domDeltas.map((delta) => (delta === null ? Infinity : Math.abs(delta))),
    );
    const maxAbsViewportDelta = Math.max(
        ...deltas.map((delta) => (delta === null ? Infinity : Math.abs(delta))),
    );
    const risk3Pass = maxAbsDelta <= 2 && maxAbsViewportDelta <= 2;

    const streamDistances = results.scenarios.risk4.stream.map(
        (snap) => snap.libraryDistanceFromEnd,
    );
    const domDistances = results.scenarios.risk4.stream.map((snap) => snap.distanceToEnd);
    const maxDistance = Math.max(...streamDistances.map((value) => Math.abs(value)));
    const risk4Pass = results.scenarios.risk4.atEndDebug.isAtEnd === true && maxDistance <= 2;
    const risk4ScrolledUpPass = Math.abs(results.scenarios.risk4ScrolledUp.scrollTopDelta) <= 1;
    const autoStream = results.scenarios.risk4WithProviderAutoScroll.stream.map((snap) =>
        Math.abs(snap.distanceToEnd),
    );
    const risk4AutoPass = Math.max(...autoStream) <= 2;

    const controlDelta = results.scenarios.risk3Control.rounds[0].deltaPx;

    const summary = {
        risk1_getScrollElement: {
            pass: risk1Pass,
            scrollElementIsViewport: r1.before.scrollElementIsViewport,
            scrollElementSlot: r1.before.scrollElementSlot,
            viewportCountInDocument: r1.before.viewportCount,
            renderedBefore: r1.before.renderedIndexes.slice(0, 3),
            renderedAfter4000: r1.after.renderedIndexes.slice(0, 3),
            scrollTopAfterSet: r1.after.scrollTop,
        },
        risk2_dynamicMeasurement: {
            pass: risk2Pass,
            growth: r2.growth,
            stableRounds,
            totalSizeValues: sizes,
            firstIndexes,
            rounds: r2.rounds,
        },
        risk3_prependAnchor: {
            pass: risk3Pass,
            domDeltasPx: domDeltas,
            viewportOffsetDeltasPx: deltas,
            maxAbsDomDeltaPx: maxAbsDelta,
            maxAbsViewportDeltaPx: maxAbsViewportDelta,
            controlAnchorStartViewportDeltaPx: controlDelta,
            controlAnchorStart: results.scenarios.risk3Control.rounds.map((round) => ({
                scrollHeightDelta: round.scrollHeightDelta,
                scrollTopDelta: round.scrollTopDelta,
                contentShiftPx: round.scrollHeightDelta - round.scrollTopDelta,
                firstRenderedRowIdBefore: round.firstRenderedRowIdBefore,
                firstRenderedRowIdAfter: round.firstRenderedRowIdAfter,
            })),
            rounds: results.scenarios.risk3.rounds,
        },
        risk4_followOnAppend: {
            pass: risk4Pass,
            atEndBeforeAppend: results.scenarios.risk4.atEndDebug,
            libraryDistanceFromEndSeries: streamDistances,
            domDistanceToEndSeries: domDistances,
            maxAbsDistanceToEnd: maxDistance,
            scrolledUpYankPx: results.scenarios.risk4ScrolledUp.scrollTopDelta,
            scrolledUpPass: risk4ScrolledUpPass,
            providerAutoScrollDistanceSeries: autoStream,
            providerAutoScrollPass: risk4AutoPass,
        },
        pageErrors: results.pageErrors.slice(0, 10),
        longTasks: {
            count: results.longTasks.length,
            maxMs: Math.max(0, ...results.longTasks.map((task) => task.duration)),
        },
        timings: { bootMs, totalMs: results.totalMs },
    };

    log("\n===== BL-382 A′ POC 结果 =====");
    log(JSON.stringify(summary, null, 2));
    log("\n===== 原始数据（含每轮 prepend/append 明细）=====");
    log(JSON.stringify(results.scenarios, null, 2));
    log(
        `\nPASS 汇总：① ${risk1Pass ? "通" : "不通"} · ② ${risk2Pass ? "通" : "不通"} · ③ ${risk3Pass ? "通" : "不通"}（max |Δ| = ${maxAbsDelta}px，对照 anchor=start Δ = ${controlDelta}px）· ④ ${risk4Pass ? "通" : "不通"}（max distToEnd = ${maxDistance}px；上翻不被拽 = ${risk4ScrolledUpPass ? "通" : "不通"}；provider auto-scroll 并存 = ${risk4AutoPass ? "通" : "不通"}）`,
    );
    log(`耗时：vite 就绪 ${bootMs}ms + 场景 ${results.totalMs - bootMs}ms = ${results.totalMs}ms`);

    process.exitCode = risk1Pass && risk2Pass && risk3Pass && risk4Pass ? 0 : 2;
}

main().catch((error) => {
    console.error("[poc] 失败：", error);
    process.exitCode = 1;
    // 失败路径也必须杀干净：vite 子进程会拖住事件循环，脚本会挂到超时（实测 300s）。
    try {
        if (process.platform === "win32" && globalThis.__pocVitePid) {
            spawn("taskkill", ["/pid", String(globalThis.__pocVitePid), "/T", "/F"], {
                stdio: "ignore",
            });
        }
    } catch {
        /* 已经退出 */
    }
});
