import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { i18n } from "../../../i18n";

const TARGET = "grant-target";
const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

const apiMock = vi.hoisted(() => ({
    getPrincipalGrants: vi.fn<(username: string) => Promise<unknown>>(),
    patchPrincipalGrants: vi.fn<(username: string, patch: unknown) => Promise<unknown>>(),
    listWorkspaces: vi.fn<() => Promise<unknown[]>>(),
}));

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        api: apiMock,
        // Minimal ApiError stand-in: `message` is the CP's English detail, which the view must
        // never render for a known problem code.
        ApiError: class MockApiError extends Error {
            problem: { code: string; detail?: string };
            constructor(code: string) {
                super("server english detail that must never surface");
                this.name = "ApiError";
                this.problem = { code, detail: "server english detail that must never surface" };
            }
        },
    };
});

const admin = { value: true };
vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({ isAdmin: admin.value }),
}));

vi.mock("../../../lib/logger", () => ({
    logger: { warn: vi.fn<() => void>(), info: vi.fn<() => void>() },
}));

import { ApiError } from "../../../composables/api";
import PrincipalGrantsView from "../PrincipalGrantsView.vue";

type Wrapper = ReturnType<typeof mount>;

async function mountView(): Promise<Wrapper> {
    const wrapper = mount(PrincipalGrantsView, {
        attachTo: document.body,
        global: { plugins: [i18n] },
    });
    await flushPromises();
    return wrapper;
}

async function loadTarget(wrapper: Wrapper, username = TARGET) {
    await wrapper.find('[data-testid="principal-grant-username"]').setValue(username);
    await wrapper.find('[data-testid="principal-grant-form"]').trigger("submit");
    await flushPromises();
}

function emptyView() {
    return { userId: TARGET_ID, username: TARGET, grants: [] };
}

function grantedView() {
    return {
        userId: TARGET_ID,
        username: TARGET,
        grants: [
            { actionClass: "CREATE_ACCOUNT", resource: "*" },
            { actionClass: "MANAGE_WORKSPACE_AGENTS", resource: WORKSPACE_ID },
        ],
    };
}

function failWith(code: string) {
    const ErrorCtor = ApiError as unknown as new (code: string) => Error;
    return new ErrorCtor(code);
}

beforeEach(() => {
    admin.value = true;
    apiMock.listWorkspaces.mockResolvedValue([{ id: WORKSPACE_ID, name: "Default Workspace" }]);
    apiMock.getPrincipalGrants.mockResolvedValue(emptyView());
    apiMock.patchPrincipalGrants.mockResolvedValue({ ...emptyView(), changed: true });
});

afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
});

