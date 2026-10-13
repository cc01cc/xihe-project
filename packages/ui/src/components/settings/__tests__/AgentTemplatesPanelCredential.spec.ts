import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import AgentTemplatesPanel from "../AgentTemplatesPanel.vue";
import { api } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";
import { i18n } from "../../../i18n";

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listCredentials: vi.fn<typeof apiModule.api.listCredentials>(),
            precheckCredentialAtoms: vi.fn<typeof apiModule.api.precheckCredentialAtoms>(),
        },
    };
});

const mockedApi = vi.mocked(api, true);

const CREDENTIAL_ID = "11111111-2222-3333-4444-555555555555";

let wrappers: VueWrapper[] = [];

async function mountPanel(): Promise<VueWrapper> {
    const wrapper = mount(AgentTemplatesPanel, {
        props: { entries: {} },
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
            {
                id: CREDENTIAL_ID,
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
            },
        ],
        count: 1,
    });
});

afterEach(() => {
    for (const wrapper of wrappers) wrapper.unmount();
    wrappers = [];
});

describe("AgentTemplatesPanel credential ceiling (PLAN-0498 T2.1)", () => {
    it("blocks the role save and lists uncovered credential atoms", async () => {
        mockedApi.precheckCredentialAtoms.mockResolvedValue({
            uncovered: [`credential_use@credential:${CREDENTIAL_ID}`],
        });

        const wrapper = await mountPanel();
        await wrapper.get('[data-testid="agent-role-name"]').setValue("Reader");
        await wrapper.get(`[data-testid="credential-role-option-${CREDENTIAL_ID}"]`).setValue(true);
        await wrapper.get('[data-testid="credential-role-attach"]').trigger("click");
        await wrapper.get('[data-testid="agent-role-form"]').trigger("submit");
        await flushPromises();

        expect(mockedApi.precheckCredentialAtoms).toHaveBeenCalledTimes(1);
        const body = mockedApi.precheckCredentialAtoms.mock.calls[0]![0];
        expect(body).toEqual([
            { actionClass: "credential_use", resource: `credential:${CREDENTIAL_ID}` },
        ]);
        expect(wrapper.emitted("save")).toBeUndefined();
        const warning = wrapper.find('[data-testid="agent-role-ceiling-warning"]');
        expect(warning.exists()).toBe(true);
        expect(warning.text()).toContain(CREDENTIAL_ID);
    });

    it("saves the role once the precheck finds nothing uncovered", async () => {
        mockedApi.precheckCredentialAtoms.mockResolvedValue({ uncovered: [] });

        const wrapper = await mountPanel();
        await wrapper.get('[data-testid="agent-role-name"]').setValue("Reader");
        await wrapper.get(`[data-testid="credential-role-option-${CREDENTIAL_ID}"]`).setValue(true);
        await wrapper.get('[data-testid="credential-role-attach"]').trigger("click");
        await wrapper.get('[data-testid="agent-role-form"]').trigger("submit");
        await flushPromises();

        expect(mockedApi.precheckCredentialAtoms).toHaveBeenCalledTimes(1);
        const save = wrapper.emitted("save")?.at(-1)?.[0] as Record<string, string>;
        expect(save).toBeTruthy();
        const roles = JSON.parse(save.roles) as Array<{
            name: string;
            permissions: Array<{ actionClass: string; resource: string }>;
        }>;
        expect(roles[0]).toMatchObject({
            name: "Reader",
            permissions: [
                { actionClass: "credential_use", resource: `credential:${CREDENTIAL_ID}` },
            ],
        });
        expect(wrapper.find('[data-testid="agent-role-ceiling-warning"]').exists()).toBe(false);
    });

    it("skips the precheck for roles without credential atoms", async () => {
        const wrapper = await mountPanel();
        await wrapper.get('[data-testid="agent-role-name"]').setValue("Plain");
        await wrapper.get('[data-testid="agent-role-form"]').trigger("submit");
        await flushPromises();

        expect(mockedApi.precheckCredentialAtoms).not.toHaveBeenCalled();
        expect(wrapper.emitted("save")).toBeTruthy();
    });
});
