import { test, expect } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import path from "node:path";
import fs from "node:fs";

/**
 * PLAN-0414 V6: real-browser verification of the Context Template editor
 * (settings) and the per-Session binding selector (chat), asserting the API
 * request payload, the reloaded persistence, and the visible result.
 * Screenshots land in the PLAN evidence directory as run artifacts.
 */

const EVIDENCE_DIR = path.resolve(
    import.meta.dirname,
    "../../../../../plans/PLAN-0414-XH-context-template-and-components/evidence/browser",
);

const TEMPLATE_ID = "11111111-1111-4111-8111-111111111111";
const COMPONENT_ID = "22222222-2222-4222-8222-222222222222";

function template(version: number, name: string) {
    return {
        id: TEMPLATE_ID,
        version,
        name,
        description: "e2e template",
        document: `{{component:${COMPONENT_ID}}}`,
        components: [
            {
                instanceId: COMPONENT_ID,
                type: "conversation_history",
                enabled: true,
                config: {
                    selection: "recent",
                    maxTurns: 20,
                    maxTokens: 8000,
                    includeCompaction: true,
                },
            },
        ],
    };
}

async function shoot(page: import("@playwright/test").Page, name: string) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const viewport = (process.env.XIHE_E2E_VIEWPORT ?? "1920x1080").replace(/\D/g, "-");
    await page.screenshot({
        path: path.join(EVIDENCE_DIR, name.replace(".png", `-${viewport}.png`)),
        fullPage: false,
    });
}

