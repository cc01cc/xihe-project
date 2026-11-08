import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SessionPolicyControls from "../components/SessionPolicyControls.vue";
import { selectCount, selectValueAt, setSelectValue } from "../../../../test-utils/select";
import { i18n } from "../../../../i18n";
import { ApiError, api } from "../../../../composables/api";
import { useAuthStore } from "../../../../stores/auth";
import type * as apiModule from "../../../../composables/api";

const { toastSuccess } = vi.hoisted(() => ({
    toastSuccess: vi.fn<(message: string) => void>(),
}));

vi.mock("vue-sonner", () => ({ toast: { success: toastSuccess, error: vi.fn<() => void>() } }));

vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            getPolicyMode: vi.fn<typeof apiModule.api.getPolicyMode>(),
            setPolicyMode: vi.fn<typeof apiModule.api.setPolicyMode>(),
        },
    };
});

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function mountControls() {
    return mount(SessionPolicyControls, {
        props: { sessionId: SESSION_ID },
        global: { plugins: [i18n] },
    });
}

beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
});

describe("SessionPolicyControls", () => {
    it("renders only the mode select, without repeating the value in a second chip", async () => {
        vi.mocked(api.getPolicyMode).mockResolvedValue({
            sessionId: SESSION_ID,
            mode: "manual",
            sessionRules: 0,
        });
        const wrapper = mountControls();
        await flushPromises();

        expect(wrapper.findAll('[data-testid="session-policy-mode"]')).toHaveLength(1);
        expect(wrapper.get('[data-testid="session-policy-mode"]').element).toBeTruthy();
        expect(selectCount(wrapper)).toBe(1);
        expect(wrapper.text()).not.toContain("审批模式");
        wrapper.unmount();
    });

    it("shows a localized inline error with retry instead of the raw API string", async () => {
        vi.mocked(api.getPolicyMode).mockRejectedValue(
            new ApiError({
                status: 500,
                code: "POLICY_UNAVAILABLE",
                detail: "Invalid policy mode response",
                requestId: "request-1",
            }),
        );
        const wrapper = mountControls();
        await flushPromises();

        const error = wrapper.get('[data-testid="session-policy-mode-error"]');
        expect(error.text()).toContain("审批模式获取失败");
        expect(error.text()).not.toContain("POLICY_UNAVAILABLE");
        expect(error.text()).not.toContain("Invalid policy mode response");
        expect(error.get('[data-testid="session-policy-mode-retry"]').text()).toBe("重试");

        vi.mocked(api.getPolicyMode).mockResolvedValue({
            sessionId: SESSION_ID,
            mode: "manual",
            sessionRules: 0,
        });
        await error.get('[data-testid="session-policy-mode-retry"]').trigger("click");
        await flushPromises();

        expect(api.getPolicyMode).toHaveBeenCalledTimes(2);
        expect(wrapper.find('[data-testid="session-policy-mode-error"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="session-policy-mode"]').attributes("disabled")).toBe(
            undefined,
        );
        wrapper.unmount();
    });

    it("retries the last requested mode after a failed change", async () => {
        vi.mocked(api.getPolicyMode).mockResolvedValue({
            sessionId: SESSION_ID,
            mode: "manual",
            sessionRules: 0,
        });
        vi.mocked(api.setPolicyMode).mockRejectedValueOnce(
            new ApiError({
                status: 409,
                code: "POLICY_CONFLICT",
                detail: "policy mode changed elsewhere",
                requestId: "request-2",
            }),
        );
        const wrapper = mountControls();
        await flushPromises();

        await setSelectValue(wrapper, '[data-testid="session-policy-mode"]', "auto");
        await flushPromises();

        const error = wrapper.get('[data-testid="session-policy-mode-error"]');
        expect(error.text()).toContain("审批模式切换失败");
        expect(error.text()).not.toContain("POLICY_CONFLICT");

        vi.mocked(api.setPolicyMode).mockResolvedValue({
            sessionId: SESSION_ID,
            mode: "auto",
            scope: "session",
        });
        await error.get('[data-testid="session-policy-mode-retry"]').trigger("click");
        await flushPromises();

        expect(api.setPolicyMode).toHaveBeenCalledTimes(2);
        expect(api.setPolicyMode).toHaveBeenLastCalledWith(SESSION_ID, "auto");
        expect(toastSuccess).toHaveBeenCalled();
        wrapper.unmount();
    });
});

