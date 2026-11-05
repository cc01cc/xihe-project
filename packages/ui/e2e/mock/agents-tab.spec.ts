import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";

/**
 * PLAN-0626 M3 (D26-05): Agent management moved from a modal into the dock's `agents`
 * tab. This spec pins the three things the move could silently break:
 *
 * 1. **Single mount** — the panel body exists exactly once. A stray second host (the old
 *    modal kept alongside the dock, or a `v-show`-hidden copy) makes every testid resolve
 *    twice: the 2026-11-02 incident produced strict-mode violations *and* long-lived false
 *    passes because assertions silently resolved to the hidden copy.
 * 2. **Deep links survive** — `/workspace/:id/chat/:sessionId` still renders the real
 *    conversation route when entered directly; moving the panel into the dock must not
 *    replace the routed whole pages (that is exactly the rejected option B).
 * 3. **PLAN-0629 C's read-only memory section** is still inside the panel (the migration
 *    must not drop it), including the existing testids.
 *
 * Runs in the mock lane: `--config e2e/playwright.config.ts e2e/mock/agents-tab.spec.ts`
 * (`scripts/e2e-host.mjs` greps `@host`, which this lane does not carry).
 */

const WORKSPACE_ID = "workspace-1",
    SESSION_ID = "session-1",
    AGENT_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    MEMORY_ID = "memory-1";

/** Screenshots are evidence, not fixtures: they go to the git-ignored evidence root. */
const SHOT_DIR = process.env.XIHE_SHOT_DIR
    ? resolve(process.env.XIHE_SHOT_DIR)
    : resolve(process.cwd(), "../../.local/xh-d28/shots");

async function capture(page: Page, name: string): Promise<string> {
    mkdirSync(SHOT_DIR, { recursive: true });
    const path = resolve(SHOT_DIR, `${name}.png`);
    await page.screenshot({ path });
    return path;
}

function agentBinding(): Record<string, unknown> {
    return {
        principalId: AGENT_ID,
        name: "Ops Agent",
        templateId: null,
        templateName: "Ops",
        createdAt: "2026-11-02T00:00:00Z",
        permissionsSnapshot: [{ actionClass: "read", resource: "*" }],
        bound: true,
        disabled: false,
    };
}

async function setupAgentsLane(page: Page): Promise<void> {
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "Session 1" }] });

    // CP capability projection: MANAGE_WORKSPACE_AGENTS for this workspace (+ instance
    // CREATE_ACCOUNT so the create form and management affordances are usable).
    await page.route("**/api/v1/me/permissions", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                userId: "user-1",
                instanceCapabilities: ["CREATE_ACCOUNT"],
                instancePermissions: [{ actionClass: "CREATE_ACCOUNT", resource: "*" }],
                workspaces: [
                    {
                        workspaceId: WORKSPACE_ID,
                        workspaceAdmin: true,
                        permissions: [
                            {
                                actionClass: "MANAGE_WORKSPACE_AGENTS",
                                resource: WORKSPACE_ID,
                            },
                        ],
                    },
                ],
            }),
        });
    });

    await page.route("**/api/v1/agent-templates**", async (route) => {
        const layer = new URL(route.request().url()).searchParams.get("layer") ?? "user";
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ layer, workspaceId: null, templates: [] }),
        });
    });

    // Same pattern for the list (`{agents:[…]}`) and the 0629 memory envelope
    // (`{memories:[…]}`) — both hang off `/workspaces/{id}/agents`.
    await page.route("**/api/v1/workspaces/workspace-1/agents**", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname.endsWith("/memories")) {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    memories: [
                        {
                            id: MEMORY_ID,
                            type: "profile",
                            pinned: true,
                            updatedAt: "2026-11-02T10:00:00Z",
                            content: "偏好中文回答",
                        },
                    ],
                }),
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ agents: [agentBinding()] }),
        });
    });

    // The chat column behind the dock polls four session projections. The shared mock
    // helper answers them with 404 (its `sessions/**` route reads `derived-state` as a
    // session id), which would put real `console.error` lines in the 0-error gate for a
    // reason unrelated to this change — stub the documented envelopes instead.
    await page.route("**/api/v1/sessions/*/derived-state", async (route) => {
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
    await page.route("**/api/v1/sessions/*/follow-ups", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                sessionId: SESSION_ID,
                queueState: "empty",
                outstandingCount: 0,
                capacityLimit: 10,
                pauseReason: null,
                items: [],
            }),
        });
    });
    await page.route("**/api/v1/sessions/*/participants", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                participants: [],
                capabilities: { view: true, manage: true, mention: true, speakAs: false },
            }),
        });
    });
    // PLAN-0635 M3 command registry: an empty registry is a valid projection.
    await page.route("**/api/v1/sessions/*/commands", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ commands: [] }),
        });
    });
}