test.describe("Context templates (PLAN-0414)", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
    });

    test("settings editor appends an immutable revision and shows a configuration-level preview", async ({
        page,
    }) => {
        // In-memory store: GET serves it, PUT captures + updates it so the reload
        // proves persistence of the appended revision.
        let stored: Record<string, string> = {
            templates: JSON.stringify([template(1, "E2E Template")]),
        };
        const puts: Array<Record<string, string>> = [];

        await page.route("**/api/v1/config/**context-templates**", async (route) => {
            if (route.request().method() === "PUT") {
                const body = route.request().postDataJSON() as Record<string, string>;
                puts.push(body);
                stored = { ...stored, ...body };
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ status: "ok" }),
                });
                return;
            }
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    domain: "context-templates",
                    entries: stored,
                    envOverridden: {},
                }),
            });
        });

        await page.goto("/settings/config", { waitUntil: "load" });
        await page.getByTestId("config-tab-user").click();

        const panel = page.getByTestId("context-templates-panel");
        await expect(panel).toBeVisible();

        // Persistence: the layer GET feeds the list; v1 renders with its revision badge.
        await expect(page.getByTestId("context-template-list")).toContainText("E2E Template");
        await expect(
            page.getByTestId("context-template-item-11111111-1111-4111-8111-111111111111"),
        ).toBeVisible();
        await expect(page.getByTestId("context-template-preview")).toBeVisible();
        await expect(page.getByTestId("context-template-preview-row-0")).toBeVisible();
        await expect(page.getByTestId("context-template-preview-status-0")).toHaveText("已解析");
        await expect(page.getByTestId("context-template-preview-budget")).toContainText(
            "8000 tokens",
        );
        await shoot(page, "01-settings-template-loaded.png");

        // Rename + edit a component's typed config (JSON) — budget sum must update live.
        await page.getByTestId("context-template-name").fill("E2E Template v2");
        await page
            .getByTestId("context-template-component-config-0")
            .fill('{"selection":"recent","maxTurns":20,"maxTokens":9000,"includeCompaction":true}');
        await expect(page.getByTestId("context-template-preview-budget")).toContainText(
            "9000 tokens",
        );

        // Insert a second component, reorder it to the top, then append a third.
        await page.getByTestId("context-template-insert-select").selectOption("text");
        await page.getByTestId("context-template-insert").click();
        await expect(page.getByTestId("context-template-component-1")).toBeVisible();
        await page.getByTestId("context-template-component-move-up-1").click();
        await expect(page.getByTestId("context-template-component-0")).toContainText("文本 text");
        await expect(page.getByTestId("context-template-component-1")).toContainText("对话历史");
        await page.getByTestId("context-template-insert-select").selectOption("workspace_tree");
        await page.getByTestId("context-template-insert").click();
        await expect(page.getByTestId("context-template-component-2")).toBeVisible();
        await expect(page.getByTestId("context-template-preview")).toContainText("workspace_tree");
        await shoot(page, "02-settings-insert-component.png");

        await page.getByTestId("context-template-save").click();

        // Network evidence: v1 retained + v2 appended, order and config persisted.
        await expect.poll(() => puts.length).toBeGreaterThan(0);
        const saved = JSON.parse(puts.at(-1)!.templates) as Array<{
            version: number;
            name: string;
            components: Array<{ type: string; config: Record<string, unknown> }>;
        }>;
        expect(saved).toHaveLength(2);
        expect(saved.map((item) => item.version).sort()).toEqual([1, 2]);
        expect(saved.find((item) => item.version === 2)?.name).toBe("E2E Template v2");
        const v2 = saved.find((item) => item.version === 2)!;
        expect(v2.components.map((component) => component.type)).toEqual([
            "text",
            "conversation_history",
            "workspace_tree",
        ]);
        const conversation = v2.components.find(
            (component) => component.type === "conversation_history",
        )!;
        expect(conversation.config.maxTokens).toBe(9000);

        // Visible persistence: reload serves the stored map, list shows the new name.
        await expect(page.getByTestId("context-template-list")).toContainText("E2E Template v2");
        await expect(page.getByTestId("context-template-revisions")).toContainText("v1");
        await expect(page.getByTestId("context-template-revisions")).toContainText("v2");
        await shoot(page, "03-settings-saved-v2.png");
    });

    test("chat binding selector pins the Session to an explicit template revision", async ({
        page,
    }) => {
        await setupMockSessions(page, {
            sessions: [{ id: "bind-session", title: "Binding session" }],
        });

        let bound: { layer: string; templateId: string; version: number } | null = null;
        await page.route("**/api/v1/config/**context-templates**", async (route) => {
            if (route.request().method() === "PUT") {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({}),
                });
                return;
            }
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    domain: "context-templates",
                    entries: { templates: JSON.stringify([template(1, "User Bound Template")]) },
                    envOverridden: {},
                }),
            });
        });
        await page.route("**/api/v1/sessions/bind-session/context-template", async (route) => {
            const body = route.request().postDataJSON() as {
                layer: string;
                templateId: string;
                version: number;
            };
            bound = body;
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    id: "bind-session",
                    workspaceId: "workspace-1",
                    title: "Binding session",
                    archived: false,
                    contextTemplateLayer: body.layer,
                    contextTemplateId: body.templateId,
                    contextTemplateVersion: body.version,
                }),
            });
        });

        await page.goto("/workspace/workspace-1/chat/bind-session", { waitUntil: "load" });

        // Mobile viewport (390px) renders the workspace files view first and keeps
        // ChatPanel behind the "Open chat" drawer trigger; desktop shows it inline.
        const openChat = page.getByRole("button", { name: "Open chat" });
        if (await openChat.count()) {
            await openChat.click();
        }

        const badge = page.getByTestId("session-context-template-current");
        await expect(page.getByTestId("session-context-template-select")).toBeVisible();
        // Default resolution lands on the built-in instance template before rebind.
        await expect(badge).toContainText("内置默认模板");
        await shoot(page, "04-chat-binding-default.png");

        await page
            .getByTestId("session-context-template-select")
            .selectOption(`user:${TEMPLATE_ID}:1`);

        // Network evidence: explicit PATCH payload.
        await expect.poll(() => bound).not.toBeNull();
        expect(bound).toEqual({ layer: "user", templateId: TEMPLATE_ID, version: 1 });

        // Visible result: badge reflects the pinned revision.
        await expect(badge).toContainText("User Bound Template v1");
        await shoot(page, "05-chat-binding-user-template.png");
    });
});
