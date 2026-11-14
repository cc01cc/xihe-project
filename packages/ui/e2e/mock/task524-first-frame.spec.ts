/**
 * task-524：workbench **首帧闪窄** —— 错误布局可见时长判据（mock lane，L0 单 spec）。
 *
 * 现象（task-497 复采时发现）：刷新后有一段窗口里树宽停在最小宽 200，随后跳到持久值。
 * 根因方向：dockview 的布局模型在首帧还没追上真实宿主宽度（宿主有 `transition-[flex-grow]
 * duration-300`，实测宿主从 6px 长到 1436px）⇒ 应用侧 setSize 是在**错的总宽**上分配余量。
 *
 * 判据（Lead 2026-11-14 裁定，**不许用「等一会儿再截屏」造假绿**）：
 *   · 修前红：错误布局可见时长 ≥ 300ms（三条采样序列）
 *   · 修后绿：错误布局可见时长 < 150ms
 *   量化口径 = 树面板出现 → 树宽等于持久值之间的时长，采样在页面内做（16ms 一拍），
 *   不依赖外部 poll 的节拍。同时记录「三栏都等于稳态值」的时长作为交叉证据。
 */
import { expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";
import { WORKSPACE_LAYOUT_STORAGE_PREFIX } from "../../src/composables/useWorkspaceLayout";

const WORKSPACE_PATH = "/workspace/workspace-1";
const LAYOUT_KEY = `${WORKSPACE_LAYOUT_STORAGE_PREFIX}workspace-1`;
const TARGET_TREE_WIDTH = 288;
/** 判据阈值（Lead 裁定）：修后错误布局可见 < 150ms。 */
const MAX_WRONG_MS = 150;

interface Reading {
    totalMs: number;
    wrongMs: number;
    wrongFrames: number;
    tripleWrongMs: number;
    series: string[];
    final: { tree: number; main: number; dock: number; host: number };
}

async function measureFirstFrame(page: Page, target: number): Promise<Reading> {
    return page.evaluate(async (targetWidth: number) => {
        const rect = (sel: string): number => {
            const el = document.querySelector(sel);
            return el ? Math.round(el.getBoundingClientRect().width) : -1;
        };
        const groupWidth = (panel: string): number => {
            const el = document
                .querySelector(`[data-dockview-panel="${panel}"]`)
                ?.closest(".dv-groupview");
            return el ? Math.round(el.getBoundingClientRect().width) : -1;
        };
        const sample = () => ({
            tree: groupWidth("tree"),
            main: groupWidth("main"),
            dock: groupWidth("monitor"),
            host: rect(".dockview-host"),
        });

        const started = performance.now();
        const series: string[] = [];
        let firstSeenAt: number | null = null;
        let steadyAt: number | null = null;
        let wrongFrames = 0;
        let wrongMs = 0;
        let lastAt = 0;
        let stable = 0;
        const snaps: { at: number; s: ReturnType<typeof sample> }[] = [];

        while (performance.now() - started < 5000) {
            const s = sample();
            const now = performance.now();
            snaps.push({ at: now, s });
            series.push(`${Math.round(now - started)}:${s.tree}:${s.main}:${s.dock}:${s.host}`);
            if (s.tree > 0 && firstSeenAt === null) firstSeenAt = now;
            if (firstSeenAt !== null) {
                const wrong = Math.abs(s.tree - targetWidth) > 2;
                if (wrong) {
                    wrongFrames += 1;
                    wrongMs += now - Math.max(lastAt, firstSeenAt);
                }
                stable = wrong ? 0 : stable + 1;
                if (stable >= 3 && steadyAt === null) {
                    steadyAt = now;
                    break;
                }
            }
            lastAt = now;
            await new Promise((r) => setTimeout(r, 16));
        }

        const final = snaps[snaps.length - 1].s;
        // 交叉证据：三栏同时等于稳态值才算「布局正确」。
        let tripleWrongMs = 0;
        for (const snap of snaps) {
            if (snap.at < (firstSeenAt ?? started)) continue;
            const same =
                Math.abs(snap.s.tree - final.tree) <= 2 &&
                Math.abs(snap.s.main - final.main) <= 2 &&
                Math.abs(snap.s.dock - final.dock) <= 2;
            if (!same) tripleWrongMs += 16;
        }

        return {
            totalMs: Math.round((steadyAt ?? performance.now()) - (firstSeenAt ?? started)),
            wrongMs: Math.round(wrongMs),
            wrongFrames,
            tripleWrongMs,
            series,
            final,
        };
    }, target);
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        (globalThis as { __xhUseDockview?: boolean }).__xhUseDockview = true;
    });
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [{ id: "session-1", title: "Session 1" }] });
    await page.setViewportSize({ width: 1920, height: 1080 });
    // 种一个非默认树宽：默认 240 与首帧 200 只差 40px，量不出「闪窄」的完整形态。
    await page.addInitScript(
        ([key, width]) => {
            localStorage.setItem(key, JSON.stringify({ treeCollapsed: false, treeWidth: width }));
        },
        [LAYOUT_KEY, TARGET_TREE_WIDTH] as const,
    );
});

test("首帧闪窄：错误布局可见时长 < 150ms（修前 ≥ 300ms 为红）", async ({ page }) => {
    const readings: Reading[] = [];
    for (let round = 0; round < 3; round += 1) {
        if (round === 0) await page.goto(WORKSPACE_PATH);
        else await page.reload();
        await page.waitForSelector('[data-dockview-panel="tree"]', {
            state: "attached",
            timeout: EXPECT_TIMEOUT_MS,
        });
        // 等这一轮彻底稳态，避免把上一轮的动画余波算进下一轮。
        await page.waitForFunction(
            (targetWidth) => {
                const el = document
                    .querySelector('[data-dockview-panel="tree"]')
                    ?.closest(".dv-groupview");
                const w = el ? Math.round(el.getBoundingClientRect().width) : -1;
                const box = globalThis as { __xh524Stable?: { at: number; w: number } };
                const now = performance.now();
                if (!box.__xh524Stable || box.__xh524Stable.w !== w) {
                    box.__xh524Stable = { at: now, w };
                    return false;
                }
                return w === targetWidth && now - box.__xh524Stable.at >= 300;
            },
            TARGET_TREE_WIDTH,
            { timeout: EXPECT_TIMEOUT_MS, polling: 50 },
        );
        await page.reload();
        readings.push(await measureFirstFrame(page, TARGET_TREE_WIDTH));
    }
    console.log(
        "PROBE524 " +
            JSON.stringify(
                readings.map((r) => ({
                    ...r,
                    series: r.series.slice(0, 24),
                    seriesLen: r.series.length,
                })),
            ),
    );

    const wrongFrames = readings.map((r) => r.wrongFrames);
    expect(
        Math.min(...wrongFrames),
        "三轮都应观测到错误布局（否则判据没有被测对象）",
    ).toBeGreaterThan(0);
    const reported = readings.map((r) => r.wrongMs);
    console.log("PROBE524MS " + JSON.stringify(reported));
    expect(
        Math.max(...reported),
        `三轮错误布局可见时长 = ${reported.join(" / ")}ms（判据 < ${MAX_WRONG_MS}ms）`,
    ).toBeLessThan(MAX_WRONG_MS);
});
