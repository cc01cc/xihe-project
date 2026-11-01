import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
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
import WorkspaceAgentManagementDialog from "../WorkspaceAgentManagementDialog.vue";

/** 真实用法：组件常驻、`:open` 由 false → true 触发能力加载（watch 非 immediate），测试照此复现。 */
async function mountOpenedDialog() {
    const wrapper = mount(WorkspaceAgentManagementDialog, {
        attachTo: document.body,
        props: { open: false, workspaceId: WORKSPACE_ID },
        global: {
            plugins: [i18n],
            stubs: { RouterLink: { props: ["to"], template: '<a :href="to"><slot /></a>' } },
        },
    });
    await wrapper.setProps({ open: true });
    await flushPromises();
    return wrapper;
}

function mountDialog() {
    return mount(WorkspaceAgentManagementDialog, {
        attachTo: document.body,
        props: { open: true, workspaceId: WORKSPACE_ID },
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
});

afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
});

describe("WorkspaceAgentManagementDialog F-02 grant hint (PLAN-0585 M2 / PLAN-0610 W5c)", () => {
    it("shows a localized actionable hint plus a link to the role surface for admins", async () => {
        const wrapper = mountDialog();
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
        const wrapper = await mountOpenedDialog();

        await wrapper.find('[data-testid="agent-principal-name"]').setValue("Research Agent");
        await wrapper.find('[data-testid="agent-principal-create-form"]').trigger("submit");
        await flushPromises();

        const text = document.body.textContent ?? "";
        expect(text).toContain("缺少 CREATE_ACCOUNT 权限");
        expect(text).toContain("角色与绑定");
        expect(text).not.toContain("CREATE_ACCOUNT permission is required");
    });

    it("hides the grant-panel link from non-admins but keeps the actionable note", async () => {
        admin.value = false;
        const wrapper = mountDialog();
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-grant-panel-link"]').exists()).toBe(false);
        expect(wrapper.text()).toContain("角色与绑定");
    });
});

