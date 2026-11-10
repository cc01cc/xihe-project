// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { generateE2EPassword } from "./helpers/password";
import { CP_URL, evidenceDir } from "./helpers/journey";
import { LONG_TIMEOUT_MS, TEST_TIMEOUT_MS } from "../timeouts";

// PLAN-0651 T4.2 — the settings nav decides from the `MANAGE_ROLES` **action atom**, not from
// `isInstanceAdmin` (Lead ruling ①, 2026-11-06). This spec walks the real stack and checks the
// three identities that separate the two criteria:
//
//   1. instance admin            — atom ✓ capability ✓ → roles tab ✓  config-locks tab ✓
//   2. plain registered user     — atom ✗ capability ✗ → both hidden, direct URL still 403
//   3. custom role, atom only    — atom ✓ capability ✗ → roles tab ✓  config-locks tab ✗
//
// Case 3 is the negative control for the ruling: if the nav still read `isInstanceAdmin`, the
// roles tab would be hidden there; if config-locks were atomized by mistake, it would show.
// CP gate parity: RoleController:52-53 / BindingController:35-36 `holdsActionAtom('MANAGE_ROLES')`;
// the atom comes from `GET /api/v1/me/permissions` (`instancePermissions`, not the capability list).
// BL-392: config-locks stays on `cap:instance:admin` (ConfigLockController:41/51/70) — no atom yet.

const ADMIN_EMAIL = "admin@xihe.local";
const ADMIN_PASSWORD = process.env.XIHE_E2E_ADMIN_PASSWORD ?? "";
const EVIDENCE = evidenceDir("plan-0651-t42-permissions-tab");

// PLAN-0752：左栏换成层×域（`SettingsSidebar`）。运维/安全项在 task-171 补了 per-item testid
// `settings-nav-ops-<id>`，域链接在 task-172 补了层限定 per-domain testid
// `settings-nav-domain-<layer>-<domain>`（同名域跨层必须带层）⇒ 三个入口断言绑语义，不再按 URL 定位。
const ROLES_TAB = '[data-testid="settings-nav-ops-roles"]';
const LOCKS_TAB = '[data-testid="settings-nav-ops-config-locks"]';
const CONFIG_TAB = '[data-testid="settings-nav-domain-user-llm-provider"]';
const SETTINGS_PATH = "/settings/user/llm-provider";

interface PermissionsBody {
    instanceCapabilities?: string[];
    instancePermissions?: Array<{ actionClass: string; resource?: string }>;
}

type AdminHeaders = Record<string, string>;

function stamp(): string {
    return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

async function shoot(page: Page, label: string): Promise<void> {
    mkdirSync(EVIDENCE, { recursive: true });
    const file = path.join(EVIDENCE, `${stamp()}-${label}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`[plan-0651] screenshot → ${file}`);
}

/** Real UI login; returns once the session is persisted (the login page's own navigation may
 *  still be in flight, so callers navigate explicitly afterwards). */
async function loginThroughUi(page: Page, email: string, password: string): Promise<void> {
    await page.goto("/login");
    await page.fill('input[name="identifier"]', email);
    await page.fill('input[name="password"]', password);
    await page.press('input[name="password"]', "Enter");
    await page.waitForFunction(() => Boolean(localStorage.getItem("xihe-token")), null, {
        timeout: LONG_TIMEOUT_MS,
    });
}

/**
 * Load the settings page and capture the `/me/permissions` projection the nav judged from.
 * The assertion payload is returned so the spec can say *why* a tab is visible.
 */
async function openSettings(page: Page): Promise<PermissionsBody> {
    const [response] = await Promise.all([
        page.waitForResponse(
            (candidate) =>
                new URL(candidate.url()).pathname === "/api/v1/me/permissions" &&
                candidate.request().method() === "GET",
            { timeout: LONG_TIMEOUT_MS },
        ),
        page.goto(SETTINGS_PATH),
    ]);
    expect(response.status(), "GET /api/v1/me/permissions").toBe(200);
    const body = (await response.json()) as PermissionsBody;
    await expect(page.locator(CONFIG_TAB)).toBeVisible();
    return body;
}

/** `instancePermissions` only — workspace-scope atoms must not be counted (Lead ruling ①). */
function instanceAtoms(body: PermissionsBody): string[] {
    return (body.instancePermissions ?? []).map((atom) => atom.actionClass);
}

async function adminHeaders(request: APIRequestContext): Promise<AdminHeaders> {
    expect(ADMIN_PASSWORD, "XIHE_E2E_ADMIN_PASSWORD must be provided by e2e-host").not.toBe("");
    const login = await request.post(`${CP_URL}/api/v1/auth/login`, {
        data: { identifier: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), await login.text()).toBe(true);
    const body = (await login.json()) as { accessToken: string };
    return { Authorization: `Bearer ${body.accessToken}`, "Content-Type": "application/json" };
}

interface PlainUser {
    email: string;
    password: string;
    userId: string;
}

async function registerPlainUser(request: APIRequestContext): Promise<PlainUser> {
    const password = generateE2EPassword();
    // Username rules (USERNAME_INVALID): letters/digits only, must not start with a digit.
    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e3)}`;
    const email = `plan0651-${suffix}@test.com`;
    const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: { email, password, username: `plan0651${suffix}` },
    });
    expect([200, 201], `register failed: ${reg.status()} ${await reg.text()}`).toContain(
        reg.status(),
    );
    const body = (await reg.json()) as {
        user?: { id?: string };
        userId?: string;
    };
    const userId = body.user?.id ?? body.userId;
    expect(userId, "register must return the user id").toBeTruthy();
    return { email, password, userId: userId as string };
}

