import { type Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";

/**
 * task-504 A 步：**窄档让位以实测行宽为准**（D-1413 同族）。
 *
 * <p>修前读数（真栈 1024）：body 1014 / 导航 297 / 工作台 661 / 树 40 / 主列 **621** ——
 * 主列低于 640 硬底线，而挤压模型用派生值（viewport − rail − nav = 728）算出 688 ⇒ **不让位**。
 * 修法是把工作台元素的 rect（实测）喂进模型；本 spec 钉「修后主列达标」+「让位可观测」，
 * 并给 1440 档一条**不得变差**的对照。</p>
 */

const WORKSPACE_PATH = "/workspace/11111111-1111-4111-8111-111111111111";
const MAIN_MIN_WIDTH = 640;

async function settle(page: Page): Promise<void> {
    await page.waitForFunction(
        () => {
            const key = [
                Math.round(
                    document
                        .querySelector('[data-testid="workspace-workbench"]')
                        ?.getBoundingClientRect().width ?? -1,
                ),
                Math.round(
                    document
                        .querySelector('[data-testid="workspace-main"]')
                        ?.getBoundingClientRect().width ?? -1,
                ),
            ].join("/");
            const box = globalThis as { __p504?: { at: number; key: string } };
            const now = performance.now();
            if (!box.__p504 || box.__p504.key !== key) {
                box.__p504 = { at: now, key };
                return false;
            }
            return now - box.__p504.at >= 300;
        },
        undefined,
        { timeout: EXPECT_TIMEOUT_MS, polling: 50 },
    );
}

async function geometry(page: Page) {
    return page.evaluate(() => {
        const w = (sel: string): number => {
            const el = document.querySelector(sel);
            return el ? Math.round(el.getBoundingClientRect().width) : -1;
        };
        const rail = document.querySelector('[data-testid="sidebar"]');
        return {
            innerWidth: window.innerWidth,
            body: Math.round(document.body.getBoundingClientRect().width),
            sidebar: rail ? Math.round(rail.getBoundingClientRect().width) : -1,
            workbench: w('[data-testid="workspace-workbench"]'),
            tree: w('[data-testid="workspace-file-rail"]'),
            main: w('[data-testid="workspace-main"]'),
            navCollapsed: !!document.querySelector(
                '[data-testid="sidebar"][data-state="collapsed"]',
            ),
        };
    });
}

test.describe("task-504 窄档让位（实测行宽）", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: "session-1", title: "Session 1" }] });
    });

    test("1024 档：主列达到 640 硬底线，且导航让位可观测", async ({ page }) => {
        await page.setViewportSize({ width: 1024, height: 800 });
        await page.goto(WORKSPACE_PATH);
        await page.waitForSelector('[data-testid="workspace-main"]', {
            state: "attached",
            timeout: EXPECT_TIMEOUT_MS,
        });
        await settle(page);
        const g = await geometry(page);
        console.log("task504 1024 " + JSON.stringify(g));
        expect(g.main).toBeGreaterThanOrEqual(MAIN_MIN_WIDTH);
        // 让位可观测：导航列不再是 240+ 的展开宽（收到 rail 56 或至少让出缺口）
        expect(g.sidebar).toBeLessThan(200);
    });

    test("1440 档对照：本卡改动不得让宽档变差", async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(WORKSPACE_PATH);
        await page.waitForSelector('[data-testid="workspace-main"]', {
            state: "attached",
            timeout: EXPECT_TIMEOUT_MS,
        });
        await settle(page);
        const g = await geometry(page);
        console.log("task504 1440 " + JSON.stringify(g));
        expect(g.main).toBeGreaterThanOrEqual(MAIN_MIN_WIDTH);
        // 修前 1440 档主列 797（真栈）/ 树 240；改动只应在「实测不够」时让位
        expect(g.sidebar).toBeGreaterThan(200);
    });
});