// PLAN-0621 F-01：没有 CREATE_ACCOUNT 的用户在**点击之前**就该知道结果。
describe("WorkspaceAgentManagementDialog F-01 create gating (PLAN-0621)", () => {
    it("disables creation and points at the role surface when the CP projection lacks CREATE_ACCOUNT", async () => {
        admin.value = false;
        apiMock.getSelfPermissions.mockResolvedValue(CREATE_ACCOUNT_MISSING);
        const wrapper = await mountOpenedDialog();
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
        const wrapper = await mountOpenedDialog();

        await wrapper.find('[data-testid="agent-principal-name"]').setValue("delegate");
        const button = wrapper.find('[data-testid="agent-principal-create"]');
        expect(button.attributes("disabled")).toBeUndefined();
        expect(wrapper.find('[data-testid="agent-create-forbidden-hint"]').exists()).toBe(false);
    });

    it("fails closed when the projection cannot be loaded, without inventing a permission", async () => {
        admin.value = false;
        apiMock.getSelfPermissions.mockRejectedValue(new ApiError("FORBIDDEN"));
        const wrapper = await mountOpenedDialog();
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

function scopeOptions(wrapper: Awaited<ReturnType<typeof mountOpenedDialog>>): string[] {
    const select = wrapper.find('[data-testid="agent-principal-scope"]');
    if (!select.exists()) return [];
    return select.findAll("option").map((option) => option.attributes("value") ?? "");
}

describe("WorkspaceAgentManagementDialog PLAN-0622 scope visibility (4 states)", () => {
    it("offers only PERSONAL when the projection grants just CREATE_OWN_AGENT", async () => {
        apiMock.getSelfPermissions.mockResolvedValue(PERSONAL_ONLY);
        const wrapper = await mountOpenedDialog();
        expect(scopeOptions(wrapper)).toEqual(["PERSONAL"]);
        // 术语对账：文案必须带 agent 限定，不能与"连接作用域"撞词。
        expect(wrapper.text()).toContain("个人 agent");
    });

    it("offers only WORKSPACE when MANAGE_WORKSPACE_AGENTS is granted for this Workspace", async () => {
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        const wrapper = await mountOpenedDialog();
        expect(scopeOptions(wrapper)).toEqual(["WORKSPACE"]);
        expect(wrapper.text()).toContain("工作区 agent");
    });

    it("offers only INSTANCE when the projection grants CREATE_ACCOUNT", async () => {
        apiMock.getSelfPermissions.mockResolvedValue(INSTANCE_ONLY);
        const wrapper = await mountOpenedDialog();
        expect(scopeOptions(wrapper)).toEqual(["INSTANCE"]);
        expect(wrapper.text()).toContain("实例 agent");
    });

    it("offers nothing and keeps creation disabled when no atom is granted (fail-closed)", async () => {
        admin.value = false;
        apiMock.getSelfPermissions.mockResolvedValue(NOTHING);
        const wrapper = await mountOpenedDialog();
        expect(wrapper.find('[data-testid="agent-principal-scope"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="agent-scope-unavailable"]').exists()).toBe(true);
        expect(
            wrapper.find('[data-testid="agent-principal-create"]').attributes("disabled"),
        ).toBeDefined();
    });
});

describe("WorkspaceAgentManagementDialog PLAN-0622 model intent", () => {
    it("blocks creation until an allowed-model row has both provider and model", async () => {
        apiMock.getSelfPermissions.mockResolvedValue(PERSONAL_ONLY);
        const wrapper = await mountOpenedDialog();
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
        const wrapper = await mountOpenedDialog();
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
        const wrapper = await mountOpenedDialog();
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

describe("WorkspaceAgentManagementDialog PLAN-0622 list rows", () => {
    const boundAgent = {
        principalId: "77777777-7777-4777-8777-777777777777",
        name: "helper",
        templateId: null,
        templateName: null,
        createdAt: "2026-11-02T00:00:00Z",
        permissionsSnapshot: [],
        source: "personal",
        ownerUserId: "99999999-9999-4999-8999-999999999999",
        defaultModelProvider: "openai",
        defaultModelName: "gpt-4o-mini",
        allowedModels: [{ provider: "openai", model: "gpt-4o-mini" }],
    };

    it("shows the source badge and the default model for each row", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([boundAgent]);
        const wrapper = await mountOpenedDialog();
        const badge = wrapper.find(
            '[data-testid="agent-scope-badge-77777777-7777-4777-8777-777777777777"]',
        );
        expect(badge.exists()).toBe(true);
        expect(badge.attributes("data-agent-scope")).toBe("personal");
        expect(badge.text()).toBe("个人 agent");
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
        const wrapper = await mountOpenedDialog();
        const button = wrapper.find(
            '[data-testid="workspace-agent-disable-77777777-7777-4777-8777-777777777777"]',
        );
        expect(wrapper.text()).toContain("禁用后新会话不能再选择该 Agent");

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
        const wrapper = await mountOpenedDialog();
        const button = wrapper.find(
            '[data-testid="workspace-agent-disable-77777777-7777-4777-8777-777777777777"]',
        );
        expect(button.attributes("disabled")).toBeDefined();
    });
});

// ── 真栈 bug（Lead 2026-11-02）：创建成功后列表不刷新，用户要关掉重开面板才看到新 agent ──────
describe("WorkspaceAgentManagementDialog list refresh after create", () => {
    it("shows the newly created principal without reopening the dialog", async () => {
        const created = {
            principalId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
            name: "Fresh agent",
            templateId: null,
            templateName: null,
            createdAt: "2026-11-02T00:00:00Z",
            source: "personal",
            permissionsSnapshot: [],
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
        const wrapper = await mountOpenedDialog();
        expect(
            wrapper.find(`[data-testid="agent-scope-badge-${created.principalId}"]`).exists(),
        ).toBe(false);

        await wrapper.find('[data-testid="agent-principal-name"]').setValue("Fresh agent");
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
describe("WorkspaceAgentManagementDialog bind an existing agent row", () => {
    const existing = {
        principalId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
        name: "Existing personal",
        templateId: null,
        templateName: null,
        createdAt: "2026-11-02T00:00:00Z",
        source: "personal",
        permissionsSnapshot: [],
    };

    it("offers a row-level bind that PUTs the workspace cap and refreshes the list", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([existing]);
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        apiMock.updateWorkspaceAgentCap.mockResolvedValue({});
        const wrapper = await mountOpenedDialog();

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
        const wrapper = await mountOpenedDialog();
        const bindRow = wrapper.find(`[data-testid="agent-bind-row-${existing.principalId}"]`);
        expect(bindRow.attributes("disabled")).toBeDefined();
        wrapper.unmount();
    });
});
