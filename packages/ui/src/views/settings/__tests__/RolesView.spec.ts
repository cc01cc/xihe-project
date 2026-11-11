import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../../i18n";
import { api, ApiError } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";
import RolesView from "../RolesView.vue";
import { roleErrorKey, roleErrorMessage } from "../../../components/settings/roleErrorMessages";
import { openSelect, selectItemComponents, setSelectValue } from "../../../test-utils/select";

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            rolesCatalog: vi.fn<typeof apiModule.api.rolesCatalog>(),
            listRoles: vi.fn<typeof apiModule.api.listRoles>(),
            createRole: vi.fn<typeof apiModule.api.createRole>(),
            updateRole: vi.fn<typeof apiModule.api.updateRole>(),
            deleteRole: vi.fn<typeof apiModule.api.deleteRole>(),
            getBindings: vi.fn<typeof apiModule.api.getBindings>(),
            replaceBindings: vi.fn<typeof apiModule.api.replaceBindings>(),
            listAdminUsers: vi.fn<typeof apiModule.api.listAdminUsers>(),
            listWorkspaces: vi.fn<typeof apiModule.api.listWorkspaces>(),
            getWorkspaceAgents: vi.fn<typeof apiModule.api.getWorkspaceAgents>(),
            listAgentPrincipals: vi.fn<typeof apiModule.api.listAgentPrincipals>(),
            getAgentRoles: vi.fn<typeof apiModule.api.getAgentRoles>(),
            bindAgentRole: vi.fn<typeof apiModule.api.bindAgentRole>(),
            unbindAgentRole: vi.fn<typeof apiModule.api.unbindAgentRole>(),
        },
    };
});

/**
 * PLAN-0610 W5b / BL-393: the page guard reads the `MANAGE_ROLES` action atom
 * (`auth.canManageRoles`); the `isInstanceAdmin` capability flag (`auth.isAdmin`) is kept on the
 * mock so a case can prove it no longer opens the page on its own.
 */
const authState = vi.hoisted(() => ({ isAdmin: true, canManageRoles: true }));
const authEnsureSelfPermissions = vi.hoisted(() =>
    vi.fn<() => Promise<boolean>>(() => Promise.resolve(true)),
);
vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({
        ensureSelfPermissions: authEnsureSelfPermissions,
        get isAdmin() {
            return authState.isAdmin;
        },
        get canManageRoles() {
            return authState.canManageRoles;
        },
    }),
}));

const mockedApi = vi.mocked(api, true);

const INSTANCE_ATOM: apiModule.ApiRoleAtom = {
    name: "MANAGE_ROLES",
    scopeClass: "instance",
    capability: false,
    resource: "*",
};
const BOTH_ATOM: apiModule.ApiRoleAtom = {
    name: "read",
    scopeClass: "both",
    capability: false,
    resource: "*",
};
const CAPABILITY_ATOM: apiModule.ApiRoleAtom = {
    name: "instance:admin",
    scopeClass: "instance",
    capability: true,
    resource: "*",
};
/** Deliberately invented: proves the editor renders the catalog instead of a hardcoded list. */
const FUTURE_ATOM: apiModule.ApiRoleAtom = {
    name: "FUTURE_ATOM_FROM_CATALOG",
    scopeClass: "both",
    capability: false,
    resource: "*",
};

const CATALOG: apiModule.ApiRoleCatalog = {
    atoms: [INSTANCE_ATOM, CAPABILITY_ATOM, BOTH_ATOM, FUTURE_ATOM],
    scopes: ["instance", "workspace"],
};

function role(overrides: Partial<apiModule.ApiRole> = {}): apiModule.ApiRole {
    return {
        id: "role-1",
        name: "AUDITOR",
        displayName: "Auditor",
        description: null,
        system: false,
        atoms: [BOTH_ATOM],
        bindingCount: 0,
        ...overrides,
    };
}

const SYSTEM_ROLE = role({
    id: "role-sys",
    name: "SUPER_ADMIN",
    displayName: "Super admin",
    system: true,
    atoms: [BOTH_ATOM, INSTANCE_ATOM, CAPABILITY_ATOM],
    bindingCount: 2,
});

