// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { expect, test } from "./helpers/mock-test";
import { expectPlatformScreenshot } from "../helpers/visual";
import { LONG_TIMEOUT_MS } from "../timeouts";

interface Route {
    path: string;
    name: string;
    requiresAuth: boolean;
    /**
     * task-171：该路由的**产品页**在真栈上要求实例管理员能力（设置区实例层门
     * `cap:instance:admin` → `authStore.hasInstanceAdminCapability` ← `user.capabilities.isInstanceAdmin`）。
     * 截图夹具此前只塞了 token、没有 user ⇒ 页面正确地渲染成「需要实例管理员能力」的警示卡，
     * 于是 `settings-domain-title` 永不出现、用例 30 s 超时。**产品行为是对的，夹具缺能力位。**
     * 形状照 `e2e/mock/config-settings.spec.ts:32-49`（同一字段、同一来源）。
     */
    needsInstanceAdmin?: boolean;
}

const allRoutes: Route[] = [
    { path: "/login", name: "login", requiresAuth: false },
    { path: "/register", name: "register", requiresAuth: false },
    { path: "/workspace", name: "workspace-default", requiresAuth: true },
    {
        path: "/workspace/workspace-1/chat/test-session",
        name: "workspace-chat-session",
        requiresAuth: true,
    },
    {
        path: "/settings/config",
        name: "settings-config",
        requiresAuth: true,
        needsInstanceAdmin: true,
    },
    { path: "/resources/knowledge", name: "resources-knowledge", requiresAuth: true },
    {
        path: "/settings/data",
        name: "settings-data",
        requiresAuth: true,
        needsInstanceAdmin: true,
    },
    { path: "/settings/monitoring", name: "settings-monitoring", requiresAuth: true },
    { path: "/workspace/ws-e2e-1", name: "workspace", requiresAuth: true },
];

/**
 * task-4 / BL-601：**截图前的就绪门**（不是固定 sleep，也不是「两次截图相同」）。
 *
 * <p>只等 `#app` 可见不够：页面在壳层可见后还有异步数据落地，期间内容区是白的。
 * `[实测] 2026-11-13`（**同容器、同 commit、只改 `--update-snapshots` 模式**）：8 513 B 纯白
 * 1920×1080 会被写成「基线」，而比较运行时拿同一张白图去比同一张白图 ⇒ `9 passed` —— 假绿；
 * 更狠的是 `=all` 让白页**在两次运行之间换路由**（workspace-default ↔ /workspace），且
 * `settings-data` 两次渲染 33 105 → 79 070 B ⇒ 拍到的不是稳态。</p>
 *
 * <p>判据 = **landmark 可见**（显式 timeout），landmark 一律选**既有**元素：7 条路由用产品面已有的
 * `data-testid`；`/login` 与 `/register` 产品面本来没有 testid（本轮不改产品代码、不新增
 * testid），用它们唯一的 `<form aria-busy>` 作 landmark —— 表单可见即该页 hero 与字段已挂载。</p>
 *
 * <p>**未登记的路由直接抛错**：新增路由忘了补门会当场红，而不是悄悄拍白图。</p>
 */
const readinessLandmarks: Record<string, { testId: string } | { selector: string }> = {
    login: { selector: "form[aria-busy]" },
    register: { selector: "form[aria-busy]" },
    // 无 tab 上下文时的选择面（PLAN-0608 C′）。
    "workspace-default": { testId: "workspace-picker" },
    // 聊天面：composer 只在会话投影落地后挂载。
    "workspace-chat-session": { testId: "chat-input" },
    // 实例层域页：层与域都解析完才出现标题。
    "settings-config": { testId: "settings-domain-title" },
    // 知识库缺口页（G3：无实体/无列表/无详情，只解释缺口并给出口）。
    "resources-knowledge": { testId: "resources-knowledge-gap" },
    // /settings/data 不是配置域页（router/index.ts:159-164 → DataControlsView，实例运维面）：
    // 标题是静态的，真正的「已落地」信号是保留策略卡进入三态之一（有数据 / 报错 / 无工作区）。
    "settings-data": {
        selector:
            '[data-testid="settings-checkpoint-constants"], [data-testid="settings-checkpoint-error"], [data-testid="settings-checkpoint-no-workspace"]',
    },
    "settings-monitoring": { testId: "settings-monitoring-heading" },
    // 工作区壳：页签栏以下唯一的路由容器（AppLayout）。
    workspace: { testId: "workspace-route-viewport" },
};

