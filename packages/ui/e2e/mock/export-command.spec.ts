import { readFile } from "node:fs/promises";
import { type Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { ACTION_TIMEOUT_MS } from "../timeouts";

/**
 * PLAN-0635 M3: `/export` is a **real download** (`Response.blob()` → `URL.createObjectURL` →
 * `<a download>` click). jsdom cannot observe any of that, so the unit lane can at best assert that
 * the fetch happened; only a real browser can prove that Chromium opened a download, honoured the
 * filename and wrote the bytes. That is the whole reason this spec exists.
 *
 * Two cases, because there are two filename sources and only pinning both keeps the fallback from
 * rotting: a `Content-Disposition` header (server decides) and its absence (`session-<id>.md`).
 */

const WORKSPACE_ID = "workspace-1",
    SESSION_ID = "export-session",
    ROOT_BRANCH_ID = "00000000-0000-4000-8000-000000000001";
const MARKDOWN_BODY = "# Exported transcript\n\n- first item\n- second item\n";
/** What `exportFileName()` falls back to when the response carries no usable disposition. */
const FALLBACK_FILENAME = `session-${SESSION_ID}.md`;
/** Deliberately different from the fallback, so a header-vs-fallback mix-up cannot pass. */
const HEADER_FILENAME = "branch-root-transcript.md";

interface ExportProbe {
    /** `branchId` query value the stub saw (`null` when the request carried none). */
    branchId: string | null;
    /** How many times the browser asked for the export endpoint. */
    requests: number;
}

async function setupExportChat(
    page: Page,
    contentDisposition: string | null,
): Promise<ExportProbe> {
    await setupMockAuth(page);
    await setupMockSessions(page, {
        sessions: [
            {
                id: SESSION_ID,
                title: "Export test",
                workspaceId: WORKSPACE_ID,
                agentPrincipalId: "agent-1",
            },
        ],
    });

    // The chat panel always probes these, and the shared `**/api/v1/sessions/**` catch-all answers
    // them with 404 (a pre-existing mock-lane gap, not an `/export` problem). Stubbing them keeps
    // "no console error" a real assertion instead of a filter that would hide export errors.
    await page.route(`**/api/v1/sessions/${SESSION_ID}/derived-state`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                sessionId: SESSION_ID,
                activeChildren: [],
                terminalNotices: [],
            }),
        });
    });
    await page.route(`**/api/v1/sessions/${SESSION_ID}/participants`, async (route) => {
        // Strict envelope (`{participants: []}`) is legal and means "no participants yet".
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ participants: [] }),
        });
    });
    await page.route(`**/api/v1/sessions/${SESSION_ID}/follow-ups**`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                sessionId: SESSION_ID,
                queueState: "empty",
                outstandingCount: 0,
                capacityLimit: 5,
                pauseReason: null,
                items: [],
            }),
        });
    });

    // The registry decides whether `/export` exists at all. Without this row the composer falls
    // back to the local table (`/clear`, `/help`) and typing `/export` would be sent as chat text.
    await page.route(`**/api/v1/sessions/${SESSION_ID}/commands`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                commands: [{ name: "/export", source: "builtin", available: true, reason: null }],
            }),
        });
    });

    const probe: ExportProbe = { branchId: null, requests: 0 };
    // Registered last on purpose: Playwright runs the most recently added matching route first, so
    // this stub wins over the `**/api/v1/**` catch-all installed by `setupMockAuth`.
    await page.route(
        (url) => url.pathname === `/api/v1/sessions/${SESSION_ID}/export`,
        async (route) => {
            probe.requests += 1;
            probe.branchId = new URL(route.request().url()).searchParams.get("branchId");
            const headers: Record<string, string> = {
                "content-type": "text/markdown; charset=utf-8",
            };
            if (contentDisposition) headers["content-disposition"] = contentDisposition;
            await route.fulfill({ status: 200, headers, body: MARKDOWN_BODY });
        },
    );
    return probe;
}

