import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";

// BL-318：本文件验的就是 MCP 侧错误码（503 运行时不可用 / 400 未知工具），逐条放行 `/api/v1/mcp`。
test.use({ mockAllow: [...DEFAULT_MOCK_ALLOW, String.raw`/api/v1/mcp`] });

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
    // The chat panel on the workspace page also projects the session's derived
    // state and follow-up queue. The shared session route falls through to a 404
    // for those two sub-paths, which would make the console-error assertion below
    // fail on a fixture gap instead of on the file-tree copy under test.
    await page.route("**/api/v1/sessions/*/derived-state", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                sessionId: "session-1",
                activeChildren: [],
                terminalNotices: [],
            }),
        });
    });
    await page.route("**/api/v1/sessions/*/follow-ups", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                sessionId: "session-1",
                queueState: "empty",
                outstandingCount: 0,
                capacityLimit: 8,
                pauseReason: null,
                items: [],
            }),
        });
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

/**
 * Uncaught app errors must stay at zero while a dependency failure renders. The
 * stubbed 503/400 shows up as the browser's own "Failed to load resource" console
 * line, so only that line is ignored.
 */
function watchPageErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
        if (message.type() !== "error") return;
        if (/Failed to load resource/.test(message.text())) return;
        errors.push(message.text());
    });
    return errors;
}

test("runtime unavailable shows runtime copy, not unknown-tool copy", async ({ page }) => {
    const pageErrors = watchPageErrors(page);
    await setupPage(page, RUNTIME_UNAVAILABLE);
    await page.goto("/workspace/workspace-1");

    await expect(page.getByText(/工作区运行时未就绪/)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/工具不存在或未启用/)).toHaveCount(0);
    await expect(page.getByTestId("workspace-tree-error-message")).toBeVisible();
    expect(pageErrors).toEqual([]);
    saveScreenshot(await page.screenshot({ fullPage: true }), "m5-browser-runtime-unavailable.png");
});

test("unknown tool shows the missing-tool copy", async ({ page }) => {
    const pageErrors = watchPageErrors(page);
    await setupPage(page, UNKNOWN_TOOL);
    await page.goto("/workspace/workspace-1");

    await expect(page.getByText(/工具不存在或未启用/)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/工作区运行时未就绪/)).toHaveCount(0);
    await expect(page.getByTestId("workspace-tree-error-message")).toBeVisible();
    expect(pageErrors).toEqual([]);
});

test.describe("mobile viewport", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("runtime unavailable copy fits without overflow", async ({ page }) => {
        const pageErrors = watchPageErrors(page);
        await setupPage(page, RUNTIME_UNAVAILABLE);
        await page.goto("/workspace/workspace-1");
        // The file panel is collapsed on mobile until the toolbar toggle opens it.
        await page.getByTestId("workspace-toolbar-files-mobile").click();

        const banner = page.getByTestId("mobile-files-sheet").getByText(/工作区运行时未就绪/);
        await expect(banner).toBeVisible({ timeout: 15000 });
        const box = await banner.boundingBox();
        expect(box?.width ?? 0).toBeLessThanOrEqual(390);
        expect(pageErrors).toEqual([]);
        saveScreenshot(
            await page.screenshot({ fullPage: true }),
            "m5-browser-runtime-unavailable-mobile.png",
        );
    });
});
