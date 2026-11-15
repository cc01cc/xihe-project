/**
 * task-585 只读余项仪器：**ws-less 上下文里，每个请求带的 X-Workspace-Id 是什么**。
 *
 * 判据不是「看起来没问题」，而是四列读数（页面 / 调用点 / 是否带旧头 / 依据）里的第三列：
 * 在 /chat/<standaloneId> 上，任何请求若携带**非空** X-Workspace-Id，就可能重演 585 的 404
 * （CP 按 workspace 相等过滤，见 SessionReadAccess.resolve）。空/缺头 = 无工作区上下文。
 *
 * 本 spec 只做取证，断言极窄：打印 JSON 供 evidence 归档；同时钉住一条底线 ——
 * 独立会话页上**不得**出现「带非空 X-Workspace-Id 的 /api/v1/sessions/<id> 读」。
 *
 * `task-621 / task-3`（2026-11-15）在本文件追加**第二族**：工作区 **A → B** 跨上下文。
 * 两族同仪器（request 钩子 + 边界索引 + 有界轮询窗），但**边界不同**：ws-less 是「上下文变空」，
 * A→B 是「上下文从 A 变成 B」—— 后者全程都有上下文，所以 601/602 那两道「按有没有上下文开关」的门
 * 在 A→B 路径上**结构上不成立**（见文件尾部长注释）。
 */
import fs from "node:fs";
import { type Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const WS_ID = "11111111-1111-4111-8111-111111111111";
const WS_SESSION = "11111111-1111-4111-8111-111111111111";
const STANDALONE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** 覆盖 AppLayout 的 10s 轮询周期，留 2s 余量。 */
const POLL_WINDOW_MS = 12_000;
const OUT = process.env.XIHE_WSLESS_HEADER_OUT ?? "H:/zeotmp/ui1-pw/wsless-header-audit.json";

type Row = {
    method: string;
    path: string;
    workspaceHeader: string;
    explicitWorkspaceParam: boolean;
};

async function stubWorkspaces(page: Page): Promise<void> {
    await page.route(
        (url) => url.pathname === "/api/v1/workspaces",
        async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([
                    { id: WS_ID, name: "Workspace 1", workspaceRole: "WS_OWNER" },
                ]),
            });
        },
    );
}

test("ws-less 上下文请求头审计（task-585 余项）", async ({ page }) => {
    const rows: Row[] = [];
    page.on("request", (request) => {
        const url = new URL(request.url());
        if (!url.pathname.startsWith("/api/")) return;
        const headers = request.headers();
        rows.push({
            method: request.method(),
            path: url.pathname + (url.search || ""),
            workspaceHeader: headers["x-workspace-id"] ?? "",
            explicitWorkspaceParam: url.searchParams.has("workspaceId"),
        });
    });

    await setupMockAuth(page);
    await stubWorkspaces(page);
    await setupMockSessions(page, {
        sessions: [{ id: WS_SESSION, title: "工作区会话" }],
        workspacelessSessions: [{ id: STANDALONE, title: "独立会话甲" }],
    });

    // 从工作区会话页进入（上下文里有工作区），再点开独立会话 —— 与 task-585 的真实路径一致。
    await page.goto("/workspace/" + WS_ID + "/chat/" + WS_SESSION);
    await expect(
        page.getByTestId("sidebar-standalone-group"),
        "standalone group visible",
    ).toBeVisible({
        timeout: LONG_TIMEOUT_MS,
    });
    const boundary = rows.length;
    await page.getByTestId("sidebar-standalone-group").getByText("独立会话甲").click();
    await expect(page.getByTestId("standalone-chat-title")).toHaveText("独立会话甲", {
        timeout: EXPECT_TIMEOUT_MS,
    });
    // 让页面把会话相关读面走完（分支/参与者/消息/monitor 等）。
    await page.waitForTimeout(1500);

    const onStandalone = rows.slice(boundary);
    const out = {
        baselineToStandaloneBoundary: boundary,
        standaloneRouteRequests: onStandalone,
        withNonEmptyWorkspaceHeader: onStandalone.filter((row) => row.workspaceHeader !== ""),
        workspaceScopedReadsOnStandalone: onStandalone.filter(
            (row) => /^\/api\/v1\/sessions\/[^/]+$/.test(row.path) && row.workspaceHeader !== "",
        ),
        sampledAt: new Date().toISOString(),
    };
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");

    // 底线判据：独立会话页上不得有「带非空工作区头的 session 详情读」（585 的 404 形态）。
    expect(out.workspaceScopedReadsOnStandalone, "独立会话页不得带工作区头读会话详情").toEqual([]);
    console.log(
        "WSLESS_AUDIT " +
            JSON.stringify({
                n: onStandalone.length,
                withHeader: out.withNonEmptyWorkspaceHeader.length,
                out: OUT,
            }),
    );
});

/**
 * task-585 余项 ②：**页面级轮询**的头注入面（唯一没被主判据咬住的一类）。
 *
 * 主判据只覆盖「会话专有读面」；而 `GET /api/v1/approvals/pending` 与 `POST /api/v1/mcp`
 * 是壳层轮询，不走会话路径 —— 它们带什么头，之前没有任何判据。
 */
