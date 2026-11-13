import { Readable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { mockApiPlugin } from "../api-server";
import {
    MOCK_AGENT_WORKSPACE_ID,
    MOCK_AGENT_PRINCIPAL_IDS,
    agentMemoriesOf,
    agentRoleBindingsOf,
    resetWorkspaceAgentFixture,
    workspaceAgentsOfWorkspace,
} from "../data/workspaceAgents";
import {
    DENIED_PERMISSION_ATOMS,
    PREVIEW_PERMISSION_ATOMS,
    PREVIEW_WORKSPACE_ATOMS,
    mockPermissionProjection,
} from "../data/previewPermissions";

/**
 * task-449 / D-1287（D-1281 同形）的机器判据：**夹具真的被路由消费**，且形状与判定照 CP。
 *
 * <p>两条判据缺一不可：①「造了数据没人用」—— 每个导出夹具都必须能从至少一条路由拿到；
 * ②「用了但形状/判定是发明的」—— 信封、required 字段、capSource 四态、PUT 空体=baseline、
 * 未知 suffix 仍 404 逐条钉。task-417 的浏览器证据依赖这里的四态样本真的存在。</p>
 */

interface Captured {
    status: number;
    body: unknown;
}

type ApiHandler = (req: unknown, res: unknown) => void;

/** 与 sessions.coverage.spec.ts 同口径：直接拿 vite 插件注册的中间件打真实 HTTP 面。 */
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
const WS = MOCK_AGENT_WORKSPACE_ID;
const agentsUrl = `/workspaces/${WS}/agents`;
const rows = (body: unknown) => (body as { agents: Array<Record<string, unknown>> }).agents;
const rowOf = (body: unknown, pid: string) => rows(body).find((row) => row.principalId === pid)!;

beforeEach(() => {
    resetWorkspaceAgentFixture();
});

describe("mock 工作区智能体夹具被路由消费（task-449）", () => {
    it("GET /workspaces/{id}/agents 回六行（不是空集），required 字段齐全", async () => {
        const answer = await call(handler, agentsUrl);
        expect(answer.status).toBe(200);
        expect(rows(answer.body)).toEqual(workspaceAgentsOfWorkspace(WS));
        expect(rows(answer.body).length).toBe(6);
        for (const row of rows(answer.body)) {
            for (const key of [
                "principalId",
                "name",
                "templateId",
                "templateName",
                "createdAt",
                "permissionsSnapshot",
                "bound",
                "disabled",
                "roleIds",
                "hooks",
                "contextPolicy",
            ]) {
                expect(row, key).toHaveProperty(key);
            }
            // hooks 是对象文档不是数组（PLAN-0625 Gap I）。
            expect(Array.isArray(row.hooks)).toBe(false);
        }
    });

    it("capSource 四态齐全：explicit 非空 / explicit 空 / baseline 空 / 缺省（417 的判据前提）", async () => {
        const { body } = await call(handler, agentsUrl);
        const explicit = rowOf(body, MOCK_AGENT_PRINCIPAL_IDS.explicit);
        const zero = rowOf(body, MOCK_AGENT_PRINCIPAL_IDS.zero);
        const inherit = rowOf(body, MOCK_AGENT_PRINCIPAL_IDS.inherit);
        const legacy = rowOf(body, MOCK_AGENT_PRINCIPAL_IDS.legacy);
        expect(explicit.capSource).toBe("explicit");
        expect((explicit.permissionsSnapshot as unknown[]).length).toBeGreaterThan(0);
        expect(zero.capSource).toBe("explicit");
        expect(zero.permissionsSnapshot).toEqual([]);
        expect(inherit.capSource).toBe("baseline");
        expect(inherit.permissionsSnapshot).toEqual([]);
        // 旧响应：**没有这个字段**（不是 null）—— UI 不得据此编造来源。
        expect(legacy).not.toHaveProperty("capSource");
        expect(rowOf(body, MOCK_AGENT_PRINCIPAL_IDS.disabled).disabled).toBe(true);
        expect(rowOf(body, MOCK_AGENT_PRINCIPAL_IDS.unbound).bound).toBe(false);
    });

    it("PUT 空体 ⇒ baseline；传 [] ⇒ explicit 零权限；传数组 ⇒ explicit（D-1109 三态）", async () => {
        const pid = MOCK_AGENT_PRINCIPAL_IDS.explicit;
        const url = `${agentsUrl}/${pid}`;
        const inherit = await call(handler, url, "PUT", {});
        expect(inherit.status).toBe(200);
        expect((inherit.body as { capSource: string }).capSource).toBe("baseline");
        expect(rowOf((await call(handler, agentsUrl)).body, pid).capSource).toBe("baseline");

        const zero = await call(handler, url, "PUT", { permissions: [] });
        expect((zero.body as { capSource: string }).capSource).toBe("explicit");
        expect((zero.body as { permissions: unknown[] }).permissions).toEqual([]);

        const atom = { actionClass: "file_read", resource: "workspace" };
        const explicit = await call(handler, url, "PUT", { permissions: [atom] });
        expect((explicit.body as { capSource: string }).capSource).toBe("explicit");
        expect((explicit.body as { permissions: unknown[] }).permissions).toEqual([atom]);
        expect(rowOf((await call(handler, agentsUrl)).body, pid).permissionsSnapshot).toEqual([
            atom,
        ]);
    });

    it("PUT 多余键 / 非数组 permissions ⇒ 400 INVALID_REQUEST；未知主体 ⇒ 404（不通配成功）", async () => {
        const pid = MOCK_AGENT_PRINCIPAL_IDS.zero;
        const extra = await call(handler, `${agentsUrl}/${pid}`, "PUT", {
            permissions: [],
            bogus: 1,
        });
        expect(extra.status).toBe(400);
        expect((extra.body as { code: string }).code).toBe("INVALID_REQUEST");
        const notArray = await call(handler, `${agentsUrl}/${pid}`, "PUT", { permissions: "x" });
        expect(notArray.status).toBe(400);
        const unknown = await call(handler, `${agentsUrl}/no-such-principal`, "PUT", {});
        expect(unknown.status).toBe(404);
        expect((unknown.body as { code: string }).code).toBe("WORKSPACE_AGENT_NOT_FOUND");
    });

    it("记忆信封 {memories}：默认只给 active，?status=all 含归档；写三面可用", async () => {
        const pid = MOCK_AGENT_PRINCIPAL_IDS.explicit;
        const url = `${agentsUrl}/${pid}/memories`;
        const active = await call(handler, url);
        expect(active.status).toBe(200);
        const list = (active.body as { memories: Array<Record<string, unknown>> }).memories;
        expect(list).toEqual(agentMemoriesOf(pid, "active"));
        expect(list.length).toBeGreaterThan(0);
        const all = await call(handler, `${url}?status=all`);
        expect((all.body as { memories: unknown[] }).memories.length).toBeGreaterThan(list.length);

        const created = await call(handler, url, "POST", { content: "新记忆", pinned: true });
        expect(created.status).toBe(201);
        const id = (created.body as { id: string }).id;
        expect((await call(handler, url)).body).toMatchObject({
            memories: expect.arrayContaining([expect.objectContaining({ id, pinned: true })]),
        });
        const patched = await call(handler, `${url}/${id}`, "PATCH", { pinned: false });
        expect(patched.status).toBe(200);
        const removed = await call(handler, `${url}/${id}`, "DELETE");
        expect(removed.status).toBe(204);
        // 归档软删：active 列表不再有它，all 里还在。
        expect(
            ((await call(handler, url)).body as { memories: Array<{ id: string }> }).memories.some(
                (row) => row.id === id,
            ),
        ).toBe(false);
        expect(
            (
                (await call(handler, `${url}?status=all`)).body as {
                    memories: Array<{ id: string }>;
                }
            ).memories.some((row) => row.id === id),
        ).toBe(true);
    });

    it("角色绑定信封 {bindings} + /roles 裸数组；种子绑定解绑 ⇒ 409（CP 兜底语义）", async () => {
        const pid = MOCK_AGENT_PRINCIPAL_IDS.explicit;
        const url = `/agent-principals/${pid}/roles?workspaceId=${WS}&locale=zh-CN`;
        const answer = await call(handler, url);
        expect(answer.status).toBe(200);
        expect((answer.body as { bindings: unknown[] }).bindings).toEqual(agentRoleBindingsOf(pid));
        const catalog = await call(handler, "/roles");
        expect(catalog.status).toBe(200);
        expect(Array.isArray(catalog.body)).toBe(true);
        const system = (
            answer.body as { bindings: Array<{ bindingId: string; isSystem: boolean }> }
        ).bindings.find((row) => row.isSystem)!;
        const denied = await call(
            handler,
            `/agent-principals/${pid}/roles/${system.bindingId}`,
            "DELETE",
        );
        expect(denied.status).toBe(409);
        expect((denied.body as { code: string }).code).toBe("ROLE_BINDING_IMMUTABLE");
    });

    it("未知 suffix 仍 404 MOCK_ENDPOINT_MISSING（不做通配 200 掩盖缺口）", async () => {
        const answer = await call(handler, `${agentsUrl}/${MOCK_AGENT_PRINCIPAL_IDS.zero}/bogus`);
        expect(answer.status).toBe(404);
        expect((answer.body as { code: string }).code).toBe("MOCK_ENDPOINT_MISSING");
    });

    it("DELETE 解绑后列表少一行；未知工作区仍是空集（不拿别层数据冒充）", async () => {
        const pid = MOCK_AGENT_PRINCIPAL_IDS.unbound;
        const removed = await call(handler, `${agentsUrl}/${pid}`, "DELETE");
        expect(removed.status).toBe(204);
        expect(rows((await call(handler, agentsUrl)).body).length).toBe(5);
        const other = await call(handler, "/workspaces/no-such-workspace/agents");
        expect(other.status).toBe(200);
        expect(rows(other.body)).toEqual([]);
    });
});

/**
 * 第 14 条缺口（浏览器实测照出来的，不是代码地图上数出来的）：写面判据要的工作区档原子
 * 此前根本不在投影里 ⇒ 「修改上限」按钮恒禁用 ⇒ 417 的写回环无法取证。
 */
describe("mock 权限投影的工作区档授予（task-449 浏览器实测补缺）", () => {
    it("GET /me/permissions 带 workspaces[]，MANAGE_WORKSPACE_AGENTS 在册且 resource 是具体工作区", async () => {
        const answer = await call(handler, "/me/permissions");
        expect(answer.status).toBe(200);
        const body = answer.body as {
            workspaces: Array<{
                workspaceId: string;
                workspaceRole: string;
                workspaceAdmin: boolean;
                permissions: Array<{ actionClass: string; resource: string }>;
            }>;
        };
        expect(Array.isArray(body.workspaces)).toBe(true);
        const ws = body.workspaces.find((row) => row.workspaceId === WS)!;
        expect(ws.workspaceRole).toBe("WS_OWNER");
        expect(ws.permissions.map((atom) => atom.actionClass)).toEqual([
            "MANAGE_WORKSPACE_AGENTS",
            "MEMORY_WRITE",
        ]);
        // 禁 `*`：工作区档原子必须钉具体工作区（否则等于把实例管理员的覆盖语义混进来）。
        for (const atom of ws.permissions) expect(atom.resource).toBe(WS);
    });

    it("实例档仍全为 `*`，两份清单不混（工作区原子不许塞进实例档）", () => {
        for (const atom of PREVIEW_PERMISSION_ATOMS) expect(atom.resource).toBe("*");
        for (const atom of PREVIEW_WORKSPACE_ATOMS) {
            expect(atom.resource).toBe(WS);
            expect(PREVIEW_PERMISSION_ATOMS.map((row) => row.actionClass)).not.toContain(
                atom.actionClass,
            );
        }
    });

    it("受限形态只扣 credential_manage，工作区档不被顺手扣掉（不造 CP 里没有的组合态）", () => {
        const granted = mockPermissionProjection({
            capabilities: ["isInstanceAdmin"],
            denied: false,
        });
        const denied = mockPermissionProjection({
            capabilities: ["isInstanceAdmin"],
            denied: true,
        });
        expect(denied.instancePermissions).toHaveLength(
            PREVIEW_PERMISSION_ATOMS.length - DENIED_PERMISSION_ATOMS.length,
        );
        expect(denied.workspaces).toEqual(granted.workspaces);
    });
});

/**
 * task-469（417 P1-6）：**live 生效权限读面**的 mock 判据。核心不是「有这条路由」，而是
 * **它真的按 live 语义求值**：与快照分得开（两个方向都有样本）、命中来源两态、显式零权限仍是零、
 * 未知 suffix 仍 404（不通配 200 掩盖缺口，D-1248）。契约 `EffectiveCapView`（openapi:6994）7 required。
 */
describe("mock live effective-cap 读面（task-469）", () => {
    const capUrl = (pid: string) => `/workspaces/${WS}/agents/${pid}/effective-cap`;
    const viewOf = async (pid: string) => {
        const answer = await call(handler, capUrl(pid));
        expect(answer.status).toBe(200);
        return answer.body as Record<string, unknown>;
    };
    const FILE_READ = { actionClass: "file_read", resource: "workspace" };
    const FILE_WRITE = { actionClass: "file_write", resource: "workspace" };
    const TOOL_EXECUTE = { actionClass: "tool_execute", resource: "workspace" };
    const EDITOR_CEILING = [FILE_READ, FILE_WRITE, TOOL_EXECUTE];

    it("六行都能读到 live 面，7 个 required 字段齐全且类型对", async () => {
        for (const pid of Object.values(MOCK_AGENT_PRINCIPAL_IDS)) {
            const view = await viewOf(pid);
            expect(Object.keys(view).sort()).toEqual(
                [
                    "bound",
                    "capSource",
                    "defaultGrants",
                    "effectiveCap",
                    "principalId",
                    "provenance",
                    "workspaceId",
                ].sort(),
            );
            expect(view.principalId).toBe(pid);
            expect(view.workspaceId).toBe(WS);
            expect(Array.isArray(view.effectiveCap)).toBe(true);
            expect(typeof view.bound).toBe("boolean");
            expect(["binding-snapshot", "role-binding"]).toContain(
                (view.capSource as { binding: string }).binding,
            );
            const provenance = view.provenance as Record<string, unknown>;
            expect(Array.isArray(provenance.principalGrantIds)).toBe(true);
            expect(Array.isArray(provenance.bindingGrantIds)).toBe(true);
            expect(Array.isArray((view.defaultGrants as { readFace: unknown }).readFace)).toBe(
                true,
            );
        }
    });

    it("binding-snapshot：绑定原子保留到主体生效上限 ⇒ live 比快照少一条（不是快照副本）", async () => {
        const pid = MOCK_AGENT_PRINCIPAL_IDS.explicit;
        const view = await viewOf(pid);
        expect(view.capSource).toEqual({ binding: "binding-snapshot" });
        expect(view.bound).toBe(true);
        // 快照三条（含 credential_use），live 只剩天花板内的两条 —— **精确相等**，不用包含判据。
        expect(view.effectiveCap).toEqual([FILE_READ, FILE_WRITE]);
        const snapshot = rowOf(await call(handler, agentsUrl).then((a) => a.body), pid)
            .permissionsSnapshot as unknown[];
        expect(snapshot).toHaveLength(3);
        expect(view.effectiveCap).not.toEqual(snapshot);
        // binding-snapshot 情形 bindingGrantIds 为空（契约原文）。
        expect((view.provenance as { bindingGrantIds: unknown[] }).bindingGrantIds).toEqual([]);
    });

    it("role-binding：继承态快照是空数组而 live 是角色天花板 ⇒ 另一个方向的 live ≠ snapshot", async () => {
        const pid = MOCK_AGENT_PRINCIPAL_IDS.inherit;
        const view = await viewOf(pid);
        expect(view.capSource).toEqual({ binding: "role-binding" });
        expect(view.bound).toBe(false);
        expect(view.effectiveCap).toEqual(EDITOR_CEILING);
        const snapshot = rowOf(await call(handler, agentsUrl).then((a) => a.body), pid)
            .permissionsSnapshot as unknown[];
        expect(snapshot).toEqual([]);
        // 命中来源的 grant 行 id = 该主体的角色绑定行（不是编的常量）。
        expect((view.provenance as { bindingGrantIds: unknown[] }).bindingGrantIds).toEqual(
            agentRoleBindingsOf(pid).map((binding) => binding.bindingId),
        );
    });

    it("显式零权限仍是零（不回落角色天花板）——[] 不是「用基线」（D-1109）", async () => {
        const view = await viewOf(MOCK_AGENT_PRINCIPAL_IDS.zero);
        expect(view.capSource).toEqual({ binding: "binding-snapshot" });
        expect(view.effectiveCap).toEqual([]);
        expect(view.bound).toBe(true);
    });

    it("未绑定行：role-binding + 空天花板 + bound=false，空态不伪装成有权限", async () => {
        const view = await viewOf(MOCK_AGENT_PRINCIPAL_IDS.unbound);
        expect(view.capSource).toEqual({ binding: "role-binding" });
        expect(view.effectiveCap).toEqual([]);
        expect(view.bound).toBe(false);
        expect((view.provenance as { bindingGrantIds: unknown[] }).bindingGrantIds).toEqual([]);
    });

    it("effectiveCap 已排序（契约：byte-identical to the internal cap and sorted）", async () => {
        for (const pid of Object.values(MOCK_AGENT_PRINCIPAL_IDS)) {
            const view = await viewOf(pid);
            const keys = (
                view.effectiveCap as Array<{ actionClass: string; resource?: string }>
            ).map((atom) => `${atom.actionClass}:${atom.resource ?? "*"}`);
            expect(keys).toEqual([...keys].sort());
        }
    });

    it("未知 suffix / 未知主体 / 别的工作区一律 404，不用通配 200 掩盖缺口", async () => {
        const pid = MOCK_AGENT_PRINCIPAL_IDS.explicit;
        const unknownSuffix = await call(handler, `${capUrl(pid)}-nope`);
        expect(unknownSuffix.status).toBe(404);
        expect((unknownSuffix.body as { code: string }).code).toBe("MOCK_ENDPOINT_MISSING");
        const unknownPrincipal = await call(
            handler,
            capUrl("00000000-0000-4000-8000-000000000000"),
        );
        expect(unknownPrincipal.status).toBe(404);
        expect((unknownPrincipal.body as { code: string }).code).toBe("WORKSPACE_AGENT_NOT_FOUND");
        const otherWorkspace = await call(
            handler,
            `/workspaces/not-the-mock-ws/agents/${pid}/effective-cap`,
        );
        expect(otherWorkspace.status).toBe(404);
    });

    it("mock 边界留痕：天花板权威是角色绑定行，不是 row.roleIds 那个显示字段", async () => {
        // disabled / legacy 两行**没有角色绑定行**（种子里只有 explicit/zero/inherit 三条）
        // ⇒ 天花板为空 ⇒ live 为空，即使 row.roleIds 写着 EDITOR。这是 mock 的既有数据形态，
        // **本批不改夹具数据去凑判据**（D-1319）；真值在 CP 的角色绑定，mock 只近似到绑定行这一层。
        for (const pid of [MOCK_AGENT_PRINCIPAL_IDS.disabled, MOCK_AGENT_PRINCIPAL_IDS.legacy]) {
            expect(agentRoleBindingsOf(pid)).toEqual([]);
            const view = await viewOf(pid);
            expect(view.effectiveCap).toEqual([]);
            expect(view.capSource).toEqual({
                binding:
                    pid === MOCK_AGENT_PRINCIPAL_IDS.disabled ? "binding-snapshot" : "role-binding",
            });
        }
    });
});
