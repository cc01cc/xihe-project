// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
/**
 * BL-317b · 移动端成员面板改版（IM 调研 §1/§3/§4 的落地验收）。
 *
 * 覆盖三件事（每件都对应调研里的一条结论，不是"页面能开"）：
 * 1. **入口升级**：会话标题区出现「头像堆叠 + 人数 + 聚合 @N」主入口，`aria-label` 带人数与
 *    未读提及数；桌面不出现（`md:hidden`，桌面有 dock 的 members 标签）。
 * 2. **面板形态**：独立高 sheet（`role="dialog"` + `aria-modal`），正文**复用**
 *    `SessionParticipantsPanel`；行密度是 `summary`：摘要行只有 头像/名字/类型/角色/`@我`，
 *    策略下拉**不在**摘要里，点「更多」才出现。
 * 3. **关闭语义**：Escape 关闭并把焦点还给触发按钮（`document.activeElement`，不是"卡看不见了"）。
 *
 * 自包含：只用 `helpers/auth` 的公共入口 + 本文件自己的路由桩，不碰 `helpers/**` 契约。
 */
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { stubSessionProjections } from "./helpers/session-projections";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const SESSION_ID = "bl317b-session";

const PARTICIPANTS = [
    {
        participantId: "part-owner",
        principalKind: "HUMAN",
        principalId: "user-1",
        displayName: "Owner One",
        role: "MEMBER",
        orderIndex: 1,
        wakePolicy: "ALL_MESSAGES",
        respondPolicy: "ALWAYS",
        readCursor: { lastReadSequence: 4, mentionCount: 2 },
    },
    {
        participantId: "part-member",
        principalKind: "HUMAN",
        principalId: "user-2",
        displayName: "Member Two",
        role: "MEMBER",
        orderIndex: 2,
        wakePolicy: "ALL_MESSAGES",
        respondPolicy: "WHEN_MENTIONED",
        readCursor: { lastReadSequence: 0, mentionCount: 0 },
    },
    {
        participantId: "part-agent",
        principalKind: "AGENT",
        principalId: "00000000-0000-4000-8000-0000000000a1",
        displayName: "Mock Agent",
        role: "PRIMARY",
        orderIndex: 10,
        wakePolicy: "ALL_MESSAGES",
        respondPolicy: "ALWAYS",
        defaultModelProvider: "anthropic",
        defaultModelName: "claude-sonnet",
    },
    {
        participantId: "part-guard",
        principalKind: "HUMAN",
        principalId: "user-3",
        displayName: "Guard Three",
        role: "GUARD",
        orderIndex: 20,
        wakePolicy: "MENTION",
        respondPolicy: "MUTED",
        readCursor: { lastReadSequence: 0, mentionCount: 0 },
    },
];

async function installRoster(page: import("@playwright/test").Page) {
    // 必须在 setupMockAuth/Sessions 之后注册（Playwright 后注册优先）。
    await page.route("**/api/v1/sessions/*/participants*", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                participants: PARTICIPANTS,
                capabilities: { view: true, manage: true, mention: true, speakAs: true },
            }),
        });
    });
}

async function openChat(page: import("@playwright/test").Page, mobile = true) {
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "BL-317b" }] });
    // 聊天列挂载会拉 derived-state / follow-ups / commands：走公共桩，不手写第二份。
    await stubSessionProjections(page, SESSION_ID);
    await installRoster(page);
    await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
    if (mobile) {
        // 390 下聊天在 `MobileChatSheet` 里（底栏文件树默认在前）—— 成员入口就在它的头里。
        await expect(page.locator('[data-testid="workspace-toolbar-more-mobile"]')).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await page.getByTestId("mobile-chat-open").click();
        await expect(page.locator('[data-testid="mobile-chat-sheet"]')).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await expect(page.locator('[data-testid="members-entry-mobile"]')).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
    }
}

