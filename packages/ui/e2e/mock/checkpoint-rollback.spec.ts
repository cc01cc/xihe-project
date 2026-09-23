import { test, expect, type Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORKSPACE_ID = "workspace-1";
const SLICE_REF = "refs/xihe/workspace/slice-b";
const CHECKPOINT_FILE_TEXT = "const answer = 1\n";
const CURRENT_FILE_TEXT = "const answer = 2\n";

interface MockState {
    checkpoints: Array<Record<string, unknown>>;
    preview: Record<string, unknown>;
    result: Record<string, unknown>;
    gitStatus: Record<string, unknown>;
    messages: Record<string, Array<Record<string, unknown>>>;
    listCalls: number;
    previewCalls: number;
    executeBodies: Array<Record<string, unknown>>;
    blobCalls: Array<{ sliceRef: string | null; path: string | null }>;
    cleanupCalls: number;
}

function checkpoint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: "checkpoint-b",
        sliceRef: SLICE_REF,
        capturedAt: "2026-09-15T10:00:00Z",
        sourceRunId: RUN_ID,
        sourceSessionId: SESSION_ID,
        predecessorRef: null,
        state: "captured",
        changedCount: 3,
        changedFiles: [
            { status: "M", path: "src/parser.ts" },
            { status: "A", path: "src/index.ts" },
            { status: "D", path: "src/legacy.ts" },
        ],
        opaqueNestedRepos: ["vendor/nested"],
        unrollableReason: null,
        truncated: false,
        revert: null,
        ...overrides,
    };
}

function createState(): MockState {
    return {
        checkpoints: [checkpoint()],
        preview: {
            sliceRef: SLICE_REF,
            counts: { restore: 2, delete: 1, typeConflict: 1 },
            entries: [
                { path: "src/parser.ts", action: "restore", state: "execute" },
                { path: "src/legacy.ts", action: "delete", state: "execute" },
                {
                    path: "src/conflict.ts",
                    action: "restore",
                    state: "type_conflict",
                    reason: "TYPE_CHANGED",
                },
            ],
            truncated: false,
            opaqueNestedRepos: ["vendor/lib"],
        },
        result: {
            sliceRef: SLICE_REF,
            counts: { restored: 1, deleted: 1, failed: 1 },
            entries: [
                { path: "src/parser.ts", outcome: "restored" },
                { path: "src/legacy.ts", outcome: "deleted" },
                { path: "src/conflict.ts", outcome: "failed", reason: "WRITE_FAILED" },
            ],
            durationMs: 1500,
            suspects: ["src/conflict.ts"],
        },
        gitStatus: {
            isRepository: true,
            entries: [
                { status: "M", path: "README.md" },
                { status: "??", path: "notes/draft.md" },
                { status: "M", path: "src/parser.ts" },
            ],
        },
        messages: {
            [SESSION_ID]: [
                {
                    id: "msg-1",
                    sessionId: SESSION_ID,
                    role: "user",
                    content: "修复 parser",
                    createdAt: "2026-09-15T09:59:00Z",
                },
                {
                    id: "msg-2",
                    sessionId: SESSION_ID,
                    role: "assistant",
                    content: "已完成修改。",
                    createdAt: "2026-09-15T10:00:00Z",
                    runId: RUN_ID,
                    runStatus: "succeeded",
                },
            ],
        },
        listCalls: 0,
        previewCalls: 0,
        executeBodies: [],
        blobCalls: [],
        cleanupCalls: 0,
    };
}

async function installCheckpointRoutes(page: Page, state: MockState) {
    await page.route("**/api/v1/workspaces/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname.endsWith("/checkpoints") && request.method() === "GET") {
            state.listCalls += 1;
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(state.checkpoints),
            });
            return;
        }
        if (url.pathname.endsWith("/checkpoints/revert/preview")) {
            state.previewCalls += 1;
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(state.preview),
            });
            return;
        }
        if (url.pathname.endsWith("/checkpoints/revert")) {
            state.executeBodies.push((request.postDataJSON() as Record<string, unknown>) ?? {});
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(state.result),
            });
            return;
        }
        if (url.pathname.endsWith("/checkpoints/blob")) {
            state.blobCalls.push({
                sliceRef: url.searchParams.get("sliceRef"),
                path: url.searchParams.get("path"),
            });
            await route.fulfill({
                status: 200,
                contentType: "text/plain",
                body: CHECKPOINT_FILE_TEXT,
            });
            return;
        }
        if (url.pathname.endsWith("/checkpoints/cleanup")) {
            state.cleanupCalls += 1;
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ removed: true }),
            });
            return;
        }
        await route.fallback();
    });
    await page.route("**/api/v1/workspaces/*/git-status", async (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(state.gitStatus),
        }),
    );
    await page.route("**/api/v1/workspaces/*/checkpoints/retention", async (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                maxRuns: 50,
                ttlDays: 30,
                unsealedNeverDeleted: true,
                currentRuns: 1,
                currentRefs: 2,
            }),
        }),
    );
    await page.route("**/mcp", async (route) => {
        const body = route.request().postDataJSON() as { method?: string } | null;
        if (body?.method !== "tools/call") return route.fallback();
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                result: { content: [{ type: "text", text: JSON.stringify(CURRENT_FILE_TEXT) }] },
            }),
        });
    });
}

