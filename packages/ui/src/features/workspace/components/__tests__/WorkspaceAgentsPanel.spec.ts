import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { i18n } from "../../../../i18n";

const WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";

const apiMock = vi.hoisted(() => ({
    getWorkspaceAgents: vi.fn<() => Promise<unknown[]>>(),
    getAgentTemplates: vi.fn<() => Promise<unknown>>(),
    // PLAN-0622：创建改为对象入参（name/templateId/scope/defaultModel*/allowedModels）。
    createAgentPrincipal: vi.fn<(input: unknown) => Promise<unknown>>(),
    updateWorkspaceAgentCap: vi.fn<() => Promise<unknown>>(),
    deleteWorkspaceAgent: vi.fn<() => Promise<void>>(),
    disableAgentPrincipal: vi.fn<(principalId: string) => Promise<void>>(),
    // PLAN-0621 F-01：权威能力投影（CP `GET /me/permissions`）。
    getSelfPermissions: vi.fn<() => Promise<unknown>>(),
    // PLAN-0629 M1-4 C：只读记忆列表。
    getWorkspaceAgentMemories: vi.fn<() => Promise<unknown[]>>(),
    // PLAN-0629 M1-5：记忆写入面（v2 裁定：无 type、归档软删、启用开关走 contextPolicy）。
    createAgentMemory: vi.fn<() => Promise<void>>(),
    updateAgentMemory: vi.fn<() => Promise<void>>(),
    deleteAgentMemory: vi.fn<() => Promise<void>>(),
    updateAgentPrincipalContextPolicy: vi.fn<() => Promise<void>>(),
    // PLAN-0667 M3：角色 / 技能区块（六条 agent 子资源 + 两条候选清单）。
    getAgentRoles: vi.fn<() => Promise<unknown[]>>(),
    getAgentSkills: vi.fn<() => Promise<unknown[]>>(),
    bindAgentRole: vi.fn<() => Promise<void>>(),
    unbindAgentRole: vi.fn<() => Promise<void>>(),
    bindAgentSkill: vi.fn<() => Promise<void>>(),
    unbindAgentSkill: vi.fn<() => Promise<void>>(),
    listRoles: vi.fn<() => Promise<unknown[]>>(),
    getSkills: vi.fn<() => Promise<unknown[]>>(),
}));

const CREATE_ACCOUNT_GRANTED = {
    userId: "99999999-9999-4999-8999-999999999999",
    instanceCapabilities: ["CREATE_ACCOUNT"],
    instancePermissions: [{ actionClass: "CREATE_ACCOUNT", resource: "*" }],
    workspaces: [],
};
const CREATE_ACCOUNT_MISSING = {
    userId: "99999999-9999-4999-8999-999999999999",
    instanceCapabilities: [],
    instancePermissions: [{ actionClass: "READ", resource: "*" }],
    workspaces: [],
};

vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        api: apiMock,
        ApiError: class MockApiError extends Error {
            problem: { code: string; detail?: string };
            constructor(code: string) {
                super("CREATE_ACCOUNT permission is required");
                this.name = "MockApiError";
                this.problem = { code, detail: "CREATE_ACCOUNT permission is required" };
            }
        },
    };
});

const admin = { value: true };
vi.mock("../../../../stores/auth", () => ({
    useAuthStore: () => ({ isAdmin: admin.value, canManageWorkspace: true }),
}));

import { ApiError } from "../../../../composables/api";
import WorkspaceAgentsPanel from "../WorkspaceAgentsPanel.vue";
import WorkspaceAgentManagementDialog from "../WorkspaceAgentManagementDialog.vue";

/**
 * PLAN-0626 M3：面板没有 `open` 开关 —— 挂载即打开（dock 标签激活 / 移动端弹窗），
 * 加载时机是 `onMounted`。测试照这个生命周期挂载，不再用 `setProps({ open: true })`。
 */
async function mountOpenedPanel() {
    const wrapper = mount(WorkspaceAgentsPanel, {
        attachTo: document.body,
        props: { workspaceId: WORKSPACE_ID },
        global: {
            plugins: [i18n],
            stubs: { RouterLink: { props: ["to"], template: '<a :href="to"><slot /></a>' } },
        },
    });
    await flushPromises();
    return wrapper;
}

function mountPanel() {
    return mount(WorkspaceAgentsPanel, {
        attachTo: document.body,
        props: { workspaceId: WORKSPACE_ID },
        global: {
            plugins: [i18n],
            stubs: { RouterLink: { props: ["to"], template: '<a :href="to"><slot /></a>' } },
        },
    });
}

beforeEach(() => {
    admin.value = true;
    apiMock.getWorkspaceAgents.mockResolvedValue([]);
    apiMock.getAgentTemplates.mockResolvedValue({
        layer: "instance",
        workspaceId: null,
        templates: [],
    });
    apiMock.updateWorkspaceAgentCap.mockResolvedValue({});
    apiMock.deleteWorkspaceAgent.mockResolvedValue(undefined);
    apiMock.getSelfPermissions.mockResolvedValue(CREATE_ACCOUNT_GRANTED);
    apiMock.getWorkspaceAgentMemories.mockResolvedValue([]);
});

afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
});

describe("WorkspaceAgentsPanel principal naming (2026-11-04)", () => {
    it("blocks a name with a space and explains the rule", async () => {
        const wrapper = await mountOpenedPanel();
        await wrapper.find('[data-testid="agent-principal-name"]').setValue("Research Agent");
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-principal-name-error"]').exists()).toBe(true);
        expect(
            wrapper.find('[data-testid="agent-principal-create"]').attributes("disabled"),
        ).toBeDefined();
        expect(apiMock.createAgentPrincipal).not.toHaveBeenCalled();
    });

    it("blocks a name starting with a digit", async () => {
        const wrapper = await mountOpenedPanel();
        await wrapper.find('[data-testid="agent-principal-name"]').setValue("1agent");
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-principal-name-error"]').exists()).toBe(true);
        expect(
            wrapper.find('[data-testid="agent-principal-create"]').attributes("disabled"),
        ).toBeDefined();
    });
});

