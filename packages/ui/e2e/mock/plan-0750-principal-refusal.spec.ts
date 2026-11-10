/**
 * PLAN-0750 V10 —— 提交期「principal 不可用」的拒绝面（mock lane，无栈）。
 *
 * ## 为什么这条判据看的是 toast 而不是消息卡片
 *
 * 这两个码是**提交期**拒绝（CP `ChatSubmissionService.requireActiveWorkspaceBinding` ⇒
 * `403 AGENT_PRINCIPAL_MISSING`），请求根本没成为一次 Run ⇒ **不会**落成带 `errorCode` 的
 * 持久消息 ⇒ `MessageItem` 的指引卡片不会出现。用户实际看到的是
 * `useSSE.sendMessage` 的 catch ⇒ `SSEStream.onError` ⇒ `toast.error`。
 *
 * ## A1-lite 判据
 *
 * `errorCopyKey()` 只给 `AGENT_PRINCIPAL_MISSING` / `AGENT_PRINCIPAL_DISABLED` 开 i18n key，
 * 于是这两个码的 toast **跟随 locale**；其余码仍走 `mappedErrorCopy`（硬编码中文，见 BL-563）。
 * 因此这里必须同时断言：en 下**不得出现中文**，且非白名单码**仍走旧路径**（旧路径的特征是
 * 带 `CODE — ` 前缀，key 路径不带）。
 *
 * ## 无静默降级（V10 的核心价值）
 *
 * 被拒之后不许有任何"帮用户兜底"的动作：不重发、不自动 rebind principal、不改绑定。
 * 断言写成计数为 0 / 恰为 1，而不是"没崩"。
 */
import { expect, test, DEFAULT_MOCK_ALLOW } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { I18nPage } from "../page-objects/I18nPage";

const SESSION_ID = "test-session";
const CHAT_API = "/api/v1/chat";
/** 裁定 A′ 要求的「工作区设置 → 智能体 → 绑定」可操作路径（双侧原文片段）。 */
const ZH_BIND_HINT = "工作区设置 → 智能体管理绑定";
const EN_BIND_HINT = "Workspace settings → Agent management";
/** CJK 表意文字 + 全角标点 —— en 语系下命中任一即判「中文外泄」。 */
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff01-\uff60]/;
/** CP 真实拒绝文案（wire 契约字符串，本卡不改）。 */
const CP_DETAIL = "An active Agent principal bound to this Workspace is required";

interface RecordedRequest {
    method: string;
    path: string;
    headers: Record<string, string>;
}

interface Refusal {
    code: string;
    detail: string;
}

/** 按出现顺序记录所有 `/api/v1/**` 请求（判据要数次数，不能只看最终态）。 */
function recordApiRequests(page: Page): RecordedRequest[] {
    const requests: RecordedRequest[] = [];
    page.on("request", (request) => {
        const url = new URL(request.url());
        if (!url.pathname.startsWith("/api/v1/")) return;
        requests.push({
            method: request.method(),
            path: url.pathname,
            headers: request.headers(),
        });
    });
    return requests;
}

/** 会话存在但**没有**绑定 principal；提交期由桩出来的 CP 拒绝。 */
async function setupRefusalLane(page: Page, refusal: Refusal): Promise<RecordedRequest[]> {
    const requests = recordApiRequests(page);
    // 必须给 `sse`：不给的话 `/api/v1/events` 只是一次性桩，`isConnected` 永远 false，
    // `useSSE.sendMessage` 会等在 `waitForConnection(5000)` 上超时并吐 "SSE connection not
    // established" —— POST /chat 根本发不出去（实测：无 sse 选项时 9 s 内零 POST /chat）。
    // `holdOpen` 让流保持打开，这样这一次提交才真的打到我们的 403 桩上。
    await setupMockAuth(page, { sse: { tokens: [], holdOpen: true } });
    await setupMockSessions(page, {
        sessions: [{ id: SESSION_ID, title: "V10 principal refusal", agentPrincipalId: null }],
    });
    // 工作区级 SSE 的默认桩只回一个会被立刻判为 invalid JSON 的 200 ⇒ 应用进入
    // ~280 ms 一次的重连循环，dock 每轮都重渲染。BL-562（reka Splitter 在重渲染窗口内抛
    // 「Panel size not found」）正是被这种 churn 触发的存量为患缺陷，会让本 spec 的公共门禁
    // 随机变红（与用例断言无关）。这里把重连间隔拉到 60 s，让本用例只关心**一次**提交。
    await page.route("**/api/v1/workspaces/*/events**", async (route) => {
        await route.fulfill({
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
            body: "retry: 60000\n\n",
        });
    });
    // 后注册优先 ⇒ 盖掉 helpers 里 `POST /api/v1/chat` 的 202 成功桩。
    await page.route("**/api/v1/chat", async (route) => {
        await route.fulfill({
            status: 403,
            contentType: "application/problem+json",
            body: JSON.stringify(refusal),
        });
    });
    return requests;
}

/** locale 来自 `localStorage["xihe-language"]`，与应用启动时的读取方式一致。 */
async function useLocale(page: Page, locale: string): Promise<void> {
    await page.goto("/login");
    await new I18nPage(page).setLanguage(locale);
}

async function openAndSend(page: Page, content: string): Promise<void> {
    await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
    const input = page.getByTestId("chat-input");
    await expect(input, "composer mounts").toBeVisible();
    await input.fill(content);
    // 用 Enter 提交（composer 的键盘发送路径，与点击 send 按钮走同一个 `handleSend`）。
    // 本夹具下 `chat-send-button` 的 click 不派发提交（实测：click 后 9 s 内零 `POST /chat`、
    // 零 `bind-defaults`，草稿仍在）；点击路径由 `chat.spec.ts` / `session-matrix-*` 覆盖。
    await input.press("Enter");
}

