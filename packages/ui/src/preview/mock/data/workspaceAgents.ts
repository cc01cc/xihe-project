/**
 * task-449 / D-1287（D-1281 同形）：工作区智能体夹具 —— 让「冻结上限快照」有行可渲染。
 *
 * 为什么存在：`GET /workspaces/{id}/agents` 此前回 `{agents:[]}`（合法空集）⇒
 * ① task-417 的快照标注与 `capSource` 来源徽标在 mock 车道**没有行可渲染**、拿不到浏览器证据；
 * ② `WorkspaceAgentsPanel` 消费 21 条 api 面，空集把其中缺失的那些**藏了起来**（本卡实测 13 条缺）。
 * 「空集不是没有缺口，是看不见缺口」（D-1281，task-25 会话夹具富化后照出 6 条缺口同形）。
 *
 * 契约纪律（逐条照 CP，不发明字段）：
 * - 读面投影 = `WorkspaceAgentController.toView:286-316`：principalId / name / templateId /
 *   templateName / createdAt / permissionsSnapshot / capSource / bound / hooks / contextPolicy /
 *   disabled / **roleIds**（BL-326：required，手写序列化器曾静默漏发）。
 * - `permissionsSnapshot` 的原子是 `{actionClass, resource?}`（`toValue:322-335`：resource 只在存在时给）。
 * - **capSource 四态**（D-1109）：explicit 非空 / explicit 空=零权限 / baseline 空=继承 / 缺省=旧响应。
 *   空数组的语义由 capSource 决定，**不由长度猜** —— 这正是 417 修掉的错判（继承态被说成零权限）。
 * - 记忆信封 `{memories:[…]}`；角色绑定信封 `{bindings:[…]}`（2026-11-05 实测 wire；冻结稿写 items，UI 两者都收）。
 * - 写面 cap（`PUT /workspaces/{ws}/agents/{pid}`）：**空体 ⇒ baseline**；`{permissions:[…]}` ⇒ explicit
 *   （`[]` 永远表示零权限，不是「用基线」，46C 已否决）。响应 `{principalId,workspaceId,permissions,capSource}`。
 * - `hooks` 是**对象文档**（`{advisors:[…]}`）不是权限数组（PLAN-0625 Gap I：数组投影曾让订阅行永不亮）。
 */

/** 与 data/sessions.ts 同一个 mock 工作区，避免两套 id 让跨面夹具对不上。 */
export const MOCK_AGENT_WORKSPACE_ID = "mock-ws-main";

export interface MockAgentAtom {
    actionClass: string;
    resource?: string;
}

export interface MockWorkspaceAgentRow {
    principalId: string;
    name: string;
    templateId: string | null;
    templateName: string | null;
    createdAt: string;
    permissionsSnapshot: MockAgentAtom[];
    /** 缺省 = D-1109 之前的旧响应（该行没有 cap 绑定来源）；null 同义。 */
    capSource?: "baseline" | "explicit" | null;
    bound: boolean;
    disabled: boolean;
    roleIds: string[];
    hooks: { advisors: Array<{ event: string; target: string }> };
    contextPolicy: { memory: { enabled: boolean } };
}

export interface MockAgentMemoryRow {
    id: string;
    principalId: string;
    content: string;
    pinned: boolean;
    updatedAt: string;
    origin: "manual" | "run";
    /** 归档软删（PLAN-0629 M1-5）：retired 行默认不列出，`?status=all` 才给。 */
    retired: boolean;
}

export interface MockAgentRoleBindingRow {
    bindingId: string;
    principalId: string;
    roleId: string;
    roleName: string;
    roleDisplayName: string;
    scopeType: string;
    scopeId: string | null;
    scopeName: string | null;
    isSystem: boolean;
    grantedBy: string;
    atomSummary: string[];
    atomCount: number;
    atomsTruncated: boolean;
}

const PID_EXPLICIT = "a1f0c4d2-7b3e-4c55-8f10-5d2c9b000201";
const PID_ZERO = "a1f0c4d2-7b3e-4c55-8f10-5d2c9b000202";
const PID_INHERIT = "a1f0c4d2-7b3e-4c55-8f10-5d2c9b000203";
const PID_LEGACY = "a1f0c4d2-7b3e-4c55-8f10-5d2c9b000204";
const PID_DISABLED = "a1f0c4d2-7b3e-4c55-8f10-5d2c9b000205";
const PID_UNBOUND = "a1f0c4d2-7b3e-4c55-8f10-5d2c9b000206";

