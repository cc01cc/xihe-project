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
