// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";

/**
 * PLAN-0752 收尾（task-184）：
 *
 * - T2.5：workspace 域段深链的浏览器用例 —— /workspace/:id/settings/:domain 直达
 *   （task-150 审计：e2e/** 里该形态命中 0，此前只有单测 WorkspaceSettingsView.spec.ts:217）
 *   + ?tab= 既有路径回归 + 域段 404（V3 形态）。
 *   **task-253（2026-11-10，Q-1110-45）已把工作区块配置层整体退役**：域段深链 / 域页 / 域 404 /
 *   域内 tool-faces 页签全部随删。本 spec 只保留 ?tab= 路径回归，四条被删用例在原处留了 (a) 标注。
 * - T5.2（mock 部分）：V10「/settings/* 不渲染工作区 <Sidebar>」的自动化断言。
 *   verify.md:37 写的 testid 是 workspace-sidebar —— 组件真实 testid 是 sidebar
 *   （src/components/sidebar/Sidebar.vue:183），本 spec 按真实 testid 断言，
 *   差异由 Lead 回填 verify.md 时更正。
 * - V12：375×812 抽屉可开合 + 无横向滚动。平台纪律（Lead 指令）：Windows 上
 *   expectPlatformScreenshot 是空操作（比较判定留 Linux 轮），本 spec 用
 *   page.screenshot 做留档截图（任意平台可用），并把每个断言槽写成三态记录
 *   （value=捕获留档 / empty=确认为空 / unreadable=读不出）落 JSON，供回填。
 */
const OUT_DIR = path.resolve(process.cwd(), "../../.local/evidence/plan-0752-closeout");
const V12_DIR = path.join(OUT_DIR, "v12");

type SlotState = "value" | "empty" | "unreadable";
interface Slot {
    state: SlotState;
    [key: string]: unknown;
}
const v12Records: Record<string, Slot> = {};

type SlotPayload = Omit<Slot, "state"> & { state?: SlotState };
async function record(
    slot: string,
    payload: () => SlotPayload | Promise<SlotPayload>,
): Promise<void> {
    try {
        const { state = "value", ...rest } = await payload();
        v12Records[slot] = { state, ...rest };
    } catch (e) {
        v12Records[slot] = { state: "unreadable", reason: String(e).slice(0, 300) };
    }
}

// mockAllow 是 regex 源码（见 helpers/mock-test.ts 头注）：放行 /rag/ 前缀的桩（不是 glob）。
test.use({ mockAllow: [...DEFAULT_MOCK_ALLOW, String.raw`/rag/`] });

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem("xihe-token", "mock-token");
        localStorage.setItem(
            "xihe-user",
            JSON.stringify({
                id: "u1",
                email: "admin@xihe.local",
                capabilities: {
                    isInstanceAdmin: true,
                    isInstanceSuper: true,
                    workspaceAdminOf: ["ws-1"],
                },
            }),
        );
        localStorage.setItem(
            "xihe-workspace",
            JSON.stringify({ id: "ws-1", name: "Mock Workspace" }),
        );
    });
});

async function mockSettingsAPIs(page: any, configRequests: string[] = []): Promise<void> {
    // Catch-all first: Playwright routes are LIFO, specific routes below win.
    await page.route("**/api/v1/**", async (route: any) => {
        const url = new URL(route.request().url());
        if (url.pathname.includes("/config/")) configRequests.push(url.pathname);
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({}),
        });
    });
    // knowledge 面板走非 /api/v1 前缀（stores/knowledge.ts:33 apiGet("/rag/stats")）。
    await page.route("**/rag/**", (route: any) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ documents: [], stats: {} }),
        }),
    );
    await page.route("**/api/v1/workspaces/ws-1", (route: any) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ id: "ws-1", name: "Mock Workspace" }),
        }),
    );
}

test.describe("PLAN-0752 T2.5 工作区设置页 tab 形态（域段已随 task-253 退役）", () => {
    // (a) 删 —— 域段深链「/workspace/ws-1/settings/rag 渲染单域页」：工作区块配置层整体退役
    //     （task-253 / Q-1110-45），域段路由与单域页都不会回来，断言对象已不存在。
    // (a) 删 —— 「approval-policy 域段暴露 policy/tool-faces 页签」：域内页签随域页一起删除；
    //     tool-faces 能力仍在实例层（ToolFacesView + 其 spec 保留），工作区入口按 Lead 裁定认下削减。
    // (a) 删 —— 「域段不在矩阵内渲染 404 且零 /config/workspace 请求」：域 404 面已不存在，
    //     且工作区层 /config 请求整体消失，判据失去对象。
    // (a) 删 —— 「域页概览按钮回 ?tab=config」：概览按钮与域页同批删除。
    test("legacy ?tab= form still renders every surviving tab container", async ({ page }) => {
        await mockSettingsAPIs(page);
        await page.goto("/workspace/ws-1/settings?tab=mcp");
        // task-253 起工作区设置页自带标题头（不再借用 SettingsLayerHeader 的「设置 › 工作区层」面包屑）。
        await expect(page.getByTestId("workspace-settings-header")).toBeVisible();
        await expect(page.getByTestId("workspace-settings-title")).toBeVisible();
        await expect(page.getByTestId("ws-settings-mcp")).toBeVisible();
        // 工作区设置页在 AppLayout 壳内（页签形态），工作区 Sidebar 照常 1 份。
        await expect(page.getByTestId("sidebar")).toHaveCount(1);

        await page.goto("/workspace/ws-1/settings?tab=credentials");
        await expect(page.getByTestId("ws-settings-credentials")).toBeVisible();

        await page.goto("/workspace/ws-1/settings?tab=knowledge");
        await expect(page.getByTestId("ws-settings-knowledge")).toBeVisible();

        // 无域段无 tab = 旧默认入口（general）。
        await page.goto("/workspace/ws-1/settings");
        await expect(page.getByTestId("ws-settings-general")).toBeVisible();

        // 工作区配置 tab 随层退役：任何 URL 都不该再把它渲染出来。
        await expect(page.getByTestId("ws-settings-tab-config")).toHaveCount(0);
    });
});

