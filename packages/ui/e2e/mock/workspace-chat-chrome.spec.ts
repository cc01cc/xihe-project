import { type Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";

/**
 * task-118（D-1907 rev7 红线）：**会话页不挂工作区级导航带**。
 *
 * <p>为什么断言必须落在 e2e：这条改动的失败形态是「静默消失」——
 * 挂载点 `#workspace-nav-actions` 若随导航带一起被摘掉，六面板开关会退回
 * `WorkspaceToolbar` 的原地分支（`md:hidden`，桌面不可见），而单测里"点得到按钮"照样绿。
 * 同理"会话页没有导航带"也不能只靠单元测试（路由 meta + 壳层 v-if 两处都可能被改回）。
 *
 * <p>断言口径（真机读数见 `.tmp/xh/ui-gates/task-118/chrome-readings.json`，2026-11-20 实测）：
 * 会话页 y=0 起就是容器页签行（`workspace-container-tabs`），同一工作区的 `/members` 页
 * y=0 仍是 32px 导航带（`workspace-secondary-nav`）⇒ 会话页比它**少一条 32px 带**。
 */
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const CHAT_PATH = `/workspace/${WORKSPACE_ID}/session/session-1`;

/** 与会话页同一套桩（沿用 viewport-matrix 的口径：config/provider/mcp/environment 全给显式桩）。 */
async function setupFixtures(page: Page) {
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [{ id: "session-1", title: "Chrome Test" }] });
    await page.addInitScript(() => {
        localStorage.setItem("xihe-mock-filetree", JSON.stringify([]));
    });
    await page.route("**/api/v1/config/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) }),
    );
    await page.route("**/api/v1/provider-catalog", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ catalogRevision: "chrome", providers: [] }),
        }),
    );
    await page.route("**/api/v1/provider-connections", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ connections: [] }),
        }),
    );
    await page.route("**/api/v1/mcp", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                result: { content: [{ type: "text", text: JSON.stringify({ entries: [] }) }] },
            }),
        }),
    );
    await page.route(`**/api/v1/workspaces/${WORKSPACE_ID}/environment`, (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                workspaceId: WORKSPACE_ID,
                status: "ready",
                storageBackend: "host_directory",
                storageRef: WORKSPACE_ID,
                executionSpec: {
                    status: "assigned",
                    generation: 1,
                    sandboxSpecHash: "chrome-spec",
                },
                runtime: { status: "ready", deviceId: "chrome-device", lastHeartbeatAt: "now" },
            }),
        }),
    );
    // task-188 S2 / task-107：聊天列的两个只读端点（team_tasks 投影、权限档位）在 mock 夹具里一直没桩，
    // 会话页因此固定两条 404，被 page-failures 门当「夹具缺陷」抓住（task-118 同期补齐）。
    // 形状必须过 `api.ts` 的 normalize：team-tasks 少了 `tasks[]` 会抛错；tier 的枚举/布尔缺一个也抛。
    await page.route("**/api/v1/sessions/*/team-tasks", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ tasks: [] }),
        }),
    );
    await page.route("**/api/v1/sessions/*/tier", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                tier: "workspace",
                source: "workspace",
                workspaceTier: "workspace",
                canConfigure: false,
                denyReason: null,
                available: ["view", "workspace", "full"],
            }),
        }),
    );
}

