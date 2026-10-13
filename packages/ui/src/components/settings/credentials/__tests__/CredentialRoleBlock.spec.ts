import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import { setActivePinia, createPinia } from "pinia";
import CredentialRoleBlock from "../CredentialRoleBlock.vue";
import { api } from "../../../../composables/api";
import type * as apiModule from "../../../../composables/api";
import { i18n } from "../../../../i18n";
import type { CredentialSummary } from "../../../../types";

vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listCredentials: vi.fn<typeof apiModule.api.listCredentials>(),
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
        revision: 1,
        createdAt: "2026-10-13T00:00:00Z",
        replacedAt: null,
        referenceCount: 0,
        ...overrides,
    };
}

let wrappers: VueWrapper[] = [];

async function mountBlock(permissions: Array<{ actionClass: string; resource?: string }> = []) {
    const wrapper = mount(CredentialRoleBlock, {
        props: { permissions },
        global: { plugins: [i18n] },
    });
    wrappers.push(wrapper);
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    mockedApi.listCredentials.mockResolvedValue({
        credentials: [
            credential(),
            credential({
                id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                label: "S3 pair",
                kind: "key_pair",
            }),
        ],
        count: 2,
    });
});

afterEach(() => {
    for (const wrapper of wrappers) wrapper.unmount();
    wrappers = [];
});

describe("CredentialRoleBlock (PLAN-0498 T2.1)", () => {
    it("lists credentials and filters by label search", async () => {
        const wrapper = await mountBlock();
        expect(wrapper.find('[data-testid="credential-role-candidates"]').exists()).toBe(true);
        expect(wrapper.text()).toContain("OpenAI key");

        await wrapper.get('[data-testid="credential-role-search"]').setValue("s3");
        expect(wrapper.text()).toContain("S3 pair");
        expect(wrapper.text()).not.toContain("OpenAI key");
    });

    it("emits credential_use atoms for the selected credentials", async () => {
        const wrapper = await mountBlock();
        await wrapper
            .get('[data-testid="credential-role-option-11111111-2222-3333-4444-555555555555"]')
            .setValue(true);
        await wrapper.get('[data-testid="credential-role-attach"]').trigger("click");
        await nextTick();

        expect(wrapper.emitted("add")?.at(-1)?.[0]).toEqual([
            {
                actionClass: "credential_use",
                resource: "credential:11111111-2222-3333-4444-555555555555",
            },
        ]);
    });

    it("renders attached atoms with labels and emits removal by resource", async () => {
        const wrapper = await mountBlock([
            {
                actionClass: "credential_use",
                resource: "credential:11111111-2222-3333-4444-555555555555",
            },
        ]);
        expect(wrapper.find('[data-testid="credential-role-attached"]').exists()).toBe(true);
        expect(wrapper.text()).toContain("OpenAI key");

        await wrapper
            .get('[data-testid="credential-role-remove-11111111-2222-3333-4444-555555555555"]')
            .trigger("click");
        expect(wrapper.emitted("remove")?.at(-1)?.[0]).toBe(
            "credential:11111111-2222-3333-4444-555555555555",
        );
    });

    it("does not attach an already attached credential twice", async () => {
        const wrapper = await mountBlock([
            {
                actionClass: "credential_use",
                resource: "credential:11111111-2222-3333-4444-555555555555",
            },
        ]);
        await wrapper
            .get('[data-testid="credential-role-option-11111111-2222-3333-4444-555555555555"]')
            .setValue(true);
        await wrapper.get('[data-testid="credential-role-attach"]').trigger("click");
        await nextTick();
        expect(wrapper.emitted("add")).toBeUndefined();
    });
});