describe("WorkspaceAgentsPanel F-02 grant hint (PLAN-0585 M2 / PLAN-0610 W5c)", () => {
    it("shows a localized actionable hint plus a link to the role surface for admins", async () => {
        const wrapper = mountPanel();
        await flushPromises();

        const link = wrapper.find('[data-testid="agent-grant-panel-link"]');
        expect(link.exists()).toBe(true);
        // W5c: the retired principal-grant page is replaced by roles & bindings.
        expect(link.attributes("href")).toBe("/settings/roles");
        // The static note names the admin surface instead of only stating the requirement.
        expect(wrapper.text()).toContain("角色与绑定");
    });

    it("replaces a 403 create failure with the localized hint, never the CP English detail", async () => {
        const ErrorCtor = ApiError as unknown as new (code: string) => Error;
        apiMock.createAgentPrincipal.mockRejectedValue(new ErrorCtor("FORBIDDEN"));
        const wrapper = await mountOpenedPanel();

        await wrapper.find('[data-testid="agent-principal-name"]').setValue("ResearchAgent");
        await wrapper.find('[data-testid="agent-principal-create-form"]').trigger("submit");
        await flushPromises();

        const text = document.body.textContent ?? "";
        expect(text).toContain("缺少 CREATE_ACCOUNT 权限");
        expect(text).toContain("角色与绑定");
        expect(text).not.toContain("CREATE_ACCOUNT permission is required");
    });

    it("hides the grant-panel link from non-admins but keeps the actionable note", async () => {
        admin.value = false;
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-grant-panel-link"]').exists()).toBe(false);
        expect(wrapper.text()).toContain("角色与绑定");
    });
});

// PLAN-0621 F-01：没有 CREATE_ACCOUNT 的用户在**点击之前**就该知道结果。
describe("WorkspaceAgentsPanel F-01 create gating (PLAN-0621)", () => {
    it("disables creation and points at the role surface when the CP projection lacks CREATE_ACCOUNT", async () => {
        admin.value = false;
        apiMock.getSelfPermissions.mockResolvedValue(CREATE_ACCOUNT_MISSING);
        const wrapper = await mountOpenedPanel();
        await flushPromises();

        const button = wrapper.find('[data-testid="agent-principal-create"]');
        expect(button.exists()).toBe(true);
        expect(button.attributes("disabled")).toBeDefined();
        // 复用既有文案，不新写一份（概念/文案膨胀门）。
        expect(wrapper.find('[data-testid="agent-create-forbidden-hint"]').exists()).toBe(true);
        expect(wrapper.text()).toContain("CREATE_ACCOUNT");
        const link = wrapper.find('[data-testid="agent-grant-panel-link"]');
        expect(link.exists()).toBe(true);
        expect(link.attributes("href")).toBe("/settings/roles");
        expect(wrapper.html()).not.toContain("/settings/principal-grants");
    });

    it("keeps creation enabled when the CP projection grants CREATE_ACCOUNT", async () => {
        admin.value = false;
        apiMock.getSelfPermissions.mockResolvedValue(CREATE_ACCOUNT_GRANTED);
        apiMock.createAgentPrincipal.mockResolvedValue({
            principalId: "77777777-7777-4777-8777-777777777777",
            templateId: null,
            templateName: null,
            createdAt: "2026-11-02T00:00:00Z",
        });
        const wrapper = await mountOpenedPanel();

        await wrapper.find('[data-testid="agent-principal-name"]').setValue("delegate");
        const button = wrapper.find('[data-testid="agent-principal-create"]');
        expect(button.attributes("disabled")).toBeUndefined();
        expect(wrapper.find('[data-testid="agent-create-forbidden-hint"]').exists()).toBe(false);
    });

    it("fails closed when the projection cannot be loaded, without inventing a permission", async () => {
        admin.value = false;
        apiMock.getSelfPermissions.mockRejectedValue(new ApiError("FORBIDDEN"));
        const wrapper = await mountOpenedPanel();
        await flushPromises();

        expect(
            wrapper.find('[data-testid="agent-principal-create"]').attributes("disabled"),
        ).toBeDefined();
    });
});

