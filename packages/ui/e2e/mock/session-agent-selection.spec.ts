import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";
import { selectByIndex } from "../helpers/select";

// BL-318：`a failed agent list resets the loading state…` 故意桩 500（验失败态 + 重试恢复），
// 逐条放行 `/workspaces/*/agents` 的失败信号。
test.use({ mockAllow: [...DEFAULT_MOCK_ALLOW, String.raw`/workspaces/[^/]+/agents`] });

test("new Workspace Session is created only after selecting a bound Agent", async ({ page }) => {
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [], createSession: true });

    await page.route("**/api/v1/workspaces/workspace-1/agents", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            // PLAN-0622 M1.2 contract: the list is `{agents:[…]}` and each row carries `bound`
            // (visible but not yet bound to this workspace) / `disabled` (D26/D27). A bare array
            // with no `bound` made `api.getWorkspaceAgents` throw on `raw.agents.map` and left
            // `boundWorkspaceAgents` empty, so the picker could never offer this Agent.
            body: JSON.stringify({
                agents: [
                    {
                        principalId: "agent-1",
                        name: "ResearchAgent",
                        templateId: null,
                        templateName: "Research",
                        createdAt: new Date().toISOString(),
                        bound: true,
                        disabled: false,
                        permissions: [{ actionClass: "read" }],
                        hooks: null,
                        contextPolicy: null,
                    },
                ],
            }),
        });
    });

    await page.goto("/workspace/workspace-1?newChat=1");
    const selector = page.getByTestId("workspace-agent-principal-select");
    await expect(selector).toBeVisible();
    await expect(page.getByTestId("workspace-create-agent-session")).toBeDisabled();

    await selectByIndex(selector, 1);
    const createRequestPromise = page.waitForRequest(
        // PLAN-0608 C′: UI now posts to /api/v1/workspaces/{id}/sessions, so match
        // both surfaces by pathname instead of a legacy suffix.
        (request) =>
            request.method() === "POST" &&
            /^\/api\/v1\/(workspaces\/[^/]+\/)?sessions$/.test(new URL(request.url()).pathname),
    );
    await page.getByTestId("workspace-create-agent-session").click();

    const createRequest = await createRequestPromise;
    await expect(page).toHaveURL(/\/workspace\/workspace-1\/chat\/mock-session-/);
    await expect(page.getByTestId("modal-backdrop")).toHaveCount(0);
    await expect(page.getByTestId("workspace-active-agent")).toContainText("agent-1");
    if ((page.viewportSize()?.width ?? 1920) < 768) {
        await page.getByTestId("mobile-chat-open").click();
        const sheet = page.getByTestId("mobile-chat-sheet");
        await expect(sheet).toBeVisible();
        await expect(page.getByTestId("mobile-session-agent")).toContainText("agent-1");
        await sheet.evaluate(async (element) => {
            await Promise.all(
                element.getAnimations({ subtree: true }).map((animation) => animation.finished),
            );
        });
    }
    const chatInput = page.getByTestId("chat-input");
    await expect(chatInput).toBeVisible();
    if ((page.viewportSize()?.width ?? 1920) < 768) {
        const hitTest = await chatInput.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const target = document.elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
            );
            return {
                targetIsInput: target === element || element.contains(target),
                sheetBackground: getComputedStyle(
                    element.closest('[data-testid="mobile-chat-sheet"]')!,
                ).backgroundColor,
                sheetOpacity: getComputedStyle(
                    element.closest('[data-testid="mobile-chat-sheet"]')!,
                ).opacity,
            };
        });
        expect(hitTest.targetIsInput, JSON.stringify(hitTest)).toBe(true);
        expect(hitTest.sheetOpacity, JSON.stringify(hitTest)).toBe("1");
    }
    expect(createRequest.postDataJSON()).toEqual({
        title: "New Chat",
        agentPrincipalId: "agent-1",
    });
    await page.screenshot({
        path: test
            .info()
            .outputPath(
                `session-agent-selected-${process.env.XIHE_E2E_VIEWPORT ?? "1920x1080"}.png`,
            ),
    });
});