test.describe("PLAN-0752 T5.2 V10 无工作区 Sidebar 泄漏（mock 自动化断言）", () => {
    for (const url of [
        "/settings/instance/llm-provider",
        "/settings/instance/logging",
        "/settings/user/rag",
        "/settings/user/agent-profile",
    ]) {
        test("no workspace Sidebar on " + url, async ({ page }) => {
            await mockSettingsAPIs(page);
            await page.goto(url);
            await expect(page.getByTestId("settings-layer-header")).toBeVisible();
            await expect(page.getByTestId("settings-layer-title")).toBeVisible();
            // V10 判据本体：AppLayout 的工作区 <Sidebar> 在 /settings/* 下 count 0。
            await expect(page.getByTestId("sidebar")).toHaveCount(0);
            // 桌面断言：抽屉切换钮 lg:hidden（仅移动端）。
            await expect(page.getByTestId("settings-drawer-toggle")).not.toBeVisible();
        });
    }
});

test.describe("PLAN-0752 V12 移动端 375×812（三态记录）", () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test("drawer opens/closes and settings never scroll horizontally", async ({ page }) => {
        mkdirSync(V12_DIR, { recursive: true });
        await mockSettingsAPIs(page);

        const overflowPx = async (): Promise<number> =>
            page.evaluate(
                () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            );
        /** V12 判据：无横向滚动 ⇔ scrollWidth <= clientWidth（负值=容器比视口窄，同样无滚动）。 */
        const expectNoHorizontalScroll = async (): Promise<void> => {
            expect(await overflowPx()).toBeLessThanOrEqual(0);
        };
        const shoot = async (name: string): Promise<string> => {
            const file = path.join(V12_DIR, name);
            await page.screenshot({ path: file, fullPage: false });
            return file;
        };

        await page.goto("/settings/user/rag");
        await expect(page.getByTestId("settings-layer-header")).toBeVisible();

        await record("desktopAsideHiddenAtMobile", async () => ({
            visible: await page.locator("aside").first().isVisible(),
        }));
        await expectNoHorizontalScroll();
        await record("horizontalOverflowDrawerClosed", async () => {
            const px = await overflowPx();
            return { overflowPx: px, hasHorizontalOverflow: px > 0 };
        });
        await record("screenshotDrawerClosed", async () => {
            const file = await shoot("v12-drawer-closed.png");
            return { file: path.basename(file), captured: true };
        });

        // 开：aria-expanded 翻转 + 抽屉渲染。
        await page.getByTestId("settings-drawer-toggle").click();
        const drawer = page.getByTestId("settings-drawer");
        await expect(drawer).toBeVisible();
        await expect(page.getByTestId("settings-drawer-toggle")).toHaveAttribute(
            "aria-expanded",
            "true",
        );
        await expectNoHorizontalScroll();
        await record("horizontalOverflowDrawerOpen", async () => {
            const px = await overflowPx();
            return { overflowPx: px, hasHorizontalOverflow: px > 0 };
        });
        await record("screenshotDrawerOpen", async () => {
            const file = await shoot("v12-drawer-open.png");
            return { file: path.basename(file), captured: true };
        });

        // 合：抽屉 header 行第一个 button（X 关闭钮，SettingsLayout.vue:69-76）。
        await drawer.getByRole("button").first().click();
        await expect(drawer).toHaveCount(0);
        await record("drawerCycle", async () => ({ opened: true, closedAfterCloseClick: true }));

        // (a) 删 —— 「工作区域段页在移动端无横向滚动」取样：域段页随 task-253 退役，改由
        //     「工作区设置页 tab 形态」承担移动端宽屏取样（见下方 goto /settings 变体）。
        //     留档证据（v12-workspace-domain-mobile.png）保留在 .local/evidence，不再随跑更新。
        await page.goto("/workspace/ws-1/settings");
        await expect(page.getByTestId("workspace-settings-page")).toBeVisible();
        // 本行与下面两条取样是 task-253 之后**尚未在车道首跑**的新断言（本卡不跑 Playwright）。
        // 首跑若 workspace-settings-header 因工作区拉取时序不稳而不可见，优先加 waitFor/断言前置等待，不要删断言。
        await expect(page.getByTestId("workspace-settings-header")).toBeVisible();
        await expectNoHorizontalScroll();
        await record("horizontalOverflowWorkspaceSettings", async () => {
            const px = await overflowPx();
            return { overflowPx: px, hasHorizontalOverflow: px > 0 };
        });
        await record("screenshotWorkspaceSettingsMobile", async () => {
            const file = await shoot("v12-workspace-settings-mobile.png");
            return { file: path.basename(file), captured: true };
        });

        // 三态记录落盘（value=捕获留档 / empty=确认为空 / unreadable=读不出）。
        const summary = {
            slot: "V12",
            platform: process.platform,
            viewport: "375x812",
            comparison:
                "deferred-to-linux: expectPlatformScreenshot no-ops off Linux (helpers/visual.ts:16)",
            verdictOrder: "进程计数优先于终态判定（见收尾报告）",
            records: v12Records,
        };
        writeFileSync(path.join(V12_DIR, "v12-records.json"), JSON.stringify(summary, null, 4));
    });
});