function problemError(status: number, code: string): ApiError {
    // The page's localized fallback is the contract here; actionably detailed problems are
    // covered separately (see roleErrorMessages / AgentRoleBindingsSection).
    return new ApiError({ status, code, detail: undefined, requestId: "test" });
}

/**
 * task-36 ②：RolesView 现在由设置区公共壳渲染（返回聊天 + SettingsNav），两者都用真实
 * vue-router API（useRoute/useRouter/RouterLink），所以挂载时必须给一个 router —— 用内存历史
 * 而不是再把 vue-router 整个 mock 掉：本 spec 还要验证「页面自己拉权限」这条 D-713 契约，
 * 真实 router 更接近产品里的直链进入。
 */
const SETTINGS_ROUTE_PATHS = [
    "/settings/config",
    "/settings/tool-faces",
    "/settings/credentials",
    "/settings/knowledge",
    "/settings/data",
    "/settings/monitoring",
    "/settings/audit",
    "/settings/config-locks",
    "/settings/roles",
];

function makeRouter(): Router {
    return createRouter({
        history: createMemoryHistory(),
        routes: [
            ...SETTINGS_ROUTE_PATHS.map((path) => ({ path, component: { template: "<div />" } })),
            { path: "/workspace", component: { template: "<div />" } },
            { path: "/workspace/:workspaceId/chat/:sessionId", component: { template: "<div />" } },
            { path: "/:pathMatch(.*)*", component: { template: "<div />" } },
        ],
    });
}

let wrappers: VueWrapper[] = [];

async function mountView() {
    const wrapper = mount(RolesView, {
        attachTo: document.body,
        global: { plugins: [i18n, makeRouter()] },
    });
    wrappers.push(wrapper);
    await flushPromises();
    return wrapper;
}

async function bodyEl<T extends Element>(selector: string): Promise<T> {
    await vi.waitFor(() => {
        expect(document.body.querySelector(selector)).toBeTruthy();
    });
    return document.body.querySelector(selector) as T;
}

async function clickBody(selector: string) {
    const el = await bodyEl<HTMLElement>(selector);
    el.click();
    await flushPromises();
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    authState.isAdmin = true;
    authState.canManageRoles = true;
    vi.clearAllMocks();
    authEnsureSelfPermissions.mockClear();
    mockedApi.rolesCatalog.mockResolvedValue(CATALOG);
    mockedApi.listRoles.mockResolvedValue([SYSTEM_ROLE, role()]);
    mockedApi.listWorkspaces.mockResolvedValue([]);
    mockedApi.listAdminUsers.mockResolvedValue([]);
    mockedApi.getBindings.mockResolvedValue({ scopeType: "instance", scopeId: null, bindings: [] });
    mockedApi.getWorkspaceAgents.mockResolvedValue([]);
    mockedApi.listAgentPrincipals.mockResolvedValue([]);
    mockedApi.getAgentRoles.mockResolvedValue([]);
});

afterEach(() => {
    wrappers.forEach((wrapper) => wrapper.unmount());
    wrappers = [];
    document.body.innerHTML = "";
});

describe("RolesView access control", () => {
    it("D-713/B7: direct mount asks auth for self permissions before rendering the page", async () => {
        // Direct route frames may arrive before SettingsNav mounted; the page must not 403 on
        // an unknown projection just because the nav did not fetch it first.
        await mountView();
        // task-36 ②：页面外面现在套了设置区公共壳，壳里的 SettingsNav 也会在 onMounted 拉一次，
        // 所以「被调用」从 1 次变 2 次。真正的不变式是：**页面自己也拉了**（直链进入不等导航），
        // 网络请求仍只有一条 —— stores/auth.ts 的 ensureSelfPermissions 是缓存 + 单飞。
        expect(authEnsureSelfPermissions).toHaveBeenCalled();
        expect(authEnsureSelfPermissions.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it("renders the forbidden view for a non-administrator and issues no request", async () => {
        authState.isAdmin = false;
        authState.canManageRoles = false;
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="roles-forbidden"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="roles-table"]').exists()).toBe(false);
        expect(mockedApi.listRoles).not.toHaveBeenCalled();
        expect(mockedApi.rolesCatalog).not.toHaveBeenCalled();
    });

    it("BL-393: opens the page for a principal holding only the MANAGE_ROLES atom", async () => {
        // CP serves this face on the atom (`RoleController`/`BindingController`), so a custom role
        // without the `instance:admin` capability must not be refused by the UI guard.
        authState.isAdmin = false;
        authState.canManageRoles = true;
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="roles-forbidden"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="roles-table"]').exists()).toBe(true);
        await vi.waitFor(() => expect(mockedApi.listRoles).toHaveBeenCalledTimes(1));
    });

    it("BL-393: the instance-admin capability alone no longer opens the page", async () => {
        // Fail-closed and consistent with CP: the capability flag is not a stand-in for the atom.
        authState.isAdmin = true;
        authState.canManageRoles = false;
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="roles-forbidden"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="roles-table"]').exists()).toBe(false);
        expect(mockedApi.listRoles).not.toHaveBeenCalled();
    });
});

