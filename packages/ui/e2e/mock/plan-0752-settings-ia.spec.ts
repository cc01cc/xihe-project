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
    // task-466（D-1322 统一口径，照 task-461 / BL-318 先例）：兜底 `200 {}` 会吞掉页面合法调用的
    // 会话集合面（`/sessions?scope=workspaceless` 与 `/workspaces/{id}/sessions`），`api.ts` 的
    // `normalizeSessionListPayload` 要求 `sessions` 数组 ⇒ `{}` 必 throw ⇒ logger[ERROR] ⇒ 共享 console 门红。
    // **后注册者优先（LIFO）**，所以这条必须在兜底之后。非 GET 仍 `fallback()` 交回上层。
    // **边界**：`{sessions: []}` 是合法空集，在这里成立只因为本 spec **不断言会话内容**；
    // 要验会话内容的 spec 必须给真行，空集会让断言变成空断言（D-1281 同族）⇒ 不许照抄到需要内容的场景。
    // 本 spec 的 page 形参是 any（沿用文件既有写法）⇒ 这里显式给 Route 类型，
    // 否则 TS7006 隐式 any（typecheck:e2e 门只拦新增，实测本条曾红）。
    await page.route(
        /\/api\/v1\/(?:workspaces\/[^/]+\/)?sessions(?:\?.*)?$/,
        (route: import("@playwright/test").Route) => {
            if (route.request().method() !== "GET") return route.fallback();
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ sessions: [] }),
            });
        },
    );
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
    test("legacy resource ?tab= falls back to general and points at the resources module (task-209)", async ({
        page,
    }) => {
        const configRequests: string[] = [];
        await mockSettingsAPIs(page, configRequests);

        // task-209 / D-1019：`mcp` / `credentials` / `knowledge` 三个 tab 与资源区双入口 ⇒ 撤。
        // 旧深链（书签/文档/外部引用）**不做 404**：回落到「常规」，并就地点名搬去哪 + 给直链。
        // 判据写成正面守卫：三个旧容器计数为 0、提示条在、链接地址是资源区对应层。
        for (const legacy of ["mcp", "credentials", "knowledge"] as const) {
            await page.goto(`/workspace/ws-1/settings?tab=${legacy}`);
            // task-253 起工作区设置页自带标题头（不再借用 SettingsLayerHeader 的「设置 › 工作区层」面包屑）。
            await expect(page.getByTestId("workspace-settings-header")).toBeVisible();
            await expect(page.getByTestId("ws-settings-general")).toBeVisible();
            await expect(page.getByTestId(`ws-settings-${legacy}`)).toHaveCount(0);
            await expect(page.getByTestId(`ws-settings-tab-${legacy}`)).toHaveCount(0);
            await expect(page.getByTestId("ws-settings-resource-moved")).toBeVisible();
            await expect(page.getByTestId("ws-settings-resource-moved-action")).toHaveAttribute(
                "href",
                `/resources/${legacy}?layer=WORKSPACE`,
            );
        }

        // task-236（M4-3）：成员提升为一级页（/workspace/:id/members）——设置页成员 tab 已撤
        // （BL-344 三态语义随面板迁入成员页）；存活容器仍是 2 个（常规 + 配置）。
        await page.goto("/workspace/ws-1/settings");
        await expect(page.getByTestId("ws-settings-tab-general")).toBeVisible();
        await expect(page.getByTestId("ws-settings-tab-members")).toHaveCount(0);
        await expect(page.locator('[data-testid^="ws-settings-tab-"]')).toHaveCount(2);
        await expect(page.getByTestId("ws-settings-resource-moved")).toHaveCount(0);
        // 工作区设置页在 AppLayout 壳内（页签形态），工作区 Sidebar 照常 1 份。
        await expect(page.getByTestId("sidebar")).toHaveCount(1);

        // PLAN-0773 M4-1（task-190，d0864b59e）：配置 tab **回来了** —— 但这次是 per-workspace 层
        // （`ConfigLayer` 新增 `workspace`），不是 task-253 退役的那个全局入口。
        // 断言从「不存在」翻成「存在」而不是删掉：纯删除只能证明「这一刻没写」，有人再撤掉它
        // 时不会有任何东西变红（同 WorkspaceSettingsView.spec.ts:145-149 的翻面理由）。
        // 本条在 M4-1 之后**恒红**，直到 2026-11-13 才被发现：76bc895a3 只跟了单测与 configStore
        // 两处规格，漏了这里（第三处），于是阻断门带着一条过期断言红了整整一天。
        await expect(page.getByTestId("ws-settings-tab-config")).toHaveCount(1);

        // 默认页签仍是 general（tabFromQuery:65-67）⇒ 配置面板不挂载，工作区层 config 读不会
        // 因为 M4-1 把 tab 加回来就凭空冒出来 —— 下面这条防复活守卫判的就是这个。
        await expect(page.getByTestId("ws-settings-config")).toHaveCount(0);

        // 防复活守卫（task-230 建立，task-253 删面后接手）：**默认页签**下工作区设置页不得发出
        // **工作区层** config 请求（M4-1 后点开配置 tab 的读面是合法的，由那一 tab 自己覆盖）。读路径的层在 query（/config/<domain>?layer=workspace），**pathname 里看不出来**，
        // 所以只能走纯函数判（src/lib/settingsIaRequests.ts，带单测），读写两种形态都覆盖。
        // 失败时把**全部**捕获到的 config 请求打出来：否则「多了一条」只能靠猜来源。
        const captured = `捕获到的 config 请求：${JSON.stringify(configRequests)}`;
        expect(
            configRequests.filter((requestUrl) => isWorkspaceLayerConfigRequest(requestUrl)),
            `工作区设置页不得发工作区层 /config 请求。${captured}`,
        ).toEqual([]);
    });
});

