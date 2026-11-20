// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
/**
 * BL-339 · 深链预填（`?compose=<base64url(JSON)>`）的 mock E2E。
 *
 * 产品口径：外部入口（托盘 / 通知 / CLI / 别的应用）能把「要发的内容 + 目标主体」带进来，
 * 但**只预填、绝不代发**。本 spec 用 mock 夹具自包含地证三件事：
 *  1. 带参打开 ⇒ composer 里有预填文本；
 *  2. 预填后 URL 里的 `compose` 已经消失（刷新/后退都不会重复预填）；
 *  3. **没有自动发送**：消息条数保持 0，且没有任何 `/chat` 发送请求。
 *
 * 不碰 `helpers/**`：全部复用既有 `setupMockAuth` / `setupMockSessions`。
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { participantRoster } from "./helpers/session-projections";
import { LONG_TIMEOUT_MS } from "../timeouts";

const SESSION_ID = "bl339-session";

/** TO 栏里的收件人 chip（限定作用域：裸 `[data-participant-id]` 会命中 speak-as 等其它字段）。 */
function toChip(page: Page, participantId: string) {
    return page.locator(`[data-testid="to-targets-chip"][data-participant-id="${participantId}"]`);
}

/** UTF-8 JSON → base64url（与外部入口的拼法一致：`-`/`_`、无 padding）。 */
function encodeCompose(payload: unknown): string {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

test.describe("BL-339 深链预填", () => {
    test("带 compose 打开 ⇒ composer 预填、URL 清参、未自动发送", async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "BL-339" }] });

        // 计数发送请求：预填不等于发送。
        let chatRequests = 0;
        await page.route("**/api/v1/sessions/*/chat", async (route) => {
            chatRequests += 1;
            await route.fulfill({
                status: 202,
                contentType: "application/json",
                body: JSON.stringify({ accepted: true }),
            });
        });

        const compose = encodeCompose({
            text: "来自托盘的预填内容：帮我核对这条绑定",
            sessionId: SESSION_ID,
        });
        await page.goto(
            `/workspace/11111111-1111-4111-8111-111111111111/session/${SESSION_ID}?compose=${compose}`,
        );

        const input = page.getByTestId("chat-input");
        await expect(input).toHaveValue("来自托盘的预填内容：帮我核对这条绑定", {
            timeout: LONG_TIMEOUT_MS,
        });

        // 立刻清参：URL 不再携带 compose（刷新不会重复预填）。
        await expect.poll(() => new URL(page.url()).searchParams.has("compose")).toBe(false);

        // 未自动发送：消息列表为空，且没有发生 /chat 请求。
        await expect(page.getByTestId("message-list").getByTestId("message-item")).toHaveCount(0);
        expect(chatRequests).toBe(0);
    });

    test("非法载荷 ⇒ 静默忽略（composer 空、URL 清参、无请求、不打断）", async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "BL-339 bad" }] });

        let chatRequests = 0;
        await page.route("**/api/v1/sessions/*/chat", async (route) => {
            chatRequests += 1;
            await route.fulfill({ status: 202, contentType: "application/json", body: "{}" });
        });

        const warnSpy: string[] = [];
        page.on("console", (message) => {
            if (message.type() === "warning") warnSpy.push(message.text());
        });

        // `text` 缺失 ⇒ 整条忽略。
        await page.goto(
            `/workspace/11111111-1111-4111-8111-111111111111/session/${SESSION_ID}?compose=${encodeCompose({ to: ["x"] })}`,
        );

        await expect(page.getByTestId("chat-input")).toHaveValue("", { timeout: LONG_TIMEOUT_MS });
        await expect.poll(() => new URL(page.url()).searchParams.has("compose")).toBe(false);
        expect(chatRequests).toBe(0);
        expect(warnSpy.some((text) => text.includes("[compose-deeplink]"))).toBe(true);
    });

    /**
     * task-113 第 0 步（BL-339，2026-11-15）：**名册未就绪时，整条深链不得被消费**。
     *
     * <p>缺陷（task-111 定位，file:line 见卡）：`InputArea.prefillDraft` 用 `participants ?? []` 当候选过滤
     * ⇒ store 的「未加载」（`participants === null`）被折叠成「空」⇒ `to`/`cc` 里的 id **全被滤掉却不报错**；
     * 而 `ChatPanel` 把 `applied`/`idle` 都当已消费 ⇒ `compose` 参数被 `replace` 清掉 ⇒ **收件人永久丢失**，
     * 重开同一链接也不会再预填；wire 上 `toTargetsPayload` 退化成 `undefined`（省略键）⇒ CP 走默认响应者
     * ⇒ **消息发给默认对象而不是深链指定的人**。</p>
     *
     * <p>怎么让「未加载」可复现而**不靠 sleep**：在 `setupMockAuth` 的默认参与者投影**之后**再注册一条
     * `participants` 路由（Playwright 后注册优先）并**故意不 fulfill** ⇒ 请求保持 pending，等价于冷启动/慢网。
     * 用例末段再手动 fulfill 名册，用来表达「修好后应补齐」这个目标态。</p>
     */
    test("名册未返回时 to/cc 不得被静默丢弃（compose 参数必须保留）", async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, {
            sessions: [{ id: SESSION_ID, title: "BL-339 slow roster" }],
        });

        const TEXT = "来自托盘的预填内容：请转给 Mock Agent";
        const TO_ID = "participant-agent";
        // task-113 B 步：这条链路上原本没有任何观察面（`InputArea.vue` 里 `console.*` 零命中），
        // 所以 warn 必须被收下来当证据，否则「静默」只能靠读源码断言。
        const warnings: string[] = [];
        page.on("console", (message) => {
            if (message.type() === "warning") warnings.push(message.text());
        });
        let participantsRequests = 0;
        let heldRoute: Route | null = null;
        await page.route("**/api/v1/sessions/*/participants", (route) => {
            participantsRequests += 1;
            // 不 fulfill ⇒ 名册保持「未加载」（这是本用例要复现的状态，不是疏忽）
            heldRoute = route;
        });

        // 只带 `to`：同一个 id 再放进 `cc` 会被 cc 候选按「已在 TO 里」去重掉，
        // 那会变成「部分命中」，与本用例要证的「名册未到」混在一起（两个原因都该 blocked，但读数会混）。
        const compose = encodeCompose({ text: TEXT, sessionId: SESSION_ID, to: [TO_ID] });
        await page.goto(
            `/workspace/11111111-1111-4111-8111-111111111111/session/${SESSION_ID}?compose=${compose}`,
        );

        // 正文已预填 ⇒ 深链确实被消费过（否则下面「参数还在」无从谈起）
        await expect(page.getByTestId("chat-input")).toHaveValue(TEXT, {
            timeout: LONG_TIMEOUT_MS,
        });
        expect(participantsRequests, "名册请求必须真的发过，否则本用例什么都没测").toBeGreaterThan(
            0,
        );

        // B 步判据：丢弃必须被点名，且 warn 必须能区分「名册还没到」与「名册里没这人」。
        await expect
            .poll(() => warnings.filter((text) => text.includes("[compose-deeplink]")), {
                timeout: 3_000,
            })
            .not.toHaveLength(0);
        const warnText = warnings.filter((text) => text.includes("[compose-deeplink]")).join("\n");
        expect(warnText, "warn 必须点名原因（两种之一）").toMatch(/名册尚未加载|名册已加载/);
        await test.info().attach("compose-deeplink warnings", {
            body: warnText,
            contentType: "text/plain",
        });
        // 未就绪时不该有收件人 chip（**必须限定 TO 栏**：裸 [data-participant-id] 会命中 speak-as 等其它字段）
        await expect(toChip(page, TO_ID)).toHaveCount(0);

        // A 步判据 1：名册没到 ⇒ **不消费**，参数必须还在（B 步时这里红：清参了）
        await expect
            .poll(() => new URL(page.url()).searchParams.has("compose"), { timeout: 3_000 })
            .toBe(true);

        // A 步判据 2：名册到达 ⇒ 重试并**补齐**（toTargetsTouched 仍为 false，但 chip 已落座）
        expect(heldRoute, "被挂住的那条路由必须存在").not.toBeNull();
        await heldRoute!.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                participants: participantRoster(),
                capabilities: { view: true, manage: true, mention: true, speakAs: true },
            }),
        });
        await expect(toChip(page, TO_ID)).toHaveCount(1, { timeout: LONG_TIMEOUT_MS });
        // A 步判据 3：真正写进收件人之后才允许清参（此前保留是"未消费"标记）
        await expect
            .poll(() => new URL(page.url()).searchParams.has("compose"), { timeout: 3_000 })
            .toBe(false);
    });

    /**
     * task-113 A 步判据（第三形态）：**名册已加载但 id 不在册 ⇒ 一个都不写 + 保留参数**。
     *
     * <p>这是「全有或全无」的判别用例：旧行为会把命中的那个填上去、漏掉的静默丢 ⇒ 用户看到 1 个
     * chip 就以为通知了 2 个人。断言：①没有 chip ②warn 走「名册已加载」分支（与「尚未加载」可区分）
     * ③**参数被消费** ④用户可见提示点名 **id**（不是「部分收件人无效」这种没点名的话）。</p>
     *
     * <p>**规格变更（task-126 F3，2026-11-15）**：本条此前断言「参数保留（可重试）」。那个期望把
     * **不可满足**（这些 id 永远不在本会话名册里）与 **可满足但还没到**（名册未加载）钉成了同一形态 ⇒
     * 深链参数**永久滞留 URL**、每次重试刷一条 warn、界面零提示。现在按「能不能满足」分流：
     * 名册未到 ⇒ 保留参数等重试（见上一条用例）；id 不在册 ⇒ 消费参数 + 提示一次。
     * **这不是放宽断言**：可观测的东西从 1 项（参数在）变成 3 项（参数被消费 + 提示出现 + 提示点名 id），
     * 且新增了「warn 只刷一次」的计数断言。</p>
     */
    test("部分 id 不在册 ⇒ 一个都不写、消费参数、提示点名 id", async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "BL-339 partial" }] });

        const warnings: string[] = [];
        page.on("console", (message) => {
            if (message.type() === "warning") warnings.push(message.text());
        });
        const TEXT = "来自托盘的预填内容：请转给 Mock Agent 和这个人";
        const KNOWN = "participant-agent";
        const GHOST = "participant-ghost-not-in-roster";
        const compose = encodeCompose({ text: TEXT, sessionId: SESSION_ID, to: [KNOWN, GHOST] });
        await page.goto(
            `/workspace/11111111-1111-4111-8111-111111111111/session/${SESSION_ID}?compose=${compose}`,
        );

        await expect(page.getByTestId("chat-input")).toHaveValue(TEXT, {
            timeout: LONG_TIMEOUT_MS,
        });
        await expect
            .poll(() => warnings.filter((text) => text.includes("[compose-deeplink]")).join("\n"), {
                timeout: 3_000,
            })
            .toContain("名册已加载");
        // 全有或全无：命中的那个也不许写。
        await expect(toChip(page, KNOWN)).toHaveCount(0);

        // 不可满足 ⇒ **参数必须被消费**（否则永久滞留 URL、每次路由变化都重试刷 warn）。
        await expect
            .poll(() => new URL(page.url()).searchParams.has("compose"), { timeout: 3_000 })
            .toBe(false);

        // 用户可见提示：一句话说清「发生了什么 + 点名 id」，第二句说清「为什么是 id + 该做什么」。
        const hint = page.getByTestId("compose-deeplink-unsat-hint");
        await expect(hint).toHaveCount(1, { timeout: LONG_TIMEOUT_MS });
        await expect(hint).toContainText("1 个收件人不在本会话，已忽略");
        await expect(hint).toContainText(GHOST);
        await expect(hint).toContainText("按 id 展示是因为名册里查不到这些人，请手动确认收件人");
        // 提示里**不许**出现命中的那个 id（只点名被丢的）。
        await expect(hint).not.toContainText(KNOWN);

        // warn 只刷一次（钉的正是 F3 的「永久重试」病）：
        // 本页会先出现 1 条「名册尚未加载」（第一跳时名册在途，那是可重试态，按设计要留痕），
        // 名册到达后的**不可满足** warn 只许出现 1 次 —— 因为消费参数后 `applied` 置真，
        // 后续 ready/retryKey 变化会在 watch 里短路，不可能再刷。
        const unsatWarns = warnings.filter(
            (text) => text.includes("[compose-deeplink]") && text.includes("名册已加载"),
        );
        expect(
            unsatWarns.length,
            `不可满足的 warn 必须只出现一次；实际：${unsatWarns.join(" | ")}`,
        ).toBe(1);
        expect(unsatWarns[0]).toContain(GHOST);
        expect(unsatWarns[0]).not.toContain(KNOWN);

        // 一次性：用户关掉后不再自己回来。
        await page.getByTestId("compose-deeplink-unsat-dismiss").click();
        await expect(hint).toHaveCount(0, { timeout: 3_000 });
    });

    /**
     * task-126 F4：**「名册到达后重试」这条承重跳此前没有用例钉住**。
     *
     * <p>`InputArea.prefillDraft` 里 `input.value === next.text ⇒ applied` 的幂等分支是它成立的前提：
     * 没有它，重试时正文已被自己写过 ⇒ 判成「用户已输入」⇒ `blocked` ⇒ 参数永远清不掉（缺陷以新机制复活）。
     * `dsd-1` 标的是「删掉大概没有用例会红」——本条就是为了让删掉它会红。</p>
     */
    test("名册到达后重试 ⇒ 参数被清、正文不重复", async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "BL-339 retry" }] });

        const TEXT = "来自托盘的预填内容：名册稍后才到";
        const TO_ID = "participant-agent";
        let heldRoute: Route | null = null;
        await page.route("**/api/v1/sessions/*/participants", (route) => {
            heldRoute = route; // 先挂住 ⇒ 第一跳只能 blocked
        });
        const compose = encodeCompose({ text: TEXT, sessionId: SESSION_ID, to: [TO_ID] });
        await page.goto(
            `/workspace/11111111-1111-4111-8111-111111111111/session/${SESSION_ID}?compose=${compose}`,
        );
        const input = page.getByTestId("chat-input");
        await expect(input).toHaveValue(TEXT, { timeout: LONG_TIMEOUT_MS });
        await expect
            .poll(() => new URL(page.url()).searchParams.has("compose"), { timeout: 3_000 })
            .toBe(true);

        expect(heldRoute, "被挂住的那条路由必须存在").not.toBeNull();
        await heldRoute!.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                participants: participantRoster(),
                capabilities: { view: true, manage: true, mention: true, speakAs: true },
            }),
        });

        // 重试成功：参数被清 + 收件人落座。
        await expect
            .poll(() => new URL(page.url()).searchParams.has("compose"), {
                timeout: LONG_TIMEOUT_MS,
            })
            .toBe(false);
        await expect(toChip(page, TO_ID)).toHaveCount(1, { timeout: LONG_TIMEOUT_MS });
        // 正文**不重复**：`toHaveValue` 是等值断言，出现 "TEXTTEXT" 会红。
        await expect(input).toHaveValue(TEXT, { timeout: LONG_TIMEOUT_MS });
    });
});
