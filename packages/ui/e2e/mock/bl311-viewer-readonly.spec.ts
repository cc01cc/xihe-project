/**
 * BL-311 —— participant（VIEWER）能看见 policy/mode 写按钮、点击后才 403 `WORKSPACE_READ_ONLY`。
 *
 * 本 spec 是**浏览器证据**（mock 车道：无 CP、无 docker、无真实后端），验证修后两条硬事实：
 *  A. VIEWER：写控件在**点击前**就 `disabled`（`session-policy-mode` 下拉 + `session-policy-auto-close`
 *     按钮两处），而**状态仍可读**（下拉仍显示当前模式、summary 行仍显示模式、自动放行横幅仍在）；
 *  B. VIEWER：鼠标点击 / 键盘操作 / 程序化事件派发之后，**没有任何** `POST /api/v1/policy/mode`
 *     写请求，也没有 403 toast —— 即 CP 侧根本收不到那次注定 403 的调用；
 *  C. EDITOR / OWNER：同一屏控件可用、可切换（现状回归，不能被这次改动连带禁用）。
 *
 * 判定源是既有投影 `auth.canWriteWorkspace`（CP `WorkspaceView.canWrite`；旧响应回退
 * `workspaceRole !== "VIEWER"`）。**CP 守卫与 BL-309 的 403/404 契约没有改**，这里只验 affordance。
 *
 * wire 事实（读源码后写死）：`setPolicyMode` 是 **POST** `/api/v1/policy/mode`
 * （`src/composables/api.ts:3665-3676`），不是 PATCH；GET 是 `/policy/mode?sessionId=…`，
 * 响应必须严格匹配 `{sessionId, mode, sessionRules?}`，写响应必须带 `scope: "session"`。
 */
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openContextPanel } from "../helpers/context-panel";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { collectPageFailures, expectNoPageFailures } from "./helpers/page-failures";
import type { PageFailures } from "./helpers/page-failures";
import { FONT_ORIGIN_FAILURE, stubSessionProjections } from "./helpers/session-projections";

const WORKSPACE_ID = "workspace-1";
const SESSION_ID = "bl311-session";
/** 中英双语正则：mock 车道默认 zh-CN，但不把断言绑死在一种语言上。 */
const READ_ONLY_COPY = /只读|read-only/i;
const AUTO_MODE_COPY = /自动放行|Auto allow|auto/i;

type WorkspaceRole = "VIEWER" | "EDITOR" | "OWNER";
type PolicyMode = "manual" | "auto";

interface PolicyLaneState {
    /** 服务端"当前"模式（写成功后更新，下一次 GET 会带回它）。 */
    mode: PolicyMode;
    /** 收到的写请求 body —— VIEWER 场景必须为空。 */
    writeRequests: Array<{ sessionId?: string; mode?: PolicyMode }>;
    /** GET 次数（证明投影真被读过，否则"显示当前模式"是空话）。 */
    reads: number;
}

/**
 * 装好三面：登录/会话夹具、workspace 投影（角色 + 可写性）、policy/mode 的读写桩。
 *
 * `canWrite` 按 CP 的权威语义给：VIEWER ⇒ false，EDITOR/OWNER ⇒ true。同时把 `workspaceRole`
 * 一起给，覆盖"某个刷新路径把 tab 上下文的角色覆盖成默认值"的可能（否则 VIEWER 场景会假绿）。
 */
async function setupPolicyLane(
    page: Page,
    role: { workspaceRole: WorkspaceRole; canWrite: boolean },
): Promise<PolicyLaneState> {
    const state: PolicyLaneState = { mode: "auto", writeRequests: [], reads: 0 };

    await setupMockAuth(page, { workspace: { workspaceRole: role.workspaceRole } });
    await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "BL-311 policy" }] });
    // 聊天列挂载后会拉这三个侧投影；不桩就是真 404 + console error（夹具缺口，不是产品缺陷）。
    await stubSessionProjections(page, SESSION_ID);
    // 参与者名单同理：`setupMockSessions` 对 `/sessions/{id}/participants` 回答 404。
    // 本 spec 不看成员面板，给一个"无权限 + 空名单"的合法信封即可（与 `agents-tab.spec.ts` 同形）。
    await page.route(`**/api/v1/sessions/${SESSION_ID}/participants`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                participants: [],
                capabilities: { view: false, manage: false, mention: false, speakAs: false },
            }),
        });
    });

    await page.route(`**/api/v1/workspaces/${WORKSPACE_ID}`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                id: WORKSPACE_ID,
                name: "Mock Workspace",
                ownerId: "user-1",
                workspaceRole: role.workspaceRole,
                canWrite: role.canWrite,
            }),
        });
    });

    await page.route("**/api/v1/policy/mode**", async (route) => {
        const request = route.request();
        if (request.method() === "POST") {
            const body = request.postDataJSON() as { sessionId?: string; mode?: PolicyMode };
            state.writeRequests.push(body);
            state.mode = body.mode ?? state.mode;
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ sessionId: SESSION_ID, mode: state.mode, scope: "session" }),
            });
            return;
        }
        state.reads += 1;
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessionId: SESSION_ID, mode: state.mode, sessionRules: 0 }),
        });
    });

    return state;
}