test.describe("ws-less 上下文 · 页面级轮询的头", () => {
    const POLL_PATHS = ["/api/v1/approvals/pending", "/api/v1/mcp"];

    function watchPolling(page: Page): Array<{ path: string; workspaceHeader: string }> {
        const rows: Array<{ path: string; workspaceHeader: string }> = [];
        page.on("request", (request) => {
            const path = new URL(request.url()).pathname;
            if (!POLL_PATHS.includes(path)) return;
            const headers = request.headers();
            rows.push({ path, workspaceHeader: headers["x-workspace-id"] ?? "" });
        });
        return rows;
    }

    async function stubWorkspaces(page: Page): Promise<void> {
        await page.route(
            (url) => url.pathname === "/api/v1/workspaces",
            async (route) => {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify([
                        { id: WS_ID, name: "Workspace 1", workspaceRole: "WS_OWNER" },
                    ]),
                });
            },
        );
    }

    test("反向控制：工作区上下文里的轮询**必须**带工作区头", async ({ page }) => {
        const rows = watchPolling(page);
        await setupMockAuth(page);
        await stubWorkspaces(page);
        await setupMockSessions(page, { sessions: [{ id: WS_SESSION, title: "工作区会话" }] });
        // task-192 ②：会话**详情**桩必须排在 `setupMockSessions`（列表桩）**之后** ——
        // Playwright 后注册优先，先注册会被列表桩的宽匹配吃掉 ⇒ 详情 404 重复出现。
        await stubSessionDetail(page, { id: SESSION_B, workspaceId: WS_B, title: "B 会话" });
        await page.goto("/workspace/" + WS_ID + "/chat/" + WS_SESSION);
        await expect(page.getByTestId("chat-input"), "composer mounts").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });

        // 轮询是异步的：等到至少一行读数，再断言「带的是当前工作区 id」。
        await expect.poll(() => rows.length, { timeout: LONG_TIMEOUT_MS }).toBeGreaterThan(0);
        expect(
            rows.filter((row) => row.workspaceHeader !== WS_ID),
            "工作区上下文里的轮询必须带当前工作区头（否则注入逻辑已死）",
        ).toEqual([]);
    });

    /**
     * task-601 / task-602 修完转常态断言（原 `test.fixme`，红读数 `H:/zeotmp/ui1-pw/t585c.txt`）。
     *
     * <p>原红的两条：ws-less 页上的 `GET /approvals/pending` 与 `POST /api/v1/mcp` 仍带上一个工作区的 id。
     * approvals 由 task-601 修（轮询跟随路由/上下文起停 + await 后复核写回）；mcp 由 task-602 修
     * （store 侧 `closeTreeContext()` 关掉树加载面 + 监控面板按路由门控）。判据从未放宽：
     * ws-less 上下文里不许出现任何工作区 id。</p>
     */
    test("ws-less 上下文里的 /api/* 必须带空头（task-601/602）", async ({ page }) => {
        const rows = watchPolling(page);
        await setupMockAuth(page);
        await stubWorkspaces(page);
        await setupMockSessions(page, {
            sessions: [{ id: WS_SESSION, title: "工作区会话" }],
            workspacelessSessions: [{ id: STANDALONE, title: "独立会话甲" }],
        });
        await page.goto("/workspace/" + WS_ID + "/chat/" + WS_SESSION);
        await expect(page.getByTestId("sidebar-standalone-group")).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        const boundary = rows.length;
        const boundaryAt = Date.now();
        await page.getByTestId("sidebar-standalone-group").getByText("独立会话甲").click();
        await expect(page.getByTestId("standalone-chat-title")).toHaveText("独立会话甲", {
            timeout: EXPECT_TIMEOUT_MS,
        });

        // 边界之后（覆盖一个轮询周期）不得带非空工作区头。
        //
        // 修前这里写的是「先等到边界后至少一行，再断言都不带头」—— 那是个**装置假设**：
        // 它假定「总会有新请求」，而 task-601/602 修完之后边界后本就该**一条都没有**，
        // 于是前置条件永远不满足（实测：poll 到 30s 超时，Received 0）。
        // 现在改为「等满一个轮询周期（有界等待，不是固定 sleep），再断言不存在带头的行」：
        // 断言强度不变（反而更严：连「一条请求都没有」也算通过），且不依赖产品一定要发请求。
        await expect
            .poll(() => Date.now() - boundaryAt, { timeout: LONG_TIMEOUT_MS, intervals: [500] })
            .toBeGreaterThan(POLL_WINDOW_MS);
        expect(rows.slice(boundary).filter((row) => row.workspaceHeader !== "")).toEqual([]);
    });
});