export const MOCK_AGENT_PRINCIPAL_IDS = {
    explicit: PID_EXPLICIT,
    zero: PID_ZERO,
    inherit: PID_INHERIT,
    legacy: PID_LEGACY,
    disabled: PID_DISABLED,
    unbound: PID_UNBOUND,
} as const;

const ROLE_VIEWER = "r1f0c4d2-7b3e-4c55-8f10-5d2c9b000301";
const ROLE_EDITOR = "r1f0c4d2-7b3e-4c55-8f10-5d2c9b000302";

function agent(
    principalId: string,
    name: string,
    capSource: MockWorkspaceAgentRow["capSource"],
    permissionsSnapshot: MockAgentAtom[],
    extra: Partial<MockWorkspaceAgentRow> = {},
): MockWorkspaceAgentRow {
    return {
        principalId,
        name,
        templateId: null,
        templateName: null,
        createdAt: "2026-11-05T02:00:00.000Z",
        permissionsSnapshot,
        ...(capSource === undefined ? {} : { capSource }),
        bound: true,
        disabled: false,
        roleIds: [ROLE_EDITOR],
        hooks: { advisors: [] },
        contextPolicy: { memory: { enabled: true } },
        ...extra,
    };
}

/** 六行覆盖 capSource 四态 + disabled + 未绑定（bound=false 的可见行，D26）。 */
const SEED_AGENTS: MockWorkspaceAgentRow[] = [
    agent(PID_EXPLICIT, "cap-explicit-agent", "explicit", [
        { actionClass: "file_read", resource: "workspace" },
        { actionClass: "file_write", resource: "workspace" },
        {
            actionClass: "credential_use",
            resource: "credential:11111111-2222-3333-4444-555555555555",
        },
    ]),
    agent(PID_ZERO, "cap-zero-agent", "explicit", [], { roleIds: [ROLE_VIEWER] }),
    agent(PID_INHERIT, "cap-inherit-agent", "baseline", []),
    // 旧响应：**没有 capSource 字段**（不是 null），UI 不得据此编造来源。
    agent(PID_LEGACY, "cap-legacy-agent", undefined, []),
    agent(
        PID_DISABLED,
        "cap-disabled-agent",
        "explicit",
        [{ actionClass: "file_read", resource: "workspace" }],
        { disabled: true },
    ),
    agent(PID_UNBOUND, "cap-unbound-agent", null, [], { bound: false, roleIds: [] }),
];

const SEED_MEMORIES: MockAgentMemoryRow[] = [
    {
        id: "m1f0c4d2-7b3e-4c55-8f10-5d2c9b000401",
        principalId: PID_EXPLICIT,
        content: "这个仓库的构建命令是 pnpm run build，产物在 dist/。",
        pinned: true,
        updatedAt: "2026-11-06T01:00:00.000Z",
        origin: "manual",
        retired: false,
    },
    {
        id: "m1f0c4d2-7b3e-4c55-8f10-5d2c9b000402",
        principalId: PID_EXPLICIT,
        content: "上一次运行发现 e2e 端口 12630 被占用，改用 12736。",
        pinned: false,
        updatedAt: "2026-11-06T02:00:00.000Z",
        origin: "run",
        retired: false,
    },
    {
        id: "m1f0c4d2-7b3e-4c55-8f10-5d2c9b000403",
        principalId: PID_EXPLICIT,
        content: "已归档的旧结论（默认不列出）。",
        pinned: false,
        updatedAt: "2026-11-05T03:00:00.000Z",
        origin: "manual",
        retired: true,
    },
    {
        id: "m1f0c4d2-7b3e-4c55-8f10-5d2c9b000404",
        principalId: PID_INHERIT,
        content: "继承态主体也有记忆：记忆与 cap 是两条独立的轴。",
        pinned: false,
        updatedAt: "2026-11-06T04:00:00.000Z",
        origin: "run",
        retired: false,
    },
];

