/**
 * 双侧轨迹对账（task-50）—— 用例注册表。
 *
 * 一条「用例」= 一层页面上会发出的那串 API 请求（`calls`），外加 **mock 车道要回什么**（`stubs`）。
 * 两侧跑同一份 `calls`：mock 车道打本地桩服务，real 车道打真栈（本轮未跑，见 README §4）。
 *
 * `compare` = 本条用例要判的归一化路径白名单；不在名单里的仍然写进轨迹但标 `compared:false`。
 * 这是把「本用例负责的形状」写死 —— 要覆盖更多就往 `compare` 里加一条。
 *
 * 桩体来源（不是随手编的）：`e2e/mock/agent-principals.spec.ts:59-134` 里 `/me/permissions`、
 * `/workspaces`、`/agent-principals` 三处 `route.fulfill` 的原文；工作区层与实例层按 `openapi.yaml`
 * 的 `WorkspaceAgentListResponse`（`{agents}`）/ `AgentPrincipalListResponse`（`{principals}`）补键名。
 *
 * 本轮只落 1 条（`stack-1` 被 R13 占着，真栈录波要等窗口）。机制通了以后再补：
 * 资源区凭据三层（`/credentials` + `/instance/credentials`）。
 */

const AGENT_ROW = {
    principalId: "principal-1",
    name: "MyAgent",
    templateId: null,
    templateName: null,
    createdAt: "2026-11-10T00:00:00Z",
    disabledAt: null,
};

const WORKSPACE_AGENT_ROW = {
    principalId: "principal-1",
    name: "MyAgent",
    bound: true,
    disabled: false,
    permissionsSnapshot: [],
    roleIds: [],
};

const INSTANCE_AGENT_ROW = {
    principalId: "principal-1",
    name: "MyAgent",
    ownerUserId: "user-1",
    workspaceId: "workspace-1",
    disabled: false,
};

export const CASES = {
    "resources-agents": {
        id: "resources-agents",
        title: "资源区 · 智能体三层（用户 / 工作区 / 实例）",
        /** 每层首屏会打的那条列表请求（顺序 = 层顺序）。 */
        calls: [
            { layer: "USER", method: "GET", path: "/api/v1/agent-principals" },
            { layer: "WORKSPACE", method: "GET", path: "/api/v1/workspaces/workspace-1/agents" },
            { layer: "INSTANCE", method: "GET", path: "/api/v1/instance/agent-principals" },
        ],
        compare: [
            "/api/v1/agent-principals",
            "/api/v1/workspaces/{id}/agents",
            "/api/v1/instance/agent-principals",
        ],
        /** mock 车道：归一化路径 -> 响应体（键名必须与契约一致；改键名 = 本轮反例）。 */
        stubs: {
            "/api/v1/agent-principals": { principals: [AGENT_ROW] },
            "/api/v1/workspaces/{id}/agents": { agents: [WORKSPACE_AGENT_ROW] },
            "/api/v1/instance/agent-principals": { principals: [INSTANCE_AGENT_ROW] },
        },
    },
};

export function getCase(id) {
    const found = CASES[id];
    if (!found) {
        const known = Object.keys(CASES).join(", ");
        throw new Error("unknown dual-lane case: " + id + " (known: " + known + ")");
    }
    return found;
}

/** 一个归一化路径是否属于本用例的对账面。 */
export function isCompared(testCase, normalizedPath) {
    return testCase.compare.includes(normalizedPath);
}