test("creates a principal separately, binds an explicit cap, and confirms unbinding", async ({
    page,
}) => {
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [] });

    // PLAN-0621 F-01: the create button stays disabled (fail-closed) until the authoritative
    // capability projection says a scope is writable. The `{}` catch-all left
    // `availableScopes` empty, so `agent-principal-create` was permanently disabled and the
    // click timed out. This caller may create Workspace Agents.
    await page.route("**/api/v1/me/permissions", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                userId: "user-1",
                instanceCapabilities: [],
                instancePermissions: [],
                workspaces: [
                    {
                        workspaceId: "workspace-1",
                        workspaceRole: "OWNER",
                        workspaceAdmin: true,
                        permissions: [
                            { actionClass: "MANAGE_WORKSPACE_AGENTS", resource: "workspace-1" },
                        ],
                    },
                ],
            }),
        }),
    );

    const bindings: Array<Record<string, unknown>> = [];
    await page.route("**/api/v1/workspaces/workspace-1/agents**", async (route) => {
        const request = route.request();
        if (request.method() === "GET") {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                // PLAN-0622 M1.2: the list envelope is `{agents:[…]}` — a bare array throws in
                // `api.getWorkspaceAgents` (`raw.agents.map`), which reads as "no agents".
                body: JSON.stringify({ agents: bindings }),
            });
            return;
        }
        if (request.method() === "PUT") {
            const body = request.postDataJSON() as {
                permissions: Array<{ actionClass: string; resource?: string }>;
            };
            // `GET /agents` answers with the full `WorkspaceAgentView`, whose
            // `permissionsSnapshot` is **required** (OpenAPI), while CP's PUT answers the
            // narrower `{principalId, workspaceId, permissions}` echo. Storing the echo in
            // the list produced a contract-violating row: the panel's cap list reads
            // `permissionsSnapshot.length`, the render aborted, and the DOM stayed on the
            // previous frame ("正在加载智能体…") — the freeze this case used to report.
            const bindingRow = {
                principalId: "agent-1",
                name: "ResearchAgent",
                templateId: null,
                templateName: null,
                createdAt: new Date().toISOString(),
                bound: true,
                disabled: false,
                permissionsSnapshot: body.permissions,
                hooks: null,
                contextPolicy: null,
            };
            const existingIndex = bindings.findIndex(
                (binding) => binding.principalId === "agent-1",
            );
            if (existingIndex < 0) bindings.push(bindingRow);
            else bindings[existingIndex] = bindingRow;
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    principalId: "agent-1",
                    workspaceId: "workspace-1",
                    permissions: body.permissions,
                }),
            });
            return;
        }
        if (request.method() === "DELETE") {
            bindings.splice(0, bindings.length);
            await route.fulfill({ status: 204 });
            return;
        }
        await route.fallback();
    });

    let createBody: unknown;
    await page.route("**/api/v1/agent-principals", async (route) => {
        createBody = route.request().postDataJSON();
        await route.fulfill({
            status: 201,
            contentType: "application/json",
            body: JSON.stringify({
                principalId: "agent-1",
                templateId: null,
                templateName: null,
                createdAt: new Date().toISOString(),
            }),
        });
    });

    await page.goto("/workspace/workspace-1");
    const agentManagementButton =
        (page.viewportSize()?.width ?? 1920) < 768
            ? page.getByTestId("workspace-toolbar-agents-mobile")
            : page.getByTestId("workspace-toolbar-agents");
    await agentManagementButton.click();
    const dialog = page.getByTestId("workspace-agent-management-dialog");
    await expect(dialog).toBeVisible();

    await page.getByTestId("agent-principal-name").fill("ResearchAgent");
    await page.getByTestId("agent-principal-create").click();
    await expect(page.getByTestId("unbound-agent-principal")).toContainText("agent-1");
    await page.getByTestId("agent-cap-read").check();
    const readResource = dialog.getByTestId("agent-resource-read");
    await readResource.fill("src/*");
    await page.getByTestId("agent-principal-bind").click();

    const binding = page.getByTestId("workspace-agent-agent-1");
    await expect(binding).toContainText("ResearchAgent");
    await expect(binding).toContainText("src/*");
    expect(createBody).toEqual({
        name: "ResearchAgent",
    });

    await binding.getByTestId("workspace-agent-edit-cap-agent-1").click();
    await page.getByTestId("agent-cap-write").check();
    await page.getByTestId("workspace-agent-save-cap-agent-1").click();
    await expect(binding).toContainText("写入");
    await expect(dialog.getByRole("status")).toContainText("工作区角色已保存");
    await page.screenshot({
        path: test
            .info()
            .outputPath(
                `agent-management-bound-${process.env.XIHE_E2E_VIEWPORT ?? "1920x1080"}.png`,
            ),
    });

    const unbind = page.getByTestId("workspace-agent-unbind-agent-1");
    await unbind.click();
    await expect(unbind).toHaveText("再次点击确认解绑");
    await unbind.click();
    await expect(page.getByText("此工作区尚未绑定智能体")).toBeVisible();
    await page.screenshot({
        path: test
            .info()
            .outputPath(
                `agent-management-unbound-${process.env.XIHE_E2E_VIEWPORT ?? "1920x1080"}.png`,
            ),
    });
});