/* ==========================================================================================
 * task-621 / task-3（Lead 2026-11-15 10:5x 建卡；同日裁定「先只做取证 + 变异证明，不碰产品代码」）
 * 工作区 **A → B** 跨上下文：换边界，同一套仪器。
 *
 * ── 为什么这不是 601/602 的同类项（必须先写清，否则下一个人会以为老修法已覆盖）──────────────
 * · 601 修「进入 ws-less 上下文」：`AppLayout.vue:240` 按 `route.name === "standalone-chat"` 停表 +
 *   `closeTreeContext()`；602 补 store 侧 `workspace.ts:364/862` 的 `treeContextClosed` 早退。
 *   **两道门都以「有没有树上下文」为开关。**
 * · A→B **全程都有上下文** ⇒ 路由门恒走 `openTreeContext()`（`AppLayout.vue:248`），
 *   `treeContextClosed` 永远是 false ⇒ **这两道门在 A→B 路径上不起作用**。
 * · A→B 仅有的实际门槛是 **id 比对**那两处：`stores/workspace.ts:386`（首载落盘前）与
 *   `:417`（排队重载落盘前）—— 变异证明就打这两个点 + 守卫写上下文那一处，不打门
 *   （`D-1504`：变异点必须在被测路径上）。
 *
 * ── 头与参数是两个源（本文件第一处「参数/头」专项断言）─────────────────────────────────────
 * · 头：`composables/api.ts:2498-2525` 的缺省 `X-Workspace-Id` = `readTabWorkspaceId()`
 *   （`lib/workspaceContext.ts`，**sessionStorage**，逐 tab）；
 * · 参数：`AppLayout.vue:253` 显式传 `auth.currentWorkspaceId`。
 * 两者切换时机不同 ⇒ 两种错配都要断言：**参数=B ∧ 头=A**、**头=B ∧ 参数=A**。
 *
 * ── 产品面能点出 A→B 吗（实测结论，别手滑写成 page.goto 冒充）────────────────────────────────
 * · **同 tab 没有「切工作区」点击控件**：`/workspace` 的 picker 在有 tab 上下文时会**弹回自己**
 *   （`WorkspacePicker.vue:121-133`：读到 tab 上下文 ⇒ clear + replace 回该工作区）；
 *   `workspace-switch-to-host` 是**执行模式**切换（`WorkspaceCreateDialog.vue:609-614`），不是切工作区。
 * · ⇒ 可点击的产品路径只有「**新 tab**（sessionStorage 为空）→ picker → 点 B」；
 *   同 tab 的 A→B 只能靠**深链**（`router/index.ts:619-622` 的守卫就是为这条路写的：
 *   在子组件发第一个请求**之前**把 tab 上下文写成目标工作区）。
 * ⇒ 下面三态分别覆盖：① 真实态（skip，需真栈）② 同 tab 深链边界（可执行，延迟注入放大窗口）
 *   ③ 新 tab picker 点击边界（可执行，**真正的产品点击路径**）。
 * ========================================================================================== */
const WS_A = WS_ID; // 1111…（与文件顶部同一份）
const WS_B = "22222222-2222-4222-8222-222222222222";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const AB_OUT = process.env.XIHE_AB_OUT ?? "H:/zeotmp/ui1-pw/workspace-a-to-b.json";
/** 卡面仪器：给 `/api/v1/mcp` 加 5 s 延迟，把窗口放大到能被 request 钩子稳定抓到。 */
const AB_DELAY_MS = 5000;
const AB_PROBE_PATH = "/api/v1/__ab_instrument_probe";

type AbRow = {
    method: string;
    path: string;
    workspaceHeader: string;
    workspaceParam: string | null;
    atMs: number;
};

/** 记录**所有** `/api/*` 请求的「头 + 显式 workspaceId 参数」。与第一族同口径，但多记参数值。 */
function recordAb(page: Page): AbRow[] {
    const rows: AbRow[] = [];
    const startedAt = Date.now();
    page.on("request", (request) => {
        const url = new URL(request.url());
        if (!url.pathname.startsWith("/api/")) return;
        rows.push({
            method: request.method(),
            path: url.pathname + (url.search || ""),
            workspaceHeader: request.headers()["x-workspace-id"] ?? "",
            workspaceParam: url.searchParams.get("workspaceId"),
            atMs: Date.now() - startedAt,
        });
    });
    return rows;
}

/** A / B 两个工作区的详情桩（`GET /api/v1/workspaces/@{id}`）——深链进入 B 时子组件要读它。 */
async function stubWorkspaceDetail(page: Page, id: string, name: string): Promise<void> {
    await page.route(
        (url) => url.pathname === "/api/v1/workspaces/" + id,
        async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    id,
                    name,
                    workspaceRole: "WS_OWNER",
                    roots: [{ id: "root-" + id.slice(0, 4), name: "root", path: "/" }],
                }),
            });
        },
    );
}

/**
 * 探针**自身的注入端点**（不是产品路由）：页面内 `fetch` 用它自证「相机看得见边界后的 A 头」。
 *
 * <p>mock server 没有这条路由 ⇒ 走 Vite proxy 得到 `404`，浏览器侧失败守卫会判红，**把 A 头断言
 * 的结论盖住**（task-192 ①：三条红点全被这条 404 的重复条目淹没）。它属于仪器资产，补它不违反
 * 「不补产品桩把真缺陷盖绿」—— 它既不模拟产品行为，也不影响产品请求集合。</p>
 */
async function stubInstrumentProbe(page: Page): Promise<void> {
    await page.route("**/api/v1/__ab_instrument_probe", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true }),
        }),
    );
}

/**
 * 会话**详情**桩（`GET /api/v1/sessions/{id}`）。
 *
 * <p>`setupMockSessions` 只桩列表；深链 `/workspace/B/chat/<SESSION_B>` 时子组件要读详情，
 * 未桩 ⇒ 默认夹具 404（`helpers/workspace-fixture.ts` 的「静默 404」同族）。同一条 URL 重复 404
 * 会污染失败守卫的输出（task-192 ② 的**夹具缺口**，补桩）。</p>
 */
