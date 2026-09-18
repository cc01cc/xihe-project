import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateE2EPassword } from "./helpers/password";

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const EVIDENCE_DIR = path.resolve(process.cwd(), "../../.local/evidence/plan-0352-v5");

type Auth = { accessToken: string; workspaceId: string };

async function register(request: APIRequestContext, name: string): Promise<Auth> {
    const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: { email: `${name}-${Date.now()}@test.com`, password: SHARED_PASSWORD, name },
    });
    expect(response.ok()).toBe(true);
    const body = await response.json();
    return { accessToken: body.accessToken, workspaceId: body.workspaceId };
}

function authHeaders(auth: Auth): Record<string, string> {
    return { Authorization: `Bearer ${auth.accessToken}`, "X-Workspace-Id": auth.workspaceId };
}

/** 会话由 UI 在空态自动创建；从首个 SSE 请求 URL 解析页面正在使用的 sessionId。 */
async function waitForSseSessionId(trace: SseTrace): Promise<string> {
    let id = "";
    await expect
        .poll(
            () => {
                const match = /sessionId=([^&]+)/.exec(trace.requests[0] ?? "");
                id = match ? decodeURIComponent(match[1]) : "";
                return id;
            },
            { timeout: 15000 },
        )
        .not.toBe("");
    return id;
}

async function sessionExists(request: APIRequestContext, auth: Auth, id: string): Promise<boolean> {
    const response = await request.get(`${CP_URL}/api/v1/sessions`, { headers: authHeaders(auth) });
    if (!response.ok()) return true;
    const body = await response.json();
    return (body.sessions ?? []).some((session: { id: string }) => session.id === id);
}

async function openChat(page: Page, auth: Auth) {
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
    await page.goto("/chat", { waitUntil: "load" });
    await expect(page.getByTestId("session-item").first()).toBeVisible({ timeout: 15000 });
}

type SseTrace = {
    requests: string[];
    responses: Array<{ url: string; status: number }>;
    finished: string[];
    failed: string[];
    consoleLines: string[];
    pageErrors: string[];
};

function installSseTrace(page: Page): SseTrace {
    const trace: SseTrace = {
        requests: [],
        responses: [],
        finished: [],
        failed: [],
        consoleLines: [],
        pageErrors: [],
    };
    page.on("request", (request) => {
        if (request.url().includes("/api/v1/events")) trace.requests.push(request.url());
    });
    page.on("response", (response) => {
        if (response.url().includes("/api/v1/events")) {
            trace.responses.push({ url: response.url(), status: response.status() });
        }
    });
    page.on("requestfinished", (request) => {
        if (request.url().includes("/api/v1/events")) trace.finished.push(request.url());
    });
    page.on("requestfailed", (request) => {
        if (request.url().includes("/api/v1/events")) trace.failed.push(request.url());
    });
    page.on("console", (message) => trace.consoleLines.push(message.text()));
    page.on("pageerror", (error) => trace.pageErrors.push(String(error)));
    return trace;
}

function eventsFor(trace: SseTrace, sessionId: string): string[] {
    return trace.requests.filter((url) => url.includes(`sessionId=${sessionId}`));
}

function dumpTrace(name: string, trace: SseTrace) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(path.join(EVIDENCE_DIR, `${name}.json`), JSON.stringify(trace, null, 2));
}

/** 有界观察窗：确认计数在窗口内保持稳定（禁止固定 sleep；轮询即显式证据）。 */
async function expectStableCount(read: () => number, expected: number, timeoutMs: number) {
    await expect
        .poll(
            async () => {
                const seen = read();
                await new Promise((resolve) => setTimeout(resolve, 300));
                return read() === seen ? seen : -1;
            },
            { timeout: timeoutMs, intervals: [50] },
        )
        .toBe(expected);
}

test.describe("@host PLAN-0352 session delete closes SSE", () => {
    test("active delete: server completes the SSE and the client never reconnects", async ({
        page,
        request,
    }) => {
        test.setTimeout(60000);
        const auth = await register(request, "v5-active-delete");
        const trace = installSseTrace(page);
        await openChat(page, auth);
        const sessionId = await waitForSseSessionId(trace);

        await expect.poll(() => eventsFor(trace, sessionId).length, { timeout: 10000 }).toBe(1);
        await expect
            .poll(
                () => trace.responses.some((r) => r.url.includes(sessionId) && r.status === 200),
                { timeout: 10000 },
            )
            .toBe(true);

        const item = page.getByTestId("session-item").first();
        await item.click({ button: "right" });
        await page.getByRole("button", { name: /删除|Delete/ }).click();

        await expect
            .poll(async () => sessionExists(request, auth, sessionId), { timeout: 10000 })
            .toBe(false);
        await expect
            .poll(
                () =>
                    trace.finished.some((url) => url.includes(sessionId)) ||
                    trace.failed.some((url) => url.includes(sessionId)),
                { timeout: 10000 },
            )
            .toBe(true);
        await expectStableCount(() => eventsFor(trace, sessionId).length, 1, 2000);
        expect(trace.consoleLines.filter((line) => line.includes("chat_sse_error"))).toEqual([]);
        await page.screenshot({
            path: path.join(EVIDENCE_DIR, "v5-1-active-delete.png"),
            fullPage: false,
        });
        dumpTrace("v5-1-active-delete", trace);
        expect(trace.pageErrors).toEqual([]);
    });

    test("passive close: exactly one reconnect, 404 fatal, no reconnect storm", async ({
        page,
        request,
    }) => {
        test.setTimeout(60000);
        const auth = await register(request, "v5-passive-close");
        const trace = installSseTrace(page);
        await openChat(page, auth);
        const sessionId = await waitForSseSessionId(trace);

        await expect.poll(() => eventsFor(trace, sessionId).length, { timeout: 10000 }).toBe(1);
        await expect
            .poll(
                () => trace.responses.some((r) => r.url.includes(sessionId) && r.status === 200),
                { timeout: 10000 },
            )
            .toBe(true);

        const deleted = await request.delete(`${CP_URL}/api/v1/sessions/${sessionId}`, {
            headers: authHeaders(auth),
        });
        expect(deleted.ok()).toBe(true);

        await expect.poll(() => eventsFor(trace, sessionId).length, { timeout: 10000 }).toBe(2);
        await expect
            .poll(
                () =>
                    trace.responses
                        .filter((r) => r.url.includes(sessionId))
                        .some((r) => r.status === 404),
                { timeout: 10000 },
            )
            .toBe(true);
        await expectStableCount(() => eventsFor(trace, sessionId).length, 2, 2500);
        await expect
            .poll(
                () => trace.consoleLines.filter((line) => line.includes("chat_sse_error")).length,
                { timeout: 10000 },
            )
            .toBeGreaterThan(0);
        const reconnects = trace.consoleLines.filter((line) =>
            line.includes("chat_sse_reconnect_scheduled"),
        );
        expect(reconnects.length).toBe(1);
        await expect(page.getByTestId("chat-send-button")).toBeVisible({ timeout: 5000 });
        await expect(page.getByTestId("chat-stop-button")).toHaveCount(0);
        await page.screenshot({
            path: path.join(EVIDENCE_DIR, "v5-2-passive-close.png"),
            fullPage: false,
        });
        dumpTrace("v5-2-passive-close", trace);
        expect(trace.pageErrors).toEqual([]);
    });
});
