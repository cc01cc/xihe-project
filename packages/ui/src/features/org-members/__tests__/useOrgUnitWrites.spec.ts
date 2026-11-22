import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    ORG_GOVERNANCE_ATOMS,
    ORG_UNIT_MOVE_CONFIRMATION_CODE,
    deriveAffectedWorkspaces,
    isOrgGovernanceRole,
    parseAffectedWorkspaceCount,
    useOrgUnitWrites,
    type OrgWriteKind,
} from "../composables/useOrgUnitWrites";

/**
 * task-136 写面状态机的机器判据（DSD-1476：每个操作至少一条错误路径，且原文不许改写）。
 *
 * 六条错误码逐条对应 CP 的真实返回（G1 真栈取证，readings-g1.json / readings-g1-agent.json）：
 * 409 ORG_UNIT_NAME_CONFLICT、422 ORG_UNIT_CYCLE、409 ORG_UNIT_MOVE_CONFIRMATION_REQUIRED、
 * 409 ORG_SCOPE_ROLE_FORBIDDEN、403 FORBIDDEN、404 ORG_UNIT_NOT_FOUND。
 * 这里只驱动状态机（不发真请求），DOM 由 OrgMembersView.spec 钉。
 */

type Reply = { status: number; body?: unknown };
interface Seen {
    method: string;
    path: string;
    body: string;
}

let seen: Seen[] = [];

function mockApi(reply: (req: Seen & { url: URL }) => Reply) {
    seen = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const raw = typeof input === "string" ? input : input.url;
        const url = new URL(raw, "http://localhost");
        const method = (init?.method ?? "GET").toUpperCase();
        const body = typeof init?.body === "string" ? init.body : "";
        const req = { method, path: url.pathname + url.search, body, url };
        seen.push({ method, path: req.path, body });
        const result = reply(req);
        if (result.body === undefined) {
            return Promise.resolve(new Response(null, { status: result.status }));
        }
        return Promise.resolve(
            new Response(JSON.stringify(result.body), {
                status: result.status,
                headers: {
                    "content-type":
                        result.status >= 400 ? "application/problem+json" : "application/json",
                },
            }),
        );
    });
}

function problem(status: number, code: string, detail: string, requestId = "req-1") {
    return {
        body: { type: "about:blank", title: code, status, code, detail, requestId },
        status,
    };
}

const CALLER = "dc962fb0-fa74-46b4-a287-7433c0c7fa45";

function setup(callerId: string | null = CALLER) {
    const written: OrgWriteKind[] = [];
    const writes = useOrgUnitWrites({
        onWritten: (kind) => written.push(kind),
        callerId: () => callerId,
    });
    return { writes, written };
}

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("xihe-token", "test-token");
    vi.restoreAllMocks();
});

describe("纯函数（都是「宁可少说也不编」的分支）", () => {
    it("从 409 原文取受影响工作区计数；取不到必须是 null，不许猜", () => {
        expect(
            parseAffectedWorkspaceCount(
                "this move affects 11 workspace(s) owned by the subject; resend with confirmAffected=true",
            ),
        ).toBe(11);
        expect(parseAffectedWorkspaceCount("resend with confirmAffected=true")).toBeNull();
    });

    it("只有移的是自己才本地派生 OWNER 工作区；别人一律空清单", () => {
        const workspaces = [
            { id: "w-1", name: "研发", workspaceRole: "OWNER" },
            { id: "w-2", name: "运营", workspaceRole: "EDITOR" },
            { id: "w-3", name: "设计", workspaceRole: "OWNER" },
        ] as never;
        expect(deriveAffectedWorkspaces(workspaces, CALLER, CALLER).map((w) => w.id)).toEqual([
            "w-1",
            "w-3",
        ]);
        // 主体是别人 ⇒ 契约没有「按主体反查工作区」的端点 ⇒ 空清单（不许拿自己的冒充）。
        expect(deriveAffectedWorkspaces(workspaces, "someone-else", CALLER)).toEqual([]);
        expect(deriveAffectedWorkspaces(workspaces, CALLER, null)).toEqual([]);
    });

    it("治理白名单：空原子算、全子集算、越界不算（镜像 CP isGovernanceRole）", () => {
        expect(isOrgGovernanceRole([])).toBe(true);
        expect(isOrgGovernanceRole([{ name: ORG_GOVERNANCE_ATOMS[0] }])).toBe(true);
        expect(isOrgGovernanceRole([{ name: "MANAGE_ORG_UNITS" }, { name: "VIEW_SECRET" }])).toBe(
            false,
        );
    });
});

