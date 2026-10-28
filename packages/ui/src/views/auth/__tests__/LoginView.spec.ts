import { mount, flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoginView from "../LoginView.vue";

const { authMock, pushMock, configMock } = vi.hoisted(() => ({
    authMock: {
        login: vi.fn<(email: string, password: string) => Promise<boolean>>(),
        error: null as string | null,
        lastError: null as { code: string; retryAfterSeconds?: number } | null,
    },
    pushMock: vi.fn<(location: unknown) => Promise<unknown>>(),
    configMock: { loadAllDomains: vi.fn<() => Promise<void>>(() => Promise.resolve()) },
}));

vi.mock("../../../stores/auth", () => ({ useAuthStore: () => authMock }));
vi.mock("../../../stores/config", () => ({ useConfigStore: () => configMock }));
vi.mock("vue-router", () => ({
    useRouter: () => ({ push: pushMock }),
    useRoute: () => ({ query: {} }),
}));
vi.mock("vue-i18n", () => ({
    useI18n: () => ({
        t: (key: string, params?: Record<string, unknown>) =>
            params ? `${key} ${JSON.stringify(params)}` : key,
    }),
}));

function mountView() {
    return mount(LoginView, {
        global: {
            stubs: {
                RouterLink: { template: "<a><slot /></a>" },
                Sun: true,
            },
        },
    });
}

async function fillAndSubmit(wrapper: ReturnType<typeof mountView>) {
    // PLAN-0565 ruling #7: the login field is the dual identifier (email or username).
    await wrapper.find("#identifier").setValue("a@test.com");
    await wrapper.find("#password").setValue("pw-12345678");
    await wrapper.find("form").trigger("submit");
}

beforeEach(() => {
    authMock.login.mockReset();
    authMock.error = null;
    authMock.lastError = null;
    pushMock.mockReset();
    configMock.loadAllDomains.mockClear();
});

describe("LoginView submission lock", () => {
    it("ignores a second submit while the first navigation is pending", async () => {
        authMock.login.mockResolvedValue(true);
        let resolvePush: (value: unknown) => void = () => {};
        pushMock.mockReturnValue(
            new Promise((resolve) => {
                resolvePush = resolve;
            }),
        );
        const wrapper = mountView();

        await fillAndSubmit(wrapper);
        await wrapper.find("form").trigger("submit");

        expect(authMock.login).toHaveBeenCalledTimes(1);
        expect(wrapper.find("form").attributes("aria-busy")).toBe("true");
        expect(wrapper.find("#identifier").attributes("disabled")).toBeDefined();
        expect(wrapper.find('button[type="submit"]').text()).toBe("login.entering");
        resolvePush(undefined);
        await flushPromises();
    });

    it("restores an editable form when navigation fails", async () => {
        authMock.login.mockResolvedValue(true);
        pushMock.mockRejectedValue(new Error("navigation rejected"));
        const wrapper = mountView();

        await fillAndSubmit(wrapper);
        await flushPromises();

        expect(wrapper.text()).toContain("login.navigationFailed");
        expect(wrapper.find('button[type="submit"]').attributes("disabled")).toBeUndefined();
    });

    it("shows the localized retry copy for a 429", async () => {
        authMock.login.mockResolvedValue(false);
        authMock.error = "Too many login attempts; retry later";
        authMock.lastError = { code: "AUTH_RATE_LIMITED", retryAfterSeconds: 12 };
        const wrapper = mountView();

        await fillAndSubmit(wrapper);
        await flushPromises();

        expect(wrapper.text()).toContain("login.rateLimitedSeconds");
        expect(wrapper.text()).toContain("12");
    });
});
