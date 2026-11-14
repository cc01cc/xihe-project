import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApiPlugin } from "../api-server";
import {
    MOCK_MEMBERS_WORKSPACE_ID,
    membersOfWorkspace,
    resetWorkspaceMemberFixture,
} from "../data/workspaceMembers";

/**
 * task-38 的机器判据：**mock 车道真的有工作区成员面**，且形状/判定/错误码照 `openapi.yaml`
 * （`:548-629` 四条 path、`:6984-6986` 三个 schema），不是照页面想要的形状编。
 *
 * <p>为什么必须钉死这些：根因是「端点根本不存在」⇒ 页面拿 `API error 404`（`ApiError` 在响应体
 * 没有 `code` 时回退成这句话）。如果测试只断言「不再是 404」，下一次有人把 404 通配成 200
 * 也能过 —— 所以这里同时钉住：**未知 workspace 仍 404**（反例）、**未知 suffix 仍 404**
 * （不做通配 200 掩盖缺口）、**唯一 OWNER 降级/移除 ⇒ 409**（用户下一步就会点）。</p>
 */

interface Captured {
    status: number;
    body: unknown;
}

type ApiHandler = (req: unknown, res: unknown) => void;

function mountApiHandler(): ApiHandler {
    let handler: ApiHandler | null = null;
    const plugin = mockApiPlugin();
    const server = {
        middlewares: {
            use: (first: unknown, second?: unknown) => {
                if (first === "/api/v1" && typeof second === "function") {
                    handler = second as ApiHandler;
                }
            },
        },
    };
    (plugin as unknown as { configureServer: (s: unknown) => void }).configureServer(server);
    if (!handler) throw new Error("mock api middleware 未注册");
    return handler;
}

function call(handler: ApiHandler, url: string, method = "GET", body?: unknown): Promise<Captured> {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? [] : [JSON.stringify(body)];
        const req = Readable.from(payload);
        const reqAny = req as unknown as Record<string, unknown>;
        reqAny.method = method;
        reqAny.url = url;
        reqAny.headers = {};
        const res = {
            statusCode: 200,
            headers: {} as Record<string, string>,
            setHeader(key: string, value: string) {
                this.headers[key] = value;
            },
            end(text?: string) {
                try {
                    resolve({
                        status: (this as unknown as { statusCode: number }).statusCode,
                        body: text ? JSON.parse(text) : null,
                    });
                } catch (cause) {
                    reject(cause);
                }
            },
        };
        handler(req, res);
    });
}

const handler = mountApiHandler();
const WS = MOCK_MEMBERS_WORKSPACE_ID;
const listUrl = `/workspaces/${WS}/members`;
const rows = (body: unknown) => body as Array<Record<string, unknown>>;
const rowOf = (body: unknown, userId: string) =>
    rows(body).find((row) => row.userId === userId) ?? null;