describe("RolesView role list", () => {
    it("marks system roles, shows atom and binding counts, and disables their delete action", async () => {
        const wrapper = await mountView();

        const systemRow = wrapper.get('[data-testid="role-row-SUPER_ADMIN"]');
        expect(systemRow.find('[data-testid="role-system-badge"]').exists()).toBe(true);
        expect(systemRow.text()).toContain("3"); // atom count via the localized "{count} atoms"
        expect(systemRow.get('[data-testid="role-binding-count"]').text()).toBe("2");
        const deleteButton = systemRow.get('[data-testid="role-delete-SUPER_ADMIN"]');
        expect(deleteButton.attributes("disabled")).toBeDefined();

        // A custom role keeps its delete action enabled.
        const customRow = wrapper.get('[data-testid="role-row-AUDITOR"]');
        expect(
            customRow.get('[data-testid="role-delete-AUDITOR"]').attributes("disabled"),
        ).toBeUndefined();
        expect(customRow.find('[data-testid="role-system-badge"]').exists()).toBe(false);
    });

    it("F-19: renders an empty state with a create path when there are no roles", async () => {
        mockedApi.listRoles.mockResolvedValue([]);
        const wrapper = await mountView();

        // 0 行时不再渲染只有表头 + 一片空白的 table。
        expect(wrapper.find('[data-testid="roles-table"]').exists()).toBe(false);
        const empty = wrapper.get('[data-testid="roles-empty"]');
        expect(empty.text()).toContain(i18n.global.t("settings.rolesEmptyTitle"));
        expect(empty.text()).toContain(i18n.global.t("settings.rolesEmptyBody"));

        // 出口：空态里的新建按钮打开同一个编辑器。
        await clickBody('[data-testid="roles-empty-create"]');
        expect(await bodyEl('[data-testid="role-editor-name"]')).toBeTruthy();
    });

    it("shows the unified error surface when the role list cannot be loaded (F-18)", async () => {
        mockedApi.listRoles.mockRejectedValue(problemError(403, "FORBIDDEN"));
        const wrapper = await mountView();

        // 加载错误不再进 roles-error（那是保存/删除错误的本地化面），走统一错误面。
        expect(wrapper.find('[data-testid="roles-error"]').exists()).toBe(false);
        const panel = wrapper.get('[data-testid="settings-error-panel"]');
        expect(panel.text()).toContain(i18n.global.t("settings.errorSurface.forbidden"));
        expect(panel.text()).not.toContain("FORBIDDEN");
        expect(panel.text()).not.toContain("API error");
    });

    it("treats a 404 on the roles endpoints as a backend gap, not a raw error (F-18)", async () => {
        mockedApi.listRoles.mockRejectedValue(problemError(404, "MOCK_ENDPOINT_MISSING"));
        const wrapper = await mountView();

        const gap = wrapper.get('[data-testid="settings-error-gap"]');
        expect(gap.text()).toContain(i18n.global.t("settings.ia.backendGapBadgeGeneric"));
        expect(wrapper.text()).not.toContain("MOCK_ENDPOINT_MISSING");
        expect(wrapper.text()).not.toContain("API error");
        expect(wrapper.find('[data-testid="settings-error-panel"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="roles-error"]').exists()).toBe(false);
    });
});

