import type { Page } from "@playwright/test";
import { setupMockAuth } from "./helpers/auth";
// 走 mock 车道的公共失败门禁（BL-318）：console error / pageerror / 非预期 >=400 自动断言。
import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";

/**
 * task-136（用户原话「组织也没法配置」）：组织成员页六个写操作接真实契约的 mock lane 判据。
 *
 * <p>契约事实来自 G1 真栈取证（`internal/A03-xihe/evidence/2026-11-20-org-members-write/README.md`），
 * 三条与本 spec 直接相关：</p>
 * <ol>
 *   <li>确认门是「先撞 409 再确认」，**不是**「先查再发」：`PUT /org-units/{u}/members/{m}` 不带
 *       `confirmAffected` 且这次移动影响该主体 OWNED 的工作区时，服务端回 409
 *       `ORG_UNIT_MOVE_CONFIRMATION_REQUIRED`，人数只在 `detail` 原文里（409 体**没有**
 *       `affectedWorkspaceIds`）。</li>
 *   <li>角色绑定域**只有 PUT 没有 GET** ⇒ 界面不能做整集勾选；先以空集建立基线，再逐条加/单条解绑，
 *       每次都以响应体为新基线。</li>
 *   <li>本地派生必然少报（CP 把 UI 看不见的工作区也算） ⇒ 界面必须写「可能不全」，不许假装精确。</li>
 * </ol>
 *
 * <p><b>为什么这些必须是 e2e 而不是单测</b>：单测只能证明 composable 收了 409；本 spec 证明
 * 「点按钮 → 真发请求 → 窗口不关 → 原文上屏 → 再点确认 → 第二次请求带 confirmAffected:true」
 * 这条**跨组件 + 跨请求**的链在真浏览器里成立。</p>
 */

/** 桩端点故意回 4xx（409 确认门 / 422 环 / 403 原子缺失）⇒ 逐条放行，不放行整条门。 */
test.use({ mockAllow: [...DEFAULT_MOCK_ALLOW, String.raw`/api/v1/org-units`] });

/**
 * 在 Dialog 里选 reka Select 的一项：**必须真点击**。
 *
 * <p>`selectByDomClick`（DOM `element.click()` 兜底）在对话框内的 Select 上不可靠：
 * 弹层拿不到 pointer 事件就不会关闭，它留下的 `data-slot="dialog-overlay" aria-hidden="true"`
 * 会一直 intercept 后续点击（实测 2026-11-21：`org-write-submit` 点不动）；另一种表现是
 * 选项没进 v-model，提交按钮恒 disabled（`org-write-role-add-submit`）。</p>
 */
async function pickOption(page: Page, triggerTestId: string, label: string): Promise<void> {
    await page.getByTestId(triggerTestId).click();
    const option = page.getByRole("option", { name: label, exact: true }).first();
    await option.waitFor({ state: "visible", timeout: 5_000 });
    await option.click();
    await expect(option).toBeHidden({ timeout: 5_000 });
}

const CALLER_ID = "user-1";

interface Seen {
    method: string;
    path: string;
    search: string;
    body: string;
}

interface Reply {
    status: number;
    body?: unknown;
}

function problem(status: number, code: string, detail: string, requestId = "req-mock"): Reply {
    return {
        status,
        body: {
            type: `https://xihe.dev/problems/${code.toLowerCase()}`,
            title: status === 409 ? "Conflict" : "Unprocessable Entity",
            status,
            code,
            detail,
            requestId,
        },
    };
}

interface Plan {
    create: Reply;
    rename: Reply;
    move: Reply;
    /** 第一次 PUT（不带 confirmAffected）的回复；第二次（带 confirm）走 `memberMoveConfirmed`。 */
    memberMove: Reply;
    memberMoveConfirmed: Reply;
    remove: Reply;
    roleBindings: Reply;
}

const okNodes = (nodes: unknown[]): Reply => ({
    status: 200,
    body: { nodes },
});

