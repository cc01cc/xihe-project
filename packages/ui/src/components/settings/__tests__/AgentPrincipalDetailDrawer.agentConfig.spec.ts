import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { nextTick } from "vue";

import { i18n } from "../../../i18n";
import { setSelectValue } from "../../../test-utils/select";
import AgentPrincipalDetailDrawer, {
    type AgentPrincipalDetail,
} from "../AgentPrincipalDetailDrawer.vue";
import WorkspaceAgentsPanel from "../../../features/workspace/components/WorkspaceAgentsPanel.vue";

/**
 * task-959 / R38：智能体配置信息架构。
 *
 * <p>这一组用例钉的是**用户裁定后的信息架构**，不是某个具体原子名：</p>
 * <ol>
 *   <li>「允许模型白名单」退役：存量 `allowedModels` 可以读，但抽屉不再渲染、保存也不再提交；</li>
 *   <li>工作区维度（skill / MCP / 文件系统授权）只在工作区面出现 —— MCP 读面来自本工作区，
 *       授权通过 `mcp:&lt;serverId&gt;` 资源行落库；</li>
 *   <li>访问预设只是模板：导入后仍是可逐项编辑的草稿；</li>
 *   <li>未绑定工作区 / 本工作区没有 MCP 时是**带下一步入口的空态**，不是空白。</li>
 * </ol>
 */

const WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";
const PRINCIPAL_ID = "77777777-7777-4777-8777-777777777777";

const apiMock = vi.hoisted(() => ({
    getWorkspaceAgents: vi.fn<() => Promise<unknown[]>>(),
    request: vi.fn<(path: string, options?: RequestInit) => Promise<unknown>>(),
    getAgentRoles: vi.fn<(workspaceId: string | null, principalId: string) => Promise<unknown[]>>(),
    updateAgentPrincipal: vi.fn<(principalId: string, body: unknown) => Promise<unknown>>(),
    getSelfPermissions: vi.fn<() => Promise<unknown>>(),
    getMcpConfig: vi.fn<() => Promise<unknown>>(),
    getWorkspaceAgentEffectiveCap: vi.fn<() => Promise<unknown>>(),
    updateWorkspaceAgentCap: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    listPresets: vi.fn<() => Promise<unknown[]>>(),
    getAgentSkills: vi.fn<() => Promise<unknown[]>>(),
    getSkills: vi.fn<() => Promise<unknown[]>>(),
    getWorkspaceSkills: vi.fn<() => Promise<unknown[]>>(),
    getWorkspaceAgentMemories: vi.fn<() => Promise<unknown[]>>(),
    listWorkspaceAgentSpawnSessions: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("../../../composables/api", () => ({
    api: apiMock,
    request: apiMock.request,
    ApiError: class MockApiError extends Error {
        problem: { code: string; detail?: string; status?: number };
        constructor(code: string, detail = "mock error", status?: number) {
            super(detail);
            this.name = "MockApiError";
            this.problem = { code, detail, status };
        }
    },
}));

vi.mock("../../../stores/config", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        useConfigStore: () => ({
            providerConnections: [],
            providerConnectionsError: false,
            modelError: null,
            modelCache: { providers: {} },
            loadProviderConnections: vi.fn<() => Promise<void>>(async () => {}),
            fetchModels: vi.fn<() => Promise<void>>(async () => {}),
        }),
    };
});

vi.mock("../../../services/providerConnectionService", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        listProviderConnections: vi.fn<() => Promise<{ connections: unknown[] }>>(async () => ({
            connections: [],
        })),
        listProviderCatalog: vi.fn<() => Promise<{ providers: unknown[] }>>(async () => ({
            providers: [],
        })),
    };
});

vi.mock("vue-router", async (importOriginal) => {
    const actual = await importOriginal<typeof import("vue-router")>();
    return {
        ...actual,
        useRoute: () => ({ params: {}, query: {} }),
        useRouter: () => ({
            replace: vi.fn<() => Promise<void>>(() => Promise.resolve()),
            push: vi.fn<() => Promise<void>>(() => Promise.resolve()),
        }),
        onBeforeRouteLeave: vi.fn<() => void>(),
        onBeforeRouteUpdate: vi.fn<() => void>(),
    };
});

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string) => void>(),
    },
}));

const WORKSPACE_ACTOR = {
    userId: "99999999-9999-4999-8999-999999999999",
    instanceCapabilities: [],
    instancePermissions: [],
    workspaces: [
        {
            workspaceId: WORKSPACE_ID,
            workspaceAdmin: true,
            permissions: [
                { actionClass: "MANAGE_WORKSPACE_AGENTS", resource: WORKSPACE_ID },
                { actionClass: "read", resource: "*" },
                { actionClass: "write", resource: "*" },
                { actionClass: "exec", resource: "*" },
            ],
        },
    ],
};