/**
 * 进会话 → 打开 dock 的 `context` 面板（策略控件就在那里面）。
 *
 * "开面板"这一步交给全仓唯一的 `openContextPanel`（幂等、pinned/floating/收起三形态都走、
 * 失败时带一份 dock 快照）；本 spec 只叠两件自己的事：导航到目标会话，以及断言策略控件已就绪。
 * 面板本体一律用可见过滤的那份 —— `session-context-panel` 可能出现两份副本（dock + 移动 sheet）。
 */
async function openPolicyPanel(page: Page): Promise<void> {
    await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`);
    await openContextPanel(page);
    await expect(page.getByTestId("session-policy-mode")).toBeVisible({ timeout: 15_000 });
}

test.describe("BL-311 VIEWER 只读：policy/mode 写入口点击前不可用", () => {
    let failures: PageFailures;
    test.beforeEach(({ page }) => {
        failures = collectPageFailures(page);
    });
    test.afterEach(() => {
        // 本 spec 不制造任何预期失败响应：console error / pageerror / >=400 必须全空
        // （唯一放行的是离线环境下的外部字体请求）。
        expectNoPageFailures(failures, [FONT_ORIGIN_FAILURE]);
    });

    test("A) 模式与 summary 仍可读，但写控件 disabled 且给出只读原因", async ({ page }) => {
        const state = await setupPolicyLane(page, { workspaceRole: "VIEWER", canWrite: false });
        await openPolicyPanel(page);

        // 投影真的读了：否则"显示当前模式"只是碰巧的空下拉。
        expect(state.reads, "the mode projection must be fetched for a VIEWER too").toBeGreaterThan(
            0,
        );

        const select = page.getByTestId("session-policy-mode");
        await expect(select, "current mode value stays readable").toHaveValue("auto");
        await expect(select, "write entry point is unusable before the click").toBeDisabled();
        await expect(select).toHaveAttribute("title", READ_ONLY_COPY);
        await expect(page.getByTestId("session-policy-mode-readonly")).toContainText(
            READ_ONLY_COPY,
        );

        // 聊天列 summary 行仍显示模式（只读≠看不到状态）。
        await expect(page.getByTestId("session-settings-summary-approval")).toContainText(
            AUTO_MODE_COPY,
        );
    });

    test("B) 点击/键盘/程序化派发都不产生写请求，也不出现 403 toast", async ({ page }) => {
        const state = await setupPolicyLane(page, { workspaceRole: "VIEWER", canWrite: false });
        // 与产品无关的旁路记账：任何 policy/mode 写请求都会被这里抓到（不依赖被测组件）。
        const writeAttempts: string[] = [];
        page.on("request", (request) => {
            if (request.method() === "POST" && request.url().includes("/api/v1/policy/mode")) {
                writeAttempts.push(request.url());
            }
        });

        await openPolicyPanel(page);

        // 自动放行状态与"不可操作"必须同时可见（安全信息不能因为只读而消失）。
        const banner = page.getByTestId("session-policy-auto-banner");
        await expect(banner).toBeVisible();
        await expect(banner).toContainText(AUTO_MODE_COPY);
        const close = page.getByTestId("session-policy-auto-close");
        await expect(close).toBeDisabled();
        await expect(close).toHaveAttribute("title", READ_ONLY_COPY);

        // 1) 真实点击（disabled ⇒ 浏览器不派发激活事件，不会触发 handler）。
        const select = page.getByTestId("session-policy-mode");
        await select.click({ force: true });
        await close.click({ force: true });
        // 2) 键盘（disabled 控件不可聚焦，按键不会改变值）。
        await select.press("ArrowDown");
        await select.press("Enter");
        // 3) 绕过 disabled 的程序化派发：JS 能给 disabled 元素派发事件，组件内守卫必须挡住写。
        //    两个 handler 都是**同步**发起请求的，所以这次 evaluate 返回时若发生过写，route 已记账。
        await page.evaluate(() => {
            document
                .querySelector('[data-testid="session-policy-auto-close"]')
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            const modeSelect = document.querySelector('[data-testid="session-policy-mode"]');
            if (modeSelect instanceof HTMLSelectElement) {
                modeSelect.value = "manual";
                modeSelect.dispatchEvent(new Event("change", { bubbles: true }));
            }
        });

        // 自动重试断言本身会推进若干轮事件循环；此后仍应零写、零 toast、横幅仍在。
        await expect(close).toBeDisabled();
        await expect(banner, "no optimistic hide: auto approval is still on").toBeVisible();
        expect(state.writeRequests, "VIEWER must not attempt a policy write").toHaveLength(0);
        expect(
            writeAttempts,
            "no POST /api/v1/policy/mode from a read-only workspace",
        ).toHaveLength(0);
        await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
        // 模式没有被本地改动：上面那句 `modeSelect.value = "manual"` 改的是 **DOM 属性**（disabled
        // 控件的 `.value` 可以直接写），Vue 的 `:value` 绑定没变过就不会把它写回去，所以原地读
        // `.value` 只会读到自己的破坏痕迹，证明不了产品状态。
        // 改用"重新加载"这一产品级事实：**如果发过写请求**，服务端模式会变；现在重新拉投影后
        // 仍是 auto（写请求断言已为 0），两者互为印证。
        await page.reload();
        await expect(page.getByTestId("session-settings-summary")).toBeVisible({ timeout: 15_000 });
        // 重载后 dock 的收起/展开与活动标签是**持久化**的（`xihe-layout-ws:<id>`），所以这里
        // 不能假设"面板一定没开、点一下摘要行就行"；`openContextPanel` 的幂等分支正好覆盖两种情况。
        await openContextPanel(page);
        await expect(page.getByTestId("session-policy-mode")).toHaveValue("auto");
    });

    test("C) EDITOR 不受影响：控件可用、可切换（现状回归）", async ({ page }) => {
        const state = await setupPolicyLane(page, { workspaceRole: "EDITOR", canWrite: true });
        await openPolicyPanel(page);

        const select = page.getByTestId("session-policy-mode");
        await expect(select).toBeEnabled();
        await expect(page.getByTestId("session-policy-mode-readonly")).toHaveCount(0);
        await expect(select).toHaveAttribute("title", AUTO_MODE_COPY);

        const writeRequest = page.waitForRequest(
            (request) =>
                request.method() === "POST" && request.url().includes("/api/v1/policy/mode"),
            { timeout: 15_000 },
        );
        await select.selectOption("manual");
        await writeRequest;

        // 写成功 ⇒ 横幅消失、summary 变「手动审批」，写 body 只带 sessionId+mode。
        await expect(page.getByTestId("session-policy-auto-banner")).toHaveCount(0, {
            timeout: 15_000,
        });
        await expect(page.getByTestId("session-settings-summary-approval")).toContainText(
            /手动|manual/i,
        );
        expect(state.writeRequests).toHaveLength(1);
        expect(state.writeRequests[0].sessionId).toBe(SESSION_ID);
        expect(state.writeRequests[0].mode).toBe("manual");
    });

    test("D) OWNER 不受影响：控件可用、可切换（现状回归）", async ({ page }) => {
        const state = await setupPolicyLane(page, { workspaceRole: "OWNER", canWrite: true });
        await openPolicyPanel(page);

        const select = page.getByTestId("session-policy-mode");
        await expect(select).toBeEnabled();
        const close = page.getByTestId("session-policy-auto-close");
        await expect(close, "the remediation button stays usable for an owner").toBeEnabled();

        // 安全动作：OWNER 一键关闭自动放行仍然生效。
        await close.click();
        await expect(page.getByTestId("session-policy-auto-banner")).toHaveCount(0, {
            timeout: 15_000,
        });
        expect(state.writeRequests).toHaveLength(1);
        expect(state.writeRequests[0].mode).toBe("manual");
    });
});
