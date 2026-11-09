import { type Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";
import { selectByLocator } from "../helpers/select";

const SESSION_ID = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1",
    WORKSPACE_ID = "workspace-1";
const RUN_ID = "d1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1",
    REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const CONFLICT_ID = "22222222-2222-4222-8222-222222222222",
    UNCLASSIFIED_TOOL = "mcp__third_party__do";

interface PolicyRulePayload {
    id: string;
    layer: string;
    ownerId: string | null;
    actionClass: string;
    resource: string;
    effect: string;
    priority: number;
    locked: boolean;
    effective: boolean;
    conflict: string | null;
}

interface PolicyFacePayload {
    id: string | null;
    scope: "builtin" | "instance" | "workspace";
    ownerId: string | null;
    tool: string;
    actionClass: string;
    shape: string;
}

const conflictedAllow: PolicyRulePayload = {
    id: CONFLICT_ID,
    layer: "workspace",
    ownerId: WORKSPACE_ID,
    actionClass: "exec",
    resource: "pnpm *",
    effect: "allow",
    priority: 0,
    locked: false,
    effective: true,
    conflict: '该 allow 不会生效：存在更具体的 deny "pnpm test *"',
};

const workspaceDeny: PolicyRulePayload = {
    id: "33333333-3333-4333-8333-333333333333",
    layer: "workspace",
    ownerId: WORKSPACE_ID,
    actionClass: "exec",
    resource: "pnpm test *",
    effect: "deny",
    priority: 0,
    locked: true,
    effective: true,
    conflict: null,
};

const domainsPayload = [
    {
        actionClass: "exec",
        effectiveLayer: "workspace",
        configuredLayers: ["workspace"],
        ruleCounts: { workspace: 2 },
    },
    { actionClass: "read", effectiveLayer: "builtin", configuredLayers: [], ruleCounts: {} },
];

function installPolicyApi(page: Page) {
    const state = {
        rules: {
            instance: [] as PolicyRulePayload[],
            user: [] as PolicyRulePayload[],
            workspace: [conflictedAllow, workspaceDeny],
        },
        faces: [
            {
                id: null,
                scope: "builtin",
                ownerId: null,
                tool: "read_file",
                actionClass: "read",
                shape: "structured",
            },
            {
                id: "44444444-4444-4444-8444-444444444444",
                scope: "workspace",
                ownerId: WORKSPACE_ID,
                tool: UNCLASSIFIED_TOOL,
                actionClass: "unclassified",
                shape: "opaque",
            },
        ] as PolicyFacePayload[],
        createdRules: [] as Array<Record<string, unknown>>,
        deletedRules: [] as string[],
        classifications: [] as Array<Record<string, unknown>>,
        conflictsRequested: [] as string[],
        /** Every `/policy/**` call the page made (used to prove the retired route reads nothing). */
        policyRequests: [] as string[],
    };

    // Registered after setupMockAuth on purpose: Playwright routes are LIFO, so these
    // specific handlers take precedence over the helper's catch-all.
    void page.route("**/api/v1/policy/**", async (route) => {
        const request = route.request(),
            url = new URL(request.url()),
            method = request.method();
        state.policyRequests.push(`${method} ${url.pathname}`);
        const layer = url.searchParams.get("layer") ?? "";
        const json = (status: number, body: unknown) =>
            route.fulfill({
                status,
                contentType: "application/json",
                body: JSON.stringify(body),
            });

        if (url.pathname.endsWith("/policy/domains") && method === "GET") {
            return json(200, domainsPayload);
        }
        if (url.pathname.endsWith("/policy/rules/conflicts") && method === "GET") {
            state.conflictsRequested.push(layer);
            return json(
                200,
                state.rules[layer as keyof typeof state.rules]?.filter(
                    (rule) => rule.conflict !== null,
                ) ?? [],
            );
        }
        if (url.pathname.endsWith("/policy/rules") && method === "GET") {
            return json(200, state.rules[layer as keyof typeof state.rules] ?? []);
        }
        if (url.pathname.endsWith("/policy/rules") && method === "POST") {
            const body = request.postDataJSON() as Record<string, unknown>;
            state.createdRules.push(body);
            const created: PolicyRulePayload = {
                id: `created-${state.createdRules.length}`,
                layer: String(body.layer),
                ownerId: String(body.layer) === "instance" ? null : WORKSPACE_ID,
                actionClass: String(body.actionClass),
                resource: String(body.resource),
                effect: String(body.effect),
                priority: Number(body.priority ?? 0),
                locked: body.locked === true,
                effective: true,
                conflict: null,
            };
            state.rules[created.layer as keyof typeof state.rules]?.push(created);
            return json(200, created);
        }
        if (url.pathname.includes("/policy/rules/") && method === "DELETE") {
            const id = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
            state.deletedRules.push(id);
            state.rules[layer as keyof typeof state.rules] = (
                state.rules[layer as keyof typeof state.rules] ?? []
            ).filter((rule) => rule.id !== id);
            return route.fulfill({ status: 204, body: "" });
        }
        if (url.pathname.endsWith("/policy/tool-faces") && method === "GET") {
            return json(200, state.faces);
        }
        if (url.pathname.endsWith("/policy/tool-faces") && method === "POST") {
            const body = request.postDataJSON() as Record<string, unknown>;
            state.classifications.push(body);
            const existing = state.faces.find(
                (face) => face.tool === body.tool && face.scope === body.scope,
            );
            if (existing) {
                existing.actionClass = String(body.actionClass);
                existing.shape = String(body.shape);
                return json(200, existing);
            }
            const created = {
                id: "55555555-5555-4555-8555-555555555555",
                scope: String(body.scope) as PolicyFacePayload["scope"],
                ownerId: WORKSPACE_ID,
                tool: String(body.tool),
                actionClass: String(body.actionClass),
                shape: String(body.shape),
            };
            state.faces.push(created);
            return json(200, created);
        }
        // BL-318：审批卡挂载会读 `GET /policy/mode?sessionId=…`（真实响应
        // `{sessionId, mode:"manual", sessionRules:0}`）。本夹具此前只桩 domains/rules/faces，
        // 落到下面的 fail-closed 404 默认分支 ⇒ 门禁接上后变成噪声红。
        if (url.pathname.endsWith("/policy/mode") && method === "GET") {
            return json(200, {
                sessionId: url.searchParams.get("sessionId") ?? "mock-session",
                mode: "manual",
                sessionRules: 0,
            });
        }
        return json(404, {
            code: "NOT_FOUND",
            detail: `unmocked ${method} ${url.pathname}`,
            status: 404,
        });
    });

    return state;
}

async function installApprovalSSE(page: Page) {
    await page.addInitScript(
        ({ sessionId, runId }: { sessionId: string; runId: string }) => {
            const pending: unknown[] = [];
            let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
            const encode = (value: string) => new TextEncoder().encode(value);
            const sse = (name: string, data: unknown) =>
                `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
            const drain = () => {
                if (!controllerRef) return;
                while (pending.length > 0) {
                    controllerRef.enqueue(encode(sse("approval_request", pending.shift())));
                }
            };
            (window as unknown as Record<string, unknown>).__pushApprovalEvent = (
                payload: unknown,
            ) => {
                pending.push(payload);
                drain();
            };
            const originalFetch = window.fetch.bind(window);
            window.fetch = async (input, init) => {
                const requestUrl =
                    typeof input === "string"
                        ? input
                        : input instanceof Request
                          ? input.url
                          : input.url;
                if (requestUrl.includes("/api/v1/events")) {
                    const body = new ReadableStream<Uint8Array>({
                        start(controller) {
                            controllerRef = controller;
                            controller.enqueue(encode("retry: 1000\n\n"));
                            queueMicrotask(drain);
                        },
                    });
                    return new Response(body, {
                        status: 200,
                        headers: { "Content-Type": "text/event-stream" },
                    });
                }
                if (
                    requestUrl.includes("/api/v1/chat") &&
                    !requestUrl.includes("/api/v1/chat/approvals/") &&
                    (init?.method ?? "GET") === "POST"
                ) {
                    const payload =
                        typeof init?.body === "string"
                            ? (JSON.parse(init.body) as { branchId?: string })
                            : {};
                    if (!payload.branchId) {
                        return new Response(
                            JSON.stringify({
                                code: "INVALID_REQUEST",
                                detail: "branchId is required",
                            }),
                            {
                                status: 400,
                                headers: { "Content-Type": "application/problem+json" },
                            },
                        );
                    }
                    return new Response(JSON.stringify({ status: "accepted", sessionId, runId }), {
                        status: 202,
                        headers: { "Content-Type": "application/json" },
                    });
                }
                return originalFetch(input, init);
            };
        },
        { sessionId: SESSION_ID, runId: RUN_ID },
    );
}

function unclassifiedApprovalEvent() {
    return {
        requestId: REQUEST_ID,
        runId: RUN_ID,
        sessionId: SESSION_ID,
        workspaceId: WORKSPACE_ID,
        tool: UNCLASSIFIED_TOOL,
        action: "call third-party tool",
        details: "third-party payload preview",
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        state: "pending",
        replayed: false,
        policy: {
            effect: "ask",
            sourceLayer: "builtin",
            matchedRule: null,
            reason: "unclassified tool requires explicit classification",
            mode: "manual",
            actionClass: "unclassified",
            shape: "opaque",
        },
    };
}

async function pushApproval(page: Page, payload: Record<string, unknown>) {
    await page.evaluate((data) => {
        (window as unknown as Record<string, unknown>).__pushApprovalEvent!(data);
    }, payload);
}

function installDecisionRoute(page: Page) {
    const calls: Array<Record<string, unknown>> = [];
    void page.route("**/api/v1/chat/approvals/**", async (route) => {
        calls.push((route.request().postDataJSON() as Record<string, unknown>) ?? {});
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                status: "accepted",
                requestId: REQUEST_ID,
                approved: true,
                decision: "once",
            }),
        });
    });
    return calls;
}

test.describe("Policy management (desktop)", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "Policy Session" }] });
    });

    // The policy-rule editor is retired from the product: `router/index.ts:84-87` redirects
    // `/settings/policy` to `settings-config`, no route imports `PolicyRulesView.vue` (only its own
    // unit test does), and `SettingsNav` no longer links `/settings/policy`. The four cases below
    // keep their original intent — where a user who asks for policy management ends up, and who may
    // see the admin-only layer — but assert the current behaviour instead of the removed editor.
    test("the retired /settings/policy route lands on the config page and issues no policy reads", async ({
        page,
    }) => {
        const state = installPolicyApi(page);
        await page.goto("/settings/policy");

        await expect(page).toHaveURL(/\/settings\/config$/);
        await expect(page.getByTestId("settings-config-heading")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("config-tab-user")).toBeVisible();
        // Retirement, stated as behaviour: the old URL must not read or write any policy surface.
        expect(state.policyRequests).toEqual([]);
    });

    test("a caller without the admin capability lands on the user-layer config page only", async ({
        page,
    }) => {
        installPolicyApi(page);
        await page.goto("/settings/policy");

        await expect(page).toHaveURL(/\/settings\/config$/);
        await expect(page.getByTestId("settings-config-heading")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        // Capability gating still holds on the page the redirect lands on: instance-layer tab and
        // the instance import/export block stay admin-only.
        await expect(page.getByTestId("config-tab-user")).toBeVisible();
        await expect(page.getByTestId("config-tab-instance")).toHaveCount(0);
        await expect(page.getByTestId("config-import-export")).toHaveCount(0);
    });

    test("an instance admin landing on the retired URL keeps the admin-only config surfaces", async ({
        page,
    }) => {
        await page.addInitScript(() => {
            // `authStore.isAdmin` reads the capability projection (PLAN-0610 W3-2b #22).
            localStorage.setItem(
                "xihe-user",
                JSON.stringify({
                    id: "user-1",
                    email: "test@xihe.local",
                    capabilities: { isInstanceAdmin: true, isInstanceSuper: true },
                }),
            );
        });
        installPolicyApi(page);
        await page.goto("/settings/policy");

        await expect(page).toHaveURL(/\/settings\/config$/);
        await expect(page.getByTestId("config-tab-instance")).toBeVisible();
        await expect(page.getByTestId("config-tab-user")).toBeVisible();
        // The instance layer is the default tab for admins, and its import/export block is the
        // admin-gated affordance that replaced the retired locked-rule control.
        await expect(page.getByTestId("config-import-export")).toBeVisible();
    });

    test("lists tool faces, highlights unclassified tools, and classifies as workspace owner", async ({
        page,
    }) => {
        const state = installPolicyApi(page);
        await page.goto("/settings/tool-faces");

        await expect(page.getByTestId("settings-tool-faces-heading")).toBeVisible({
            timeout: ACTION_TIMEOUT_MS,
        });
        await expect(page.getByTestId("settings-tool-face-source-read_file")).toContainText("内置");
        await expect(
            page.getByTestId(`settings-tool-face-unclassified-${UNCLASSIFIED_TOOL}`),
        ).toContainText("默认 ask");
        await expect(
            page.getByTestId(`settings-tool-face-unclassified-${UNCLASSIFIED_TOOL}`),
        ).toContainText("未分类");

        await page.getByTestId(`settings-tool-face-classify-${UNCLASSIFIED_TOOL}`).click();
        await page
            .getByTestId(`settings-tool-face-classify-action-class-${UNCLASSIFIED_TOOL}`)
            .fill("exec");
        await selectByLocator(
            page.getByTestId(`settings-tool-face-classify-shape-${UNCLASSIFIED_TOOL}`),
            "解释器型",
        );
        await page.getByTestId(`settings-tool-face-classify-submit-${UNCLASSIFIED_TOOL}`).click();

        await expect.poll(() => state.classifications.length).toBe(1);
        expect(state.classifications[0]).toEqual({
            scope: "workspace",
            tool: UNCLASSIFIED_TOOL,
            actionClass: "exec",
            shape: "interpreter",
        });
        await expect(
            page.getByTestId(`settings-tool-face-action-class-${UNCLASSIFIED_TOOL}`),
        ).toContainText("exec");
        await expect(
            page.getByTestId(`settings-tool-face-unclassified-${UNCLASSIFIED_TOOL}`),
        ).toHaveCount(0);
    });

    // PLAN-0707：同一 BaseModal 内 reka Select 阻塞；待事件序列排查（见 evidence/reka-dialog-select.md）。
    test("approval classify-and-allow classifies first and hands back a once decision", async ({
        page,
    }) => {
        const state = installPolicyApi(page);
        await installApprovalSSE(page);
        const calls = installDecisionRoute(page);

        await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`);
        await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await pushApproval(page, unclassifiedApprovalEvent());

        const dialog = page.locator('[data-testid="modal-content"]');
        await expect(dialog).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await expect(dialog.locator('[data-testid="approval-unclassified-notice"]')).toContainText(
            "未分类",
        );
        // Never a one-click persistent allow for unclassified tools.
        await expect(dialog.locator('[data-testid="approval-allow-session"]')).toHaveCount(0);
        await expect(dialog.locator('[data-testid="approval-save-rule"]')).toHaveCount(0);
        expect(calls).toHaveLength(0);

        await dialog.locator('[data-testid="approval-classify-entry"]').click();
        expect(calls).toHaveLength(0);
        expect(state.classifications).toHaveLength(0);
        await dialog.locator('[data-testid="approval-classify-action-class"]').fill("exec");
        await selectByLocator(
            dialog.locator('[data-testid="approval-classify-shape"]'),
            "解释器型",
        );
        await dialog.locator('[data-testid="approval-classify-submit"]').click();

        await expect.poll(() => state.classifications.length).toBe(1);
        expect(state.classifications[0]).toEqual({
            scope: "workspace",
            tool: UNCLASSIFIED_TOOL,
            actionClass: "exec",
            shape: "interpreter",
        });
        await expect.poll(() => calls.length).toBe(1);
        expect(calls[0]).toEqual({ decision: "once" });
    });
});

