import { expect, test, type Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";

// Audit entries mirror the four-domain `v_audit_entries` user tier (PLAN-0466):
// type tag + native status/summary/source, no internal fields.
const chatEntry = {
    type: "chat_run",
    id: "run-a1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    runId: "run-a1",
    status: "succeeded",
    summary: "gpt-5",
    source: "user_submission",
    errorCode: null,
    scope: null,
    cancelReason: null,
    toolCallId: null,
    approvalRequestId: null,
    terminalOutcome: "success",
    createdAt: "2026-09-09T01:00:00.000Z",
    startedAt: null,
    finishedAt: "2026-09-09T01:00:04.000Z",
};

// Entry policy snapshots mirror the exact wire shape of CP OperationPolicySummary
// (PLAN-0328 T1.15/T1.7): lower-case enums, nullable matchedRule/mode/allowedBy, and the
// nullable `reused` session-reuse annotation (null = not applicable).
const invAuto = {
    type: "mcp_invocation",
    id: "inv-auto",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    runId: "run-1",
    status: "completed",
    summary: "write_file",
    source: "agent",
    errorCode: null,
    scope: null,
    cancelReason: null,
    toolCallId: "call-auto-1",
    approvalRequestId: null,
    terminalOutcome: null,
    createdAt: "2026-09-09T01:00:00.000Z",
    startedAt: "2026-09-09T01:00:00.000Z",
    finishedAt: "2026-09-09T01:00:00.125Z",
    // An auto verdict is always an allow with a non-null allowedBy (PolicyVerdict
    // .allowedByMode); the underlying ask rule stays visible as matchedRule.
    policy: {
        effect: "allow",
        sourceLayer: "builtin",
        matchedRule: '{ write, "*", ask }',
        reason: "requires approval for domain write",
        mode: "auto",
        allowedBy: "auto@session",
        actionClass: "write",
        shape: "structured",
        reused: null,
    },
};

const invAllow = {
    ...invAuto,
    id: "inv-allow",
    summary: "read_file",
    toolCallId: "call-allow-2",
    policy: {
        effect: "allow",
        sourceLayer: "workspace",
        matchedRule: '{ read, "src/**", allow }',
        reason: "workspace rule allows reads under src",
        mode: "manual",
        allowedBy: null,
        actionClass: "read",
        shape: "structured",
        reused: null,
    },
};

const invReuse = {
    ...invAuto,
    id: "inv-reuse",
    toolCallId: "call-reuse-4",
    // T1.7: the engine verdict stayed `ask`; the dispatch was then authorized by an exact
    // session fingerprint reuse, which the projection annotates with reused=true.
    policy: {
        effect: "ask",
        sourceLayer: "builtin",
        matchedRule: '{ write, "*", ask }',
        reason: "write requires approval",
        mode: "manual",
        allowedBy: null,
        actionClass: "write",
        shape: "structured",
        reused: true,
    },
};

const invAsk = {
    ...invAuto,
    id: "inv-ask",
    summary: "execute_command",
    toolCallId: "call-ask-3",
    policy: {
        effect: "ask",
        sourceLayer: "builtin",
        matchedRule: '{ exec, "*", ask }',
        reason: "exec requires approval",
        mode: "manual",
        allowedBy: null,
        actionClass: "exec",
        shape: "structured",
        reused: null,
    },
};

const invLegacy = {
    ...invAuto,
    id: "inv-legacy",
    summary: "list_directory",
    source: "agent",
    toolCallId: "call-legacy-3",
    policy: undefined,
};

const listEntries = [invAuto, invAllow, invReuse, invAsk, invLegacy, chatEntry];

const DETAILS: Record<string, unknown> = {
    "inv-auto": {
        entry: invAuto,
        timeline: [
            {
                sequence: 1,
                eventType: "invocation.opened",
                fromStatus: null,
                toStatus: "active",
                createdAt: "2026-09-09T01:00:00.000Z",
            },
            {
                sequence: 2,
                eventType: "attempt.succeeded",
                fromStatus: "started",
                toStatus: "succeeded",
                actorType: "cp",
                createdAt: "2026-09-09T01:00:00.125Z",
            },
        ],
        attempts: [
            {
                id: "attempt-1",
                invocationId: "inv-auto",
                stage: "agent_dispatch",
                retryNo: 0,
                module: "agent",
                status: "succeeded",
                durationMs: 125,
            },
        ],
    },
    "inv-allow": { entry: invAllow, timeline: [], attempts: [] },
    "inv-reuse": { entry: invReuse, timeline: [], attempts: [] },
    "inv-ask": { entry: invAsk, timeline: [], attempts: [] },
    "inv-legacy": { entry: invLegacy, timeline: [], attempts: [] },
    "run-a1": {
        entry: chatEntry,
        timeline: [
            {
                sequence: 1,
                eventType: "terminal",
                fromStatus: "running",
                toStatus: "succeeded",
                terminalOutcome: "success",
                createdAt: "2026-09-09T01:00:04.000Z",
            },
        ],
        attempts: [],
    },
};

async function installAuditRoutes(page: Page, mode: "normal" | "empty" | "error") {
    const listRequests: string[] = [],
        detailRequests: string[] = [];

    await page.route("**/api/v1/audit/entries**", async (route) => {
        const url = new URL(route.request().url()),
            segments = url.pathname.split("/").filter(Boolean);
        const id = segments.at(-1);
        // List = /api/v1/audit/entries; detail = /api/v1/audit/entries/{type}/{id}.
        const isDetail = segments.length === 6 && segments[3] === "entries" && id !== undefined;

        if (isDetail) {
            detailRequests.push(url.toString());
            const detail = DETAILS[id as string];
            if (!detail) {
                await route.fulfill({
                    status: 404,
                    contentType: "application/json",
                    body: JSON.stringify({ code: "AUDIT_ENTRY_NOT_FOUND" }),
                });
                return;
            }
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(detail),
            });
            return;
        }

        listRequests.push(url.toString());
        if (mode === "error") {
            await route.fulfill({
                status: 503,
                contentType: "application/problem+json",
                body: JSON.stringify({
                    code: "AUDIT_UNAVAILABLE",
                    detail: "Audit backend unavailable",
                    status: 503,
                }),
            });
            return;
        }
        if (mode === "empty") {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    entries: [],
                    page: 0,
                    size: 20,
                    totalElements: 0,
                    totalPages: 0,
                }),
            });
            return;
        }

        const status = url.searchParams.get("status"),
            typeFilter = url.searchParams.get("type");
        const pageNumber = Number(url.searchParams.get("page") ?? "0");
        if (typeFilter === "chat_run") {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    entries: [chatEntry],
                    page: pageNumber,
                    size: 20,
                    totalElements: 1,
                    totalPages: 1,
                }),
            });
            return;
        }
        if (status === "failed") {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    entries: [
                        {
                            ...invAuto,
                            id: pageNumber === 0 ? "inv-failed-1" : "inv-failed-2",
                            status: "failed",
                            summary: `Failed entry page ${pageNumber + 1}`,
                        },
                    ],
                    page: pageNumber,
                    size: 20,
                    totalElements: 21,
                    totalPages: 2,
                }),
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                entries: listEntries,
                page: pageNumber,
                size: 20,
                totalElements: listEntries.length,
                totalPages: 1,
            }),
        });
    });

    return { listRequests, detailRequests };
}

