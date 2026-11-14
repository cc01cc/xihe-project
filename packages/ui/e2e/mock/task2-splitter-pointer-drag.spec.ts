/**
 * task-2（原 task-613）：**默认路径内层 SplitterGroup 指针拖拽**的回归判据（mock lane，L0 单 spec）。
 *
 * 修的是「指针拖拽静默失效、键盘却通」：`WorkspaceWorkbench.vue` 的 `setTreePanel` 挂在
 * `<SplitterPanel :ref>` 上，而 Vue 的函数 ref 在**该 vnode 每次 patch 时都会被回调**
 * （`@vue/runtime-core` 的 `patch()` → `setRef()`，函数 ref 无条件回调）；reka 的 SplitterGroup
 * 每写一次 layout 就重渲染（`SplitterGroup.js:517` 的 renderSlot 传 `{ layout }`）⇒ 拖拽每帧都跑一次
 * 首帧 bootstrap ⇒ 每帧 `resize(存储宽)` 把 reka 刚应用的增量撤销（实测拖拽帧 `prev=[17.28,82.72]`
 * 被写回 `[20.73,79.27]`）。修法：bootstrap 收成「每实例一次」+ 补一条显式的 store→面板通道
 * （`useSplitterPanelWidthSync`）。
 *
 * 判据里有两类是**故意**选成「如果修回旧形态就必红」的：
 *   · ③ 拖拽期 style 写入次数 = 拖拽点数（旧形态是 2×：reka 一次 + bootstrap 回写一次）；
 *   · ⑦ 组宽变化后仍是存储 px（旧形态靠每帧回写碰巧成立；通道删掉就会跟着组宽缩水）。
 *
 * 跑法：`$env:XIHE_UI_PORT='12788'; pnpm exec playwright test --config e2e/playwright.config.ts
 * e2e/mock/task2-splitter-pointer-drag.spec.ts`
 */
import { expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";
import {
    TREE_COLLAPSED_WIDTH,
    TREE_WIDTH_DEFAULT,
    WORKSPACE_LAYOUT_STORAGE_PREFIX,
} from "../../src/composables/useWorkspaceLayout";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_PATH = `/workspace/${WORKSPACE_ID}`;
const LAYOUT_KEY = `${WORKSPACE_LAYOUT_STORAGE_PREFIX}${WORKSPACE_ID}`;
const GLOBAL_LAYOUT_KEY = "xihe-layout-global";

interface Reading {
    /** rail 的真实几何宽度（小数，别取整：取整会把 0.5px 的差别抹掉）。 */
    rail: number;
    /** inline flex-grow（reka 按百分比写）。 */
    flexGrow: string | null;
    stored: number | null;
}

async function read(page: Page, storageKey = LAYOUT_KEY): Promise<Reading> {
    return page.evaluate((key) => {
        const rail = document.querySelector('[data-testid="workspace-file-rail"]');
        const panel = rail?.closest("[data-panel]") as HTMLElement | null;
        let stored: number | null = null;
        try {
            const parsed = JSON.parse(localStorage.getItem(key) ?? "{}") as { treeWidth?: unknown };
            if (typeof parsed.treeWidth === "number") stored = parsed.treeWidth;
        } catch {
            /* 忽略解析失败：判据会以 null 报出来 */
        }
        return {
            rail: rail ? rail.getBoundingClientRect().width : -1,
            flexGrow: panel?.style.flexGrow ?? null,
            stored,
        };
    }, storageKey);
}

/** 一帧渲染（两个 rAF：布局+绘制都落定），不是 sleep 占位。 */
async function frame(page: Page): Promise<void> {
    await page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
    );
}

async function openWorkbench(page: Page, width = 1920): Promise<void> {
    await page.setViewportSize({ width, height: 1080 });
    await page.goto(WORKSPACE_PATH);
    await page.waitForSelector('[data-testid="workspace-workbench"]', {
        state: "attached",
        timeout: EXPECT_TIMEOUT_MS,
    });
    await page.waitForSelector('[data-testid="workspace-file-rail"]', {
        state: "attached",
        timeout: EXPECT_TIMEOUT_MS,
    });
    await frame(page);
}

