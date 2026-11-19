import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { i18n } from "../../../../i18n";
import WorkspaceAgentsPanel from "../WorkspaceAgentsPanel.vue";

/**
 * task-116 · 方案 A UI 侧：工作区「默认智能体」。
 *
 * 卡面写域与验收见 team task task-116。CP 侧（task-106）**尚未**落
 * `workspace_agents.is_default` 与 `PUT/DELETE /workspaces/{ws}/agents/{pid}/default`
 * ⇒ 本 spec 先把 UI 契约钉死（先红），实现按此跟进；404 必须降级成可读文案，不许崩、不许谎报成功。
 *
 * 契约（与 lead 对齐的假定面）：
 * - `WorkspaceAgentBinding.isDefault?: boolean`（列表读面透出；刷新后仍在 ⇒ 读服务端不是本地缓存）；
 * - `api.setWorkspaceAgentDefault(workspaceId, principalId)` = PUT .../default；
 * - `api.clearWorkspaceAgentDefault(workspaceId, principalId)` = DELETE .../default；
 * - testid 家族 `workspace-agent-default-*`（badge / set / clear / hint / error / disabled）。
 */

const WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";
const DEFAULT_AGENT_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_AGENT_ID = "88888888-8888-4888-8888-888888888888";

const apiMock = vi.hoisted(() => ({
    getWorkspaceAgents: vi.fn<() => Promise<unknown[]>>(),
    getAgentTemplates: vi.fn<() => Promise<unknown>>(),
    createAgentPrincipal: vi.fn<(input: unknown) => Promise<unknown>>(),
    updateWorkspaceAgentCap: vi.fn<() => Promise<unknown>>(),
    deleteWorkspaceAgent: vi.fn<() => Promise<void>>(),
    getWorkspaceAgentEffectiveCap: vi.fn<() => Promise<unknown>>(),
    disableAgentPrincipal: vi.fn<(principalId: string) => Promise<void>>(),
    getSelfPermissions: vi.fn<() => Promise<unknown>>(),
    getWorkspaceAgentMemories: vi.fn<() => Promise<unknown[]>>(),
    createAgentMemory: vi.fn<() => Promise<void>>(),
    updateAgentMemory: vi.fn<() => Promise<void>>(),
    deleteAgentMemory: vi.fn<() => Promise<void>>(),
    updateAgentPrincipalContextPolicy: vi.fn<() => Promise<void>>(),
    getAgentRoles: vi.fn<() => Promise<unknown[]>>(),
    getAgentSkills: vi.fn<() => Promise<unknown[]>>(),
    bindAgentRole: vi.fn<() => Promise<void>>(),
    unbindAgentRole: vi.fn<() => Promise<void>>(),
    bindAgentSkill: vi.fn<() => Promise<void>>(),
    unbindAgentSkill: vi.fn<() => Promise<void>>(),
    listRoles: vi.fn<() => Promise<unknown[]>>(),
    getSkills: vi.fn<() => Promise<unknown[]>>(),
    getWorkspaceSkills: vi.fn<(workspaceId: string) => Promise<unknown[]>>(),
    listWorkspaceAgentSpawnSessions: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    // task-116：默认智能体写面（CP 端点尚未落地）。
    setWorkspaceAgentDefault: vi.fn<(workspaceId: string, principalId: string) => Promise<void>>(),
    clearWorkspaceAgentDefault:
        vi.fn<(workspaceId: string, principalId: string) => Promise<void>>(),
}));

vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        api: apiMock,
        ApiError: class MockApiError extends Error {
            problem: { code: string; detail?: string; status?: number };
            constructor(
                code: string,
                detail = "CREATE_ACCOUNT permission is required",
                status?: number,
            ) {
                super(detail);
                this.name = "MockApiError";
                this.problem = { code, detail, status };
            }
        },
    };
});

vi.mock("../../../../stores/auth", () => ({
    useAuthStore: () => ({
        isAdmin: true,
        canReadInstanceContent: true,
        canManageWorkspacePolicy: true,
        canManageWorkspace: true,
        user: { id: "99999999-9999-4999-8999-999999999999" },
    }),
}));

const WORKSPACE_MANAGE = {
    userId: "99999999-9999-4999-8999-999999999999",
    instanceCapabilities: [],
    instancePermissions: [],
    workspaces: [
        {
            workspaceId: WORKSPACE_ID,
            workspaceAdmin: true,
            permissions: [{ actionClass: "MANAGE_WORKSPACE_AGENTS", resource: WORKSPACE_ID }],
        },
    ],
};

/** 只有读权限：能看见默认标记，但不能改（fail-closed，不让人点了才发现没权限）。 */
const READ_ONLY = {
    userId: "99999999-9999-4999-8999-999999999999",
    instanceCapabilities: [],
    instancePermissions: [{ actionClass: "READ", resource: "*" }],
    workspaces: [],
};