function defaultPlan(): Plan {
    return {
        create: { status: 201, body: { id: "ou-new", path: "p.ou-new" } },
        rename: {
            status: 200,
            body: { id: "ou-rd", name: "研发部2", parentId: null, depth: 0, hasChildren: true },
        },
        move: {
            status: 200,
            body: {
                id: "ou-rd",
                name: "研发部",
                parentId: "ou-platform",
                depth: 1,
                hasChildren: true,
            },
        },
        memberMove: {
            status: 200,
            body: {
                memberId: CALLER_ID,
                fromOrgUnitId: null,
                toOrgUnitId: "ou-rd",
                affectedWorkspaceIds: [],
                auditEvent: "org_membership_moved",
            },
        },
        memberMoveConfirmed: {
            status: 200,
            body: {
                memberId: CALLER_ID,
                fromOrgUnitId: null,
                toOrgUnitId: "ou-rd",
                affectedWorkspaceIds: ["w-1"],
                auditEvent: "org_membership_moved",
            },
        },
        remove: { status: 204 },
        roleBindings: { status: 200, body: { roleIds: [] } },
    };
}

/** 树：根 研发部(有子) → 平台组；只两行即可覆盖「选中单元」与「父候选」。 */
const NODES: Record<string, unknown[]> = {
    "": [{ id: "ou-rd", name: "研发部", parentId: null, depth: 0, hasChildren: true }],
    "ou-rd": [
        { id: "ou-platform", name: "平台组", parentId: "ou-rd", depth: 1, hasChildren: false },
    ],
};

const ORGANIZATION_ROLE = {
    id: "role-org",
    name: "ORG_GOVERNOR",
    displayName: "组织治理员",
    description: "",
    system: false,
    bindingCount: 0,
    // 原子落在 CP 治理白名单内（MANAGE_ORG_UNITS / MANAGE_ORG_UNIT_MEMBERS / READ_ORG_UNIT_MEMBERS）。
    atoms: [
        {
            name: "MANAGE_ORG_UNITS",
            scopeClass: "instance",
            capability: "manage",
            resource: "org_unit",
        },
    ],
};

let seen: Seen[] = [];
let plan: Plan = defaultPlan();

/**
 * 全部 org 面桩：**在 setupMockAuth 之后注册**（Playwright route 是 LIFO，后注册优先），
 * 否则会被它那条回 `200 {}` 的 `/api/v1/**` 兜底吃掉 —— 空对象比 404 更难查。
 */
async function stubOrgApi(page: Page): Promise<void> {
    const record = (method: string, url: string, body: string) => {
        const parsed = new URL(url);
        seen.push({ method, path: parsed.pathname, search: parsed.search, body });
    };

    await page.route(/\/api\/v1\/org-units(\?.*)?$/, async (route) => {
        const request = route.request();
        const url = request.url();
        record(request.method(), url, request.postData() ?? "");
        if (request.method() === "POST") return route.fulfill(reply(plan.create));
        const parentId = new URL(url).searchParams.get("parentId") ?? "";
        return route.fulfill(reply(okNodes(NODES[parentId] ?? [])));
    });

    await page.route(/\/api\/v1\/org-units\/[^/]+\/parent$/, async (route) => {
        record(route.request().method(), route.request().url(), route.request().postData() ?? "");
        await route.fulfill(reply(plan.move));
    });

    await page.route(/\/api\/v1\/org-units\/[^/]+\/members\/[^/]+(\?.*)?$/, async (route) => {
        const request = route.request();
        record(request.method(), request.url(), request.postData() ?? "");
        if (request.method() === "DELETE") return route.fulfill(reply(plan.remove));
        // 同一路径两次 PUT：不带 confirmAffected 的第一次与带 true 的第二次分开配置。
        const body = request.postData() ?? "";
        const confirmed = body.includes("true");
        return route.fulfill(reply(confirmed ? plan.memberMoveConfirmed : plan.memberMove));
    });

    await page.route(/\/api\/v1\/org-units\/[^/]+\/members(\?.*)?$/, async (route) => {
        record(route.request().method(), route.request().url(), route.request().postData() ?? "");
        await route.fulfill(
            reply({
                status: 200,
                body: {
                    // 读面形状是 { members }（api.listOrgUnitMembers 读 data.members）；写成 { nodes } 会让
                    // 页面在 .length 上抛 pageerror，门禁全红而断言一条都没跑。
                    members: [
                        {
                            memberKind: "human",
                            memberId: CALLER_ID,
                            orgUnitId: "ou-rd",
                            displayName: "测试管理员",
                        },
                    ],
                },
            }),
        );
    });

    await page.route(/\/api\/v1\/org-units\/[^/]+\/role-bindings$/, async (route) => {
        const request = route.request();
        record(request.method(), request.url(), request.postData() ?? "");
        const body = request.postData() ?? "{}";
        const roleIds = (JSON.parse(body) as { roleIds?: string[] }).roleIds ?? [];
        // 基线与后续提交共用同一个回复工厂：成功后响应体就是新基线（契约里没有 GET 读面）。
        if (plan.roleBindings.status === 200) {
            return route.fulfill(reply({ status: 200, body: { roleIds } }));
        }
        return route.fulfill(reply(plan.roleBindings));
    });

    await page.route(/\/api\/v1\/org-units\/[^/]+(\?.*)?$/, async (route) => {
        const request = route.request();
        record(request.method(), request.url(), request.postData() ?? "");
        await route.fulfill(reply(plan.rename));
    });

    await page.route(/\/api\/v1\/roles(\?.*)?$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([ORGANIZATION_ROLE]),
        });
    });

    await page.route(/\/api\/v1\/users(\?.*)?$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                items: [{ id: CALLER_ID, email: "test@xihe.local", name: "测试管理员" }],
            }),
        });
    });

    await page.route(/\/api\/v1\/workspaces(\?.*)?$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([
                { id: "w-1", name: "研发工作区", workspaceRole: "OWNER" },
                { id: "w-2", name: "只读工作区", workspaceRole: "VIEWER" },
            ]),
        });
    });

    await page.route(/\/api\/v1\/agent-principals(\?.*)?$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ principals: [{ principalId: "agent-1", name: "编码助手" }] }),
        });
    });
}

