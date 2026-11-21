import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FirstRunAccount from "../FirstRunAccount.vue";
import { i18n } from "../../../i18n";
import { ApiError } from "../../../composables/api";

const mocks = vi.hoisted(() => ({
    disclose: vi.fn<typeof import("../../../composables/api").api.discloseFirstRunAccount>(),
    rewrite: vi.fn<typeof import("../../../composables/api").api.rewriteFirstRunAccount>(),
}));

vi.mock("../../../composables/api", () => ({
    api: { discloseFirstRunAccount: mocks.disclose, rewriteFirstRunAccount: mocks.rewrite },
    ApiError: class ApiError extends Error {
        constructor(public problem: { status: number }) {
            super();
        }
    },
}));
function mountView() {
    return mount(FirstRunAccount, { global: { plugins: [i18n], stubs: { RouterLink: true } } });
}

beforeEach(() => {
    mocks.disclose.mockReset();
    mocks.rewrite.mockReset();
    localStorage.clear();
    sessionStorage.clear();
});

describe("first-run account", () => {
    it("discloses only on explicit action, holds it in memory, and clears it on rewrite", async () => {
        const sample = "example-generated-value";
        mocks.disclose.mockResolvedValue({
            state: "generated-secret",
            account: { email: "admin@example.invalid", username: "admin" },
            secret: { value: sample },
        });
        mocks.rewrite.mockResolvedValue({
            account: { email: "admin@example.invalid", username: "admin" },
            secretRevoked: true,
        });
        const wrapper = mountView();
        expect(mocks.disclose).not.toHaveBeenCalled();
        await wrapper.get("button").trigger("click");
        await flushPromises();
        expect(wrapper.text()).toContain(sample);
        expect(wrapper.text()).toContain(i18n.global.t("onboarding.firstRunOnce"));
        expect(JSON.stringify(localStorage)).not.toContain(sample);
        expect(JSON.stringify(sessionStorage)).not.toContain(sample);
        await wrapper.get("#first-run-password").setValue("example-new-value");
        await wrapper.get("form").trigger("submit");
        await flushPromises();
        expect(mocks.rewrite).toHaveBeenCalledWith("example-new-value", "admin");
        expect(wrapper.text()).not.toContain(sample);
        expect(wrapper.text()).toContain(i18n.global.t("onboarding.firstRunRewritten"));
        wrapper.unmount();
        expect(mountView().text()).not.toContain(sample);
    });

    it("does not show an operator-provided password", async () => {
        mocks.disclose.mockResolvedValue({
            state: "operator-provided",
            account: { email: "admin@example.invalid", username: "admin" },
            secret: null,
            source: "env",
        });
        const wrapper = mountView();
        await wrapper.get("button").trigger("click");
        await flushPromises();
        expect(wrapper.text()).toContain(i18n.global.t("onboarding.firstRunOperator"));
        expect(wrapper.text()).not.toContain(i18n.global.t("onboarding.firstRunSecret"));
    });

    it.each([
        ["server error", new ApiError({ status: 500, code: "ERROR", requestId: "test" })],
        ["network error", new Error("network")],
    ])("allows retry after a %s", async (_label, failure) => {
        mocks.disclose.mockRejectedValue(failure);
        const wrapper = mountView();
        await wrapper.get("button").trigger("click");
        await flushPromises();
        expect(wrapper.find("button").exists()).toBe(true);
        expect(wrapper.get('[role="alert"]').text()).toBe(
            i18n.global.t("onboarding.firstRunRevealFailed"),
        );
        expect(mocks.disclose).toHaveBeenCalledTimes(1);
    });

    it("does not retry an unavailable disclosure", async () => {
        mocks.disclose.mockRejectedValue(
            new ApiError({ status: 403, code: "FIRST_RUN_ACCOUNT_UNAVAILABLE", requestId: "test" }),
        );
        const wrapper = mountView();
        await wrapper.get("button").trigger("click");
        await flushPromises();
        expect(wrapper.find("button").exists()).toBe(false);
        expect(wrapper.get('[role="alert"]').text()).toBe(
            i18n.global.t("onboarding.firstRunUnavailable"),
        );
    });

    it("reports a consumed disclosure without showing a secret", async () => {
        mocks.disclose.mockRejectedValue(
            new ApiError({
                status: 410,
                code: "FIRST_RUN_ACCOUNT_ALREADY_DISCLOSED",
                requestId: "test",
            }),
        );
        const wrapper = mountView();
        await wrapper.get("button").trigger("click");
        await flushPromises();
        expect(wrapper.text()).toContain(i18n.global.t("onboarding.firstRunConsumed"));
        expect(wrapper.find("button").exists()).toBe(false);
        expect(wrapper.find("form").exists()).toBe(false);
    });

    it("shows the disclosure after a successful retry", async () => {
        mocks.disclose.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({
            state: "operator-provided",
            account: { email: "admin@example.invalid", username: "admin" },
            secret: null,
            source: "env",
        });
        const wrapper = mountView();
        await wrapper.get("button").trigger("click");
        await flushPromises();
        expect(wrapper.get('[role="alert"]').text()).toBe(
            i18n.global.t("onboarding.firstRunRevealFailed"),
        );
        await wrapper.get("button").trigger("click");
        await flushPromises();
        expect(mocks.disclose).toHaveBeenCalledTimes(2);
        expect(wrapper.find('[role="alert"]').exists()).toBe(false);
        expect(wrapper.text()).toContain(i18n.global.t("onboarding.firstRunOperator"));
        expect(wrapper.find("form").exists()).toBe(true);
    });
});
