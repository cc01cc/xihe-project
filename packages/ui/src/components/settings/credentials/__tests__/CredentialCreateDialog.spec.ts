import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import { setActivePinia, createPinia } from "pinia";
import CredentialCreateDialog from "../CredentialCreateDialog.vue";
import { api } from "../../../../composables/api";
import type * as apiModule from "../../../../composables/api";
import { i18n } from "../../../../i18n";
import type { CredentialCreateRequest } from "../../../../types";

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
            createCredential: vi.fn<typeof apiModule.api.createCredential>(),
            listCredentials: vi.fn<typeof apiModule.api.listCredentials>(),
            listWorkspaces: vi.fn<typeof apiModule.api.listWorkspaces>(),
        },
    };
});

const mockedApi = vi.mocked(api, true);

let wrappers: VueWrapper[] = [];

async function mountDialog(): Promise<VueWrapper> {
    const wrapper = mount(CredentialCreateDialog, {
        props: { open: true },
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

async function selectBodyValue(selector: string, value: string) {
    const select = bodyEl<HTMLSelectElement>(selector);
    expect(select).toBeTruthy();
    select!.value = value;
    select!.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
}

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    setActivePinia(createPinia());
    mockedApi.listCredentials.mockResolvedValue({ credentials: [], count: 0 });
});

afterEach(() => {
    for (const wrapper of wrappers) wrapper.unmount();
    wrappers = [];
});

describe("CredentialCreateDialog (PLAN-0498 T1.2)", () => {
    it("creates a token credential with the entered fields", async () => {
        mockedApi.createCredential.mockResolvedValue({ id: "cred-1" } as never);

        const wrapper = await mountDialog();
        await setBodyValue('[data-testid="credentials-create-label"]', "OpenAI key");
        await setBodyValue('[data-testid="credentials-create-token"]', "sk-test-value");
        await clickBody('[data-testid="credentials-create-submit"]');
        await flushPromises();

        const body = mockedApi.createCredential.mock.calls[0]![0] as CredentialCreateRequest;
        expect(body).toMatchObject({
            label: "OpenAI key",
            kind: "token",
            deliveryTier: "lease",
            token: "sk-test-value",
        });
        expect(body.ownerType).toBeUndefined();
        expect(wrapper.emitted("created")).toBeTruthy();
    });

    it("switches to key_pair and collects both key fields", async () => {
        mockedApi.createCredential.mockResolvedValue({ id: "cred-2" } as never);

        await mountDialog();
        await setBodyValue('[data-testid="credentials-create-label"]', "S3 pair");
        await selectBodyValue('[data-testid="credentials-create-kind"]', "key_pair");
        await setBodyValue('[data-testid="credentials-create-access-key"]', "AKIA-test");
        await setBodyValue('[data-testid="credentials-create-secret-key"]', "secret-test");
        await clickBody('[data-testid="credentials-create-submit"]');
        await flushPromises();

        const body = mockedApi.createCredential.mock.calls[0]![0] as CredentialCreateRequest;
        expect(body).toMatchObject({
            label: "S3 pair",
            kind: "key_pair",
            accessKey: "AKIA-test",
            secretKey: "secret-test",
        });
        expect(body.token).toBeUndefined();
    });

    it("blocks submit until the required fields are present", async () => {
        await mountDialog();
        await clickBody('[data-testid="credentials-create-submit"]');
        await nextTick();

        expect(mockedApi.createCredential).not.toHaveBeenCalled();
        expect(bodyEl('[data-testid="credentials-create-error"]')?.textContent).toContain("名称");

        await setBodyValue('[data-testid="credentials-create-label"]', "No secret");
        await clickBody('[data-testid="credentials-create-submit"]');
        await nextTick();

        expect(mockedApi.createCredential).not.toHaveBeenCalled();
        expect(bodyEl('[data-testid="credentials-create-error"]')?.textContent).toContain("Token");
    });

    it("masks the secret input until the toggle is used", async () => {
        await mountDialog();
        const input = bodyEl<HTMLInputElement>('[data-testid="credentials-create-token"]');
        expect(input?.type).toBe("password");

        await clickBody('[data-testid="credentials-create-token-toggle"]');
        expect(bodyEl<HTMLInputElement>('[data-testid="credentials-create-token"]')?.type).toBe(
            "text",
        );
    });
});