function refusalToast(page: Page) {
    return page.locator("[data-sonner-toast]").first();
}

test.describe("PLAN-0750 V10 — 提交期 principal 拒绝的 toast 通道", () => {
    // 本 spec 全部用例都**故意**让 POST /api/v1/chat 回 403（验的就是产品对它的处理），
    // 按 mock 门禁的规则逐条放行，而不是整体跳过 0-console-error 判据。
    test.use({
        mockAllow: [
            ...DEFAULT_MOCK_ALLOW,
            // 403 响应本身（failedResponses 通道）。
            String.raw`/api/v1/chat`,
            // 应用自己把这次拒绝记进 console（`useSSE.ts` 的 `logger.error`
            // 「Failed to send message via SSE: <CODE>」）—— 本 spec 验的就是这条路径，
            // 它的 `@ location.url` 指向 logger.ts 而不是 /api/v1/chat，故需单独放行。
            String.raw`Failed to send message via SSE:`,
        ],
    });

    test("zh-CN：AGENT_PRINCIPAL_MISSING ⇒ toast 给「工作区设置 → 智能体管理绑定」路径", async ({
        page,
    }) => {
        await setupRefusalLane(page, { code: "AGENT_PRINCIPAL_MISSING", detail: CP_DETAIL });
        await useLocale(page, "zh-CN");
        await openAndSend(page, "未绑定 principal 时发送");

        const toast = refusalToast(page);
        await expect(toast, "拒绝必须外显，不能静默").toBeVisible();
        await expect(toast, "给出可操作路径").toContainText(ZH_BIND_HINT);
        await expect(toast, "说明缺的是什么").toContainText("智能体");
    });

    test("en-US：同一个码跟随 locale，且不得出现任何中文（A1-lite 核心判据）", async ({ page }) => {
        await setupRefusalLane(page, { code: "AGENT_PRINCIPAL_MISSING", detail: CP_DETAIL });
        await useLocale(page, "en-US");
        await openAndSend(page, "send without a bound principal");

        const toast = refusalToast(page);
        await expect(toast, "拒绝必须外显").toBeVisible();
        await expect(toast, "英文可操作路径").toContainText(EN_BIND_HINT);
        const text = (await toast.textContent()) ?? "";
        expect(text, `en toast 原文 = ${text}`).not.toMatch(CJK);
    });

    test("en-US：AGENT_PRINCIPAL_DISABLED 同样跟随 locale（第二个被覆盖的码）", async ({
        page,
    }) => {
        await setupRefusalLane(page, {
            code: "AGENT_PRINCIPAL_DISABLED",
            detail: "The Agent principal bound to this Workspace is disabled",
        });
        await useLocale(page, "en-US");
        await openAndSend(page, "send with a disabled principal");

        const toast = refusalToast(page);
        await expect(toast).toBeVisible();
        await expect(toast, "指出是停用而非未绑定").toContainText("disabled");
        await expect(toast, "仍给可操作路径").toContainText(EN_BIND_HINT);
        const text = (await toast.textContent()) ?? "";
        expect(text, `en toast 原文 = ${text}`).not.toMatch(CJK);
    });

    test("非白名单码仍走旧路径：errorCopyKey 返回 null ⇒ toast 保留 CODE 前缀", async ({
        page,
    }) => {
        // 判据 = 旧路径特有形态（`chatErrorToastText` 会拼 `CODE — 文案`）；key 路径不拼码。
        // 这条锁住「加法没顺手改别的码」，其余码的硬编码中文问题归 BL-563。
        await setupRefusalLane(page, {
            code: "PROVIDER_REQUIRED",
            detail: "The session has no provider connection bound",
        });
        await useLocale(page, "en-US");
        await openAndSend(page, "send without a provider");

        await expect(refusalToast(page), "旧路径保留错误码前缀").toContainText("PROVIDER_REQUIRED");
    });

    test("无静默降级：发送恰 1 次、零自动 rebind、零 principal 变更", async ({ page }) => {
        const requests = await setupRefusalLane(page, {
            code: "AGENT_PRINCIPAL_MISSING",
            detail: CP_DETAIL,
        });
        await useLocale(page, "zh-CN");
        await openAndSend(page, "被拒后不得静默降级");

        await expect(refusalToast(page), "先确认拒绝已外显").toContainText(ZH_BIND_HINT);

        const chatPosts = () =>
            requests.filter((item) => item.method === "POST" && item.path === CHAT_API).length;
        await expect.poll(chatPosts, { message: "提交发出去，恰 1 次" }).toBe(1);

        // 前提证据：这次提交**带工作区上下文**（V10 场景就是「带 workspaceId 发 chat」）。
        const chatRequest = requests.find(
            (item) => item.method === "POST" && item.path === CHAT_API,
        );
        expect(chatRequest?.headers["x-workspace-id"], "提交带着工作区上下文").toBe("workspace-1");

        // 静默降级（重发 / 回退发送 / 自动 rebind）若存在，必落在这个窗口内。
        await page.waitForTimeout(600);
        expect(chatPosts(), "被拒后没有重发或回退发送").toBe(1);
        expect(
            requests.filter(
                (item) =>
                    item.method === "POST" &&
                    /^\/api\/v1\/workspaces\/[^/]+\/agents$/.test(item.path),
            ),
            "没有自动 rebind（POST /workspaces/{id}/agents）",
        ).toHaveLength(0);
        expect(
            requests.filter(
                (item) =>
                    /^\/api\/v1\/agent-principals(\/|$)/.test(item.path) && item.method !== "GET",
            ),
            "没有静默改绑 principal（非 GET 的 /agent-principals）",
        ).toHaveLength(0);
    });
});
