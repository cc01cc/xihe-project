import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { i18n } from "../../../../i18n";

const WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";

const OWNER = {
    userId: "11111111-1111-4111-8111-111111111111",
    username: "owner",
    email: "owner@test.com",
    name: "Owner",
    role: "OWNER",
    createdAt: "2026-10-28T00:00:00Z",
};
const EDITOR = {
    userId: "22222222-2222-4222-8222-222222222222",
    username: "editor",
    email: "editor@test.com",
    name: "Editor",
    role: "EDITOR",
    createdAt: "2026-10-28T01:00:00Z",
};

const apiMock = vi.hoisted(() => ({
    listWorkspaceMembers: vi.fn<() => Promise<unknown[]>>(),
    addWorkspaceMember: vi.fn<(input: { username: string; role: string }) => Promise<unknown>>(),
    updateWorkspaceMemberRole: vi.fn<(userId: string, role: string) => Promise<unknown>>(),
    removeWorkspaceMember: vi.fn<(workspaceId: string, userId: string) => Promise<void>>(),
}));

vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        api: apiMock,
        // PLAN-0565: minimal ApiError stand-in carrying problem.code for mapping.
        ApiError: class MockApiError extends Error {
            problem: { code: string };
            constructor(code: string) {
                super(code);
                this.name = "ApiError";
                this.problem = { code };
            }
        },
    };
});

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message?: unknown) => string | number>(),
        error: vi.fn<(message?: unknown) => string | number>(),
        warning: vi.fn<(message?: unknown) => string | number>(),
        info: vi.fn<(message?: unknown) => string | number>(),
    },
}));

async function mountPanel(readonly = false) {
    const { default: WorkspaceMembersPanel } = await import("../WorkspaceMembersPanel.vue");
    const wrapper = mount(WorkspaceMembersPanel, {
        attachTo: document.body,
        props: { workspaceId: WORKSPACE_ID, readonly },
        global: { plugins: [i18n] },
    });
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    apiMock.listWorkspaceMembers.mockResolvedValue([
        structuredClone(OWNER),
        structuredClone(EDITOR),
    ]);
    apiMock.addWorkspaceMember.mockResolvedValue({ ...EDITOR, role: "VIEWER" });
    apiMock.updateWorkspaceMemberRole.mockResolvedValue({ ...EDITOR, role: "VIEWER" });
    apiMock.removeWorkspaceMember.mockResolvedValue(undefined);
});

afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
});

describe("WorkspaceMembersPanel", () => {
    it("loads and renders members with identity fields", async () => {
        const wrapper = await mountPanel();
        expect(wrapper.findAll('[data-testid="ws-members-row"]')).toHaveLength(2);
        expect(wrapper.text()).toContain("owner");
        expect(wrapper.text()).toContain("editor@test.com");
        expect(apiMock.listWorkspaceMembers).toHaveBeenCalledWith(WORKSPACE_ID);
    });

    it("adds a member by username with the selected role", async () => {
        const wrapper = await mountPanel();
        await wrapper.find('[data-testid="ws-members-add-input"]').setValue("newmember");
        await wrapper.find('[data-testid="ws-members-add-btn"]').trigger("click");
        await flushPromises();

        expect(apiMock.addWorkspaceMember).toHaveBeenCalledWith(WORKSPACE_ID, {
            username: "newmember",
            role: "EDITOR",
        });
        expect(apiMock.listWorkspaceMembers).toHaveBeenCalledTimes(2);
    });

    it("surfaces the ruling-6 copy for unknown usernames", async () => {
        const { ApiError } = await import("../../../../composables/api");
        apiMock.addWorkspaceMember.mockRejectedValue(new ApiError("USER_NOT_FOUND"));
        const wrapper = await mountPanel();
        await wrapper.find('[data-testid="ws-members-add-input"]').setValue("ghost");
        await wrapper.find('[data-testid="ws-members-add-btn"]').trigger("click");
        await flushPromises();

        expect(wrapper.text()).toContain("该用户不存在，请对方先注册");
        expect(apiMock.listWorkspaceMembers).toHaveBeenCalledTimes(1);
    });

    it("maps already-exists and last-owner codes to localized copy", async () => {
        const { ApiError } = await import("../../../../composables/api");
        const wrapper = await mountPanel();

        apiMock.addWorkspaceMember.mockRejectedValue(new ApiError("MEMBER_ALREADY_EXISTS"));
        await wrapper.find('[data-testid="ws-members-add-input"]').setValue("owner");
        await wrapper.find('[data-testid="ws-members-add-btn"]').trigger("click");
        await flushPromises();
        expect(wrapper.text()).toContain("该用户已是工作区成员");

        apiMock.updateWorkspaceMemberRole.mockRejectedValue(new ApiError("LAST_OWNER"));
        const editorRow = wrapper.findAll('[data-testid="ws-members-row"]')[1];
        await editorRow.find("select").setValue("VIEWER");
        await flushPromises();
        expect(wrapper.text()).toContain("不能移除或降级唯一所有者");
    });

    it("locks owner-row role select and hides write affordances in readonly mode", async () => {
        const wrapper = await mountPanel();
        const ownerRow = wrapper.findAll('[data-testid="ws-members-row"]')[0];
        expect(ownerRow.find("select").attributes("disabled")).toBeDefined();
        wrapper.unmount();

        const readonlyWrapper = await mountPanel(true);
        expect(readonlyWrapper.find('[data-testid="ws-members-add"]').exists()).toBe(false);
        expect(readonlyWrapper.text()).toContain("仅工作区所有者可以管理成员。");
        expect(readonlyWrapper.findAll('[data-testid="ws-members-row"]')).toHaveLength(2);
        expect(apiMock.removeWorkspaceMember).not.toHaveBeenCalled();
        readonlyWrapper.unmount();
    });

    it("removes a member through the confirm dialog", async () => {
        const wrapper = await mountPanel();
        const editorRow = wrapper.findAll('[data-testid="ws-members-row"]')[1];
        await editorRow.find('[data-testid^="ws-members-remove-"]').trigger("click");
        await flushPromises();

        expect(
            document.body.querySelector('[data-testid="ws-members-remove-confirm"]'),
        ).not.toBeNull();
        const confirm = document.body.querySelector(
            '[data-testid="ws-members-remove-btn"]',
        ) as HTMLButtonElement | null;
        expect(confirm).not.toBeNull();
        confirm?.click();
        await flushPromises();

        expect(apiMock.removeWorkspaceMember).toHaveBeenCalledWith(WORKSPACE_ID, EDITOR.userId);
        expect(apiMock.listWorkspaceMembers).toHaveBeenCalledTimes(2);
        wrapper.unmount();
    });
});