test.describe("PLAN-0626 M3: workspace Agent management in the dock `agents` tab", () => {
    test.use({ viewport: { width: 1920, height: 1080 } });

    test("opens the tab, mounts the panel once, keeps the read-only memory block, and logs no errors", async ({
        page,
    }) => {
        const consoleErrors: string[] = [],
            pageErrors: string[] = [],
            failedResponses: string[] = [];
        page.on("console", (message) => {
            if (message.type() === "error") consoleErrors.push(message.text());
        });
        page.on("pageerror", (error) => pageErrors.push(error.message));
        // A 404 surfaces in the console only as "Failed to load resource", with no URL —
        // keep the status+URL list so a failure names the endpoint instead of the symptom.
        page.on("response", (response) => {
            if (response.status() >= 400) {
                failedResponses.push(`${response.status()} ${response.url()}`);
            }
        });

        await setupAgentsLane(page);
        await page.goto(`/workspace/${WORKSPACE_ID}`);

        await page.getByTestId("workspace-toolbar-agents").click();

        // The toolbar entry opens the dock tab — it must not mount a modal any more.
        await expect(page.getByTestId("dock-tab-agents")).toHaveAttribute("aria-selected", "true");
        await expect(page.getByTestId("modal-backdrop")).toHaveCount(0);

        const panel = page.getByTestId("workspace-agent-management-dialog");
        await expect(panel).toBeVisible();
        // ── the normalisation gate: exactly one panel, one form, one row ──────────────
        await expect(panel).toHaveCount(1);
        await expect(page.getByTestId("agent-principal-create-form")).toHaveCount(1);
        await expect(page.getByTestId(`workspace-agent-${AGENT_ID}`)).toHaveCount(1);

        // ── PLAN-0629 C: the read-only memory section survived the migration ─────────
        await expect(page.getByTestId("agent-memory-section")).toHaveCount(1);
        await page.getByTestId(`agent-memory-toggle-${AGENT_ID}`).click();
        await expect(page.getByTestId("agent-memory-readonly-hint")).toBeVisible();
        await expect(page.getByTestId("agent-memory-list")).toHaveCount(1);
        await expect(page.getByTestId(`agent-memory-content-${MEMORY_ID}`)).toContainText(
            "偏好中文回答",
        );

        // ── D26-01: the tab id lives in the existing `dockTabs` array, not a second store ─
        // Persistence is throttled (250ms writer), so poll the projection instead of sleeping.
        await expect
            .poll(
                async () =>
                    page.evaluate((workspaceId) => {
                        const raw = localStorage.getItem(`xihe-layout-ws:${workspaceId}`);
                        if (!raw) return "";
                        const parsed = JSON.parse(raw) as {
                            dockTabs?: string[];
                            activeDockTab?: string | null;
                        };
                        // The wide-screen first run opens `monitor` by default, so the tab set
                        // is a superset: assert membership plus the active projection.
                        return parsed.dockTabs?.includes("agents")
                            ? String(parsed.activeDockTab)
                            : `not-persisted:${(parsed.dockTabs ?? []).join(",")}`;
                    }, WORKSPACE_ID),
                {
                    timeout: 5000,
                    message: "the `agents` tab must land in the existing dockTabs/activeDockTab",
                },
            )
            .toBe("agents");

        expect(pageErrors, `pageErrors=${JSON.stringify(pageErrors)}`).toEqual([]);
        expect(failedResponses, `failedResponses=${JSON.stringify(failedResponses)}`).toEqual([]);
        expect(consoleErrors, `consoleErrors=${JSON.stringify(consoleErrors)}`).toEqual([]);

        // Evidence only (all assertions are done): the workbench row renders 36px taller
        // than a 1080px viewport on develop as well, so the last line of the 0629 C memory
        // block is clipped there. One taller shot shows the whole dock panel at once —
        // form, bound row and the read-only memory block — instead of two near-duplicates.
        await page.setViewportSize({ width: 1920, height: 1400 });
        await page.getByTestId("workspace-agent-management-dialog").evaluate((element) => {
            element.scrollTop = element.scrollHeight;
        });
        const shot = await capture(page, "agents-tab-opened-1920");
        test.info().annotations.push({ type: "evidence", description: shot });
    });
});

