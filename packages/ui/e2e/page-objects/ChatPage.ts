import { expect, type Page, type Locator } from "@playwright/test";

export class ChatPage {
    readonly page: Page;
    readonly input: Locator;
    readonly sendButton: Locator;
    readonly stopButton: Locator;
    readonly scrollerViewport: Locator;
    readonly scrollerButton: Locator;
    readonly fileInput: Locator;
    readonly uploadIndicator: Locator;

    constructor(page: Page) {
        this.page = page;
        this.input = page.locator('[data-testid="chat-input"]');
        this.sendButton = page.locator('[data-testid="chat-send-button"]');
        this.stopButton = page.locator('[data-testid="chat-stop-button"]');
        this.scrollerViewport = page.locator('[data-testid="message-scroller-viewport"]');
        this.scrollerButton = page.locator('[data-testid="message-scroller-button"]');
        this.fileInput = page.locator('[data-testid="file-upload-input"]');
        this.uploadIndicator = page.locator('[data-testid="attachment-uploading-indicator"]');
    }

    /** mock 车道种入的工作区 id（`e2e/mock/helpers/auth.ts:246 MOCK_WORKSPACE_ID`）。
     *
     * <p>task-142：默认值曾是 `"workspace-1"` —— 不是 UUID。task-537 在 `src/router/index.ts:610`
     * 用 `isUuid` 守卫路由里的工作区 id，非 UUID 就判「工作区链接无效」并回列表页，
     * 聊天页因此永不挂载（症状是整个测试打满 30 s 超时）。`src/lib/__tests__/uuid.spec.ts:21`
     * 已经`expect(isUuid("workspace-1")).toBe(false)` 把这条钉住 —— 错的是夹具默认值，不是产品守卫。</p>
     *
     * <p>**写字面量而不 import 夹具常量**：本 page object 同时被 `e2e/real/**` 使用，
     * 反向依赖 `e2e/mock/helpers` 会把真实链路绑到 mock 车的种子上（方向反了）。
     * 显式传 workspaceId 的调用方（`e2e/real/attachment-preview-budget.spec.ts:741/:850`）不受影响。</p>
     */
    async goto(
        sessionId?: string,
        workspaceId = "11111111-1111-4111-8111-111111111111",
    ): Promise<void> {
        const path = sessionId ? `/workspace/${workspaceId}/session/${sessionId}` : "/workspace";
        await this.page.goto(path);
        await this.input.waitFor({ state: "visible" });
    }

    async attachFiles(
        filePaths: (string | { name: string; mimeType: string; buffer: Buffer })[],
    ): Promise<void> {
        await this.fileInput.setInputFiles(filePaths);
    }

    async sendMessage(text: string): Promise<void> {
        await this.input.fill(text);
        await this.input.press("Enter");
    }

    messageLocator(text: string): Locator {
        return this.page.locator("text=" + text);
    }

    attachmentLocator(name: string): Locator {
        return this.page.locator('[data-testid="message-attachment"]', { hasText: name });
    }

    async scrollToTop(): Promise<void> {
        await this.scrollerViewport.evaluate((el) => {
            // Mark the movement as user initiated so auto-scroll does not restore the end.
            el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
            el.scrollTop = 0;
            el.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
    }

    async isScrollerButtonActive(): Promise<boolean> {
        const active = await this.scrollerButton.getAttribute("data-active");
        return active === "true";
    }

    async expectScrollerButtonActive(): Promise<void> {
        await expect(this.scrollerButton).toHaveAttribute("data-active", "true");
    }

    async expectScrollerButtonInactive(): Promise<void> {
        await expect(this.scrollerButton).toHaveAttribute("data-active", "false");
    }

    async clickScrollerButton(): Promise<void> {
        await this.scrollerButton.click();
    }
}
