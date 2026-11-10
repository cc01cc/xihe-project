// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";
import { isWorkspaceLayerConfigRequest } from "../../src/lib/settingsIaRequests";

/**
 * PLAN-0752 收尾（task-184）：
 *
 * - T2.5：workspace 域段深链的浏览器用例 —— /workspace/:id/settings/:domain 直达
 *   （task-150 审计：e2e/** 里该形态命中 0，此前只有单测 WorkspaceSettingsView.spec.ts:217）
 *   + ?tab= 既有路径回归 + 域段 404（V3 形态）。
 * - T5.2（mock 部分）：V10「/settings/* 不渲染工作区 <Sidebar>」的自动化断言。
 *   verify.md:37 写的 testid 是 workspace-sidebar —— 组件真实 testid 是 sidebar
 *   （src/components/sidebar/Sidebar.vue:183），本 spec 按真实 testid 断言，
 *   差异由 Lead 回填 verify.md 时更正。
 * - V12：375×812 抽屉可开合 + 无横向滚动。平台纪律（Lead 指令）：Windows 上
 *   expectPlatformScreenshot 是空操作（比较判定留 Linux 轮），本 spec 用
 *   page.screenshot 做留档截图（任意平台可用），并把每个断言槽写成三态记录
 *   （value=捕获留档 / empty=确认为空 / unreadable=读不出）落 JSON，供回填。
 *
 * <p>task-230（2026-11-10）：上面「域段 404 + 零工作区层请求」这条原本是**恒真断言** ——
 * 采集端只存 pathname，判定端比 `/config/workspace/` 前缀，而工作区层的读路径是
 * `/config/<domain>?layer=workspace`（层在 query），两边都碰不到层 ⇒ filter 恒空。
 * 现改为采集 pathname+search 并用 `src/lib/settingsIaRequests.ts` 的纯函数判定（该函数有单测）。</p>
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
        // task-230：收 **pathname + search**。只收 pathname 会丢掉 query，而工作区层的读请求是
        // /config/<domain>?layer=workspace —— 层在 query 里。丢了它，下游「零工作区层请求」判定
        // 就恒真（假绿）。
        if (url.pathname.includes("/config/")) {
            configRequests.push(`${url.pathname}${url.search}`);
        }
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

test.describe("PLAN-0752 T2.5 workspace 域段深链", () => {
    test("deep link /workspace/ws-1/settings/rag renders the single-domain page", async ({
        page,
    }) => {
        await mockSettingsAPIs(page);
        await page.goto("/workspace/ws-1/settings/rag");
        await expect(page.getByTestId("workspace-settings-page")).toBeVisible();
        await expect(page.getByTestId("ws-settings-domain-page")).toBeVisible();
        const title = page.getByTestId("ws-settings-domain-title");
        await expect(title).toBeVisible();
        await expect(title).not.toHaveText("");
        // T1.1b（task-179，d5865c57 已进 develop）：工作区域页层头归一到 SettingsLayerHeader
        // —— 面包屑「设置 › 工作区层 › {域}」+ text-2xl 层标题（旧手写 kicker 已退役）。
        await expect(page.getByTestId("settings-layer-header")).toBeVisible();
        await expect(page.getByTestId("settings-breadcrumb")).toBeVisible();
        // 工作区设置是 **AppLayout 壳内的 tab**（导航页签「工作区设置」），不是 /settings 层壳：
        // 因此这里工作区 Sidebar 恰好渲染 1 份（V10 只约束 /settings/* 的实例/用户层，见下方用例）。
        await expect(page.getByTestId("sidebar")).toHaveCount(1);
        await expect(page.getByTestId("settings-not-found")).toHaveCount(0);
    });

    test("approval-policy domain segment exposes policy/tool-faces domain tabs", async ({
        page,
    }) => {
        await mockSettingsAPIs(page);
        await page.goto("/workspace/ws-1/settings/approval-policy");
        await expect(page.getByTestId("ws-settings-domain-page")).toBeVisible();
        const tabs = page.getByTestId("ws-settings-domain-tabs");
        await expect(tabs).toBeVisible();
        await expect(page.getByTestId("settings-domain-tab-policy")).toHaveAttribute(
            "aria-selected",
            "true",
        );
        await page.getByTestId("settings-domain-tab-tool-faces").click();
        await expect(page.getByTestId("ws-settings-tool-faces")).toBeVisible();
        await page.getByTestId("settings-domain-tab-policy").click();
        await expect(page.getByTestId("settings-domain-tab-policy")).toHaveAttribute(
            "aria-selected",
            "true",
        );
        await expect(page.getByTestId("ws-settings-tool-faces")).toHaveCount(0);
    });

    test("domain outside the workspace matrix renders 404 view with zero config requests", async ({
        page,
    }) => {
        const configRequests: string[] = [];
        await mockSettingsAPIs(page, configRequests);
        await page.goto("/workspace/ws-1/settings/logging");
        await expect(page.getByTestId("settings-not-found")).toBeVisible();
        await expect(page.getByTestId("ws-settings-domain-page")).toHaveCount(0);
        // T3.4 口径：域段 404 是路由层判定，零**工作区层** /config 请求（不是空表单）。
        // AppLayout 壳内的其它组件会拉 user/instance 层域配置（/config/<domain>?layer=user），
        // 与本页 404 判定无关，所以判据收窄到「工作区层」，而不是字面的「零 /config 请求」。
        //
        // task-230：**收窄的实现方式**换掉了。旧写法 `p.includes("/config/workspace/")` 只比对
        // pathname 片段，而工作区层的读路径是 /config/<domain>?layer=workspace（层在 query）⇒
        // 该 filter 命中集恒空 ⇒ 断言恒真：它只证明「没发写请求」，绿着但没验到读请求。
        // 现按纯函数判定（src/lib/settingsIaRequests.ts，有单测），读写两种形态都覆盖。
        // 失败时把**全部**捕获到的 config 请求打出来：否则「多了一条」只能靠猜来源。
        const captured = `捕获到的 config 请求：${JSON.stringify(configRequests)}`;
        expect(
            configRequests.filter((requestUrl) => isWorkspaceLayerConfigRequest(requestUrl)),
            `404 域段不得发工作区层 /config 请求。${captured}`,
        ).toEqual([]);
        // 「不得请求 /config/logging」这条**不能加**（task-230 实测后撤回，别再加回来）：
        // App.vue:30 的启动预热 configStore.loadAllDomains() 会拉 CONFIG_DOMAINS（10 个域，
        // 含 logging；stores/config.ts:52-58），**任何已登录页面**都会发。实测本用例捕获到的
        // 10 条正好是那 10 个域：
        //   llm-provider / context-policy / embedding / rag / agent-runtime / agent-profile /
        //   user-preference / logging / approval-policy / job-policy
        // 也就是说「有没有 /config/logging」度量的是**应用壳启动预热**，不是本页 404 行为，
        // 加进来会让任何页面都红。本页判据只能落在「有没有**工作区层**请求」上（上一条）。
        // 依据：isWorkspaceLayerConfigRequest 的读路径口径见 src/lib/settingsIaRequests.ts。
    });

    test("legacy ?tab= form still renders every tab container", async ({ page }) => {
        await mockSettingsAPIs(page);
        await page.goto("/workspace/ws-1/settings?tab=config");
        // T1.1b 后概览态层头 = SettingsLayerHeader（旧 workspace-settings-heading 退役）。
        await expect(page.getByTestId("settings-layer-header")).toBeVisible();
        await expect(page.getByTestId("ws-settings-tab-config")).toBeVisible();
        // 工作区设置页在 AppLayout 壳内（页签形态），工作区 Sidebar 照常 1 份。
        await expect(page.getByTestId("sidebar")).toHaveCount(1);

        await page.goto("/workspace/ws-1/settings?tab=mcp");
        await expect(page.getByTestId("ws-settings-mcp")).toBeVisible();

        await page.goto("/workspace/ws-1/settings?tab=credentials");
        await expect(page.getByTestId("ws-settings-credentials")).toBeVisible();

        await page.goto("/workspace/ws-1/settings?tab=knowledge");
        await expect(page.getByTestId("ws-settings-knowledge")).toBeVisible();

        // 无域段无 tab = 旧默认入口（general）。
        await page.goto("/workspace/ws-1/settings");
        await expect(page.getByTestId("ws-settings-general")).toBeVisible();
    });

    test("domain page overview button returns to the ?tab=config form", async ({ page }) => {
        await mockSettingsAPIs(page);
        await page.goto("/workspace/ws-1/settings/rag");
        await expect(page.getByTestId("ws-settings-domain-page")).toBeVisible();
        await page.getByTestId("ws-settings-domain-overview").click();
        await expect(page).toHaveURL(/workspace\/ws-1\/settings\?tab=config$/);
        await expect(page.getByTestId("settings-layer-header")).toBeVisible();
        await expect(page.getByTestId("ws-settings-tab-config")).toBeVisible();
        await expect(page.getByTestId("ws-settings-domain-page")).toHaveCount(0);
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

        // 工作区域段页在移动端同样无横向滚动（壳是 AppLayout，不是 SettingsLayout）。
        await page.goto("/workspace/ws-1/settings/rag");
        await expect(page.getByTestId("ws-settings-domain-page")).toBeVisible();
        await expectNoHorizontalScroll();
        await record("horizontalOverflowWorkspaceDomain", async () => {
            const px = await overflowPx();
            return { overflowPx: px, hasHorizontalOverflow: px > 0 };
        });
        await record("screenshotWorkspaceDomainMobile", async () => {
            const file = await shoot("v12-workspace-domain-mobile.png");
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
