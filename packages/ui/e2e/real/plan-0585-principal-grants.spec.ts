import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";
import { expectPlatformScreenshot } from "../helpers/visual";

/**
 * PLAN-0585 M2 real-browser acceptance — maps 1:1 onto `evidence/m2-ui-checklist.md`.
 *
 * External-service mode (shared PLAN-0585 / PLAN-0591 isolated stack):
 *   XIHE_E2E_EXTERNAL_SERVER=1        reuse the running UI instead of `pnpm dev` (playwright.config)
 *   XIHE_CP_BASE_URL | XIHE_CP_PORT   CP origin — no port is hardcoded in this spec
 *   XIHE_E2E_ADMIN_TOKEN              instance-admin bearer (preferred)
 *     or XIHE_E2E_ADMIN_USERNAME|XIHE_E2E_ADMIN_EMAIL + XIHE_E2E_ADMIN_PASSWORD (login)
 *   XIHE_E2E_ADMIN_WORKSPACE_ID       optional; defaults to the admin's first workspace
 *   XIHE_E2E_PASSWORD                 optional shared password for the registered users
 *
 * Missing contract ⇒ every test skips with an actionable message, so `--list` and the rest of the
 * real lane stay runnable. No `waitForTimeout` anywhere: network assertions use `waitForResponse`.
 *
 * Fixture pitfalls (first stack-4 run: 5 failures, all spec-assumption, see evidence/m2-browser.md):
 *   1) seed localStorage["xihe-user"] with the REAL {id,email,name,role}. `stores/auth.ts:58`
 *      derives isAdmin from user.role, so a role-less seed silently renders every ADMIN surface
 *      (nav item, grant page, agent-dialog link) as its 403/hidden branch.
 *   2) never derive a username from the email. CP truncates the derived name to 32 chars and
 *      de-duplicates with a prefix/suffix (User#defaultUsernameFromEmail, User.java:78-84), so the
 *      only authority is `GET /api/v1/workspaces/{ws}/members` → match `userId` → `username`.
 *
 * Item → test mapping:
 *   1 reachability · 3 read+grant · 4 changed:false → "admin grants CREATE_ACCOUNT (...)"
 *   2 non-admin isolation                          → "non-admin sees no nav entry ..."
 *   5 workspace atom round trip + local UUID gate   → "admin adds and removes a workspace-scoped atom ..."
 *   6 real 4xx localized copy                      → "real 4xx responses render localized copy ..."
 *   7 F-02 agent dialog hint + admin link           → "F-02: the agent dialog shows ..."
 *   8 grant takes effect end to end + mobile       → "the grant takes effect end to end ..."
 *     (item 8's en sub-check is N/A: the running UI has no language switch — see evidence §4)
 */

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
const CREATE_ACCOUNT = "CREATE_ACCOUNT";
const MANAGE_WORKSPACE_AGENTS = "MANAGE_WORKSPACE_AGENTS";

interface AdminSession {
    token: string;
    userId: string;
    username: string;
    workspaceId: string;
    identity: Identity;
}

/** The exact shape the UI auth store hydrates from localStorage["xihe-user"]. */
interface Identity {
    id: string;
    email: string;
    name: string;
    role: string;
}

interface RegisteredUser {
    token: string;
    userId: string;
    username: string;
    email: string;
    workspaceId: string;
    identity: Identity;
}

