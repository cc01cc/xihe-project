import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentBindings, MANAGE_AGENTS_ATOM } from "../useAgentBindings";

/**
 * task-153 S1：绑定读面 / 写面的判据单测。
 *
 * <p>只要两条硬结论：① 能不能管按原子判（实例行 ∪ 该工作区行）；② 读不到不等于没绑。
 * 另外钉住 J5 —— 写成功后必须**重取读面**，不许把写入的结果直接塞进本地状态。</p>
 */

interface Seen {
    method: string;
    path: string;
    body: string;
}

type Reply = { status: number; body: unknown };

let calls: Seen[] = [];

function mockApi(handler: (seen: Seen & { url: URL }) => Reply) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const raw =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(raw, "http://127.0.0.1");
        const seen: Seen = {
            method: (init?.method ?? "GET").toUpperCase(),
            path: url.pathname,
            body: typeof init?.body === "string" ? init.body : "",
        };
        calls.push(seen);
        const reply = handler({ ...seen, url });
        return new Response(JSON.stringify(reply.body), {
            status: reply.status,
            headers: { "content-type": "application/json" },
        });
    });
}

function permissionView(options: {
    instanceAtoms?: string[];
    workspaceAtoms?: Record<string, string[]>;
}) {
    return {
        userId: "u-1",
        instanceCapabilities: [],
        instancePermissions: (options.instanceAtoms ?? []).map((actionClass) => ({
            actionClass,
            resource: "*",
        })),
        workspaces: Object.entries(options.workspaceAtoms ?? {}).map(([workspaceId, atoms]) => ({
            workspaceId,
            permissions: atoms.map((actionClass) => ({ actionClass, resource: "*" })),
        })),
    };
}

const WORKSPACES = [
    { id: "w-1", name: "研发工作区", workspaceRole: "OWNER" },
    { id: "w-2", name: "运维工作区", workspaceRole: "OWNER" },
];