describe("新建 / 改名 / 搬移单元", () => {
    it("新建成功：打 POST /org-units 带 name+parentId，成功后回调重取（J5）", async () => {
        mockApi(() => ({ status: 201, body: { id: "u-new", path: "p.u-new" } }));
        const { writes, written } = setup();

        await expect(writes.createUnit({ name: "数据平台", parentId: "u-root" })).resolves.toBe(
            true,
        );
        expect(seen).toHaveLength(1);
        expect(seen[0].method).toBe("POST");
        expect(seen[0].path).toBe("/api/v1/org-units");
        expect(JSON.parse(seen[0].body)).toEqual({ name: "数据平台", parentId: "u-root" });
        expect(written).toEqual(["create-unit"]);
        expect(writes.problem.value).toBeNull();
    });

    it("同名 409 ORG_UNIT_NAME_CONFLICT：失败、原文照留、不回调重取", async () => {
        mockApi(() =>
            problem(
                409,
                "ORG_UNIT_NAME_CONFLICT",
                "a sibling unit already uses this name",
                "req-409",
            ),
        );
        const { writes, written } = setup();

        await expect(writes.createUnit({ name: "重复", parentId: null })).resolves.toBe(false);
        expect(writes.problem.value).toEqual({
            status: 409,
            code: "ORG_UNIT_NAME_CONFLICT",
            detail: "a sibling unit already uses this name",
            requestId: "req-409",
        });
        expect(written).toEqual([]);
    });

    it("搬移成环 422 ORG_UNIT_CYCLE：不本地预检，交给服务端原文（J2）", async () => {
        mockApi(() =>
            problem(
                422,
                "ORG_UNIT_CYCLE",
                "an org unit cannot become a child of itself or of its own descendant",
            ),
        );
        const { writes } = setup();

        await expect(writes.moveUnit("u-root", "u-root")).resolves.toBe(false);
        expect(writes.problem.value?.status).toBe(422);
        expect(writes.problem.value?.code).toBe("ORG_UNIT_CYCLE");
        // 请求照样发出去了：环判定是服务端的，本地树只是可见子集。
        expect(seen[0].method).toBe("PUT");
        expect(seen[0].path).toBe("/api/v1/org-units/u-root/parent");
        expect(JSON.parse(seen[0].body)).toEqual({ parentId: "u-root" });
    });
});

describe("改名：错误路径照留原文（J2）", () => {
    it("改名撞 409 ORG_UNIT_NAME_CONFLICT（PATCH 带 name）：失败且原文照留", async () => {
        mockApi(() =>
            problem(
                409,
                "ORG_UNIT_NAME_CONFLICT",
                "a sibling unit already uses this name",
                "req-rename",
            ),
        );
        const { writes, written } = setup();

        await expect(writes.renameUnit("u-root", "研发部2")).resolves.toBe(false);
        expect(seen[0].method).toBe("PATCH");
        expect(seen[0].path).toBe("/api/v1/org-units/u-root");
        expect(JSON.parse(seen[0].body)).toEqual({ name: "研发部2" });
        expect(writes.problem.value?.code).toBe("ORG_UNIT_NAME_CONFLICT");
        expect(writes.problem.value?.requestId).toBe("req-rename");
        expect(written).toEqual([]);
    });
});