/** 等几何与 store 都稳定（连续两次一致），不裸读中间帧。 */
async function settle(page: Page, storageKey = LAYOUT_KEY): Promise<Reading> {
    // 稳定窗口 350ms：宿主链有 `transition-[flex-grow] duration-300`，两帧相同不足以排除过渡中间态
    // （task-497 的 waitForStableGeometry 是同一口径，这里不另造一套）。
    let previous = await read(page, storageKey);
    let stableSince = Date.now();
    for (let i = 0; i < 120; i += 1) {
        await frame(page);
        const current = await read(page, storageKey);
        const same =
            Math.abs(current.rail - previous.rail) < 0.01 && current.flexGrow === previous.flexGrow;
        if (!same) stableSince = Date.now();
        else if (Date.now() - stableSince >= 350) return current;
        previous = current;
    }
    throw new Error(`几何未稳定：${JSON.stringify(previous)}`);
}

/** 等去抖写盘（`useWorkspaceLayout` 的 writer 是 250ms 合并）。 */
async function waitForStored(
    page: Page,
    expected: number | null,
    storageKey = LAYOUT_KEY,
): Promise<number> {
    for (let i = 0; i < 80; i += 1) {
        const current = await read(page, storageKey);
        if (current.stored !== null && (expected === null || current.stored === expected)) {
            return current.stored;
        }
        await page.waitForTimeout(50);
    }
    const last = await read(page, storageKey);
    throw new Error(`去抖后仍未写盘：期望 ${expected ?? "(非空)"}，实际 ${JSON.stringify(last)}`);
}

/** 在树面板上装 style 写入探针（数次数，不看最终值）。 */
async function installStyleProbe(page: Page, target: "tree" | "nav"): Promise<void> {
    await page.evaluate((which) => {
        const box = globalThis as unknown as {
            __xhStyleWrites: string[];
            __xhStyleObs?: MutationObserver;
        };
        const rail =
            which === "tree"
                ? document.querySelector('[data-testid="workspace-file-rail"]')
                : document.querySelector('[data-sidebar="sidebar"]');
        const panel = rail?.closest("[data-panel]") as HTMLElement | null;
        if (!panel) throw new Error(`style 探针找不到 panel（${which}）`);
        box.__xhStyleObs?.disconnect();
        box.__xhStyleWrites = [];
        const obs = new MutationObserver((records) => {
            for (let i = 0; i < records.length; i += 1) {
                box.__xhStyleWrites.push(panel.style.flexGrow);
            }
        });
        obs.observe(panel, { attributes: true, attributeFilter: ["style"] });
        box.__xhStyleObs = obs;
    }, target);
}

async function styleWriteCount(page: Page): Promise<number> {
    return page.evaluate(
        () =>
            (globalThis as unknown as { __xhStyleWrites?: string[] }).__xhStyleWrites?.length ?? -1,
    );
}

async function dragHandle(page: Page, testid: string, deltas: number[]): Promise<void> {
    const handle = page.locator(`[data-testid="${testid}"]`);
    const box = await handle.boundingBox();
    if (!box) throw new Error(`${testid} 没有 boundingBox`);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await frame(page);
    await page.mouse.down();
    await frame(page);
    for (const dx of deltas) {
        await page.mouse.move(cx + dx, cy, { steps: 1 });
        await frame(page);
    }
    await page.mouse.up();
    await frame(page);
}

/** nav 面板宽（几何，取外层 group 的第一块 panel）。 */
async function navPanelWidth(page: Page): Promise<number> {
    return page.evaluate(() => {
        const sashes = [...document.querySelectorAll("[data-panel-group]")];
        const group = sashes.find((el) => el.querySelector('[data-testid="sidebar-resizer"]'));
        if (!group) return -1;
        const panel = [...group.children].find((el) => el.hasAttribute("data-panel"));
        return panel ? panel.getBoundingClientRect().width : -1;
    });
}

test.beforeEach(async ({ page }) => {
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [{ id: "session-1", title: "Session 1" }] });
});

