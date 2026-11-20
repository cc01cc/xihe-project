// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
/**
 * BL-311 —— participant（VIEWER）能看见写控件、点击后才 403 `WORKSPACE_READ_ONLY`。
 *
 * 本 spec 是**浏览器证据**（mock 车道：无 CP、无 docker、无真实后端），验证修后三条硬事实：
 *  A. VIEWER：写控件在**点击前**就 `disabled`（会话权限档位选择器 `session-tier-select` +
 *     `session-policy-auto-close` 按钮两处），且**原因常显**（`session-tier-readonly` 可见文本，
 *     不靠 title）；同时**状态仍可读**（选择器显示当前档位、summary 行仍显示审批模式、自动放行
 *     横幅仍在）；
 *  B. VIEWER：鼠标点击 / 键盘操作 / 程序化事件派发之后，**没有任何** `PATCH /api/v1/sessions/{id}/tier`
 *     写请求，也没有 403 toast —— 即 CP 侧根本收不到那次注定 403 的调用；
 *  C. EDITOR / OWNER：同一屏控件可用、可切换（现状回归，不能被这次改动连带禁用）。
 *
 * **task-16 跟改（2026-11-20，D-1908）**：本 spec 原判据是「独立审批模式下拉
 * `session-policy-mode` 点击前 disabled」。D-1908（DSD id=1448）二把该下拉换成**会话权限三档**
 * （`SessionTierSelect`），`approval_mode` 降级为派生值；旧下拉的唯一持有者
 * `chat/components/SessionPolicyControls.vue` 已无任何 import（死组件）⇒ 写入口只剩档位选择器。
 * BL-311 的规则**不变**，只是集中到档位这一个写入口上：可见 + 点击前禁用 + 可见原因 + 零写请求。
 * 改前失败消息：`expect(getByTestId("session-policy-mode")).toBeVisible: element(s) not found`
 * （`openPolicyPanel` 的首行断言，四条用例全死在这里）。
 *
 * 判定源是既有投影 `auth.canWriteWorkspace`（CP `WorkspaceView.canWrite`；旧响应回退
 * `workspaceRole !== "VIEWER"`）**与 CP 的 `canConfigure` 取严**（`SessionTierSelect.vue` 的
 * `readOnly`）。**CP 守卫与 BL-309 的 403/404 契约没有改**，这里只验 affordance。
 *
 * wire 事实（读源码后写死）：档位读写是 **GET / PATCH** `/api/v1/sessions/{id}/tier`
 * （`src/composables/api.ts:4991-5002`），PATCH body 只有 `{tier}`；响应必须严格含
 * `{tier, source, workspaceTier, canConfigure, denyReason, available}`
 * （`normalizeSessionTierState` 对未知枚举直接抛 "Invalid session tier response"，不静默降级）。
 */
import { expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { openContextPanel } from "../helpers/context-panel";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { collectPageFailures, expectNoPageFailures } from "./helpers/page-failures";
import type { PageFailures } from "./helpers/page-failures";
import { FONT_ORIGIN_FAILURE, stubSessionProjections } from "./helpers/session-projections";
import { LONG_TIMEOUT_MS } from "../timeouts";
import { selectByTestId } from "../helpers/select";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "bl311-session";
/** 中英双语正则：mock 车道默认 zh-CN，但不把断言绑死在一种语言上。 */
const READ_ONLY_COPY = /只读|read-only/i;
const AUTO_MODE_COPY = /自动放行|Auto allow|auto/i;
/** 三档文案（`sessionSettings.tierView|tierWorkspace|tierFull`）。 */
const TIER_COPY = {
    view: /仅可查看|View only/i,
    workspace: /工作区内修改|Workspace edits/i,
} as const;

type WorkspaceRole = "VIEWER" | "EDITOR" | "OWNER";
type SessionTier = "view" | "workspace" | "full";

interface TierLaneState {
    /** 服务端"当前"档位（写成功后更新，下一次 GET 会带回它）。 */
    tier: SessionTier;
    /** 收到的档位写请求 body —— VIEWER 场景必须为空。 */
    writeRequests: Array<{ tier?: SessionTier }>;
    /** 收到的策略写请求 body（横幅的「关闭自动放行」走 POST /policy/mode）—— VIEWER 同样必须为空。 */
    policyWrites: Array<{ mode?: string }>;
    /** GET 次数（证明投影真被读过，否则"显示当前档位"是空话）。 */
    reads: number;
}

/**
 * 装好四面：登录/会话夹具、workspace 投影（角色 + 可写性）、会话权限档位的读写桩。
 *
 * `canWrite` 按 CP 的权威语义给：VIEWER ⇒ false，EDITOR/OWNER ⇒ true。同时把 `workspaceRole`
 * 一起给，覆盖"某个刷新路径把 tab 上下文的角色覆盖成默认值"的可能（否则 VIEWER 场景会假绿）。
 * 档位响应里的 `canConfigure` 与 `canWrite` 同步：D-1908 的只读判定是**两者取严**
 * （`SessionTierSelect.vue` `readOnly`），只给一边会让断言测不到真实组合。
 */
async function setupTierLane(
    page: Page,
    role: { workspaceRole: WorkspaceRole; canWrite: boolean },
): Promise<TierLaneState> {
    const state: TierLaneState = {
        tier: "view",
        writeRequests: [],
        policyWrites: [],
        reads: 0,
    };
    const canConfigure = role.workspaceRole !== "VIEWER";

    await setupMockAuth(page, { workspace: { workspaceRole: role.workspaceRole } });
    await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "BL-311 tier" }] });
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

    // 审批模式仍是**可读状态**（summary 行与自动放行横幅），但它的写入口只剩横幅里的关闭按钮。
    // 桩成 `auto`：只有这样"横幅在 + 按钮禁用"这条只读判据才有被测对象（默认 manual 时横幅不渲染）。
    await page.route("**/api/v1/policy/mode**", async (route) => {
        if (route.request().method() === "POST") {
            const body = route.request().postDataJSON() as { mode?: string } | null;
            state.policyWrites.push(body ?? {});
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ sessionId: SESSION_ID, mode: "manual", scope: "session" }),
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessionId: SESSION_ID, mode: "auto", sessionRules: 0 }),
        });
    });

    const tierState = () =>
        JSON.stringify({
            tier: state.tier,
            source: "session" as const,
            workspaceTier: "workspace" as const,
            canConfigure,
            denyReason: canConfigure ? null : ("viewer" as const),
            available: ["view", "workspace", "full"],
        });

    await page.route(`**/api/v1/sessions/${SESSION_ID}/tier`, async (route) => {
        const request = route.request();
        if (request.method() === "PATCH") {
            const body = request.postDataJSON() as { tier?: SessionTier };
            state.writeRequests.push(body);
            if (body.tier) state.tier = body.tier;
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: tierState(),
            });
            return;
        }
        state.reads += 1;
        await route.fulfill({ status: 200, contentType: "application/json", body: tierState() });
    });

    return state;
}

