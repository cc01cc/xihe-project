import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as apiModule from "../../../composables/api";

/**
 * PLAN-0750 M3（T3.1 / T3.2 / T3.3）：用户层「智能体」面板。
 *
 * <p>锁四件事，全部对应冻结矩阵的判据：</p>
 * <ol>
 *   <li><b>U1</b>——创建表单**没有工作区选择器**，且创建走 `createOwnAgentPrincipal`
 *       （无 ws 上下文）；`createAgentPrincipal`（工作区门）一次都不许被调到。</li>
 *   <li><b>R3</b>——列表只读 `listMyAgentPrincipals`（个人视图）。</li>
 *   <li><b>U2</b>——本面板不碰 `WorkspaceAgentPrincipalsPanel` 的单门；绑定只是工作区能力。</li>
 *   <li><b>T3.2</b>——没有任何可管理工作区时给**显式提示**，不是渲染点了才 403 的按钮。</li>
 * </ol>
 */

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listMyAgentPrincipals: vi.fn<typeof apiModule.api.listMyAgentPrincipals>(),
            createOwnAgentPrincipal: vi.fn<typeof apiModule.api.createOwnAgentPrincipal>(),
            createAgentPrincipal: vi.fn<typeof apiModule.api.createAgentPrincipal>(),
            getSelfPermissions: vi.fn<typeof apiModule.api.getSelfPermissions>(),
            listWorkspaces: vi.fn<typeof apiModule.api.listWorkspaces>(),
            getWorkspaceAgents: vi.fn<typeof apiModule.api.getWorkspaceAgents>(),
            updateWorkspaceAgentCap: vi.fn<typeof apiModule.api.updateWorkspaceAgentCap>(),
        },
    };
});

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string) => void>(),
        warn: vi.fn<(message: string) => void>(),
    },
}));

import { api } from "../../../composables/api";
import { i18n } from "../../../i18n";
import AgentPrincipalsPanel from "../AgentPrincipalsPanel.vue";

const mockedApi = vi.mocked(api, true);

function agentRow(principalId: string, name: string): apiModule.AgentPrincipalSummary {
    return {
        principalId,
        name,
        templateId: null,
        templateName: null,
        createdAt: "2026-11-10T00:00:00Z",
        disabled: false,
        defaultModelProvider: null,
        defaultModelName: null,
    };
}

/** 默认：普通 USER —— 有 CREATE_OWN_AGENT，但只在 ws-1 持 MANAGE_WORKSPACE_AGENTS。 */
function selfPermissions(options: {
    instanceAtoms?: string[];
    workspaces?: apiModule.SelfPermissionsView["workspaces"];
}): apiModule.SelfPermissionsView {
    return {
        userId: "user-1",
        instanceCapabilities: [],
        instancePermissions: (options.instanceAtoms ?? ["CREATE_OWN_AGENT"]).map((actionClass) => ({
            actionClass,
            resource: "*",
        })),
        workspaces: options.workspaces ?? [
            {
                workspaceId: "ws-1",
                workspaceRole: "OWNER",
                workspaceAdmin: true,
                permissions: [{ actionClass: "MANAGE_WORKSPACE_AGENTS", resource: "ws-1" }],
            },
        ],
    };
}

function mountPanel() {
    return mount(AgentPrincipalsPanel, { global: { plugins: [i18n] }, attachTo: document.body });
}

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    mockedApi.listMyAgentPrincipals.mockResolvedValue([agentRow("p-1", "MyAgent")]);
    mockedApi.getSelfPermissions.mockResolvedValue(selfPermissions({}));
    mockedApi.listWorkspaces.mockResolvedValue([
        { id: "ws-1", name: "Workspace One" },
    ] as apiModule.ApiWorkspace[]);
    mockedApi.getWorkspaceAgents.mockResolvedValue([]);
    mockedApi.updateWorkspaceAgentCap.mockResolvedValue({ permissions: [] });
    mockedApi.createOwnAgentPrincipal.mockResolvedValue({
        principalId: "p-2",
        templateId: null,
        templateName: null,
        createdAt: "2026-11-10T00:00:00Z",
    });
});

describe("AgentPrincipalsPanel — 列表与个人视图 (R3)", () => {
    it("renders the personal view from listMyAgentPrincipals", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        expect(mockedApi.listMyAgentPrincipals).toHaveBeenCalledTimes(1);
        expect(wrapper.find('[data-testid="agent-principals-row-p-1"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-principals-row-name-p-1"]').text()).toBe(
            "MyAgent",
        );
        // 个人视图 = 没有 workspaceId 查询参数那个入口；这条锁住"没换成工作区列表"。
        expect(mockedApi.getWorkspaceAgents).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
        );
        wrapper.unmount();
    });

    it("shows the empty state when the caller has created nothing", async () => {
        mockedApi.listMyAgentPrincipals.mockResolvedValue([]);
        const wrapper = mountPanel();
        await flushPromises();
        expect(wrapper.find('[data-testid="agent-principals-empty"]').exists()).toBe(true);
        wrapper.unmount();
    });
});