// ── PLAN-0622（M3 UI 跟随）：agent 三档 scope / 模型意图 / disable / 来源徽标 ────────────
const PERSONAL_ONLY = {
    userId: "99999999-9999-4999-8999-999999999999",
    instanceCapabilities: ["CREATE_OWN_AGENT"],
    instancePermissions: [{ actionClass: "CREATE_OWN_AGENT", resource: "*" }],
    workspaces: [],
};
const WORKSPACE_ONLY = {
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
const INSTANCE_ONLY = {
    userId: "99999999-9999-4999-8999-999999999999",
    instanceCapabilities: ["CREATE_ACCOUNT"],
    instancePermissions: [{ actionClass: "CREATE_ACCOUNT", resource: "*" }],
    workspaces: [],
};
const NOTHING = {
    userId: "99999999-9999-4999-8999-999999999999",
    instanceCapabilities: [],
    instancePermissions: [{ actionClass: "READ", resource: "*" }],
    workspaces: [],
};

function scopeOptions(wrapper: Awaited<ReturnType<typeof mountOpenedPanel>>): string[] {
    const select = wrapper.find('[data-testid="agent-principal-scope"]');
    if (!select.exists()) return [];
    return select.findAll("option").map((option) => option.attributes("value") ?? "");
}

describe("WorkspaceAgentsPanel PLAN-0622 scope visibility (4 states)", () => {
    it("offers only PERSONAL when the projection grants just CREATE_OWN_AGENT", async () => {
        apiMock.getSelfPermissions.mockResolvedValue(PERSONAL_ONLY);
        const wrapper = await mountOpenedPanel();
        expect(scopeOptions(wrapper)).toEqual(["PERSONAL"]);
        // 术语对账：文案必须带「智能体」限定，不能与"连接作用域"撞词。
        expect(wrapper.text()).toContain("个人智能体");
    });

    it("offers only WORKSPACE when MANAGE_WORKSPACE_AGENTS is granted for this Workspace", async () => {
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        const wrapper = await mountOpenedPanel();
        expect(scopeOptions(wrapper)).toEqual(["WORKSPACE"]);
        expect(wrapper.text()).toContain("工作区智能体");
    });

    it("offers only INSTANCE when the projection grants CREATE_ACCOUNT", async () => {
        apiMock.getSelfPermissions.mockResolvedValue(INSTANCE_ONLY);
        const wrapper = await mountOpenedPanel();
        expect(scopeOptions(wrapper)).toEqual(["INSTANCE"]);
        expect(wrapper.text()).toContain("实例智能体");
    });

    it("offers nothing and keeps creation disabled when no atom is granted (fail-closed)", async () => {
        admin.value = false;
        apiMock.getSelfPermissions.mockResolvedValue(NOTHING);
        const wrapper = await mountOpenedPanel();
        expect(wrapper.find('[data-testid="agent-principal-scope"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="agent-scope-unavailable"]').exists()).toBe(true);
        expect(
            wrapper.find('[data-testid="agent-principal-create"]').attributes("disabled"),
        ).toBeDefined();
    });
});

describe("WorkspaceAgentsPanel PLAN-0622 model intent", () => {
    it("blocks creation until an allowed-model row has both provider and model", async () => {
        apiMock.getSelfPermissions.mockResolvedValue(PERSONAL_ONLY);
        const wrapper = await mountOpenedPanel();
        await wrapper.find('[data-testid="agent-principal-name"]').setValue("delegate");
        expect(
            wrapper.find('[data-testid="agent-principal-create"]').attributes("disabled"),
        ).toBeUndefined();

        await wrapper.find('[data-testid="agent-allowed-model-add"]').trigger("click");
        await wrapper.find('[data-testid="agent-allowed-model-provider-0"]').setValue("openai");
        expect(wrapper.find('[data-testid="agent-allowed-model-error"]').exists()).toBe(true);
        expect(
            wrapper.find('[data-testid="agent-principal-create"]').attributes("disabled"),
        ).toBeDefined();

        await wrapper.find('[data-testid="agent-allowed-model-name-0"]').setValue("gpt-4o-mini");
        expect(wrapper.find('[data-testid="agent-allowed-model-error"]').exists()).toBe(false);
        expect(
            wrapper.find('[data-testid="agent-principal-create"]').attributes("disabled"),
        ).toBeUndefined();
    });

    it("rejects duplicate provider+model pairs", async () => {
        apiMock.getSelfPermissions.mockResolvedValue(PERSONAL_ONLY);
        const wrapper = await mountOpenedPanel();
        await wrapper.find('[data-testid="agent-principal-name"]').setValue("delegate");
        for (const [index, provider, model] of [
            [0, "openai", "gpt-4o-mini"],
            [1, "openai", "gpt-4o-mini"],
        ] as const) {
            await wrapper.find('[data-testid="agent-allowed-model-add"]').trigger("click");
            await wrapper
                .find(`[data-testid="agent-allowed-model-provider-${index}"]`)
                .setValue(provider);
            await wrapper.find(`[data-testid="agent-allowed-model-name-${index}"]`).setValue(model);
        }
        expect(wrapper.find('[data-testid="agent-allowed-model-error"]').text()).toContain("重复");
    });

    it("requires the default model pair to be complete and sends the whole intent", async () => {
        apiMock.getSelfPermissions.mockResolvedValue(PERSONAL_ONLY);
        apiMock.createAgentPrincipal.mockResolvedValue({
            principalId: "88888888-8888-4888-8888-888888888888",
            templateId: null,
            templateName: null,
            createdAt: "2026-11-02T00:00:00Z",
        });
        const wrapper = await mountOpenedPanel();
        await wrapper.find('[data-testid="agent-principal-name"]').setValue("delegate");
        await wrapper.find('[data-testid="agent-default-model-provider"]').setValue("openai");
        expect(wrapper.find('[data-testid="agent-default-model-error"]').exists()).toBe(true);
        await wrapper.find('[data-testid="agent-default-model-name"]').setValue("gpt-4o-mini");
        expect(wrapper.find('[data-testid="agent-default-model-error"]').exists()).toBe(false);

        await wrapper.find('[data-testid="agent-principal-create-form"]').trigger("submit");
        await flushPromises();
        expect(apiMock.createAgentPrincipal).toHaveBeenCalledWith({
            name: "delegate",
            scope: "PERSONAL",
            defaultModelProvider: "openai",
            defaultModelName: "gpt-4o-mini",
        });
    });
});

describe("WorkspaceAgentsPanel PLAN-0622 list rows", () => {
    const boundAgent = {
        principalId: "77777777-7777-4777-8777-777777777777",
        name: "helper",
        templateId: null,
        templateName: null,
        createdAt: "2026-11-02T00:00:00Z",
        permissionsSnapshot: [],
        bound: true,
        disabled: false,
        source: "personal",
        ownerUserId: "99999999-9999-4999-8999-999999999999",
        defaultModelProvider: "openai",
        defaultModelName: "gpt-4o-mini",
        allowedModels: [{ provider: "openai", model: "gpt-4o-mini" }],
    };

    it("shows the source badge and the default model for each row", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([boundAgent]);
        const wrapper = await mountOpenedPanel();
        const badge = wrapper.find(
            '[data-testid="agent-scope-badge-77777777-7777-4777-8777-777777777777"]',
        );
        expect(badge.exists()).toBe(true);
        expect(badge.attributes("data-agent-scope")).toBe("personal");
        expect(badge.text()).toBe("个人智能体");
        expect(
            wrapper
                .find('[data-testid="agent-default-model-77777777-7777-4777-8777-777777777777"]')
                .text(),
        ).toContain("openai / gpt-4o-mini");
    });

    it("disables an agent only after the second click and spells out the consequence", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([boundAgent]);
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        apiMock.disableAgentPrincipal.mockResolvedValue(undefined);
        const wrapper = await mountOpenedPanel();
        const button = wrapper.find(
            '[data-testid="workspace-agent-disable-77777777-7777-4777-8777-777777777777"]',
        );
        expect(wrapper.text()).toContain("禁用后新会话不能再选择该智能体");

        await button.trigger("click");
        expect(apiMock.disableAgentPrincipal).not.toHaveBeenCalled();
        expect(button.text()).toBe("再次点击确认禁用");

        await button.trigger("click");
        await flushPromises();
        expect(apiMock.disableAgentPrincipal).toHaveBeenCalledWith(boundAgent.principalId);
    });

    it("keeps the disable button disabled when the projection grants nothing", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([boundAgent]);
        admin.value = false;
        apiMock.getSelfPermissions.mockResolvedValue(NOTHING);
        const wrapper = await mountOpenedPanel();
        const button = wrapper.find(
            '[data-testid="workspace-agent-disable-77777777-7777-4777-8777-777777777777"]',
        );
        expect(button.attributes("disabled")).toBeDefined();
    });
});