function detailResponse(id: string) {
    return (response: { url: string; status: number }) =>
        response.url().includes(`/api/v1/audit/entries/`) &&
        response.url().endsWith(`/${id}`) &&
        response.status() === 200;
}

test.describe("Audit read view (PLAN-0466)", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: "session-1", title: "Audit Session" }] });
    });

    test("lists entries, loads a detail timeline, filters status, paginates, and captures post-action view", async ({
        page,
    }, testInfo) => {
        const requests = await installAuditRoutes(page, "normal");
        await page.goto("/settings/audit");

        await expect(page.getByTestId("settings-audit-heading")).toBeVisible();
        await expect(page.getByTestId("settings-audit-entry-inv-auto")).toBeVisible();
        expect(new URL(requests.listRequests[0]).searchParams.get("size")).toBe("20");

        const detailResponsePromise = page.waitForResponse(detailResponse("inv-auto"));
        await page.getByTestId("settings-audit-entry-inv-auto").click();
        await detailResponsePromise;
        await expect(
            page.getByTestId("settings-audit-items").getByText("write_file"),
        ).toBeVisible();
        await expect(page.getByText("agent_dispatch", { exact: true })).toBeVisible();
        await expect(page.getByTestId("settings-audit-events")).toContainText("invocation.opened");
        await expect(page.getByTestId("settings-audit-events")).toContainText("active");
        await page.screenshot({
            path: testInfo.outputPath("audit-after-detail.png"),
            fullPage: true,
        });

        await page.getByTestId("settings-audit-status").selectOption("failed");
        await expect(page.getByTestId("settings-audit-entry-inv-failed-1")).toBeVisible();
        const filteredRequest = requests.listRequests.at(-1);
        expect(filteredRequest).toBeDefined();
        expect(new URL(filteredRequest!).searchParams.get("status")).toBe("failed");
        expect(new URL(filteredRequest!).searchParams.get("page")).toBe("0");

        await page.getByRole("button", { name: "下一页" }).click();
        await expect(page.getByTestId("settings-audit-entry-inv-failed-2")).toBeVisible();
        const pagedRequest = requests.listRequests.at(-1);
        expect(pagedRequest).toBeDefined();
        expect(new URL(pagedRequest!).searchParams.get("page")).toBe("1");
        expect(requests.detailRequests).toHaveLength(1);
    });

    test("scopes the list request by the type filter", async ({ page }) => {
        const requests = await installAuditRoutes(page, "normal");
        await page.goto("/settings/audit");

        await page.getByTestId("settings-audit-type").selectOption("chat_run");
        await expect(page.getByTestId("settings-audit-entry-run-a1")).toBeVisible();
        const filteredRequest = requests.listRequests.at(-1);
        expect(filteredRequest).toBeDefined();
        expect(new URL(filteredRequest!).searchParams.get("type")).toBe("chat_run");
        expect(new URL(filteredRequest!).searchParams.get("status")).toBeNull();
    });

    test("shows per-entry verdicts, the auto highlight and the legacy no-verdict state", async ({
        page,
    }) => {
        await installAuditRoutes(page, "normal");
        await page.goto("/settings/audit");

        const autoResponse = page.waitForResponse(detailResponse("inv-auto"));
        await page.getByTestId("settings-audit-entry-inv-auto").click();
        await autoResponse;

        const autoItem = page.getByTestId("settings-audit-items");
        await expect(autoItem.getByTestId("settings-audit-policy-call-auto-1")).toBeVisible();
        await expect(autoItem.getByTestId("settings-audit-policy-call-auto-1-effect")).toHaveText(
            "允许",
        );
        await expect(
            autoItem.getByTestId("settings-audit-policy-call-auto-1-matched-rule"),
        ).toHaveText('{ write, "*", ask }');
        await expect(
            autoItem.getByTestId("settings-audit-policy-call-auto-1-source-layer"),
        ).toHaveText("内置层");
        await expect(autoItem.getByTestId("settings-audit-policy-call-auto-1-mode")).toHaveText(
            "自动放行",
        );
        await expect(
            autoItem.getByTestId("settings-audit-policy-call-auto-1-allowed-by"),
        ).toContainText("由 auto 放行");
        await expect(
            autoItem.getByTestId("settings-audit-policy-call-auto-1-allowed-by"),
        ).toContainText("auto@session");
        await expect(autoItem.getByText("工具调用: call-auto-1")).toBeVisible();

        const allowResponse = page.waitForResponse(detailResponse("inv-allow"));
        await page.getByTestId("settings-audit-entry-inv-allow").click();
        await allowResponse;
        const allowItem = page.getByTestId("settings-audit-items");
        await expect(allowItem.getByText("read_file", { exact: true })).toBeVisible();
        await expect(allowItem.getByTestId("settings-audit-policy-call-allow-2-effect")).toHaveText(
            "允许",
        );
        await expect(
            allowItem.getByTestId("settings-audit-policy-call-allow-2-matched-rule"),
        ).toHaveText('{ read, "src/**", allow }');
        await expect(
            allowItem.getByTestId("settings-audit-policy-call-allow-2-source-layer"),
        ).toHaveText("工作区层");
        await expect(allowItem.getByTestId("settings-audit-policy-call-allow-2-mode")).toHaveText(
            "手动审批",
        );
        await expect(
            allowItem.getByTestId("settings-audit-policy-call-allow-2-allowed-by"),
        ).toHaveCount(0);

        // A plain ask verdict has no allowedBy and must keep rendering the ask label.
        const askResponse = page.waitForResponse(detailResponse("inv-ask"));
        await page.getByTestId("settings-audit-entry-inv-ask").click();
        await askResponse;
        const askItem = page.getByTestId("settings-audit-items");
        await expect(askItem.getByTestId("settings-audit-policy-call-ask-3-effect")).toHaveText(
            "询问",
        );
        await expect(
            askItem.getByTestId("settings-audit-policy-call-ask-3-matched-rule"),
        ).toHaveText('{ exec, "*", ask }');
        await expect(
            askItem.getByTestId("settings-audit-policy-call-ask-3-source-layer"),
        ).toHaveText("内置层");
        await expect(askItem.getByTestId("settings-audit-policy-call-ask-3-mode")).toHaveText(
            "手动审批",
        );
        await expect(
            askItem.getByTestId("settings-audit-policy-call-ask-3-allowed-by"),
        ).toHaveCount(0);

        const legacyResponse = page.waitForResponse(detailResponse("inv-legacy"));
        await page.getByTestId("settings-audit-entry-inv-legacy").click();
        await legacyResponse;
        const legacyItem = page.getByTestId("settings-audit-items");
        await expect(legacyItem.getByTestId("settings-audit-policy-absent-inv-legacy")).toHaveText(
            "无判定记录（旧记录或非 MCP 路径）",
        );
        await expect(legacyItem.getByTestId("settings-audit-policy-call-legacy-3")).toHaveCount(0);

        const autoAgain = page.waitForResponse(detailResponse("inv-auto"));
        await page.getByTestId("settings-audit-entry-inv-auto").click();
        await autoAgain;
        await page.getByText("判定详情").click();
        await expect(page.getByTestId("settings-audit-policy-call-auto-1-reason")).toBeVisible();
        await expect(page.getByTestId("settings-audit-policy-call-auto-1-reason")).toHaveText(
            "requires approval for domain write",
        );
        await expect(page.getByTestId("settings-audit-policy-call-auto-1-action-class")).toHaveText(
            "write",
        );
        await expect(page.getByTestId("settings-audit-policy-call-auto-1-shape")).toHaveText(
            "结构化",
        );

        // T1.7: only the reused=true entry carries the reuse marker (icon + text); the null rows
        // and the legacy row must not have reuse invented for them.
        const reuseResponse = page.waitForResponse(detailResponse("inv-reuse"));
        await page.getByTestId("settings-audit-entry-inv-reuse").click();
        await reuseResponse;
        const reuseItem = page.getByTestId("settings-audit-items");
        await expect(reuseItem.getByTestId("settings-audit-policy-call-reuse-4-effect")).toHaveText(
            "询问",
        );
        await expect(reuseItem.getByTestId("settings-audit-policy-call-reuse-4-reused")).toHaveText(
            "由复用放行",
        );
        await expect(
            reuseItem.getByTestId("settings-audit-policy-call-reuse-4-reused").locator("svg"),
        ).toHaveCount(1);
        await expect(page.getByTestId("settings-audit-policy-call-auto-1-reused")).toHaveCount(0);
        await expect(page.getByTestId("settings-audit-policy-call-allow-2-reused")).toHaveCount(0);
        await expect(page.getByTestId("settings-audit-policy-call-ask-3-reused")).toHaveCount(0);
        await expect(page.getByTestId("settings-audit-policy-absent-inv-legacy")).toHaveCount(0);

        // The answerer annotation stays unimplemented (T1.9): the view must not invent it.
        await expect(page.getByTestId("settings-audit-items").getByText(/回答者/)).toHaveCount(0);
    });

    test("renders an explicit empty state", async ({ page }) => {
        await installAuditRoutes(page, "empty");
        await page.goto("/settings/audit");

        await expect(page.getByTestId("settings-audit-empty")).toBeVisible();
        await expect(page.getByTestId("settings-audit-no-selection")).toBeVisible();
    });

    test("renders a recoverable API error", async ({ page }) => {
        await installAuditRoutes(page, "error");
        await page.goto("/settings/audit");

        await expect(page.getByText("Audit backend unavailable")).toBeVisible();
        await expect(page.getByTestId("settings-audit-no-selection")).toBeVisible();
    });
});