describe("改名成功后重取读面", () => {
    it("成功：PATCH 返回节点即回调（不本地改 label）", async () => {
        mockApi(() => ({
            status: 200,
            body: { id: "u-root", name: "研发部2", parentId: null, depth: 0, hasChildren: true },
        }));
        const { writes, written } = setup();

        await expect(writes.renameUnit("u-root", "研发部2")).resolves.toBe(true);
        expect(written).toEqual(["rename-unit"]);
    });
});

describe("加成员：先撞 409 再确认（J3）", () => {
    it("撞确认门不算失败：摊开 409 原文计数 + 本地派生清单，且标注可派生", async () => {
        mockApi(({ method, url }) => {
            if (method === "PUT" && url.pathname.includes("/members/")) {
                return problem(
                    409,
                    ORG_UNIT_MOVE_CONFIRMATION_CODE,
                    "this move affects 11 workspace(s) owned by the subject; resend with confirmAffected=true",
                    "req-move",
                );
            }
            return {
                status: 200,
                body: [
                    { id: "w-1", name: "研发工作区", workspaceRole: "OWNER" },
                    { id: "w-2", name: "只读工作区", workspaceRole: "VIEWER" },
                ],
            };
        });
        const { writes, written } = setup();

        const verdict = await writes.requestMemberMove({
            unitId: "u-target",
            memberId: CALLER,
            memberKind: "human",
            memberName: "admin",
        });

        expect(verdict).toBe("needs-confirmation");
        expect(writes.pendingMove.value).toMatchObject({
            unitId: "u-target",
            memberId: CALLER,
            memberName: "admin",
            serverCount: 11,
            derivable: true,
            isSelf: true,
            requestId: "req-move",
        });
        // 409 原文逐字保留（J2：可以显示，但不许改写）。
        expect(writes.pendingMove.value?.detail).toContain("affects 11 workspace(s)");
        expect(writes.pendingMove.value?.derived).toEqual([{ id: "w-1", name: "研发工作区" }]);
        // 确认门不是失败：不置 problem，也不算写过。
        expect(writes.problem.value).toBeNull();
        expect(written).toEqual([]);
    });

    it("确认后原样带 confirmAffected:true 重发，成功即重取读面", async () => {
        let attempt = 0;
        mockApi(({ method, url }) => {
            if (method === "PUT" && url.pathname.includes("/members/")) {
                attempt += 1;
                if (attempt === 1) {
                    return problem(
                        409,
                        ORG_UNIT_MOVE_CONFIRMATION_CODE,
                        "this move affects 3 workspace(s) owned by the subject; resend with confirmAffected=true",
                    );
                }
                return {
                    status: 200,
                    body: {
                        memberId: CALLER,
                        fromOrgUnitId: "u-root",
                        toOrgUnitId: "u-target",
                        affectedWorkspaceIds: ["w-1"],
                        auditEvent: "org_membership_moved",
                    },
                };
            }
            return { status: 200, body: [] };
        });
        const { writes, written } = setup();

        await writes.requestMemberMove({
            unitId: "u-target",
            memberId: CALLER,
            memberKind: "human",
            memberName: "admin",
        });
        await expect(writes.confirmMemberMove()).resolves.toBe(true);

        const second = seen.filter((row) => row.method === "PUT").at(-1);
        expect(JSON.parse(second?.body ?? "{}")).toEqual({ confirmAffected: true });
        expect(writes.pendingMove.value).toBeNull();
        expect(written).toEqual(["place-member"]);
    });

    it("403 FORBIDDEN 是失败而不是确认门：原文上屏且不派生清单（不白拉一次 workspace）", async () => {
        mockApi(() =>
            problem(403, "FORBIDDEN", "org unit is outside the caller's governance scope"),
        );
        const { writes, written } = setup("someone-else");

        const verdict = await writes.requestMemberMove({
            unitId: "u-elsewhere",
            memberId: "m-bot",
            memberKind: "agent_principal",
            memberName: "codebot",
        });

        expect(verdict).toBe("failed");
        expect(writes.pendingMove.value).toBeNull();
        expect(writes.problem.value?.code).toBe("FORBIDDEN");
        expect(writes.problem.value?.detail).toBe(
            "org unit is outside the caller's governance scope",
        );
        expect(seen).toHaveLength(1);
        expect(written).toEqual([]);
    });
});