async function stubSessionDetail(
    page: Page,
    input: { id: string; workspaceId: string; title: string },
): Promise<void> {
    const { id: sessionId, workspaceId, title } = input;
    await page.route(
        (url) => url.pathname === "/api/v1/sessions/" + sessionId,
        (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    id: sessionId,
                    title,
                    workspaceId,
                    createdAt: "2026-11-15T00:00:00.000Z",
                    updatedAt: "2026-11-15T00:00:00.000Z",
                    modelProvider: null,
                    modelName: null,
                    archived: false,
                    agentPrincipalId: null,
                }),
            }),
    );
}
test.describe("工作区 A → B 跨上下文（task-621 / task-3）", () => {
    /**
     * ① **真实态**（卡面判据 1 的前半）：mock 车道不可达 ⇒ 显式 skip 并写明原因。
     * 不许静默跳过、不许写成通过 —— 真栈窗口到位后**删掉第一行 test.skip 即可恢复执行**。
     */
    test("A→B 真实态：边界后带 A 的 workspaceId 头/参数 = 0", async ({ page }) => {
        test.skip(
            true,
            "mock 车道不可达（需真栈窗口）：真实 A→B 依赖 CP 按 workspace 相等过滤的 404/越权行为，mock 无真 CP",
        );
        const rows = recordAb(page);
        await setupMockAuth(page);
        await stubWorkspaceDetail(page, WS_A, "Workspace A");
        await stubWorkspaceDetail(page, WS_B, "Workspace B");
        await setupMockSessions(page, { sessions: [{ id: WS_SESSION, title: "工作区会话" }] });
        // task-192 ②：会话**详情**桩必须排在 `setupMockSessions`（列表桩）**之后** ——
        // Playwright 后注册优先，先注册会被列表桩的宽匹配吃掉 ⇒ 详情 404 重复出现。
        await stubSessionDetail(page, { id: SESSION_B, workspaceId: WS_B, title: "B 会话" });
        // task-192 ①：探针端点桩**放在最后一次注册**（Playwright 后注册优先）—— helpers 里存在
        // 兜底/兜底 404 的宽匹配路由，早注册会被它吃掉 ⇒ 页面内自证 fetch 拿 404、失败守卫变红。
        await stubInstrumentProbe(page);
        await page.goto("/workspace/" + WS_A + "/chat/" + WS_SESSION);
        await expect(page.getByTestId("chat-input"), "A 的 composer 挂载").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        const boundary = rows.length;
        // 真栈窗口下这里换成产品路径（点进 B）；mock 里没有该控件，故本态保持 skip。
        await page.goto("/workspace/" + WS_B + "/chat/" + SESSION_B);
        await expect.poll(() => page.url(), { timeout: LONG_TIMEOUT_MS }).toContain(WS_B);
        const product = rows.slice(boundary);
        expect(
            product.filter((row) => row.workspaceHeader === WS_A),
            "边界后带 A 头的请求",
        ).toEqual([]);
        expect(
            product.filter((row) => row.workspaceParam === WS_A),
            "边界后带 A 参数的请求",
        ).toEqual([]);
    });

    /**
     * ② **同 tab 深链边界**（可执行）：这里的 `page.goto` 是**产品支持的深链路径**，不是冒充点击 ——
     * 产品面同 tab 换工作区只有这一条路，守卫 `router/index.ts:619-622` 就是为它写的。
     * 延迟注入 `/api/v1/mcp` 5 s 把「A 的树请求还在途」这个窗口放大。
     * **注意本态的能力边界（D-1516）**：整页导航会卸载页面 ⇒ A 的在途请求被浏览器丢弃，
     * 所以「A 的在途请求在边界后落地」这类泄漏**在深链态里根本不存在**（拿它当真证据就是假绿）。
     * 本态只验**守卫写入时序**（`router/index.ts:619-622` 在子组件首个请求前写 tab 上下文）——
     * 不是因为整页导航不经守卫（**经**，初始导航同样被拦截），而是因为它没有在途窗口。
     * 真正的在途/错配窗口在 P1 点击态（同文件下方 `P1：别组会话`）。
     */
    test("A→B 深链边界（延迟注入态）：边界后不得出现 A 的头，也不得出现「参数=B ∧ 头=A」", async ({
        page,
    }) => {
        const rows = recordAb(page);
        await stubInstrumentProbe(page);
        await setupMockAuth(page, { workspaceEvents: "off" });
        await stubWorkspaceDetail(page, WS_A, "Workspace A");
        await stubWorkspaceDetail(page, WS_B, "Workspace B");
        // 仪器：/api/v1/mcp 延迟 5 s（卡面指定）。后注册的 route 赢过 helpers 的桩。
        // ⚠️ task-192 ②：原来这里 `route.continue()` ⇒ 请求穿到 Vite proxy，而 mock 车道**没有**
        // `/api/v1/mcp` 后端 ⇒ 每次都是 `502`。它不是产品行为，是「夹具缺口」：延迟本身才是仪器的
        // 目的（把在途窗口放大），响应体给一个合法的 JSON-RPC 200 即可，不必让 proxy 插手。
        await page.route("**/api/v1/mcp", async (route) => {
            await new Promise((resolve) => setTimeout(resolve, AB_DELAY_MS));
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }),
            });
        });
        await setupMockSessions(page, { sessions: [{ id: WS_SESSION, title: "工作区会话" }] });
        // task-192 ②：会话**详情**桩必须排在 `setupMockSessions`（列表桩）**之后** ——
        // Playwright 后注册优先，先注册会被列表桩的宽匹配吃掉 ⇒ 详情 404 重复出现。
        await stubSessionDetail(page, { id: SESSION_B, workspaceId: WS_B, title: "B 会话" });

        // task-192 ①：探针端点桩**放在最后一次注册**（Playwright 后注册优先）—— helpers 里存在
        // 兜底/兜底 404 的宽匹配路由，早注册会被它吃掉 ⇒ 页面内自证 fetch 拿 404、失败守卫变红。
        await stubInstrumentProbe(page);
        await page.goto("/workspace/" + WS_A + "/chat/" + WS_SESSION);
        await expect(page.getByTestId("chat-input"), "A 的 composer 挂载").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        const boundary = rows.length;
        const boundaryAt = Date.now();

        // 深链边界：同一 tab 切到 B（守卫先写 tab 上下文 = B，再挂视图）。
        await page.goto("/workspace/" + WS_B + "/chat/" + SESSION_B);
        await expect.poll(() => page.url(), { timeout: LONG_TIMEOUT_MS }).toContain(WS_B);

        // 等满一个轮询周期（有界等待，不是固定 sleep）：审批轮询一跳 10 s，覆盖到才能说「这一屏没有」。
        await expect
            .poll(() => Date.now() - boundaryAt, { timeout: LONG_TIMEOUT_MS, intervals: [500] })
            .toBeGreaterThan(POLL_WINDOW_MS);

        /* 仪器自证（Lead 裁定①）：在**边界之后**故意发一条带 A 头的请求 —— 相机必须看得见它。
         * 看不见 ⇒ 下面「0 条」不成立。这是「仪器自证」，与「变异证明」是两件事。 */
        const probeAt = rows.length;
        await page.evaluate(
            (probe) => {
                void fetch(probe.path, { headers: { "X-Workspace-Id": probe.header } }).catch(
                    () => {},
                );
            },
            { path: AB_PROBE_PATH, header: WS_A },
        );
        await expect
            .poll(
                () =>
                    rows.slice(probeAt).filter((row) => row.path.startsWith(AB_PROBE_PATH)).length,
                { timeout: EXPECT_TIMEOUT_MS },
            )
            .toBe(1);
        const selfProof = rows.slice(probeAt).filter((row) => row.path.startsWith(AB_PROBE_PATH));
        expect(selfProof[0]?.workspaceHeader, "仪器自证：相机必须看得见边界后的 A 头").toBe(WS_A);

        const product = rows.slice(boundary).filter((row) => !row.path.startsWith(AB_PROBE_PATH));
        const withAHead = product.filter((row) => row.workspaceHeader === WS_A);
        const paramBHeadA = product.filter(
            (row) => row.workspaceParam === WS_B && row.workspaceHeader === WS_A,
        );
        const headBParamA = product.filter(
            (row) => row.workspaceHeader === WS_B && row.workspaceParam === WS_A,
        );

        const out = {
            card: "task-621 / task-3",
            case: "deep-link",
            boundaryIndex: boundary,
            boundaryTotalRows: rows.length,
            delayMs: AB_DELAY_MS,
            selfProof,
            postBoundaryRows: product.length,
            withAHead,
            paramBHeadA,
            headBParamA,
            sample: product.slice(0, 20),
            sampledAt: new Date().toISOString(),
        };
        fs.writeFileSync(AB_OUT, JSON.stringify(out, null, 2), "utf8");

        expect(withAHead, "边界后带 A 头的请求（源 B/源 C 泄漏）").toEqual([]);
        expect(paramBHeadA, "参数=B ∧ 头=A（头源与参数源错配）").toEqual([]);
        expect(headBParamA, "头=B ∧ 参数=A（反向错配）").toEqual([]);
        console.log(
            "AB_AUDIT " +
                JSON.stringify({
                    boundary,
                    post: product.length,
                    withAHead: withAHead.length,
                    out: AB_OUT,
                }),
        );
    });

    /**
     * ③ **新 tab 经 picker 点进 B**（可执行，**真正的产品点击路径**）：
     * 新 tab 的 sessionStorage 为空 ⇒ `/workspace` 渲染 picker（`WorkspacePicker.vue:144`），
     * 点 `workspace-picker-item-<B>` ⇒ `openWorkspace()` 写 tab 上下文并 `router.push` 到 B
     * （`WorkspacePicker.vue:73-86`）。断言：边界后带 A 头/参数的请求 = 0，且**确实有带 B 头的请求**
     * （否则「0 条」可能只是「一条请求都没发」的假绿）。
     */
    test("新 tab 经 picker 点进 B（产品点击路径）：带 A 的请求 = 0，且带 B 的请求 > 0", async ({
        page,
    }) => {
        // 用默认 fixture 的 page；不另建 context：helpers 的 seed 面挂在 fixture 上，自建
        // context 会把 seed 落空。
        // ⚠️ 但「sessionStorage 天然为空」这个前提**自 PLAN-0560 起已不成立**：`setupMockAuth`
        // 会按 tab 上下文播种（`xihe-workspace`），于是 `/workspace` 直接进工作区视图、
        // picker 永不渲染（2026-11-15 实测：30s 内 `workspace-picker` 找不到）。
        // 所以这里显式清掉两种存储 —— 与 `workspace-management.spec.ts` 的空 picker 用例同一手法。
        const rows = recordAb(page);
        // task-192 ①：探针自身端点必须先桩，否则 404 会进失败守卫、盖住 A 头结论。
        await stubInstrumentProbe(page);
        await setupMockAuth(page, {
            workspaceEvents: "off",
            workspaceList: [
                { id: WS_A, name: "Workspace 1", workspaceRole: "WS_OWNER" },
                { id: WS_B, name: "Workspace B", workspaceRole: "WS_OWNER" },
            ],
        });
        await stubWorkspaceDetail(page, WS_A, "Workspace 1");
        await stubWorkspaceDetail(page, WS_B, "Workspace B");
        await setupMockSessions(page, { sessions: [] });
        await stubSessionDetail(page, { id: SESSION_B, workspaceId: WS_B, title: "B 会话" });
        // 清存储必须**排在 helpers 的 addInitScript 之后**：Playwright 按注册顺序执行 init script，
        // 先清后播种等于没清（2026-11-15 实测：先清时 picker 依然 30s 找不到）。
        await page.addInitScript(() => {
            localStorage.removeItem("xihe-workspace");
            sessionStorage.removeItem("xihe-workspace");
        });

        // task-192 ①：探针端点桩**放在最后一次注册**（Playwright 后注册优先）—— helpers 里存在
        // 兜底/兜底 404 的宽匹配路由，早注册会被它吃掉 ⇒ 页面内自证 fetch 拿 404、失败守卫变红。
        await stubInstrumentProbe(page);
        await page.goto("/workspace");
        await expect(
            page.getByTestId("workspace-picker"),
            "picker 渲染（新 tab 无 tab 上下文）",
        ).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        const boundary = rows.length;
        const boundaryAt = Date.now();
        await page.getByTestId("workspace-picker-item-" + WS_B).click();
        await expect.poll(() => page.url(), { timeout: LONG_TIMEOUT_MS }).toContain(WS_B);
        await expect
            .poll(() => Date.now() - boundaryAt, { timeout: LONG_TIMEOUT_MS, intervals: [500] })
            .toBeGreaterThan(POLL_WINDOW_MS);

        const product = rows.slice(boundary);
        const withA = product.filter(
            (row) => row.workspaceHeader === WS_A || row.workspaceParam === WS_A,
        );
        const withB = product.filter((row) => row.workspaceHeader === WS_B);

        const out = {
            card: "task-621 / task-3",
            case: "picker-new-tab",
            boundaryIndex: boundary,
            selfProof: {
                withBHeadCount: withB.length,
                note: "本态不需要延迟注入：B 的首页请求本身就是正面控制",
            },
            postBoundaryRows: product.length,
            withA,
            sample: product.slice(0, 20),
            sampledAt: new Date().toISOString(),
        };
        fs.writeFileSync(
            AB_OUT.replace(/\.json$/, "-picker.json"),
            JSON.stringify(out, null, 2),
            "utf8",
        );

        expect(product.length, "边界后至少要有一条请求（否则「0 条」是假绿）").toBeGreaterThan(0);
        expect(withB.length, "边界后必须出现带 B 头的请求（正面控制）").toBeGreaterThan(0);
        expect(withA, "picker 进 B 之后不得再出现 A 的头/参数").toEqual([]);
    });
});

