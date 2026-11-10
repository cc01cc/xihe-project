// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { expectPlatformScreenshot } from "../helpers/visual";
import { LONG_TIMEOUT_MS } from "../timeouts";

/**
 * PLAN-0610 W5c — **retirement spec** (formerly the PLAN-0585 M2 acceptance for the grant page).
 *
 * The `/api/v1/principal-grants/*` write surface was retired in W2 (decision #28: `410
 * PRINCIPAL_GRANTS_RETIRED`, `source='direct'` rows went inert with V88) and the admin page itself
 * is retired in W5c: the component is gone, the nav entry is gone, and `/settings/principal-grants`
 * is a **redirect** to `/settings/roles` so an old bookmark does not land on a blank route.
 *
 * This file is kept (not deleted — removing a tracked spec needs wave approval) and rewritten to
 * assert exactly that, so the day someone reintroduces the surface, or drops the redirect, this goes
 * red. Every assertion is a retirement claim; none of them re-seed grants.
 *
 * External-service mode (shared isolated stack):
 *   XIHE_E2E_EXTERNAL_SERVER=1        reuse the running UI instead of `pnpm dev` (playwright.config)
 *   XIHE_CP_BASE_URL | XIHE_CP_PORT   CP origin — no port is hardcoded in this spec
 *   XIHE_E2E_ADMIN_TOKEN              instance-admin bearer (preferred)
 *     or XIHE_E2E_ADMIN_USERNAME|XIHE_E2E_ADMIN_EMAIL + XIHE_E2E_ADMIN_PASSWORD (login)
 *
 * Missing contract ⇒ tests skip with an actionable message so `--list` and the rest of the real lane
 * stay runnable. No `waitForTimeout`: every wait is an explicit `waitForResponse` or locator timeout.
 */

interface AdminSession {
    token: string;
    userId: string;
    email: string;
    name: string;
    workspaceId: string;
}

/**
 * The exact shape `stores/auth.ts` hydrates from `localStorage["xihe-user"]`.
 *
 * PLAN-0610 W3-2b (decision #22): authority comes from `capabilities`, never from a `role` string, so
 * seeding a `role` (as this spec used to) would silently render every admin surface as its 403
 * branch — that is exactly the fixture mistake the old comment warned about, one level deeper.
 */
interface Identity {
    id: string;
    email: string;
    name: string;
    capabilities: {
        isInstanceAdmin: boolean;
        isInstanceSuper: boolean;
        workspaceAdminOf: string[];
    };
}

function cpOrigin(): string {
    const explicit = process.env.XIHE_CP_BASE_URL;
    if (explicit) return explicit.replace(/\/$/, "");
    const port = process.env.XIHE_CP_PORT;
    return port ? `http://localhost:${port}` : "";
}

function hasAdminContract(): boolean {
    return (
        Boolean(process.env.XIHE_E2E_ADMIN_TOKEN) ||
        Boolean(
            (process.env.XIHE_E2E_ADMIN_USERNAME || process.env.XIHE_E2E_ADMIN_EMAIL) &&
            process.env.XIHE_E2E_ADMIN_PASSWORD,
        )
    );
}

function missingContract(): string {
    if (!cpOrigin()) return "Set XIHE_CP_BASE_URL (or XIHE_CP_PORT) to the shared stack CP origin";
    if (!hasAdminContract()) {
        return "Set XIHE_E2E_ADMIN_TOKEN, or XIHE_E2E_ADMIN_USERNAME+XIHE_E2E_ADMIN_PASSWORD";
    }
    return "";
}