describe("移除成员：本地确认态（DELETE 没有 confirmAffected）", () => {
    it("第一步只落确认态、零请求；确认后 DELETE 带 memberKind", async () => {
        mockApi(() => ({ status: 204 }));
        const { writes, written } = setup();

        // isSelf 由调用方（面板持有 auth store）判定后传入 —— 确认框据此点名「移出自己会失读面」。
        writes.requestMemberRemoval({
            unitId: "u-root",
            memberId: CALLER,
            memberKind: "human",
            memberName: "admin",
            isSelf: true,
        });
        expect(seen).toHaveLength(0);
        expect(writes.pendingRemoval.value?.isSelf).toBe(true);

        await expect(writes.confirmMemberRemoval()).resolves.toBe(true);
        expect(seen[0].method).toBe("DELETE");
        expect(seen[0].path).toBe(
            "/api/v1/org-units/u-root/members/" + CALLER + "?memberKind=human",
        );
        expect(writes.pendingRemoval.value).toBeNull();
        expect(written).toEqual(["remove-member"]);
    });

    it("404 ORG_UNIT_NOT_FOUND：失败留原文，确认态不清（用户还看得见自己点的是谁）", async () => {
        mockApi(() => problem(404, "ORG_UNIT_NOT_FOUND", "org unit not found"));
        const { writes, written } = setup();

        writes.requestMemberRemoval({
            unitId: "u-gone",
            memberId: "m-1",
            memberKind: "human",
            memberName: "bob",
            isSelf: false,
        });
        await expect(writes.confirmMemberRemoval()).resolves.toBe(false);

        expect(writes.problem.value?.code).toBe("ORG_UNIT_NOT_FOUND");
        expect(writes.pendingRemoval.value?.memberName).toBe("bob");
        expect(written).toEqual([]);
    });
});

describe("改角色：只做逐条新增 / 单条解绑，服务端响应体就是新基线", () => {
    it("非治理角色 409 ORG_SCOPE_ROLE_FORBIDDEN：失败、原文照留、不交回基线", async () => {
        mockApi(() =>
            problem(
                409,
                "ORG_SCOPE_ROLE_FORBIDDEN",
                "role 'ADMIN' is not an org-unit governance role; atom(s) outside the whitelist: CREATE_OWN_AGENT",
            ),
        );
        const { writes, written } = setup();

        const result = await writes.replaceRoleBindings("u-root", ["ADMIN"]);
        expect(result.ok).toBe(false);
        expect(result.roleIds).toBeNull();
        expect(writes.problem.value?.code).toBe("ORG_SCOPE_ROLE_FORBIDDEN");
        expect(JSON.parse(seen[0].body)).toEqual({ presetIds: ["ADMIN"] });
        expect(written).toEqual([]);
    });

    it("成功时把响应体的 presetIds 当唯一基线交回（契约没有 GET 读面）", async () => {
        mockApi(() => ({ status: 200, body: { presetIds: [] } }));
        const { writes, written } = setup();

        await expect(writes.replaceRoleBindings("u-root", [])).resolves.toEqual({
            ok: true,
            roleIds: [],
        });
        expect(seen[0].method).toBe("PUT");
        expect(seen[0].path).toBe("/api/v1/org-units/u-root/preset-bindings");
        expect(written).toEqual(["preset-bindings"]);
    });
});

describe("busy / 非 ApiError", () => {
    it("非 ApiError 不上编 status/code：网络断就只有 message", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new Error("boom")));
        const { writes } = setup();

        await expect(writes.createUnit({ name: "x", parentId: null })).resolves.toBe(false);
        expect(writes.problem.value?.status).toBe(0);
        expect(writes.problem.value?.code).toBe("");
        expect(writes.busy.value).toBe(false);
    });
});