/**
 * PLAN-0651 M5 T5.1: the create form no longer offers a principal `scope` selector and creation
 * itself is gated on `MANAGE_WORKSPACE_AGENTS`. A caller without it (fixture: only the user-tier
 * MEMORY_WRITE_SELF atom; BL-312 removed the former CREATE_OWN_AGENT sample) must be
 * stopped before the click, with the F-02 grant hint, and must not fire a create or bind request.
 */
test("a caller without MANAGE_WORKSPACE_AGENTS cannot create or bind before the click", async ({
    page,
}) => {
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [] });
    await page.route("**/api/v1/me/permissions", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                userId: "user-1",
                instanceCapabilities: [],
                instancePermissions: [{ actionClass: "MEMORY_WRITE_SELF", resource: "*" }],
                workspaces: [
                    {
                        workspaceId: "workspace-1",
                        workspaceRole: "EDITOR",
                        workspaceAdmin: false,
                        permissions: [],
                    },
                ],
            }),
        }),
    );

    const bindCalls: Array<Record<string, unknown>> = [];
    let createCalls = 0;
    await page.route("**/api/v1/workspaces/workspace-1/agents**", async (route) => {
        if (route.request().method() === "GET") {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ agents: [] }),
            });
            return;
        }
        bindCalls.push((route.request().postDataJSON() as Record<string, unknown>) ?? {});
        await route.fulfill({
            status: 403,
            contentType: "application/problem+json",
            body: JSON.stringify({
                type: "about:blank",
                title: "Forbidden",
                status: 403,
                code: "FORBIDDEN",
                detail: "MANAGE_WORKSPACE_AGENTS permission is required",
            }),
        });
    });
    await page.route("**/api/v1/agent-principals", (route) => {
        createCalls += 1;
        return route.fulfill({
            status: 403,
            contentType: "application/problem+json",
            body: JSON.stringify({
                type: "about:blank",
                title: "Forbidden",
                status: 403,
                code: "FORBIDDEN",
                detail: "MANAGE_WORKSPACE_AGENTS permission is required",
            }),
        });
    });

    await page.goto("/workspace/workspace-1");
    const managementButton =
        (page.viewportSize()?.width ?? 1920) < 768
            ? page.getByTestId("workspace-toolbar-agents-mobile")
            : page.getByTestId("workspace-toolbar-agents");
    await managementButton.click();

    await expect(page.getByTestId("agent-principal-scope")).toHaveCount(0);
    await page.getByTestId("agent-principal-name").fill("CreatedWithoutManageGrant");
    const create = page.getByTestId("agent-principal-create");
    await expect(create).toBeDisabled();
    await expect(page.getByTestId("agent-create-forbidden-hint")).toContainText("角色与绑定");
    expect(createCalls).toBe(0);

    const bind = page.getByTestId("agent-principal-bind");
    await expect(bind).toHaveCount(0);
    expect(bindCalls).toEqual([]);

    await expect(page.getByText("此工作区尚未绑定智能体")).toBeVisible();
});

