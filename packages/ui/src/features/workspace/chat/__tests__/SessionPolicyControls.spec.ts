import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SessionPolicyControls from "../components/SessionPolicyControls.vue";
import { i18n } from "../../../../i18n";
import { ApiError, api } from "../../../../composables/api";
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
        expect(wrapper.element.querySelectorAll("select")).toHaveLength(1);
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

        await wrapper.get('[data-testid="session-policy-mode"]').setValue("auto");
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