test.describe("Policy management (mobile)", () => {
    test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "Policy Session" }] });
    });

    test("renders the retired policy URL as config and keeps the tool-face classifier on a small viewport", async ({
        page,
    }) => {
        installPolicyApi(page);
        await page.goto("/settings/policy");

        // Same retirement as the desktop cases, at 390 px: the old URL resolves to config.
        await expect(page).toHaveURL(/\/settings\/config$/);
        await expect(page.getByTestId("settings-config-heading")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });

        // `/settings/tool-faces` is the policy surface that survived the retirement; the
        // unclassified-tool affordance must stay reachable and readable on a small viewport.
        await page.goto("/settings/tool-faces");
        await expect(page.getByTestId("settings-tool-faces-heading")).toBeVisible();
        await expect(
            page.getByTestId(`settings-tool-face-unclassified-${UNCLASSIFIED_TOOL}`),
        ).toContainText("默认 ask");
    });

    test("classify-and-allow works in the mobile approval sheet", async ({ page }) => {
        const state = installPolicyApi(page);
        await installApprovalSSE(page);
        const calls = installDecisionRoute(page);

        await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`);
        await page.getByTestId("mobile-chat-open").click();
        await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await pushApproval(page, unclassifiedApprovalEvent());

        const dialog = page.locator('[data-testid="modal-content"]');
        await expect(dialog).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await dialog.locator('[data-testid="approval-classify-entry"]').click();
        const actionClass = dialog.locator('[data-testid="approval-classify-action-class"]');
        await expect(actionClass).toBeVisible();
        await actionClass.click();
        await expect(actionClass).toBeFocused();
        // Real keystrokes, not `fill`: the regression this pins is focus ownership. The
        // chat sheet is a modal dialog with a trapped focus scope, and while the approval
        // modal was teleported out of that scope the sheet's trap reclaimed focus on
        // every focusin, so every character was swallowed and the field stayed empty.
        await actionClass.pressSequentially("exec");
        await expect(actionClass).toBeFocused();
        await expect(actionClass).toHaveValue("exec");

        await expect(dialog.locator('[data-testid="approval-classify-submit"]')).toBeEnabled();
        await dialog.locator('[data-testid="approval-classify-submit"]').click();

        await expect.poll(() => state.classifications.length).toBe(1);
        await expect.poll(() => calls.length).toBe(1);
        expect(calls[0]).toEqual({ decision: "once" });
    });
});
