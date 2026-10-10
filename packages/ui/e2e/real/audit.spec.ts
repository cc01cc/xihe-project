import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";
import {
    ensureAgentWorkspaceBinding,
    sendChat,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;

type Auth = {
    accessToken: string;
    workspaceId: string;
};

type AuditEntry = {
    type: string;
    id: string;
    sessionId?: string | null;
    status: string;
    summary?: string | null;
    source?: string | null;
    createdAt?: string;
};

type AuditDetail = {
    entry: AuditEntry;
    timeline: Array<{
        sequence: number;
        eventType: string;
        fromStatus?: string | null;
        toStatus?: string | null;
        createdAt?: string;
    }>;
    attempts: unknown[];
};

async function register(request: APIRequestContext): Promise<Auth> {
    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
    const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: {
            email: `audit-real-${Date.now()}@test.local`,
            password,
            name: "Audit Real",
        },
    });
    expect(response.status(), await response.text()).toBe(201);
    const body = await response.json();
    return { accessToken: body.accessToken, workspaceId: body.workspaceId };
}

async function installAuth(page: Page, auth: Auth) {
    await page.addInitScript(
        ({ token, workspaceId }) => {
            localStorage.setItem("xihe-token", token);
            localStorage.setItem("xihe-user", JSON.stringify({ workspaceId }));
            localStorage.setItem(
                "xihe-workspace",
                JSON.stringify({ id: workspaceId, name: "Default Workspace" }),
            );
        },
        { token: auth.accessToken, workspaceId: auth.workspaceId },
    );
}

async function findSessionId(request: APIRequestContext, auth: Auth): Promise<string> {
    const response = await request.get(`${CP_URL}/api/v1/sessions`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const body = (await response.json()) as { sessions?: Array<{ id: string }> };
    return body.sessions?.[0]?.id ?? "";
}

/** PLAN-0466: the session's chat run must surface as a `chat_run` audit entry. */
async function findChatRunEntry(
    request: APIRequestContext,
    auth: Auth,
    sessionId: string,
): Promise<AuditEntry | null> {
    const response = await request.get(
        `${CP_URL}/api/v1/audit/entries?sessionId=${encodeURIComponent(sessionId)}&type=chat_run&size=20`,
        { headers: { Authorization: `Bearer ${auth.accessToken}` } },
    );
    if (!response.ok()) return null;
    const body = (await response.json()) as { entries?: AuditEntry[] };
    return body.entries?.[0] ?? null;
}

async function findEntryDetail(
    request: APIRequestContext,
    auth: Auth,
    entry: AuditEntry,
): Promise<AuditDetail | null> {
    const response = await request.get(`${CP_URL}/api/v1/audit/entries/${entry.type}/${entry.id}`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    if (!response.ok()) return null;
    return (await response.json()) as AuditDetail;
}

async function agentLlmReadiness(request: APIRequestContext, auth: Auth): Promise<string> {
    const response = await request.get(`${CP_URL}/api/v1/status`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    if (!response.ok()) return "unknown";
    const body = (await response.json()) as {
        services?: Array<{ key?: string; llmReady?: string }>;
    };
    return body.services?.find((service) => service.key === "agent")?.llmReady ?? "unknown";
}

test.describe.configure({ retries: 0 });

test("@host PLAN-0466 Audit read view serves the four-domain entry stream", async ({
    page,
    request,
}, testInfo) => {
    test.setTimeout(180000);
    const auth = await register(request);
    const principalId = await provisionWorkspaceAgentPrincipal(request, auth, {
        name: "Audit Read Fixture",
        actions: ["read", "write"],
    });
    const sessionId = await createSessionWithPrincipal(request, auth, {
        principalId,
        title: "Audit Read Session",
    });
    await ensureAgentWorkspaceBinding(auth.workspaceId);
    await waitForControlPlaneAgentReady(request, { Authorization: `Bearer ${auth.accessToken}` });
    await installAuth(page, auth);

    const pageErrors: string[] = [],
        consoleErrors: string[] = [],
        requestFailures: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("requestfailed", (failed) => {
        const reason = failed.failure()?.errorText ?? "unknown";
        if (reason !== "net::ERR_ABORTED") {
            requestFailures.push(`${failed.method()} ${failed.url()} :: ${reason}`);
        }
    });

    await page.goto(`/workspace/${auth.workspaceId}/chat/${sessionId}`, { waitUntil: "load" });
    const textarea = page.locator("textarea");
    await expect(textarea).toBeVisible({ timeout: 20000 });
    await expect.poll(() => agentLlmReadiness(request, auth), { timeout: 60000 }).toBe("ready");

    const chatResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
            response.request().method() === "POST" &&
            url.pathname === "/api/v1/chat" &&
            response.status() === 202
        );
    });
    await sendChat(page, "今天天气怎么样？");
    await chatResponse;

    await expect.poll(() => findSessionId(request, auth), { timeout: 20000 }).toBe(sessionId);

    // 1) the chat run becomes a session-scoped `chat_run` entry of the audit view
    await expect
        .poll(() => findChatRunEntry(request, auth, sessionId), { timeout: 60000 })
        .not.toBeNull();
    const entry = (await findChatRunEntry(request, auth, sessionId)) as AuditEntry;
    expect(entry.type).toBe("chat_run");
    expect(entry.sessionId).toBe(sessionId);

    // 2) its detail timeline comes from chat_run_history (non-empty once terminal)
    await expect
        .poll(
            async () => {
                const detail = await findEntryDetail(request, auth, entry);
                return detail?.timeline.length ?? 0;
            },
            { timeout: 90000, message: "chat_run_history must hold the terminal event" },
        )
        .toBeGreaterThan(0);

    // 3) AuditView: list -> filter -> detail -> timeline against the new routes
    await page.goto("/settings/audit", { waitUntil: "load" });
    const listResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
            response.request().method() === "GET" &&
            url.pathname === "/api/v1/audit/entries" &&
            response.status() === 200
        );
    });
    await page.reload({ waitUntil: "load" });
    await listResponse;

    const entryRow = page.getByTestId(`settings-audit-entry-${entry.id}`);
    await expect(entryRow).toBeVisible({ timeout: 20000 });

    const filterResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
            response.request().method() === "GET" &&
            url.pathname === "/api/v1/audit/entries" &&
            url.searchParams.get("type") === "chat_run" &&
            response.status() === 200
        );
    });
    await page.getByTestId("settings-audit-type").selectOption("chat_run");
    await filterResponse;
    await expect(entryRow).toBeVisible();

    const detailResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
            response.request().method() === "GET" &&
            url.pathname === `/api/v1/audit/entries/${entry.type}/${entry.id}` &&
            response.status() === 200
        );
    });
    await entryRow.click();
    const detail = await detailResponse.then((response) => response.json() as Promise<AuditDetail>);

    expect(detail.entry.id).toBe(entry.id);
    expect(detail.entry.sessionId).toBe(sessionId);
    expect(detail.entry.type).toBe("chat_run");
    expect(detail.entry.createdAt).toBeTruthy();
    expect(detail.entry.startedAt).toBeNull();
    expect(detail.timeline.length).toBeGreaterThan(0);
    expect(detail.attempts).toEqual([]);

    await expect(page.getByTestId("settings-audit-events")).toContainText(
        /terminal|cancel|recovery|restore/,
        { timeout: 10000 },
    );
    // The detail pane labels the entry as a chat run while the list keeps its rows.
    await expect(page.getByText("对话运行").last()).toBeVisible();
    await expect(page.getByText("创建时间", { exact: true })).toBeVisible();
    await expect(page.getByText("开始时间", { exact: true })).toHaveCount(0);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(requestFailures).toEqual([]);

    await page.screenshot({
        path: testInfo.outputPath("plan-0466-real-audit-after-detail.png"),
        fullPage: true,
    });
});