const SEED_ROLE_BINDINGS: MockAgentRoleBindingRow[] = [
    {
        bindingId: "b1f0c4d2-7b3e-4c55-8f10-5d2c9b000501",
        principalId: PID_EXPLICIT,
        roleId: ROLE_EDITOR,
        roleName: "WS_EDITOR",
        roleDisplayName: "工作区读写",
        scopeType: "workspace",
        scopeId: MOCK_AGENT_WORKSPACE_ID,
        scopeName: "Mock 主工作区",
        isSystem: true,
        grantedBy: "u1f0c4d2-7b3e-4c55-8f10-5d2c9b000001",
        atomSummary: ["file_read", "file_write", "tool_execute"],
        atomCount: 5,
        atomsTruncated: true,
    },
    {
        bindingId: "b1f0c4d2-7b3e-4c55-8f10-5d2c9b000502",
        principalId: PID_ZERO,
        roleId: ROLE_VIEWER,
        roleName: "WS_VIEWER",
        roleDisplayName: "工作区只读",
        scopeType: "workspace",
        scopeId: MOCK_AGENT_WORKSPACE_ID,
        scopeName: "Mock 主工作区",
        isSystem: true,
        grantedBy: "u1f0c4d2-7b3e-4c55-8f10-5d2c9b000001",
        atomSummary: ["file_read"],
        atomCount: 1,
        atomsTruncated: false,
    },
    {
        bindingId: "b1f0c4d2-7b3e-4c55-8f10-5d2c9b000503",
        principalId: PID_INHERIT,
        roleId: ROLE_EDITOR,
        roleName: "WS_EDITOR",
        roleDisplayName: "工作区读写",
        scopeType: "workspace",
        scopeId: MOCK_AGENT_WORKSPACE_ID,
        scopeName: "Mock 主工作区",
        isSystem: true,
        grantedBy: "u1f0c4d2-7b3e-4c55-8f10-5d2c9b000001",
        atomSummary: ["file_read", "file_write", "tool_execute"],
        atomCount: 5,
        atomsTruncated: true,
    },
];

let agents: MockWorkspaceAgentRow[] = SEED_AGENTS.map((row) => ({ ...row }));
let memories: MockAgentMemoryRow[] = SEED_MEMORIES.map((row) => ({ ...row }));
let roleBindings: MockAgentRoleBindingRow[] = SEED_ROLE_BINDINGS.map((row) => ({ ...row }));

/** 单测与 e2e 之间复位（写面会改内存集合，不复位就会跨用例漂移）。 */
export function resetWorkspaceAgentFixture(): void {
    agents = SEED_AGENTS.map((row) => ({
        ...row,
        permissionsSnapshot: [...row.permissionsSnapshot],
    }));
    memories = SEED_MEMORIES.map((row) => ({ ...row }));
    roleBindings = SEED_ROLE_BINDINGS.map((row) => ({ ...row }));
}

export function workspaceAgentsOfWorkspace(workspaceId: string): MockWorkspaceAgentRow[] {
    return workspaceId === MOCK_AGENT_WORKSPACE_ID ? agents.map((row) => ({ ...row })) : [];
}

export function agentMemoriesOf(
    principalId: string,
    status: "active" | "retired" | "all" = "active",
): MockAgentMemoryRow[] {
    return memories
        .filter((row) => row.principalId === principalId)
        .filter((row) =>
            status === "all" ? true : status === "retired" ? row.retired : !row.retired,
        )
        .map((row) => ({ ...row }));
}

export function agentRoleBindingsOf(principalId: string): MockAgentRoleBindingRow[] {
    return roleBindings.filter((row) => row.principalId === principalId).map((row) => ({ ...row }));
}

/**
 * `PUT /workspaces/{ws}/agents/{pid}` 的判定：**省略 permissions ⇒ baseline**，传数组 ⇒ explicit。
 * 返回 CP 的响应形状；未知主体回 null（调用方转 404），不做通配成功。
 */
export function setWorkspaceAgentCap(
    workspaceId: string,
    principalId: string,
    permissions: MockAgentAtom[] | undefined,
): {
    principalId: string;
    workspaceId: string;
    permissions: MockAgentAtom[];
    capSource: "baseline" | "explicit";
} | null {
    if (workspaceId !== MOCK_AGENT_WORKSPACE_ID) return null;
    const row = agents.find((item) => item.principalId === principalId);
    if (!row) return null;
    if (permissions === undefined) {
        row.capSource = "baseline";
        row.permissionsSnapshot = [];
    } else {
        row.capSource = "explicit";
        row.permissionsSnapshot = permissions.map((atom) => ({ ...atom }));
    }
    return {
        principalId,
        workspaceId,
        permissions: row.permissionsSnapshot.map((atom) => ({ ...atom })),
        capSource: row.capSource,
    };
}

/** 与 `handleInstanceResource` / `handleAgentSkillBinding` 同形：返回 null = 本模块不接这条路径。 */
export interface MockAgentDispatchResult {
    status: number;
    body: unknown;
}

