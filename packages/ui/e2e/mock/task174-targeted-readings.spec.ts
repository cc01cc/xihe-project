/**
 * 说明（Lead 2026-11-15 裁定）：本 spec 访问 `scheduled-tasks` 页只为「有面包屑的页面」这一读数，
 * 其列表接口 `GET /workspaces/{id}/scheduled-tasks` 的桩加在 `helpers/auth.ts`（**读数所需**，
 * 不是产品面新增）。此前缺桩 ⇒ 404 ⇒ 严格控制台断言失败 ⇒ 读数有效但 spec 恒红，
 * 那会让后来人分不清「真回归」与「已知红」。
 */
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

/**
 * task-174 两条**定向**读数（Lead 2026-11-15 要求：两个读数冲突时不许选一个信）。
 *
 * ① 状态栏 `aria-current`：S2a 那轮读到「状态栏内恒 1 处」(`cac2a82b9`)，本批在 chat 页读到 0。
 *    定向做法 = 换**确实有面包屑**的页面（scheduled-tasks）再读，并同时报「该页有没有面包屑元素」。
 *    结论只能是甲（本批回归）/ 乙（该页本来没有面包屑 ⇒ 0 是正确值，判据要改写成「有面包屑时 1 处」）。
 *
 * ② 顶部全局页签行：`v-if="tabs.length > 0 && claims === 0"` —— **条件隐藏 ≠ 实例移除**。
 *    必须在**确实有 tab 打开**（`v-if` 为真）的页面读实例数；为 0 才说明实例真的不再渲染。
 */
test.describe("task-174 定向读数", () => {
    test("① 有面包屑的页面：状态栏 aria-current + 面包屑元素存在性", async ({ page }) => {
        await setupMockAuth(page, {});
        await setupMockSessions(page, { sessions: [{ id: "targeted-session", title: "T" }] });
        const reads: Record<string, unknown> = {};

        for (const target of [
            { name: "chat", path: `/workspace/${WORKSPACE_ID}/session/targeted-session` },
            { name: "scheduled", path: `/workspace/${WORKSPACE_ID}/scheduled-tasks` },
        ]) {
            await page.goto(target.path);
            await page.locator('[data-testid="workspace-status-bar"]').waitFor({
                state: "visible",
                timeout: EXPECT_TIMEOUT_MS,
            });
            const bar = page.locator('[data-testid="workspace-status-bar"]');
            reads[target.name] = {
                statusBarAriaCurrent: await bar.locator("[aria-current]").count(),
                breadcrumbAny: await page
                    .locator(
                        '[data-testid*="breadcrumb"], nav[aria-label*="面包屑"], [aria-label*="readcrumb"]',
                    )
                    .count(),
                barTextHasWs: (await bar.innerText()).includes("Mock Workspace"),
            };
        }

        console.log("[task174-targeted] " + JSON.stringify(reads));
        // 只钉「两个页面都读到了」，结论由读数 + 卡面裁定，不在这里强行判甲/乙。
        expect(Object.keys(reads)).toEqual(["chat", "scheduled"]);
    });

    test("② 有 tab 打开时：全局行实例数（条件隐藏 vs 实例移除）", async ({ page }) => {
        await setupMockAuth(page, {});
        await setupMockSessions(page, {
            sessions: [
                { id: "targeted-a", title: "A" },
                { id: "targeted-b", title: "B" },
            ],
        });
        // 先钉两个会话页签（openTabs 有内容 ⇒ TabBar 的 v-if 为真）。
        await page.goto(`/workspace/${WORKSPACE_ID}/session/targeted-a`);
        await page
            .locator('[data-testid="workspace-main"]')
            .waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS });
        await page.goto(`/workspace/${WORKSPACE_ID}/session/targeted-b`);
        await page
            .locator('[data-testid="workspace-main"]')
            .waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS });
        await page.goto(`/workspace/${WORKSPACE_ID}/session/targeted-a`);
        await page
            .locator('[data-testid="workspace-container-tabs"]')
            .first()
            .waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS });

        const state = await page.evaluate(() => {
            const key = Object.keys(localStorage).find((k) => k.startsWith("xihe-layout-ws:"));
            const raw = key ? localStorage.getItem(key) : null;
            const parsed = raw ? (JSON.parse(raw) as { openTabs?: string[] }) : null;
            return {
                layoutKey: key ?? null,
                openTabs: parsed?.openTabs ?? [],
                globalTabBarRows: document.querySelectorAll('[data-testid="workspace-tab-bar"]')
                    .length,
                containerRowTabs: Array.from(
                    document.querySelectorAll('[data-testid="workspace-container-tabs"]'),
                ).map((node) => ({
                    container: node.getAttribute("data-container"),
                    tabs: node.querySelectorAll('[role="tab"]').length,
                })),
            };
        });

        console.log("[task174-targeted] " + JSON.stringify({ judge2: state }));
        // 「有 tab 打开」这个前提必须先成立，否则「全局行 = 0」可能只是因为 v-if 为假。
        expect((state.openTabs ?? []).length, "前提：至少一个钉住的页签").toBeGreaterThan(0);
        expect(state.globalTabBarRows, "全局行实例数（前提已成立）").toBe(0);
    });
});
