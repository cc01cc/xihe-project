// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";
import { ensureWorkspace } from "./helpers/workspace";

/**
 * PLAN-0752 收尾 T5.2（真栈部分，task-184）：
 *
 * - V10：`/settings/*`（实例/用户层）**不渲染** AppLayout 的工作区 <Sidebar>。
 *   verify.md:37 写的 testid 是 `workspace-sidebar`，但组件真实 testid 是 `sidebar`
 *   （src/components/sidebar/Sidebar.vue:183）——本 spec 按真实 testid 断言。
 * - ~~工作区域段深链（T2.5 的真栈取样）：`/workspace/:id/settings/:domain` 直达 + 域段 404。~~
 *   **已随 task-253（2026-11-10，Q-1110-45）删除**：工作区块配置层整体退役，域段深链 / 域页 /
 *   域 404 都不存在了。删除项在原处留了 (a) 标注；幸存的判据见下方 V10 与 V12 用例。
 * - V12 真栈取样：375×812 抽屉可开合 + 无横向滚动；截图留档，比较判定留 Linux 轮
 *   （expectPlatformScreenshot 在非 Linux 是空操作，helpers/visual.ts:16）。
 *
 * 依赖：`scripts/e2e-host.mjs`（或 `mise run dev:host`）提供的真实 CP；mock 车道另有
 * `e2e/mock/plan-0752-settings-ia.spec.ts` 覆盖同一判据的静态面。
 */
const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const OUT_DIR = path.resolve(process.cwd(), "../../.local/evidence/plan-0752-closeout");
const V12_DIR = path.join(OUT_DIR, "v12-real");

type Auth = { accessToken: string; workspaceId: string };

async function register(request: APIRequestContext): Promise<Auth> {
    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
    const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: {
            email: `settings-ia-real-${Date.now()}@test.local`,
            password,
            name: "Settings IA Real",
        },
    });
    expect(response.status(), await response.text()).toBe(201);
    const body = (await response.json()) as { accessToken: string };
    const workspaceId = await ensureWorkspace(request, body.accessToken);
    return { accessToken: body.accessToken, workspaceId };
}

async function installAuth(page: Page, auth: Auth): Promise<void> {
    await page.addInitScript(
        ({ token, workspaceId }) => {
            localStorage.setItem("xihe-token", token);
            localStorage.setItem("xihe-user", JSON.stringify({ workspaceId }));
            localStorage.setItem(
                "xihe-workspace",
                JSON.stringify({ id: workspaceId, name: "Default Workspace" }),
            );
        },
        { token: auth.accessToken, workspaceId: auth.workspaceId },
    );
}

test.describe.configure({ retries: 0 });

test("@host PLAN-0752 V10 settings pages render without the workspace sidebar", async ({
    page,
    request,
}) => {
    const auth = await register(request);
    await installAuth(page, auth);
    for (const url of ["/settings/user/rag", "/settings/user/llm-provider"]) {
        await page.goto(url);
        await expect(page.getByTestId("settings-layer-header")).toBeVisible();
        await expect(page.getByTestId("settings-layer-title")).toBeVisible();
        // V10 判据本体：/settings/* 壳里 0 份工作区 <Sidebar>。
        await expect(page.getByTestId("sidebar")).toHaveCount(0);
        // 设置区左栏在（层进 URL 的导航没有丢）。
        await expect(page.getByTestId("settings-sidebar")).toBeVisible();
    }
});

// (a) 删 —— 「@host 工作区域段深链渲染在工作区 tab 壳内」：task-253 已删除
// `/workspace/:id/settings/:domain` 路由、单域页（ws-settings-domain-page/-title）与
// `settings-not-found` 域 404 面（工作区块配置层整体退役，Q-1110-45 裁定）。
// 断言对象不存在且不会回来，故整条删除；工作区设置页的存活面由 mock 车道的
// `legacy ?tab= form still renders every surviving tab container` 覆盖。

test("@host PLAN-0752 V12 mobile 375x812 drawer and horizontal scroll sampling", async ({
    page,
    request,
}) => {
    mkdirSync(V12_DIR, { recursive: true });
    await page.setViewportSize({ width: 375, height: 812 });
    const auth = await register(request);
    await installAuth(page, auth);

    const records: Record<string, unknown> = {};
    const overflowPx = async (): Promise<number> =>
        page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
    const record = (slot: string, payload: Record<string, unknown>): void => {
        records[slot] = { state: "value", ...payload };
    };
    const shoot = async (name: string): Promise<void> => {
        try {
            await page.screenshot({ path: path.join(V12_DIR, name), fullPage: false });
            record(name, { captured: true });
        } catch (e) {
            records[name] = { state: "unreadable", reason: String(e).slice(0, 300) };
        }
    };

    await page.goto("/settings/user/rag");
    await expect(page.getByTestId("settings-layer-header")).toBeVisible();
    record("desktopAsideHiddenAtMobile", {
        visible: await page.locator("aside").first().isVisible(),
    });
    record("horizontalOverflowDrawerClosed", {
        overflowPx: await overflowPx(),
        hasHorizontalOverflow: (await overflowPx()) > 0,
    });
    await shoot("v12-real-drawer-closed.png");

    await page.getByTestId("settings-drawer-toggle").click();
    const drawer = page.getByTestId("settings-drawer");
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId("settings-drawer-toggle")).toHaveAttribute(
        "aria-expanded",
        "true",
    );
    record("horizontalOverflowDrawerOpen", {
        overflowPx: await overflowPx(),
        hasHorizontalOverflow: (await overflowPx()) > 0,
    });
    await shoot("v12-real-drawer-open.png");
    await drawer.getByRole("button").first().click();
    await expect(drawer).toHaveCount(0);
    record("drawerCycle", { opened: true, closedAfterCloseClick: true });

    // (a) 删 —— 「工作区域段页在移动端无横向滚动」取样：域段页随 task-253 退役。
    // 工作区设置页（tab 形态）的移动端取样改在 mock 车道
    // （e2e/mock/plan-0752-settings-ia.spec.ts 的 V12 用例，screenshotWorkspaceSettingsMobile）；
    // 真栈改跑该形态需在 VW 窗口另立用例，不在本卡（不跑真栈）。

    writeFileSync(
        path.join(V12_DIR, "v12-records-real.json"),
        JSON.stringify(
            {
                slot: "V12-real",
                platform: process.platform,
                viewport: "375x812",
                comparison: "deferred-to-linux: expectPlatformScreenshot no-ops off Linux",
                records,
            },
            null,
            4,
        ),
    );
});