function agent(id: string, name: string, isDefault = false) {
    return {
        principalId: id,
        name,
        templateId: null,
        templateName: null,
        createdAt: new Date().toISOString(),
        permissionsSnapshot: [],
        bound: true,
        disabled: false,
        ...(isDefault ? { isDefault: true } : {}),
    };
}

const mountedWrappers: VueWrapper[] = [];

function mountPanel() {
    const wrapper = mount(WorkspaceAgentsPanel, {
        attachTo: document.body,
        props: { workspaceId: WORKSPACE_ID },
        global: {
            plugins: [i18n],
            stubs: { RouterLink: { props: ["to"], template: '<a :href="to"><slot /></a>' } },
        },
    }) as VueWrapper;
    mountedWrappers.push(wrapper);
    return wrapper;
}

async function mountLoaded() {
    const wrapper = mountPanel();
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    localStorage.removeItem("xihe-pending-agent-principals");
    for (const fn of Object.values(apiMock)) fn.mockReset();
    apiMock.getWorkspaceAgents.mockResolvedValue([]);
    apiMock.getAgentTemplates.mockResolvedValue({
        layer: "instance",
        workspaceId: null,
        templates: [],
    });
    apiMock.getWorkspaceAgentMemories.mockResolvedValue([]);
    apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_MANAGE);
    apiMock.getAgentRoles.mockResolvedValue([]);
    apiMock.getAgentSkills.mockResolvedValue([]);
    apiMock.listRoles.mockResolvedValue([]);
    apiMock.getSkills.mockResolvedValue([]);
    apiMock.getWorkspaceSkills.mockResolvedValue([]);
    apiMock.setWorkspaceAgentDefault.mockResolvedValue(undefined);
    apiMock.clearWorkspaceAgentDefault.mockResolvedValue(undefined);
});

afterEach(() => {
    for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount();
    vi.clearAllMocks();
    document.body.innerHTML = "";
});

