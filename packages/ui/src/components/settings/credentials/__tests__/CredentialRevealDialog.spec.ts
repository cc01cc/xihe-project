import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import CredentialRevealDialog from "../CredentialRevealDialog.vue";
import { api, ApiError } from "../../../../composables/api";
import type * as apiModule from "../../../../composables/api";
import { i18n } from "../../../../i18n";

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string) => void>(),
    },
}));

vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            revealCredential: vi.fn<typeof apiModule.api.revealCredential>(),
        },
    };
});

const mockedApi = vi.mocked(api, true);

const CREDENTIAL_ID = "11111111-2222-3333-4444-555555555555";

let wrappers: VueWrapper[] = [];

async function mountDialog(): Promise<VueWrapper> {
    const wrapper = mount(CredentialRevealDialog, {
        props: { open: true, credentialId: CREDENTIAL_ID, label: "OpenAI key" },
        attachTo: document.body,
        global: { plugins: [i18n] },
    });
    wrappers.push(wrapper);
    await flushPromises();
    return wrapper;
}

function bodyEl<T extends Element>(selector: string): T | null {
    return document.body.querySelector(selector) as T | null;
}

async function clickBody(selector: string) {
    const el = bodyEl<HTMLElement>(selector);
    expect(el).toBeTruthy();
    el!.click();
    await nextTick();
}

async function setBodyValue(selector: string, value: string) {
    const input = bodyEl<HTMLInputElement>(selector);
    expect(input).toBeTruthy();
    input!.value = value;
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
}

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
});

afterEach(() => {
    for (const wrapper of wrappers) wrapper.unmount();
    wrappers = [];
    vi.useRealTimers();
});

describe("CredentialRevealDialog (PLAN-0498 T3.1)", () => {
    it("reveals once after step-up and auto-hides after the countdown", async () => {
        vi.useFakeTimers();
        mockedApi.revealCredential.mockResolvedValue({
            credentialId: CREDENTIAL_ID,
            revision: 3,
            value: "sk-revealed-once",
        });

        await mountDialog();
        await setBodyValue('[data-testid="credentials-reveal-password"]', "login-password");
        await clickBody('[data-testid="credentials-reveal-submit"]');
        await flushPromises();

        expect(mockedApi.revealCredential).toHaveBeenCalledWith(CREDENTIAL_ID, "login-password");
        expect(bodyEl('[data-testid="credentials-reveal-value"]')?.textContent).toContain(
            "sk-revealed-once",
        );

        vi.advanceTimersByTime(30_000);
        await nextTick();
        expect(bodyEl('[data-testid="credentials-reveal-value"]')).toBeNull();
        expect(bodyEl('[data-testid="credentials-reveal-password"]')).toBeTruthy();
    });

    it("keeps the step-up failure inline for a wrong password", async () => {
        mockedApi.revealCredential.mockRejectedValue(
            new ApiError({
                status: 401,
                code: "CREDENTIAL_REVEAL_STEP_UP_FAILED",
                detail: "wrong",
                requestId: "r",
            }),
        );

        await mountDialog();
        await setBodyValue('[data-testid="credentials-reveal-password"]', "wrong-password");
        await clickBody('[data-testid="credentials-reveal-submit"]');
        await flushPromises();

        const error = bodyEl('[data-testid="credentials-reveal-error"]');
        expect(error?.textContent).toContain("密码错误");
        expect(bodyEl('[data-testid="credentials-reveal-value"]')).toBeNull();
        expect(bodyEl('[data-testid="credentials-reveal-submit"]')).toBeTruthy();
    });

    it("surfaces the rate-limit state", async () => {
        mockedApi.revealCredential.mockRejectedValue(
            new ApiError({
                status: 429,
                code: "CREDENTIAL_REVEAL_RATE_LIMITED",
                detail: "limited",
                requestId: "r",
            }),
        );

        await mountDialog();
        await setBodyValue('[data-testid="credentials-reveal-password"]', "login-password");
        await clickBody('[data-testid="credentials-reveal-submit"]');
        await flushPromises();

        expect(bodyEl('[data-testid="credentials-reveal-error"]')?.textContent).toContain(
            "过于频繁",
        );
    });

    it("clears the revealed value when the dialog closes", async () => {
        mockedApi.revealCredential.mockResolvedValue({
            credentialId: CREDENTIAL_ID,
            revision: 3,
            value: "sk-revealed-once",
        });

        const wrapper = await mountDialog();
        await setBodyValue('[data-testid="credentials-reveal-password"]', "login-password");
        await clickBody('[data-testid="credentials-reveal-submit"]');
        await flushPromises();
        expect(bodyEl('[data-testid="credentials-reveal-value"]')).toBeTruthy();

        await wrapper.setProps({ open: false });
        await nextTick();
        await wrapper.setProps({ open: true });
        await flushPromises();

        expect(bodyEl('[data-testid="credentials-reveal-value"]')).toBeNull();
        expect(bodyEl('[data-testid="credentials-reveal-password"]')).toBeTruthy();
    });
});
