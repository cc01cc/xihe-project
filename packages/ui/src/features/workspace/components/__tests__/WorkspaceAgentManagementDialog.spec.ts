import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { i18n } from "../../../../i18n";

const WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";

const apiMock = vi.hoisted(() => ({
    getWorkspaceAgents: vi.fn<() => Promise<unknown[]>>(),
    getAgentTemplates: vi.fn<() => Promise<unknown>>(),
    createAgentPrincipal: vi.fn<(name: string, templateId?: string) => Promise<unknown>>(),
    updateWorkspaceAgentCap: vi.fn<() => Promise<unknown>>(),
    deleteWorkspaceAgent: vi.fn<() => Promise<void>>(),
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
        const wrapper = mountDialog();
        await flushPromises();

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
    /** 真实用法：组件常驻、`:open` 由 false → true 触发加载（watch 非 immediate），测试照此复现。 */
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
            name: "delegate",
            permissions: [],
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
