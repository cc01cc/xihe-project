import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { i18n } from "../../../i18n";
import { api, ApiError } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";
import AgentRoleBindingsSection from "../AgentRoleBindingsSection.vue";

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            getWorkspaceAgents: vi.fn<typeof apiModule.api.getWorkspaceAgents>(),
            listAgentPrincipals: vi.fn<typeof apiModule.api.listAgentPrincipals>(),
            getAgentRoles: vi.fn<typeof apiModule.api.getAgentRoles>(),
            bindAgentRole: vi.fn<typeof apiModule.api.bindAgentRole>(),
            unbindAgentRole: vi.fn<typeof apiModule.api.unbindAgentRole>(),
        },
    };
});

const mockedApi = vi.mocked(api, true);
const ROLES: apiModule.ApiRole[] = [
    {
        id: "role-a",
        name: "AUDITOR",
        displayName: "Auditor",
        description: null,
        system: false,
        atoms: [{ name: "read", scopeClass: "both", capability: false, resource: "*" }],
        bindingCount: 0,
    },
    {
        id: "role-b",
        name: "EDITOR",
        displayName: "Editor",
        description: null,
        system: false,
        atoms: [{ name: "write", scopeClass: "both", capability: false, resource: "*" }],
        bindingCount: 0,
    },
    {
        id: "role-seed",
        name: "SEED",
        displayName: "Seed",
        description: null,
        system: true,
        atoms: [{ name: "read", scopeClass: "both", capability: false, resource: "*" }],
        bindingCount: 0,
    },
];

function binding(roleId: string, bindingId: string, isSystem = false): apiModule.AgentRoleBinding {
    return {
        bindingId,
        roleId,
        name: roleId,
        displayName: roleId,
        scopeType: "workspace",
        scopeId: "ws-1",
        scopeName: null,
        isSystem,
        atomSummary: [],
        atomCount: 0,
        atomsTruncated: false,
    };
}

function mountSection(scope: apiModule.ApiBindingScope = "workspace") {
    return mount(AgentRoleBindingsSection, {
        attachTo: document.body,
        props: {
            scope,
            scopeId: "ws-1",
            workspaceId: "ws-1",
            roles: ROLES,
        },
        global: { plugins: [i18n] },
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getWorkspaceAgents.mockResolvedValue([
        {
            principalId: "agent-1",
            name: "Research Agent",
            templateId: null,
            templateName: null,
            createdAt: "2026-11-05T00:00:00Z",
            permissionsSnapshot: [],
            bound: true,
            disabled: false,
        },
    ]);
    mockedApi.listAgentPrincipals.mockResolvedValue([
        { principalId: "agent-1", name: "Research Agent" },
    ]);
    mockedApi.getAgentRoles.mockResolvedValue([binding("role-seed", "seed-1", true)]);
    mockedApi.bindAgentRole.mockResolvedValue(undefined);
    mockedApi.unbindAgentRole.mockResolvedValue(undefined);
});

describe("AgentRoleBindingsSection (PLAN-0651 T5.2)", () => {
    it("loads an agent's bindings, saves an added role, and shows seed bindings as read-only", async () => {
        mockedApi.getAgentRoles
            .mockResolvedValueOnce([binding("role-seed", "seed-1", true)])
            .mockResolvedValueOnce([
                binding("role-seed", "seed-1", true),
                binding("role-b", "binding-b"),
            ]);
        const wrapper = mountSection();
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-role-bindings-agent"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-role-binding-remove-role-seed"]').exists()).toBe(
            false,
        );

        await wrapper.find('[data-testid="agent-role-bindings-role"]').setValue("role-b");
        await wrapper.find('[data-testid="agent-role-bindings-add"]').trigger("click");
        await wrapper.find('[data-testid="agent-role-bindings-save"]').trigger("click");
        await flushPromises();

        expect(mockedApi.bindAgentRole).toHaveBeenCalledWith("ws-1", "agent-1", "role-b");
        expect(mockedApi.unbindAgentRole).not.toHaveBeenCalled();
        expect(wrapper.emitted("notice")?.length).toBeGreaterThan(0);
    });

    it("unbinds a removed non-seed role", async () => {
        mockedApi.getAgentRoles
            .mockResolvedValueOnce([
                binding("role-seed", "seed-1", true),
                binding("role-a", "binding-a"),
            ])
            .mockResolvedValueOnce([binding("role-seed", "seed-1", true)]);
        const wrapper = mountSection();
        await flushPromises();

        await wrapper.find('[data-testid="agent-role-binding-remove-role-a"]').trigger("click");
        await wrapper.find('[data-testid="agent-role-bindings-save"]').trigger("click");
        await flushPromises();

        expect(mockedApi.unbindAgentRole).toHaveBeenCalledWith("ws-1", "agent-1", "binding-a");
        expect(mockedApi.bindAgentRole).not.toHaveBeenCalled();
    });

    it("surfaces the 409 ROLE_BINDING_EXCEEDS_CAP detail instead of a generic message", async () => {
        mockedApi.getAgentRoles.mockResolvedValue([binding("role-seed", "seed-1", true)]);
        mockedApi.bindAgentRole.mockRejectedValue(
            new ApiError({
                status: 409,
                code: "ROLE_BINDING_EXCEEDS_CAP",
                detail: "cap exceeded: requires WRITE_SECRETS",
                requestId: "test",
            }),
        );
        const wrapper = mountSection();
        await flushPromises();

        await wrapper.find('[data-testid="agent-role-bindings-role"]').setValue("role-b");
        await wrapper.find('[data-testid="agent-role-bindings-add"]').trigger("click");
        await wrapper.find('[data-testid="agent-role-bindings-save"]').trigger("click");
        await flushPromises();

        expect(wrapper.get('[data-testid="agent-role-bindings-error"]').text()).toContain(
            "cap exceeded: requires WRITE_SECRETS",
        );
    });

    it("localizes 409 AGENT_PRINCIPAL_FORBIDDEN_ATOMS instead of echoing the English detail", async () => {
        mockedApi.bindAgentRole.mockRejectedValue(
            new ApiError({
                status: 409,
                code: "AGENT_PRINCIPAL_FORBIDDEN_ATOMS",
                detail: "role carries atoms an agent principal may never hold: credential.use,instance:admin",
                requestId: "test",
            }),
        );
        const wrapper = mountSection();
        await flushPromises();

        await wrapper.find('[data-testid="agent-role-bindings-role"]').setValue("role-b");
        await wrapper.find('[data-testid="agent-role-bindings-add"]').trigger("click");
        await wrapper.find('[data-testid="agent-role-bindings-save"]').trigger("click");
        await flushPromises();

        const text = wrapper.get('[data-testid="agent-role-bindings-error"]').text();
        const zh = i18n.global.getLocaleMessage("zh-CN") as {
            settings: { rolesError: Record<string, string> };
        };
        const en = i18n.global.getLocaleMessage("en-US") as {
            settings: { rolesError: Record<string, string> };
        };
        expect(text).toBe(zh.settings.rolesError.agentRoleForbiddenAtoms);
        expect(text).not.toContain("credential.use");
        expect(en.settings.rolesError.agentRoleForbiddenAtoms).toBeTruthy();
    });

    it("uses the instance authorization context (no workspace query) for instance scope", async () => {
        mountSection("instance");
        await flushPromises();

        expect(mockedApi.listAgentPrincipals).toHaveBeenCalledWith();
        expect(mockedApi.getWorkspaceAgents).not.toHaveBeenCalled();
        expect(mockedApi.getAgentRoles).toHaveBeenCalledWith(null, "agent-1");
    });
});
