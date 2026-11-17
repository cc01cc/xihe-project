/**
 * task-189 对接（ui-40）：工作区分组侧栏的按组取数桩 —— 从 sidebar-workspace-groups.spec.ts
 * 的局部 helper（stubTwoWorkspaces）提取成导出（G4 单一实现：原 spec 已改 import 本文件）。
 *
 * 能力：左栏「工作区分组」要渲染 session-item，单靠 setupMockSessions 的默认桩不够——
 * 分组列表按 x-workspace-id 头扇出 GET /api/v1/sessions（pathname 精确），每个 workspace
 * 只拿自己那份（「按组取数」的产品替身，task-352 / D-1206）。
 *
 * 注册顺序：必须在 `setupMockAuth(page)` / `setupMockSessions(page, …)` **之后**
 * 调用（Playwright 后注册优先，盖过夹具默认的 GET /sessions）。
 *
 * wire 形状复用 `auth.ts#mockSessionWire`（同一条投影，不自造第二份）。
 */
import type { Page } from "@playwright/test";
import { mockSessionWire, type MockSessionRecord } from "./auth";

export interface MockWorkspaceListRecord {
    id: string;
    name: string;
    ownerId?: string;
    workspaceRole?: string;
}

/** `GET /api/v1/workspaces`（pathname 精确）→ 工作区列表（左栏分组头数据源）。 */
export async function stubWorkspaceList(
    page: Page,
    workspaces: MockWorkspaceListRecord[],
): Promise<void> {
    await page.route(
        (url) => url.pathname === "/api/v1/workspaces",
        async (route) => {
            if (route.request().method() !== "GET") return route.fallback();
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(
                    workspaces.map((w) => ({
                        id: w.id,
                        name: w.name,
                        ownerId: w.ownerId ?? "user-1",
                        workspaceRole: w.workspaceRole ?? "OWNER",
                    })),
                ),
            });
        },
    );
}

/**
 * `GET /api/v1/sessions`（pathname 精确）按 `x-workspace-id` 头扇出：
 * 每个 workspace 只拿到 `sessions[]` 里 `workspaceId` 匹配自己那部分。
 *
 * `?scope=workspaceless`（独立会话探针，api.ts:3271）与按组读同路径只差查询参数——
 * 默认回空，避免同一会话同时落在「工作区组内」与「独立会话组」造成 strict 冲突
 * （sidebar-workspace-groups.spec 注释的 2026-11-15 实测坑）；要造独立会话就传 `options.workspaceless`。
 */
export async function stubGroupedWorkspaceSessions(
    page: Page,
    sessions: MockSessionRecord[],
    options: { workspaceless?: MockSessionRecord[] } = {},
): Promise<void> {
    await page.route(
        (url) => url.pathname === "/api/v1/sessions",
        async (route) => {
            if (route.request().method() !== "GET") return route.fallback();
            const url = new URL(route.request().url());
            if (url.searchParams.get("scope") === "workspaceless") {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        sessions: (options.workspaceless ?? []).map((s) =>
                            mockSessionWire(s, null),
                        ),
                    }),
                });
                return;
            }
            const workspaceId = route.request().headers()["x-workspace-id"] ?? null;
            const scoped = sessions.filter((s) => (s.workspaceId ?? null) === workspaceId);
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    sessions: scoped.map((s) => mockSessionWire(s, s.workspaceId ?? workspaceId)),
                }),
            });
        },
    );
}