test("① 指针拖拽 5 点：rail 240 → ≠240，且每点恰 1 次 style 写入", async ({ page }) => {
    await openWorkbench(page);
    const before = await settle(page);
    expect(before.rail, "起点应是默认树宽").toBeCloseTo(TREE_WIDTH_DEFAULT, 0);

    await installStyleProbe(page, "tree");
    const handle = page.locator('[data-testid="tree-resizer"]');
    await handle.waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS });
    const box = await handle.boundingBox();
    if (!box) throw new Error("tree-resizer 没有 boundingBox");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await frame(page);
    await page.mouse.down();
    await frame(page);
    await installStyleProbe(page, "tree");

    const samples: Reading[] = [];
    for (const dx of [-8, -16, -24, -32, -40]) {
        await page.mouse.move(cx + dx, cy, { steps: 1 });
        await frame(page);
        samples.push(await read(page));
    }
    const writesDuringDrag = await styleWriteCount(page);
    await page.mouse.up();
    await frame(page);

    console.log(
        "[task2] drag-samples",
        JSON.stringify(samples.map((s) => ({ rail: +s.rail.toFixed(2), flexGrow: s.flexGrow }))),
        "styleWrites=",
        writesDuringDrag,
    );

    // ①-a 每点都变，且单调递减（方向：向左拖 ⇒ 变窄）
    for (const sample of samples) {
        expect(sample.rail, "拖拽中 rail 不得停在 240").toBeLessThan(before.rail - 1);
    }
    for (let i = 1; i < samples.length; i += 1) {
        expect(samples[i]!.rail, "rail 应随拖拽单调递减").toBeLessThan(samples[i - 1]!.rail);
        expect(Number(samples[i]!.flexGrow), "flexGrow 应随拖拽单调递减").toBeLessThan(
            Number(samples[i - 1]!.flexGrow),
        );
    }

    // ①-b 拖拽期 style 写入次数 = 拖拽点数。
    //     旧形态（每次 patch 都 bootstrap）= reka 一次 + 回写一次 = 2× ⇒ 这条必然红。
    expect(writesDuringDrag, "拖拽期每点只该有 1 次 layout 写入（回写会变成 2×）").toBe(
        samples.length,
    );

    // ①-c 落盘 + 与几何一致
    const after = await settle(page);
    const storedAfter = await waitForStored(page, after.stored);
    console.log("[task2] after-release", JSON.stringify({ ...after, stored: storedAfter }));
    expect(after.rail).toBeLessThan(before.rail - 30);
});

test("② reload 后宽度保持（与落盘值同值，±0.6px 渲染容差）", async ({ page }) => {
    await openWorkbench(page);
    await settle(page);
    await dragHandle(page, "tree-resizer", [-8, -16, -24, -32, -40]);
    const afterDrag = await settle(page);
    const stored = await waitForStored(page, afterDrag.stored);
    console.log("[task2] stored", stored, "rail", afterDrag.rail);

    await page.reload();
    await page.waitForSelector('[data-testid="workspace-file-rail"]', {
        state: "attached",
        timeout: EXPECT_TIMEOUT_MS,
    });
    const afterReload = await settle(page);
    console.log("[task2] after-reload", JSON.stringify(afterReload));
    expect(
        Math.abs(afterReload.rail - afterDrag.rail),
        `reload 后 rail(${afterReload.rail}) 应与 reload 前(${afterDrag.rail}) 一致`,
    ).toBeLessThanOrEqual(0.25);
    // 「保持」的判据 = **reload 前后的渲染宽一致**（真栈同形读数：拖后 239 → reload 239）。
    // 此处曾有「RO 内容框 vs flex 内容框差 ~0.5%、隐含基数 1155.3/1161.5」的归因，**已由 task-28
    // 证伪**（组元素上 contentRect / contentBoxSize / borderBoxSize / getBoundingClientRect 四量
    // 逐值相等，差值 0.0000）⇒ 判据式与五档读数见 `DEV-011 §6.2`，本文件不写第二版。
});

