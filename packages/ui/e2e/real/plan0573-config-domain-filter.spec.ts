import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { collectPageErrors, actionableErrors } from "./helpers/console";
import { generateE2EPassword } from "./helpers/password";

// PLAN-0573: the UI must not issue merged `GET /config/{domain}` requests for
// domains CP rejects with 403 for non-admins (the strict console gate sees
// every 403). Non-admin boots fetch the readable subset; admin behavior is
// unchanged (full CONFIG_DOMAINS pull, instance tab renders `logging`).
const CP_URL = `http://127.0.0.1:${process.env.XIHE_CP_PORT || "12631"}`,
    UI_URL = `http://localhost:${process.env.XIHE_UI_PORT || "12630"}`,
    ADMIN_EMAIL = "admin@xihe.local";

/** Merged-read domains CP accepts from a non-admin (ConfigService isReadableByNonAdmin). */
const NON_ADMIN_MERGED_DOMAINS = [
    "llm-provider",
    "context-policy",
    "embedding",
    "rag",
    "agent-runtime",
    "agent-profile",
    "user-preference",
    "approval-policy",
    "job-policy",
];

interface LoginResult {
    accessToken: string;
    user: Record<string, unknown>;
    workspaceId: string;
}

async function injectSession(page: Page, auth: LoginResult) {
    await page.addInitScript(
        ({ token, user, workspaceId }) => {
            localStorage.setItem("xihe-token", token);
            localStorage.setItem("xihe-user", JSON.stringify(user));
            localStorage.setItem(
                "xihe-workspace",
                JSON.stringify({ id: workspaceId, name: "E2E" }),
            );
        },
        { token: auth.accessToken, user: auth.user, workspaceId: auth.workspaceId },
    );
}

function mergedConfigUrl(domain: string): RegExp {
    return new RegExp(`/api/v1/config/${domain}(\\?|$)`);
}

test.describe.serial("@host PLAN-0573 config domain filter", () => {
    let adminAuth: LoginResult;

    test.beforeAll(async ({ request }) => {
        const adminPassword = process.env.XIHE_E2E_ADMIN_PASSWORD ?? "";
        expect(adminPassword, "XIHE_E2E_ADMIN_PASSWORD must be provided by e2e-host").not.toBe("");
        const login = await request.post(`${CP_URL}/api/v1/auth/login`, {
            data: { identifier: ADMIN_EMAIL, password: adminPassword },
        });
        expect(login.ok(), await login.text()).toBe(true);
        adminAuth = (await login.json()) as LoginResult;
    });

    test("V1: non-admin boot fetches readable domains only and keeps the console clean", async ({
        page,
        request,
    }) => {
        test.setTimeout(120000);
        const registration = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `plan0573-${randomUUID()}@test.local`,
                password: generateE2EPassword(),
                name: "PLAN-0573",
            },
        });
        expect(registration.status(), await registration.text()).toBe(201);
        const registered = (await registration.json()) as {
            accessToken: string;
            workspaceId: string;
        };
        // Register returns only tokens — hydrate the user object the SPA seeds
        // from /auth/me (role=USER drives the non-admin filter path).
        const me = await request.get(`${CP_URL}/api/v1/auth/me`, {
            headers: { Authorization: `Bearer ${registered.accessToken}` },
        });
        expect(me.ok(), await me.text()).toBe(true);
        const userAuth: LoginResult = {
            accessToken: registered.accessToken,
            workspaceId: registered.workspaceId,
            user: (await me.json()) as Record<string, unknown>,
        };

        const configRequests: string[] = [],
            errors = collectPageErrors(page);
        page.on("request", (req) => {
            const match = req.url().match(/\/api\/v1\/config\/([a-z-]+)(\?|$)/);
            if (match) configRequests.push(match[1]);
        });

        await injectSession(page, userAuth);
        await page.goto(`${UI_URL}/settings/config`);
        await expect(page.getByTestId("config-tab-user")).toBeVisible({ timeout: 15000 });
        // Both config batches are issued synchronously (boot merged pull at App
        // mount, then the user-tab layer pull): llm-provider appears twice by
        // the time the settings page has rendered both surfaces.
        await expect
            .poll(() => configRequests.filter((d) => d === "llm-provider").length, {
                timeout: 15000,
            })
            .toBeGreaterThanOrEqual(2);

        // No doomed request at all — merged or layer-shaped.
        expect(configRequests).not.toContain("logging");
        for (const domain of NON_ADMIN_MERGED_DOMAINS) {
            expect(configRequests, `missing readable domain ${domain}`).toContain(domain);
        }
        // The instance tab is admin-only: no instance-layer requests either.
        expect(
            configRequests.filter((domain) => domain === "logging"),
            "non-admin must never request /config/logging",
        ).toEqual([]);
        expect(actionableErrors(errors), errors.join("\n")).toEqual([]);

        await page.screenshot({ scale: "css",
            path: test.info().outputPath("plan0573-non-admin-config.png"),
            fullPage: true,
        });
    });

    test("V2: admin boot still pulls logging and the instance tab renders it", async ({ page }) => {
        test.setTimeout(120000);
        const configRequests: string[] = [],
            loggingResponses: number[] = [],
            errors = collectPageErrors(page);
        page.on("request", (req) => {
            const match = req.url().match(/\/api\/v1\/config\/([a-z-]+)(\?|$)/);
            if (match) configRequests.push(match[1]);
        });
        page.on("response", (res) => {
            if (mergedConfigUrl("logging").test(res.url())) loggingResponses.push(res.status());
        });

        await injectSession(page, adminAuth);
        await page.goto(`${UI_URL}/settings/config`);

        // Admin bypass unchanged: the merged batch includes `logging` and lands 200.
        await expect
            .poll(() => loggingResponses.length, { timeout: 15000 })
            .toBeGreaterThanOrEqual(1);
        expect(
            loggingResponses.filter((status) => status !== 200),
            "every admin logging read must succeed",
        ).toEqual([]);
        expect(configRequests, "admin boot must request the logging domain").toContain("logging");
        await expect(page.getByTestId("config-tab-instance")).toBeVisible({ timeout: 15000 });
        const loggingPanel = page.getByTestId("config-domain-logging");
        await expect(loggingPanel).toBeVisible({ timeout: 15000 });
        for (const domain of NON_ADMIN_MERGED_DOMAINS) {
            expect(configRequests, `admin batch missing ${domain}`).toContain(domain);
        }
        expect(actionableErrors(errors), errors.join("\n")).toEqual([]);

        await page.screenshot({ scale: "css",
            path: test.info().outputPath("plan0573-admin-config.png"),
            fullPage: true,
        });
    });
});