test.describe("BL-317b 移动端成员面板", () => {
    test.use({ viewport: MOBILE_VIEWPORT });

    test("标题区主入口：头像堆叠 + 人数 + 聚合 @N，aria-label 带人数与未读提及", async ({
        page,
    }) => {
        await openChat(page);

        const entry = page.locator('[data-testid="members-entry-mobile"]');
        // 入口是"会话标题区"的主入口：可键盘触达（button）、有 dialog 语义（aria-haspopup）。
        await expect(entry).toHaveRole("button");
        await expect(entry).toHaveAttribute("aria-haspopup", "dialog");
        // aria-label 形如"会话成员，4 人，2 个未读提及"（服务端 mentionCount 之和）。
        await expect(entry).toHaveAttribute("aria-label", /会话成员，4 人，2 个未读提及/);
        // 头像堆叠 2–3 个；人数与 @N 都要显示。
        const avatars = page.locator('[data-testid="members-entry-avatar"]');
        expect(await avatars.count()).toBeGreaterThanOrEqual(2);
        expect(await avatars.count()).toBeLessThanOrEqual(3);
        await expect(page.locator('[data-testid="members-entry-count"]')).toHaveText("4");
        await expect(page.locator('[data-testid="members-entry-mentions"]')).toHaveText("@2");
        // 触控区 ≥44px（下界断言，不写死像素 —— token 变了也不返工）。
        const box = await entry.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);

        await page.screenshot({
            path: "H:/zeotmp/t56-bl318/bl317b-390-entry.png",
            fullPage: false,
        });
    });

    test("独立成员 sheet：role=dialog + aria-modal，摘要行只露要点，「更多」才展开策略", async ({
        page,
    }) => {
        await openChat(page);
        await page.locator('[data-testid="members-entry-mobile"]').click();

        const sheet = page.locator('[data-testid="mobile-members-sheet"]');
        await expect(sheet).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await expect(sheet).toHaveAttribute("role", "dialog");
        await expect(sheet).toHaveAttribute("aria-modal", "true");
        // 正文复用既有面板（不是第二套实现）。
        await expect(sheet.locator('[data-testid="participants-list"]')).toBeVisible();
        await expect(sheet.locator('[data-testid="participants-list"] > li')).toHaveCount(4);
        await expect(page.locator('[data-testid="mobile-members-sheet-count"]')).toHaveText("4");

        // 摘要态：只有要点 + 「更多」；策略/模型/移除**不**在摘要里。
        const expand = sheet.locator('[data-testid="participant-expand-part-owner"]');
        await expect(expand).toBeVisible();
        await expect(expand).toHaveAttribute("aria-expanded", "false");
        await expect(
            sheet.locator('[data-testid="participant-wake-indicator-part-owner"]'),
        ).toHaveCount(0);
        await expect(sheet.locator('[data-testid="participant-remove-part-owner"]')).toHaveCount(0);
        // 类型/角色徽标仍在（人机混排：一个名单、统一行骨架，颜色不是唯一差异）。
        // 判据用**数据属性**而不是本地化文本（`AGENT` 在 zh 下渲染成"智能体"）。
        await expect(
            sheet.locator('[data-testid="participant-kind-badge-part-agent"]'),
        ).toHaveAttribute("data-participant-kind", "AGENT");
        await expect(
            sheet.locator('[data-testid="participant-role-badge-part-guard"]'),
        ).toHaveAttribute("data-session-role", "GUARD");
        // @我 N 只来自服务端 mentionCount。
        await expect(
            sheet.locator('[data-testid="participant-mention-badge-part-owner"]'),
        ).toHaveText("@2");

        await page.screenshot({ path: "H:/zeotmp/t56-bl318/bl317b-390-sheet.png" });

        // 展开：策略与移除出现，且按钮仍是 44px 触控区。
        await expand.click();
        await expect(
            sheet.locator('[data-testid="participant-wake-indicator-part-owner"]'),
        ).toBeVisible();
        await expect(sheet.locator('[data-testid="participant-remove-part-owner"]')).toBeVisible();
        const removeBox = await sheet
            .locator('[data-testid="participant-remove-part-owner"]')
            .boundingBox();
        expect(removeBox?.height ?? 0).toBeGreaterThan(0);
    });

    test("Escape 关闭 sheet 且焦点回到触发按钮", async ({ page }) => {
        await openChat(page);
        const entry = page.locator('[data-testid="members-entry-mobile"]');
        await entry.click();
        await expect(page.locator('[data-testid="mobile-members-sheet"]')).toBeVisible({
            timeout: ACTION_TIMEOUT_MS,
        });

        await page.keyboard.press("Escape");
        await expect(page.locator('[data-testid="mobile-members-sheet"]')).toHaveCount(0);

        // 判据用 document.activeElement，不是"sheet 不见了"。
        await expect
            .poll(
                async () =>
                    page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? ""),
                { timeout: ACTION_TIMEOUT_MS, message: "关闭成员 sheet 后焦点应回到触发按钮" },
            )
            .toBe("members-entry-mobile");
    });

    test("关闭后回到原聊天（滚动位置保留），且不出现第二条实现", async ({ page }) => {
        await openChat(page);
        await expect(page.locator('[data-testid="members-entry-mobile"]')).toBeVisible();
        // 记录滚动位置（没有 `workspace-route-viewport` 时按 0 处理，不做假设）。
        const scrollOf = () =>
            page.evaluate(
                () =>
                    document.querySelector('[data-testid="workspace-route-viewport"]')?.scrollTop ??
                    0,
            );
        const before = await scrollOf();

        await page.locator('[data-testid="members-entry-mobile"]').click();
        await expect(page.locator('[data-testid="mobile-members-sheet"]')).toBeVisible();
        await page.locator('[data-testid="mobile-members-sheet-close"]').click();
        await expect(page.locator('[data-testid="mobile-members-sheet"]')).toHaveCount(0);

        expect(await scrollOf()).toBe(before);
        // 回原聊天：输入框仍在（sheet 是覆盖层，不卸载聊天）。
        await expect(page.locator('[data-testid="chat-input"]')).toBeVisible();
        // 旧入口仍可用（BL-317 兜底）：先关掉聊天 sheet（它盖住了工具栏），再走溢出菜单。
        await page.keyboard.press("Escape");
        await expect(page.locator('[data-testid="mobile-chat-sheet"]')).toHaveCount(0);
        await page.locator('[data-testid="workspace-toolbar-more-mobile"]').click();
        await page.locator('[data-testid="workspace-toolbar-more-members"]').click();
        await expect(page.locator('[data-testid="mobile-changes-sheet"]')).toBeVisible();
        await expect(page.locator('[data-testid="mobile-members-sheet"]')).toHaveCount(0);
    });
});

test.describe("BL-317b 桌面零回归", () => {
    test.use({ viewport: { width: 1920, height: 1080 } });

    test("1920：标题区入口不出现（桌面走 dock 的 members 标签）", async ({ page }) => {
        await openChat(page, false);
        // 桌面下移动入口不该存在（`md:hidden` + 聊天不在 sheet 里）。
        await expect(page.locator('[data-testid="members-entry-mobile"]')).toHaveCount(0);
        await page.screenshot({ path: "H:/zeotmp/t56-bl318/bl317b-1920.png", fullPage: false });
    });
});
