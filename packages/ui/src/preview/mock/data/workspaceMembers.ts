/**
 * 工作区成员面（`/api/v1/workspaces/{workspaceId}/members`）的夹具 + dispatch —— task-38。
 *
 * ## 为什么有这个文件
 * 用户实拍：工作区「成员」页（`/workspace/<id>/members`）报 `出错: API error 404`。
 * 根因不是页面写错，是 **mock 车道根本没有这条端点**：`api-server.ts` 里只实现了
 * `/org-units/{id}/members`（组织成员），`workspaces/` 前缀的分支只有 sessions / checkpoints /
 * agents / environment / jobs / stdio-servers / mcp/servers ⇒ 产品页拿到 404，渲染错误态。
 * 而 `ApiError.message` 在响应体缺 `code` 时回退成 `API error <status>`（`composables/api.ts:2549`），
 * 于是用户看到的是一句没有语义的 404 —— 正是「夹具缺口会伪装成产品回归」的同款形态。
 *
 * ## 形状照契约，不照页面
 * 唯一依据是 `docs/api/openapi.yaml`（`:548-629` 四条 path + `:6984-6986` 三个 schema）：
 * - `GET`   → 200 **裸数组** `MemberView[]`（`{userId, username, email, name, role, createdAt}`）；
 * - `POST`  → 201 `MemberView`；404 `USER_NOT_FOUND`；409 `MEMBER_ALREADY_EXISTS`；400 `INVALID_NAME_FORMAT`；
 * - `PATCH /{userId}` → 200 `MemberView`；404 `MEMBER_NOT_FOUND`；409 `LAST_OWNER`；
 * - `DELETE /{userId}` → 204（无体）；404 `MEMBER_NOT_FOUND`；409 `LAST_OWNER`；
 * - 未知 workspace ⇒ 404 `WORKSPACE_NOT_FOUND`（**不是**把所有 404 都改成 200 —— 那条反例由
 *   `__tests__/workspaceMembers.coverage.spec.ts` 钉住）。
 * `role` 只出 `OWNER|EDITOR|VIEWER`：契约里 legacy `ADMIN/MEMBER` **投影**为 `EDITOR`，不往 UI 漏旧词。
 *
 * ## 两个只有 mock 才需要的开关（都写在这里，不自创第三个）
 * - `XIHE_UI_MOCK_MEMBER_VIEWER=1` ⇒ 模拟「非 OWNER」：读也 403 `WORKSPACE_FORBIDDEN`（PLAN-0565 裁定 #2：
 *   VIEWER 连列表都不给），写也 403。默认关闭，与 `XIHE_UI_MOCK_DENIED` / `_NONADMIN` 同形。
 * - 唯一 OWNER 的「降级/移除」⇒ 409 `LAST_OWNER`：这条**不需要开关**，它是真实判定（server-authoritative），
 *   用户下面就会点「把自己改成只读」「移除自己」。
 *
 * ## 不做什么（诚实边界）
 * 不复刻 CP 的审计落库、`role_bindings`、账号密码/邀请流，也不做「按 email 邀请」——契约里添加成员
 * **只按唯一 username**（PLAN-0565 裁定 #7），多给一条入口等于教 UI 走不存在的路。
 */

export interface MockWorkspaceMember {
    userId: string;
    username: string;
    email: string;
    name: string | null;
    role: "OWNER" | "EDITOR" | "VIEWER";
    createdAt: string;
}

/** 与 `api-server.ts` 的 `MOCK_WORKSPACE.id` 同一个工作区（同一性由 spec 用 `GET /workspaces` 反查钉住）。 */
export const MOCK_MEMBERS_WORKSPACE_ID = "9f8e7d6c-5b4a-4321-8fed-cba987654321";

const ASSIGNABLE_ROLES = new Set(["EDITOR", "VIEWER"]);

/** 账号名文法（openapi `MemberAddRequest.username` 的 pattern，2026-11-03 命名裁定）。 */
const USERNAME_PATTERN = /^[A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff]*$/;

