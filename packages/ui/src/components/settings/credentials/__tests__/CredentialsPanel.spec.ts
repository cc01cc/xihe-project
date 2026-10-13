import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import { setActivePinia, createPinia } from "pinia";
import CredentialsPanel from "../CredentialsPanel.vue";
import { api } from "../../../../composables/api";
import type * as apiModule from "../../../../composables/api";
import { i18n } from "../../../../i18n";
import type { CredentialSummary } from "../../../../types";

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
            listCredentials: vi.fn<typeof apiModule.api.listCredentials>(),
            createCredential: vi.fn<typeof apiModule.api.createCredential>(),
            replaceCredential: vi.fn<typeof apiModule.api.replaceCredential>(),
            deleteCredential: vi.fn<typeof apiModule.api.deleteCredential>(),
            getCredentialReferences: vi.fn<typeof apiModule.api.getCredentialReferences>(),
            listWorkspaces: vi.fn<typeof apiModule.api.listWorkspaces>(),
        },
    };
});

const mockedApi = vi.mocked(api, true);

function credential(overrides: Partial<CredentialSummary> = {}): CredentialSummary {
    return {
        id: "11111111-2222-3333-4444-555555555555",
        label: "OpenAI key",
        kind: "token",
        deliveryTier: "lease",
        ownerType: "USER",
        ownerId: "user-1",
        status: "active",
        fingerprint: "abcdef0123456789abcdef0123456789",
        revision: 2,
        createdAt: "2026-10-13T00:00:00Z",
        replacedAt: null,
        referenceCount: 1,
        ...overrides,
    };
}

let wrappers: VueWrapper[] = [];

async function mountPanel(): Promise<VueWrapper> {
    const wrapper = mount(CredentialsPanel, {
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

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    setActivePinia(createPinia());
});

afterEach(() => {
    for (const wrapper of wrappers) wrapper.unmount();
    wrappers = [];
});

describe("CredentialsPanel (PLAN-0498 T1.1/T1.3)", () => {
    it("renders sanitized list metadata without any plaintext", async () => {
        mockedApi.listCredentials.mockResolvedValue({
            credentials: [credential()],
            count: 1,
        });

        const wrapper = await mountPanel();
        const html = wrapper.html();
        expect(wrapper.text()).toContain("OpenAI key");
        expect(wrapper.text()).toContain("abcdef01234");
        expect(wrapper.text()).not.toContain("abcdef0123456789abcdef0123456789");
        expect(html).not.toContain("sk-test-value");
        expect(bodyEl('[data-testid="credentials-empty"]')).toBeNull();
    });

    it("shows the empty state when the owner has no credentials", async () => {
        mockedApi.listCredentials.mockResolvedValue({ credentials: [], count: 0 });

        await mountPanel();
        expect(bodyEl('[data-testid="credentials-empty"]')?.textContent).toContain("暂无凭据");
    });

    it("opens the detail dialog from a row and shows the delete reference report", async () => {
        mockedApi.listCredentials.mockResolvedValue({
            credentials: [credential()],
            count: 1,
        });
        mockedApi.getCredentialReferences.mockResolvedValue({
            references: [
                {
                    source: "grant",
                    subjectType: "agent_principal",
                    subjectId: "principal-1",
                    actionClass: "credential_use",
                    resource: "credential:11111111-2222-3333-4444-555555555555",
                },
            ],
        });

        await mountPanel();
        await clickBody('[data-testid="credentials-row-11111111-2222-3333-4444-555555555555"]');
        await flushPromises();
        expect(bodyEl('[data-testid="credentials-detail-dialog"]')).toBeTruthy();

        await clickBody('[data-testid="credentials-detail-delete"]');
        await flushPromises();
        const refs = bodyEl('[data-testid="credentials-delete-references"]');
        expect(refs?.textContent).toContain("principal-1");
    });

    it("deletes after confirmation and refreshes the list", async () => {
        mockedApi.listCredentials.mockResolvedValue({
            credentials: [credential()],
            count: 1,
        });
        mockedApi.getCredentialReferences.mockResolvedValue({ references: [] });
        mockedApi.deleteCredential.mockResolvedValue({
            id: "11111111-2222-3333-4444-555555555555",
            deleted: true,
            references: [],
        });

        await mountPanel();
        await clickBody('[data-testid="credentials-row-11111111-2222-3333-4444-555555555555"]');
        await flushPromises();
        await clickBody('[data-testid="credentials-detail-delete"]');
        await flushPromises();
        expect(bodyEl('[data-testid="credentials-delete-no-refs"]')).toBeTruthy();

        await clickBody('[data-testid="credentials-delete-submit"]');
        await flushPromises();

        expect(mockedApi.deleteCredential).toHaveBeenCalledWith(
            "11111111-2222-3333-4444-555555555555",
        );
        expect(mockedApi.listCredentials.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("shows the reveal entry only for reveal-tier credentials", async () => {
        mockedApi.listCredentials.mockResolvedValue({
            credentials: [credential({ deliveryTier: "reveal" })],
            count: 1,
        });

        await mountPanel();
        await clickBody('[data-testid="credentials-row-11111111-2222-3333-4444-555555555555"]');
        await flushPromises();
        expect(bodyEl('[data-testid="credentials-detail-reveal"]')).toBeTruthy();

        await clickBody('[data-testid="credentials-detail-reveal"]');
        await flushPromises();
        expect(bodyEl('[data-testid="credentials-reveal-dialog"]')).toBeTruthy();
        expect(bodyEl('[data-testid="credentials-reveal-password"]')).toBeTruthy();
    });

    it("hides the reveal entry for lease-tier credentials", async () => {
        mockedApi.listCredentials.mockResolvedValue({
            credentials: [credential()],
            count: 1,
        });

        await mountPanel();
        await clickBody('[data-testid="credentials-row-11111111-2222-3333-4444-555555555555"]');
        await flushPromises();
        expect(bodyEl('[data-testid="credentials-detail-reveal"]')).toBeNull();
    });
});