for (const route of allRoutes) {
    test(`${route.name} renders with 0 console errors`, async ({ page }) => {
        const errors: string[] = [];
        page.on("console", (msg) => {
            if (msg.type() === "error") errors.push(msg.text());
        });
        page.on("pageerror", (err) => errors.push(err.message));

        if (route.requiresAuth) {
            await page.addInitScript(() => {
                localStorage.setItem("xihe-token", "mock-token-for-screenshot");
            });
        }

        if (route.needsInstanceAdmin) {
            // 只给需要它的两条路由加，**不广播**：其它路由的截图是别的渲染面，
            // 多给一次能力位就可能让第 3 张基线变（task-171 验收 ②）。
            await page.addInitScript(() => {
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
            });
        }

        if (route.path === "/workspace/workspace-1/chat/test-session") {
            await page.addInitScript(() => {
                localStorage.setItem(
                    "xihe-sessions",
                    JSON.stringify([
                        {
                            id: "test-session",
                            title: "Test Session",
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                        },
                    ]),
                );
            });
        }

        await page.route("**/api/v1/events**", async (route2) => {
            await route2.fulfill({
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
                body: new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode("retry: 5000\n\n"));
                    },
                }),
            });
        });

        await page.route("**/api/v1/**", async (route2) => {
            const requestUrl = new URL(route2.request().url());
            const workspaceMatch = requestUrl.pathname.match(/\/api\/v1\/workspaces\/([^/]+)$/);
            if (workspaceMatch) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ id: workspaceMatch[1], name: "Screenshot Workspace" }),
                });
                return;
            }
            if (requestUrl.pathname.endsWith("/sessions")) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ sessions: [] }),
                });
                return;
            }
            const sessionMatch = requestUrl.pathname.match(/\/api\/v1\/sessions\/([^/]+)$/);
            if (sessionMatch) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        id: sessionMatch[1],
                        title: "Screenshot Session",
                        workspaceId: "workspace-1",
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                        archived: false,
                    }),
                });
                return;
            }
            if (requestUrl.pathname.endsWith("/policy/mode")) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        sessionId: "test-session",
                        mode: "manual",
                        sessionRules: 0,
                    }),
                });
                return;
            }
            // `GET /api/v1/version` returns `VersionInfo`, whose `modules: {cp, agent, runtime}`
            // is required and rendered by MonitoringView (`versionInfo.modules.cp.version`). The
            // `{}` catch-all below therefore threw `Cannot read properties of undefined
            // (reading 'cp')` — a fixture gap, not a UI error, and this spec asserts 0 console
            // errors per route.
            if (requestUrl.pathname.endsWith("/version")) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        stackId: "stack-1",
                        releaseChannel: "dev",
                        startedAt: new Date().toISOString(),
                        commit: null,
                        modules: {
                            cp: { version: "0.0.0-mock", commit: null },
                            agent: { version: "0.0.0-mock", commit: null },
                            runtime: { version: "0.0.0-mock", commit: null },
                        },
                    }),
                });
                return;
            }
            // A page that renders "with 0 console errors" only proves something if the chat
            // projections answer with their real shapes. The `{}` catch-all below made the chat
            // surfaces read `undefined.find` / `.filter` / `.map` (messages array, follow-up queue
            // `items`, derived-state `activeChildren`) and the monitor read `history.recent`, i.e.
            // the route "rendered" only because the failure landed after the assertion.
            const sessionPath = (suffix: string) =>
                requestUrl.pathname.endsWith(`/sessions/test-session/${suffix}`);
            if (sessionPath("messages")) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify([]),
                });
                return;
            }
            if (sessionPath("derived-state")) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        sessionId: "test-session",
                        activeChildren: [],
                        terminalNotices: [],
                    }),
                });
                return;
            }
            if (sessionPath("follow-ups")) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        sessionId: "test-session",
                        queueState: "empty",
                        outstandingCount: 0,
                        capacityLimit: 5,
                        pauseReason: null,
                        items: [],
                    }),
                });
                return;
            }
            if (sessionPath("participants")) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ participants: [] }),
                });
                return;
            }
            if (sessionPath("branches")) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        sessionId: "test-session",
                        items: [
                            {
                                branchId: "00000000-0000-4000-8000-000000000001",
                                parentBranchId: null,
                                forkPointMessageId: null,
                                forkPointRunId: null,
                                createdAt: new Date().toISOString(),
                            },
                        ],
                    }),
                });
                return;
            }
            if (sessionPath("commands")) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ commands: [] }),
                });
                return;
            }
            // `GET /chat/sessions/{id}/monitor` → `SessionMonitorResponse`. `history` and
            // `readiness` are required projections (`SessionMonitorPanel` renders
            // `data.history.recent`), so `{}` threw "reading 'recent'".
            if (
                requestUrl.pathname.includes("/chat/sessions/") &&
                requestUrl.pathname.endsWith("/monitor")
            ) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        generatedAt: new Date().toISOString(),
                        session: {
                            id: "test-session",
                            title: "Test Session",
                            agentPrincipalId: null,
                            modelProvider: null,
                            modelName: null,
                            providerConnectionId: null,
                            connectionRevision: null,
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                        },
                        activity: [],
                        history: { windowSize: 20, counts: {}, recent: [] },
                        readiness: {
                            connection: null,
                            agent: {
                                status: "unknown",
                                llmReady: "unknown",
                                verifiedAt: null,
                                configRevision: "0",
                            },
                            lastObservedRun: null,
                        },
                        transport: { attemptCount: 0, failedCount: 0, partialCount: 0 },
                    }),
                });
                return;
            }
            if (requestUrl.pathname.endsWith("/agents")) {
                // PLAN-0622 M1.2 envelope; `raw.agents.map` throws on a bare array.
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ agents: [] }),
                });
                return;
            }
            await route2.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({}),
            });
        });

        const resp = await page.goto(route.path, { waitUntil: "load", timeout: LONG_TIMEOUT_MS });
        expect(resp?.status()).toBe(200);
        await expect(page.locator("#app")).toBeVisible();
        // Readiness, not a clock（AGENTS 禁令：禁固定 sleep）：每条路由等自己的 landmark。
        const landmark = readinessLandmarks[route.name];
        if (!landmark) throw new Error(`no readiness landmark for route ${route.name}`);
        const gate =
            "testId" in landmark
                ? page.getByTestId(landmark.testId)
                : page.locator(landmark.selector).first();
        await expect(gate).toBeVisible({ timeout: LONG_TIMEOUT_MS });

        // **D-1085 ② 要求的非空断言**：截图前先证明「主内容真的挂载了且占了版面」。
        // 只比 sha 相等是禁止的 —— 两次都拍白也能逐字节相同（今晚实证过）。
        // 一级（这里）证明非空，二级（两次独立运行 sha256 相同）才允许说「稳态」。
        const gateBox = await gate.boundingBox();
        expect(gateBox, `landmark of ${route.name} has no layout box`).not.toBeNull();
        expect(
            (gateBox?.width ?? 0) * (gateBox?.height ?? 0),
            `landmark of ${route.name} has ~zero area (blank capture?)`,
        ).toBeGreaterThan(1000);
        const bodyTextLength = await page.evaluate(() => document.body.innerText.trim().length);
        expect(
            bodyTextLength,
            `page ${route.name} rendered no text (blank capture?)`,
        ).toBeGreaterThan(0);
        // 字体落地再拍：字体没到时文本度量未定（显式事件等待，不是等时间）。
        await page.evaluate(() => document.fonts.ready.then(() => true));

        // task-174：console 断言必须在截图**之前** —— 截图在非 linux 平台会 `test.skip()`，
        // skip 会中止用例体，放在后面等于「Windows 上这条断言永远不跑」（原顺序就是这样）。
        // 语义也更强：截图前已确认这一页零 console error。
        expect(errors).toEqual([]);

        await expectPlatformScreenshot(page, route.name + ".png");
    });
}