/**
 * BL-311：VIEWER 只读工作区里，policy/mode 的**写入口**必须在点击前就不可用（不是点了才吃
 * 403 `WORKSPACE_READ_ONLY`），而模式**状态仍要可读**。判定源是既有投影 `auth.canWriteWorkspace`
 * （`stores/auth.ts:96-98` = CP `WorkspaceView.canWrite`，旧响应回退 `workspaceRole !== "VIEWER"`）。
 * CP 守卫与 BL-309 的 403/404 契约不变 —— 前端只是 affordance。
 */
describe("SessionPolicyControls read-only workspace (BL-311)", () => {
    function seedWorkspace(workspace: { workspaceRole?: string; canWrite?: boolean }) {
        useAuthStore().$patch({
            workspace: { id: "workspace-1", name: "Workspace", ...workspace },
        });
    }

    it("keeps the mode readable but not operable for a VIEWER", async () => {
        seedWorkspace({ workspaceRole: "VIEWER" });
        vi.mocked(api.getPolicyMode).mockResolvedValue({
            sessionId: SESSION_ID,
            mode: "auto",
            sessionRules: 0,
        });
        const wrapper = mountControls();
        await flushPromises();

        const select = wrapper.get('[data-testid="session-policy-mode"]');
        expect(
            select.attributes("disabled"),
            "write entry point disabled before click",
        ).toBeDefined();
        // 状态仍可读：下拉值仍是服务端返回的 auto，旁边给出只读原因。
        expect(selectValueAt(wrapper, 0)).toBe("auto");
        expect(select.attributes("title")).toBe(i18n.global.t("workspace.viewerReadOnly"));
        expect(wrapper.get('[data-testid="session-policy-mode-readonly"]').text()).toBe(
            i18n.global.t("workspace.viewerReadOnly"),
        );

        // 改值也不产生写请求（后继若把 `disabled` 去掉，这里会变成红：见组件内的早退守卫）。
        await setSelectValue(wrapper, '[data-testid="session-policy-mode"]', "manual");
        await flushPromises();
        expect(api.setPolicyMode, "read-only must not attempt a write").not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it("treats CP's canWrite=false as read-only even when the role string says EDITOR", async () => {
        seedWorkspace({ workspaceRole: "EDITOR", canWrite: false });
        vi.mocked(api.getPolicyMode).mockResolvedValue({
            sessionId: SESSION_ID,
            mode: "manual",
            sessionRules: 0,
        });
        const wrapper = mountControls();
        await flushPromises();

        expect(
            wrapper.get('[data-testid="session-policy-mode"]').attributes("disabled"),
            "CP projection wins over the legacy role fallback",
        ).toBeDefined();
        wrapper.unmount();
    });

    it("keeps the mode editable for an EDITOR (unchanged behaviour)", async () => {
        seedWorkspace({ workspaceRole: "EDITOR" });
        vi.mocked(api.getPolicyMode).mockResolvedValue({
            sessionId: SESSION_ID,
            mode: "manual",
            sessionRules: 0,
        });
        vi.mocked(api.setPolicyMode).mockResolvedValue({
            sessionId: SESSION_ID,
            mode: "auto",
            scope: "session",
        });
        const wrapper = mountControls();
        await flushPromises();

        const select = wrapper.get('[data-testid="session-policy-mode"]');
        expect(select.attributes("disabled")).toBeUndefined();
        expect(wrapper.find('[data-testid="session-policy-mode-readonly"]').exists()).toBe(false);

        await setSelectValue(wrapper, '[data-testid="session-policy-mode"]', "auto");
        await flushPromises();
        expect(api.setPolicyMode).toHaveBeenCalledWith(SESSION_ID, "auto");
        wrapper.unmount();
    });
});