// ── 真栈 bug（Lead 2026-11-02）：创建成功后列表不刷新，用户要关掉重开面板才看到新 agent ──────
describe("WorkspaceAgentsPanel list refresh after create", () => {
    it("shows the newly created principal without reopening the dialog", async () => {
        const created = {
            principalId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
            name: "Fresh agent",
            templateId: null,
            templateName: null,
            createdAt: "2026-11-02T00:00:00Z",
            source: "personal",
            permissionsSnapshot: [],
            bound: true,
            disabled: false,
        };
        // 第一次读取（打开面板）还没有它；创建成功后重新读取才出现 —— 这正是真栈的行为。
        apiMock.getWorkspaceAgents.mockResolvedValueOnce([]).mockResolvedValueOnce([created]);
        apiMock.createAgentPrincipal.mockResolvedValue({
            principalId: created.principalId,
            templateId: null,
            templateName: null,
            createdAt: created.createdAt,
            scope: "PERSONAL",
            ownerUserId: "99999999-9999-4999-8999-999999999999",
        });
        const wrapper = await mountOpenedPanel();
        expect(
            wrapper.find(`[data-testid="agent-scope-badge-${created.principalId}"]`).exists(),
        ).toBe(false);

        await wrapper.find('[data-testid="agent-principal-name"]').setValue("FreshAgent");
        await wrapper.find('[data-testid="agent-principal-create-form"]').trigger("submit");
        await flushPromises();

        const badge = wrapper.find(`[data-testid="agent-scope-badge-${created.principalId}"]`);
        expect(badge.exists(), "the created principal must appear in the list immediately").toBe(
            true,
        );
        expect(badge.attributes("data-agent-scope")).toBe("personal");
        expect(apiMock.getWorkspaceAgents).toHaveBeenCalledTimes(2);
        wrapper.unmount();
    });
});

// ── 真栈 S2 bug（Lead 2026-11-02）：已存在的（未绑定）agent 在面板里没有绑定入口 ────────────────
// CP 的 GET /workspaces/{ws}/agents 现在会返回调用者自己的 PERSONAL/INSTANCE 主体（V4），
// 但它们**未绑定**时无法建会话（403 not bound）；而 UI 只在"刚创建"的区块里给 bind 按钮，
// 关掉重开后就没有入口了 —— 用户视角是死路。
describe("WorkspaceAgentsPanel bind an existing agent row", () => {
    const existing = {
        principalId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
        name: "Existing personal",
        templateId: null,
        templateName: null,
        createdAt: "2026-11-02T00:00:00Z",
        source: "personal",
        permissionsSnapshot: [],
        bound: true,
        disabled: false,
    };

    it("offers a row-level bind that PUTs the workspace cap and refreshes the list", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([existing]);
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        apiMock.updateWorkspaceAgentCap.mockResolvedValue({});
        const wrapper = await mountOpenedPanel();

        const bindRow = wrapper.find(`[data-testid="agent-bind-row-${existing.principalId}"]`);
        expect(
            bindRow.exists(),
            "an existing agent row must offer a way to bind it to this workspace",
        ).toBe(true);

        await bindRow.trigger("click");
        await flushPromises();

        expect(apiMock.updateWorkspaceAgentCap).toHaveBeenCalledWith(
            WORKSPACE_ID,
            existing.principalId,
            [],
        );
        // 绑定后必须重新读取列表（与创建后的刷新同一口径）。
        expect(apiMock.getWorkspaceAgents).toHaveBeenCalledTimes(2);
        wrapper.unmount();
    });

    it("keeps the row-level bind disabled without MANAGE_WORKSPACE_AGENTS (fail-closed)", async () => {
        admin.value = false;
        apiMock.getWorkspaceAgents.mockResolvedValue([existing]);
        apiMock.getSelfPermissions.mockResolvedValue(PERSONAL_ONLY);
        const wrapper = await mountOpenedPanel();
        const bindRow = wrapper.find(`[data-testid="agent-bind-row-${existing.principalId}"]`);
        expect(bindRow.attributes("disabled")).toBeDefined();
        wrapper.unmount();
    });
});

// PLAN-0622 D26：未绑定的行要显式标「未绑定」，否则用户以为它已经能用。
describe("WorkspaceAgentsPanel unbound badge", () => {
    it("marks a row without a workspace binding", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([
            {
                principalId: "cccccccc-3333-4333-8333-cccccccccccc",
                name: "Not bound yet",
                templateId: null,
                templateName: null,
                createdAt: "2026-11-02T00:00:00Z",
                source: "personal",
                permissionsSnapshot: [],
                bound: false,
                disabled: false,
            },
            {
                principalId: "dddddddd-4444-4444-8444-dddddddddddd",
                name: "Bound already",
                templateId: null,
                templateName: null,
                createdAt: "2026-11-02T00:00:00Z",
                source: "workspace",
                permissionsSnapshot: [],
                bound: true,
                disabled: false,
            },
        ]);
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        const wrapper = await mountOpenedPanel();

        const unboundBadge = wrapper.find(
            '[data-testid="agent-unbound-badge-cccccccc-3333-4333-8333-cccccccccccc"]',
        );
        expect(unboundBadge.exists(), "an unbound row must say so").toBe(true);
        expect(unboundBadge.text()).toMatch(/未绑定|Not bound/i);
        expect(
            wrapper
                .find('[data-testid="agent-unbound-badge-dddddddd-4444-4444-8444-dddddddddddd"]')
                .exists(),
            "a bound row must not carry the unbound badge",
        ).toBe(false);
        wrapper.unmount();
    });
});