/** Full replacement of the instance-scope binding set: read it, append, write it back. */
async function bindRole(
    request: APIRequestContext,
    headers: AdminHeaders,
    userId: string,
    roleId: string,
): Promise<void> {
    const current = await request.get(`${CP_URL}/api/v1/bindings?scope=instance`, { headers });
    expect(current.ok(), await current.text()).toBe(true);
    const body = (await current.json()) as {
        bindings?: Array<{ subjectType?: string; subjectId?: string; roleId?: string }>;
    };
    const bindings = (body.bindings ?? []).map((binding) => ({
        subjectType: binding.subjectType ?? "user",
        subjectId: binding.subjectId,
        roleId: binding.roleId,
    }));
    bindings.push({ subjectType: "user", subjectId: userId, roleId });
    const put = await request.put(`${CP_URL}/api/v1/bindings?scope=instance`, {
        headers,
        data: { bindings },
    });
    expect(put.ok(), await put.text()).toBe(true);
}

test.describe("@host PLAN-0651 T4.2 permissions tab atom judgment", () => {
    test("instance admin holds MANAGE_ROLES ⇒ roles + config-locks tabs visible", async ({
        page,
    }) => {
        test.setTimeout(TEST_TIMEOUT_MS);
        await loginThroughUi(page, ADMIN_EMAIL, ADMIN_PASSWORD);
        const body = await openSettings(page);
        console.log(`[plan-0651] admin instancePermissions=${instanceAtoms(body).join(",")}`);
        expect(instanceAtoms(body)).toContain("MANAGE_ROLES");
        await expect(page.locator(ROLES_TAB)).toBeVisible();
        // BL-392: this face has no atom yet, so the capability `isInstanceAdmin` still drives it.
        await expect(page.locator(LOCKS_TAB)).toBeVisible();
        await shoot(page, "admin-settings-nav");
    });

    test("plain user without the atom ⇒ both tabs hidden; direct URL still 403", async ({
        page,
        request,
    }) => {
        test.setTimeout(TEST_TIMEOUT_MS);
        const user = await registerPlainUser(request);
        await loginThroughUi(page, user.email, user.password);
        const body = await openSettings(page);
        console.log(`[plan-0651] plain user instancePermissions=${instanceAtoms(body).join(",")}`);
        expect(instanceAtoms(body)).not.toContain("MANAGE_ROLES");
        await expect(page.locator(ROLES_TAB)).toHaveCount(0);
        await expect(page.locator(LOCKS_TAB)).toHaveCount(0);
        await shoot(page, "plain-user-settings-nav");
        // PLAN-0651 T4.2 does not touch the RolesView guard (Lead ruling ①): the retired-flag
        // guard still answers the forbidden view for a direct navigation.
        await page.goto("/settings/roles");
        await expect(page.locator('[data-testid="roles-forbidden"]')).toBeVisible();
    });

    test("custom role holding MANAGE_ROLES only ⇒ roles tab shown, capability-gated tab stays hidden", async ({
        page,
        request,
    }) => {
        test.setTimeout(TEST_TIMEOUT_MS);
        const headers = await adminHeaders(request);
        // Role names are constrained by V87 `ck_roles_name_format` (^[A-Z][A-Z0-9_]{1,63}$).
        const created = await request.post(`${CP_URL}/api/v1/roles`, {
            headers,
            data: {
                name: `PLAN0651_ATOM_ONLY_${Date.now().toString(36).slice(-5).toUpperCase()}`,
                displayName: "PLAN-0651 atom only",
                description: "MANAGE_ROLES without instance:admin — T4.2 negative control",
                atoms: ["MANAGE_ROLES"],
            },
        });
        expect(created.status(), await created.text()).toBe(201);
        const role = (await created.json()) as { id: string };

        const user = await registerPlainUser(request);
        await bindRole(request, headers, user.userId, role.id);

        await loginThroughUi(page, user.email, user.password);
        const body = await openSettings(page);
        console.log(
            `[plan-0651] atom-only instancePermissions=${instanceAtoms(body).join(",")} capabilities=${(body.instanceCapabilities ?? []).join(",")}`,
        );
        expect(instanceAtoms(body)).toContain("MANAGE_ROLES");
        // No `cap:instance:admin` ⇒ the capability-driven face must stay hidden (BL-392).
        await expect(page.locator(ROLES_TAB)).toBeVisible();
        await expect(page.locator(LOCKS_TAB)).toHaveCount(0);
        await shoot(page, "atom-only-settings-nav");
    });
});