function bearer(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function loginAdmin(request: APIRequestContext, origin: string): Promise<AdminSession> {
    if (process.env.XIHE_E2E_ADMIN_TOKEN) {
        const token = process.env.XIHE_E2E_ADMIN_TOKEN;
        const me = await request.get(`${origin}/api/v1/auth/me`, { headers: bearer(token) });
        expect(me.status(), `GET /auth/me -> ${me.status()} ${await me.text()}`).toBe(200);
        const raw = (await me.json()) as {
            id: string;
            email?: string;
            name?: string;
            capabilities?: { isInstanceAdmin?: boolean };
        };
        expect(
            raw.capabilities?.isInstanceAdmin,
            "XIHE_E2E_ADMIN_TOKEN must belong to an instance administrator (cap:instance:admin)",
        ).toBe(true);
        const workspaceId = await firstWorkspace(request, origin, token);
        return {
            token,
            userId: raw.id,
            email: raw.email ?? "",
            name: raw.name ?? "admin",
            workspaceId,
        };
    }

    const identifier =
        process.env.XIHE_E2E_ADMIN_USERNAME ?? process.env.XIHE_E2E_ADMIN_EMAIL ?? "";
    const login = await request.post(`${origin}/api/v1/auth/login`, {
        data: { identifier, password: process.env.XIHE_E2E_ADMIN_PASSWORD },
    });
    expect(login.status(), `POST /auth/login -> ${login.status()} ${await login.text()}`).toBe(200);
    const body = (await login.json()) as {
        accessToken: string;
        workspaceId?: string;
        user: {
            id: string;
            email?: string;
            name?: string;
            capabilities?: { isInstanceAdmin?: boolean };
        };
    };
    expect(
        body.user.capabilities?.isInstanceAdmin,
        "the admin login must carry cap:instance:admin",
    ).toBe(true);
    const workspaceId =
        body.workspaceId ?? (await firstWorkspace(request, origin, body.accessToken));
    expect(workspaceId, "the admin login must resolve a workspace").not.toBe("");
    return {
        token: body.accessToken,
        userId: body.user.id,
        email: body.user.email ?? "",
        name: body.user.name ?? "admin",
        workspaceId,
    };
}

async function firstWorkspace(
    request: APIRequestContext,
    origin: string,
    token: string,
): Promise<string> {
    const configured = process.env.XIHE_E2E_ADMIN_WORKSPACE_ID;
    if (configured) return configured;
    const list = await request.get(`${origin}/api/v1/workspaces`, { headers: bearer(token) });
    expect(list.status(), `GET /workspaces -> ${await list.text()}`).toBe(200);
    const rows = (await list.json()) as Array<{ id: string }>;
    expect(rows.length, "admin token must expose at least one workspace").toBeGreaterThan(0);
    return rows[0].id;
}

/** Seeds the UI auth context without driving the login form (PLAN-0560 storage shape). */
function seedContext(page: Page, session: AdminSession, asAdmin: boolean) {
    const identity: Identity = {
        id: session.userId,
        email: session.email,
        name: session.name,
        capabilities: {
            isInstanceAdmin: asAdmin,
            isInstanceSuper: false,
            workspaceAdminOf: [],
        },
    };
    page.addInitScript(
        ({ token, ws, user }) => {
            localStorage.setItem("xihe-token", token);
            localStorage.setItem("xihe-user", JSON.stringify(user));
            localStorage.setItem(
                "xihe-workspace",
                JSON.stringify({ id: ws, name: "Default Workspace" }),
            );
            sessionStorage.setItem(
                "xihe-workspace",
                JSON.stringify({
                    id: ws,
                    name: "Default Workspace",
                    workspaceRole: "OWNER",
                    ownerId: "x",
                }),
            );
        },
        { token: session.token, ws: session.workspaceId, user: identity },
    );
}

test.describe("@host PLAN-0610 W5c principal-grant retirement", () => {
    let admin: AdminSession;
    let origin = "";

    test.beforeAll(async ({ request }) => {
        if (missingContract()) return;
        origin = cpOrigin();
        admin = await loginAdmin(request, origin);
        console.log(`[plan-0610-w5c] admin=${admin.email} ws=${admin.workspaceId}`);
    });

    test.beforeEach(() => {
        const missing = missingContract();
        test.skip(Boolean(missing), missing);
    });

    test("the CP surface answers 410 PRINCIPAL_GRANTS_RETIRED for both verbs", async ({
        request,
    }) => {
        const read = await request.get(`${origin}/api/v1/principal-grants/some-user`, {
            headers: bearer(admin.token),
        });
        expect(read.status(), `GET -> ${read.status()} ${await read.text()}`).toBe(410);

        const write = await request.patch(`${origin}/api/v1/principal-grants/some-user`, {
            headers: bearer(admin.token),
            data: { add: [{ actionClass: "CREATE_ACCOUNT", resource: "*" }] },
        });
        expect(write.status(), `PATCH -> ${write.status()} ${await write.text()}`).toBe(410);
    });

    test("an old bookmark is redirected to the role surface instead of a blank route", async ({
        page,
    }) => {
        seedContext(page, admin, true);
        await page.goto("/settings/principal-grants", { waitUntil: "load" });

        await expect(page).toHaveURL(/\/settings\/roles$/, { timeout: LONG_TIMEOUT_MS });
        await expect(page.getByTestId("roles-view")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        // The retired page's own test ids must not exist any more.
        await expect(page.getByTestId("principal-grant-view")).toHaveCount(0);
        await expect(page.getByTestId("principal-grant-username")).toHaveCount(0);
        await page.screenshot({
            path: "test-results/plan-0610-w5c/01-old-bookmark-redirect.png",
            fullPage: true,
        });
        expectPlatformScreenshot(page, "plan-0610-w5c-old-bookmark-redirect.png");
    });

    test("the settings nav offers roles instead of the retired page and never calls the old API", async ({
        page,
    }) => {
        seedContext(page, admin, true);
        const retiredCalls: string[] = [];
        page.on("request", (request) => {
            if (request.url().includes("/api/v1/principal-grants/")) {
                retiredCalls.push(request.url());
            }
        });

        await page.goto("/settings/user/llm-provider", { waitUntil: "load" });
        // PLAN-0752 后左栏是域/资源链接，运维项没有 per-item testid ⇒ 用 href 定位。
        const rolesItem = page.locator('a[href="/settings/roles"]');
        await expect(rolesItem).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await expect(page.locator('a[href="/settings/principal-grants"]')).toHaveCount(0);

        await rolesItem.click();
        await expect(page).toHaveURL(/\/settings\/roles$/);
        await expect(page.getByTestId("roles-view")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        expect(retiredCalls, "the UI must not call the retired grant surface").toEqual([]);
    });

    test("a non-admin bookmark still lands on the role surface's own 403 view", async ({
        page,
    }) => {
        seedContext(page, admin, false);
        await page.goto("/settings/principal-grants", { waitUntil: "load" });

        await expect(page).toHaveURL(/\/settings\/roles$/, { timeout: LONG_TIMEOUT_MS });
        await expect(page.getByTestId("roles-forbidden")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await page.screenshot({
            path: "test-results/plan-0610-w5c/02-non-admin-bookmark.png",
            fullPage: true,
        });
        expectPlatformScreenshot(page, "plan-0610-w5c-non-admin-bookmark.png");
    });

    test("F-02 guidance points at the role surface, not the retired page", async ({ page }) => {
        seedContext(page, admin, true);
        await page.goto(`/workspace/${admin.workspaceId}`, { waitUntil: "load" });
        await page.getByTestId("workspace-toolbar-agents").click();

        const link = page.getByTestId("agent-grant-panel-link");
        await expect(link).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await expect(link).toHaveAttribute("href", "/settings/roles");
        await page.screenshot({
            path: "test-results/plan-0610-w5c/03-f02-link.png",
            fullPage: true,
        });
        expectPlatformScreenshot(page, "plan-0610-w5c-f02-link.png");
    });
});