/* ── 变异证明（不是本文件的一部分，按顺序人工执行；每点单独一轮、各自恢复并核 sha256）──────────
 * 目标：证明上面对「边界后带 A 头/参数」的断言**真的咬得住**（Lead 裁定②：变异点必须落在被测路径上）。
 * 变异点（都在 A→B 的实际门槛上，**不在** ws-less 的那两道门上）：
 *   M1  `stores/workspace.ts:386`  首载落盘前的陈旧丢弃 ⇒ 注释掉该行
 *   M2  `stores/workspace.ts:417`  排队重载落盘前的陈旧丢弃 ⇒ 注释掉该行
 *   M3  `router/index.ts:619-622`  守卫里的 `writeTabWorkspaceId(routeWorkspaceId)` ⇒ 注释掉（头会停在 A）
 * 判据（按 `D-1516` 定矩阵，别混跑）：
 *   M1 / M2 ⇒ 在 **④ P1 点击态**上跑（SPA 内切换，A 的树请求才可能真的在途）—— 必须红。
 *   M3       ⇒ 在 **② 深链态**上跑（整页导航时守卫是 tab 上下文的**唯一**写入者；
 *               `sessionStorage` 跨整页导航存活 ⇒ 移除后头停在 A）—— 必须红。
 *   **③ picker 不承担变异证明**：`WorkspacePicker.vue:77` 在 push 前自己写了上下文，
 *   守卫不是唯一写入者 ⇒ 那里移除 M3「仍绿」是**正确的绿**。
 * **「变异后仍绿」有两种含义**（`D-1516`）：①该点不在被测路径上；②**该点不是该路径的唯一写入者**。
 * 前者是证据不足，后者是正确结论 —— 不要为了凑红去换点，也不要把它误报成「判据没咬住」。
 * 恢复后必须绿且 `sha256` 与变异前一致；每点单独一轮、各自恢复，不许一次全改。
 * ────────────────────────────────────────────────────────────────────────────────────── */