const ROLE_CATALOG = [
    {
        id: ROLE_VIEWER,
        name: "WS_VIEWER",
        displayName: "工作区只读",
        description: "只读访问工作区文件与运行结果。",
        system: true,
        atoms: [
            {
                name: "file_read",
                scopeClass: "workspace",
                capability: false,
                resource: "workspace",
                displayName: "读取文件",
            },
        ],
        bindingCount: 1,
    },
    {
        id: ROLE_EDITOR,
        name: "WS_EDITOR",
        displayName: "工作区读写",
        description: "读写工作区文件并执行工具。",
        system: true,
        atoms: [
            {
                name: "file_read",
                scopeClass: "workspace",
                capability: false,
                resource: "workspace",
                displayName: "读取文件",
            },
            {
                name: "file_write",
                scopeClass: "workspace",
                capability: false,
                resource: "workspace",
                displayName: "写入文件",
            },
            {
                name: "tool_execute",
                scopeClass: "workspace",
                capability: false,
                resource: "workspace",
                displayName: "执行工具",
            },
        ],
        bindingCount: 2,
    },
];

function problem(status: number, code: string, detail: string): MockAgentDispatchResult {
    return {
        status,
        body: { type: "about:blank", title: code, status, code, detail, requestId: "mock-request" },
    };
}

/**
 * 工作区智能体面的 dispatch（task-449）。路径与判定逐条照 CP：
 * - `WorkspaceAgentController`：list / PUT cap（空体=baseline）/ DELETE unbind / memories 子资源；
 * - `AgentPrincipalController`：create / disable / PATCH contextPolicy（整对象替换）；
 * - 角色绑定：`/agent-principals/{pid}/roles`（信封 `{bindings:[…]}`）+ `/roles` 目录（裸数组）。
 * 未知 suffix 一律回 null ⇒ 上层 404 `MOCK_ENDPOINT_MISSING`，**不做通配 200 掩盖缺口**。
 * 诚实边界：mock 不复刻 CP 的主体名文法（UI 侧 `principalNameError` 已守）与角色 cap 上限求值。
 */
