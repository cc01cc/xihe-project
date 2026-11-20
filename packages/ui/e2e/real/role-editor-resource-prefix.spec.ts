// lane: @real —— 只能在真栈跑（写面 POST/PATCH/DELETE /api/v1/roles 在 mock 里按 task-72 有意留 404，
// 不补假写面），三条拒绝报文必须来自真实 CP。
// timeout-exempt: real-stack identity setup for task-126 (LONG_TIMEOUT_MS waits on CP + UI login)
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { CP_URL } from "./helpers/journey";
import { generateE2EPassword } from "./helpers/password";
import { LONG_TIMEOUT_MS, TEST_TIMEOUT_MS } from "../timeouts";

/**
 * task-126 — 角色编辑器的资源前缀必须原样到达 CP，且 CP 的三条拒绝**原文**要能落到 UI 上。
 *
 * <p>Lead 裁定（2026-11-20 22:50）选了「纯文本完整形态」：**不做下拉预校验**，否则 400/404 在提交前
 * 就被拦住，卡面第 3 条要求的「原文可见」根本达不到。于是本 spec 走真栈验证两件事：</p>
 *
 * <ol>
 *   <li><b>送得到、存得下</b>：UI 建 role 时选 `read` + 填 `fs:<ws>/src` ⇒ 抓 `POST /api/v1/roles`
 *       的真实请求体，断言 `atoms` 里是该对象形态（不是裸串），响应 201 且回显 pattern；再用
 *       `GET /api/v1/roles` 复读确认落库（卡面要求「请求体实测含该字段且后端 200 落库」）。</li>
 *   <li><b>三条拒绝的原文</b>：`400 INVALID_GRANT_RESOURCE`（`src` 不是合法形态）、
 *       `404 WORKSPACE_NOT_FOUND`（uuid 不存在）、`403 FORBIDDEN`（有 MANAGE_ROLES 原子但缺
 *       工作区管理权，PLAN-0651 的自定义角色身份）——每条都当场抓 CP 的真实响应体，并断言
 *       `[data-testid="roles-error"]` 的文本**等于**响应里的 `detail`，证明 UI 没有把报文吞成
 *       「保存失败」。</li>
 * </ol>
 *
 * <p>契约事实（task-81 GrantResourcePattern，实测）：唯一合法形态 `fs:<workspaceUuid>[/<rel>]`；
 * 空白/裸串仍按 canonical 处理（capability 原子写 `*`、instance-only 原子不可收窄）。</p>
 */

const ADMIN_EMAIL = "admin@xihe.local";
const ADMIN_PASSWORD = process.env.XIHE_E2E_ADMIN_PASSWORD ?? "";
const ROLES_TAB = '[data-testid="settings-nav-ops-roles"]';
const INSTANCE_GROUP = "#settings-nav-instance";
const SETTINGS_PATH = "/settings/user/llm-provider";
const EDITOR = '[data-testid="role-editor-dialog"]';
const SUBMIT = '[data-testid="role-editor-submit"]';
const PAGE_ERROR = '[data-testid="roles-error"]';
const UNKNOWN_WORKSPACE = "00000000-0000-4000-8000-000000000000";

interface AtomView {
    name: string;
    scopeClass?: string;
    capability?: boolean;
    resource?: string;
}

interface RoleView {
    id: string;
    name: string;
    atoms?: AtomView[];
}

interface WireAtom {
    actionClass?: string;
    resource?: string;
}

/** CP answers the workspace list as a **bare array** (probed 2026-11-20, stack-2). */
type WorkspaceListBody =
    | Array<{ id?: string; workspaceId?: string }>
    | { workspaces?: Array<{ id?: string; workspaceId?: string }> };

interface BindingBody {
    bindings?: Array<{ subjectType?: string; subjectId: string; roleId: string }>;
}

type Headers = Record<string, string>;

function stamp(): string {
    return Date.now()
        .toString(36)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
}

