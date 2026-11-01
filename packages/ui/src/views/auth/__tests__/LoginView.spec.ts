import { mount, flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoginView from "../LoginView.vue";
import { api } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";

const { authMock, pushMock, configMock } = vi.hoisted(() => ({
    authMock: {
        login: vi.fn<(email: string, password: string) => Promise<boolean>>(),
        localLogin: vi.fn<() => Promise<boolean>>(),
        error: null as string | null,
        lastError: null as { code: string; retryAfterSeconds?: number } | null,
        isAdmin: false,
    },
    pushMock: vi.fn<(location: unknown) => Promise<unknown>>(),
    configMock: { loadAllDomains: vi.fn<() => Promise<void>>(() => Promise.resolve()) },
}));

vi.mock("../../../stores/auth", () => ({ useAuthStore: () => authMock }));
vi.mock("../../../stores/config", () => ({ useConfigStore: () => configMock }));
vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            bootstrapStatus: vi.fn<typeof apiModule.api.bootstrapStatus>(),
        },
    };
});
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

/** Local-mode presence comes from CP's bootstrap status, not from a build flag. */
async function mountWithLocalMode(localMode: boolean) {
    vi.mocked(api.bootstrapStatus).mockResolvedValue({ initialized: true, localMode });
    const wrapper = mountView();
    await flushPromises();
    return wrapper;
}

async function fillAndSubmit(wrapper: ReturnType<typeof mountView>) {
    // PLAN-0565 ruling #7: the login field is the dual identifier (email or username).
    await wrapper.find("#identifier").setValue("a@test.com");
    await wrapper.find("#password").setValue("pw-12345678");
    await wrapper.find("form").trigger("submit");
}

beforeEach(() => {
    authMock.login.mockReset();
    authMock.localLogin.mockReset();
    authMock.error = null;
    authMock.lastError = null;
    authMock.isAdmin = false;
    pushMock.mockReset();
    configMock.loadAllDomains.mockClear();
    vi.mocked(api.bootstrapStatus).mockReset();
    vi.mocked(api.bootstrapStatus).mockResolvedValue({ initialized: true, localMode: false });
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

describe("LoginView local-mode entry (BL-150 A)", () => {
    it("renders the passwordless entry only when CP reports localMode", async () => {
        const local = await mountWithLocalMode(true);
        expect(local.find('[data-testid="login-local-mode"]').exists()).toBe(true);

        const hosted = await mountWithLocalMode(false);
        expect(hosted.find('[data-testid="login-local-mode"]').exists()).toBe(false);
    });

    it("stays hidden when the bootstrap status cannot be read", async () => {
        vi.mocked(api.bootstrapStatus).mockRejectedValue(new Error("offline"));
        const wrapper = mountView();
        await flushPromises();
        expect(wrapper.find('[data-testid="login-local-mode"]').exists()).toBe(false);
    });

    // PLAN-0612 T6.3：非 localMode（普通部署）**不得**走到免密端点 —— 这是 BL-150 改动最需要
    // 防的回归：一旦条件写反，托管部署上的登录页会去 POST /auth/local-login（CP 侧 404/403）。
    it("never calls the passwordless endpoint on a hosted (non-localMode) instance", async () => {
        const hosted = await mountWithLocalMode(false);
        expect(hosted.find('[data-testid="login-local-mode"]').exists()).toBe(false);
        expect(authMock.localLogin).not.toHaveBeenCalled();
        // 普通表单仍是唯一入口。
        expect(hosted.find("#identifier").exists()).toBe(true);
        expect(hosted.find("#password").exists()).toBe(true);
    });

    it("signs in passwordlessly and enters the workspace", async () => {
        authMock.localLogin.mockResolvedValue(true);
        pushMock.mockResolvedValue(undefined);
        const wrapper = await mountWithLocalMode(true);

        await wrapper.get('[data-testid="login-local-mode"]').trigger("click");
        await flushPromises();

        expect(authMock.localLogin).toHaveBeenCalledTimes(1);
        expect(pushMock).toHaveBeenCalledWith("/workspace");
        // The config load must run after the capability-aware sign-in, not before it.
        expect(configMock.loadAllDomains).toHaveBeenCalledWith({ isAdmin: false });
    });

    it("localizes the 409 LOCAL_SINGLE_USER_REQUIRED outcome instead of echoing CP detail", async () => {
        authMock.localLogin.mockResolvedValue(false);
        authMock.error = "local mode requires exactly one user";
        authMock.lastError = { code: "LOCAL_SINGLE_USER_REQUIRED" };
        const wrapper = await mountWithLocalMode(true);

        await wrapper.get('[data-testid="login-local-mode"]').trigger("click");
        await flushPromises();

        expect(wrapper.text()).toContain("login.localSingleUserRequired");
        expect(wrapper.text()).not.toContain("local mode requires exactly one user");
        expect(pushMock).not.toHaveBeenCalled();
    });
});
