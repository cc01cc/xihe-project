import { expect, test } from "./helpers/mock-test";
import type { Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { openContextPanel } from "../helpers/context-panel";
import path from "node:path";
import fs from "node:fs";

/**
 * PLAN-0414 V6 (binding selector half): real-browser verification that the
 * per-Session request-template selector pins an explicit template revision —
 * asserting the PATCH payload, the visible badge, and the rendered screenshot.
 *
 * The settings half of the original spec (component insert/reorder, live budget
 * preview, immutable revision append) asserted a template model that PLAN-0439
 * (`b74f9a44`) replaced with the API request template editor. No counterpart
 * survives, and that surface is now covered by `e2e/real/api-request-template.spec.ts`,
 * `plan0416-context-reliability.spec.ts`, `plan0503-config-catalog.spec.ts` and
 * `plan0505-delete-impact.spec.ts`, so the stale half was removed rather than
 * remapped.
 * Screenshots land in the gitignored per-plan evidence directory as run artifacts.
 */

// Resolve from this file's own location (packages/ui/e2e/mock) rather than a
// fixed `../` climb from the checkout root: a fixed climb counts directory
// levels, so running this spec inside a Git worktree (one extra level) escaped
// into `<repo>/.worktrees/plans/...` instead of the checkout's own `.local/`.
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../.."),
    EVIDENCE_DIR = path.resolve(PACKAGE_ROOT, "../../.local/evidence/plan-0414-context-templates");

const TEMPLATE_ID = "11111111-1111-4111-8111-111111111111",
    SESSION_ID = "bind-session",
    CONNECTION_ID = "33333333-3333-4333-8333-333333333333",
    API_TYPE_ID = "openai-chat-completions",
    CONNECTION_REVISION = 7;

function template(version: number, name: string) {
    return {
        id: TEMPLATE_ID,
        version,
        name,
        description: "e2e template",
        apiTypeId: API_TYPE_ID,
        apiTypeVersion: 1,
        bodySource: '{"model":"e2e"}',
        status: "published" as const,
    };
}

async function shoot(page: Page, name: string) {
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

    test("chat binding selector pins the Session to an explicit template revision", async ({
        page,
    }) => {
        await setupMockSessions(page, {
            sessions: [{ id: SESSION_ID, title: "Binding session" }],
        });

        // The pinned binding, as the CP would persist it. The Session projection must
        // reflect this after the PATCH: `SessionContextTemplate` applies the PATCH response
        // (OpenAPI: `updateSessionApiRequestTemplate` → `Session`) to the store, and the chat
        // summary row — a second instance of the resolver (PLAN-0626 M2-3) — re-reads the
        // session. A GET stub that keeps answering "unbound" forever models a server losing
        // writes, which is what made the summary assert stay red while the pin had succeeded.
        let bound: {
            layer: string;
            templateId: string;
            version: number;
            connectionRevision: number;
        } | null = null;
        const sessionProjection = () => ({
            id: SESSION_ID,
            workspaceId: "workspace-1",
            title: "Binding session",
            archived: false,
            providerConnectionId: CONNECTION_ID,
            contextTemplateLayer: bound?.layer ?? null,
            contextTemplateId: bound?.templateId ?? null,
            contextTemplateVersion: bound?.version ?? null,
        });

        // The session must carry a provider connection so the panel can scope
        // the visible templates to that connection's api type (PLAN-0523 T3.5).
        await page.route(`**/api/v1/sessions/${SESSION_ID}`, async (route) => {
            if (route.request().method() !== "GET") return route.fallback();
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(sessionProjection()),
            });
        });

        await page.route("**/api/v1/provider-connections**", async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    connections: [
                        {
                            id: CONNECTION_ID,
                            name: "E2E connection",
                            apiTypeId: API_TYPE_ID,
                            apiTypeVersion: 1,
                            revision: CONNECTION_REVISION,
                        },
                    ],
                }),
            });
        });

        // `listVisibleTemplates` reads instance + user + workspace layers; only
        // the user layer publishes a template here, so the selector offers
        // exactly one rebind target.
        await page.route("**/api/v1/config/api-request-templates**", async (route) => {
            const layer = new URL(route.request().url()).searchParams.get("layer");
            const entries =
                layer === "user"
                    ? { templates: JSON.stringify([template(1, "User Bound Template")]) }
                    : {};
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ domain: "api-request-templates", entries }),
            });
        });

        await page.route(`**/api/v1/sessions/${SESSION_ID}/api-request-template`, async (route) => {
            bound = route.request().postDataJSON() as typeof bound;
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(sessionProjection()),
            });
        });

        await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`, { waitUntil: "load" });

        // Mobile viewport renders the workspace files view first and keeps
        // ChatPanel behind the "Open chat" drawer trigger; desktop shows it inline.
        // The viewport decides this, not a `count()` probe: probing made the outcome depend on
        // whether the trigger had already rendered (flaky when the lane was loaded).
        if ((page.viewportSize()?.width ?? 1920) < 768) {
            await page.getByRole("button", { name: "Open chat" }).click();
        }

        // PLAN-0582 S4 / PLAN-0626 M2: collapsed by default. The unbound state is a
        // risk badge in the summary row; the selector itself now lives in the dock
        // `context` tab, which the summary row opens (desktop entry, not an accordion).
        // The badge is the *resolved* state of the summary-only resolver (Session + template
        // catalog + provider connections), so wait for that state with an explicit budget instead
        // of the 5 s default — under a loaded lane the three loads outlived the default.
        const settingsSummary = page.getByTestId("session-settings-summary");
        await expect(settingsSummary.getByTestId("session-settings-risk-template")).toContainText(
            "模板未绑定",
            { timeout: 15000 },
        );
        await expect(page.getByTestId("session-settings-expanded")).toBeHidden();
        await shoot(page, "04-chat-binding-default.png");

        // The helper asserts the panel is visible before returning, so the old
        // "click the summary then hope the accordion collapsed/expanded in time"
        // sequence is gone (no fixed waits).
        await openContextPanel(page);
        const select = page.getByTestId("session-context-template-select");
        await expect(select).toBeVisible();

        await select.selectOption(`user:${TEMPLATE_ID}:1`);

        // Network evidence: PATCH pins layer + template + revision, and carries
        // the connection revision the CP compares against.
        await expect.poll(() => bound).not.toBeNull();
        expect(bound).toEqual({
            layer: "user",
            templateId: TEMPLATE_ID,
            version: 1,
            connectionRevision: CONNECTION_REVISION,
        });

        // `applySessionRecord(updated)` changes `updatedAt`, which re-runs this component's
        // watcher: the selector is emptied and disabled, then re-fetches the Session and the
        // template catalog before it can show the pinned revision. Waiting for that settled state
        // (instead of asserting within the default 5 s budget) is what keeps the summary assertion
        // below from racing the reload on a loaded lane.
        await expect(select).toBeEnabled({ timeout: 15000 });
        await expect(select).toHaveValue(`user:${TEMPLATE_ID}:1`, { timeout: 15000 });

        // Visible result: the summary reflects the pinned revision.
        await expect(page.getByTestId("session-context-template-current")).toContainText(
            "User Bound Template v1",
            { timeout: 15000 },
        );
        await expect(page.getByTestId("session-settings-risk-template")).toHaveCount(0, {
            timeout: 15000,
        });
        await shoot(page, "05-chat-binding-user-template.png");
    });
});
