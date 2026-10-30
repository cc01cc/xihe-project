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
}));

vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        api: apiMock,
        ApiError: class MockApiError extends Error {
            problem: { code: string; detail?: string };
            constructor(code: string) {
                super("CREATE_ACCOUNT permission is required");
                this.name = "ApiError";
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
});

afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
});

describe("WorkspaceAgentManagementDialog F-02 grant hint (PLAN-0585 M2)", () => {
    it("shows a localized actionable hint plus a grant-panel link to admins", async () => {
        const wrapper = mountDialog();
        await flushPromises();

        const link = wrapper.find('[data-testid="agent-grant-panel-link"]');
        expect(link.exists()).toBe(true);
        expect(link.attributes("href")).toBe("/settings/principal-grants");
        // The static note now names the admin panel instead of only stating the requirement.
        expect(wrapper.text()).toContain("Principal 授权");
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
        expect(text).toContain("Principal 授权");
        expect(text).not.toContain("CREATE_ACCOUNT permission is required");
    });

    it("hides the grant-panel link from non-admins but keeps the actionable note", async () => {
        admin.value = false;
        const wrapper = mountDialog();
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-grant-panel-link"]').exists()).toBe(false);
        expect(wrapper.text()).toContain("Principal 授权");
    });
});
