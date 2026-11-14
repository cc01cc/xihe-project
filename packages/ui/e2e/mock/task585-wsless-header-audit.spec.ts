/**
 * task-585 只读余项仪器：**ws-less 上下文里，每个请求带的 X-Workspace-Id 是什么**。
 *
 * 判据不是「看起来没问题」，而是四列读数（页面 / 调用点 / 是否带旧头 / 依据）里的第三列：
 * 在 /chat/<standaloneId> 上，任何请求若携带**非空** X-Workspace-Id，就可能重演 585 的 404
 * （CP 按 workspace 相等过滤，见 SessionReadAccess.resolve）。空/缺头 = 无工作区上下文。
 *
 * 本 spec 只做取证，断言极窄：打印 JSON 供 evidence 归档；同时钉住一条底线 ——
 * 独立会话页上**不得**出现「带非空 X-Workspace-Id 的 /api/v1/sessions/<id> 读」。
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