describe("RoleEditorDialog catalog wiring", () => {
    it("renders atoms from GET /roles/catalog, grouped by scope class", async () => {
        await mountView();
        await clickBody('[data-testid="roles-create"]');

        const instanceGroup = await bodyEl('[data-testid="role-editor-atoms-instance"]');
        const bothGroup = await bodyEl('[data-testid="role-editor-atoms-both"]');

        // The invented atom proves nothing is hardcoded on the UI side.
        expect(instanceGroup.textContent).toContain("MANAGE_ROLES");
        expect(instanceGroup.textContent).toContain("instance:admin");
        expect(bothGroup.textContent).toContain("FUTURE_ATOM_FROM_CATALOG");
        expect(bothGroup.textContent).toContain("read");
        // Scope-class copy is rendered next to each group.
        expect(instanceGroup.textContent).toContain(
            i18n.global.t("settings.rolesEditorGroupInstanceHint"),
        );
        expect(bothGroup.textContent).toContain(i18n.global.t("settings.rolesEditorGroupBothHint"));
    });

    it("creates a role with the selected catalog atoms", async () => {
        mockedApi.createRole.mockResolvedValue(role({ id: "role-new", name: "FUTURE_ROLE" }));
        await mountView();
        await clickBody('[data-testid="roles-create"]');

        const nameInput = (await bodyEl('[data-testid="role-editor-name"]')) as HTMLInputElement;
        nameInput.value = "FUTURE_ROLE";
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
        const displayInput = (await bodyEl(
            '[data-testid="role-editor-display-name"]',
        )) as HTMLInputElement;
        displayInput.value = "Future role";
        displayInput.dispatchEvent(new Event("input", { bubbles: true }));
        await clickBody('[data-testid="role-editor-atom-FUTURE_ATOM_FROM_CATALOG"]');
        await clickBody('[data-testid="role-editor-submit"]');

        await vi.waitFor(() => expect(mockedApi.createRole).toHaveBeenCalled());
        expect(mockedApi.createRole.mock.calls[0]?.[0]).toEqual({
            name: "FUTURE_ROLE",
            displayName: "Future role",
            description: "",
            atoms: ["FUTURE_ATOM_FROM_CATALOG"],
        });
    });

    it("sends only the display name for a system role", async () => {
        mockedApi.updateRole.mockResolvedValue(SYSTEM_ROLE);
        await mountView();
        await clickBody('[data-testid="role-edit-SUPER_ADMIN"]');

        expect(await bodyEl('[data-testid="role-editor-system-hint"]')).toBeTruthy();
        const nameInput = (await bodyEl('[data-testid="role-editor-name"]')) as HTMLInputElement;
        expect(nameInput.disabled).toBe(true);
        const displayInput = (await bodyEl(
            '[data-testid="role-editor-display-name"]',
        )) as HTMLInputElement;
        displayInput.value = "Renamed super admin";
        displayInput.dispatchEvent(new Event("input", { bubbles: true }));
        await clickBody('[data-testid="role-editor-submit"]');

        await vi.waitFor(() => expect(mockedApi.updateRole).toHaveBeenCalled());
        const [roleId, payload] = mockedApi.updateRole.mock.calls[0] ?? [];
        expect(roleId).toBe("role-sys");
        expect(payload).toEqual({ displayName: "Renamed super admin", description: "" });
        expect(payload).not.toHaveProperty("atoms");
        expect(payload).not.toHaveProperty("name");
    });
});