// PLAN-0622 D27：`disabled` 现在有真实数据（CP 投影），确认「已禁用」徽标与禁用按钮同时生效。
describe("WorkspaceAgentsPanel disabled row", () => {
    it("shows the disabled badge and disables the disable button for a disabled agent", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([
            {
                principalId: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee",
                name: "Already disabled",
                templateId: null,
                templateName: null,
                createdAt: "2026-11-02T00:00:00Z",
                source: "personal",
                permissionsSnapshot: [],
                bound: true,
                disabled: true,
            },
        ]);
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        const wrapper = await mountOpenedPanel();

        expect(
            wrapper
                .find('[data-testid="agent-disabled-badge-eeeeeeee-5555-4555-8555-eeeeeeeeeeee"]')
                .exists(),
            "a disabled agent must carry the disabled badge",
        ).toBe(true);
        expect(
            wrapper
                .find(
                    '[data-testid="workspace-agent-disable-eeeeeeee-5555-4555-8555-eeeeeeeeeeee"]',
                )
                .attributes("disabled"),
            "an already disabled agent must not offer the disable action again",
        ).toBeDefined();
        wrapper.unmount();
    });
});

describe("WorkspaceAgentsPanel hook subscriptions (PLAN-0625 M3, read-only)", () => {
    // The document below is the wire shape (`advisors[].on`), i.e. exactly what
    // `api.getWorkspaceAgents` hands the component — no second shape is invented here.
    const guardAgent = {
        principalId: "88888888-8888-4888-8888-888888888888",
        name: "guardian",
        templateId: null,
        templateName: null,
        createdAt: "2026-11-02T00:00:00Z",
        permissionsSnapshot: [],
        bound: true,
        disabled: false,
        source: "workspace",
        hooks: { advisors: [{ kind: "guard", on: ["approval.ask"] }] },
    };

    it("renders the advisor kinds and the action classes from advisors[].on", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([guardAgent]);
        const wrapper = await mountOpenedPanel();

        const line = wrapper.get(
            '[data-testid="agent-hooks-88888888-8888-4888-8888-888888888888"]',
        );
        expect(line.text()).toContain("guard");
        expect(line.text()).toContain("approval.ask");
        // 只读：该行没有任何可编辑控件。
        expect(line.find("input, select, button").exists()).toBe(false);
    });

    it("merges the action classes of several advisors without repeating them", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([
            {
                ...guardAgent,
                hooks: {
                    advisors: [
                        { kind: "guard", on: ["approval.ask"] },
                        { kind: "lint", on: ["approval.ask"] },
                    ],
                },
            },
        ]);
        const wrapper = await mountOpenedPanel();

        const line = wrapper.get(
            '[data-testid="agent-hooks-88888888-8888-4888-8888-888888888888"]',
        );
        expect(line.text()).toContain("guard、lint");
        expect(line.text().match(/approval\.ask/g)?.length).toBe(1);
    });

    it("renders no hooks line when the principal carries null subscriptions", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([{ ...guardAgent, hooks: null }]);
        const wrapper = await mountOpenedPanel();

        expect(wrapper.find('[data-testid^="agent-hooks-"]').exists()).toBe(false);
    });

    it("renders no hooks line when the ancestors carry no advisors", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([{ ...guardAgent, hooks: { advisors: [] } }]);
        const wrapper = await mountOpenedPanel();

        expect(wrapper.find('[data-testid^="agent-hooks-"]').exists()).toBe(false);
    });
});