test.describe("task-118：会话页不挂工作区级导航带", () => {
    test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

    test("会话页 workspace-nav-* 计数为 0，且顶带首行是容器页签行", async ({ page }) => {
        await setupFixtures(page);
        await page.goto(CHAT_PATH);

        // ① 导航带本体不渲染：整族 testid 一个都不许出现（`workspace-nav-actions` 已迁走，不在这族里）。
        await expect(page.getByTestId("workspace-secondary-nav")).toHaveCount(0);
        await expect(page.locator('[data-testid^="workspace-nav-"]')).toHaveCount(0);
        // 反证：同一个工作区的成员页仍有导航带（否则"0"可能只是页面没加载完）。
        await page.goto(`/workspace/${WORKSPACE_ID}/members`);
        await expect(page.getByTestId("workspace-secondary-nav")).toBeVisible();
        await expect(page.locator('[data-testid^="workspace-nav-"]').first()).toBeVisible();
    });

    test("会话页 y=0 是容器页签行（少一条 32px 带），右栏开合图标仍在且不落右栏", async ({
        page,
    }) => {
        await setupFixtures(page);
        await page.goto(CHAT_PATH);

        const mainRow = page.locator(
            '[data-testid="workspace-container-tabs"][data-container="main"]',
        );
        await expect(mainRow).toBeVisible();
        const box = await mainRow.boundingBox();
        expect(box, "容器页签行必须可见").not.toBeNull();
        // 会话页顶带少一条 32px 带 ⇒ 页签行贴顶。改回（导航带回来）时这里读到 32 ⇒ 红。
        expect(Math.abs((box?.y ?? Number.NaN) - 0)).toBeLessThanOrEqual(1);
        expect(Math.round(box?.height ?? 0)).toBe(32);

        // ② 右栏开合图标（task-137 起唯一的面板入口）必须仍渲染 **且** 落在页签行行尾的宿主里
        //    （摘带时最容易漏的一条）；它不许出现在右栏子树里。
        //    注意：开合图标是 `#workspace-nav-actions` 宿主的**兄弟**节点（不是它的子节点），
        //    写成 `#workspace-nav-actions [data-testid=…]` 会解析成 0 —— 那不是回归，是选择器错位。
        await expect(mainRow.locator('[data-testid="workspace-dock-toggle"]')).toHaveCount(1);
        await expect(
            page.locator('[data-container="right"] [data-testid="workspace-dock-toggle"]'),
        ).toHaveCount(0);
        // 六面板图标簇已整体退役（task-137）：负向判据 = 零残留，强度不降。
        await expect(page.getByTestId("workspace-panel-actions")).toHaveCount(0);

        // ③ 会话设置入口只走聊天列：右栏折叠/不在时它也必须可读，且不在右栏子树里。
        await expect(page.getByTestId("session-settings")).toHaveCount(1);
        await expect(
            page.locator('[data-container="right"] [data-testid="session-settings"]'),
        ).toHaveCount(0);
    });

    test("工作区自己的页面入口不变：/members 与 /settings 均可达（深链合法）", async ({ page }) => {
        await setupFixtures(page);
        await page.goto(`/workspace/${WORKSPACE_ID}/members`);
        // 导航项来自路由表（useWorkspaceNav），本卡只保证导航带仍在、两个入口仍在。
        const navItems = page.locator('[data-testid^="workspace-nav-"]');
        await expect(navItems.first()).toBeVisible();
        expect(await navItems.count()).toBeGreaterThanOrEqual(6);
        await expect(page.getByTestId("workspace-nav-settings")).toBeVisible();
        await page.getByTestId("workspace-nav-settings").click();
        await expect(page).toHaveURL(new RegExp(`/workspace/${WORKSPACE_ID}/settings`));
    });

    /**
     * task-5（D1450 / Q-65）：**会话页顶部不再有「设置」入口**，会话设置只经摘要行（右栏 `session-config`）。
     *
     * <p>为什么必须落 e2e：这条改动的失败形态是「入口悄悄长回来」——导航项由路由表 `meta.workspacePage`
     * 派生，壳层只要重新 `showSecondaryNav` 就会在会话页顶部多出一条带；单测里「路由 meta 还在」照样绿。
     * 证据（真机读数、三带口径、范围边界）见 `internal/A03-xihe/evidence/2026-11-20-session-settings-entry/`。</p>
     */
    test("task-5（D1450）：顶部 64px 内没有「设置」入口，会话设置只经摘要行进 session-config", async ({
        page,
    }) => {
        await setupFixtures(page);
        await page.goto(CHAT_PATH);
        await expect(page.getByTestId("session-settings-summary")).toBeVisible();

        // ① 工作区导航带整族为 0：会话页顶部不许出现工作区级的「设置」入口。
        //    反证在第三条用例：工作区页上 workspace-nav-settings 仍存在且可点（D-1907 的入口没被误删）。
        await expect(page.locator('[data-testid^="workspace-nav-"]')).toHaveCount(0);

        // ② 顶部 64px（容器页签行 32px + 会话标题行 32px）内没有任何「设置」文本 / aria-label / title。
        //    边界卡 64 而不是 96：摘要行正好落在 y=64，它自己就是会话设置的唯一入口（aria「打开会话配置」），
        //    把它算进扫描区会让断言与裁定互相矛盾。
        const offenders = await page.evaluate(() => {
            const hits: { testid: string | null; text: string; top: number }[] = [];
            for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) continue;
                if (rect.top >= 64) continue;
                const own = Array.from(el.childNodes)
                    .filter((node) => node.nodeType === Node.TEXT_NODE)
                    .map((node) => (node.textContent ?? "").trim())
                    .join(" ");
                const hay = `${own} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`;
                if (hay.includes("设置")) {
                    hits.push({
                        testid: el.dataset.testid ?? null,
                        text: hay.trim(),
                        top: Math.round(rect.top),
                    });
                }
            }
            return hits;
        });
        expect(
            offenders,
            `会话页顶部 64px 内不得有「设置」入口，实际命中：${JSON.stringify(offenders)}`,
        ).toEqual([]);

        // ③ 唯一入口：点摘要行 ⇒ 右栏恰好开出一个 pane:right:session-config:<sid>，且它被选中。
        await page.getByTestId("session-settings-summary").click();
        const configTab = page.getByTestId("dock-tab-pane:right:session-config:session-1");
        await expect(configTab).toBeVisible();
        await expect(configTab).toHaveAttribute("aria-selected", "true");
        await expect(
            page.locator('[data-testid^="dock-tab-pane:right:session-config:"]'),
        ).toHaveCount(1);
    });
});
