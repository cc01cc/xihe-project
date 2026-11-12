// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { expect, test } from "./helpers/mock-test";
import { expectPlatformScreenshot } from "../helpers/visual";
import { LONG_TIMEOUT_MS } from "../timeouts";

interface Route {
    path: string;
    name: string;
    requiresAuth: boolean;
}

const allRoutes: Route[] = [
    { path: "/login", name: "login", requiresAuth: false },
    { path: "/register", name: "register", requiresAuth: false },
    { path: "/workspace", name: "workspace-default", requiresAuth: true },
    {
        path: "/workspace/workspace-1/chat/test-session",
        name: "workspace-chat-session",
        requiresAuth: true,
    },
    { path: "/settings/config", name: "settings-config", requiresAuth: true },
    { path: "/resources/knowledge", name: "resources-knowledge", requiresAuth: true },
    { path: "/settings/data", name: "settings-data", requiresAuth: true },
    { path: "/settings/monitoring", name: "settings-monitoring", requiresAuth: true },
    { path: "/workspace/ws-e2e-1", name: "workspace", requiresAuth: true },
];

for (const route of allRoutes) {
    test(`${route.name} renders with 0 console errors`, async ({ page }) => {
        const errors: string[] = [];
        page.on("console", (msg) => {
            if (msg.type() === "error") errors.push(msg.text());
        });
        page.on("pageerror", (err) => errors.push(err.message));

        if (route.requiresAuth) {
            await page.addInitScript(() => {
                localStorage.setItem("xihe-token", "mock-token-for-screenshot");
            });
        }

        if (route.path === "/workspace/workspace-1/chat/test-session") {
            await page.addInitScript(() => {
                localStorage.setItem(
                    "xihe-sessions",
                    JSON.stringify([
                        {
                            id: "test-session",
                            title: "Test Session",
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                        },
                    ]),
                );
            });
        }

        await page.route("**/api/v1/events**", async (route2) => {
            await route2.fulfill({
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
                body: new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode("retry: 5000\n\n"));
                    },
                }),
            });
        });

        await page.route("**/api/v1/**", async (route2) => {
            const requestUrl = new URL(route2.request().url());
            const workspaceMatch = requestUrl.pathname.match(/\/api\/v1\/workspaces\/([^/]+)$/);
            if (workspaceMatch) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ id: workspaceMatch[1], name: "Screenshot Workspace" }),
                });
                return;
            }
            if (requestUrl.pathname.endsWith("/sessions")) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ sessions: [] }),
                });
                return;
            }
            const sessionMatch = requestUrl.pathname.match(/\/api\/v1\/sessions\/([^/]+)$/);
            if (sessionMatch) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        id: sessionMatch[1],
                        title: "Screenshot Session",
                        workspaceId: "workspace-1",
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                        archived: false,
                    }),
                });
                return;
            }
            if (requestUrl.pathname.endsWith("/policy/mode")) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        sessionId: "test-session",
                        mode: "manual",
                        sessionRules: 0,
                    }),
                });
                return;
            }
            // `GET /api/v1/version` returns `VersionInfo`, whose `modules: {cp, agent, runtime}`
            // is required and rendered by MonitoringView (`versionInfo.modules.cp.version`). The
            // `{}` catch-all below therefore threw `Cannot read properties of undefined
            // (reading 'cp')` — a fixture gap, not a UI error, and this spec asserts 0 console
            // errors per route.
            if (requestUrl.pathname.endsWith("/version")) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        stackId: "stack-1",
                        releaseChannel: "dev",
                        startedAt: new Date().toISOString(),
                        commit: null,
                        modules: {
                            cp: { version: "0.0.0-mock", commit: null },
                            agent: { version: "0.0.0-mock", commit: null },
                            runtime: { version: "0.0.0-mock", commit: null },
                        },
                    }),
                });
                return;
            }
            // A page that renders "with 0 console errors" only proves something if the chat
            // projections answer with their real shapes. The `{}` catch-all below made the chat
            // surfaces read `undefined.find` / `.filter` / `.map` (messages array, follow-up queue
            // `items`, derived-state `activeChildren`) and the monitor read `history.recent`, i.e.
            // the route "rendered" only because the failure landed after the assertion.
            const sessionPath = (suffix: string) =>
                requestUrl.pathname.endsWith(`/sessions/test-session/${suffix}`);
            if (sessionPath("messages")) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify([]),
                });
                return;
            }
            if (sessionPath("derived-state")) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        sessionId: "test-session",
                        activeChildren: [],
                        terminalNotices: [],
                    }),
                });
                return;
            }
            if (sessionPath("follow-ups")) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        sessionId: "test-session",
                        queueState: "empty",
                        outstandingCount: 0,
                        capacityLimit: 5,
                        pauseReason: null,
                        items: [],
                    }),
                });
                return;
            }
            if (sessionPath("participants")) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ participants: [] }),
                });
                return;
            }
            if (sessionPath("branches")) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        sessionId: "test-session",
                        items: [
                            {
                                branchId: "00000000-0000-4000-8000-000000000001",
                                parentBranchId: null,
                                forkPointMessageId: null,
                                forkPointRunId: null,
                                createdAt: new Date().toISOString(),
                            },
                        ],
                    }),
                });
                return;
            }
            if (sessionPath("commands")) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ commands: [] }),
                });
                return;
            }
            // `GET /chat/sessions/{id}/monitor` → `SessionMonitorResponse`. `history` and
            // `readiness` are required projections (`SessionMonitorPanel` renders
            // `data.history.recent`), so `{}` threw "reading 'recent'".
            if (
                requestUrl.pathname.includes("/chat/sessions/") &&
                requestUrl.pathname.endsWith("/monitor")
            ) {
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        generatedAt: new Date().toISOString(),
                        session: {
                            id: "test-session",
                            title: "Test Session",
                            agentPrincipalId: null,
                            modelProvider: null,
                            modelName: null,
                            providerConnectionId: null,
                            connectionRevision: null,
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                        },
                        activity: [],
                        history: { windowSize: 20, counts: {}, recent: [] },
                        readiness: {
                            connection: null,
                            agent: {
                                status: "unknown",
                                llmReady: "unknown",
                                verifiedAt: null,
                                configRevision: "0",
                            },
                            lastObservedRun: null,
                        },
                        transport: { attemptCount: 0, failedCount: 0, partialCount: 0 },
                    }),
                });
                return;
            }
            if (requestUrl.pathname.endsWith("/agents")) {
                // PLAN-0622 M1.2 envelope; `raw.agents.map` throws on a bare array.
                await route2.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ agents: [] }),
                });
                return;
            }
            await route2.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({}),
            });
        });

        const resp = await page.goto(route.path, { waitUntil: "load", timeout: LONG_TIMEOUT_MS });
        expect(resp?.status()).toBe(200);
        await expect(page.locator("#app")).toBeVisible();
        if (route.name === "workspace-chat-session") {
            // Readiness, not a clock: the chat surface mounts its composer only after the session
            // projection has been applied, and the assertions below must cover the projections
            // resolving — the `{}` catch-all used to fail *after* this test had already passed.
            await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        }

        await expectPlatformScreenshot(page, route.name + ".png");
        expect(errors).toEqual([]);
    });
}