test.describe("Audit policy verdict on mobile (PLAN-0328 T1.15)", () => {
    test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: "session-1", title: "Audit Session" }] });
    });

    test("renders the verdict block, bypass highlight and legacy state at 390x844", async ({
        page,
    }, testInfo) => {
        await installAuditRoutes(page, "normal");
        await page.goto("/settings/audit");

        const autoResponse = page.waitForResponse(detailResponse("inv-auto"));
        await page.getByTestId("settings-audit-entry-inv-auto").click();
        await autoResponse;

        await expect(page.getByTestId("settings-audit-policy-call-auto-1-effect")).toHaveText(
            "允许",
        );
        await expect(
            page.getByTestId("settings-audit-policy-call-auto-1-allowed-by"),
        ).toContainText("由 auto 放行");

        const legacyResponse = page.waitForResponse(detailResponse("inv-legacy"));
        await page.getByTestId("settings-audit-entry-inv-legacy").click();
        await legacyResponse;
        await expect(page.getByTestId("settings-audit-policy-absent-inv-legacy")).toHaveText(
            "无判定记录（旧记录或非 MCP 路径）",
        );

        const reuseResponse = page.waitForResponse(detailResponse("inv-reuse"));
        await page.getByTestId("settings-audit-entry-inv-reuse").click();
        await reuseResponse;
        await expect(page.getByTestId("settings-audit-policy-call-reuse-4-reused")).toHaveText(
            "由复用放行",
        );

        const autoAgain = page.waitForResponse(detailResponse("inv-auto"));
        await page.getByTestId("settings-audit-entry-inv-auto").click();
        await autoAgain;
        await page.getByText("判定详情").first().click();
        await expect(page.getByTestId("settings-audit-policy-call-auto-1-reason")).toBeVisible();

        await expect(
            page.getByTestId("settings-audit-policy-call-auto-1-allowed-by"),
        ).toBeInViewport();
        await page.screenshot({
            path: testInfo.outputPath("audit-policy-mobile-390x844.png"),
            fullPage: true,
        });
    });
});