function principal(overrides: Partial<AgentPrincipalDetail> = {}): AgentPrincipalDetail {
    return {
        principalId: PRINCIPAL_ID,
        name: "ResearchAgent",
        ownership: "USER",
        templateName: "Researcher",
        createdAt: "2026-11-01T02:03:04Z",
        disabled: false,
        defaultModelProvider: "openai",
        defaultModelName: "gpt-4o-mini",
        // 存量行可以带白名单：读兼容，但界面不得再出现编辑入口。
        allowedModels: [{ provider: "openai", model: "gpt-4o-mini" }],
        hooks: null,
        contextPolicy: null,
        delegationPolicy: null,
        ...overrides,
    };
}

function mountDrawer(props: Record<string, unknown> = {}) {
    return mount(AgentPrincipalDetailDrawer, {
        props: { open: true, principal: principal(), ...props } as never,
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
}

function boundAgent(snapshot: Array<Record<string, unknown>> = []) {
    return {
        principalId: PRINCIPAL_ID,
        name: "ResearchAgent",
        templateId: null,
        templateName: "Researcher",
        createdAt: "2026-11-01T02:03:04Z",
        permissionsSnapshot: snapshot,
        capSource: "explicit",
        bound: true,
        disabled: false,
        isDefault: false,
        hooks: null,
        contextPolicy: null,
    };
}

async function mountPanel() {
    const wrapper = mount(WorkspaceAgentsPanel, {
        attachTo: document.body,
        props: { workspaceId: WORKSPACE_ID },
        global: {
            plugins: [i18n, createPinia()],
            stubs: { RouterLink: { props: ["to"], template: '<a :href="to"><slot /></a>' } },
        },
    });
    await flushPromises();
    return wrapper;
}

function testid(id: string): HTMLElement {
    const node = document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    if (!node) throw new Error(`missing testid: ${id}`);
    return node;
}

function maybeTestid(id: string): HTMLElement | null {
    return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

async function click(testidValue: string): Promise<void> {
    testid(testidValue).click();
    await flushPromises();
}

beforeEach(() => {
    document.body.innerHTML = "";
    apiMock.getWorkspaceAgents.mockReset();
    apiMock.request.mockReset();
    apiMock.getAgentRoles.mockReset();
    apiMock.updateAgentPrincipal.mockReset();
    apiMock.getSelfPermissions.mockReset();
    apiMock.getMcpConfig.mockReset();
    apiMock.getWorkspaceAgentEffectiveCap.mockReset();
    apiMock.updateWorkspaceAgentCap.mockReset();
    apiMock.listPresets.mockReset();
    apiMock.getAgentSkills.mockReset();
    apiMock.getSkills.mockReset();
    apiMock.getWorkspaceSkills.mockReset();
    apiMock.getWorkspaceAgentMemories.mockReset();
    apiMock.listWorkspaceAgentSpawnSessions.mockReset();

    apiMock.getWorkspaceAgents.mockResolvedValue([boundAgent([])]);
    apiMock.request.mockResolvedValue({ agents: [], bindableCandidates: [] });
    apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ACTOR);
    apiMock.getMcpConfig.mockResolvedValue({ mcpServers: {} });
    apiMock.getWorkspaceAgentEffectiveCap.mockResolvedValue({
        principalId: PRINCIPAL_ID,
        workspaceId: WORKSPACE_ID,
        effectiveCap: [],
        capSource: { binding: "binding-snapshot" },
        provenance: { principalGrantIds: [], bindingGrantIds: [], grantSources: {} },
        defaultGrants: { readFace: ["workspace-member"] },
        bound: true,
    });
    apiMock.updateWorkspaceAgentCap.mockResolvedValue({});
    apiMock.listPresets.mockResolvedValue([]);
    apiMock.getAgentRoles.mockResolvedValue([]);
    apiMock.updateAgentPrincipal.mockResolvedValue({});
    apiMock.getAgentSkills.mockResolvedValue([]);
    apiMock.getSkills.mockResolvedValue([]);
    apiMock.getWorkspaceSkills.mockResolvedValue([]);
    apiMock.getWorkspaceAgentMemories.mockResolvedValue([]);
    apiMock.listWorkspaceAgentSpawnSessions.mockResolvedValue({
        counts: { all: 0 },
        sessions: [],
    });
});

describe("R38 · 允许模型白名单退役", () => {
    it("存量 allowedModels 只读兼容：抽屉不渲染白名单编辑区，保存 payload 也不带它", async () => {
        const update = vi.fn<() => Promise<unknown>>(async () => ({
            principalId: PRINCIPAL_ID,
            defaultModelProvider: "anthropic",
            defaultModelName: "claude-x",
            allowedModels: null,
            hooks: null,
            contextPolicy: null,
            delegationPolicy: null,
        }));
        apiMock.request.mockImplementation((path: string) => {
            if (path.includes("/agent-principals/")) return update();
            return Promise.resolve({ agents: [], bindableCandidates: [] });
        });
        const wrapper = mountDrawer();
        await flushPromises();

        expect(maybeTestid("apd-allowed-add")).toBeNull();
        expect(maybeTestid("apd-allowed-0-provider")).toBeNull();
        expect(wrapper.text()).not.toContain("允许模型白名单");
        // Agent ↔ 模型是多对一：唯一模型意图仍可编辑并保存。
        expect(testid("apd-model-binding-provider")).toBeTruthy();
    });
});

describe("R38 · 工作区维度（MCP + 访问预设）", () => {
    it("MCP 读面来自本工作区；勾选 = 授出 mcp:<serverId> 通道行", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([
            boundAgent([
                { actionClass: "read", resource: "*" },
                { actionClass: "write", resource: "*" },
            ]),
        ]);
        apiMock.getMcpConfig.mockResolvedValue({
            mcpServers: { filesystem: { command: "npx", args: ["-y", "server-filesystem"] } },
        });
        await mountPanel();

        expect(maybeTestid("workspace-agent-mcp-server-filesystem")).toBeTruthy();
        await click(`workspace-agent-edit-cap-${PRINCIPAL_ID}`);

        const checkbox = testid(`agent-mcp-grant-filesystem`) as HTMLInputElement;
        expect(checkbox.checked).toBe(false);
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event("change"));
        await flushPromises();

        await click(`workspace-agent-save-cap-${PRINCIPAL_ID}`);
        const payload = apiMock.updateWorkspaceAgentCap.mock.calls[0]?.[2] as Array<
            Record<string, string>
        >;
        expect(
            payload.some(
                (permission) =>
                    permission.actionClass === "write" && permission.resource === "mcp:filesystem",
            ),
        ).toBe(true);
    });

    it("访问预设只是模板：导入的是原子草稿，导入后仍可逐项编辑", async () => {
        apiMock.listPresets.mockResolvedValue([
            {
                id: "preset-1",
                name: "editor",
                displayName: "Editor",
                description: null,
                system: false,
                bindingCount: 0,
                atoms: [
                    {
                        name: "action:write",
                        capability: false,
                        scopeClass: "both",
                        resource: "*",
                    },
                    {
                        name: "cap:MANAGE_WORKSPACE_AGENTS",
                        capability: true,
                        scopeClass: "both",
                        resource: "*",
                    },
                ],
            },
        ]);
        apiMock.getWorkspaceAgents.mockResolvedValue([boundAgent([])]);
        const wrapper = await mountPanel();

        await click(`workspace-agent-edit-cap-${PRINCIPAL_ID}`);
        await setSelectValue(wrapper, '[data-testid="agent-preset-import-select"]', "preset-1");
        await click("agent-preset-import-apply");

        // 导入后 write 动作进入勾选态，且草稿仍可被单独改资源。
        expect((testid("agent-cap-write") as HTMLInputElement).checked).toBe(true);
        expect(testid("agent-preset-import-message").textContent).toContain("1");
        const resource = testid("agent-resource-write") as HTMLInputElement;
        resource.value = "fs:ws/src";
        resource.dispatchEvent(new Event("input"));
        await nextTick();
        expect((testid("agent-resource-write") as HTMLInputElement).value).toBe("fs:ws/src");
    });

    it("本工作区没有 MCP / 没有可绑定主体时是带下一步入口的空态", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([]);
        await mountPanel();

        expect(maybeTestid("agent-candidates-empty")).toBeTruthy();
        expect(maybeTestid("agent-principals-page-link")).toBeTruthy();
    });

    it("本工作区 MCP 为空时在权限编辑区给出空态 + 管理入口", async () => {
        await mountPanel();

        expect(maybeTestid("workspace-agent-mcp-manage")).toBeTruthy();
        expect(maybeTestid("workspace-agent-mcp-empty")).toBeTruthy();

        await click(`workspace-agent-edit-cap-${PRINCIPAL_ID}`);
        expect(maybeTestid("agent-mcp-config-empty")).toBeTruthy();
    });
});