describe("RolesView delete flow", () => {
    it("deletes a custom role after confirmation", async () => {
        mockedApi.deleteRole.mockResolvedValue(undefined);
        await mountView();

        await clickBody('[data-testid="role-delete-AUDITOR"]');
        await clickBody('[data-testid="role-delete-confirm"]');

        await vi.waitFor(() => expect(mockedApi.deleteRole).toHaveBeenCalledWith("role-1"));
        expect(mockedApi.listRoles).toHaveBeenCalledTimes(2);
    });

    it("localizes ROLE_IN_USE instead of echoing the server detail", async () => {
        mockedApi.deleteRole.mockRejectedValue(problemError(409, "ROLE_IN_USE"));
        const wrapper = await mountView();

        await clickBody('[data-testid="role-delete-AUDITOR"]');
        await clickBody('[data-testid="role-delete-confirm"]');

        const error = wrapper.get('[data-testid="roles-error"]');
        expect(error.text()).toBe(i18n.global.t("settings.rolesError.roleInUse"));
        expect(error.text()).not.toContain("english detail");
    });

    it("localizes SYSTEM_ROLE_IMMUTABLE when the server refuses", async () => {
        mockedApi.updateRole.mockRejectedValue(problemError(409, "SYSTEM_ROLE_IMMUTABLE"));
        const wrapper = await mountView();

        await clickBody('[data-testid="role-edit-SUPER_ADMIN"]');
        await clickBody('[data-testid="role-editor-submit"]');

        await vi.waitFor(() =>
            expect(wrapper.get('[data-testid="roles-error"]').text()).toBe(
                i18n.global.t("settings.rolesError.systemRoleImmutable"),
            ),
        );
    });
});