test.describe("PLAN-0626 M3: deep links keep reaching the whole-page routes", () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    /**
     * The routed chat page is addressed **only** by its URL: the session below is not in
     * the workspace's session list, so the page can reach it just by reading the route and
     * loading it by id. That makes the deep link observable in the DOM (the header shows the
     * routed session's title). If the route were replaced by side panels, the guard would
     * bounce to `/workspace/:id` and the title would fall back to the generic header.
     */
    const DEEP_SESSION_ID = "deep-session-77";

    test("a direct /workspace/:id/chat/:sessionId load still renders that session, and the agents tab opens there", async ({
        page,
    }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));

        await setupAgentsLane(page);
        await page.route(`**/api/v1/sessions/${DEEP_SESSION_ID}`, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    id: DEEP_SESSION_ID,
                    title: "Deep Session",
                    workspaceId: WORKSPACE_ID,
                    agentPrincipalId: AGENT_ID,
                    createdAt: "2026-11-02T00:00:00Z",
                    updatedAt: "2026-11-02T00:00:00Z",
                    modelProvider: null,
                    modelName: null,
                    archived: false,
                }),
            });
        });

        // Direct entry (no in-app navigation) — the deep-link contract from D26-05.
        await page.goto(`/workspace/${WORKSPACE_ID}/chat/${DEEP_SESSION_ID}`);

        await expect(page.getByTestId("workspace-conversation")).toBeVisible();
        // The routed session id was actually used (not the workspace fallback).
        await expect(page.getByTestId("workspace-session-title")).toContainText("Deep Session");
        await expect(page.getByTestId("chat-input")).toBeVisible();
        await expect(page).toHaveURL(
            new RegExp(`/workspace/${WORKSPACE_ID}/chat/${DEEP_SESSION_ID}$`),
        );

        await page.getByTestId("workspace-toolbar-agents").click();
        await expect(page.getByTestId("dock-tab-agents")).toHaveAttribute("aria-selected", "true");
        await expect(page.getByTestId("workspace-agent-management-dialog")).toHaveCount(1);
        // The floating dock is not a modal: no backdrop, and the routed page stays mounted.
        await expect(page.getByTestId("modal-backdrop")).toHaveCount(0);
        await expect(page.getByTestId("workspace-conversation")).toBeAttached();
        // No late redirect: the URL still names the deep-linked chat page.
        await expect(page).toHaveURL(
            new RegExp(`/workspace/${WORKSPACE_ID}/chat/${DEEP_SESSION_ID}$`),
        );

        expect(pageErrors, `pageErrors=${JSON.stringify(pageErrors)}`).toEqual([]);

        const shot = await capture(page, "agents-tab-deeplink-1440");
        test.info().annotations.push({ type: "evidence", description: shot });
    });
});