test.describe("PLAN-0752 T5.2 V10 无工作区 Sidebar 泄漏（mock 自动化断言）", () => {
    // task-485：原第 4 条用的是 `/settings/user/agent-profile` —— 该路径已 302 到 /members
    // （`agent-profile` 迁出设置区，D4），在 /settings 下断言"层头可见"会变成断言一个不存在的页。
    // 换成仍在用户层矩阵里的 `agent-templates`；302 本身另立一条用例（下面那条 302 用例）。
    for (const url of [
        "/settings/instance/llm-provider",
        "/settings/instance/logging",
        "/settings/user/rag",
        "/settings/user/agent-templates",
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

/**
 * task-485 / task-226 D4（用户 2026-11-14 ④）：`agent-profile` 撤出设置区，旧 URL **302 → 成员管理**。
 *
 * <p>为什么单独立一条而不是把旧断言删掉：删掉只能证明"这一刻没人访问这个 URL"，
 * 将来有人把重定向去掉、让它掉进 404 兜底时不会有任何东西变红（同 `config-settings.spec.ts`
 * 里"翻面而不是删除"的理由）。判据是**终态 URL**，不是"页面没报错"。</p>
 */
test.describe("task-485 智能体个人迁出设置区（302 不 404）", () => {
    for (const url of ["/settings/instance/agent-profile", "/settings/user/agent-profile"]) {
        test("redirects " + url + " to the members module", async ({ page }) => {
            await mockSettingsAPIs(page);
            await page.goto(url, { waitUntil: "load" });
            await expect(page).toHaveURL(/\/members$/);
            // 反向：不得落 404 视图（那是把"迁走"做成"死链"）。
            await expect(page.getByTestId("settings-not-found")).toHaveCount(0);
        });
    }
});

/**
 * task-485「智能体配置」组页（用户 2026-11-14 ③「智能体模板与角色应该放到智能体配置里」）。
 *
 * <p>判据：两段**同时挂载**（不是 tab）、各自 testid 落在同一页、页内锚点导航给出两个段的链接；
 * 且锚点是 `#settings-domain-<域>`（只改 hash 不触发路由），不是两条路由。</p>
 */
test.describe("task-485 智能体配置组页（两段一页，域不合并）", () => {
    for (const layer of ["instance", "user"] as const) {
        test("renders both agent sections on " + layer, async ({ page }) => {
            await mockSettingsAPIs(page);
            await page.goto(`/settings/${layer}/agent-config`, { waitUntil: "load" });
            await expect(page.getByTestId("settings-agent-config-view")).toBeVisible();
            await expect(page.getByTestId("settings-agent-config-title")).toBeVisible();
            // 两段都在 DOM 里（不是"点导航才出现"）。
            await expect(page.locator('[data-testid^="settings-agent-config-nav-"]')).toHaveCount(
                2,
            );
            await expect(
                page.getByTestId("settings-agent-config-nav-agent-templates"),
            ).toHaveAttribute("href", "#settings-domain-agent-templates");
            await expect(
                page.getByTestId("settings-agent-config-nav-agent-runtime"),
            ).toHaveAttribute("href", "#settings-domain-agent-runtime");
        });
    }

    test("workspace layers do not register the agent-config group route", async ({ page }) => {
        await mockSettingsAPIs(page);
        // 工作区层撤掉 `agent-templates` 后该组只剩 1 段 ⇒ 不成组、不注册组路由 ⇒ 走 404 视图。
        await page.goto("/settings/workspace-default/agent-config", { waitUntil: "load" });
        await expect(page.getByTestId("settings-not-found")).toBeVisible();
    });
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