/**
 * 已注册账号（POST 的 username 查表面）。前三个是当前成员，后两个**有账号但不是成员**
 * （否则「加人」这条路在预览里永远只有 409 一种结局，等于没演示到 201）。
 */
const ACCOUNTS: Array<{ userId: string; username: string; email: string; name: string }> = [
    { userId: "mock-user", username: "zhang-an", email: "mock@xihe.dev", name: "张安" },
    { userId: "u-alan", username: "alan", email: "alan@xihe.dev", name: "阿岚" },
    { userId: "u-guyuan", username: "guyuan", email: "guyuan@xihe.dev", name: "顾远" },
    { userId: "u-zhouye", username: "zhouye", email: "zhouye@xihe.dev", name: "周野" },
    { userId: "u-lina", username: "lina", email: "lina@xihe.dev", name: "李娜" },
];

const INITIAL_MEMBERS: MockWorkspaceMember[] = [
    {
        userId: "mock-user",
        username: "zhang-an",
        email: "mock@xihe.dev",
        name: "张安",
        role: "OWNER",
        createdAt: "2026-11-01T09:00:00Z",
    },
    {
        userId: "u-alan",
        username: "alan",
        email: "alan@xihe.dev",
        name: "阿岚",
        role: "EDITOR",
        createdAt: "2026-11-03T02:14:00Z",
    },
    {
        userId: "u-guyuan",
        username: "guyuan",
        email: "guyuan@xihe.dev",
        name: "顾远",
        role: "VIEWER",
        createdAt: "2026-11-06T07:41:00Z",
    },
];

/**
 * 成员表。**可变**：POST/PATCH/DELETE 真的改它 —— 否则「加完人列表不变」会在预览里被
 * 当成产品 bug（task-449 同款教训：夹具必须是路由真的消费的那一份）。
 */
let members: MockWorkspaceMember[] = INITIAL_MEMBERS.map((row) => ({ ...row }));

/** 测试隔离：`beforeEach` 复位（与 `resetWorkspaceAgentFixture` 同形）。 */
export function resetWorkspaceMemberFixture(): void {
    members = INITIAL_MEMBERS.map((row) => ({ ...row }));
}

/** 供 spec 直接对账的只读快照（返回副本，防止测试改到内部状态）。 */
export function membersOfWorkspace(workspaceId: string): MockWorkspaceMember[] | null {
    if (workspaceId !== MOCK_MEMBERS_WORKSPACE_ID) return null;
    return members.map((row) => ({ ...row }));
}

/** 预览开关：模拟非 OWNER（读也 403）。默认关闭。 */
export function isMemberViewerPreview(): boolean {
    return process.env.XIHE_UI_MOCK_MEMBER_VIEWER === "1";
}

export interface MockMemberDispatchResult {
    status: number;
    body: unknown;
}

function problem(status: number, code: string, detail: string): MockMemberDispatchResult {
    return {
        status,
        body: { type: "about:blank", title: code, status, code, detail, requestId: "mock-request" },
    };
}

function ownerCount(rows: MockWorkspaceMember[]): number {
    return rows.filter((row) => row.role === "OWNER").length;
}

/** 入参形状校验：契约把「名字文法不对」与「其余非法」分成两个错误码，别合并。 */
function validateUsername(
    raw: unknown,
): { ok: true; username: string } | { ok: false; code: string; detail: string } {
    const username = typeof raw === "string" ? raw.trim() : "";
    if (username.length === 0) {
        return { ok: false, code: "INVALID_REQUEST", detail: "username is required" };
    }
    if (!USERNAME_PATTERN.test(username)) {
        return {
            ok: false,
            code: "INVALID_NAME_FORMAT",
            detail: "Username may contain letters, Chinese characters and digits, and must not start with a digit",
        };
    }
    return { ok: true, username };
}