// ── PLAN-0629 M1-4 C：只读「记忆」区（四态 + 404 不当崩溃 + 无写入控件） ────────────────
describe("WorkspaceAgentsPanel PLAN-0629 read-only memory", () => {
    const PRINCIPAL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const agentWithMemory = {
        principalId: PRINCIPAL_ID,
        name: "memo agent",
        templateId: null,
        templateName: null,
        createdAt: "2026-11-02T00:00:00Z",
        permissionsSnapshot: [],
        bound: true,
        disabled: false,
        source: "personal",
        ownerUserId: "99999999-9999-4999-8999-999999999999",
    };
    const toggle = `[data-testid="agent-memory-toggle-${PRINCIPAL_ID}"]`;

    it("lists the rows the server returned (pinned / updatedAt / content; no type badge)", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([agentWithMemory]);
        apiMock.getWorkspaceAgentMemories.mockResolvedValue([
            {
                id: "memory-1",
                pinned: true,
                updatedAt: "2026-11-02T10:00:00Z",
                content: "偏好中文回答",
            },
            {
                id: "memory-2",
                pinned: false,
                updatedAt: "2026-11-02T11:00:00Z",
                content: "项目使用 Vue 3",
            },
        ]);
        const wrapper = await mountOpenedPanel();

        await wrapper.get(toggle).trigger("click");
        await flushPromises();

        expect(apiMock.getWorkspaceAgentMemories).toHaveBeenCalledWith(WORKSPACE_ID, PRINCIPAL_ID);
        const items = wrapper.findAll('[data-testid^="agent-memory-item-"]');
        expect(items).toHaveLength(2);
        // 用户裁定 v2：CP 删 type 列 ⇒ UI 不再有 profile/fact 徽标。
        expect(wrapper.find('[data-testid^="agent-memory-type-"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="agent-memory-pinned-memory-1"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-memory-pinned-memory-2"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="agent-memory-updated-memory-1"]').text()).toContain(
            "更新于",
        );
        expect(wrapper.get('[data-testid="agent-memory-content-memory-2"]').text()).toContain(
            "项目使用 Vue 3",
        );
        // 只读语义必须在 UI 上说清，否则会被当成"存不进去的 bug"。
        expect(wrapper.get('[data-testid="agent-memory-readonly-hint"]').text()).toContain(
            "记忆写入在后续版本开放",
        );
        // 只读：记忆区内没有任何写入/编辑控件，只有一个重试按钮的容身处也不该出现。
        const panel = wrapper.get(`[data-testid="agent-memory-panel-${PRINCIPAL_ID}"]`);
        expect(panel.find("input, textarea, select").exists()).toBe(false);
        expect(panel.find('[data-testid^="agent-memory-retry-"]').exists()).toBe(false);
    });

    it("shows the explicit empty-state copy instead of a blank area", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([agentWithMemory]);
        apiMock.getWorkspaceAgentMemories.mockResolvedValue([]);
        const wrapper = await mountOpenedPanel();

        await wrapper.get(toggle).trigger("click");
        await flushPromises();

        expect(wrapper.get('[data-testid="agent-memory-empty"]').text()).toBe(
            "该主体暂无记忆（记忆写入需 MEMORY_WRITE 授权）",
        );
        expect(wrapper.find('[data-testid="agent-memory-list"]').exists()).toBe(false);
    });

    it("shows the loading state while the request is in flight", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([agentWithMemory]);
        let resolve!: (rows: unknown[]) => void;
        apiMock.getWorkspaceAgentMemories.mockReturnValue(
            new Promise((done) => {
                resolve = done;
            }),
        );
        const wrapper = await mountOpenedPanel();

        await wrapper.get(toggle).trigger("click");
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-memory-loading"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-memory-empty"]').exists()).toBe(false);

        resolve([]);
        await flushPromises();
        expect(wrapper.find('[data-testid="agent-memory-loading"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="agent-memory-empty"]').exists()).toBe(true);
    });

    it("treats 404 as 'no permission or not found' and offers a retry", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([agentWithMemory]);
        apiMock.getWorkspaceAgentMemories.mockRejectedValueOnce(
            new ApiError("AGENT_PRINCIPAL_NOT_FOUND"),
        );
        const wrapper = await mountOpenedPanel();

        await wrapper.get(toggle).trigger("click");
        await flushPromises();

        const failed = wrapper.get('[data-testid="agent-memory-failed"]');
        expect(failed.text()).toContain("无权限查看该主体的记忆，或该主体不存在");
        expect(wrapper.find('[role="alert"]').text()).toContain("无权限");

        // 重试走同一路径，成功后回到列表态（失败不是死路）。
        apiMock.getWorkspaceAgentMemories.mockResolvedValueOnce([
            {
                id: "memory-3",
                type: "fact",
                pinned: false,
                updatedAt: "2026-11-02T12:00:00Z",
                content: "retry worked",
            },
        ]);
        await wrapper.get(`[data-testid="agent-memory-retry-${PRINCIPAL_ID}"]`).trigger("click");
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-memory-failed"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="agent-memory-item-memory-3"]').exists()).toBe(true);
    });

    it("closes the panel on the second click and drops stale rows", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([agentWithMemory]);
        apiMock.getWorkspaceAgentMemories.mockResolvedValue([
            {
                id: "memory-1",
                type: "profile",
                pinned: false,
                updatedAt: "2026-11-02T10:00:00Z",
                content: "x",
            },
        ]);
        const wrapper = await mountOpenedPanel();

        await wrapper.get(toggle).trigger("click");
        await flushPromises();
        expect(wrapper.get(toggle).attributes("aria-expanded")).toBe("true");

        await wrapper.get(toggle).trigger("click");
        await flushPromises();

        expect(wrapper.get(toggle).attributes("aria-expanded")).toBe("false");
        expect(wrapper.find(`[data-testid="agent-memory-panel-${PRINCIPAL_ID}"]`).exists()).toBe(
            false,
        );
        expect(wrapper.find('[data-testid^="agent-memory-item-"]').exists()).toBe(false);
    });
});

// ── PLAN-0626 M3：生命周期 + 单一宿主（dock 标签 / 移动端弹窗） ────────────────────────
describe("WorkspaceAgentsPanel PLAN-0626 M3 lifecycle", () => {
    it("loads the list and the capability projection once per mount", async () => {
        // 迁移后没有 `open` prop：挂载即打开，加载必须在 onMounted 发生（否则标签打开后是空壳）。
        await mountOpenedPanel();

        expect(apiMock.getWorkspaceAgents).toHaveBeenCalledTimes(1);
        expect(apiMock.getSelfPermissions).toHaveBeenCalledTimes(1);
    });
});

describe("WorkspaceAgentManagementDialog mobile shell (PLAN-0626 M3)", () => {
    function mountShell(open: boolean) {
        return mount(WorkspaceAgentManagementDialog, {
            attachTo: document.body,
            props: { open, workspaceId: WORKSPACE_ID },
            global: {
                plugins: [i18n],
                stubs: { RouterLink: { props: ["to"], template: '<a :href="to"><slot /></a>' } },
            },
        });
    }

    it("renders the same panel body exactly once inside the modal", async () => {
        const wrapper = mountShell(true);
        await flushPromises();

        expect(
            document.querySelectorAll('[data-testid="workspace-agent-management-dialog"]'),
        ).toHaveLength(1);
        expect(wrapper.find('[data-testid="modal-backdrop"]').exists()).toBe(true);
        wrapper.unmount();
    });

    it("mounts no panel while closed — a closed shell is not a hidden copy", async () => {
        // 2026-11-03 的教训：`v-show` 式"存在但隐藏"的副本会让同一 testid 命中两次。
        const wrapper = mountShell(false);
        await flushPromises();

        expect(
            document.querySelectorAll('[data-testid="workspace-agent-management-dialog"]'),
        ).toHaveLength(0);
        expect(apiMock.getWorkspaceAgents).not.toHaveBeenCalled();
        wrapper.unmount();
    });
});

