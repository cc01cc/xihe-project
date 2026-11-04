import { mount, flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RegisterView from "../RegisterView.vue";

const { authMock, pushMock } = vi.hoisted(() => ({
    authMock: {
        register: vi.fn<(email: string, password: string, name: string) => Promise<boolean>>(),
        error: null as string | null,
        lastError: null as { code: string; retryAfterSeconds?: number } | null,
    },
    pushMock: vi.fn<(location: unknown) => Promise<unknown>>(),
}));

vi.mock("../../../stores/auth", () => ({ useAuthStore: () => authMock }));
vi.mock("vue-router", () => ({
    useRouter: () => ({ push: pushMock }),
}));
vi.mock("vue-i18n", () => ({
    useI18n: () => ({
        t: (key: string, params?: Record<string, unknown>) =>
            params ? `${key} ${JSON.stringify(params)}` : key,
    }),
}));

function mountView() {
    return mount(RegisterView, {
        global: {
            stubs: {
                RouterLink: { template: "<a><slot /></a>" },
                Sun: true,
            },
        },
    });
}

async function fillAndSubmit(wrapper: ReturnType<typeof mountView>) {
    await wrapper.find("#email").setValue("a@test.com");
    await wrapper.find("#password").setValue("pw-12345678");
    await wrapper.find("#confirmPassword").setValue("pw-12345678");
    await wrapper.find("form").trigger("submit");
}

beforeEach(() => {
    authMock.register.mockReset();
    authMock.error = null;
    authMock.lastError = null;
    pushMock.mockReset();
});

describe("RegisterView submission lock", () => {
    it("ignores a second submit while navigation is pending", async () => {
        authMock.register.mockResolvedValue(true);
        let resolvePush: (value: unknown) => void = () => {};
        pushMock.mockReturnValue(
            new Promise((resolve) => {
                resolvePush = resolve;
            }),
        );
        const wrapper = mountView();

        await fillAndSubmit(wrapper);
        await wrapper.find("form").trigger("submit");

        expect(authMock.register).toHaveBeenCalledTimes(1);
        expect(wrapper.find("form").attributes("aria-busy")).toBe("true");
        expect(wrapper.find("#email").attributes("disabled")).toBeDefined();
        expect(wrapper.find('button[type="submit"]').text()).toBe("register.entering");
        resolvePush(undefined);
        await flushPromises();
    });

    it("restores the form when navigation fails", async () => {
        authMock.register.mockResolvedValue(true);
        pushMock.mockRejectedValue(new Error("navigation rejected"));
        const wrapper = mountView();

        await fillAndSubmit(wrapper);
        await flushPromises();

        expect(wrapper.text()).toContain("register.navigationFailed");
        expect(wrapper.find('button[type="submit"]').attributes("disabled")).toBeUndefined();
    });

    it("shows the localized retry copy for a 429", async () => {
        authMock.register.mockResolvedValue(false);
        authMock.error = "Too many login attempts; retry later";
        authMock.lastError = { code: "AUTH_RATE_LIMITED", retryAfterSeconds: 9 };
        const wrapper = mountView();

        await fillAndSubmit(wrapper);
        await flushPromises();

        expect(wrapper.text()).toContain("register.rateLimitedSeconds");
        expect(wrapper.text()).toContain("9");
    });
});

// 2026-11-04 用户裁定：用户名规则（字母/中文汉字/数字、不得数字开头、不含空格、≤32 位）必须在**前端**拦住，
// 否则用户填完提交才被 CP 以 400 USERNAME_INVALID 打回（且 detail 是英文）。
describe("RegisterView username validation (PLAN-0621 F-05)", () => {
    async function fillWithUsername(wrapper: ReturnType<typeof mountView>, username: string) {
        await wrapper.find("#email").setValue("a@test.com");
        await wrapper.find("#username").setValue(username);
        await wrapper.find("#password").setValue("pw-12345678");
        await wrapper.find("#confirmPassword").setValue("pw-12345678");
        await wrapper.find("form").trigger("submit");
        await flushPromises();
    }

    it.each(["Headed Second", "1abc", "ab-c", "a".repeat(33), "ab_c", "1王小明"])(
        "blocks %s before any request and shows the rule hint",
        async (username) => {
            authMock.register.mockResolvedValue(true);
            const wrapper = mountView();
            await fillWithUsername(wrapper, username);

            expect(
                authMock.register,
                "invalid username must not reach the CP",
            ).not.toHaveBeenCalled();
            expect(wrapper.text()).toContain("register.usernameInvalid");
        },
    );

    it.each(["王小明", "HeadedSecond", "abc123"])(
        "accepts %s under the 2026-11-04 naming rule",
        async (username) => {
            authMock.register.mockResolvedValue(true);
            pushMock.mockResolvedValue(undefined);
            const wrapper = mountView();
            await fillWithUsername(wrapper, username);

            expect(authMock.register).toHaveBeenCalledWith(
                "a@test.com",
                "pw-12345678",
                "a",
                username,
            );
        },
    );

    it("submits a valid username unchanged", async () => {
        authMock.register.mockResolvedValue(true);
        pushMock.mockResolvedValue(undefined);
        const wrapper = mountView();
        await fillWithUsername(wrapper, "headed_second");

        // 下划线也不合法（规则只允许小写字母/数字）—— 这条断言同时固定了"合法集"的边界。
        expect(authMock.register).not.toHaveBeenCalled();

        await wrapper.find("#username").setValue("headedsecond");
        await wrapper.find("form").trigger("submit");
        await flushPromises();
        expect(authMock.register).toHaveBeenCalledTimes(1);
        expect(authMock.register.mock.calls[0][3]).toBe("headedsecond");
    });
});