describe("AgentPrincipalsPanel — 创建走用户级门 (U1)", () => {
    it("has no workspace selector in the create form", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.find('[data-testid="agent-principals-create-button"]').trigger("click");

        const form = wrapper.find('[data-testid="agent-principals-create-form"]');
        expect(form.exists()).toBe(true);
        // 矩阵 U1：一旦带工作区，CP 会按 MANAGE_WORKSPACE_AGENTS 判权 ⇒ 普通账号 403。
        expect(form.find('[data-testid="agent-principals-create-workspace"]').exists()).toBe(false);
        expect(form.html()).not.toContain("workspaceId");
        wrapper.unmount();
    });

    it("creates through createOwnAgentPrincipal with a name-only body", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.find('[data-testid="agent-principals-create-button"]').trigger("click");
        await wrapper.find('[data-testid="agent-principals-create-name"]').setValue("MyAgent");
        await wrapper.find('[data-testid="agent-principals-create-form"]').trigger("submit");
        await flushPromises();

        expect(mockedApi.createOwnAgentPrincipal).toHaveBeenCalledTimes(1);
        expect(mockedApi.createOwnAgentPrincipal).toHaveBeenCalledWith({ name: "MyAgent" });
        // 工作区门那条路一次都不能被调到（U1：两扇门不许串）。
        expect(mockedApi.createAgentPrincipal).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it("shows the atom-denied gate instead of the create button without CREATE_OWN_AGENT", async () => {
        mockedApi.getSelfPermissions.mockResolvedValue(selfPermissions({ instanceAtoms: [] }));
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-principals-create-denied"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-atom-denied"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-principals-create-button"]').exists()).toBe(false);
        wrapper.unmount();
    });
});

describe("AgentPrincipalsPanel — 绑定动作 (T3.2)", () => {
    it("binds through the workspace cap call and reports the binding", async () => {
        const wrapper = mountPanel();
        await flushPromises();

        await wrapper.find('[data-testid="agent-principals-bind-p-1"]').trigger("click");
        await flushPromises();
        const submit = document.querySelector('[data-testid="agent-principals-bind-submit"]');
        expect(submit).not.toBeNull();
        (submit as HTMLElement).click();
        await flushPromises();

        // 空 cap = 绑定但不授予工具权限；工作区 id 来自可管理工作区列表。
        expect(mockedApi.updateWorkspaceAgentCap).toHaveBeenCalledWith("ws-1", "p-1", []);
        expect(wrapper.find('[data-testid="agent-principals-bound-p-1"]').text()).toContain(
            "Workspace One",
        );
        wrapper.unmount();
    });

    it("states the missing permission explicitly when no workspace is manageable", async () => {
        mockedApi.getSelfPermissions.mockResolvedValue(
            selfPermissions({
                instanceAtoms: ["CREATE_OWN_AGENT"],
                workspaces: [
                    {
                        workspaceId: "ws-1",
                        workspaceRole: "VIEWER",
                        workspaceAdmin: false,
                        permissions: [],
                    },
                ],
            }),
        );
        const wrapper = mountPanel();
        await flushPromises();

        // T3.2：无权限要**显式提示**，不是留一个点了才 403 的按钮。
        expect(wrapper.find('[data-testid="agent-principals-bind-denied"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-principals-bind-p-1"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("treats an instance-scope MANAGE_WORKSPACE_AGENTS as manageable everywhere", async () => {
        mockedApi.getSelfPermissions.mockResolvedValue(
            selfPermissions({
                instanceAtoms: ["CREATE_OWN_AGENT", "MANAGE_WORKSPACE_AGENTS"],
                workspaces: [
                    {
                        workspaceId: "ws-2",
                        workspaceRole: "VIEWER",
                        workspaceAdmin: false,
                        permissions: [],
                    },
                ],
            }),
        );
        mockedApi.listWorkspaces.mockResolvedValue([
            { id: "ws-2", name: "Workspace Two" },
        ] as apiModule.ApiWorkspace[]);
        const wrapper = mountPanel();
        await flushPromises();

        // CP 的 holdsActionAtom 求值是「实例行 ∪ 工作区行」，UI 必须照抄，否则藏掉真实可绑入口。
        expect(wrapper.find('[data-testid="agent-principals-bind-denied"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="agent-principals-bind-p-1"]').exists()).toBe(true);
        wrapper.unmount();
    });
});