async function openChat(page: Page) {
        await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`);
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 15000 });
}

test.describe("PLAN-0339 workspace slices", () => {
    let state: MockState;
    test.beforeEach(async ({ page }) => {
        state = createState();
        await setupMockAuth(page);
        await setupMockSessions(page, {
            sessions: [{ id: SESSION_ID, title: "Workspace slices" }],
            messages: state.messages,
        });
        await installCheckpointRoutes(page, state);
    });

    test("captured marker opens a slice preview and sends confirmations", async ({ page }) => {
        await openChat(page);
        await expect(page.getByTestId("run-checkpoint-marker")).toHaveAttribute(
            "data-checkpoint-kind",
            "captured",
        );
        await page.getByTestId("run-checkpoint-revert-entry").click();
        await expect(page.getByTestId("checkpoint-dialog")).toBeVisible({ timeout: 10000 });
        await expect(page.getByTestId("revert-preview-type-conflict-count")).toHaveText("1");
        await expect(page.getByTestId("revert-preview-confirm")).toBeDisabled();
        await page.getByTestId("revert-preview-type-conflict-ack").check();
        await page.getByTestId("revert-preview-confirm").click();
        await expect(page.getByTestId("revert-result-counts")).toBeVisible({ timeout: 10000 });
        expect(state.previewCalls).toBe(1);
        expect(state.executeBodies).toEqual([
            { sliceRef: SLICE_REF, acknowledgeTypeChanges: ["src/conflict.ts"] },
        ]);
    });

    test("result keeps slice blob diff separate from current content", async ({ page }) => {
        await openChat(page);
        await page.getByTestId("run-checkpoint-revert-entry").click();
        await page.getByTestId("revert-preview-type-conflict-ack").check();
        await page.getByTestId("revert-preview-confirm").click();
        await expect(page.getByTestId("revert-result-group-failed")).toContainText(
            "src/conflict.ts",
        );
        await page.getByTestId("revert-result-diff-src/conflict.ts").click();
        await expect(page.getByTestId("revert-result-diff-rows")).toContainText("const answer = 2");
        expect(state.blobCalls).toEqual([{ sliceRef: SLICE_REF, path: "src/conflict.ts" }]);
    });

    test("timeline and pending status remain separate views", async ({ page }) => {
        await page.goto(`/workspace/${WORKSPACE_ID}`);
        await expect(page.getByTestId("workspace-conversation")).toBeVisible({ timeout: 10000 });
        await page.getByTestId("workspace-toolbar-changes").click();
        const panel = page.getByTestId("workspace-changes-panel");
        await panel.getByTestId("workspace-checkpoint-select-checkpoint-b").click();
        await expect(panel.getByTestId("workspace-checkpoint-timeline")).toContainText(
            "src/parser.ts",
        );
        await panel.getByTestId("workspace-diff-tab-pending").click();
        await expect(panel.getByTestId("workspace-diff-pending-list")).toContainText("README.md");
        await expect(panel.getByTestId("workspace-diff-pending-list")).not.toContainText(
            "src/legacy.ts",
        );
    });

    test("cleanup requires a second confirmation and canonical body", async ({ page }) => {
        await page.goto("/settings/data");
        await expect(page.getByTestId("settings-checkpoint-retention")).toBeVisible({
            timeout: 15000,
        });
        await page.getByTestId("settings-checkpoint-cleanup").click();
        await expect(page.getByTestId("settings-checkpoint-cleanup-confirm-box")).toBeVisible();
        expect(state.cleanupCalls).toBe(0);
        const cleanupRequest = page.waitForRequest((request) =>
            request.url().includes("/checkpoints/cleanup"),
        );
        await page.getByTestId("settings-checkpoint-cleanup-confirm").click();
        await expect(page.getByTestId("settings-checkpoint-cleanup-result")).toContainText(
            "清理完成",
        );
        expect(state.cleanupCalls).toBe(1);
        expect((await cleanupRequest).postDataJSON()).toEqual({ acknowledge: true });
    });
});

test.describe("PLAN-0339 workspace slices mobile", () => {
    let state: MockState;
    test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    test.beforeEach(async ({ page }) => {
        state = createState();
        await setupMockAuth(page);
        await setupMockSessions(page, {
            sessions: [{ id: SESSION_ID, title: "Workspace slices" }],
            messages: state.messages,
        });
        await installCheckpointRoutes(page, state);
    });
    test("preview is usable in the mobile sheet", async ({ page }) => {
        await openChat(page);
        await page.getByTestId("run-checkpoint-revert-entry").click();
        await expect(page.getByTestId("checkpoint-dialog-mobile")).toBeVisible({ timeout: 10000 });
        await expect(page.getByTestId("revert-preview-cancel")).toBeFocused();
        await page.getByTestId("revert-preview-type-conflict-ack").check();
        await page.getByTestId("revert-preview-confirm").click();
        await expect(page.getByTestId("revert-result-counts")).toBeVisible({ timeout: 10000 });
    });
    test("cleanup confirmation remains reachable on mobile", async ({ page }) => {
        await page.goto("/settings/data");
        await expect(page.getByTestId("settings-checkpoint-retention")).toBeVisible({
            timeout: 15000,
        });
        await page.getByTestId("settings-checkpoint-cleanup").click();
        await expect(page.getByTestId("settings-checkpoint-cleanup-confirm-box")).toBeVisible();
        await page.getByTestId("settings-checkpoint-cleanup-confirm").click();
        await expect(page.getByTestId("settings-checkpoint-cleanup-result")).toBeVisible();
        expect(state.cleanupCalls).toBe(1);
    });
});