/* ==========================================================================================
 * task-621 / task-3 —— **P1 主用例**：同 tab、无重载的 A→B（侧栏「别组会话」点击）
 *
 * 为什么它必须是主用例（`D-1516`）：深链整页导航会把 A 的在途请求随页面卸载丢掉，
 * 于是「在途落地」永绿；而 P1 是 **SPA 内切换**，窗口真实存在，且**确定性存在**：
 *   `WorkspaceSessionGroups.vue:205-213 openForeignSession()` 的执行顺序是
 *     `writeTabWorkspace(B)` → `router.push(workspaceChatPath(B, sessionId))`
 *   ⇒ 从写上下文那一刻起，**新发请求带 B 头**，而路由仍是 A、`auth.workspace` 仍是 A、
 *     `loadTree()` 入口捕获的 `currentWorkspaceId`（`stores/workspace.ts:347`）仍是 A
 *   ⇒ 「**头=B ∧ 路由/参数=A**」是每次切换都必然出现的一小段，不是概率竞态。
 *
 * 点击链（`[源码]`）：`sidebar-workspace-group-toggle-<B>`（`WorkspaceSessionGroups.vue:324`
 * → `toggleGroup`）⇒ `sidebar-workspace-group-body-<B>`（:357）⇒ `SessionItem`
 * `data-testid="session-item"` 点击（`SessionItem.vue:50/98/106` emit select）⇒
 * `SessionList.vue:85-96 handleSelect`（`isForeignGroup` ⇒ emit `select-foreign-session`）⇒
 * `WorkspaceSessionGroups.vue:390` ⇒ `openForeignSession`。
 *
 * **P2（A 内新建工作区）为何不加用例**：`WorkspaceCreateDialog.vue:359-362` 是
 * `auth.workspace = ws; writeTabWorkspace(ws)` —— **参数与上下文同时写 B**，不存在
 * 「头=B ∧ 参数=A」的时间窗；随后的 `WorkspaceView.vue:128-130 router.push` 只是导航。
 * 风险形态与 P1 同族但窗口不成立 ⇒ 按「不加永远绿的用例」处理，只在此记录理由。
 *
 * ── 「头=B ∧ 路由/参数=A」这条主断言的**空集风险**与处置（`D-1500`：否定的结论只有一个空集）──
 * 导航落地后 UI 全在 B 面，边界后**可能本来就没有 A 路径请求** ⇒ 该断言会空集绿。处置 = **方案 (a) 补对照**：
 * 断言「边界**前**带 A 头的请求 > 0」且「边界前路径含 A / `workspaceId=A` 的请求 > 0」，
 * 先证明 A 面真的在发请求、且 A 路径形态真的存在，再断言边界后 = 0。
 * 同时按方案 (b) 定**证据等级**：主证据 = ①带 A 头 = 0 + ③正面控制（带 B 头 > 0）；
 * 本条（头=B ∧ A 路径）是**防回归保险**，不单独承担主证据。两个都写，不二选一。
 * ========================================================================================== */