describe("WorkspaceAgentsPanel · 默认智能体（task-116 方案 A）", () => {
    it("marks the default agent and offers the action only on the rows that can take it", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([
            agent(DEFAULT_AGENT_ID, "Default agent", true),
            agent(OTHER_AGENT_ID, "Other agent"),
        ]);
        const wrapper = await mountLoaded();

        expect(
            wrapper
                .find(`[data-testid="workspace-agent-default-badge-${DEFAULT_AGENT_ID}"]`)
                .exists(),
        ).toBe(true);
        expect(
            wrapper
                .find(`[data-testid="workspace-agent-default-badge-${OTHER_AGENT_ID}"]`)
                .exists(),
        ).toBe(false);
        // 已经是默认 ⇒ 只给「取消默认」；不是默认 ⇒ 只给「设为默认」。
        expect(
            wrapper
                .find(`[data-testid="workspace-agent-default-clear-${DEFAULT_AGENT_ID}"]`)
                .exists(),
        ).toBe(true);
        expect(
            wrapper
                .find(`[data-testid="workspace-agent-default-set-${DEFAULT_AGENT_ID}"]`)
                .exists(),
        ).toBe(false);
        expect(
            wrapper.find(`[data-testid="workspace-agent-default-set-${OTHER_AGENT_ID}"]`).exists(),
        ).toBe(true);
        expect(
            wrapper
                .find(`[data-testid="workspace-agent-default-clear-${OTHER_AGENT_ID}"]`)
                .exists(),
        ).toBe(false);
    });

    it("PUTs the default and re-reads the list so the badge comes from the server, not a local cache", async () => {
        apiMock.getWorkspaceAgents
            .mockResolvedValueOnce([
                agent(DEFAULT_AGENT_ID, "Default agent", true),
                agent(OTHER_AGENT_ID, "Other agent"),
            ])
            .mockResolvedValueOnce([
                agent(DEFAULT_AGENT_ID, "Default agent"),
                agent(OTHER_AGENT_ID, "Other agent", true),
            ]);
        const wrapper = await mountLoaded();
        await wrapper
            .get(`[data-testid="workspace-agent-default-set-${OTHER_AGENT_ID}"]`)
            .trigger("click");
        await flushPromises();

        expect(apiMock.setWorkspaceAgentDefault).toHaveBeenCalledTimes(1);
        expect(apiMock.setWorkspaceAgentDefault).toHaveBeenCalledWith(WORKSPACE_ID, OTHER_AGENT_ID);
        // 标记必须来自重新读取的列表（验收③：刷新后仍在 = 读 API 不是本地缓存）。
        expect(apiMock.getWorkspaceAgents).toHaveBeenCalledTimes(2);
        expect(
            wrapper
                .find(`[data-testid="workspace-agent-default-badge-${OTHER_AGENT_ID}"]`)
                .exists(),
        ).toBe(true);
        expect(
            wrapper
                .find(`[data-testid="workspace-agent-default-badge-${DEFAULT_AGENT_ID}"]`)
                .exists(),
        ).toBe(false);
    });

    it("clears the default through DELETE and the badge goes away after the re-read", async () => {
        apiMock.getWorkspaceAgents
            .mockResolvedValueOnce([agent(DEFAULT_AGENT_ID, "Default agent", true)])
            .mockResolvedValueOnce([agent(DEFAULT_AGENT_ID, "Default agent")]);
        const wrapper = await mountLoaded();
        await wrapper
            .get(`[data-testid="workspace-agent-default-clear-${DEFAULT_AGENT_ID}"]`)
            .trigger("click");
        await flushPromises();

        expect(apiMock.clearWorkspaceAgentDefault).toHaveBeenCalledTimes(1);
        expect(apiMock.clearWorkspaceAgentDefault).toHaveBeenCalledWith(
            WORKSPACE_ID,
            DEFAULT_AGENT_ID,
        );
        expect(
            wrapper
                .find(`[data-testid="workspace-agent-default-badge-${DEFAULT_AGENT_ID}"]`)
                .exists(),
        ).toBe(false);
        expect(
            wrapper
                .find(`[data-testid="workspace-agent-default-set-${DEFAULT_AGENT_ID}"]`)
                .exists(),
        ).toBe(true);
    });

    it("turns a missing CP endpoint (404) into readable copy and keeps the previous state", async () => {
        const { ApiError } = await import("../../../../composables/api");
        apiMock.getWorkspaceAgents.mockResolvedValue([
            agent(DEFAULT_AGENT_ID, "Default agent", true),
            agent(OTHER_AGENT_ID, "Other agent"),
        ]);
        apiMock.setWorkspaceAgentDefault.mockRejectedValue(
            new (ApiError as unknown as new (
                code: string,
                detail: string,
                status: number,
            ) => Error)(
                "NOT_FOUND",
                "No static resource workspaces/66666666-6666-4666-8666-666666666666/agents/88888888-8888-4888-8888-888888888888/default.",
                404,
            ),
        );
        const wrapper = await mountLoaded();
        await wrapper
            .get(`[data-testid="workspace-agent-default-set-${OTHER_AGENT_ID}"]`)
            .trigger("click");
        await flushPromises();

        const error = wrapper.get('[data-testid="workspace-agent-default-error"]');
        expect(error.text().trim().length).toBeGreaterThan(0);
        // 瞬时面只显示可读文案：错误码 / 英文 detail / 「API error 404」都不许漏到界面。
        expect(error.text()).not.toContain("NOT_FOUND");
        expect(error.text()).not.toContain("No static resource");
        expect(error.text()).not.toMatch(/API error \d+/);
        // 失败不改状态：默认标记仍在原行，列表没有被本地乐观改写。
        expect(
            wrapper
                .find(`[data-testid="workspace-agent-default-badge-${DEFAULT_AGENT_ID}"]`)
                .exists(),
        ).toBe(true);
    });

    it("keeps the badge visible but disables the action without MANAGE_WORKSPACE_AGENTS", async () => {
        apiMock.getSelfPermissions.mockResolvedValue(READ_ONLY);
        apiMock.getWorkspaceAgents.mockResolvedValue([
            agent(DEFAULT_AGENT_ID, "Default agent", true),
            agent(OTHER_AGENT_ID, "Other agent"),
        ]);
        const wrapper = await mountLoaded();

        expect(
            wrapper
                .find(`[data-testid="workspace-agent-default-badge-${DEFAULT_AGENT_ID}"]`)
                .exists(),
        ).toBe(true);
        const setButton = wrapper.get(
            `[data-testid="workspace-agent-default-set-${OTHER_AGENT_ID}"]`,
        );
        expect(setButton.attributes("disabled")).toBeDefined();
        const reason = wrapper.get(
            `[data-testid="workspace-agent-default-disabled-${OTHER_AGENT_ID}"]`,
        );
        expect(reason.text().trim().length).toBeGreaterThan(0);

        await setButton.trigger("click");
        await flushPromises();
        expect(apiMock.setWorkspaceAgentDefault).not.toHaveBeenCalled();
    });

    it("explains what the default does and warns when the workspace has none", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([agent(OTHER_AGENT_ID, "Other agent")]);
        const wrapper = await mountLoaded();

        const hint = wrapper.get('[data-testid="workspace-agent-default-hint"]');
        expect(hint.text()).toContain(i18n.global.t("workspaceAgents.noDefaultHint"));
    });
});