/** OWNER projection, so the panel opens in its normal (writable) shape. */
async function stubOwnerPermissions(page: Page): Promise<void> {
    await page.route("**/api/v1/me/permissions", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                userId: "user-1",
                instanceCapabilities: [],
                instancePermissions: [],
                workspaces: [
                    {
                        workspaceId: "workspace-1",
                        workspaceRole: "OWNER",
                        workspaceAdmin: true,
                        permissions: [
                            { actionClass: "MANAGE_WORKSPACE_AGENTS", resource: "workspace-1" },
                        ],
                    },
                ],
            }),
        }),
    );
}

/** `GET /agent-templates` per layer; the `{}` catch-all breaks `result.templates.map`. */
async function stubAgentTemplates(page: Page): Promise<void> {
    await page.route("**/api/v1/agent-templates**", (route) => {
        const layer = new URL(route.request().url()).searchParams.get("layer") ?? "user";
        return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ layer, workspaceId: null, templates: [] }),
        });
    });
}

/** `WorkspaceAgentView` row (PLAN-0622 M1.2 shape, `permissionsSnapshot` required). */
function agentViewRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        principalId: "agent-1",
        name: "ResearchAgent",
        templateId: null,
        templateName: null,
        createdAt: new Date().toISOString(),
        bound: true,
        disabled: false,
        permissionsSnapshot: [{ actionClass: "read", resource: "src/*" }],
        hooks: null,
        contextPolicy: null,
        ...overrides,
    };
}

async function openAgentsPanel(page: Page): Promise<void> {
    await page.goto("/workspace/workspace-1");
    await page.getByTestId("workspace-toolbar-agents").click();
    await expect(page.getByRole("heading", { name: "已绑定智能体" })).toBeVisible({
        timeout: ACTION_TIMEOUT_MS,
    });
}

test("a failed agent list resets the loading state, names the failure, and retry recovers", async ({
    page,
}) => {
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [] });
    await stubOwnerPermissions(page);
    await stubAgentTemplates(page);

    let failing = true;
    await page.route("**/api/v1/workspaces/workspace-1/agents", async (route) => {
        if (failing) {
            await route.fulfill({
                status: 500,
                contentType: "application/problem+json",
                body: JSON.stringify({
                    type: "about:blank",
                    title: "Internal Server Error",
                    status: 500,
                    code: "INTERNAL_ERROR",
                    detail: "agents unavailable",
                    requestId: "req-agents-500",
                }),
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ agents: [agentViewRow()] }),
        });
    });

    await page.goto("/workspace/workspace-1");
    await page.getByTestId("workspace-toolbar-agents").click();

    // Failure is a terminal state: the spinner must not survive it, and the reason must be visible
    // (a stuck "正在加载智能体…" is exactly what hid this outcome before).
    await expect(page.getByTestId("agent-error")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
    await expect(page.getByTestId("agent-error")).toContainText("agents unavailable");
    await expect(page.getByText("正在加载智能体…")).toHaveCount(0);
    await expect(page.getByTestId("workspace-agent-refresh")).toBeEnabled();

    failing = false;
    await page.getByTestId("workspace-agent-refresh").click();
    await expect(page.getByTestId("workspace-agent-agent-1")).toContainText("ResearchAgent");
    await expect(page.getByTestId("agent-error")).toHaveCount(0);
});

test("one contract-violating row degrades instead of freezing the whole list", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [] });
    await stubOwnerPermissions(page);
    await stubAgentTemplates(page);
    await page.route("**/api/v1/workspaces/workspace-1/agents", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                // `permissionsSnapshot` is required by `WorkspaceAgentView`; a row that lost it must
                // not abort the render (the cap list reads `.length`), otherwise the panel keeps the
                // previous "loading" frame forever and the next click reads as a dead button.
                agents: [{ ...agentViewRow(), permissionsSnapshot: undefined }],
            }),
        }),
    );

    await openAgentsPanel(page);

    const row = page.getByTestId("workspace-agent-agent-1");
    await expect(row).toContainText("ResearchAgent");
    await expect(row).toContainText("无工具权限");
    await expect(page.getByText("正在加载智能体…")).toHaveCount(0);
    expect(pageErrors).toEqual([]);
});