test("@host PLAN-0466 AuditView paginates and surfaces a list error", async ({ page, request }) => {
    const auth = await register(request),
        entries: AuditEntry[] = [
            {
                type: "chat_run",
                id: "audit-page-one",
                status: "succeeded",
                summary: "Page one",
                source: "user_submission",
                createdAt: "2026-10-07T10:00:00Z",
            },
            {
                type: "workspace_job",
                id: "audit-page-two",
                status: "cancelled",
                summary: "Page two",
                source: "user_cancel",
                createdAt: "2026-10-07T09:00:00Z",
            },
        ];
    await installAuth(page, auth);
    let failList = false;
    await page.route("**/api/v1/audit/entries**", async (route) => {
        const url = new URL(route.request().url()),
            pageNumber = Number(url.searchParams.get("page") ?? "0"),
            entry = entries[pageNumber];
        if (url.pathname !== "/api/v1/audit/entries") {
            await route.continue();
            return;
        }
        if (failList) {
            await route.fulfill({
                status: 503,
                contentType: "application/problem+json",
                body: JSON.stringify({
                    type: "about:blank",
                    title: "Service Unavailable",
                    status: 503,
                    detail: "audit edge unavailable",
                    code: "AUDIT_TEMP_UNAVAILABLE",
                    requestId: "audit-e2e-request",
                }),
            });
            return;
        }

        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                entries: entry ? [entry] : [],
                page: pageNumber,
                size: 20,
                totalElements: entries.length,
                totalPages: entries.length,
            }),
        });
    });

    await page.goto("/settings/audit", { waitUntil: "load" });
    await expect(page.getByTestId("settings-audit-entry-audit-page-one")).toBeVisible();
    await expect(page.getByText("1 / 2", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "上一页" })).toBeDisabled();

    await Promise.all([
        page.waitForResponse((response) => {
            const url = new URL(response.url());
            return url.pathname === "/api/v1/audit/entries" && url.searchParams.get("page") === "1";
        }),
        page.getByRole("button", { name: "下一页" }).click(),
    ]);
    await expect(page.getByTestId("settings-audit-entry-audit-page-two")).toBeVisible();
    await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "上一页" })).toBeEnabled();

    failList = true;
    await Promise.all([
        page.waitForResponse((response) => {
            const url = new URL(response.url());
            return url.pathname === "/api/v1/audit/entries" && response.status() === 503;
        }),
        page.getByTestId("settings-audit-status").selectOption("failed"),
    ]);
    await expect(page.getByText("audit edge unavailable")).toBeVisible();
    await expect(page.getByTestId("settings-audit-no-selection")).toBeVisible();
});
