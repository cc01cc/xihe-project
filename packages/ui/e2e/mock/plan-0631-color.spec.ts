/**
 * PLAN-0631 色彩方案质量门。**默认 = C2′（C2 弱化描边版，用户 2026-11-03 圈选定案）**，
 * C1/C3 仅 `?color=c1|c3` opt-in 对比用。用户三条反馈（本次需求）：
 * ① C2 描边 #8b93a1 太实 → 弱化为 #c9cfd6（白底上 1.57:1，弱化但可见）；
 * ② 「新建工作区」不配主按钮层级（低频/可逆/位置固定）→ 中性 ghost；
 * ③ 自己的气泡保持品牌蓝实心（--bubble），不描边、不中性化。
 *
 * 结构（10 例）：
 * - **C2′ 默认 × 4 页**：chat（发送按钮弱化描边 + 用户气泡蓝）/ dialog（primary vs
 *   destructive）/ settings / **picker（新建工作区已降级 ghost）**，产出 default2-*.png；
 * - **C1/C3 opt-in × 3 页**：`?color=` 对比断言（描边/气泡/徽标 token 真的换掉了）；
 * - 全部 1920×1080、同数据、deviceScaleFactor=1（像素面积可比）。
 * - **对比度实测**：正文 ≥4.5、按钮文字 ≥4.5、气泡白字 ≥4.5、危险按钮红字 ≥4.5、
 *   焦点环 ≥3（WCAG 1.4.11）；
 * - **持久化清除式迁移**：任何情况下 localStorage `xihe-color-scheme` 都必须为 null
 *   （启动 removeItem，不读值、不再写）；
 * - **0 console error / 0 pageerror**（每个用例各自断言）。
 *
 * 复现（headless，**必须**给 `--config`；本机 Playwright 需 chrome-beta 通道）：
 *   cd packages/ui
 *   $env:XIHE_E2E_PROFILE = "mock"
 *   $env:XIHE_E2E_BROWSER_CHANNEL = "chrome-beta"
 *   $env:XIHE_UI_PORT = "12650"                      # 可选：避开别的车道
 *   $env:XH_0631_COLOR_SHOT_DIR = "H:/zeogit/one/.local/xh-d28/shots/0631-color"
 *   pnpm exec playwright test --config e2e/playwright.config.ts `
 *       e2e/mock/plan-0631-color.spec.ts --reporter=list
 *
 * 产物默认落在**最近一层名为 `one` 的祖先**下的 `.local/xh-d28/shots/0631-color`
 * （worktree 与主 checkout 都成立），可用 `XH_0631_COLOR_SHOT_DIR` 覆盖。
 * 彩色像素占比由 `node .local/xh-d28/color-area.mjs`（PNG 解码 + 色度阈值）从这些
 * 截图统计，数字写进 `.local/xh-d28/0631-color-options.md`。
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import {
    contrastBetween,
    contrastRatio,
    firstColorIn,
    hsl,
    hueDistance,
    probe,
    probeActive,
} from "../helpers/color";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 从本文件向上找名为 `one` 的目录（worktree / 主 checkout 都成立），再进 `.local`。 */
function defaultShotDir(): string {
    let dir = HERE;
    for (let i = 0; i < 10; i += 1) {
        if (path.basename(dir) === "one") {
            return path.join(dir, ".local", "xh-d28", "shots", "0631-color");
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return path.resolve(HERE, "../../../../../.local/xh-d28/shots/0631-color");
}

const SHOT_DIR = process.env.XH_0631_COLOR_SHOT_DIR
    ? path.resolve(process.env.XH_0631_COLOR_SHOT_DIR)
    : defaultShotDir();

interface ColorCase {
    id: "C1" | "C3";
    param: "c1" | "c3";
    name: string;
    /** `--action` 解析后的期望色。 */
    action: string;
    actionForeground: string;
    /** 1px 描边（C1/C3 为透明；默认 C2′ 另测）。 */
    actionBorder: string;
    /** 自己的气泡（反馈③：默认走 --bubble 品牌蓝；C1/C3 各自覆盖）。 */
    bubble: string;
    bubbleForeground: string;
    badge: string;
    badgeForeground: string;
    badgeBorder: string;
    brand: string;
    destructive: string;
}

const CASES: ColorCase[] = [
    {
        id: "C1",
        param: "c1",
        name: "中性优先",
        action: "#1a1a1a",
        actionForeground: "#ffffff",
        actionBorder: "transparent",
        bubble: "#1a1a1a",
        bubbleForeground: "#ffffff",
        badge: "#eef0f3",
        badgeForeground: "#1b1e24",
        badgeBorder: "transparent",
        brand: "#2450c8",
        destructive: "#b42318",
    },
    {
        id: "C3",
        param: "c3",
        name: "降饱和",
        action: "#4a68a4",
        actionForeground: "#ffffff",
        actionBorder: "transparent",
        bubble: "#4a68a4",
        bubbleForeground: "#ffffff",
        badge: "transparent",
        badgeForeground: "#2f4a8c",
        badgeBorder: "#b9c6df",
        brand: "#4a68a4",
        destructive: "#b42318",
    },
];

/** C2′（默认）期望色 —— 用户三条反馈落进基础层后的实测基准。 */
const DEFAULT_CASE = {
    id: "C2′",
    name: "蓝仅小面积（默认）",
    action: "#ffffff",
    actionForeground: "#16181d",
    /** 反馈①：弱化描边（旧 C2 是 #8b93a1）。 */
    actionBorder: "#c9cfd6",
    /** 反馈③：气泡保持品牌蓝实心 + 白字。 */
    bubble: "#3b5bd0",
    bubbleForeground: "#ffffff",
    brand: "#3b5bd0",
    destructive: "#b42318",
} as const;

const SESSION_ID = "color-session";
const AGENT_PRINCIPAL_ID = "00000000-0000-4000-8000-0000000000a1";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DRAFT = "把主按钮改成近黑，蓝色只留链接和焦点环。";

/** 同一份数据：两轮对话（用户气泡 + 助手正文），让"大面积色块"在聊天页里可见。 */
const MESSAGES: Record<string, Array<Record<string, unknown>>> = {
    [SESSION_ID]: [
        {
            id: "msg-1",
            sessionId: SESSION_ID,
            role: "USER",
            content: "现在的界面蓝色块太多了：发送按钮、新建对话、消息气泡全是一个蓝。",
            createdAt: "2026-11-03T02:10:00.000Z",
        },
        {
            id: "msg-2",
            sessionId: SESSION_ID,
            role: "ASSISTANT",
            content: [
                "我把「彩色用量」拆成三档给你选：",
                "",
                "1. C1 中性优先：主按钮近黑，蓝色只留链接 / 焦点环 / 选中项；",
                "2. C2 蓝仅小面积：主按钮白底描边，蓝色退到图标与下划线；",
                "3. C3 降饱和：蓝还在，但更灰一档，徽标去底色改描边。",
                "",
                "三者都保持正文 ≥4.5:1、焦点环 ≥3:1，危险操作仍是红色。",
            ].join("\n"),
            createdAt: "2026-11-03T02:10:20.000Z",
        },
        {
            id: "msg-3",
            sessionId: SESSION_ID,
            role: "USER",
            content: "行，先看发送按钮和弹窗里的删除按钮。",
            createdAt: "2026-11-03T02:11:00.000Z",
        },
    ],
};

/** 与 `rgb()` 计算值对齐的比较基准（transparent → rgba(0,0,0,0)）。 */
function cssColor(hex: string): string {
    if (hex === "transparent") return "rgba(0, 0, 0, 0)";
    const value = hex.replace("#", "");
    const r = Number.parseInt(value.slice(0, 2), 16);
    const g = Number.parseInt(value.slice(2, 4), 16);
    const b = Number.parseInt(value.slice(4, 6), 16);
    return `rgb(${r}, ${g}, ${b})`;
}

/**
 * 三个候选都必须 0 console error / 0 pageerror —— 收集器在导航前挂上。
 *
 * 唯一放行项：`net::ERR_CONNECTION_CLOSED`。mock 的 approval SSE 是一条由
 * `window.fetch` 覆盖出来的**不结束**的流，用例收尾/重连时 Chrome 会记一条无 URL 的
 * 网络层错误；它不代表应用异常，也不带资源地址。这条单独记进诊断（随断言消息打印），
 * 其余 console error 与所有 pageerror 照旧红灯。
 */
function collectErrors(page: Page): { errors: string[]; http: string[] } {
    const errors: string[] = [];
    const http: string[] = [];
    page.on("console", (message) => {
        if (message.type() !== "error") return;
        const text = message.text();
        if (text.includes("net::ERR_CONNECTION_CLOSED")) {
            http.push(`(ignored mock-SSE teardown) ${text}`);
            return;
        }
        errors.push(`console: ${text}`);
    });
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("response", (response) => {
        if (response.status() >= 400) http.push(`${response.status()} ${response.url()}`);
    });
    return { errors, http };
}

function writeMeasure(name: string, payload: unknown): void {
    const dir = path.join(SHOT_DIR, "measure");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function shoot(page: Page, name: string): Promise<string> {
    mkdirSync(path.dirname(path.join(SHOT_DIR, name)), { recursive: true });
    const file = path.join(SHOT_DIR, name);
    await page.screenshot({ path: file, animations: "disabled", caret: "hide" });
    return file;
}

async function prepareAuth(page: Page): Promise<void> {
    await setupMockAuth(page);
    await page.addInitScript(() => {
        localStorage.setItem(
            "xihe-user",
            JSON.stringify({
                id: "user-1",
                email: "test@xihe.local",
                name: "Test User",
                capabilities: {
                    isInstanceAdmin: true,
                    isInstanceSuper: true,
                    workspaceAdminOf: ["workspace-1"],
                },
            }),
        );
        // ≥1800px 时 dock 默认展开 monitor 面板（会去拉一个 mock 里不存在的聚合接口，
        // 截图里就是一块"加载失败"）。这里是用户态布局，不是产品行为：收起 dock，
        // 让三张图的聊天列宽度一致、画面里没有无关的失败提示。
        localStorage.setItem(
            "xihe-layout-ws:workspace-1",
            JSON.stringify({ dockCollapsed: true, dockMode: "pinned" }),
        );
    });
}

/** `setupMockSessions` 对未知会话子资源回 404；缺 fixture 会让"0 console error"变红。 */
async function mockSessionProjections(page: Page, sessionId: string): Promise<void> {
    await page.route(`**/api/v1/sessions/${sessionId}/derived-state`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessionId, activeChildren: [], terminalNotices: [] }),
        });
    });
    await page.route(`**/api/v1/sessions/${sessionId}/follow-ups`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                sessionId,
                queueState: "empty",
                outstandingCount: 0,
                capacityLimit: 5,
                pauseReason: null,
                items: [],
            }),
        });
    });
    await page.route(`**/api/v1/sessions/${sessionId}/participants`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ participants: [] }),
        });
    });
    await page.route(`**/api/v1/sessions/${sessionId}/commands`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ commands: [] }),
        });
    });
}

