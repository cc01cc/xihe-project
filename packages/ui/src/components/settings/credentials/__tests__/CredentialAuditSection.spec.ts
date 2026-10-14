import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import CredentialAuditSection from "../CredentialAuditSection.vue";
import { api } from "../../../../composables/api";
import type * as apiModule from "../../../../composables/api";
import { i18n } from "../../../../i18n";

vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            getCredentialReferences: vi.fn<typeof apiModule.api.getCredentialReferences>(),
            getCredentialEvents: vi.fn<typeof apiModule.api.getCredentialEvents>(),
        },
    };
});

const mockedApi = vi.mocked(api, true);

const CREDENTIAL_ID = "11111111-2222-3333-4444-555555555555";

let wrappers: VueWrapper[] = [];

async function mountSection(): Promise<VueWrapper> {
    const wrapper = mount(CredentialAuditSection, {
        props: { credentialId: CREDENTIAL_ID },
        global: { plugins: [i18n] },
    });
    wrappers.push(wrapper);
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getCredentialReferences.mockResolvedValue({
        references: [
            {
                source: "grant",
                subjectType: "agent_principal",
                subjectId: "principal-1",
                actionClass: "credential_use",
                resource: `credential:${CREDENTIAL_ID}`,
            },
        ],
    });
    mockedApi.getCredentialEvents.mockResolvedValue({
        events: [
            {
                id: "ev-2",
                eventType: "revealed",
                actor: "user:u1",
                createdAt: "2026-10-13T10:00:00Z",
            },
            {
                id: "ev-1",
                eventType: "created",
                actor: "user:u1",
                createdAt: "2026-10-12T10:00:00Z",
            },
        ],
    });
});

afterEach(() => {
    for (const wrapper of wrappers) wrapper.unmount();
    wrappers = [];
});

describe("CredentialAuditSection (PLAN-0498 T3.2)", () => {
    it("renders references and the labelled event trail without any value", async () => {
        const wrapper = await mountSection();

        expect(mockedApi.getCredentialEvents).toHaveBeenCalledWith(CREDENTIAL_ID);
        const references = wrapper.find('[data-testid="credential-audit-references"]');
        expect(references.exists()).toBe(true);
        expect(references.text()).toContain("principal-1");

        const events = wrapper.find('[data-testid="credential-audit-events"]');
        expect(events.exists()).toBe(true);
        expect(events.text()).toContain("查看");
        expect(events.text()).toContain("创建");
        expect(events.text()).toContain("user:u1");
    });

    it("shows empty states when there are no references or events", async () => {
        mockedApi.getCredentialReferences.mockResolvedValue({ references: [] });
        mockedApi.getCredentialEvents.mockResolvedValue({ events: [] });

        const wrapper = await mountSection();
        expect(wrapper.find('[data-testid="credential-audit-no-references"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="credential-audit-no-events"]').exists()).toBe(true);
    });

    it("surfaces load failures without crashing", async () => {
        mockedApi.getCredentialReferences.mockRejectedValue(new Error("boom"));

        const wrapper = await mountSection();
        expect(wrapper.find('[data-testid="credential-audit-error"]').exists()).toBe(true);
    });
});