// ── PLAN-0629 M1-5：记忆写入面（v2 裁定）──────────────────────────────────────────
describe("WorkspaceAgentsPanel memory write surface", () => {
    const PRINCIPAL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const MEMORY_WRITE_GRANTED = {
        userId: "99999999-9999-4999-8999-999999999999",
        instanceCapabilities: [],
        instancePermissions: [],
        workspaces: [
            {
                workspaceId: WORKSPACE_ID,
                workspaceAdmin: false,
                permissions: [{ actionClass: "MEMORY_WRITE", resource: WORKSPACE_ID }],
            },
        ],
    };
    const agentWithWritableMemory = {
        principalId: PRINCIPAL_ID,
        name: "writable agent",
        templateId: null,
        templateName: null,
        createdAt: "2026-11-02T00:00:00Z",
        permissionsSnapshot: [],
        bound: true,
        disabled: false,
        source: "workspace",
        ownerUserId: null,
        // 「启用记忆」开关必须与现值合并且不丢其它 key。
        contextPolicy: { window: 5, memory: { policyVersion: 1 } },
    };
    const toggle = `[data-testid="agent-memory-toggle-${PRINCIPAL_ID}"]`;

    async function mountWithMemory() {
        apiMock.getSelfPermissions.mockResolvedValue(MEMORY_WRITE_GRANTED);
        apiMock.getWorkspaceAgents.mockResolvedValue([agentWithWritableMemory]);
        apiMock.getWorkspaceAgentMemories.mockResolvedValue([
            {
                id: "memory-1",
                pinned: false,
                updatedAt: "2026-11-03T10:00:00Z",
                content: "偏好中文回答",
                origin: "manual",
            },
            {
                id: "memory-2",
                pinned: true,
                updatedAt: "2026-11-03T11:00:00Z",
                content: "项目使用 Vue 3",
            },
        ]);
        const wrapper = await mountOpenedPanel();
        await wrapper.get(toggle).trigger("click");
        await flushPromises();
        return wrapper;
    }

    it("creates a memory without a type field and re-reads the list", async () => {
        const wrapper = await mountWithMemory();
        apiMock.createAgentMemory.mockResolvedValue(undefined);

        await wrapper
            .get(`[data-testid="agent-memory-create-open-${PRINCIPAL_ID}"]`)
            .trigger("click");
        await wrapper
            .get(`[data-testid="agent-memory-create-content-${PRINCIPAL_ID}"]`)
            .setValue("本仓库使用 pnpm");
        await wrapper
            .get(`[data-testid="agent-memory-create-save-${PRINCIPAL_ID}"]`)
            .trigger("click");
        await flushPromises();

        expect(apiMock.createAgentMemory).toHaveBeenCalledWith(WORKSPACE_ID, PRINCIPAL_ID, {
            content: "本仓库使用 pnpm",
            pinned: false,
        });
        expect(apiMock.getWorkspaceAgentMemories).toHaveBeenCalledTimes(2);
    });

    it("archives through the confirmation and re-reads the list", async () => {
        const wrapper = await mountWithMemory();
        apiMock.deleteAgentMemory.mockResolvedValue(undefined);

        await wrapper.get('[data-testid="agent-memory-archive-memory-1"]').trigger("click");
        expect(
            wrapper.get('[data-testid="agent-memory-archive-confirm-memory-1"]').text(),
        ).toContain("显示已归档");
        await wrapper
            .get('[data-testid="agent-memory-archive-confirm-button-memory-1"]')
            .trigger("click");
        await flushPromises();

        expect(apiMock.deleteAgentMemory).toHaveBeenCalledWith(
            WORKSPACE_ID,
            PRINCIPAL_ID,
            "memory-1",
        );
        expect(apiMock.getWorkspaceAgentMemories).toHaveBeenCalledTimes(2);
    });

    it("surfaces a write failure instead of pretending success", async () => {
        const wrapper = await mountWithMemory();
        apiMock.createAgentMemory.mockRejectedValue(new Error("boom"));

        await wrapper
            .get(`[data-testid="agent-memory-create-open-${PRINCIPAL_ID}"]`)
            .trigger("click");
        await wrapper
            .get(`[data-testid="agent-memory-create-content-${PRINCIPAL_ID}"]`)
            .setValue("会失败的写入");
        await wrapper
            .get(`[data-testid="agent-memory-create-save-${PRINCIPAL_ID}"]`)
            .trigger("click");
        await flushPromises();

        expect(wrapper.get('[data-testid="agent-memory-action-error"]').exists()).toBe(true);
    });

    it("toggles memory off through the shared Switch and merges the existing contextPolicy", async () => {
        const wrapper = await mountWithMemory();
        apiMock.updateAgentPrincipalContextPolicy.mockResolvedValue(undefined);

        await wrapper.get(`[data-testid="agent-memory-enabled-${PRINCIPAL_ID}"]`).trigger("click");
        await flushPromises();

        expect(apiMock.updateAgentPrincipalContextPolicy).toHaveBeenCalledWith(PRINCIPAL_ID, {
            window: 5,
            memory: { policyVersion: 1, enabled: false },
        });
    });

    it("requests the archived view when 显示已归档 is on, and renders origin only when present", async () => {
        const wrapper = await mountWithMemory();

        // origin chip：有 origin 的行渲染，缺字段的行不渲染（不上默认值）。
        expect(wrapper.get('[data-testid="agent-memory-origin-memory-1"]').text()).toContain(
            "手动",
        );
        expect(wrapper.find('[data-testid="agent-memory-origin-memory-2"]').exists()).toBe(false);

        await wrapper
            .get(`[data-testid="agent-memory-show-archived-${PRINCIPAL_ID}"]`)
            .trigger("click");
        await flushPromises();

        expect(apiMock.getWorkspaceAgentMemories).toHaveBeenLastCalledWith(
            WORKSPACE_ID,
            PRINCIPAL_ID,
            "all",
        );
    });
});