/** 对话框页：审批弹窗（primary = 允许一次 / destructive = 拒绝）走真实 SSE 事件。 */
const approvalEvent = (requestId: string) => ({
    requestId,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    workspaceId: "workspace-1",
    tool: "request_approval",
    action: "delete file",
    details: "workspace/README.md",
    argumentsHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    state: "pending",
    replayed: false,
    policy: {
        effect: "ask",
        sourceLayer: "workspace",
        matchedRule: null,
        reason: "No matching allow rule",
        mode: "manual",
        actionClass: "delete",
        shape: "structured",
    },
});

async function installApprovalSSE(page: Page): Promise<void> {
    await page.addInitScript(
        ({ sessionId, runId }: { sessionId: string; runId: string }) => {
            const pending: unknown[] = [];
            let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
            const encode = (value: string) => new TextEncoder().encode(value);
            const sse = (name: string, data: unknown) =>
                `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
            const drain = () => {
                if (!controllerRef) return;
                while (pending.length > 0) {
                    controllerRef.enqueue(encode(sse("approval_request", pending.shift())));
                }
            };
            (window as unknown as Record<string, unknown>).__pushApprovalEvent = (
                payload: unknown,
            ) => {
                pending.push(payload);
                drain();
            };
            const originalFetch = window.fetch.bind(window);
            window.fetch = async (input, init) => {
                const requestUrl =
                    typeof input === "string"
                        ? input
                        : input instanceof URL
                          ? input.toString()
                          : input.url;
                if (requestUrl.includes("/api/v1/events")) {
                    const body = new ReadableStream<Uint8Array>({
                        start(controller) {
                            controllerRef = controller;
                            controller.enqueue(encode("retry: 1000\n\n"));
                            queueMicrotask(drain);
                        },
                    });
                    return new Response(body, {
                        status: 200,
                        headers: { "Content-Type": "text/event-stream" },
                    });
                }
                if (
                    requestUrl.includes("/api/v1/chat") &&
                    !requestUrl.includes("/api/v1/chat/approvals/") &&
                    (init?.method ?? "GET") === "POST"
                ) {
                    return new Response(JSON.stringify({ status: "accepted", sessionId, runId }), {
                        status: 202,
                        headers: { "Content-Type": "application/json" },
                    });
                }
                return originalFetch(input, init);
            };
        },
        { sessionId: SESSION_ID, runId: RUN_ID },
    );
}

async function installPolicyModeRoute(page: Page): Promise<void> {
    await page.route("**/api/v1/policy/mode*", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessionId: SESSION_ID, mode: "manual", sessionRules: 0 }),
        });
    });
}

/** 设置页：角色定义（含系统徽标 = secondary Badge、选中 tab、主按钮）。 */
async function mockRolesApis(page: Page): Promise<void> {
    const atom = { name: "read", scopeClass: "both", capability: false, resource: "*" };
    await page.route("**/api/v1/roles/catalog", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ atoms: [atom], scopes: ["instance", "workspace"] }),
        });
    });
    await page.route("**/api/v1/roles", async (route) => {
        if (route.request().method() !== "GET") {
            await route.fulfill({ status: 204, body: "" });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([
                {
                    id: "role-sys",
                    name: "SUPER_ADMIN",
                    displayName: "Super Admin",
                    description: null,
                    system: true,
                    atoms: [atom],
                    bindingCount: 1,
                },
                {
                    id: "role-auditor",
                    name: "AUDITOR",
                    displayName: "Auditor",
                    description: "Read-only reviewer",
                    system: false,
                    atoms: [atom],
                    bindingCount: 0,
                },
            ]),
        });
    });
    await page.route("**/api/v1/workspaces", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([]),
        });
    });
}

test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

test.describe("PLAN-0631 colour schemes（C1/C3 opt-in 对比）", () => {
    for (const item of CASES) {
        test(`${item.id} (${item.name}) — chat: send button + composer`, async ({ page }) => {
            await page.emulateMedia({ reducedMotion: "reduce" });
            const { errors, http } = collectErrors(page);
            await prepareAuth(page);
            await setupMockSessions(page, {
                sessions: [{ id: SESSION_ID, title: "色彩方案对比" }],
                messages: MESSAGES,
            });
            await mockSessionProjections(page, SESSION_ID);

            await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}?color=${item.param}`, {
                waitUntil: "load",
            });
            await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 20000 });
            await expect(page.locator('[data-testid="message-item"]').first()).toBeVisible({
                timeout: 20000,
            });
            await page.getByTestId("chat-input").fill(DRAFT);

            const attributes = await page.evaluate(() => ({
                color: document.documentElement.getAttribute("data-xh-color"),
                variant: document.documentElement.getAttribute("data-xh-variant"),
                stored: localStorage.getItem("xihe-color-scheme"),
            }));
            expect(attributes.color, "?color= 必须投影到 <html data-xh-color>").toBe(item.param);
            expect(attributes.stored, "清除式迁移：不得再写持久化键").toBeNull();

            const shot = await shoot(page, `${item.id}-chat.png`);

            // 先在**未聚焦**状态量按钮填充/描边（聚焦会把 1px 描边换成 2px 焦点环）。
            const send = await probe(page, '[data-testid="chat-send-button"]');
            const bubble = await probe(
                page,
                '[data-testid="message-item"] [data-slot="bubble-content"]',
            );
            const body = await probe(
                page,
                '[data-testid="message-item"] p, [data-testid="message-item"] .paragraph-node',
            );
            const tokens = await page.evaluate(() => {
                const style = getComputedStyle(document.documentElement);
                const read = (name: string) => style.getPropertyValue(name).trim();
                return {
                    background: read("--background"),
                    foreground: read("--foreground"),
                    mutedForeground: read("--muted-foreground"),
                    action: read("--action"),
                    actionForeground: read("--action-foreground"),
                    actionBorder: read("--action-border"),
                    primary: read("--primary"),
                    brand: read("--brand"),
                    link: read("--link"),
                    ring: read("--ring"),
                    destructive: read("--destructive"),
                    badge: read("--badge"),
                };
            });
            // 焦点环：真实键盘 Tab 到**发送按钮**（不数固定次数，按 activeElement 判定）。
            await page.getByTestId("chat-input").focus();
            for (let step = 0; step < 12; step += 1) {
                const activeTestId = await page.evaluate(
                    () =>
                        (document.activeElement as HTMLElement | null)?.getAttribute(
                            "data-testid",
                        ) ?? "",
                );
                if (activeTestId === "chat-send-button") break;
                await page.keyboard.press("Tab");
            }
            const focus = await probeActive(page);
            expect(focus.testId, "焦点环必须量在发送按钮上（键盘可达）").toBe("chat-send-button");

            const sendContrast = contrastRatio(send.color, [send.background]);
            const bodyContrast = contrastRatio(body.color, body.backgrounds);
            // 正文 token（--foreground on --background）与"气泡里的正文"分开记：
            // 前者是灰阶基线，后者随气泡填充一起变化。
            const bodyTokenContrast = contrastRatio(tokens.foreground, [tokens.background]);
            const mutedContrast = contrastRatio(tokens.mutedForeground, [tokens.background]);
            const hasOutline = focus.outlineStyle !== "none" && focus.outlineWidthPx >= 2;
            const hasRing = focus.boxShadow !== "none" && focus.boxShadow.length > 0;
            expect(hasOutline || hasRing, "焦点指示必须可见（outline 或 ring）").toBe(true);
            const focusColor = firstColorIn(hasOutline ? focus.outlineColor : focus.boxShadow);
            expect(
                focusColor,
                `焦点环颜色必须可解析（focus=${JSON.stringify(focus)}）`,
            ).not.toBeNull();
            const focusContrast = contrastRatio(focusColor!, focus.backgrounds);

            // 几何必须还是 B（色彩方案不许顺手改密度/字号/圆角）。
            expect(body.fontSizePx, "B 正文 14px").toBeCloseTo(14, 0);
            expect(body.lineHeightPx, "B 正文行高 1.55").toBeCloseTo(21.7, 0);
            expect(send.borderRadiusPx, "B 主档圆角 10px").toBeCloseTo(10, 0);

            // 颜色必须真的换成候选值。
            expect(send.background, "发送按钮填充 = --action").toBe(cssColor(item.action));
            expect(send.color, "发送按钮文字 = --action-foreground").toBe(
                cssColor(item.actionForeground),
            );
            expect(bubble.background, "用户消息气泡 = 该方案的 --bubble").toBe(
                cssColor(item.bubble),
            );
            expect(bubble.color, "气泡文字 = --bubble-foreground").toBe(
                cssColor(item.bubbleForeground),
            );
            expect(tokens.brand, "--brand").toBe(item.brand);
            expect(tokens.destructive, "--destructive").toBe(item.destructive);

            expect(bodyTokenContrast, "正文 token（前景/背景）≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
            expect(bodyContrast, "消息气泡内正文 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
            expect(mutedContrast, "次级文字 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
            expect(sendContrast, "发送按钮文字 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
            expect(focusContrast, "焦点环与背景 ≥ 3:1（WCAG 1.4.11）").toBeGreaterThanOrEqual(3);

            if (item.actionBorder !== "transparent") {
                // raw <button> 没有 border token 通道，由基础层补 1px 内描边。
                expect(send.outlineWidthPx, "发送按钮必须有 1px 描边").toBeGreaterThanOrEqual(1);
                expect(send.outlineColor, "描边颜色").toBe(cssColor(item.actionBorder));
            }

            writeMeasure(`${item.id}-chat`, {
                scheme: item.id,
                param: item.param,
                page: "chat",
                shot,
                tokens,
                contrast: {
                    body: bodyTokenContrast,
                    bubbleText: bodyContrast,
                    muted: mutedContrast,
                    sendButton: sendContrast,
                    focusRing: focusContrast,
                },
                geometry: {
                    bodyFontSizePx: body.fontSizePx,
                    bodyLineHeightPx: body.lineHeightPx,
                    controlRadiusPx: send.borderRadiusPx,
                },
                send,
                bubble,
                focus,
                focusTarget: `${focus.tag} ${focus.testId} ${focus.label}`.trim(),
            });
            expect(errors, `4xx/5xx 响应：\n${http.join("\n")}`).toEqual([]);
        });

        test(`${item.id} (${item.name}) — dialog: primary vs destructive`, async ({ page }) => {
            await page.emulateMedia({ reducedMotion: "reduce" });
            const { errors, http } = collectErrors(page);
            await prepareAuth(page);
            await setupMockSessions(page, {
                sessions: [
                    {
                        id: SESSION_ID,
                        title: "审批弹窗配色",
                        agentPrincipalId: AGENT_PRINCIPAL_ID,
                    },
                ],
            });
            await mockSessionProjections(page, SESSION_ID);
            await installPolicyModeRoute(page);
            await installApprovalSSE(page);

            await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}?color=${item.param}`, {
                waitUntil: "load",
            });
            await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 20000 });
            await page.evaluate((payload) => {
                const push = (window as unknown as Record<string, unknown>).__pushApprovalEvent as (
                    event: unknown,
                ) => void;
                push(payload);
            }, approvalEvent(REQUEST_ID));

            const dialog = page.locator('[data-testid="modal-content"]');
            await expect(dialog).toBeVisible({ timeout: 10000 });
            await expect(dialog.locator('[data-testid="approval-approve"]')).toBeVisible();
            await expect(dialog.locator('[data-testid="approval-reject"]')).toBeVisible();

            const shot = await shoot(page, `${item.id}-dialog.png`);

            const approve = await probe(page, '[data-testid="approval-approve"]');
            const reject = await probe(page, '[data-testid="approval-reject"]');

            const approveContrast = contrastRatio(approve.color, approve.backgrounds);
            const rejectContrast = contrastRatio(reject.color, reject.backgrounds);

            // primary = 动作填充；destructive = 语义红（红字 + 红边，不是中性）。
            expect(approve.background, "primary 按钮填充 = --action").toBe(cssColor(item.action));
            expect(approve.color, "primary 按钮文字 = --action-foreground").toBe(
                cssColor(item.actionForeground),
            );
            expect(reject.color, "destructive 按钮文字必须仍是语义红").toBe(
                cssColor(item.destructive),
            );

            // 区分度：destructive 必须"红"（饱和度高），且与 primary 在色相或中性上不同。
            const dangerHsl = hsl(reject.color);
            const actionHsl = hsl(approve.background);
            const hueGap = hueDistance(reject.color, approve.background);
            const distinguishable = dangerHsl.s >= 40 && (actionHsl.s < 24 || hueGap >= 60);
            expect(
                distinguishable,
                `primary(${approve.background}) 与 destructive(${reject.color}) 必须可区分：` +
                    `danger.s=${dangerHsl.s} action.s=${actionHsl.s} hueGap=${hueGap}`,
            ).toBe(true);

            expect(approveContrast, "primary 按钮文字 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
            expect(rejectContrast, "destructive 文字 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);

            writeMeasure(`${item.id}-dialog`, {
                scheme: item.id,
                param: item.param,
                page: "dialog",
                shot,
                contrast: {
                    primaryButton: approveContrast,
                    destructiveButton: rejectContrast,
                    primaryVsDestructive: contrastBetween(approve.background, reject.color),
                },
                distinguishability: {
                    actionHsl,
                    dangerHsl,
                    hueGap,
                    rule: "danger.s>=40 && (action.s<24 || hueGap>=60)",
                },
                approve,
                reject,
            });
            expect(errors, `4xx/5xx 响应：\n${http.join("\n")}`).toEqual([]);
        });

        test(`${item.id} (${item.name}) — settings: badge / selected tab / primary action`, async ({
            page,
        }) => {
            await page.emulateMedia({ reducedMotion: "reduce" });
            const { errors, http } = collectErrors(page);
            await prepareAuth(page);
            await mockRolesApis(page);

            await page.goto(`/settings/roles?color=${item.param}`, { waitUntil: "load" });
            await expect(page.getByTestId("roles-view")).toBeVisible({ timeout: 20000 });
            await expect(page.getByTestId("role-system-badge").first()).toBeVisible({
                timeout: 20000,
            });

            const shot = await shoot(page, `${item.id}-settings.png`);

            const badge = await probe(page, '[data-testid="role-system-badge"]');
            const create = await probe(page, '[data-testid="roles-create"]');
            const selectedNav = await probe(page, '[data-testid="roles-tab-roles"]');
            const row = await probe(page, '[data-testid="role-row-SUPER_ADMIN"]');

            const badgeContrast = contrastRatio(badge.color, badge.backgrounds);
            const createContrast = contrastRatio(create.color, create.backgrounds);

            expect(badge.background, "徽标底 = --badge").toBe(cssColor(item.badge));
            expect(badge.color, "徽标字 = --badge-foreground").toBe(cssColor(item.badgeForeground));
            if (item.badgeBorder !== "transparent") {
                expect(badge.borderTopColor, "C2/C3 徽标必须有 1px 描边").toBe(
                    cssColor(item.badgeBorder),
                );
                expect(badge.borderTopWidth).toBeGreaterThanOrEqual(1);
            }
            expect(create.background, "主按钮填充 = --action").toBe(cssColor(item.action));
            // 选中态用 --brand（2px 下划线），保证 C1 的"蓝色只留选中项"成立。
            expect(selectedNav.borderBottomColor, "设置页选中 tab 下划线 = --brand").toBe(
                cssColor(item.brand),
            );
            expect(selectedNav.borderBottomWidth).toBeGreaterThanOrEqual(2);

            expect(badgeContrast, "徽标文字 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
            expect(createContrast, "主按钮文字 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
            // B 的表格行：`tr { height: 32px }` 是下限，13px 正文 + py-1 + 1px 边实际落 36px。
            expect(row.rect.height, "B 表格行高（≥32 下限）").toBeGreaterThanOrEqual(31);
            expect(row.rect.height, "B 表格行高仍是一屏多行的密集档").toBeLessThanOrEqual(40);

            writeMeasure(`${item.id}-settings`, {
                scheme: item.id,
                param: item.param,
                page: "settings",
                shot,
                contrast: { badge: badgeContrast, primaryButton: createContrast },
                badge,
                create,
                selectedNav,
                rowHeightPx: row.rect.height,
            });
            expect(errors, `4xx/5xx 响应：\n${http.join("\n")}`).toEqual([]);
        });
    }

    test("C2′ (default) — chat: 弱化描边发送按钮 + 品牌蓝气泡", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        const { errors, http } = collectErrors(page);
        await prepareAuth(page);
        await setupMockSessions(page, {
            sessions: [{ id: SESSION_ID, title: "默认色彩 C2′" }],
            messages: MESSAGES,
        });
        await mockSessionProjections(page, SESSION_ID);

        await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`, { waitUntil: "load" });
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 20000 });
        await expect(page.locator('[data-testid="message-item"]').first()).toBeVisible({
            timeout: 20000,
        });
        await page.getByTestId("chat-input").fill(DRAFT);

        const attributes = await page.evaluate(() => ({
            color: document.documentElement.getAttribute("data-xh-color"),
            stored: localStorage.getItem("xihe-color-scheme"),
            action: getComputedStyle(document.documentElement).getPropertyValue("--action").trim(),
            actionBorder: getComputedStyle(document.documentElement)
                .getPropertyValue("--action-border")
                .trim(),
            bubble: getComputedStyle(document.documentElement).getPropertyValue("--bubble").trim(),
        }));
        expect(attributes.color, "默认 = C2′：不设 data-xh-color").toBeNull();
        expect(attributes.stored, "清除式迁移：旧 xihe-color-scheme 必须已清除").toBeNull();
        expect(attributes.action, "默认 --action = 白底（反馈①②：主操作不再铺色）").toBe("#ffffff");
        expect(attributes.actionBorder, "默认 --action-border = 弱化描边").toBe(
            DEFAULT_CASE.actionBorder,
        );
        expect(attributes.bubble, "默认 --bubble = 品牌蓝（反馈③）").toBe(DEFAULT_CASE.bubble);

        const shot = await shoot(page, "default2-chat.png");

        // 先在**未聚焦**状态量按钮填充/描边（聚焦会把 1px 描边换成 2px 焦点环）。
        const send = await probe(page, '[data-testid="chat-send-button"]');
        const bubble = await probe(
            page,
            '[data-testid="message-item"] [data-slot="bubble-content"]',
        );
        const body = await probe(
            page,
            '[data-testid="message-item"] p, [data-testid="message-item"] .paragraph-node',
        );
        const tokens = await page.evaluate(() => {
            const style = getComputedStyle(document.documentElement);
            const read = (name: string) => style.getPropertyValue(name).trim();
            return {
                background: read("--background"),
                foreground: read("--foreground"),
                mutedForeground: read("--muted-foreground"),
                action: read("--action"),
                actionForeground: read("--action-foreground"),
                actionBorder: read("--action-border"),
                bubble: read("--bubble"),
                primary: read("--primary"),
                brand: read("--brand"),
                link: read("--link"),
                ring: read("--ring"),
                destructive: read("--destructive"),
                badge: read("--badge"),
            };
        });
        // 焦点环：真实键盘 Tab 到**发送按钮**（不数固定次数，按 activeElement 判定）。
        await page.getByTestId("chat-input").focus();
        for (let step = 0; step < 12; step += 1) {
            const activeTestId = await page.evaluate(
                () =>
                    (document.activeElement as HTMLElement | null)?.getAttribute("data-testid") ??
                    "",
            );
            if (activeTestId === "chat-send-button") break;
            await page.keyboard.press("Tab");
        }
        const focus = await probeActive(page);
        expect(focus.testId, "焦点环必须量在发送按钮上（键盘可达）").toBe("chat-send-button");

        // 反馈①：白底 + 弱化 1px 描边（旧 C2 是 #8b93a1）。
        expect(send.background, "发送按钮填充 = 白底").toBe(cssColor(DEFAULT_CASE.action));
        expect(send.color, "发送按钮文字 = --action-foreground").toBe(
            cssColor(DEFAULT_CASE.actionForeground),
        );
        expect(send.outlineWidthPx, "发送按钮必须有 1px 内描边").toBeGreaterThanOrEqual(1);
        expect(send.outlineColor, "弱化描边色值（反馈①）").toBe(
            cssColor(DEFAULT_CASE.actionBorder),
        );

        // 反馈③：气泡品牌蓝实心 + 白字，无描边。
        expect(bubble.background, "用户气泡 = 品牌蓝实心").toBe(cssColor(DEFAULT_CASE.bubble));
        expect(bubble.color, "气泡白字").toBe(cssColor(DEFAULT_CASE.bubbleForeground));
        expect(bubble.outlineStyle, "气泡不得有描边（反馈③）").toBe("none");

        // 几何必须还是 B（色彩方案不许顺手改密度/字号/圆角）。
        expect(body.fontSizePx, "B 正文 14px").toBeCloseTo(14, 0);
        expect(body.lineHeightPx, "B 正文行高 1.55").toBeCloseTo(21.7, 0);
        expect(send.borderRadiusPx, "B 主档圆角 10px").toBeCloseTo(10, 0);

        expect(tokens.brand, "--brand").toBe(DEFAULT_CASE.brand);
        // 基础层 --destructive 是 oklch 红（候选文件才落 #b42318 字面值）：
        // 判"仍是语义红"用色相距离，不判字面量。
        expect(
            hueDistance(tokens.destructive, DEFAULT_CASE.destructive),
            "--destructive 仍是语义红（与 #b42318 同族）",
        ).toBeLessThanOrEqual(10);

        const sendContrast = contrastRatio(send.color, [send.background]);
        const bodyContrast = contrastRatio(body.color, body.backgrounds);
        const bodyTokenContrast = contrastRatio(tokens.foreground, [tokens.background]);
        const mutedContrast = contrastRatio(tokens.mutedForeground, [tokens.background]);
        const bubbleTextContrast = contrastRatio(bubble.color, [bubble.background]);
        const hasOutline = focus.outlineStyle !== "none" && focus.outlineWidthPx >= 2;
        const hasRing = focus.boxShadow !== "none" && focus.boxShadow.length > 0;
        expect(hasOutline || hasRing, "焦点指示必须可见（outline 或 ring）").toBe(true);
        const focusColor = firstColorIn(hasOutline ? focus.outlineColor : focus.boxShadow);
        expect(focusColor, `焦点环颜色必须可解析（focus=${JSON.stringify(focus)}）`).not.toBeNull();
        const focusContrast = contrastRatio(focusColor!, focus.backgrounds);

        expect(bodyTokenContrast, "正文 token（前景/背景）≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
        expect(bodyContrast, "消息气泡内正文 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
        expect(bubbleTextContrast, "气泡白字 ≥ 4.5:1（反馈③）").toBeGreaterThanOrEqual(4.5);
        expect(mutedContrast, "次级文字 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
        expect(sendContrast, "发送按钮文字 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
        expect(focusContrast, "焦点环与背景 ≥ 3:1（WCAG 1.4.11）").toBeGreaterThanOrEqual(3);

        writeMeasure("default2-chat", {
            scheme: DEFAULT_CASE.id,
            page: "chat",
            shot,
            tokens,
            contrast: {
                body: bodyTokenContrast,
                bubbleText: bodyContrast,
                bubbleWhite: bubbleTextContrast,
                muted: mutedContrast,
                sendButton: sendContrast,
                focusRing: focusContrast,
            },
            borderWeakened: {
                before: "#8b93a1（对白 3.09:1）",
                after: `${DEFAULT_CASE.actionBorder}（对白 1.57:1）`,
            },
            geometry: {
                bodyFontSizePx: body.fontSizePx,
                bodyLineHeightPx: body.lineHeightPx,
                controlRadiusPx: send.borderRadiusPx,
            },
            send,
            bubble,
            focus,
            focusTarget: `${focus.tag} ${focus.testId} ${focus.label}`.trim(),
        });
        expect(errors, `4xx/5xx 响应：\n${http.join("\n")}`).toEqual([]);
    });

    test("C2′ (default) — dialog: primary vs destructive", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        const { errors, http } = collectErrors(page);
        await prepareAuth(page);
        await setupMockSessions(page, {
            sessions: [
                {
                    id: SESSION_ID,
                    title: "审批弹窗配色",
                    agentPrincipalId: AGENT_PRINCIPAL_ID,
                },
            ],
        });
        await mockSessionProjections(page, SESSION_ID);
        await installPolicyModeRoute(page);
        await installApprovalSSE(page);

        await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`, { waitUntil: "load" });
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 20000 });
        await page.evaluate((payload) => {
            const push = (window as unknown as Record<string, unknown>).__pushApprovalEvent as (
                event: unknown,
            ) => void;
            push(payload);
        }, approvalEvent(REQUEST_ID));

        const dialog = page.locator('[data-testid="modal-content"]');
        await expect(dialog).toBeVisible({ timeout: 10000 });
        await expect(dialog.locator('[data-testid="approval-approve"]')).toBeVisible();
        await expect(dialog.locator('[data-testid="approval-reject"]')).toBeVisible();

        const shot = await shoot(page, "default2-dialog.png");

        const approve = await probe(page, '[data-testid="approval-approve"]');
        const reject = await probe(page, '[data-testid="approval-reject"]');

        const approveContrast = contrastRatio(approve.color, approve.backgrounds);
        const rejectContrast = contrastRatio(reject.color, reject.backgrounds);

        // primary = 白底弱化描边；destructive = 语义红（红字 + 红边，不是中性）。
        expect(approve.background, "primary 按钮填充 = 白底").toBe(cssColor(DEFAULT_CASE.action));
        expect(approve.color, "primary 按钮文字 = 深字").toBe(
            cssColor(DEFAULT_CASE.actionForeground),
        );
        // 基础层 --destructive 是 oklch 红：判"仍是语义红"用色相距离 + 饱和度，不判字面量。
        const dangerHsl = hsl(reject.color);
        expect(
            hueDistance(reject.color, DEFAULT_CASE.destructive) <= 10 && dangerHsl.s >= 40,
            `destructive 按钮文字必须仍是语义红（实测 ${reject.color}）`,
        ).toBe(true);

        // 区分度：destructive 必须"红"（饱和度高），且与 primary 在色相或中性上不同。
        const actionHsl = hsl(approve.background);
        const hueGap = hueDistance(reject.color, approve.background);
        const distinguishable = dangerHsl.s >= 40 && (actionHsl.s < 24 || hueGap >= 60);
        expect(
            distinguishable,
            `primary(${approve.background}) 与 destructive(${reject.color}) 必须可区分：` +
                `danger.s=${dangerHsl.s} action.s=${actionHsl.s} hueGap=${hueGap}`,
        ).toBe(true);

        expect(approveContrast, "primary 按钮文字 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
        expect(rejectContrast, "destructive 文字 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);

        writeMeasure("default2-dialog", {
            scheme: DEFAULT_CASE.id,
            page: "dialog",
            shot,
            contrast: {
                primaryButton: approveContrast,
                destructiveButton: rejectContrast,
                primaryVsDestructive: contrastBetween(approve.background, reject.color),
            },
            distinguishability: {
                actionHsl,
                dangerHsl,
                hueGap,
                rule: "danger.s>=40 && (action.s<24 || hueGap>=60)",
            },
            approve,
            reject,
        });
        expect(errors, `4xx/5xx 响应：\n${http.join("\n")}`).toEqual([]);
    });

    test("C2′ (default) — settings: badge / selected tab / primary", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        const { errors, http } = collectErrors(page);
        await prepareAuth(page);
        await mockRolesApis(page);

        await page.goto("/settings/roles", { waitUntil: "load" });
        await expect(page.getByTestId("roles-view")).toBeVisible({ timeout: 20000 });
        await expect(page.getByTestId("role-system-badge").first()).toBeVisible({
            timeout: 20000,
        });

        const shot = await shoot(page, "default2-settings.png");

        const badge = await probe(page, '[data-testid="role-system-badge"]');
        const create = await probe(page, '[data-testid="roles-create"]');
        const selectedNav = await probe(page, '[data-testid="roles-tab-roles"]');
        const row = await probe(page, '[data-testid="role-row-SUPER_ADMIN"]');

        const badgeContrast = contrastRatio(badge.color, badge.backgrounds);
        const createContrast = contrastRatio(create.color, create.backgrounds);

        // 徽标沿用默认（--badge = --secondary #f1f3f7），不铺强调色。
        expect(badge.background, "徽标底 = --badge（secondary 浅灰）").toBe(cssColor("#f1f3f7"));
        expect(badge.color, "徽标字 = --badge-foreground").toBe(cssColor("#16181d"));
        expect(create.background, "主按钮填充 = 白底弱化描边").toBe(cssColor(DEFAULT_CASE.action));
        expect(create.borderTopWidth, "主按钮 1px 弱化描边").toBeGreaterThanOrEqual(1);
        expect(create.borderTopColor, "弱化描边色值").toBe(cssColor(DEFAULT_CASE.actionBorder));
        // 选中态用 --brand（2px 下划线），蓝只留小面积。
        expect(selectedNav.borderBottomColor, "设置页选中 tab 下划线 = --brand").toBe(
            cssColor(DEFAULT_CASE.brand),
        );
        expect(selectedNav.borderBottomWidth).toBeGreaterThanOrEqual(2);

        expect(badgeContrast, "徽标文字 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
        expect(createContrast, "主按钮文字 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);
        // B 的表格行：`tr { height: 32px }` 是下限，13px 正文 + py-1 + 1px 边实际落 36px。
        expect(row.rect.height, "B 表格行高（≥32 下限）").toBeGreaterThanOrEqual(31);
        expect(row.rect.height, "B 表格行高仍是一屏多行的密集档").toBeLessThanOrEqual(40);

        writeMeasure("default2-settings", {
            scheme: DEFAULT_CASE.id,
            page: "settings",
            shot,
            contrast: { badge: badgeContrast, primaryButton: createContrast },
            badge,
            create,
            selectedNav,
            rowHeightPx: row.rect.height,
        });
        expect(errors, `4xx/5xx 响应：\n${http.join("\n")}`).toEqual([]);
    });

    test("C2′ (default) — picker: 新建工作区已降级 ghost", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        const { errors, http } = collectErrors(page);
        await prepareAuth(page);
        // 选择面只在"无 tab 上下文"时渲染：清掉 setupMockAuth 种下的工作区——
        // 两处都要清：sessionStorage 是当前 SSOT，localStorage 是 legacy 迁移源，
        // 不清 localStorage 的话启动迁移会把它又拷回 sessionStorage。
        await page.addInitScript(() => {
            sessionStorage.removeItem("xihe-workspace");
            localStorage.removeItem("xihe-workspace");
        });
        await page.route("**/api/v1/workspaces", async (route) => {
            if (route.request().method() !== "GET") {
                await route.fallback();
                return;
            }
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([]),
            });
        });

        await page.goto("/workspace", { waitUntil: "load" });
        await expect(page.getByTestId("workspace-picker-empty")).toBeVisible({ timeout: 20000 });

        const shot = await shoot(page, "default2-picker.png");

        const create = await probe(page, '[data-testid="workspace-picker-create"]');
        const createContrast = contrastRatio(create.color, create.backgrounds);

        // 反馈②：中性 ghost —— 透明底 + 1px 边框 + 常规字重，不用 --action 填充。
        expect(create.background, "新建工作区 = 透明底（不是 --action 白底/蓝底）").toBe(
            "rgba(0, 0, 0, 0)",
        );
        expect(create.borderTopWidth, "ghost 必须有 1px 边框").toBeGreaterThanOrEqual(1);
        // --border = --border-subtle = rgba(22, 24, 29, 0.09)：实色改 alpha，直接比对计算值。
        expect(create.borderTopColor, "ghost 边框 = --border").toBe("rgba(22, 24, 29, 0.09)");
        expect(create.color, "ghost 文字 = --foreground").toBe(cssColor("#16181d"));
        expect(create.fontWeight, "常规字重（不是主按钮的 600）").toBe("400");
        expect(createContrast, "ghost 文字 ≥ 4.5:1").toBeGreaterThanOrEqual(4.5);

        writeMeasure("default2-picker", {
            scheme: DEFAULT_CASE.id,
            page: "picker",
            shot,
            ghostDowngrade: {
                before: "bg-action 实心（主按钮层级）",
                after: "透明底 + 1px --border 边框 + font-normal（L2 中性可操作）",
            },
            contrast: { createButton: createContrast },
            create,
        });
        expect(errors, `4xx/5xx 响应：\n${http.join("\n")}`).toEqual([]);
    });
});