describe("RoleBindingsPanel", () => {
    async function openBindings() {
        const wrapper = await mountView();
        await clickBody('[data-testid="roles-tab-bindings"]');
        return wrapper;
    }

    it("reads the instance scope on open and sends the full replacement on save", async () => {
        mockedApi.getBindings.mockResolvedValue({
            scopeType: "instance",
            scopeId: null,
            bindings: [
                {
                    id: "b-1",
                    subjectType: "user",
                    subjectId: "user-1",
                    roleId: "role-sys",
                    roleName: "SUPER_ADMIN",
                    grantedBy: null,
                    grantedAt: null,
                },
            ],
        });
        mockedApi.listAdminUsers.mockResolvedValue([
            { id: "user-1", email: "a@xihe.local", username: "alice" },
            { id: "user-2", email: "b@xihe.local", username: "bob" },
        ]);
        mockedApi.replaceBindings.mockResolvedValue({
            scopeType: "instance",
            scopeId: null,
            bindings: [
                {
                    id: "b-1",
                    subjectType: "user",
                    subjectId: "user-1",
                    roleId: "role-sys",
                    roleName: "SUPER_ADMIN",
                    grantedBy: null,
                    grantedAt: null,
                },
                {
                    id: "b-2",
                    subjectType: "user",
                    subjectId: "user-2",
                    roleId: "role-1",
                    roleName: "AUDITOR",
                    grantedBy: null,
                    grantedAt: null,
                },
            ],
        });

        const wrapper = await openBindings();
        await vi.waitFor(() =>
            expect(mockedApi.getBindings).toHaveBeenCalledWith("instance", null),
        );

        // Existing row is shown and its role resolved from the role list.
        const row = wrapper.get('[data-testid="role-binding-row-user-1"]');
        expect(row.text()).toContain("Super admin");

        // Add a second binding through the account search + role select.
        await clickBody('[data-testid="role-bindings-subject-search"]');
        await vi.waitFor(() =>
            expect(
                document.body.querySelector('[data-testid="role-bindings-subject"]'),
            ).toBeTruthy(),
        );
        await setSelectValue(wrapper, '[data-testid="role-bindings-subject"]', "user-2");
        await setSelectValue(wrapper, '[data-testid="role-bindings-role"]', "role-1");
        await clickBody('[data-testid="role-bindings-add"]');

        await clickBody('[data-testid="role-bindings-save"]');

        await vi.waitFor(() => expect(mockedApi.replaceBindings).toHaveBeenCalled());
        const [scope, scopeId, payload] = mockedApi.replaceBindings.mock.calls[0] ?? [];
        expect(scope).toBe("instance");
        expect(scopeId).toBeNull();
        // Full replacement: both the pre-existing row and the new one, never a delta.
        expect(payload).toEqual([
            { subjectType: "user", subjectId: "user-1", roleId: "role-sys" },
            { subjectType: "user", subjectId: "user-2", roleId: "role-1" },
        ]);
        // The returned set drives the effective-capability summary.
        const effective = wrapper.get('[data-testid="role-bindings-effective"]');
        expect(effective.text()).toContain("alice");
        expect(effective.text()).toContain("read");
        expect(effective.text()).toContain("MANAGE_ROLES");
    });

    it.each([
        ["ROLE_SCOPE_MISMATCH", 400, "roleScopeMismatch"],
        ["PRIVILEGE_ESCALATION", 403, "privilegeEscalation"],
        ["LAST_SUPER_ADMIN", 409, "lastSuperAdmin"],
        ["CONCURRENT_MODIFICATION", 409, "concurrentModification"],
    ])("localizes %s on save", async (code, status, key) => {
        mockedApi.replaceBindings.mockRejectedValue(problemError(status, code));
        const wrapper = await openBindings();

        await clickBody('[data-testid="role-bindings-save"]');

        await vi.waitFor(() =>
            expect(wrapper.get('[data-testid="role-bindings-error"]').text()).toBe(
                i18n.global.t(`settings.rolesError.${key}`),
            ),
        );
        expect(wrapper.get('[data-testid="role-bindings-error"]').text()).not.toContain(
            "english detail",
        );
    });

    it("marks instance-only roles as unusable in the workspace scope", async () => {
        mockedApi.listWorkspaces.mockResolvedValue([
            { id: "ws-1", name: "Workspace One" },
        ] as never);
        mockedApi.listRoles.mockResolvedValue([
            SYSTEM_ROLE,
            role({ id: "role-both", name: "AUDITOR", atoms: [BOTH_ATOM] }),
            role({ id: "role-instance", name: "INSTANCE_ONLY", atoms: [INSTANCE_ATOM] }),
        ]);
        const wrapper = await openBindings();

        await setSelectValue(wrapper, '[data-testid="role-bindings-scope"]', "workspace");
        await flushPromises();

        await vi.waitFor(() =>
            expect(mockedApi.getBindings).toHaveBeenCalledWith("workspace", "ws-1"),
        );
        await openSelect(wrapper, '[data-testid="role-bindings-role"]');
        const roleItems = selectItemComponents(wrapper);
        const instanceOnly = roleItems.find(
            (item) => item.attributes("data-testid") === "role-bindings-role-option-INSTANCE_ONLY",
        );
        expect(instanceOnly?.props("disabled")).toBe(true);
        // A role whose atoms are all `both` stays selectable.
        const auditor = roleItems.find(
            (item) => item.attributes("data-testid") === "role-bindings-role-option-AUDITOR",
        );
        expect(auditor?.props("disabled")).toBeFalsy();
    });

    it("switches to the agent-principal subject and renders the isolated agent section", async () => {
        mockedApi.listWorkspaces.mockResolvedValue([
            { id: "ws-1", name: "Workspace One" },
        ] as never);
        mockedApi.listAgentPrincipals.mockResolvedValue([
            { principalId: "agent-1", name: "Research Agent" },
        ]);
        mockedApi.getAgentRoles.mockResolvedValue([]);
        const wrapper = await openBindings();

        await setSelectValue(
            wrapper,
            '[data-testid="role-bindings-subject-type"]',
            "agent_principal",
        );
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-role-bindings-section"]').exists()).toBe(true);
        await vi.waitFor(() =>
            expect(mockedApi.getAgentRoles).toHaveBeenCalledWith(null, "agent-1"),
        );
    });
});

describe("roleErrorMessages", () => {
    it("maps every required code and falls back without leaking the detail", () => {
        expect(roleErrorKey(problemError(400, "ROLE_SCOPE_MISMATCH"))).toBe("roleScopeMismatch");
        expect(roleErrorKey(problemError(403, "PRIVILEGE_ESCALATION"))).toBe("privilegeEscalation");
        expect(roleErrorKey(problemError(409, "LAST_SUPER_ADMIN"))).toBe("lastSuperAdmin");
        expect(roleErrorKey(problemError(409, "CONCURRENT_MODIFICATION"))).toBe(
            "concurrentModification",
        );
        expect(roleErrorKey(new Error("boom"))).toBe("generic");

        const message = roleErrorMessage(problemError(409, "ROLE_IN_USE"), (key) => key);
        expect(message).toBe("settings.rolesError.roleInUse");
    });
});