beforeEach(() => {
    resetWorkspaceMemberFixture();
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("mock 工作区成员面：形状照契约（task-38）", () => {
    it("GET /workspaces/{id}/members 回裸数组，每行 required 字段齐全且 role 只用三态", async () => {
        const answer = await call(handler, listUrl);
        expect(answer.status).toBe(200);
        expect(Array.isArray(answer.body)).toBe(true);
        const list = rows(answer.body);
        expect(list.length).toBe(3);
        for (const row of list) {
            for (const key of ["userId", "username", "email", "name", "role", "createdAt"]) {
                expect(row, key).toHaveProperty(key);
            }
            expect(["OWNER", "EDITOR", "VIEWER"]).toContain(row.role);
            // createdAt 是 date-time（页面按它排序/显示加入时间）。
            expect(Number.isNaN(Date.parse(String(row.createdAt)))).toBe(false);
        }
        expect(list.filter((row) => row.role === "OWNER").length).toBe(1);
    });

    it("夹具工作区与产品 /workspaces 返回的是同一个 id（不是第二套 id）", async () => {
        const answer = await call(handler, "/workspaces");
        expect(answer.status).toBe(200);
        const workspace = rows(answer.body)[0];
        expect(workspace.id).toBe(MOCK_MEMBERS_WORKSPACE_ID);
    });
});

describe("写操作：真改夹具，且错误码照契约", () => {
    it("POST 已知非成员账号 ⇒ 201 且随后出现在列表里", async () => {
        const created = await call(handler, listUrl, "POST", {
            username: "zhouye",
            role: "EDITOR",
        });
        expect(created.status).toBe(201);
        const row = created.body as Record<string, unknown>;
        expect(row.username).toBe("zhouye");
        expect(row.role).toBe("EDITOR");
        expect(row.userId).toBe("u-zhouye");

        const after = await call(handler, listUrl);
        expect(rowOf(after.body, "u-zhouye")).not.toBeNull();
        expect(rows(after.body).length).toBe(4);
    });

    it("POST 未注册的 username ⇒ 404 USER_NOT_FOUND（页面文案「该用户不存在，请对方先注册」）", async () => {
        const answer = await call(handler, listUrl, "POST", { username: "nobody", role: "EDITOR" });
        expect(answer.status).toBe(404);
        expect((answer.body as { code: string }).code).toBe("USER_NOT_FOUND");
    });

    it("POST 重复添加已有成员 ⇒ 409 MEMBER_ALREADY_EXISTS", async () => {
        const answer = await call(handler, listUrl, "POST", { username: "alan", role: "VIEWER" });
        expect(answer.status).toBe(409);
        expect((answer.body as { code: string }).code).toBe("MEMBER_ALREADY_EXISTS");
    });

    it("POST 非法名字文法 ⇒ 400 INVALID_NAME_FORMAT；role 不在 EDITOR|VIEWER ⇒ 400 INVALID_REQUEST", async () => {
        const badName = await call(handler, listUrl, "POST", {
            username: "1.ab c",
            role: "EDITOR",
        });
        expect(badName.status).toBe(400);
        expect((badName.body as { code: string }).code).toBe("INVALID_NAME_FORMAT");

        const badRole = await call(handler, listUrl, "POST", { username: "lina", role: "OWNER" });
        expect(badRole.status).toBe(400);
        expect((badRole.body as { code: string }).code).toBe("INVALID_REQUEST");

        const missing = await call(handler, listUrl, "POST", { role: "EDITOR" });
        expect(missing.status).toBe(400);
    });

    it("PATCH 改角色 ⇒ 200 且列表反映新角色", async () => {
        const answer = await call(handler, `${listUrl}/u-alan`, "PATCH", { role: "VIEWER" });
        expect(answer.status).toBe(200);
        expect((answer.body as { role: string }).role).toBe("VIEWER");
        const after = await call(handler, listUrl);
        expect(rowOf(after.body, "u-alan")?.role).toBe("VIEWER");
    });

    it("PATCH/DELETE 唯一 OWNER ⇒ 409 LAST_OWNER（用户下一步就会点自己降级/移除）", async () => {
        const downgrade = await call(handler, `${listUrl}/mock-user`, "PATCH", { role: "EDITOR" });
        expect(downgrade.status).toBe(409);
        expect((downgrade.body as { code: string }).code).toBe("LAST_OWNER");

        const remove = await call(handler, `${listUrl}/mock-user`, "DELETE");
        expect(remove.status).toBe(409);
        expect((remove.body as { code: string }).code).toBe("LAST_OWNER");
    });

    it("PATCH/DELETE 非成员 id ⇒ 404 MEMBER_NOT_FOUND", async () => {
        const patch = await call(handler, `${listUrl}/u-ghost`, "PATCH", { role: "VIEWER" });
        expect(patch.status).toBe(404);
        expect((patch.body as { code: string }).code).toBe("MEMBER_NOT_FOUND");

        const remove = await call(handler, `${listUrl}/u-ghost`, "DELETE");
        expect(remove.status).toBe(404);
        expect((remove.body as { code: string }).code).toBe("MEMBER_NOT_FOUND");
    });

    it("DELETE 普通成员 ⇒ 204 无体，且列表少一行", async () => {
        const answer = await call(handler, `${listUrl}/u-guyuan`, "DELETE");
        expect(answer.status).toBe(204);
        expect(answer.body).toBeNull();
        const after = await call(handler, listUrl);
        expect(rows(after.body).length).toBe(2);
        expect(rowOf(after.body, "u-guyuan")).toBeNull();
    });
});

describe("反例：不许把 404 通配成 200", () => {
    const ghost = "00000000-0000-4000-8000-000000000000";

    it("不存在的 workspace id ⇒ GET/POST/PATCH/DELETE 全 404 WORKSPACE_NOT_FOUND", async () => {
        const url = `/workspaces/${ghost}/members`;
        const cases = [
            await call(handler, url),
            await call(handler, url, "POST", { username: "lina", role: "EDITOR" }),
            await call(handler, `${url}/u-alan`, "PATCH", { role: "VIEWER" }),
            await call(handler, `${url}/u-alan`, "DELETE"),
        ];
        for (const answer of cases) {
            expect(answer.status).toBe(404);
            expect((answer.body as { code: string }).code).toBe("WORKSPACE_NOT_FOUND");
        }
    });

    it("已实现端点之外的 suffix ⇒ 404 MOCK_ENDPOINT_MISSING（不做通配 200）", async () => {
        const answer = await call(handler, `${listUrl}/u-alan/roles`);
        expect(answer.status).toBe(404);
        expect((answer.body as { code: string }).code).toBe("MOCK_ENDPOINT_MISSING");
    });

    it("XIHE_UI_MOCK_MEMBER_VIEWER=1 ⇒ 非 OWNER：读也 403 WORKSPACE_FORBIDDEN（PLAN-0565 裁定 #2）", async () => {
        vi.stubEnv("XIHE_UI_MOCK_MEMBER_VIEWER", "1");
        const read = await call(handler, listUrl);
        expect(read.status).toBe(403);
        expect((read.body as { code: string }).code).toBe("WORKSPACE_FORBIDDEN");

        const write = await call(handler, listUrl, "POST", { username: "lina", role: "EDITOR" });
        expect(write.status).toBe(403);
    });
});

describe("夹具纯函数", () => {
    it("membersOfWorkspace 对未知 id 回 null（调用方据此 404），已知 id 回副本", () => {
        expect(membersOfWorkspace("00000000-0000-4000-8000-000000000000")).toBeNull();
        const first = membersOfWorkspace(MOCK_MEMBERS_WORKSPACE_ID)!;
        first[0].role = "VIEWER";
        expect(membersOfWorkspace(MOCK_MEMBERS_WORKSPACE_ID)![0].role).toBe("OWNER");
    });
});