function reply(value: Reply): { status: number; contentType: string; body: string } {
    return {
        status: value.status,
        contentType: "application/json",
        body: JSON.stringify(value.body ?? {}),
    };
}

async function openMembers(page: Page): Promise<void> {
    await setupMockAuth(page);
    await stubOrgApi(page);
    await page.goto("/members");
    await page.waitForSelector('[data-testid="org-tree-label-ou-rd"]');
}

async function selectRootUnit(page: Page): Promise<void> {
    await page.locator('[data-testid="org-tree-label-ou-rd"]').click();
    await page.waitForSelector('[data-testid="org-write-actions"]');
}

function wrote(method: string, path: string): Seen[] {
    return seen.filter((row) => row.method === method && row.path === path);
}

test.beforeEach(() => {
    seen = [];
    plan = defaultPlan();
});

test.describe("task-136 组织写面（mock lane）", () => {
    test("新建子单元：选中父单元后提交 ⇒ POST /org-units 带 parentId，成功后重取树", async ({
        page,
    }) => {
        await openMembers(page);
        await selectRootUnit(page);
        const rootsBefore = wrote("GET", "/api/v1/org-units").length;

        await page.getByTestId("org-write-new-unit").click();
        await page.getByTestId("org-write-name").fill("新部门");
        await page.getByTestId("org-write-submit").click();

        await expect.poll(() => wrote("POST", "/api/v1/org-units").length).toBe(1);
        expect(JSON.parse(wrote("POST", "/api/v1/org-units")[0].body)).toEqual({
            name: "新部门",
            parentId: "ou-rd",
        });
        // J5：写后一律重取读面（不乐观插入）。树根请求因此变多。
        await expect
            .poll(() => wrote("GET", "/api/v1/org-units").length)
            .toBeGreaterThan(rootsBefore);
        await expect(page.getByTestId("org-write-dialog")).toHaveCount(0);
    });

    test("新建撞 409 同名：窗口不关，code 与 detail 原文逐字可见（J2）", async ({ page }) => {
        plan.create = problem(
            409,
            "ORG_UNIT_NAME_CONFLICT",
            "a sibling unit already uses this name",
            "req-name-conflict",
        );
        await openMembers(page);
        await selectRootUnit(page);

        await page.getByTestId("org-write-new-unit").click();
        await page.getByTestId("org-write-name").fill("重复");
        await page.getByTestId("org-write-submit").click();

        await expect(page.getByTestId("org-write-problem-code")).toContainText(
            "ORG_UNIT_NAME_CONFLICT",
        );
        await expect(page.getByTestId("org-write-problem-detail")).toContainText(
            "a sibling unit already uses this name",
        );
        await expect(page.getByTestId("org-write-problem")).toContainText("req-name-conflict");
        // 失败不关窗：原文必须留在屏幕上，否则用户看到「没反应」。
        await expect(page.getByTestId("org-write-dialog")).toHaveCount(1);
    });

    test("改名：PATCH /org-units/{id} 带 name；成功后关窗并重取", async ({ page }) => {
        await openMembers(page);
        await selectRootUnit(page);

        await page.getByTestId("org-write-rename").click();
        await expect(page.getByTestId("org-write-name")).toHaveValue("研发部");
        await page.getByTestId("org-write-name").fill("研发部2");
        await page.getByTestId("org-write-submit").click();

        await expect.poll(() => wrote("PATCH", "/api/v1/org-units/ou-rd").length).toBe(1);
        expect(JSON.parse(wrote("PATCH", "/api/v1/org-units/ou-rd")[0].body)).toEqual({
            name: "研发部2",
        });
        await expect(page.getByTestId("org-write-dialog")).toHaveCount(0);
    });

    test("搬移成环：请求照样发出去，422 ORG_UNIT_CYCLE 原文上屏（不本地预检）", async ({
        page,
    }) => {
        plan.move = problem(
            422,
            "ORG_UNIT_CYCLE",
            "an org unit cannot become a child of itself or of its own descendant",
        );
        await openMembers(page);
        await selectRootUnit(page);

        await page.getByTestId("org-write-move").click();
        // 父候选 = 树里已加载的单元（含自己）——环由服务端判定，界面不拦。
        await pickOption(page, "org-write-parent", "研发部");
        await page.getByTestId("org-write-submit").click();

        await expect.poll(() => wrote("PUT", "/api/v1/org-units/ou-rd/parent").length).toBe(1);
        expect(JSON.parse(wrote("PUT", "/api/v1/org-units/ou-rd/parent")[0].body)).toEqual({
            parentId: "ou-rd",
        });
        await expect(page.getByTestId("org-write-problem-code")).toContainText("ORG_UNIT_CYCLE");
        await expect(page.getByTestId("org-write-problem-detail")).toContainText(
            "an org unit cannot become a child of itself or of its own descendant",
        );
    });

    test("加成员撞 409 确认门：计数 + 派生清单 + 「可能不全」+ 自我后果；确认后带 confirmAffected:true 重发", async ({
        page,
    }) => {
        plan.memberMove = problem(
            409,
            "ORG_UNIT_MOVE_CONFIRMATION_REQUIRED",
            "this move affects 11 workspace(s) owned by the subject; resend with confirmAffected=true",
            "req-move-gate",
        );
        await openMembers(page);
        await selectRootUnit(page);

        await page.getByTestId("org-write-add-member").click();
        await page.getByTestId(`org-write-subject-${CALLER_ID}`).click();
        await page.getByTestId("org-write-submit").click();

        // 第一次：不带 confirmAffected。
        await expect
            .poll(() => wrote("PUT", `/api/v1/org-units/ou-rd/members/${CALLER_ID}`).length)
            .toBe(1);
        expect(
            JSON.parse(wrote("PUT", `/api/v1/org-units/ou-rd/members/${CALLER_ID}`)[0].body),
        ).toEqual({ confirmAffected: false });

        // 409 原文 + 计数：数字来自 detail 原文，不是界面编的。
        await expect(page.getByTestId("org-write-affected-count")).toContainText("11");
        await expect(page.getByTestId("org-write-problem-detail")).toContainText(
            "affects 11 workspace(s)",
        );
        // 本地派生只列 OWNER，且必须标注「可能不全」。
        await expect(page.getByTestId("org-write-affected-list")).toContainText("研发工作区");
        await expect(page.getByTestId("org-write-affected-list")).not.toContainText("只读工作区");
        await expect(page.getByTestId("org-write-affected-partial")).toContainText(
            /可能不全|incomplete/i,
        );
        // 移动对象是自己 ⇒ 必须点名「移出后失去读面、搬回 403」。
        await expect(page.getByTestId("org-write-self-risk")).toContainText("403");

        await page.getByTestId("org-write-confirm-move").click();
        await expect
            .poll(() => wrote("PUT", `/api/v1/org-units/ou-rd/members/${CALLER_ID}`).length)
            .toBe(2);
        expect(
            JSON.parse(wrote("PUT", `/api/v1/org-units/ou-rd/members/${CALLER_ID}`)[1].body),
        ).toEqual({ confirmAffected: true });
        await expect(page.getByTestId("org-write-dialog")).toHaveCount(0);
    });

    test("移除成员：先选人再确认 ⇒ DELETE ?memberKind=human，且自我后果点名", async ({ page }) => {
        await openMembers(page);
        await selectRootUnit(page);

        await page.getByTestId("org-write-remove-member").click();
        await page.getByTestId(`org-write-remove-pick-${CALLER_ID}`).click();
        await expect(page.getByTestId("org-write-self-risk")).toContainText(
            /没有接口|no endpoint/i,
        );
        // 确认前一个请求都不发。
        expect(wrote("DELETE", `/api/v1/org-units/ou-rd/members/${CALLER_ID}`)).toHaveLength(0);

        await page.getByTestId("org-write-confirm-remove").click();
        await expect
            .poll(() => wrote("DELETE", `/api/v1/org-units/ou-rd/members/${CALLER_ID}`).length)
            .toBe(1);
        expect(wrote("DELETE", `/api/v1/org-units/ou-rd/members/${CALLER_ID}`)[0].search).toContain(
            "memberKind=human",
        );
        await expect(page.getByTestId("org-write-dialog")).toHaveCount(0);
    });

    test("改角色：无 GET 读面 ⇒ 先建空集基线，再逐条加（每次响应体即新基线）", async ({ page }) => {
        await openMembers(page);
        await selectRootUnit(page);

        await page.getByTestId("org-write-change-role").click();
        await expect(page.getByTestId("org-write-role-baseline-unknown")).toHaveCount(1);
        await page.getByTestId("org-write-role-establish").click();

        await expect
            .poll(() => wrote("PUT", "/api/v1/org-units/ou-rd/role-bindings").length)
            .toBe(1);
        expect(JSON.parse(wrote("PUT", "/api/v1/org-units/ou-rd/role-bindings")[0].body)).toEqual({
            roleIds: [],
        });
        await expect(page.getByTestId("org-write-role-baseline")).toBeVisible();

        await pickOption(page, "org-write-role-add", "组织治理员");
        await page.getByTestId("org-write-role-add-submit").click();

        await expect
            .poll(() => wrote("PUT", "/api/v1/org-units/ou-rd/role-bindings").length)
            .toBe(2);
        expect(JSON.parse(wrote("PUT", "/api/v1/org-units/ou-rd/role-bindings")[1].body)).toEqual({
            roleIds: ["role-org"],
        });
        await expect(page.getByTestId("org-write-role-bound-role-org")).toBeVisible();
    });

    test("改角色撞 409 非治理角色：镜像不是权威，原文照显（J2 第 4 条）", async ({ page }) => {
        plan.roleBindings = problem(
            409,
            "ORG_SCOPE_ROLE_FORBIDDEN",
            "role 'ORG_GOVERNOR' is not an org-unit governance role; atom(s) outside the whitelist: CREATE_OWN_AGENT",
        );
        await openMembers(page);
        await selectRootUnit(page);

        await page.getByTestId("org-write-change-role").click();
        await page.getByTestId("org-write-role-establish").click();

        await expect(page.getByTestId("org-write-problem-code")).toContainText(
            "ORG_SCOPE_ROLE_FORBIDDEN",
        );
        await expect(page.getByTestId("org-write-problem-detail")).toContainText(
            "atom(s) outside the whitelist",
        );
        await expect(page.getByTestId("org-write-dialog")).toHaveCount(1);
    });
});