test("③ 键盘路径不回退：ArrowLeft×3 ⇒ 240 → 201（方向不反）", async ({ page }) => {
    await openWorkbench(page);
    const before = await settle(page);
    const handle = page.locator('[data-testid="tree-resizer"]');
    await handle.focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    const after = await settle(page);
    console.log("[task2] keyboard", JSON.stringify({ before: before.rail, after: after.rail }));
    // 240 − 3×16 = 192，但 min 200 ⇒ 夹到 200（mock lane 的组宽 1162 ⇒ 渲染 ~201）
    expect(after.rail, "键盘三次左移应夹到 min 200 附近").toBeLessThan(before.rail - 30);
    expect(after.rail, "不应被最小宽以下的错误值污染").toBeGreaterThan(195);
    const stored = await waitForStored(page, after.stored);
    expect(stored, "键盘路径仍要写键").toBe(200);
});

test("④ 外层 nav 手柄仍有效（指针拖拽改 nav 面板宽 + 写全局键）", async ({ page }) => {
    await openWorkbench(page);
    await settle(page);
    const before = await navPanelWidth(page);
    expect(before, "nav 面板应存在").toBeGreaterThan(100);
    await dragHandle(page, "sidebar-resizer", [8, 16, 24, 31]);
    const after = await navPanelWidth(page);
    const storedNav = await page.evaluate((key) => {
        try {
            const parsed = JSON.parse(localStorage.getItem(key) ?? "{}") as { navWidth?: unknown };
            return typeof parsed.navWidth === "number" ? parsed.navWidth : null;
        } catch {
            return null;
        }
    }, GLOBAL_LAYOUT_KEY);
    console.log("[task2] nav", JSON.stringify({ before, after, storedNav }));
    expect(after, "nav 拖动应让面板变宽").toBeGreaterThan(before + 20);
});

test("⑤ 首帧 bootstrap 仍工作：落盘宽 280（≠默认 240）⇒ 挂载即 280", async ({ page }) => {
    await page.addInitScript(
        ([key, width]) => {
            localStorage.setItem(key, JSON.stringify({ treeCollapsed: false, treeWidth: width }));
        },
        [LAYOUT_KEY, 280] as const,
    );
    await openWorkbench(page);
    const settled = await settle(page);
    console.log("[task2] mount-with-stored-280", JSON.stringify(settled));
    expect(settled.stored, "store 应是种进去的 280").toBe(280);
    expect(
        Math.abs(settled.rail - 280),
        `挂载即存储宽 280（不是默认 240）；实际 ${settled.rail}（容差口径见 DEV-011 §6.2）`,
    ).toBeLessThanOrEqual(2.5);
    expect(settled.rail, "不得退回默认 240").toBeGreaterThan(260);
});

test("⑥ task-551 语义保留：窄视口首帧即折叠成 40px rail", async ({ page }) => {
    await openWorkbench(page, 1180);
    // 折叠是**渲染**状态（走 collapse()），落到 40px 有一段过渡 ⇒ 轮询到 40，不裸读首帧
    let rail = -1;
    for (let i = 0; i < 80; i += 1) {
        rail = await page.evaluate(() => {
            const el = document.querySelector('[data-testid="workspace-file-rail"]');
            return el ? el.getBoundingClientRect().width : -1;
        });
        if (Math.abs(rail - TREE_COLLAPSED_WIDTH) <= 1) break;
        await page.waitForTimeout(50);
    }
    const handleCount = await page.locator('[data-testid="tree-resizer"]').count();
    const facts = await page.evaluate(() => {
        const panel = document
            .querySelector('[data-testid="workspace-file-rail"]')
            ?.closest("[data-panel]") as HTMLElement | null;
        return {
            dataState: panel?.getAttribute("data-state") ?? null,
            dataSize: panel?.getAttribute("data-panel-size") ?? null,
            collapsible: panel?.getAttribute("data-panel-collapsible") ?? null,
            expandBtn: document.querySelectorAll('[data-testid="workspace-tree-expand"]').length,
            tree: document.querySelectorAll('[data-testid="workspace-file-tree"]').length,
        };
    });
    console.log("[task2] narrow-first-frame", JSON.stringify({ rail, handleCount, facts }));
    // rail 容差 ±2：折叠档是**另一个口径**（同一绝对误差在 40px 上放大，实测 40.98 vs 40），
    // 上界 2.5% 见 `DEV-011 §6.2`。
    // 这条判据的判别力在「reka 自己也认为折叠了」（data-state=collapsed）+ 手柄消失，
    // 不是小数第几位 —— 挂载首帧没折叠时实测是 expanded / 220px（task-2 回归读数）。
    expect(
        Math.abs(rail - TREE_COLLAPSED_WIDTH),
        `首帧 rail=${rail} 应落在 40±2`,
    ).toBeLessThanOrEqual(2);
    expect(facts.dataState, "reka 侧也必须是 collapsed（渲染态与库态不许分叉）").toBe("collapsed");
    expect(handleCount, "折叠态没有可拖的手柄").toBe(0);
});

