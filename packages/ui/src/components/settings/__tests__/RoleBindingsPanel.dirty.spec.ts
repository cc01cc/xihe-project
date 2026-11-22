import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import RoleBindingsPanel from "../RoleBindingsPanel.vue";
import { i18n } from "../../../i18n";
import { api } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";
import { setSelectValue } from "../../../test-utils/select";

/**
 * task-92 缺口二（用户段）：`RoleBindingsPanel` 的草稿基准**派生自 `bindingSet`**（不维护布尔），
 * save 成功后随重新载入的 bindingSet 复位；且**非当前 subjectType 的草稿不参与 dirty**
 * （不可见也改不了，算进 dirty 会让用户在看不到那段时被拦下）。
 */
vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            getBindings: vi.fn<typeof apiModule.api.getBindings>(),
            replaceBindings: vi.fn<typeof apiModule.api.replaceBindings>(),
            listAdminUsers: vi.fn<typeof apiModule.api.listAdminUsers>(),
            getWorkspaceAgents: vi.fn<typeof apiModule.api.getWorkspaceAgents>(),
            listAgentPrincipals: vi.fn<typeof apiModule.api.listAgentPrincipals>(),
            getAgentRoles: vi.fn<typeof apiModule.api.getAgentRoles>(),
            bindAgentRole: vi.fn<typeof apiModule.api.bindAgentRole>(),
            unbindAgentRole: vi.fn<typeof apiModule.api.unbindAgentRole>(),
        },
    };
});
const mockedApi = vi.mocked(api, true);

const ROLE_A: apiModule.ApiPreset = {
    id: "role-a",
    name: "AUDITOR",
    displayName: "Auditor",
    description: null,
    system: false,
    atoms: [{ name: "read", scopeClass: "both", capability: false, resource: "*" }],
    bindingCount: 1,
};

function bindingsOf(rows: apiModule.ApiBindingInput[]): apiModule.ApiBindingSet {
    return { scopeType: "instance", scopeId: null, bindings: rows };
}

function mountPanel() {
    return mount(RoleBindingsPanel, {
        props: { presets: [ROLE_A], workspaces: [] },
        global: {
            plugins: [i18n],
            stubs: {
                AgentRoleBindingsSection: {
                    name: "AgentRoleBindingsSection",
                    props: ["scope", "scopeId", "workspaceId", "presets"],
                    emits: ["notice", "dirty"],
                    template: '<div data-testid="agent-role-section-stub" />',
                },
            },
        },
    });
}

function lastDirty(wrapper: ReturnType<typeof mountPanel>): boolean | undefined {
    const events = wrapper.emitted("dirty") ?? [];
    return events.length === 0 ? undefined : (events.at(-1)?.[0] as boolean);
}

describe("RoleBindingsPanel · dirty 派生（task-92）", () => {
    beforeEach(() => {
        mockedApi.getBindings.mockReset();
        mockedApi.replaceBindings.mockReset();
        mockedApi.getBindings.mockResolvedValue(
            bindingsOf([{ subjectType: "user", subjectId: "user-1", roleId: "role-a" }]),
        );
        mockedApi.replaceBindings.mockImplementation(async (_scope, _scopeId, rows) =>
            bindingsOf(rows),
        );
    });

    it("载入后 user 段无改动 ⇒ dirty=false", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        expect(lastDirty(wrapper), "刚从服务端载入的行就是基准，不许一上来就算脏").toBe(false);
        wrapper.unmount();
    });

    it("删掉一行（与 bindingSet 不同）⇒ dirty=true", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.get('[data-testid="role-binding-remove-user-1-role-a"]').trigger("click");
        await flushPromises();
        expect(lastDirty(wrapper)).toBe(true);
        wrapper.unmount();
    });

    it("保存成功后基准随之复位 ⇒ dirty=false", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.get('[data-testid="role-binding-remove-user-1-role-a"]').trigger("click");
        await flushPromises();
        expect(lastDirty(wrapper)).toBe(true);

        await wrapper.get('[data-testid="preset-bindings-save"]').trigger("click");
        await flushPromises();
        expect(mockedApi.replaceBindings).toHaveBeenCalledTimes(1);
        expect(lastDirty(wrapper), "save 之后 bindingSet 已重载，不许还挂着 true").toBe(false);
        wrapper.unmount();
    });

    it("切到 agent_principal 段后它的草稿才算脏；切回 user 段草稿未改 ⇒false", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await setSelectValue(
            wrapper,
            '[data-testid="preset-bindings-subject-type"]',
            "agent_principal",
        );
        await flushPromises();

        const section = wrapper.findComponent({ name: "AgentRoleBindingsSection" });
        expect(section.exists()).toBe(true);
        section.vm.$emit("dirty", true);
        await flushPromises();
        expect(lastDirty(wrapper), "当前段是 agent ⇒ 它的草稿要算").toBe(true);

        await setSelectValue(wrapper, '[data-testid="preset-bindings-subject-type"]', "user");
        await flushPromises();
        expect(lastDirty(wrapper), "切回 user 段：user 行没改，必须回到 false").toBe(false);
        wrapper.unmount();
    });
});