interface GrantAtom {
    actionClass: string;
    resource?: string;
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

/**
 * Usernames are NOT derivable from the email: CP truncates the derived name to 32 chars, may add a
 * `user` prefix and de-duplicates on collision (User#defaultUsernameFromEmail). The member list is
 * the authoritative source, so every fixture resolves its username through it.
 */
async function resolveUsername(
    request: APIRequestContext,
    origin: string,
    workspaceId: string,
    token: string,
    userId: string,
): Promise<string> {
    const response = await request.get(`${origin}/api/v1/workspaces/${workspaceId}/members`, {
        headers: bearer(token),
    });
    expect(response.status(), `GET members -> ${response.status()} ${await response.text()}`).toBe(
        200,
    );
    const rows = (await response.json()) as Array<{ userId: string; username: string }>;
    const row = rows.find((candidate) => candidate.userId === userId);
    expect(row, `member row for ${userId} must exist in workspace ${workspaceId}`).toBeTruthy();
    return row!.username;
}

async function loginAdmin(request: APIRequestContext, origin: string): Promise<AdminSession> {
    const token = process.env.XIHE_E2E_ADMIN_TOKEN;
    const configuredWorkspace = process.env.XIHE_E2E_ADMIN_WORKSPACE_ID;
    if (token) {
        const me = await request.get(`${origin}/api/v1/auth/me`, { headers: bearer(token) });
        expect(me.status(), `GET /auth/me -> ${me.status()} ${await me.text()}`).toBe(200);
        const raw = (await me.json()) as {
            id: string;
            email?: string;
            name?: string;
            role?: string;
        };
        const identity: Identity = {
            id: raw.id,
            email: raw.email ?? "",
            name: raw.name ?? "admin",
            role: raw.role ?? "ADMIN",
        };
        let workspaceId = configuredWorkspace;
        if (!workspaceId) {
            const list = await request.get(`${origin}/api/v1/workspaces`, {
                headers: bearer(token),
            });
            expect(list.status(), `GET /workspaces -> ${await list.text()}`).toBe(200);
            const rows = (await list.json()) as Array<{ id: string }>;
            expect(rows.length, "admin token must expose at least one workspace").toBeGreaterThan(
                0,
            );
            workspaceId = rows[0].id;
        }
        return {
            token,
            userId: raw.id,
            username: await resolveUsername(request, origin, workspaceId, token, raw.id),
            workspaceId,
            identity,
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
        user: { id: string; email?: string; name?: string; role?: string };
    };
    const workspaceId = configuredWorkspace ?? body.workspaceId ?? "";
    expect(workspaceId, "the admin login must resolve a workspace").not.toBe("");
    return {
        token: body.accessToken,
        userId: body.user.id,
        username: await resolveUsername(
            request,
            origin,
            workspaceId,
            body.accessToken,
            body.user.id,
        ),
        workspaceId,
        identity: {
            id: body.user.id,
            email: body.user.email ?? "",
            name: body.user.name ?? "admin",
            role: body.user.role ?? "ADMIN",
        },
    };
}

async function registerUser(
    request: APIRequestContext,
    origin: string,
    label: string,
): Promise<RegisteredUser> {
    const email = `${label}-${Date.now()}-${Math.floor(Math.random() * 10_000)}@test.com`;
    const response = await request.post(`${origin}/api/v1/auth/register`, {
        data: { email, password: SHARED_PASSWORD, name: label },
    });
    expect(response.status(), `register ${label} -> ${await response.text()}`).toBe(201);
    const body = (await response.json()) as {
        accessToken: string;
        workspaceId: string;
        user: { id: string; email?: string; name?: string; role?: string };
    };
    return {
        token: body.accessToken,
        userId: body.user.id,
        username: await resolveUsername(
            request,
            origin,
            body.workspaceId,
            body.accessToken,
            body.user.id,
        ),
        email,
        workspaceId: body.workspaceId,
        identity: {
            id: body.user.id,
            email: body.user.email ?? email,
            name: body.user.name ?? label,
            role: body.user.role ?? "USER",
        },
    };
}

/** Seeds the UI auth/workspace context without driving the login form (PLAN-0560 storage shape). */
function seedContext(
    page: Page,
    session: { token: string; workspaceId: string; identity: Identity },
    workspaceRole: string,
) {
    page.addInitScript(
        ({ token, ws, role, identity }) => {
            localStorage.setItem("xihe-token", token);
            // The auth store derives isAdmin from user.role — seeding a role-less user made every
            // ADMIN-only surface render its 403 view (first stack-4 run, 5 failures).
            localStorage.setItem("xihe-user", JSON.stringify(identity));
            localStorage.setItem(
                "xihe-workspace",
                JSON.stringify({ id: ws, name: "Default Workspace" }),
            );
            sessionStorage.setItem(
                "xihe-workspace",
                JSON.stringify({
                    id: ws,
                    name: "Default Workspace",
                    workspaceRole: role,
                    ownerId: "x",
                }),
            );
        },
        {
            token: session.token,
            ws: session.workspaceId,
            role: workspaceRole,
            identity: session.identity,
        },
    );
}

function patchGrants(
    request: APIRequestContext,
    origin: string,
    admin: AdminSession,
    username: string,
    body: { add?: GrantAtom[]; remove?: GrantAtom[] },
) {
    return request.patch(`${origin}/api/v1/principal-grants/${encodeURIComponent(username)}`, {
        headers: bearer(admin.token),
        data: body,
    });
}

function isGrantPatch(response: { request(): { method(): string }; url(): string }): boolean {
    return (
        response.request().method() === "PATCH" &&
        response.url().includes("/api/v1/principal-grants/")
    );
}

test.describe("@host PLAN-0585 principal grants (M2 UI)", () => {
    let admin: AdminSession;
    let target: RegisteredUser;
    // Dedicated grantless fixture: only this suite's end-to-end test grants atoms, and it only ever
    // touches `target`, so `grantless` is guaranteed to hold no CREATE_ACCOUNT at F-02 time.
    let grantless: RegisteredUser;
    let origin = "";

    test.beforeAll(async ({ request }) => {
        if (missingContract()) return;
        origin = cpOrigin();
        admin = await loginAdmin(request, origin);
        target = await registerUser(request, origin, "plan0585-grant-target");
        grantless = await registerUser(request, origin, "plan0585-grantless");
        // Identity summary for the evidence (no tokens/secrets are printed).
        console.log(
            `[plan-0585] admin=${admin.username} role=${admin.identity.role} ws=${admin.workspaceId}`,
        );
        console.log(
            `[plan-0585] target=${target.username} role=${target.identity.role} ws=${target.workspaceId}`,
        );
        console.log(
            `[plan-0585] grantless=${grantless.username} role=${grantless.identity.role} ws=${grantless.workspaceId}`,
        );
    });

    test.beforeEach(() => {
        const missing = missingContract();
        test.skip(Boolean(missing), missing);
    });

    test.afterAll(async ({ request }) => {
        if (!admin || !target) return;
        // Keep the shared stack clean: revoke everything this suite may have granted. The status is
        // logged (no secrets) so evidence can cite that the 0591 M3 lane inherits a clean state.
        const cleanup = await patchGrants(request, origin, admin, target.username, {
            remove: [
                { actionClass: CREATE_ACCOUNT, resource: "*" },
                { actionClass: MANAGE_WORKSPACE_AGENTS, resource: target.workspaceId },
                { actionClass: MANAGE_WORKSPACE_AGENTS, resource: admin.workspaceId },
            ],
        });
        console.log(
            `[plan-0585] afterAll revoke for ${target.username} -> HTTP ${cleanup.status()}`,
        );
    });

    test("admin grants CREATE_ACCOUNT (changed:true, then changed:false, then persists)", async ({
        page,
    }) => {
        seedContext(page, admin, "OWNER");
        await page.goto("/settings/config", { waitUntil: "load" });

        const navItem = page.getByTestId("settings-nav-settings-principal-grants");
        await expect(navItem).toBeVisible({ timeout: 20_000 });
        await navItem.click();
        await expect(page).toHaveURL(/\/settings\/principal-grants$/);
        await expect(page.getByTestId("principal-grant-view")).toBeVisible({ timeout: 20_000 });
        await expect(page.getByTestId("principal-grant-forbidden")).toHaveCount(0);
        await page.screenshot({
            path: "test-results/plan-0585/01-admin-grant-page.png",
            fullPage: true,
        });
        expectPlatformScreenshot(page, "plan-0585-admin-grant-page.png");

        // Real read: no `self` on the wire (decision #8), identity resolved from the username.
        const readResponse = page.waitForResponse(
            (response) =>
                response.request().method() === "GET" &&
                response.url().includes(`/api/v1/principal-grants/${target.username}`),
            { timeout: 20_000 },
        );
        await page.getByTestId("principal-grant-username").fill(target.username);
        await page.getByTestId("principal-grant-form").press("Enter");
        const read = await readResponse;
        expect(read.status()).toBe(200);
        const readBody = (await read.json()) as Record<string, unknown>;
        expect(readBody.username).toBe(target.username);
        expect(readBody).not.toHaveProperty("self");
        await expect(page.getByTestId("principal-grant-identity")).toContainText(target.userId);

        // Grant → 200 changed:true.
        await page.getByTestId("principal-grant-create-account").check();
        const firstPatch = page.waitForResponse(isGrantPatch, { timeout: 20_000 });
        await page.getByTestId("principal-grant-save").click();
        const first = await firstPatch;
        expect(first.status()).toBe(200);
        const firstBody = (await first.json()) as { changed: boolean; grants: unknown[] };
        expect(firstBody.changed).toBe(true);
        expect(JSON.stringify(firstBody.grants)).toContain(CREATE_ACCOUNT);
        await expect(page.getByTestId("principal-grant-notice")).toContainText("授权已更新");
        await page.screenshot({
            path: "test-results/plan-0585/02-grant-saved.png",
            fullPage: true,
        });
        expectPlatformScreenshot(page, "plan-0585-grant-saved.png");

        // Idempotent replay → 200 changed:false.
        const secondPatch = page.waitForResponse(isGrantPatch, { timeout: 20_000 });
        await page.getByTestId("principal-grant-save").click();
        const secondBody = (await (await secondPatch).json()) as { changed: boolean };
        expect(secondBody.changed).toBe(false);
        await expect(page.getByTestId("principal-grant-notice")).toContainText("没有实际变更");

        // Persistence after reload.
        await page.reload({ waitUntil: "load" });
        await page.getByTestId("principal-grant-username").fill(target.username);
        await page.getByTestId("principal-grant-form").press("Enter");
        await expect(page.getByTestId("principal-grant-create-account")).toBeChecked({
            timeout: 20_000,
        });
    });

    test("non-admin sees no nav entry and gets the 403 view without calling the grants API", async ({
        page,
    }) => {
        seedContext(page, target, "EDITOR");
        const grantRequests: string[] = [];
        page.on("request", (request) => {
            if (request.url().includes("/api/v1/principal-grants/")) {
                grantRequests.push(request.url());
            }
        });

        await page.goto("/settings/config", { waitUntil: "load" });
        await expect(page.getByTestId("settings-nav-settings-config")).toBeVisible({
            timeout: 20_000,
        });
        await expect(page.getByTestId("settings-nav-settings-principal-grants")).toHaveCount(0);

        await page.goto("/settings/principal-grants", { waitUntil: "load" });
        await expect(page.getByTestId("principal-grant-forbidden")).toBeVisible({
            timeout: 20_000,
        });
        await expect(page.getByTestId("principal-grant-username")).toHaveCount(0);
        expect(grantRequests, "a non-admin must never call the grant surface").toEqual([]);
        await page.screenshot({
            path: "test-results/plan-0585/03-non-admin-forbidden.png",
            fullPage: true,
        });
        expectPlatformScreenshot(page, "plan-0585-non-admin-forbidden.png");
    });

    test("admin adds and removes a workspace-scoped atom; an invalid UUID never reaches the API", async ({
        page,
    }) => {
        seedContext(page, admin, "OWNER");
        await page.goto("/settings/principal-grants", { waitUntil: "load" });
        await page.getByTestId("principal-grant-username").fill(target.username);
        await page.getByTestId("principal-grant-form").press("Enter");
        await expect(page.getByTestId("principal-grant-editor")).toBeVisible({ timeout: 20_000 });

        const patches: string[] = [];
        page.on("request", (request) => {
            if (
                request.method() === "PATCH" &&
                request.url().includes("/api/v1/principal-grants/")
            ) {
                patches.push(request.url());
            }
        });

        // `*` is not a resource: the local gate rejects it before any request (decision #5).
        await page.getByTestId("principal-grant-workspace-input").fill("*");
        await page.getByTestId("principal-grant-workspace-add").click();
        await expect(page.getByTestId("principal-grant-error")).toContainText("UUID 格式不正确");
        expect(patches).toEqual([]);

        // A concrete existing workspace UUID round-trips through PATCH add → remove.
        await page.getByTestId("principal-grant-workspace-input").fill(admin.workspaceId);
        await page.getByTestId("principal-grant-workspace-add").click();
        await expect(page.getByTestId("principal-grant-workspace-row")).toHaveCount(1);

        const addPatch = page.waitForResponse(isGrantPatch, { timeout: 20_000 });
        await page.getByTestId("principal-grant-save").click();
        const added = (await (await addPatch).json()) as { changed: boolean; grants: unknown[] };
        expect(added.changed).toBe(true);
        expect(JSON.stringify(added.grants)).toContain(MANAGE_WORKSPACE_AGENTS);
        expect(JSON.stringify(added.grants)).toContain(admin.workspaceId);
        await page.screenshot({
            path: "test-results/plan-0585/04-workspace-granted.png",
            fullPage: true,
        });
        expectPlatformScreenshot(page, "plan-0585-workspace-granted.png");

        await page.getByTestId("principal-grant-workspace-remove").click();
        await expect(page.getByTestId("principal-grant-workspace-row")).toHaveCount(0);
        const removePatch = page.waitForResponse(isGrantPatch, { timeout: 20_000 });
        await page.getByTestId("principal-grant-save").click();
        expect(((await (await removePatch).json()) as { changed: boolean }).changed).toBe(true);
    });

    test("real 4xx responses render localized copy without the CP english detail", async ({
        page,
    }) => {
        seedContext(page, admin, "OWNER");
        await page.goto("/settings/principal-grants", { waitUntil: "load" });

        // 404 USER_NOT_FOUND for an unknown username.
        await page.getByTestId("principal-grant-username").fill(`ghost${Date.now()}`);
        await page.getByTestId("principal-grant-form").press("Enter");
        await expect(page.getByTestId("principal-grant-error")).toContainText(
            "找不到该用户名对应的账号",
            { timeout: 20_000 },
        );
        expect(await page.getByTestId("principal-grant-error").innerText()).not.toContain(
            "USER_NOT_FOUND",
        );
        await page.screenshot({
            path: "test-results/plan-0585/05-error-user-not-found.png",
            fullPage: true,
        });
        expectPlatformScreenshot(page, "plan-0585-error-user-not-found.png");

        // 400 INVALID_GRANT_RESOURCE for a well-formed UUID that names no workspace.
        await page.getByTestId("principal-grant-username").fill(target.username);
        await page.getByTestId("principal-grant-form").press("Enter");
        await expect(page.getByTestId("principal-grant-editor")).toBeVisible({ timeout: 20_000 });
        await page
            .getByTestId("principal-grant-workspace-input")
            .fill("00000000-0000-4000-8000-000000000000");
        await page.getByTestId("principal-grant-workspace-add").click();
        const badResource = page.waitForResponse(isGrantPatch, { timeout: 20_000 });
        await page.getByTestId("principal-grant-save").click();
        expect((await badResource).status()).toBe(400);
        await expect(page.getByTestId("principal-grant-error")).toContainText("资源不合法");
        expect(await page.getByTestId("principal-grant-error").innerText()).not.toContain(
            "INVALID_GRANT_RESOURCE",
        );
        await page.screenshot({
            path: "test-results/plan-0585/06-error-resource.png",
            fullPage: true,
        });
        expectPlatformScreenshot(page, "plan-0585-error-resource.png");
    });

    test("F-02: grantless user gets the localized 403 hint, admins get the panel link", async ({
        page,
        request,
    }) => {
        // (1) Timestamped proof that the atom is absent *before* the create attempt. `grantless` is a
        // dedicated fixture that no other test grants to, and CREATE_ACCOUNT is not part of the
        // default grant set (GrantDefaultService), so deny-by-default must hold here.
        const before = await request.get(
            `${origin}/api/v1/principal-grants/${encodeURIComponent(grantless.username)}`,
            { headers: bearer(admin.token) },
        );
        expect(before.status(), await before.text()).toBe(200);
        const beforeBody = (await before.json()) as { grants: GrantAtom[] };
        expect(beforeBody.grants.map((atom) => atom.actionClass)).not.toContain(CREATE_ACCOUNT);
        console.log(
            `[plan-0585] F-02 pre-create grants=${JSON.stringify(beforeBody.grants)} at ${new Date().toISOString()}`,
        );

        // (2) The grantless user creates from its own workspace: real 403 + localized copy.
        seedContext(page, grantless, "OWNER");
        await page.goto(`/workspace/${grantless.workspaceId}`, { waitUntil: "load" });
        await page.getByTestId("workspace-toolbar-agents").click();
        await expect(page.getByTestId("agent-principal-create-form")).toBeVisible({
            timeout: 20_000,
        });
        await expect(page.getByTestId("agent-grant-panel-link")).toHaveCount(0);

        const deniedResponse = page.waitForResponse(
            (response) =>
                response.url().includes("/api/v1/agent-principals") &&
                response.request().method() === "POST",
            { timeout: 20_000 },
        );
        await page.getByTestId("agent-principal-name").fill(`grantless-${Date.now()}`);
        await page.getByTestId("agent-principal-create-form").press("Enter");
        const denied = await deniedResponse;
        expect(denied.status()).toBe(403);
        console.log(
            `[plan-0585] F-02 create -> HTTP ${denied.status()} at ${new Date().toISOString()}`,
        );

        // DEVELOP built the running UI before the `agent-error` test id landed, so accept either it
        // or the role="alert" paragraph the dialog has always rendered.
        const error = page.locator('[data-testid="agent-error"], p[role="alert"]').first();
        await expect(error).toContainText("缺少 CREATE_ACCOUNT 权限", { timeout: 20_000 });
        await expect(error).not.toContainText("CREATE_ACCOUNT permission is required");
        await page.screenshot({
            path: "test-results/plan-0585/07-f02-forbidden.png",
            fullPage: true,
        });
        expectPlatformScreenshot(page, "plan-0585-f02-forbidden.png");

        // (3) Admin shortcut: the later init script overwrites the seeded identity, so the same page
        // reloads as ADMIN and the panel link appears.
        seedContext(page, admin, "OWNER");
        await page.goto(`/workspace/${admin.workspaceId}`, { waitUntil: "load" });
        await page.getByTestId("workspace-toolbar-agents").click();
        const link = page.getByTestId("agent-grant-panel-link");
        await expect(link).toBeVisible({ timeout: 20_000 });
        await expect(link).toHaveAttribute("href", "/settings/principal-grants");
        await page.screenshot({
            path: "test-results/plan-0585/07b-f02-admin-link.png",
            fullPage: true,
        });
        expectPlatformScreenshot(page, "plan-0585-f02-admin-link.png");
    });

    test("the grant takes effect end to end and the grant page survives mobile", async ({
        page,
        request,
    }) => {
        const granted = await patchGrants(request, origin, admin, target.username, {
            add: [
                { actionClass: CREATE_ACCOUNT, resource: "*" },
                { actionClass: MANAGE_WORKSPACE_AGENTS, resource: target.workspaceId },
            ],
        });
        expect(granted.status(), await granted.text()).toBe(200);

        const created = await request.post(`${origin}/api/v1/agent-principals`, {
            headers: bearer(target.token),
            data: { name: `plan0585-agent-${Date.now()}` },
        });
        expect(created.status(), await created.text()).toBe(201);
        const principalId = ((await created.json()) as { principalId: string }).principalId;

        const bound = await request.put(
            `${origin}/api/v1/workspaces/${target.workspaceId}/agents/${principalId}`,
            {
                headers: bearer(target.token),
                data: { permissions: [{ actionClass: CREATE_ACCOUNT, resource: "*" }] },
            },
        );
        expect(bound.status(), await bound.text()).toBe(200);

        const revoked = await patchGrants(request, origin, admin, target.username, {
            remove: [{ actionClass: CREATE_ACCOUNT, resource: "*" }],
        });
        expect(revoked.status(), await revoked.text()).toBe(200);
        const denied = await request.post(`${origin}/api/v1/agent-principals`, {
            headers: bearer(target.token),
            data: { name: `plan0585-agent-denied-${Date.now()}` },
        });
        expect(denied.status()).toBe(403);

        // i18n: the running UI ships zh-CN only — `createI18n({locale:"zh-CN"})` is static and
        // nothing applies `useSettingsStore().language` to it (no switcher wired, `xihe-language`
        // is never read at boot; probe 2026-10-31 proved a seeded value changes nothing). So this
        // item asserts the zh copy and records the en gap instead of faking a locale switch.
        seedContext(page, admin, "OWNER");
        await page.goto("/settings/principal-grants", { waitUntil: "load" });
        await expect(page.getByTestId("principal-grant-view")).toContainText("Principal 授权", {
            timeout: 20_000,
        });
        await page.screenshot({
            path: "test-results/plan-0585/08-grant-page-zh.png",
            fullPage: true,
        });
        expectPlatformScreenshot(page, "plan-0585-grant-page-zh.png");

        await page.setViewportSize({ width: 390, height: 844 });
        const overflow = await page.evaluate(() => {
            const doc = document.documentElement;
            return doc.scrollWidth > doc.clientWidth + 1;
        });
        expect(overflow, "no horizontal overflow at 390px").toBe(false);
        await page.screenshot({ path: "test-results/plan-0585/09-mobile.png", fullPage: true });
        expectPlatformScreenshot(page, "plan-0585-mobile.png");
    });
});
