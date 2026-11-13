import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";
import { selectByTestId } from "../helpers/select";

// BL-318：本文件有两条**故意**制造成员写失败（409 已存在 / 404 未知用户名）以验裁定 #6 文案，
// 逐条放行成员端点的失败信号。
test.use({ mockAllow: [...DEFAULT_MOCK_ALLOW, String.raw`/workspaces/[^/]+/members`] });

// PLAN-0565：工作区设置页「成员」tab（裁定 #2/#3/#6/#7 的 UI 侧验收）。
const WORKSPACE_ID = "workspace-1";

interface MockMember {
    userId: string;
    username: string;
    email: string;
    name: string | null;
    role: string;
    createdAt: string;
}

let members: MockMember[];
let seq = 0;

/**
 * task-470：把 `/me/permissions` 投影**挂上**，并逐用例只翻 `workspaceAdmin` 这一个布尔。
 *
 * <p>为什么必须挂：task-414 把管理面判据迁到能力原子后，`stores/auth.ts` 的
 * `canManageWorkspace = canWorkspaceAdmin(id) || workspaceProjection?.workspaceAdmin === true`
 * **完全不看 `workspaceRole`**。夹具此前只给 role=OWNER、不挂投影 ⇒ 判据恒 false ⇒ 加人表单恒隐藏，
 * OWNER 的两条用例红在「元素 disabled/不可见」而不是产品缺陷。</p>
 *
 * <p>为什么四条用例都要挂（而不是只给 OWNER 挂）：投影**缺失**时任何角色都只读，
 * 那样 EDITOR/VIEWER 的「表单隐藏」就**不携带角色判别力**（把 OWNER 改成 VIEWER 照样绿）。
 * 判别力来自**同一投影面下的差异** —— 四条都 present，只差 `workspaceAdmin`。</p>
 */
async function serveProjection(
    page: import("@playwright/test").Page,
    options: { role: string; workspaceAdmin: boolean },
): Promise<void> {
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
                        workspaceId: WORKSPACE_ID,
                        workspaceRole: options.role,
                        workspaceAdmin: options.workspaceAdmin,
                        // 角色基线写权限：真实 CP 给 OWNER/EDITOR `WRITE_WORKSPACE_CONTENT`，VIEWER 没有。
                        // 不给的话 `canViewMembers`（投影已知时 = 可写 || 可管理）会把 EDITOR 判成
                        // **连列表都看不到** —— 那不是本用例要测的只读态，是另一种权限缺失。
                        // 管理面的判别力仍只由 `workspaceAdmin` 这一个布尔承担。
                        permissions:
                            options.role === "VIEWER"
                                ? []
                                : [{ actionClass: "WRITE_WORKSPACE_CONTENT", resource: "*" }],
                    },
                ],
            }),
        }),
    );
}

function makeMember(username: string, role: string, userId: string): MockMember {
    return {
        userId,
        username,
        email: `${username}@test.com`,
        name: null,
        role,
        createdAt: "2026-10-28T00:00:00Z",
    };
}

