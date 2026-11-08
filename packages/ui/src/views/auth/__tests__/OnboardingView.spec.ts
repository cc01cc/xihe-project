import { mount, flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OnboardingView from "../OnboardingView.vue";

const { authMock, pushMock, bootstrapStatusMock } = vi.hoisted(() => ({
    authMock: {
        register: vi.fn<(email: string, password: string, name: string) => Promise<boolean>>(),
        error: null as string | null,
    },
    pushMock: vi.fn<(location: unknown) => Promise<unknown>>(),
    bootstrapStatusMock: vi.fn<() => Promise<{ localMode: boolean }>>(),
}));

vi.mock("../../../stores/auth", () => ({ useAuthStore: () => authMock }));
vi.mock("../../../composables/api", () => ({
    api: { bootstrapStatus: bootstrapStatusMock },
}));
vi.mock("vue-router", () => ({
    useRouter: () => ({ push: pushMock }),
    useRoute: () => ({ query: {} }),
}));
vi.mock("vue-i18n", () => ({
    useI18n: () => ({ t: (key: string) => key }),
}));

function mountView() {
    return mount(OnboardingView, { global: { stubs: { Sun: true } } });
}

async function settle() {
    await flushPromises();
    await flushPromises();
}

beforeEach(() => {
    authMock.register.mockReset();
    authMock.register.mockResolvedValue(true);
    authMock.error = null;
    pushMock.mockReset();
    bootstrapStatusMock.mockReset();
    bootstrapStatusMock.mockResolvedValue({ localMode: true });
});

describe("OnboardingView validation (BL-151)", () => {
    it("uses a native email input", async () => {
        const wrapper = mountView();
        await settle();
        expect(wrapper.find("#email").attributes("type")).toBe("email");
        expect(wrapper.find("#email").attributes("inputmode")).toBe("email");
    });

    it("blocks an invalid email before any request and shows an inline alert", async () => {
        const wrapper = mountView();
        await settle();
        await wrapper.find("#email").setValue("not-an-email");
        await wrapper.find("form").trigger("submit");
        await settle();

        expect(authMock.register).not.toHaveBeenCalled();
        const alert = wrapper.find('[data-testid="onboarding-email-error"]');
        expect(alert.exists()).toBe(true);
        expect(alert.attributes("role")).toBe("alert");
        expect(alert.text()).toBe("onboarding.emailInvalid");
    });

    it("shows the required hint on an empty submit (button is clickable)", async () => {
        const wrapper = mountView();
        await settle();
        await wrapper.find("form").trigger("submit");
        await settle();

        expect(authMock.register).not.toHaveBeenCalled();
        expect(wrapper.find('[data-testid="onboarding-email-error"]').text()).toBe(
            "onboarding.emailRequired",
        );
    });

    it("clears the hint once the email becomes valid and submits the trimmed value", async () => {
        const wrapper = mountView();
        await settle();
        await wrapper.find("#email").setValue("bad");
        await wrapper.find("form").trigger("submit");
        await settle();
        expect(wrapper.find('[data-testid="onboarding-email-error"]').exists()).toBe(true);

        await wrapper.find("#email").setValue("  a@test.com  ");
        await wrapper.find("#email").trigger("blur");
        await settle();
        expect(wrapper.find('[data-testid="onboarding-email-error"]').exists()).toBe(false);

        await wrapper.find("form").trigger("submit");
        await settle();
        expect(authMock.register).toHaveBeenCalledWith("a@test.com", "", "");
        expect(pushMock).toHaveBeenCalled();
    });
});