// ── PLAN-0667 M3：角色 / 技能区块（列表 + 绑定/解绑 + 409 三类码 + 无硬编码中文） ──────────
describe("WorkspaceAgentsPanel PLAN-0667 roles & skills", () => {
    const PRINCIPAL_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const rbacAgent = {
        principalId: PRINCIPAL_ID,
        name: "rbac agent",
        templateId: null,
        templateName: null,
        createdAt: "2026-11-02T00:00:00Z",
        permissionsSnapshot: [],
        bound: true,
        disabled: false,
        source: "personal",
        ownerUserId: "99999999-9999-4999-8999-999999999999",
    };
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
    const rolesToggle = `[data-testid="agent-roles-toggle-${PRINCIPAL_ID}"]`;

    beforeEach(() => {
        apiMock.getWorkspaceAgents.mockResolvedValue([rbacAgent]);
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_MANAGE);
        apiMock.getAgentRoles.mockResolvedValue([
            {
                bindingId: "binding-system",
                roleId: "role-seed",
                name: "AGENT_SPAWNER",
                scope: "instance",
                isSystem: true,
                atomSummary: ["读取", "执行"],
            },
            {
                bindingId: "binding-editor",
                roleId: "role-editor",
                name: "WS_EDITOR",
                scope: "workspace",
                isSystem: false,
                atomSummary: ["读取", "写入", "执行"],
            },
        ]);
        apiMock.getAgentSkills.mockResolvedValue([
            { bindingId: "skill-binding-1", skillId: "skill-1", name: "contract-review" },
        ]);
        apiMock.listRoles.mockResolvedValue([
            { id: "role-editor", name: "WS_EDITOR", displayName: "Workspace editor" },
        ]);
        apiMock.getSkills.mockResolvedValue([
            { skillId: "skill-2", name: "test-case-writing", definitionScope: null },
        ]);
    });

    it("lists name / scope / system badge / derived-atom summary and never unbinds a system binding", async () => {
        const wrapper = await mountOpenedPanel();
        await wrapper.get(rolesToggle).trigger("click");
        await flushPromises();

        const system = wrapper.get('[data-testid="agent-role-item-binding-system"]');
        expect(system.text()).toContain("AGENT_SPAWNER");
        expect(system.text()).toContain("instance");
        expect(system.text()).toContain(i18n.global.t("workspace.agentRoleSystemBadge"));
        // D5(b)：只渲染摘要，不展开全集。
        expect(system.text()).toContain(
            i18n.global.t("workspace.agentRoleAtomsSummary", { atoms: "读取 · 执行" }),
        );
        expect(wrapper.find('[data-testid="agent-role-unbind-binding-system"]').exists()).toBe(
            false,
        );

        const editor = wrapper.get('[data-testid="agent-role-item-binding-editor"]');
        expect(editor.text()).toContain("WS_EDITOR");
        await wrapper.get('[data-testid="agent-role-unbind-binding-editor"]').trigger("click");
        await flushPromises();
        expect(apiMock.unbindAgentRole).toHaveBeenCalledWith(PRINCIPAL_ID, "binding-editor");
    });

    it("binds the selected role and maps 409 AGENT_PRINCIPAL_FORBIDDEN_ATOMS to localized copy", async () => {
        apiMock.bindAgentRole.mockRejectedValue(new ApiError("AGENT_PRINCIPAL_FORBIDDEN_ATOMS"));
        const wrapper = await mountOpenedPanel();
        await wrapper.get(rolesToggle).trigger("click");
        await flushPromises();

        await wrapper
            .get(`[data-testid="agent-role-select-${PRINCIPAL_ID}"]`)
            .setValue("role-editor");
        await wrapper.get(`[data-testid="agent-role-bind-${PRINCIPAL_ID}"]`).trigger("click");
        await flushPromises();

        expect(apiMock.bindAgentRole).toHaveBeenCalledWith(PRINCIPAL_ID, "role-editor");
        expect(wrapper.get('[data-testid="agent-rbac-action-error"]').text()).toBe(
            i18n.global.t("workspace.agentRoleForbiddenAtoms"),
        );
    });

    it("lists skills and unbinds one through the skill endpoint", async () => {
        const wrapper = await mountOpenedPanel();
        await wrapper.get(rolesToggle).trigger("click");
        await flushPromises();

        expect(wrapper.get('[data-testid="agent-skills-list"]').text()).toContain(
            "contract-review",
        );
        await wrapper.get('[data-testid="agent-skill-unbind-skill-binding-1"]').trigger("click");
        await flushPromises();
        expect(apiMock.unbindAgentSkill).toHaveBeenCalledWith(PRINCIPAL_ID, "skill-binding-1");
    });

    it("keeps the section read-only (with explanation) when the projection lacks MANAGE_WORKSPACE_AGENTS", async () => {
        apiMock.getSelfPermissions.mockResolvedValue(CREATE_ACCOUNT_MISSING);
        const wrapper = await mountOpenedPanel();
        await wrapper.get(rolesToggle).trigger("click");
        await flushPromises();

        expect(wrapper.find(`[data-testid="agent-role-bind-${PRINCIPAL_ID}"]`).exists()).toBe(
            false,
        );
        expect(wrapper.find('[data-testid="agent-rbac-readonly-hint"]').exists()).toBe(true);
    });

    it("has no hardcoded CJK copy outside comments (i18n is the single source)", () => {
        const source = readFileSync(
            resolve(process.cwd(), "src/features/workspace/components/WorkspaceAgentsPanel.vue"),
            "utf8",
        );
        const stripped = source
            .replace(/<!--[\s\S]*?-->/g, "")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/[^\n]*/g, "");
        const cjk = stripped.match(/[\u4e00-\u9fff]/g);
        expect(cjk, `hardcoded CJK: ${cjk?.slice(0, 6).join("") ?? ""}`).toBeNull();
    });
});