/**
 * `/export` is branch-scoped and refuses to run while the selected branch is unknown
 * (`InputArea.downloadSessionExport` toasts `branchUnavailable` and returns). The command registry
 * row — the thing `runExportCommand` waits for — is a *separate* async load, so "row visible" does
 * not imply "branch resolved". Waiting for the branch projection is the ordering guarantee; relying
 * on the row alone is what made this spec flaky under a loaded lane.
 */
function branchProjectionLoaded(page: Page): Promise<unknown> {
    return page.waitForResponse(
        (response) =>
            response.url().includes(`/api/v1/sessions/${SESSION_ID}/branches`) &&
            response.status() === 200,
    );
}

/** Submits `/export` through the real composer (menu row + Enter), not through the API layer. */
async function runExportCommand(page: Page): Promise<void> {
    const input = page.getByTestId("chat-input");
    await expect(input).toBeVisible();
    await input.fill("/export");
    // Readiness: the row only exists once the registry merge has landed, and pressing Enter
    // earlier would emit the literal text as the user's message instead of running the command.
    await expect(page.getByRole("option", { name: /\/export/ })).toBeVisible();
    await input.press("Enter");
}

test("`/export` downloads the artifact and takes the filename from Content-Disposition", async ({
    page,
}) => {
    const consoleErrors: string[] = [],
        httpErrors: string[] = [];
    page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    // A console error from a failed resource does not name the URL, so keep the raw 4xx/5xx list
    // too: the failure message then points at the endpoint instead of "Failed to load resource".
    page.on("response", (response) => {
        if (response.status() >= 400)
            httpErrors.push(
                `${response.status()} ${response.request().method()} ${response.url()}`,
            );
    });

    const probe = await setupExportChat(page, `attachment; filename="${HEADER_FILENAME}"`);
    const branchesReady = branchProjectionLoaded(page);
    await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`, {
        waitUntil: "domcontentloaded",
    });
    await branchesReady;

    // Explicit short timeout: a missing download should read as "no download event", not as a
    // generic 30 s test timeout.
    const downloadPromise = page.waitForEvent("download", { timeout: ACTION_TIMEOUT_MS });
    await runExportCommand(page);
    const download = await downloadPromise;

    // ① the download really happened — the one thing jsdom cannot observe at all
    expect(await download.failure()).toBeNull();
    // ② the filename came from the response header, not from the `session-<id>.md` fallback
    expect(download.suggestedFilename()).toBe(HEADER_FILENAME);
    expect(download.suggestedFilename()).not.toBe(FALLBACK_FILENAME);
    // ③ the request was branch-scoped: `?branchId=` carries the selected branch
    expect(probe.requests).toBe(1);
    expect(probe.branchId).toBe(ROOT_BRANCH_ID);
    // ④ the bytes landed: an anchor click alone still emits `download`, so read the file
    expect(await readFile(await download.path(), "utf8")).toBe(MARKDOWN_BODY);

    expect(httpErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
});

test("`/export` falls back to `session-<sessionId>.md` when the response has no Content-Disposition", async ({
    page,
}) => {
    const probe = await setupExportChat(page, null);
    const branchesReady = branchProjectionLoaded(page);
    await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`, {
        waitUntil: "domcontentloaded",
    });
    await branchesReady;

    const downloadPromise = page.waitForEvent("download", { timeout: ACTION_TIMEOUT_MS });
    await runExportCommand(page);
    const download = await downloadPromise;

    expect(await download.failure()).toBeNull();
    // The fallback is a real, exercised path — not dead code behind the happy case.
    expect(download.suggestedFilename()).toBe(FALLBACK_FILENAME);
    expect(probe.branchId).toBe(ROOT_BRANCH_ID);
    expect(await readFile(await download.path(), "utf8")).toBe(MARKDOWN_BODY);
});