/**
 * 成员面 dispatch。未知 suffix/方法一律回 `null` ⇒ 上层 404 `MOCK_ENDPOINT_MISSING`，
 * **不做通配 200 掩盖缺口**（D-1248）。
 */
export async function handleWorkspaceMemberResource(
    method: string,
    path: string,
    _url: URL,
    readJsonBody: () => Promise<Record<string, unknown>>,
): Promise<MockMemberDispatchResult | null> {
    const listMatch = path.match(/^\/workspaces\/([^/]+)\/members$/);
    const itemMatch = path.match(/^\/workspaces\/([^/]+)\/members\/([^/]+)$/);
    if (!listMatch && !itemMatch) return null;

    const workspaceId = decodeURIComponent((listMatch ?? itemMatch)![1]);
    // ① 预览开关（模拟 VIEWER）：契约里非 OWNER 连列表都读不到 ⇒ 403 先于一切。
    if (isMemberViewerPreview()) {
        return problem(403, "WORKSPACE_FORBIDDEN", "Workspace role VIEWER cannot manage members");
    }
    // ② 反例基线：不存在的 workspace 必须仍是 404（不是「一律 200」）。
    const rows = membersOfWorkspace(workspaceId);
    if (!rows) {
        return problem(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
    }

    if (listMatch) {
        if (method === "GET") return { status: 200, body: rows };
        if (method === "POST") {
            const body = await readJsonBody();
            const usernameCheck = validateUsername(body.username);
            if (!usernameCheck.ok) {
                return problem(400, usernameCheck.code, usernameCheck.detail);
            }
            const role = typeof body.role === "string" ? body.role : "";
            if (!ASSIGNABLE_ROLES.has(role)) {
                return problem(400, "INVALID_REQUEST", "role must be EDITOR or VIEWER");
            }
            const account = ACCOUNTS.find((row) => row.username === usernameCheck.username);
            if (!account) {
                // 契约原文：UI copy「该用户不存在，请对方先注册」（openapi:585）。
                return problem(
                    404,
                    "USER_NOT_FOUND",
                    "User not found; the account must register first",
                );
            }
            if (members.some((row) => row.userId === account.userId)) {
                return problem(
                    409,
                    "MEMBER_ALREADY_EXISTS",
                    "User is already a member of this workspace",
                );
            }
            const added: MockWorkspaceMember = {
                userId: account.userId,
                username: account.username,
                email: account.email,
                name: account.name,
                role: role as "EDITOR" | "VIEWER",
                createdAt: new Date().toISOString(),
            };
            members = [...members, added];
            return { status: 201, body: { ...added } };
        }
        return null;
    }

    const userId = decodeURIComponent(itemMatch![2]);
    const target = members.find((row) => row.userId === userId);
    if (!target) {
        return problem(404, "MEMBER_NOT_FOUND", "Member not found in this workspace");
    }
    if (method === "PATCH") {
        const body = await readJsonBody();
        const role = typeof body.role === "string" ? body.role : "";
        if (!ASSIGNABLE_ROLES.has(role)) {
            return problem(400, "INVALID_REQUEST", "role must be EDITOR or VIEWER");
        }
        // 唯一 OWNER 不许降级（server-authoritative，无角色例外）。
        if (target.role === "OWNER" && role !== "OWNER" && ownerCount(members) === 1) {
            return problem(409, "LAST_OWNER", "Cannot downgrade the last OWNER of the workspace");
        }
        const updated: MockWorkspaceMember = { ...target, role: role as "EDITOR" | "VIEWER" };
        members = members.map((row) => (row.userId === userId ? updated : row));
        return { status: 200, body: { ...updated } };
    }
    if (method === "DELETE") {
        if (target.role === "OWNER" && ownerCount(members) === 1) {
            return problem(409, "LAST_OWNER", "Cannot remove the last OWNER of the workspace");
        }
        members = members.filter((row) => row.userId !== userId);
        return { status: 204, body: null };
    }
    return null;
}