describe("PrincipalGrantsView", () => {
    it("renders a forbidden state for non-admins and never loads grants", async () => {
        admin.value = false;
        const wrapper = await mountView();
        expect(wrapper.find('[data-testid="principal-grant-forbidden"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="principal-grant-username"]').exists()).toBe(false);
        expect(apiMock.getPrincipalGrants).not.toHaveBeenCalled();
        expect(apiMock.listWorkspaces).not.toHaveBeenCalled();
    });

    it("loads a target by exact username and mirrors the granted atoms", async () => {
        apiMock.getPrincipalGrants.mockResolvedValue(grantedView());
        const wrapper = await mountView();
        await loadTarget(wrapper);

        expect(apiMock.getPrincipalGrants).toHaveBeenCalledWith(TARGET);
        expect(wrapper.find('[data-testid="principal-grant-identity"]').text()).toContain(
            TARGET_ID,
        );
        const checkbox = wrapper.find('[data-testid="principal-grant-create-account"]');
        expect((checkbox.element as HTMLInputElement).checked).toBe(true);
        expect(wrapper.findAll('[data-testid="principal-grant-workspace-row"]')).toHaveLength(1);
        expect(wrapper.text()).toContain(WORKSPACE_ID);
    });

    it("sends only the difference and reports changed:true", async () => {
        const wrapper = await mountView();
        await loadTarget(wrapper);

        await wrapper.find('[data-testid="principal-grant-create-account"]').setValue(true);
        await wrapper.find('[data-testid="principal-grant-save"]').trigger("click");
        await flushPromises();

        expect(apiMock.patchPrincipalGrants).toHaveBeenCalledTimes(1);
        expect(apiMock.patchPrincipalGrants).toHaveBeenCalledWith(TARGET, {
            add: [{ actionClass: "CREATE_ACCOUNT", resource: "*" }],
            remove: [],
        });
        expect(wrapper.find('[data-testid="principal-grant-notice"]').text()).toContain(
            "授权已更新",
        );
    });

    it("surfaces changed:false as an idempotent replay, not as an error", async () => {
        apiMock.getPrincipalGrants.mockResolvedValue(grantedView());
        apiMock.patchPrincipalGrants.mockResolvedValue({ ...grantedView(), changed: false });
        const wrapper = await mountView();
        await loadTarget(wrapper);

        await wrapper.find('[data-testid="principal-grant-save"]').trigger("click");
        await flushPromises();

        expect(wrapper.find('[data-testid="principal-grant-notice"]').text()).toContain(
            "没有实际变更",
        );
        expect(wrapper.find('[data-testid="principal-grant-error"]').exists()).toBe(false);
    });

    it("requires a valid workspace UUID before granting MANAGE_WORKSPACE_AGENTS", async () => {
        const wrapper = await mountView();
        await loadTarget(wrapper);

        const input = wrapper.find('[data-testid="principal-grant-workspace-input"]');
        await input.setValue("not-a-uuid");
        await wrapper.find('[data-testid="principal-grant-workspace-add"]').trigger("click");
        expect(wrapper.find('[data-testid="principal-grant-error"]').text()).toContain(
            "UUID 格式不正确",
        );
        expect(wrapper.findAll('[data-testid="principal-grant-workspace-row"]')).toHaveLength(0);

        await input.setValue(WORKSPACE_ID.toUpperCase());
        await wrapper.find('[data-testid="principal-grant-workspace-add"]').trigger("click");
        expect(wrapper.findAll('[data-testid="principal-grant-workspace-row"]')).toHaveLength(1);

        await wrapper.find('[data-testid="principal-grant-save"]').trigger("click");
        await flushPromises();
        expect(apiMock.patchPrincipalGrants).toHaveBeenCalledWith(TARGET, {
            add: [{ actionClass: "MANAGE_WORKSPACE_AGENTS", resource: WORKSPACE_ID }],
            remove: [],
        });
    });

    it("removes a previously granted workspace through the difference set", async () => {
        apiMock.getPrincipalGrants.mockResolvedValue(grantedView());
        const wrapper = await mountView();
        await loadTarget(wrapper);

        await wrapper.find('[data-testid="principal-grant-workspace-remove"]').trigger("click");
        expect(wrapper.findAll('[data-testid="principal-grant-workspace-row"]')).toHaveLength(0);

        await wrapper.find('[data-testid="principal-grant-save"]').trigger("click");
        await flushPromises();
        expect(apiMock.patchPrincipalGrants).toHaveBeenCalledWith(TARGET, {
            add: [],
            remove: [{ actionClass: "MANAGE_WORKSPACE_AGENTS", resource: WORKSPACE_ID }],
        });
    });

    const errorCases: Array<[string, string]> = [
        ["USER_NOT_FOUND", "找不到该用户名对应的账号"],
        ["FORBIDDEN", "没有权限执行该操作"],
        ["UNMANAGEABLE_ACTION_CLASS", "不能在此页面授予"],
        ["INVALID_GRANT_RESOURCE", "资源不合法"],
        ["DIRECT_GRANT_CONFLICT", "刚被并发修改"],
        ["OPERATION_LOCK_TIMEOUT", "锁等待超时"],
        ["INVALID_REQUEST", "请求不合法"],
        ["SOMETHING_ELSE", "操作失败"],
    ];

    for (const [code, expected] of errorCases) {
        it(`maps ${code} to localized copy without leaking the raw detail`, async () => {
            apiMock.getPrincipalGrants.mockRejectedValue(failWith(code));
            const wrapper = await mountView();
            await loadTarget(wrapper);

            const error = wrapper.find('[data-testid="principal-grant-error"]');
            expect(error.exists()).toBe(true);
            expect(error.text()).toContain(expected);
            expect(error.text()).not.toContain("server english detail");
        });
    }

    it("rejects an empty username before calling the API", async () => {
        const wrapper = await mountView();
        await wrapper.find('[data-testid="principal-grant-form"]').trigger("submit");
        await flushPromises();

        expect(apiMock.getPrincipalGrants).not.toHaveBeenCalled();
        expect(wrapper.find('[data-testid="principal-grant-error"]').text()).toContain("请先输入");
    });
});
