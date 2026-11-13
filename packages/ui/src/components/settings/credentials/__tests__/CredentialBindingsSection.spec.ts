import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import CredentialBindingsSection from "../CredentialBindingsSection.vue";
import { api } from "../../../../composables/api";
import type * as apiModule from "../../../../composables/api";
import { i18n } from "../../../../i18n";
import { setSelectValue } from "../../../../test-utils/select";

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
            listWorkspaces: vi.fn<typeof apiModule.api.listWorkspaces>(),
            getWorkspaceAgents: vi.fn<typeof apiModule.api.getWorkspaceAgents>(),
            bindCredential: vi.fn<typeof apiModule.api.bindCredential>(),
            unbindCredential: vi.fn<typeof apiModule.api.unbindCredential>(),
        },
    };
});

const mockedApi = vi.mocked(api, true);

const CREDENTIAL_ID = "11111111-2222-3333-4444-555555555555";

let wrappers: VueWrapper[] = [];

async function mountSection(): Promise<VueWrapper> {
    const wrapper = mount(CredentialBindingsSection, {
        props: { credentialId: CREDENTIAL_ID },
        global: { plugins: [i18n] },
    });
    wrappers.push(wrapper);
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.listWorkspaces.mockResolvedValue([{ id: "ws-1", name: "Workspace One" }] as never);
    // PLAN-0622（CP `13e54cad`）：item 用 `permissionsSnapshot` 且 `source` 必填。
    // 注意：这里 mock 的是 **api 客户端边界**（`api.getWorkspaceAgents` 已经解包成数组），
    // `{agents:[…]}` 信封由 `composables/__tests__/api.spec.ts` 用真实 fetch mock 断言。
    mockedApi.getWorkspaceAgents.mockResolvedValue([
        {
            principalId: "principal-bound",
            name: "Bound agent",
            templateId: null,
            templateName: null,
            createdAt: "2026-10-13T00:00:00Z",
            permissionsSnapshot: [
                { actionClass: "credential_use", resource: `credential:${CREDENTIAL_ID}` },
            ],
        },
        {
            principalId: "principal-free",
            name: "Free agent",
            templateId: null,
            templateName: null,
            createdAt: "2026-10-13T00:00:00Z",
            permissionsSnapshot: [],
            bound: true,
        },
    ]);
    mockedApi.bindCredential.mockResolvedValue({
        credentialId: CREDENTIAL_ID,
        agentPrincipalIds: ["principal-free"],
        bound: true,
    });
    mockedApi.unbindCredential.mockResolvedValue({
        credentialId: CREDENTIAL_ID,
        agentPrincipalIds: ["principal-bound"],
        bound: false,
    });
});

afterEach(() => {
    for (const wrapper of wrappers) wrapper.unmount();
    wrappers = [];
});

describe("CredentialBindingsSection (PLAN-0498 T2.2)", () => {
    it("lists workspace agents and marks the already bound principal", async () => {
        const wrapper = await mountSection();
        await setSelectValue(wrapper, '[data-testid="credential-bind-workspace"]', "ws-1");
        await flushPromises();

        expect(mockedApi.getWorkspaceAgents).toHaveBeenCalledWith("ws-1");
        expect(wrapper.text()).toContain("Bound agent");
        expect(wrapper.findAll('[data-testid="credential-bind-bound"]')).toHaveLength(1);
    });

    // task-417 P1-6：「已绑定」由 permissionsSnapshot 判定，而快照是 CP 存的上限文档、不是实时求值
    // 结果（真源 resolveCapFor 无公开读面），角色授权（grant）那条轴也不在快照里 ⇒ 判据来源必须写明。
    // 本用例只钉「说清楚了」+「语义没变」，不改绑定/解绑行为（那两条写面只动工作区 cap）。
    it("states that the bound badge is judged from the cap snapshot, not live authority", async () => {
        const wrapper = await mountSection();
        await setSelectValue(wrapper, '[data-testid="credential-bind-workspace"]', "ws-1");
        await flushPromises();

        expect(wrapper.get('[data-testid="credential-bind-snapshot-note"]').text()).toBe(
            i18n.global.t("credentials.bindSnapshotNote"),
        );
        // 语义不弱化：仍只有快照里持 credential_use 的那一个主体被标为已绑定。
        const badges = wrapper.findAll('[data-testid="credential-bind-bound"]');
        expect(badges).toHaveLength(1);
        expect(wrapper.text()).toContain("Free agent");
    });

    it("binds the selected principals all-or-nothing", async () => {
        const wrapper = await mountSection();
        await setSelectValue(wrapper, '[data-testid="credential-bind-workspace"]', "ws-1");
        await flushPromises();
        await wrapper.get('[data-testid="credential-bind-agent-principal-free"]').setValue(true);
        await wrapper.get('[data-testid="credential-bind-apply"]').trigger("click");
        await flushPromises();

        expect(mockedApi.bindCredential).toHaveBeenCalledWith(CREDENTIAL_ID, {
            workspaceId: "ws-1",
            agentPrincipalIds: ["principal-free"],
        });
        expect(wrapper.emitted("changed")).toBeTruthy();
    });

    it("unbinds the selected principals", async () => {
        const wrapper = await mountSection();
        await setSelectValue(wrapper, '[data-testid="credential-bind-workspace"]', "ws-1");
        await flushPromises();
        await wrapper.get('[data-testid="credential-bind-agent-principal-bound"]').setValue(true);
        await wrapper.get('[data-testid="credential-bind-remove"]').trigger("click");
        await flushPromises();

        expect(mockedApi.unbindCredential).toHaveBeenCalledWith(CREDENTIAL_ID, {
            workspaceId: "ws-1",
            agentPrincipalIds: ["principal-bound"],
        });
    });

    it("keeps the apply button disabled without a selection", async () => {
        const wrapper = await mountSection();
        await setSelectValue(wrapper, '[data-testid="credential-bind-workspace"]', "ws-1");
        await flushPromises();
        await nextTick();

        const apply = wrapper.get('[data-testid="credential-bind-apply"]');
        expect(apply.attributes("disabled")).toBeDefined();
        expect(mockedApi.bindCredential).not.toHaveBeenCalled();
    });

    it("surfaces bind failures inline without emitting changed", async () => {
        mockedApi.bindCredential.mockRejectedValue(new Error("scope exceeded"));

        const wrapper = await mountSection();
        await setSelectValue(wrapper, '[data-testid="credential-bind-workspace"]', "ws-1");
        await flushPromises();
        await wrapper.get('[data-testid="credential-bind-agent-principal-free"]').setValue(true);
        await wrapper.get('[data-testid="credential-bind-apply"]').trigger("click");
        await flushPromises();

        expect(wrapper.find('[data-testid="credential-bind-error"]').text()).toContain(
            "scope exceeded",
        );
        expect(wrapper.emitted("changed")).toBeFalsy();
    });
});