test("⑦ 组宽变化后仍是存储 px（新通道非装饰：删掉它会跟着组宽缩水）", async ({ page }) => {
    await openWorkbench(page, 1920);
    const wide = await settle(page);
    expect(wide.rail).toBeCloseTo(TREE_WIDTH_DEFAULT, 0);

    // 视口变窄 ⇒ 中栏容器变窄。存储语义是 px ⇒ 树应保持 ~240，而不是按 % 缩水。
    await page.setViewportSize({ width: 1600, height: 1080 });
    const narrow = await settle(page);
    console.log("[task2] group-resize", JSON.stringify({ wide: wide.rail, narrow: narrow.rail }));
    expect(
        narrow.rail,
        `组宽变小后树仍应是存储 px（240 附近）；按 % 缩水会掉到 ~200 以下`,
    ).toBeGreaterThan(TREE_WIDTH_DEFAULT - 8);
    expect(narrow.rail).toBeLessThan(TREE_WIDTH_DEFAULT + 8);
});

test("⑧ release 取整：落盘为整数，且面板同步到该整数（取整通道不是装饰）", async ({ page }) => {
    await openWorkbench(page);
    const before = await settle(page);
    expect(before.rail).toBeCloseTo(TREE_WIDTH_DEFAULT, 0);

    // 目标：拖到 238.6px ⇒ clampTreeWidth 取整成 239 ⇒ 面板应被同步到 239（旧形态停在 238.6）
    const handle = page.locator('[data-testid="tree-resizer"]');
    const box = await handle.boundingBox();
    if (!box) throw new Error("tree-resizer 没有 boundingBox");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const targetDx = 239 - before.rail - 0.4;
    await page.mouse.move(cx, cy);
    await frame(page);
    await page.mouse.down();
    await frame(page);
    await page.mouse.move(cx + targetDx, cy, { steps: 4 });
    await frame(page);
    await page.mouse.up();
    await frame(page);
    const after = await settle(page);
    const stored = await waitForStored(page, after.stored);
    const geom = await page.evaluate(() => {
        const group = document.querySelector("[data-panel-group]");
        const rail = document.querySelector('[data-testid="workspace-file-rail"]');
        const panel = rail?.closest("[data-panel]") as HTMLElement | null;
        const grow = Number(panel?.style.flexGrow ?? "0");
        const railW = rail?.getBoundingClientRect().width ?? -1;
        return {
            groupRect: group?.getBoundingClientRect().width ?? -1,
            railW,
            grow,
            impliedBase: grow > 0 ? railW / (grow / 100) : -1,
        };
    });
    console.log("[task2] clamp-rounding", JSON.stringify({ after, stored, geom }));
    expect(stored, "落盘必须是整数（clampTreeWidth 取整）").toBe(Math.round(stored));
    // px 容差取 1% + 1px：判据式与出处见 `DEV-011 §6.2`（不在本文件复述原因）。
    // 「通道不是装饰」的**判别力**在 ⑦（组宽变化：240 保持 vs 按 % 缩到 ~194），不在这条。
    expect(
        Math.abs(after.rail - stored),
        `面板(${after.rail}) 应跟随落盘值 ${stored}`,
    ).toBeLessThanOrEqual(stored * 0.01 + 1);
});