async function loginThroughUi(page: Page, email: string, password: string): Promise<void> {
    await page.goto("/login");
    await page.fill('input[name="identifier"]', email);
    await page.fill('input[name="password"]', password);
    await page.press('input[name="password"]', "Enter");
    await page.waitForFunction(() => Boolean(localStorage.getItem("xihe-token")), null, {
        timeout: LONG_TIMEOUT_MS,
    });
}

async function adminHeaders(request: APIRequestContext): Promise<Headers> {
    expect(ADMIN_PASSWORD, "XIHE_E2E_ADMIN_PASSWORD must be provided by the runner").not.toBe("");
    const login = await request.post(`${CP_URL}/api/v1/auth/login`, {
        data: { identifier: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), await login.text()).toBe(true);
    const body = (await login.json()) as { accessToken: string };
    return { Authorization: `Bearer ${body.accessToken}`, "Content-Type": "application/json" };
}

async function firstWorkspaceId(request: APIRequestContext, headers: Headers): Promise<string> {
    const response = await request.get(`${CP_URL}/api/v1/workspaces`, { headers });
    expect(response.ok(), await response.text()).toBe(true);
    const body = (await response.json()) as WorkspaceListBody;
    const list = Array.isArray(body) ? body : (body.workspaces ?? []);
    const first = list[0];
    const id = first?.id ?? first?.workspaceId ?? "";
    expect(id, "GET /api/v1/workspaces must return at least one workspace").not.toBe("");
    return id;
}

/** Open the roles page the way a user does (settings → instance layer → ops → roles). */
async function openRolesPage(page: Page): Promise<void> {
    await page.goto(SETTINGS_PATH);
    if ((await page.locator(ROLES_TAB).count()) === 0) {
        await page.locator(INSTANCE_GROUP).click();
    }
    await expect(page.locator(ROLES_TAB)).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await page.locator(ROLES_TAB).click();
    await expect(page.locator('[data-testid="roles-create"]')).toBeVisible({
        timeout: LONG_TIMEOUT_MS,
    });
}

/** Open a fresh create dialog and pick `read` with an optional resource prefix. */
async function openEditorWithRead(page: Page, roleName: string, resource: string): Promise<void> {
    await page.locator('[data-testid="roles-create"]').click();
    await expect(page.locator(EDITOR)).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await page.fill('[data-testid="role-editor-name"]', roleName);
    await page.fill('[data-testid="role-editor-display-name"]', "task-126 resource prefix");
    await page.fill('[data-testid="role-editor-atom-search"]', "read");
    await page.locator('[data-testid="role-editor-atom-read"]').click();
    const resourceInput = page.locator('[data-testid="role-editor-atom-resource-read"]');
    await expect(resourceInput).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    if (resource !== "") {
        await resourceInput.fill(resource);
    }
}

async function submitAndCapture(
    page: Page,
): Promise<{ status: number; sent: string; body: string }> {
    const [response] = await Promise.all([
        page.waitForResponse(
            (candidate) =>
                new URL(candidate.url()).pathname === "/api/v1/roles" &&
                candidate.request().method() === "POST",
            { timeout: LONG_TIMEOUT_MS },
        ),
        page.locator(SUBMIT).click(),
    ]);
    return {
        status: response.status(),
        sent: response.request().postData() ?? "",
        body: await response.text(),
    };
}

test.describe("task-126 role editor resource prefix (real stack)", () => {
    test("the prefix travels to CP and reads back from the stored role", async ({
        page,
        request,
    }) => {
        test.setTimeout(TEST_TIMEOUT_MS * 3);
        const headers = await adminHeaders(request);
        const workspaceId = await firstWorkspaceId(request, headers);
        const roleName = `XH_T126_PREFIX_${stamp()}`;
        const expected = `fs:${workspaceId}/src`;

        await loginThroughUi(page, ADMIN_EMAIL, ADMIN_PASSWORD);
        await openRolesPage(page);
        await openEditorWithRead(page, roleName, expected);

        const result = await submitAndCapture(page);
        console.log(`[task-126] POST /api/v1/roles ${result.status} sent=${result.sent}`);
        console.log(`[task-126] POST /api/v1/roles body=${result.body.slice(0, 800)}`);

        expect(result.status, result.body).toBe(201);
        const sent = JSON.parse(result.sent) as { atoms?: Array<string | WireAtom> };
        const atomObjects = (sent.atoms ?? []).filter(
            (atom): atom is WireAtom => typeof atom === "object" && atom !== null,
        );
        expect(
            atomObjects,
            `request body must carry the object form: ${result.sent}`,
        ).toContainEqual({ actionClass: "read", resource: expected });

        const created = JSON.parse(result.body) as RoleView;
        expect(created.name).toBe(roleName);
        const createdRead = (created.atoms ?? []).find((atom) => atom.name === "read");
        expect(createdRead?.resource, "response must echo the stored pattern").toBe(expected);

        const listed = await request.get(`${CP_URL}/api/v1/roles`, { headers });
        expect(listed.ok(), await listed.text()).toBe(true);
        const rolesBody = (await listed.json()) as { roles?: RoleView[] } | RoleView[];
        const roles = Array.isArray(rolesBody) ? rolesBody : (rolesBody.roles ?? []);
        const stored = roles.find((role) => role.name === roleName);
        expect(stored, "GET /api/v1/roles must return the new role").toBeTruthy();
        const storedRead = (stored?.atoms ?? []).find((atom) => atom.name === "read");
        expect(storedRead?.resource, "the stored role must keep the narrowed pattern").toBe(
            expected,
        );

        const cleanup = await request.delete(`${CP_URL}/api/v1/roles/${created.id}`, { headers });
        expect(cleanup.status(), await cleanup.text()).toBe(204);
    });

    test("the three CP refusals reach the page as CP's own detail text", async ({
        page,
        browser,
        request,
    }) => {
        test.setTimeout(TEST_TIMEOUT_MS * 5);
        const headers = await adminHeaders(request);
        const workspaceId = await firstWorkspaceId(request, headers);
        const stampValue = stamp();
        const roleName = `XH_T126_REFUSED_${stampValue}`;

        await loginThroughUi(page, ADMIN_EMAIL, ADMIN_PASSWORD);
        await openRolesPage(page);
        await openEditorWithRead(page, roleName, "src");

        // ① 400 INVALID_GRANT_RESOURCE — a bare relative path is not a legal pattern.
        const bad400 = await submitAndCapture(page);
        const body400 = JSON.parse(bad400.body) as { code?: string; detail?: string };
        console.log(`[task-126] 400 body=${bad400.body}`);
        expect(bad400.status).toBe(400);
        expect(body400.code).toBe("INVALID_GRANT_RESOURCE");
        await expect(page.locator(PAGE_ERROR)).toHaveText(body400.detail ?? "", {
            timeout: LONG_TIMEOUT_MS,
        });
        expect(body400.detail ?? "").toContain("path patterns must be fs:<workspaceId>");

        // ② 404 WORKSPACE_NOT_FOUND — well-formed pattern, unknown workspace uuid.
        await page
            .locator('[data-testid="role-editor-atom-resource-read"]')
            .fill(`fs:${UNKNOWN_WORKSPACE}/src`);
        const bad404 = await submitAndCapture(page);
        const body404 = JSON.parse(bad404.body) as { code?: string; detail?: string };
        console.log(`[task-126] 404 body=${bad404.body}`);
        expect(bad404.status).toBe(404);
        expect(body404.code).toBe("WORKSPACE_NOT_FOUND");
        await expect(page.locator(PAGE_ERROR)).toHaveText(body404.detail ?? "", {
            timeout: LONG_TIMEOUT_MS,
        });

        // ③ 403 FORBIDDEN — an identity that holds MANAGE_ROLES but cannot administer the
        // workspace's bindings (PLAN-0651's custom-role pattern, reused as the negative control).
        const granterName = `XH_T126_GRANTER_${stampValue}`;
        const granter = await request.post(`${CP_URL}/api/v1/roles`, {
            headers,
            data: {
                name: granterName,
                displayName: "task-126 granter",
                atoms: ["read", "MANAGE_ROLES"],
            },
        });
        expect(granter.status(), await granter.text()).toBe(201);
        const granterRole = (await granter.json()) as RoleView;

        const email = `task126-${stampValue.toLowerCase()}@e2e.local`;
        const password = generateE2EPassword(16);
        const registered = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: { email, password, username: `t126${stampValue.toLowerCase()}`.slice(0, 32) },
        });
        expect(registered.status(), await registered.text()).toBe(201);
        const registeredBody = (await registered.json()) as {
            user?: { id?: string };
            userId?: string;
        };
        const userId = registeredBody.user?.id ?? registeredBody.userId ?? "";
        expect(userId, "register must return the new user id").not.toBe("");

        const bindingsResponse = await request.get(`${CP_URL}/api/v1/bindings?scope=instance`, {
            headers,
        });
        expect(bindingsResponse.ok(), await bindingsResponse.text()).toBe(true);
        const bindingsBody = (await bindingsResponse.json()) as BindingBody;
        const original = (bindingsBody.bindings ?? []).map((binding) => ({
            subjectType: binding.subjectType ?? "user",
            subjectId: binding.subjectId,
            roleId: binding.roleId,
        }));
        const appended = [
            ...original,
            { subjectType: "user", subjectId: userId, roleId: granterRole.id },
        ];
        const bind = await request.put(`${CP_URL}/api/v1/bindings?scope=instance`, {
            headers,
            data: { bindings: appended },
        });
        expect(bind.ok(), await bind.text()).toBe(true);

        const narrowContext = await browser.newContext();
        try {
            const narrowPage = await narrowContext.newPage();
            await loginThroughUi(narrowPage, email, password);
            await openRolesPage(narrowPage);
            await openEditorWithRead(narrowPage, `XH_T126_DENIED_${stampValue}`, "");
            await narrowPage
                .locator('[data-testid="role-editor-atom-resource-read"]')
                .fill(`fs:${workspaceId}/src`);
            const bad403 = await submitAndCapture(narrowPage);
            const body403 = JSON.parse(bad403.body) as { code?: string; detail?: string };
            console.log(`[task-126] 403 body=${bad403.body}`);
            expect(bad403.status).toBe(403);
            expect(body403.code).toBe("FORBIDDEN");
            await expect(narrowPage.locator(PAGE_ERROR)).toHaveText(body403.detail ?? "", {
                timeout: LONG_TIMEOUT_MS,
            });
            expect(body403.detail ?? "").toContain("MANAGE_WORKSPACE_AGENTS");
        } finally {
            await narrowContext.close();
            const restore = await request.put(`${CP_URL}/api/v1/bindings?scope=instance`, {
                headers,
                data: { bindings: original },
            });
            expect(restore.ok(), await restore.text()).toBe(true);
            const dropGranter = await request.delete(`${CP_URL}/api/v1/roles/${granterRole.id}`, {
                headers,
            });
            expect(dropGranter.status(), await dropGranter.text()).toBe(204);
        }

        // Nothing was created by the three refused submissions.
        const after = await request.get(`${CP_URL}/api/v1/roles`, { headers });
        const afterBody = (await after.json()) as { roles?: RoleView[] } | RoleView[];
        const afterRoles = Array.isArray(afterBody) ? afterBody : (afterBody.roles ?? []);
        expect(afterRoles.some((role) => role.name === roleName)).toBe(false);
    });
});