test.describe("PLAN-0565 workspace members tab", () => {
    test.beforeEach(async ({ page }) => {
        seq = 0;
        members = [
            makeMember("owner", "OWNER", "u-owner"),
            makeMember("editor", "EDITOR", "u-editor"),
        ];
        await setupMockAuth(page);
        // task-470：默认投影 = OWNER + workspaceAdmin:true（后注册的路由优先，个别用例可再覆盖）。
        await serveProjection(page, { role: "OWNER", workspaceAdmin: true });
        await page.route("**/api/v1/workspaces/workspace-1/members**", async (route) => {
            const method = route.request().method();
            const url = new URL(route.request().url());
            if (method === "GET") {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify(members),
                });
                return;
            }
            if (method === "POST") {
                const body = route.request().postDataJSON() as {
                    username?: string;
                    role?: string;
                };
                if (!body.username || !body.role) {
                    await route.fulfill({
                        status: 400,
                        contentType: "application/problem+json",
                        body: JSON.stringify({ code: "INVALID_REQUEST", detail: "bad body" }),
                    });
                    return;
                }
                if (body.username === "ghost") {
                    await route.fulfill({
                        status: 404,
                        contentType: "application/problem+json",
                        body: JSON.stringify({
                            code: "USER_NOT_FOUND",
                            detail: "No registered account for this username",
                        }),
                    });
                    return;
                }
                if (members.some((m) => m.username === body.username)) {
                    await route.fulfill({
                        status: 409,
                        contentType: "application/problem+json",
                        body: JSON.stringify({
                            code: "MEMBER_ALREADY_EXISTS",
                            detail: "already a member",
                        }),
                    });
                    return;
                }
                seq += 1;
                const created = makeMember(body.username, body.role, `u-new-${seq}`);
                members.push(created);
                await route.fulfill({
                    status: 201,
                    contentType: "application/json",
                    body: JSON.stringify(created),
                });
                return;
            }
            if (method === "PATCH") {
                const userId = url.pathname.split("/").pop() ?? "";
                const target = members.find((m) => m.userId === userId);
                if (!target) {
                    await route.fulfill({
                        status: 404,
                        contentType: "application/problem+json",
                        body: JSON.stringify({ code: "MEMBER_NOT_FOUND", detail: "not a member" }),
                    });
                    return;
                }
                const body = route.request().postDataJSON() as { role?: string };
                target.role = body.role ?? target.role;
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify(target),
                });
                return;
            }
            if (method === "DELETE") {
                const userId = url.pathname.split("/").pop() ?? "";
                const target = members.find((m) => m.userId === userId);
                if (!target) {
                    await route.fulfill({
                        status: 404,
                        contentType: "application/problem+json",
                        body: JSON.stringify({ code: "MEMBER_NOT_FOUND", detail: "not a member" }),
                    });
                    return;
                }
                if (
                    target.role === "OWNER" &&
                    members.filter((m) => m.role === "OWNER").length <= 1
                ) {
                    await route.fulfill({
                        status: 409,
                        contentType: "application/problem+json",
                        body: JSON.stringify({ code: "LAST_OWNER", detail: "last owner" }),
                    });
                    return;
                }
                members = members.filter((m) => m.userId !== userId);
                await route.fulfill({ status: 204 });
                return;
            }
            await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
        });
        await page.route("**/api/v1/config/**", (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ domain: "x", entries: {}, envOverridden: {} }),
            }),
        );
        await page.route("**/api/v1/events**", (route) =>
            route.fulfill({
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
                body: "retry: 5000\n\n",
            }),
        );
    });

    test("OWNER sees the tab, adds a member by username and removes one via confirm", async ({
        page,
    }) => {
        // task-236（M4-3）：成员提升为一级页 —— 直达 /members，不再经设置页 tab。
        await page.goto(`/workspace/${WORKSPACE_ID}/members`, { waitUntil: "load" });
        await expect(page.getByTestId("workspace-members-page")).toBeVisible();
        await expect(page.getByTestId("ws-members-list")).toBeVisible();
        await expect(page.getByTestId("ws-members-row")).toHaveCount(2);

        // Add by username (ruling #7) — the list reloads with the new row.
        await page.getByTestId("ws-members-add-input").fill("newmember");
        await selectByTestId(page, "ws-members-add-role", "VIEWER");
        await page.getByTestId("ws-members-add-btn").click();
        await expect(page.getByTestId("ws-members-row")).toHaveCount(3);
        await expect(page.getByTestId("ws-members-panel")).toContainText("newmember");

        // Duplicate add surfaces the localized conflict copy (insert-only API).
        await page.getByTestId("ws-members-add-input").fill("editor");
        await page.getByTestId("ws-members-add-btn").click();
        await expect(page.getByTestId("ws-members-panel")).toContainText("该用户已是工作区成员");

        // Remove the editor through the confirm dialog.
        await page.getByTestId("ws-members-remove-u-editor").click();
        await expect(page.getByTestId("ws-members-remove-confirm")).toBeVisible();
        await page.getByTestId("ws-members-remove-btn").click();
        await expect(page.getByTestId("ws-members-row")).toHaveCount(2);
    });

    test("unknown username surfaces the ruling-6 copy without adding a row", async ({ page }) => {
        // task-236（M4-3）：直达一级成员页。
        await page.goto(`/workspace/${WORKSPACE_ID}/members`, { waitUntil: "load" });
        await expect(page.getByTestId("ws-members-list")).toBeVisible();

        await page.getByTestId("ws-members-add-input").fill("ghost");
        await page.getByTestId("ws-members-add-btn").click();
        await expect(page.getByTestId("ws-members-panel")).toContainText(
            "该用户不存在，请对方先注册",
        );
        await expect(page.getByTestId("ws-members-row")).toHaveCount(2);
    });

    test("EDITOR sees a read-only member list", async ({ page }) => {
        await page.addInitScript(() => {
            sessionStorage.setItem(
                "xihe-workspace",
                JSON.stringify({
                    id: "workspace-1",
                    name: "Mock Workspace",
                    workspaceRole: "EDITOR",
                    ownerId: "owner-1",
                }),
            );
        });
        // task-470：投影 present 但 workspaceAdmin=false —— 「隐藏」这才可归因于本角色无该能力。
        await serveProjection(page, { role: "EDITOR", workspaceAdmin: false });
        // task-236（M4-3）：EDITOR 直达一级成员页（旧 ?tab=members 会重定向到这里）。
        await page.goto(`/workspace/${WORKSPACE_ID}/members`, { waitUntil: "load" });
        await expect(page.getByTestId("workspace-members-page")).toBeVisible();
        await expect(page.getByTestId("ws-members-panel")).toContainText(
            "仅工作区所有者可以管理成员。",
        );
        // BL-344：加人表单**常驻挂载**（无 v-if），只读时用 hidden 类隐藏；断言可见性而非
        // DOM 数量（节点存在是设计，不是回归）。
        await expect(page.getByTestId("ws-members-add")).toBeHidden();
        await expect(page.locator('[data-testid^="ws-members-remove-"]')).toHaveCount(0);
        await expect(page.getByTestId("ws-members-row")).toHaveCount(2);
    });

    test("VIEWER：成员页不渲染列表；旧 ?tab=members 深链重定向到成员页", async ({ page }) => {
        await page.addInitScript(() => {
            sessionStorage.setItem(
                "xihe-workspace",
                JSON.stringify({
                    id: "workspace-1",
                    name: "Mock Workspace",
                    workspaceRole: "VIEWER",
                    ownerId: "owner-1",
                }),
            );
        });
        // task-470：同上，VIEWER 也是「投影在、能力位为 false」，不是「投影没来」。
        await serveProjection(page, { role: "VIEWER", workspaceAdmin: false });
        await page.goto(`/workspace/${WORKSPACE_ID}/settings`, { waitUntil: "load" });
        // 设置页不再有成员 tab（单入口）。
        await expect(page.getByTestId("ws-settings-tab-members")).toHaveCount(0);

        // 旧深链 ?tab=members ⇒ 重定向到一级成员页（不回落、不 404），页壳在、列表不渲染。
        await page.goto(`/workspace/${WORKSPACE_ID}/settings?tab=members`, { waitUntil: "load" });
        await expect(page).toHaveURL(`/workspace/${WORKSPACE_ID}/members`);
        await expect(page.getByTestId("workspace-members-page")).toBeVisible();
        await expect(page.getByTestId("ws-members-panel")).toHaveCount(0);
        await expect(page.getByTestId("ws-members-row")).toHaveCount(0);
    });

    /**
     * task-470：钉「**谁负责加载投影**」。管理面判据读 `/me/permissions`，而启动只加载 capabilities；
     * 成员页若不再自己请求它，直连/刷新本页的真实 OWNER 会拿到只读面板。删掉 onMounted 这条就红。
     */
    test("成员页挂载即请求原子投影（防回归：删 onMounted 就红）", async ({ page }) => {
        const projection = page.waitForRequest((request) =>
            request.url().includes("/api/v1/me/permissions"),
        );
        await page.goto(`/workspace/${WORKSPACE_ID}/members`, { waitUntil: "load" });
        await projection;
        await expect(page.getByTestId("workspace-members-page")).toBeVisible();
    });

    /**
     * task-470 正对照：**同一份 EDITOR 夹具**，只把 `workspaceAdmin` 翻成 true ⇒ 表单必须变可见。
     * 没有这条，上面 EDITOR 的「隐藏」仍可能由别的门槛顺手挡住（投影缺失、页壳没挂、选择器错）；
     * 有了这条，「隐藏 ⇄ 可见」随**这一个布尔**翻转，判据才真正锚在能力位上。
     */
    test("EDITOR 夹具 + workspaceAdmin=true ⇒ 加人表单可见（判别力正对照）", async ({ page }) => {
        await page.addInitScript(() => {
            sessionStorage.setItem(
                "xihe-workspace",
                JSON.stringify({
                    id: "workspace-1",
                    name: "Mock Workspace",
                    workspaceRole: "EDITOR",
                    ownerId: "owner-1",
                }),
            );
        });
        await serveProjection(page, { role: "EDITOR", workspaceAdmin: true });
        await page.goto(`/workspace/${WORKSPACE_ID}/members`, { waitUntil: "load" });
        await expect(page.getByTestId("workspace-members-page")).toBeVisible();
        await expect(page.getByTestId("ws-members-add")).toBeVisible();
        await expect(page.getByTestId("ws-members-add-input")).toBeEnabled();
    });
});