beforeEach(() => {
    calls = [];
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("useAgentBindings（task-153 S1）", () => {
    it("能力投影失败 ⇒ fail-closed：canManage 是 null（不说你没权限），且一个写请求都不发", async () => {
        mockApi(() => ({ status: 500, body: { code: "INTERNAL", detail: "boom" } }));
        const bindings = useAgentBindings({ principalId: () => "p-1" });
        await bindings.load();

        expect(bindings.capabilityState.value).toBe("failed");
        expect(bindings.canManage.value).toBeNull();
        expect(bindings.manageableWorkspaces.value).toEqual([]);

        const sent = await bindings.setBound("w-1", true);
        expect(sent).toBe(false);
        // 只发生了那一次能力投影（GET），没有任何写请求。
        expect(calls.map((call) => call.method)).toEqual(["GET"]);
        expect(calls.some((call) => call.method !== "GET")).toBe(false);
    });

    it("没有 MANAGE_WORKSPACE_AGENTS 原子 ⇒ 候选为空、canManage false、零请求（不自造 403）", async () => {
        mockApi((seen) => {
            if (seen.path === "/api/v1/me/permissions") {
                return { status: 200, body: permissionView({ instanceAtoms: ["VIEW_WORKSPACE"] }) };
            }
            return { status: 200, body: WORKSPACES };
        });
        const bindings = useAgentBindings({ principalId: () => "p-1" });
        await bindings.load();

        expect(bindings.capabilityState.value).toBe("ready");
        expect(bindings.canManage.value).toBe(false);
        expect(bindings.manageableWorkspaces.value).toEqual([]);
        expect(bindings.bindingViews.value).toEqual([]);

        const sent = await bindings.setBound("w-1", true);
        expect(sent).toBe(false);
        expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
    });

    it("实例级原子 ⇒ 每个工作区都能管；已绑行带 isDefault/capSource，未绑行为 false", async () => {
        mockApi((seen) => {
            if (seen.path === "/api/v1/me/permissions") {
                return {
                    status: 200,
                    body: permissionView({ instanceAtoms: [MANAGE_AGENTS_ATOM] }),
                };
            }
            if (seen.path === "/api/v1/workspaces") return { status: 200, body: WORKSPACES };
            if (seen.path === "/api/v1/workspaces/w-1/agents") {
                return {
                    status: 200,
                    body: {
                        agents: [
                            {
                                principalId: "p-1",
                                name: "ResearchAgent",
                                bound: true,
                                isDefault: true,
                                capSource: "explicit",
                            },
                            { principalId: "p-2", name: "Other", bound: true, isDefault: false },
                        ],
                    },
                };
            }
            return { status: 200, body: { agents: [] } };
        });
        const bindings = useAgentBindings({ principalId: () => "p-1" });
        await bindings.load();

        expect(bindings.manageableWorkspaces.value.map((workspace) => workspace.id)).toEqual([
            "w-1",
            "w-2",
        ]);
        expect(bindings.bindingViews.value).toEqual([
            {
                workspaceId: "w-1",
                workspaceName: "研发工作区",
                bound: true,
                isDefault: true,
                capSource: "explicit",
            },
            {
                workspaceId: "w-2",
                workspaceName: "运维工作区",
                bound: false,
                isDefault: false,
                capSource: null,
            },
        ]);
        expect(bindings.unreadableWorkspaces.value).toEqual([]);
    });

    // 锚点（Lead 要在卡面验收里引这一条）：null ≠ 未绑定，见 task-153 裁定。
    it("某个工作区读面失败 ⇒ 那一行 bound 是 null 并登记 unreadable，绝不降级成「未绑定」", async () => {
        mockApi((seen) => {
            if (seen.path === "/api/v1/me/permissions") {
                return {
                    status: 200,
                    body: permissionView({ instanceAtoms: [MANAGE_AGENTS_ATOM] }),
                };
            }
            if (seen.path === "/api/v1/workspaces") return { status: 200, body: WORKSPACES };
            if (seen.path === "/api/v1/workspaces/w-2/agents") {
                return { status: 403, body: { code: "WORKSPACE_FORBIDDEN", detail: "no" } };
            }
            return { status: 200, body: { agents: [] } };
        });
        const bindings = useAgentBindings({ principalId: () => "p-1" });
        await bindings.load();

        const second = bindings.bindingViews.value.find((row) => row.workspaceId === "w-2");
        expect(second?.bound).toBeNull();
        expect(bindings.unreadableWorkspaces.value).toEqual(["w-2"]);
    });

    it("绑定两个工作区 ⇒ 各一次 PUT 且写后重取读面（不是本地插入）", async () => {
        const bound = new Set<string>();
        mockApi((seen) => {
            if (seen.path === "/api/v1/me/permissions") {
                return {
                    status: 200,
                    body: permissionView({ instanceAtoms: [MANAGE_AGENTS_ATOM] }),
                };
            }
            if (seen.path === "/api/v1/workspaces") return { status: 200, body: WORKSPACES };
            if (seen.method === "PUT") {
                bound.add(seen.path.split("/")[4]);
                return {
                    status: 200,
                    body: {
                        principalId: "p-1",
                        workspaceId: seen.path.split("/")[4],
                        permissions: [],
                        capSource: "explicit",
                    },
                };
            }
            const workspaceId = seen.path.split("/")[4];
            return {
                status: 200,
                body: {
                    agents: bound.has(workspaceId)
                        ? [
                              {
                                  principalId: "p-1",
                                  name: "ResearchAgent",
                                  bound: true,
                                  isDefault: false,
                                  capSource: "explicit",
                              },
                          ]
                        : [],
                },
            };
        });
        const bindings = useAgentBindings({ principalId: () => "p-1" });
        await bindings.load();
        expect(bindings.bindingViews.value.every((row) => row.bound === false)).toBe(true);

        const before = calls.length;
        expect(await bindings.setBound("w-1", true)).toBe(true);
        expect(await bindings.setBound("w-2", true)).toBe(true);

        const writes = calls.slice(before).filter((call) => call.method === "PUT");
        expect(writes.map((call) => call.path)).toEqual([
            "/api/v1/workspaces/w-1/agents/p-1",
            "/api/v1/workspaces/w-2/agents/p-1",
        ]);
        expect(writes[0]?.body).toBe(JSON.stringify({ permissions: [] }));
        // J5：两次绑定后各自重取了一次读面（共 2 次 GET /agents），标记来自 CP 回包。
        // 只数 `/agents` 读面：S2 起角色读面也是 GET，混在一起数会让这条正交断言的分子漂移。
        const rereads = calls
            .slice(before)
            .filter((call) => call.method === "GET" && call.path.endsWith("/agents"));
        expect(rereads.length).toBe(4);
        expect(bindings.bindingViews.value.map((row) => row.bound)).toEqual([true, true]);
    });

    it("解绑走 DELETE，失败保留原始 cause 供 presentCauseError 转文案，且不动读面状态", async () => {
        mockApi((seen) => {
            if (seen.path === "/api/v1/me/permissions") {
                return {
                    status: 200,
                    body: permissionView({ instanceAtoms: [MANAGE_AGENTS_ATOM] }),
                };
            }
            if (seen.path === "/api/v1/workspaces") return { status: 200, body: WORKSPACES };
            if (seen.method === "DELETE") {
                return { status: 404, body: { code: "AGENT_PRINCIPAL_NOT_FOUND", detail: "gone" } };
            }
            return { status: 200, body: { agents: [] } };
        });
        const bindings = useAgentBindings({ principalId: () => "p-1" });
        await bindings.load();

        expect(await bindings.setBound("w-1", false)).toBe(false);
        expect(calls.some((call) => call.method === "DELETE")).toBe(true);
        const cause = bindings.lastCause.value as { problem?: { code?: string } } | null;
        expect(cause?.problem?.code).toBe("AGENT_PRINCIPAL_NOT_FOUND");
        expect(bindings.isBusy("w-1")).toBe(false);

        bindings.clearCause();
        expect(bindings.lastCause.value).toBeNull();
    });
});

describe("useAgentBindings（task-153 S2 角色读面 + 默认开关）", () => {
    const THREE = [
        { id: "w-1", name: "研发工作区", workspaceRole: "OWNER" },
        { id: "w-2", name: "运维工作区", workspaceRole: "OWNER" },
        { id: "w-3", name: "验收工作区", workspaceRole: "OWNER" },
    ];

    function rolesReply(rows: Array<{ bindingId: string; roleId: string; name: string }>) {
        return { status: 200, body: { items: rows } };
    }

    it("已绑行读角色、未绑行不发角色请求；设为默认 ⇒ 1 次 PUT + 按工作区数重取读面（正交断言）", async () => {
        mockApi((seen) => {
            if (seen.path === "/api/v1/me/permissions") {
                return {
                    status: 200,
                    body: permissionView({ instanceAtoms: [MANAGE_AGENTS_ATOM] }),
                };
            }
            if (seen.path === "/api/v1/workspaces") return { status: 200, body: WORKSPACES };
            if (seen.path === "/api/v1/agent-principals/p-1/roles") {
                return rolesReply([
                    { bindingId: "b-1", roleId: "r-1", name: "OrgAdmin" },
                    { bindingId: "b-2", roleId: "r-2", name: "Auditor" },
                ]);
            }
            if (seen.path === "/api/v1/workspaces/w-1/agents") {
                return {
                    status: 200,
                    body: {
                        agents: [
                            {
                                principalId: "p-1",
                                name: "ResearchAgent",
                                bound: true,
                                isDefault: false,
                                capSource: "baseline",
                            },
                        ],
                    },
                };
            }
            return { status: 200, body: { agents: [] } };
        });
        const bindings = useAgentBindings({ principalId: () => "p-1" });
        await bindings.load();

        // 已绑行：四态里的 ready + 两行角色，只认服务端返回的名字。
        expect(bindings.rolesFor("w-1").state).toBe("ready");
        expect(bindings.rolesFor("w-1").roles.map((role) => role.name)).toEqual([
            "OrgAdmin",
            "Auditor",
        ]);
        // 未绑行：idle 且**没有**为它发角色请求（省掉注定 404 的 N 次读）。
        expect(bindings.rolesFor("w-2").state).toBe("idle");
        const rolePaths = calls.filter((call) => call.path.endsWith("/roles"));
        expect(rolePaths.length).toBe(1);

        const before = calls.length;
        expect(await bindings.setDefault("w-1", true)).toBe(true);

        const writes = calls.slice(before).filter((call) => call.method === "PUT");
        expect(writes.map((call) => call.path)).toEqual([
            "/api/v1/workspaces/w-1/agents/p-1/default",
        ]);
        // 正交：默认标记不本地改，写后按可管理工作区数重取读面（2 个工作区 ⇒ 2 次 GET /agents）。
        const rereads = calls
            .slice(before)
            .filter((call) => call.method === "GET" && call.path.endsWith("/agents"));
        expect(rereads.length).toBe(WORKSPACES.length);
    });

    it("未绑行不能设为默认：零请求直接拒绝（不发注定 404 的写）", async () => {
        mockApi((seen) => {
            if (seen.path === "/api/v1/me/permissions") {
                return {
                    status: 200,
                    body: permissionView({ instanceAtoms: [MANAGE_AGENTS_ATOM] }),
                };
            }
            if (seen.path === "/api/v1/workspaces") return { status: 200, body: WORKSPACES };
            return { status: 200, body: { agents: [] } };
        });
        const bindings = useAgentBindings({ principalId: () => "p-1" });
        await bindings.load();
        const before = calls.length;
        expect(await bindings.setDefault("w-2", true)).toBe(false);
        expect(calls.length).toBe(before);
    });

    // 锚点（Lead 2026-11-21 10:55 与 task-219 同口径）：404 / 5xx / 空数组是三件事，不许合并成一个空态。
    it("角色读面四态分明：空数组 ⇒ ready、404 ⇒ not-found、5xx ⇒ failed（三者互不相等）", async () => {
        mockApi((seen) => {
            if (seen.path === "/api/v1/me/permissions") {
                return {
                    status: 200,
                    body: permissionView({ instanceAtoms: [MANAGE_AGENTS_ATOM] }),
                };
            }
            if (seen.path === "/api/v1/workspaces") return { status: 200, body: THREE };
            if (seen.path === "/api/v1/agent-principals/p-1/roles") {
                const workspaceId = seen.url.searchParams.get("workspaceId");
                if (workspaceId === "w-1") return rolesReply([]);
                if (workspaceId === "w-2") {
                    return {
                        status: 404,
                        body: { code: "AGENT_PRINCIPAL_NOT_FOUND", detail: "not visible here" },
                    };
                }
                return { status: 500, body: { code: "INTERNAL", detail: "boom" } };
            }
            return {
                status: 200,
                body: {
                    agents: [
                        {
                            principalId: "p-1",
                            name: "ResearchAgent",
                            bound: true,
                            isDefault: false,
                            capSource: "baseline",
                        },
                    ],
                },
            };
        });
        const bindings = useAgentBindings({ principalId: () => "p-1" });
        await bindings.load();

        expect(bindings.rolesFor("w-1").state).toBe("ready");
        expect(bindings.rolesFor("w-1").roles).toEqual([]);
        expect(bindings.rolesFor("w-2").state).toBe("not-found");
        expect(bindings.rolesFor("w-3").state).toBe("failed");
        expect(
            new Set([
                bindings.rolesFor("w-1").state,
                bindings.rolesFor("w-2").state,
                bindings.rolesFor("w-3").state,
            ]).size,
        ).toBe(3);
        // 404 的原文保留在 cause 里，供界面透出 code（不是吞成空数组）。
        const notFoundCause = bindings.rolesFor("w-2").cause as {
            problem?: { code?: string };
        } | null;
        expect(notFoundCause?.problem?.code).toBe("AGENT_PRINCIPAL_NOT_FOUND");
    });
});

/**
 * task-41（Lead 2026-11-21 裁定 A/B）：`canManage` 的第三态 —— 「清单还没回 / 读失败」时必须是 `null`，
 * 不许退化成本地算出来的 `false`。
 *
 * <p>原理由：旧实现先置 `capabilityState = "ready"` 再 `await listWorkspaces()`，清单 pending 期间
 * `workspaces` 是空数组 ⇒ `canManage` 算出 `false`，面板落下「你没有可管理的工作区智能体权限」。
 * 真栈 11:10 那次误判就是这么来的（org1-probe-race：延迟 /workspaces 时该分支稳定复现）。</p>
 */
describe("useAgentBindings（task-41 读态语义）", () => {
    it("清单未回 ⇒ canManage 是 null（不是 false）；回来后才 true 并读绑定", async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
            const raw =
                typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            const url = new URL(raw, "http://127.0.0.1");
            calls.push({
                method: (init?.method ?? "GET").toUpperCase(),
                path: url.pathname,
                body: "",
            });
            if (url.pathname === "/api/v1/me/permissions") {
                return new Response(
                    JSON.stringify(permissionView({ instanceAtoms: [MANAGE_AGENTS_ATOM] })),
                    { status: 200, headers: { "content-type": "application/json" } },
                );
            }
            if (url.pathname === "/api/v1/workspaces") {
                await gate;
                return new Response(JSON.stringify(WORKSPACES), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }
            return new Response(JSON.stringify({ agents: [] }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        });

        const bindings = useAgentBindings({ principalId: () => "p-1" });
        const loading = bindings.load();
        await vi.waitFor(() =>
            expect(calls.some((call) => call.path === "/api/v1/workspaces")).toBe(true),
        );

        // 投影已到、清单未回：判据不齐 ⇒ null。空数组不得被当成"没有可管理的工作区"。
        expect(bindings.canManage.value).toBeNull();
        expect(bindings.manageableWorkspaces.value).toEqual([]);
        // 判据没齐就不读绑定（不许拿空候选集去发请求，也不许让 readState 变 ready）。
        expect(bindings.readState.value).toBe("idle");
        expect(calls.some((call) => call.path.endsWith("/agents"))).toBe(false);

        release();
        await loading;

        expect(bindings.workspacesState.value).toBe("ready");
        expect(bindings.canManage.value).toBe(true);
        expect(bindings.manageableWorkspaces.value.length).toBe(WORKSPACES.length);
        // 清单回来后确实去读了每个工作区的绑定。
        expect(bindings.readState.value).toBe("ready");
        expect(calls.filter((call) => call.path.endsWith("/agents")).length).toBe(
            WORKSPACES.length,
        );
    });

    it("清单读失败 ⇒ workspacesState=failed 且 canManage 仍是 null（不降级成 false / 空清单）", async () => {
        mockApi((seen) => {
            if (seen.path === "/api/v1/me/permissions") {
                return {
                    status: 200,
                    body: permissionView({ instanceAtoms: [MANAGE_AGENTS_ATOM] }),
                };
            }
            if (seen.path === "/api/v1/workspaces") {
                return { status: 500, body: { code: "INTERNAL", detail: "boom" } };
            }
            return { status: 200, body: { agents: [] } };
        });

        const bindings = useAgentBindings({ principalId: () => "p-1" });
        await bindings.load();

        expect(bindings.workspacesState.value).toBe("failed");
        // 原始 cause 保留给界面透出 code（读失败 ≠ 没权限，两种输入必须能分辨）。
        expect(bindings.workspacesCause.value).not.toBeNull();
        expect(bindings.canManage.value).toBeNull();
        expect(bindings.manageableWorkspaces.value).toEqual([]);
        // 读不到清单就不读绑定，也不落 ready（否则面板会说"读完了，什么都没有"）。
        expect(bindings.readState.value).toBe("idle");
        expect(calls.map((call) => call.path)).toEqual([
            "/api/v1/me/permissions",
            "/api/v1/workspaces",
        ]);
    });
});
