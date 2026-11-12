import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";
import { expectPlatformScreenshot } from "../helpers/visual";

// BL-318：`shows error state with retry button` 故意桩 500（验知识库错误态 + 重试），
// 逐条放行 `/rag/stats` 的失败信号。
test.use({ mockAllow: [...DEFAULT_MOCK_ALLOW, String.raw`/rag/stats`] });

const DOCS = [
    { id: "doc-1", filename: "requirements.pdf", chunks: 5 },
    { id: "doc-2", filename: "architecture.md", chunks: 12 },
    { id: "doc-3", filename: "notes.txt", chunks: 3 },
];

// PLAN-0752 T4.4（task-91）：知识库**只有工作区承载**（CP 无库表，按 workspace 分区），
// 旧 user 层入口 `/settings/knowledge` 已改成工作区重定向 —— 没有工作区上下文时直接回选择面，
// 所以从这条 URL 出发永远看不到面板。这四个状态用例要验的组件（`KnowledgeBaseView`）没有变，
// 变的是**它挂在哪**：工作区设置的「知识库」tab（`WorkspaceSettingsView` 的 `ws-settings-knowledge`）。
// 断言逐条保留（空态 / 错误重试 / 加载中 / 文档列表 + 删除按钮），只把入口换到当前产品路径。
//
// task-209（D-1019）：那条 tab 已撤（工作区设置只保留「常规/成员」）⇒ **本文件暂时没有可达入口**。
// 处置：整组 `fixme`，**断言一行不删**（用例体原样保留，等于可执行的注释：那条 tab 一旦挂回来，
// 这里立刻重新变绿）。同批把「列表 + 删除 + 上传」三条行为搬到组件级
// `src/components/__tests__/KnowledgeBaseView.spec.ts`，能力暂时没有入口但行为仍被钉住。
// 重新启用的条件：`KnowledgeBaseView` 重新有可达挂载点（见回执「工作区知识库写面重接」建议）。
const KNOWLEDGE_PAGE = "/workspace/workspace-1/settings?tab=knowledge";

test.describe.fixme("Knowledge Base（task-209：挂载点已撤，等重接）", () => {
    test.beforeEach(async ({ page }) => {
        // 工作区路由需要登录态 + 工作区上下文（`workspace-1` 由夹具种入 tab 会话上下文）。
        await setupMockAuth(page);
    });

    test("shows empty state with drop zone", async ({ page }) => {
        await page.route("**/api/v1/**", (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({}),
            }),
        );
        await page.route("**/api/v1/events**", (route) =>
            route.fulfill({
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
                body: "retry: 5000\n\n",
            }),
        );
        await page.route("**/api/v1/rag/stats", (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ documents: [] }),
            }),
        );
        await page.goto(KNOWLEDGE_PAGE, { waitUntil: "load" });
        await page.waitForTimeout(1500);
        await expect(page.locator("text=暂无文档")).toBeVisible();
        await expectPlatformScreenshot(page, "knowledge-empty.png");
    });

    test("shows error state with retry button", async ({ page }) => {
        await page.route("**/api/v1/events**", (route) =>
            route.fulfill({
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
                body: "retry: 5000\n\n",
            }),
        );
        await page.route("**/api/v1/**", (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({}),
            }),
        );
        await page.route("**/api/v1/rag/stats", (route) =>
            route.fulfill({ status: 500, body: "Server error" }),
        );
        await page.goto(KNOWLEDGE_PAGE, { waitUntil: "load" });
        await page.waitForTimeout(1000);
        await expect(page.locator("text=Retry")).toBeVisible();
        await expectPlatformScreenshot(page, "knowledge-error.png");
    });

    test("shows loading state", async ({ page }) => {
        await page.route("**/api/v1/**", (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({}),
            }),
        );
        await page.route("**/api/v1/events**", (route) =>
            route.fulfill({
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
                body: "retry: 5000\n\n",
            }),
        );
        await page.route("**/api/v1/rag/stats", async (route) => {
            await new Promise((r) => setTimeout(r, 2000));
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ documents: [] }),
            });
        });
        await page.goto(KNOWLEDGE_PAGE, { waitUntil: "load" });
        await expect(page.locator("text=Loading documents")).toBeVisible();
        await expectPlatformScreenshot(page, "knowledge-loading.png");
    });

    test("lists documents with delete button", async ({ page }) => {
        await page.route("**/api/v1/events**", (route) =>
            route.fulfill({
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
                body: "retry: 5000\n\n",
            }),
        );
        await page.route("**/api/v1/**", (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({}),
            }),
        );
        await page.route("**/api/v1/rag/stats", (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ documents: DOCS }),
            }),
        );
        await page.goto(KNOWLEDGE_PAGE, { waitUntil: "load" });
        await page.waitForTimeout(1500);
        await expect(page.locator("text=requirements.pdf")).toBeVisible();
        await expect(page.locator("text=architecture.md")).toBeVisible();
        await expect(page.locator("text=notes.txt")).toBeVisible();
        await expect(page.locator('button:has-text("删除")')).toHaveCount(3);
        await expectPlatformScreenshot(page, "knowledge-documents.png");
    });
});