/**
 * 进会话 → 打开右栏的「会话配置」页签（档位控件就在那里面）。
 *
 * "开面板"这一步交给全仓唯一的 `openContextPanel`（幂等、pinned/floating/收起三形态都走、
 * 失败时带一份 dock 快照）；本 spec 只叠两件自己的事：导航到目标会话，以及断言写控件已就绪。
 * 面板本体一律用可见过滤的那份 —— `session-context-panel` 可能出现两份副本（dock + 移动 sheet）。
 */
async function openTierPanel(page: Page): Promise<void> {
    await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`);
    await openContextPanel(page);
    await expect(page.getByTestId("session-tier-select")).toBeVisible({
        timeout: LONG_TIMEOUT_MS,
    });
}

test.describe("BL-311 VIEWER 只读：会话权限档位写入口点击前不可用", () => {
    let failures: PageFailures;
    test.beforeEach(({ page }) => {
        failures = collectPageFailures(page);
    });
    test.afterEach(() => {
        // 本 spec 不制造任何预期失败响应：console error / pageerror / >=400 必须全空
        // （唯一放行的是离线环境下的外部字体请求）。
        expectNoPageFailures(failures, [FONT_ORIGIN_FAILURE]);
    });

    test("A) 档位与 summary 仍可读，但写控件 disabled 且给出常显的只读原因", async ({ page }) => {
        const state = await setupTierLane(page, { workspaceRole: "VIEWER", canWrite: false });
        await openTierPanel(page);

        // 投影真的读了：否则"显示当前档位"只是碰巧的空控件。
        expect(state.reads, "the tier projection must be fetched for a VIEWER too").toBeGreaterThan(
            0,
        );

        const select = page.getByTestId("session-tier-select");
        await expect(select, "current tier stays readable").toContainText(TIER_COPY.view);
        await expect(select, "write entry point is unusable before the click").toBeDisabled();
        // D-1908 三：原因**常显**（可见文本），不靠 title 悬停。
        await expect(page.getByTestId("session-tier-readonly")).toBeVisible();
        await expect(page.getByTestId("session-tier-readonly")).toContainText(READ_ONLY_COPY);

        // 聊天列 summary 行仍显示审批模式（只读≠看不到状态）。
        await expect(page.getByTestId("session-settings-summary-approval")).toContainText(
            AUTO_MODE_COPY,
        );
    });

    test("B) 点击/键盘/程序化派发都不产生写请求，也不出现 403 toast", async ({ page }) => {
        const state = await setupTierLane(page, { workspaceRole: "VIEWER", canWrite: false });
        // 与产品无关的旁路记账：任何 tier 写请求都会被这里抓到（不依赖被测组件）。
        const writeAttempts: string[] = [];
        page.on("request", (request) => {
            if (
                request.method() === "PATCH" &&
                request.url().includes(`/api/v1/sessions/${SESSION_ID}/tier`)
            ) {
                writeAttempts.push(request.url());
            }
        });

        await openTierPanel(page);

        // 自动放行横幅的关闭按钮同样属于写入口（POST /policy/mode）：必须同样禁用 + 给原因。
        const banner = page.getByTestId("session-policy-auto-banner");
        await expect(banner).toBeVisible();
        await expect(banner).toContainText(AUTO_MODE_COPY);
        const close = page.getByTestId("session-policy-auto-close");
        await expect(close).toBeDisabled();
        await expect(close).toHaveAttribute("title", READ_ONLY_COPY);

        // 1) 真实点击（disabled ⇒ 浏览器不派发激活事件，popup 也不会打开）。
        const select = page.getByTestId("session-tier-select");
        await select.click({ force: true });
        await close.click({ force: true });
        // 2) 键盘（disabled 控件不可聚焦，按键不会改变值）。
        await select.press("ArrowDown");
        await select.press("Enter");
        // 3) 绕过 disabled 的程序化派发：JS 能给 disabled 元素派发事件，组件内守卫必须挡住写。
        //    这里只触发**DOM 层**事件：Vue 的 `update:modelValue` 由组件内部 emit，
        //    外部 DOM 事件不构成选择；真正的守卫（无 canConfigure / 越层 / 同档 ⇒ 不发请求）
        //    由 `chat/__tests__/sessionTierControls.spec.ts` 用组件级测试钉住。
        await page.evaluate(() => {
            document
                .querySelector('[data-testid="session-policy-auto-close"]')
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            document
                .querySelector('[data-testid="session-tier-select"]')
                ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        // 自动重试断言本身会推进若干轮事件循环；此后仍应零写、零 toast、横幅仍在。
        await expect(close).toBeDisabled();
        await expect(banner, "no optimistic hide: auto approval is still on").toBeVisible();
        expect(state.writeRequests, "VIEWER must not attempt a tier write").toHaveLength(0);
        expect(state.policyWrites, "VIEWER must not attempt a policy-mode write").toHaveLength(0);
        expect(
            writeAttempts,
            "no PATCH /api/v1/sessions/{id}/tier from a read-only workspace",
        ).toHaveLength(0);
        await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
        // 档位没有被本地改动：走"重新加载"这一产品级事实（服务端档位没变、写请求为 0，两者互为印证）。
        await page.reload();
        await expect(page.getByTestId("session-settings-summary")).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        // 重载后 dock 的收起/展开与活动标签是**持久化**的（`xihe-layout-ws:<id>`），所以这里
        // 不能假设"面板一定没开、点一下摘要行就行"；`openContextPanel` 的幂等分支正好覆盖两种情况。
        await openContextPanel(page);
        await expect(page.getByTestId("session-tier-select")).toContainText(TIER_COPY.view);
        await expect(page.getByTestId("session-tier-select")).toBeDisabled();
    });

    test("C) EDITOR 不受影响：控件可用、可切换（现状回归）", async ({ page }) => {
        const state = await setupTierLane(page, { workspaceRole: "EDITOR", canWrite: true });
        await openTierPanel(page);

        const select = page.getByTestId("session-tier-select");
        await expect(select).toBeEnabled();
        await expect(page.getByTestId("session-tier-readonly")).toHaveCount(0);
        await expect(select).toContainText(TIER_COPY.view);

        const writeRequest = page.waitForRequest(
            (request) =>
                request.method() === "PATCH" &&
                request.url().includes(`/api/v1/sessions/${SESSION_ID}/tier`),
            { timeout: LONG_TIMEOUT_MS },
        );
        // wire 值 → 文案的映射在 `e2e/helpers/select.ts`（认 i18n 键，不抄文案副本）。
        await selectByTestId(page, "session-tier-select", "workspace");
        await writeRequest;

        // 写成功 ⇒ 选择器显示新档位（不做乐观更新，值来自服务端响应），写 body 只带 tier。
        await expect(select).toContainText(TIER_COPY.workspace);
        expect(state.writeRequests).toHaveLength(1);
        expect(state.writeRequests[0].tier).toBe("workspace");
        expect(state.tier).toBe("workspace");
    });

    test("D) OWNER 不受影响：控件可用、可切换（现状回归）", async ({ page }) => {
        const state = await setupTierLane(page, { workspaceRole: "OWNER", canWrite: true });
        await openTierPanel(page);

        const select = page.getByTestId("session-tier-select");
        await expect(select).toBeEnabled();
        const close = page.getByTestId("session-policy-auto-close");
        await expect(close, "the remediation button stays usable for an owner").toBeEnabled();

        const writeRequest = page.waitForRequest(
            (request) =>
                request.method() === "PATCH" &&
                request.url().includes(`/api/v1/sessions/${SESSION_ID}/tier`),
            { timeout: LONG_TIMEOUT_MS },
        );
        await selectByTestId(page, "session-tier-select", "full");
        await writeRequest;

        await expect(select).toContainText(/完全权限|Full access/i);
        expect(state.writeRequests).toHaveLength(1);
        expect(state.writeRequests[0].tier).toBe("full");
    });
});
