import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";

/**
 * PLAN-0557/BL-109 browser evidence: the workspace file panel must distinguish
 * "dependency unavailable" from "unknown tool" in the visible error copy.
 *
 * This is a mock E2E for the UI mapping; CP-side classification is covered by
 * `McpProxyTest` and the unreachable-stub evidence in the PLAN directory.
 */

const EVIDENCE_DIR = path.resolve(
    process.cwd(),
    "../../../../../plans/PLAN-0557-XH-mcp-failure-classification/evidence",
);

interface ProblemFixture {
    status: number;
    code: string;
    detail: string;
    reason?: string;
    dependency?: string;
    retryable?: boolean;
}

const RUNTIME_UNAVAILABLE: ProblemFixture = {
    status: 503,
    code: "RUNTIME_UNAVAILABLE",
    detail: "Workspace runtime is unavailable; retry after the service starts",
    reason: "unreachable",
    dependency: "runtime",
    retryable: true,
};

const UNKNOWN_TOOL: ProblemFixture = {
    status: 400,
    code: "UNKNOWN_TOOL",
    detail: "Requested tool is not available in this workspace",
};

async function setupPage(
    page: import("@playwright/test").Page,
    problem: ProblemFixture,
): Promise<void> {
    await setupMockAuth(page);
    await setupMockSessions(page, {
        sessions: [{ id: "session-1", title: "Session 1" }],
        messages: { "session-1": [] },
    });
    await page.route("**/mcp", async (route) => {
        const body = route.request().postDataJSON() as {
            method?: string;
            params?: { name?: string };
        };
        if (body?.method !== "tools/call" || body?.params?.name !== "list_directory") {
            await route.fallback();
            return;
        }
        await route.fulfill({
            status: problem.status,
            contentType: "application/problem+json",
            body: JSON.stringify({
                type: `https://xihe.dev/problems/${problem.code.toLowerCase()}`,
                title: "Request failed",
                status: problem.status,
                code: problem.code,
                detail: problem.detail,
                requestId: "req-plan-0557",
                ...(problem.dependency ? { dependency: problem.dependency } : {}),
                ...(problem.reason ? { reason: problem.reason } : {}),
                ...(problem.retryable === undefined ? {} : { retryable: problem.retryable }),
            }),
        });
    });
}

function saveScreenshot(buffer: Buffer, name: string): void {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE_DIR, name), buffer);
}

test("runtime unavailable shows runtime copy, not unknown-tool copy", async ({ page }) => {
    await setupPage(page, RUNTIME_UNAVAILABLE);
    await page.goto("/workspace/workspace-1");

    await expect(page.getByText(/工作区运行时未就绪/)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/工具不存在或未启用/)).toHaveCount(0);
    saveScreenshot(await page.screenshot({ fullPage: true }), "m5-browser-runtime-unavailable.png");
});

test("unknown tool shows the missing-tool copy", async ({ page }) => {
    await setupPage(page, UNKNOWN_TOOL);
    await page.goto("/workspace/workspace-1");

    await expect(page.getByText(/工具不存在或未启用/)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/工作区运行时未就绪/)).toHaveCount(0);
});

test.describe("mobile viewport", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("runtime unavailable copy fits without overflow", async ({ page }) => {
        await setupPage(page, RUNTIME_UNAVAILABLE);
        await page.goto("/workspace/workspace-1");
        // The file panel is collapsed on mobile until the toolbar toggle opens it.
        await page.getByTestId("workspace-toolbar-files-mobile").click();

        const banner = page.getByTestId("mobile-files-sheet").getByText(/工作区运行时未就绪/);
        await expect(banner).toBeVisible({ timeout: 15000 });
        const box = await banner.boundingBox();
        expect(box?.width ?? 0).toBeLessThanOrEqual(390);
        saveScreenshot(
            await page.screenshot({ fullPage: true }),
            "m5-browser-runtime-unavailable-mobile.png",
        );
    });
});