export async function handleWorkspaceAgentResource(
    method: string,
    path: string,
    url: URL,
    readJsonBody: () => Promise<Record<string, unknown>>,
): Promise<MockAgentDispatchResult | null> {
    const listMatch = path.match(/^\/workspaces\/([^/]+)\/agents$/);
    if (listMatch && method === "GET") {
        return { status: 200, body: { agents: workspaceAgentsOfWorkspace(listMatch[1]) } };
    }
    const itemMatch = path.match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)$/);
    if (itemMatch) {
        const [, workspaceId, principalId] = itemMatch;
        if (method === "PUT") {
            const body = await readJsonBody();
            const keys = Object.keys(body);
            const hasPermissions = Object.prototype.hasOwnProperty.call(body, "permissions");
            // CP:248-251：只接受空体或**只含** permissions 数组；其余一律 400 INVALID_REQUEST。
            if (keys.length > 1 || (hasPermissions && !Array.isArray(body.permissions))) {
                return problem(
                    400,
                    "INVALID_REQUEST",
                    "Body must be empty or contain only a permissions array",
                );
            }
            const result = setWorkspaceAgentCap(
                workspaceId,
                principalId,
                hasPermissions ? (body.permissions as MockAgentAtom[]) : undefined,
            );
            return result
                ? { status: 200, body: result }
                : problem(404, "WORKSPACE_AGENT_NOT_FOUND", "Workspace Agent binding not found");
        }
        if (method === "DELETE") {
            const before = agents.length;
            agents = agents.filter(
                (row) =>
                    !(row.principalId === principalId && workspaceId === MOCK_AGENT_WORKSPACE_ID),
            );
            return agents.length === before
                ? problem(404, "WORKSPACE_AGENT_NOT_FOUND", "Workspace Agent binding not found")
                : { status: 204, body: null };
        }
    }
    const memoryMatch = path.match(
        /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/memories(?:\/([^/]+))?$/,
    );
    if (memoryMatch) {
        const [, , principalId, memoryId] = memoryMatch;
        if (!memoryId && method === "GET") {
            const status = url.searchParams.get("status");
            const filter = status === "retired" || status === "all" ? status : "active";
            return { status: 200, body: { memories: agentMemoriesOf(principalId, filter) } };
        }
        if (!memoryId && method === "POST") {
            const body = await readJsonBody();
            const content = typeof body.content === "string" ? body.content.trim() : "";
            if (!content) return problem(400, "INVALID_REQUEST", "content is required");
            const row: MockAgentMemoryRow = {
                id: `m-new-${memories.length + 1}`,
                principalId,
                content,
                pinned: body.pinned === true,
                updatedAt: new Date().toISOString(),
                origin: "manual",
                retired: false,
            };
            memories.push(row);
            return { status: 201, body: { ...row } };
        }
        if (memoryId && method === "PATCH") {
            const row = memories.find((item) => item.id === memoryId);
            if (!row) return problem(404, "MEMORY_NOT_FOUND", "Memory not found");
            const body = await readJsonBody();
            if (typeof body.content === "string") row.content = body.content;
            if (typeof body.pinned === "boolean") row.pinned = body.pinned;
            row.updatedAt = new Date().toISOString();
            return { status: 200, body: { ...row } };
        }
        if (memoryId && method === "DELETE") {
            const row = memories.find((item) => item.id === memoryId);
            if (!row) return problem(404, "MEMORY_NOT_FOUND", "Memory not found");
            row.retired = true; // 归档软删，不是物理删除（PLAN-0629 M1-5）
            return { status: 204, body: null };
        }
    }
    const rolesMatch = path.match(/^\/agent-principals\/([^/]+)\/roles(?:\/([^/]+))?$/);
    if (rolesMatch) {
        const [, principalId, bindingId] = rolesMatch;
        if (!bindingId && method === "GET") {
            return { status: 200, body: { bindings: agentRoleBindingsOf(principalId) } };
        }
        if (!bindingId && method === "POST") {
            const body = await readJsonBody();
            const roleId = typeof body.roleId === "string" ? body.roleId : "";
            const role = ROLE_CATALOG.find((item) => item.id === roleId);
            if (!role) return problem(404, "ROLE_NOT_FOUND", "Role not found");
            const row: MockAgentRoleBindingRow = {
                bindingId: `b-new-${roleBindings.length + 1}`,
                principalId,
                roleId: role.id,
                roleName: role.name,
                roleDisplayName: role.displayName,
                scopeType: "workspace",
                scopeId: url.searchParams.get("workspaceId"),
                scopeName: "Mock 主工作区",
                isSystem: role.system,
                grantedBy: "u1f0c4d2-7b3e-4c55-8f10-5d2c9b000001",
                atomSummary: role.atoms.slice(0, 3).map((atom) => atom.name),
                atomCount: role.atoms.length,
                atomsTruncated: role.atoms.length > 3,
            };
            roleBindings.push(row);
            return { status: 201, body: { ...row } };
        }
        if (bindingId && method === "DELETE") {
            const row = roleBindings.find((item) => item.bindingId === bindingId);
            if (!row) return problem(404, "ROLE_BINDING_NOT_FOUND", "Role binding not found");
            // 种子绑定不可解（CP 409 兜底，UI 据 isSystem 不渲染解绑按钮）。
            if (row.isSystem) {
                return problem(
                    409,
                    "ROLE_BINDING_IMMUTABLE",
                    "Seed role binding cannot be removed",
                );
            }
            roleBindings = roleBindings.filter((item) => item.bindingId !== bindingId);
            return { status: 204, body: null };
        }
    }
    if (path === "/roles" && method === "GET") {
        return { status: 200, body: ROLE_CATALOG.map((role) => ({ ...role })) };
    }
    if (path === "/agent-principals" && method === "POST") {
        const body = await readJsonBody();
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) return problem(400, "INVALID_REQUEST", "name is required");
        const principalId = `a-new-${agents.length + 1}`;
        agents.push(
            agent(principalId, name, "explicit", [], {
                bound: false,
                roleIds: [],
                templateId: typeof body.templateId === "string" ? body.templateId : null,
            }),
        );
        return {
            status: 201,
            body: {
                principalId,
                templateId: null,
                templateName: null,
                createdAt: new Date().toISOString(),
            },
        };
    }
    const principalMatch = path.match(/^\/agent-principals\/([^/]+)(\/disable)?$/);
    if (principalMatch) {
        const [, principalId, disableSuffix] = principalMatch;
        const row = agents.find((item) => item.principalId === principalId);
        if (disableSuffix && method === "POST") {
            if (!row) return problem(404, "AGENT_PRINCIPAL_NOT_FOUND", "Agent principal not found");
            row.disabled = true;
            return { status: 204, body: null };
        }
        if (!disableSuffix && method === "PATCH") {
            if (!row) return problem(404, "AGENT_PRINCIPAL_NOT_FOUND", "Agent principal not found");
            const body = await readJsonBody();
            // contextPolicy 是**整对象替换**（UI 侧必须先合并现值再发）。
            if (body.contextPolicy && typeof body.contextPolicy === "object") {
                row.contextPolicy = body.contextPolicy as MockWorkspaceAgentRow["contextPolicy"];
            }
            return { status: 204, body: null };
        }
    }
    return null;
}