test.describe("工作区 A → B 同 tab 点击切换（P1：别组会话）（task-621 / task-3）", () => {
    test("P1 点击切换：边界后带 A 头 = 0，且不得出现「头=B ∧ 路由/参数=A」", async ({ page }) => {
        const rows = recordAb(page);
        // task-192 ①：探针自身端点必须先桩，否则 404 会进失败守卫、盖住 A 头结论。
        await stubInstrumentProbe(page);
        await setupMockAuth(page, {
            workspaceEvents: "off",
            workspaceList: [
                { id: WS_A, name: "Workspace 1", workspaceRole: "WS_OWNER" },
                { id: WS_B, name: "Workspace B", workspaceRole: "WS_OWNER" },
            ],
        });
        await stubWorkspaceDetail(page, WS_A, "Workspace 1");
        await stubWorkspaceDetail(page, WS_B, "Workspace B");
        // 别组的会话列表来自 getSessions(B) ⇒ `GET /api/v1/sessions` + **显式 X-Workspace-Id: B**
        // （`composables/api.ts:3254-3260`）；`setupMockSessions` 已桩该路径，两组拿到同一份列表即够用。
        await setupMockSessions(page, {
            sessions: [{ id: WS_SESSION, title: "工作区会话" }],
        });

        // task-192 ①：探针端点桩**放在最后一次注册**（Playwright 后注册优先）—— helpers 里存在
        // 兜底/兜底 404 的宽匹配路由，早注册会被它吃掉 ⇒ 页面内自证 fetch 拿 404、失败守卫变红。
        await stubInstrumentProbe(page);
        await page.goto("/workspace/" + WS_A + "/chat/" + WS_SESSION);
        await expect(page.getByTestId("chat-input"), "A 的 composer 挂载").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });

        // 点前先展开 B 组（这是产品动作本身，不是准备步骤的作弊：分组默认折叠，用户也要点这一下）。
        const toggleB = page.getByTestId("sidebar-workspace-group-toggle-" + WS_B);
        await expect(toggleB, "左栏出现 B 组").toBeVisible({ timeout: LONG_TIMEOUT_MS });

        /* 边界**前**对照（D-1500 空集守卫）：证明 A 面确实在发请求、且「A 路径」这条形态真实存在。
         * 少了这两条，「边界后 0 条」只是「本来就没有」。 */
        const preAHeadCount = rows.filter((row) => row.workspaceHeader === WS_A).length;
        const preAPathRows = rows.filter(
            (row) => row.workspaceParam === WS_A || row.path.includes(WS_A),
        );
        const preAPathCount = preAPathRows.length;
        /* 对照组自身也要能过期告警：若这 N 条**全都来自同一条被轮询的端点**，
         * 那「A 路径形态真实存在」只覆盖了一个形态，将来那条端点改路径 ⇒ 对照组静默失效。
         * 所以记下构成（前 3 条 method+path + 去重路径数），只记录不断言。 */
        const preAPathSamples = preAPathRows.slice(0, 3).map((row) => row.method + " " + row.path);
        const preAPathDistinct = new Set(preAPathRows.map((row) => row.path.split("?")[0])).size;

        const boundary = rows.length;
        const boundaryAt = Date.now();
        await toggleB.click();
        const bodyB = page.getByTestId("sidebar-workspace-group-body-" + WS_B);
        await expect(bodyB, "B 组展开").toBeVisible({ timeout: LONG_TIMEOUT_MS });
        const foreignItem = bodyB.getByTestId("session-item").first();
        await expect(foreignItem, "B 组里有可点会话").toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await foreignItem.click();

        await expect.poll(() => page.url(), { timeout: LONG_TIMEOUT_MS }).toContain(WS_B);
        // 有界等一个轮询周期：覆盖 AppLayout 的 10 s 一跳（POLL_WINDOW_MS = 12 s）。
        await expect
            .poll(() => Date.now() - boundaryAt, { timeout: LONG_TIMEOUT_MS, intervals: [500] })
            .toBeGreaterThan(POLL_WINDOW_MS);

        /* 仪器自证（边界后）：故意发一条带 A 头的请求，相机必须看见它。
         * 看不见 ⇒ 下面的「0 条」不成立。 */
        const probeAt = rows.length;
        await page.evaluate(
            (probe) => {
                void fetch(probe.path, { headers: { "X-Workspace-Id": probe.header } }).catch(
                    () => {},
                );
            },
            { path: AB_PROBE_PATH, header: WS_A },
        );
        await expect
            .poll(
                () =>
                    rows.slice(probeAt).filter((row) => row.path.startsWith(AB_PROBE_PATH)).length,
                { timeout: EXPECT_TIMEOUT_MS },
            )
            .toBe(1);
        const selfProof = rows.slice(probeAt).filter((row) => row.path.startsWith(AB_PROBE_PATH));
        expect(selfProof[0]?.workspaceHeader, "仪器自证：相机必须看得见边界后的 A 头").toBe(WS_A);

        const product = rows.slice(boundary).filter((row) => !row.path.startsWith(AB_PROBE_PATH));
        const withAHead = product.filter((row) => row.workspaceHeader === WS_A);
        // 「头=B ∧ 路由/参数=A」：路径里带 A，或显式 workspaceId=A 参数，而头已经换成 B。
        const headBParamA = product.filter(
            (row) =>
                row.workspaceHeader === WS_B &&
                (row.workspaceParam === WS_A || row.path.includes(WS_A)),
        );
        const withBHead = product.filter((row) => row.workspaceHeader === WS_B);

        const out = {
            card: "task-621 / task-3",
            case: "p1-foreign-session-click",
            boundaryIndex: boundary,
            boundaryTotalRows: rows.length,
            preBoundary: {
                aHead: preAHeadCount,
                aPath: preAPathCount,
                aPathSamples: preAPathSamples,
                aPathDistinctPaths: preAPathDistinct,
                note: "aPathDistinctPaths === 1 ⇒ 对照组只覆盖一个端点形态，端点改路径时会静默失效",
            },
            selfProof,
            postBoundaryRows: product.length,
            withAHead,
            headBParamA,
            withBHeadCount: withBHead.length,
            sample: product.slice(0, 20),
            sampledAt: new Date().toISOString(),
        };
        fs.writeFileSync(
            AB_OUT.replace(/\.json$/, "-p1-click.json"),
            JSON.stringify(out, null, 2),
            "utf8",
        );

        // 对照组（边界前）：A 面必须真的在发请求，否则下面的「0 条」是空集绿。
        expect(preAHeadCount, "对照：边界前必须有带 A 头的请求（A 面确实在跑）").toBeGreaterThan(0);
        expect(
            preAPathCount,
            "对照：边界前必须有 A 路径/参数的请求（该形态真实存在）",
        ).toBeGreaterThan(0);
        // 正面控制：边界后必须真的有请求、且真的带 B 头 —— 否则「0 条」是「一条都没发」的假绿。
        expect(product.length, "边界后至少一条请求").toBeGreaterThan(0);
        expect(withBHead.length, "边界后必须出现带 B 头的请求（正面控制）").toBeGreaterThan(0);
        // 主证据两条（下面第一条 + 上面的正面控制）
        expect(withAHead, "边界后带 A 头的请求").toEqual([]);
        // 防回归保险（不单独承担主证据）：写上下文早于导航的确定性窗口
        expect(headBParamA, "头=B ∧ 路由/参数=A（写上下文早于导航的确定性窗口）").toEqual([]);
        console.log(
            "AB_AUDIT_P1 " +
                JSON.stringify({
                    boundary,
                    preBoundary: {
                        aHead: preAHeadCount,
                        aPath: preAPathCount,
                        aPathDistinctPaths: preAPathDistinct,
                        aPathSamples: preAPathSamples,
                    },
                    post: product.length,
                    withAHead: withAHead.length,
                    headBParamA: headBParamA.length,
                    out: AB_OUT.replace(/\.json$/, "-p1-click.json"),
                }),
        );
    });
});
