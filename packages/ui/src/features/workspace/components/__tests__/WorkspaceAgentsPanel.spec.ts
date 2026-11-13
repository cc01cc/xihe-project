import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { i18n } from "../../../../i18n";
import { openSelect, selectItemValuesFor, setSelectValue } from "../../../../test-utils/select";

const WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";

const apiMock = vi.hoisted(() => ({
    getWorkspaceAgents: vi.fn<() => Promise<unknown[]>>(),
    getAgentTemplates: vi.fn<() => Promise<unknown>>(),
    // PLAN-0622：创建改为对象入参（name/templateId/scope/defaultModel*/allowedModels）。
    createAgentPrincipal: vi.fn<(input: unknown) => Promise<unknown>>(),
    updateWorkspaceAgentCap: vi.fn<() => Promise<unknown>>(),
    deleteWorkspaceAgent: vi.fn<() => Promise<void>>(),
    disableAgentPrincipal: vi.fn<(principalId: string) => Promise<void>>(),
    // PLAN-0621 F-01：权威能力投影（CP `GET /me/permissions`）。
    getSelfPermissions: vi.fn<() => Promise<unknown>>(),
    // PLAN-0629 M1-4 C：只读记忆列表。
    getWorkspaceAgentMemories: vi.fn<() => Promise<unknown[]>>(),
    // PLAN-0629 M1-5：记忆写入面（v2 裁定：无 type、归档软删、启用开关走 contextPolicy）。
    createAgentMemory: vi.fn<() => Promise<void>>(),
    updateAgentMemory: vi.fn<() => Promise<void>>(),
    deleteAgentMemory: vi.fn<() => Promise<void>>(),
    updateAgentPrincipalContextPolicy: vi.fn<() => Promise<void>>(),
    // PLAN-0667 M3：角色 / 技能区块（六条 agent 子资源 + 两条候选清单）。
    getAgentRoles: vi.fn<() => Promise<unknown[]>>(),
    getAgentSkills: vi.fn<() => Promise<unknown[]>>(),
    bindAgentRole: vi.fn<() => Promise<void>>(),
    unbindAgentRole: vi.fn<() => Promise<void>>(),
    bindAgentSkill: vi.fn<() => Promise<void>>(),
    unbindAgentSkill: vi.fn<() => Promise<void>>(),
    listRoles: vi.fn<() => Promise<unknown[]>>(),
    getSkills: vi.fn<() => Promise<unknown[]>>(),
    getWorkspaceSkills: vi.fn<(workspaceId: string) => Promise<unknown[]>>(),
}));

const CREATE_ACCOUNT_MISSING = {
    userId: "99999999-9999-4999-8999-999999999999",
    instanceCapabilities: [],
    instancePermissions: [{ actionClass: "READ", resource: "*" }],
    workspaces: [],
};

vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        api: apiMock,
        ApiError: class MockApiError extends Error {
            problem: { code: string; detail?: string };
            constructor(code: string, detail = "CREATE_ACCOUNT permission is required") {
                super(detail);
                this.name = "MockApiError";
                this.problem = { code, detail };
            }
        },
    };
});

const admin = { value: true };
/**
 * task-74：面板的鉴权面是三件（能力位 / `READ_INSTANCE_CONTENT` 原子 / `MANAGE_WORKSPACE_POLICY` 原子）。
 * 本 spec 不测判据轴，只测面板行为 ⇒ 三个都绑同一个 `admin` 开关，保持既有用例语义不变；
 * 判据轴本身由 authStore 单测与 18 处对照表（evidence/2026-11-13-a1-isadmin-cp-guard-matrix）负责。
 */
vi.mock("../../../../stores/auth", () => ({
    useAuthStore: () => ({
        isAdmin: admin.value,
        canReadInstanceContent: admin.value,
        canManageWorkspacePolicy: admin.value,
        canManageWorkspace: true,
        user: { id: "99999999-9999-4999-8999-999999999999" },
    }),
}));

import { ApiError } from "../../../../composables/api";
import WorkspaceAgentsPanel from "../WorkspaceAgentsPanel.vue";
import WorkspaceAgentManagementDialog from "../WorkspaceAgentManagementDialog.vue";

/**
 * PLAN-0626 M3：面板没有 `open` 开关 —— 挂载即打开（dock 标签激活 / 移动端弹窗），
 * 加载时机是 `onMounted`。测试照这个生命周期挂载，不再用 `setProps({ open: true })`。
 */
async function mountOpenedPanel() {
    const wrapper = mountTracked({
        attachTo: document.body,
        props: { workspaceId: WORKSPACE_ID },
        global: {
            plugins: [i18n],
            stubs: { RouterLink: { props: ["to"], template: '<a :href="to"><slot /></a>' } },
        },
    });
    await flushPromises();
    return wrapper;
}

function mountPanel() {
    return mountTracked({
        attachTo: document.body,
        props: { workspaceId: WORKSPACE_ID },
        global: {
            plugins: [i18n],
            stubs: { RouterLink: { props: ["to"], template: '<a :href="to"><slot /></a>' } },
        },
    });
}

beforeEach(() => {
    admin.value = true;
    localStorage.removeItem("xihe-pending-agent-principals");
    // BL-359：`clearAllMocks` 只清调用记录，**不清 `mockResolvedValueOnce`/`mockRejectedValueOnce`
    // 的未消费队列**；一旦上一条用例留下的 once 值排到本用例，行为就随顺序变化
    // （`toHaveBeenCalledTimes(2)` 因此红）。这里用 `mockReset` 把队列一并清空，再重设默认值。
    // BL-359：`getWorkspaceAgents` 也有 `mockResolvedValueOnce`（L445 等）——未消费的 once 队列会
    // 优先于 `mockResolvedValue` 生效，让本用例拿到"另一个智能体"（例如 `memory.enabled=false`），
    // 于是「新建记忆」按钮 `:disabled` 为 true、点击无效、`v-if` 永不渲染。
    apiMock.getWorkspaceAgents.mockReset();
    apiMock.getWorkspaceAgentMemories.mockReset();
    apiMock.createAgentMemory.mockReset();
    apiMock.deleteAgentMemory.mockReset();
    apiMock.getWorkspaceAgents.mockResolvedValue([]);
    apiMock.getAgentTemplates.mockResolvedValue({
        layer: "instance",
        workspaceId: null,
        templates: [],
    });
    apiMock.updateWorkspaceAgentCap.mockResolvedValue({});
    apiMock.deleteWorkspaceAgent.mockResolvedValue(undefined);
    apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
    apiMock.getWorkspaceAgentMemories.mockResolvedValue([]);
});

afterEach(() => {
    // BL-359：teleport 到 body 的 Dialog 必须 unmount 才会重置 open 状态；清 innerHTML 不够
    // （`document.body.innerHTML = ""` 只删 DOM 节点，Vue 的 `open` 仍是 true ⇒ 下一条用例
    //  挂载时"上一个对话框还开着"，`wrapper.get(...)` 会取到别的对话框里的元素）。
    for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount();
    vi.clearAllMocks();
    document.body.innerHTML = "";
});

/** BL-359：所有挂载都登记，`afterEach` 统一 `unmount()`（teleport 组件的 open 状态只能靠卸载重置）。 */
const mountedWrappers: VueWrapper[] = [];

function mountTracked(options: Parameters<typeof mount>[1]): VueWrapper {
    const wrapper = mount(WorkspaceAgentsPanel, options) as VueWrapper;
    mountedWrappers.push(wrapper);
    return wrapper;
}
describe("WorkspaceAgentsPanel principal naming (2026-11-04)", () => {
    it("blocks a name with a space and explains the rule", async () => {
        const wrapper = await mountOpenedPanel();
        await wrapper.find('[data-testid="agent-principal-name"]').setValue("Research Agent");
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-principal-name-error"]').exists()).toBe(true);
        expect(
            wrapper.find('[data-testid="agent-principal-create"]').attributes("disabled"),
        ).toBeDefined();
        expect(apiMock.createAgentPrincipal).not.toHaveBeenCalled();
    });

    it("blocks a name starting with a digit", async () => {
        const wrapper = await mountOpenedPanel();
        await wrapper.find('[data-testid="agent-principal-name"]').setValue("1agent");
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-principal-name-error"]').exists()).toBe(true);
        expect(
            wrapper.find('[data-testid="agent-principal-create"]').attributes("disabled"),
        ).toBeDefined();
    });
});

describe("WorkspaceAgentsPanel F-02 grant hint (PLAN-0585 M2 / PLAN-0610 W5c)", () => {
    it("shows a localized actionable hint plus a link to the role surface for admins", async () => {
        const wrapper = mountPanel();
        await flushPromises();

        const link = wrapper.find('[data-testid="agent-grant-panel-link"]');
        expect(link.exists()).toBe(true);
        // W5c: the retired principal-grant page is replaced by roles & bindings.
        expect(link.attributes("href")).toBe("/settings/roles");
        // The static note names the admin surface instead of only stating the requirement.
        expect(wrapper.text()).toContain("角色与绑定");
    });

    it("replaces a 403 create failure with the localized hint, never the CP English detail", async () => {
        const ErrorCtor = ApiError as unknown as new (code: string) => Error;
        apiMock.createAgentPrincipal.mockRejectedValue(new ErrorCtor("FORBIDDEN"));
        const wrapper = await mountOpenedPanel();

        await wrapper.find('[data-testid="agent-principal-name"]').setValue("ResearchAgent");
        await wrapper.find('[data-testid="agent-principal-create-form"]').trigger("submit");
        await flushPromises();

        const text = document.body.textContent ?? "";
        expect(text).toContain("缺少 MANAGE_WORKSPACE_AGENTS 权限");
        expect(text).toContain("角色与绑定");
        expect(text).not.toContain("CREATE_ACCOUNT permission is required");
    });

    it("hides the grant-panel link from non-admins but keeps the actionable note", async () => {
        admin.value = false;
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-grant-panel-link"]').exists()).toBe(false);
        expect(wrapper.text()).toContain("角色与绑定");
    });
});

// PLAN-0621 F-01 / PLAN-0651 T5.1：没有工作区智能体管理权限的用户在**点击之前**就该知道结果。
describe("WorkspaceAgentsPanel create gating (T5.1 default WORKSPACE)", () => {
    it("disables creation and points at the role surface when the projection lacks MANAGE_WORKSPACE_AGENTS", async () => {
        admin.value = false;
        apiMock.getSelfPermissions.mockResolvedValue(CREATE_ACCOUNT_MISSING);
        const wrapper = await mountOpenedPanel();
        await flushPromises();

        const button = wrapper.find('[data-testid="agent-principal-create"]');
        expect(button.exists()).toBe(true);
        expect(button.attributes("disabled")).toBeDefined();
        // 复用既有文案，不新写一份（概念/文案膨胀门）。
        expect(wrapper.find('[data-testid="agent-create-forbidden-hint"]').exists()).toBe(true);
        expect(wrapper.text()).toContain("MANAGE_WORKSPACE_AGENTS");
        const link = wrapper.find('[data-testid="agent-grant-panel-link"]');
        expect(link.exists()).toBe(true);
        expect(link.attributes("href")).toBe("/settings/roles");
        expect(wrapper.html()).not.toContain("/settings/principal-grants");
    });

    it("keeps creation enabled when the projection grants MANAGE_WORKSPACE_AGENTS", async () => {
        admin.value = false;
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        apiMock.createAgentPrincipal.mockResolvedValue({
            principalId: "77777777-7777-4777-8777-777777777777",
            templateId: null,
            templateName: null,
            createdAt: "2026-11-02T00:00:00Z",
        });
        const wrapper = await mountOpenedPanel();

        await wrapper.find('[data-testid="agent-principal-name"]').setValue("delegate");
        const button = wrapper.find('[data-testid="agent-principal-create"]');
        expect(button.attributes("disabled")).toBeUndefined();
        expect(wrapper.find('[data-testid="agent-create-forbidden-hint"]').exists()).toBe(false);
    });

    it("fails closed when the projection cannot be loaded, without inventing a permission", async () => {
        admin.value = false;
        apiMock.getSelfPermissions.mockRejectedValue(new ApiError("FORBIDDEN"));
        const wrapper = await mountOpenedPanel();
        await flushPromises();

        expect(
            wrapper.find('[data-testid="agent-principal-create"]').attributes("disabled"),
        ).toBeDefined();
        expect(wrapper.find('[data-testid="agent-create-forbidden-hint"]').exists()).toBe(false);
        expect(wrapper.text()).toContain(i18n.global.t("workspace.agentPermissionUnavailable"));
    });

    it("shows a pending permission state until the projection resolves", async () => {
        admin.value = false;
        let resolvePermissions!: (value: unknown) => void;
        apiMock.getSelfPermissions.mockReturnValue(
            new Promise((resolve) => {
                resolvePermissions = resolve;
            }),
        );
        const wrapper = mountPanel();

        expect(wrapper.text()).toContain(i18n.global.t("workspace.agentPermissionLoading"));
        expect(wrapper.find('[data-testid="agent-create-forbidden-hint"]').exists()).toBe(false);

        resolvePermissions(CREATE_ACCOUNT_MISSING);
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-create-forbidden-hint"]').exists()).toBe(true);
        expect(wrapper.text()).not.toContain(i18n.global.t("workspace.agentPermissionLoading"));
    });
});

// ── PLAN-0622（M3 UI 跟随）：agent 三档 scope / 模型意图 / disable / 来源徽标 ────────────
// BL-312：原 PERSONAL-only fixture 持有的 CREATE_OWN_AGENT 已移除；改用仍存在的 user 层原子
// MEMORY_WRITE_SELF——三个用例的语义都是「不持 MANAGE_WORKSPACE_AGENTS ⇒ fail-closed」。
const USER_TIER_ONLY = {
    userId: "99999999-9999-4999-8999-999999999999",
    instanceCapabilities: ["MEMORY_WRITE_SELF"],
    instancePermissions: [{ actionClass: "MEMORY_WRITE_SELF", resource: "*" }],
    workspaces: [],
};
const WORKSPACE_ONLY = {
    userId: "99999999-9999-4999-8999-999999999999",
    instanceCapabilities: [],
    instancePermissions: [],
    workspaces: [
        {
            workspaceId: WORKSPACE_ID,
            workspaceAdmin: true,
            permissions: [{ actionClass: "MANAGE_WORKSPACE_AGENTS", resource: WORKSPACE_ID }],
        },
    ],
};
const NOTHING = {
    userId: "99999999-9999-4999-8999-999999999999",
    instanceCapabilities: [],
    instancePermissions: [{ actionClass: "READ", resource: "*" }],
    workspaces: [],
};

// ── PLAN-0651 M5 T5.1：作用域写面退出（UI 不再提供 scope 选择）────────────────────────
describe("WorkspaceAgentsPanel T5.1 scope write exit", () => {
    it("does not render a scope write control", async () => {
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        const wrapper = await mountOpenedPanel();
        expect(wrapper.find('[data-testid="agent-principal-scope"]').exists()).toBe(false);
        expect(wrapper.html()).not.toContain("data-agent-scope");
    });

    it("gates creation on MANAGE_WORKSPACE_AGENTS because CP defaults to WORKSPACE", async () => {
        apiMock.getSelfPermissions.mockResolvedValue(USER_TIER_ONLY);
        const personal = await mountOpenedPanel();
        expect(
            personal.find('[data-testid="agent-principal-create"]').attributes("disabled"),
        ).toBeDefined();
        expect(personal.find('[data-testid="agent-create-forbidden-hint"]').exists()).toBe(true);

        apiMock.getSelfPermissions.mockResolvedValue(NOTHING);
        const none = await mountOpenedPanel();
        expect(
            none.find('[data-testid="agent-principal-create"]').attributes("disabled"),
        ).toBeDefined();
    });
});

describe("WorkspaceAgentsPanel PLAN-0622 model intent", () => {
    it("blocks creation until an allowed-model row has both provider and model", async () => {
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        const wrapper = await mountOpenedPanel();
        await wrapper.find('[data-testid="agent-principal-name"]').setValue("delegate");
        expect(
            wrapper.find('[data-testid="agent-principal-create"]').attributes("disabled"),
        ).toBeUndefined();

        await wrapper.find('[data-testid="agent-allowed-model-add"]').trigger("click");
        await wrapper.find('[data-testid="agent-allowed-model-provider-0"]').setValue("openai");
        expect(wrapper.find('[data-testid="agent-allowed-model-error"]').exists()).toBe(true);
        expect(
            wrapper.find('[data-testid="agent-principal-create"]').attributes("disabled"),
        ).toBeDefined();

        await wrapper.find('[data-testid="agent-allowed-model-name-0"]').setValue("gpt-4o-mini");
        expect(wrapper.find('[data-testid="agent-allowed-model-error"]').exists()).toBe(false);
        expect(
            wrapper.find('[data-testid="agent-principal-create"]').attributes("disabled"),
        ).toBeUndefined();
    });

    it("rejects duplicate provider+model pairs", async () => {
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        const wrapper = await mountOpenedPanel();
        await wrapper.find('[data-testid="agent-principal-name"]').setValue("delegate");
        for (const [index, provider, model] of [
            [0, "openai", "gpt-4o-mini"],
            [1, "openai", "gpt-4o-mini"],
        ] as const) {
            await wrapper.find('[data-testid="agent-allowed-model-add"]').trigger("click");
            await wrapper
                .find(`[data-testid="agent-allowed-model-provider-${index}"]`)
                .setValue(provider);
            await wrapper.find(`[data-testid="agent-allowed-model-name-${index}"]`).setValue(model);
        }
        expect(wrapper.find('[data-testid="agent-allowed-model-error"]').text()).toContain("重复");
    });

    it("requires the default model pair to be complete and sends the whole intent", async () => {
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        apiMock.createAgentPrincipal.mockResolvedValue({
            principalId: "88888888-8888-4888-8888-888888888888",
            templateId: null,
            templateName: null,
            createdAt: "2026-11-02T00:00:00Z",
        });
        const wrapper = await mountOpenedPanel();
        await wrapper.find('[data-testid="agent-principal-name"]').setValue("delegate");
        await wrapper.find('[data-testid="agent-default-model-provider"]').setValue("openai");
        expect(wrapper.find('[data-testid="agent-default-model-error"]').exists()).toBe(true);
        await wrapper.find('[data-testid="agent-default-model-name"]').setValue("gpt-4o-mini");
        expect(wrapper.find('[data-testid="agent-default-model-error"]').exists()).toBe(false);

        await wrapper.find('[data-testid="agent-principal-create-form"]').trigger("submit");
        await flushPromises();
        expect(apiMock.createAgentPrincipal).toHaveBeenCalledWith({
            name: "delegate",
            defaultModelProvider: "openai",
            defaultModelName: "gpt-4o-mini",
        });
    });
});

describe("WorkspaceAgentsPanel PLAN-0622 list rows", () => {
    const boundAgent = {
        principalId: "77777777-7777-4777-8777-777777777777",
        name: "helper",
        templateId: null,
        templateName: null,
        createdAt: "2026-11-02T00:00:00Z",
        permissionsSnapshot: [],
        bound: true,
        disabled: false,
        defaultModelProvider: "openai",
        defaultModelName: "gpt-4o-mini",
        allowedModels: [{ provider: "openai", model: "gpt-4o-mini" }],
    };

    it("renders the default model without a tier/scope badge for each row", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([boundAgent]);
        const wrapper = await mountOpenedPanel();
        expect(
            wrapper
                .find('[data-testid="agent-scope-badge-77777777-7777-4777-8777-777777777777"]')
                .exists(),
        ).toBe(false);
        expect(wrapper.html()).not.toContain("data-agent-scope");
        expect(
            wrapper
                .find('[data-testid="agent-default-model-77777777-7777-4777-8777-777777777777"]')
                .text(),
        ).toContain("openai / gpt-4o-mini");
    });

    it("disables an agent only after the second click and spells out the consequence", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([boundAgent]);
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        apiMock.disableAgentPrincipal.mockResolvedValue(undefined);
        const wrapper = await mountOpenedPanel();
        const button = wrapper.find(
            '[data-testid="workspace-agent-disable-77777777-7777-4777-8777-777777777777"]',
        );
        expect(wrapper.text()).toContain("禁用后新会话不能再选择该智能体");

        await button.trigger("click");
        expect(apiMock.disableAgentPrincipal).not.toHaveBeenCalled();
        expect(button.text()).toBe("再次点击确认禁用");

        await button.trigger("click");
        await flushPromises();
        expect(apiMock.disableAgentPrincipal).toHaveBeenCalledWith(boundAgent.principalId);
    });

    it("keeps the disable button disabled when the projection grants nothing", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([boundAgent]);
        admin.value = false;
        apiMock.getSelfPermissions.mockResolvedValue(NOTHING);
        const wrapper = await mountOpenedPanel();
        const button = wrapper.find(
            '[data-testid="workspace-agent-disable-77777777-7777-4777-8777-777777777777"]',
        );
        expect(button.attributes("disabled")).toBeDefined();
    });
});

// ── 真栈 bug（Lead 2026-11-02）：创建成功后列表不刷新，用户要关掉重开面板才看到新 agent ──────
describe("WorkspaceAgentsPanel list refresh after create", () => {
    it("shows the newly created principal without reopening the dialog", async () => {
        const created = {
            principalId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
            name: "Fresh agent",
            templateId: null,
            templateName: null,
            createdAt: "2026-11-02T00:00:00Z",
            permissionsSnapshot: [],
            bound: true,
            disabled: false,
        };
        // 第一次读取（打开面板）还没有它；创建成功后重新读取才出现 —— 这正是真栈的行为。
        apiMock.getWorkspaceAgents.mockResolvedValueOnce([]).mockResolvedValueOnce([created]);
        apiMock.createAgentPrincipal.mockResolvedValue({
            principalId: created.principalId,
            templateId: null,
            templateName: null,
            createdAt: created.createdAt,
        });
        const wrapper = await mountOpenedPanel();
        expect(
            wrapper.find(`[data-testid="workspace-agent-${created.principalId}"]`).exists(),
        ).toBe(false);

        await wrapper.find('[data-testid="agent-principal-name"]').setValue("FreshAgent");
        await wrapper.find('[data-testid="agent-principal-create-form"]').trigger("submit");
        await flushPromises();

        const row = wrapper.find(`[data-testid="workspace-agent-${created.principalId}"]`);
        expect(row.exists(), "the created principal must appear in the list immediately").toBe(
            true,
        );
        expect(wrapper.find('[data-testid="unbound-agent-principal"]').text()).toContain(
            created.principalId,
        );
        expect(wrapper.html()).not.toContain("data-agent-scope");
        expect(apiMock.getWorkspaceAgents).toHaveBeenCalledTimes(2);
        wrapper.unmount();
    });
});

// ── PLAN-0651 recovery: principalId 按 userId+workspaceId 本地保存，绑定成功才清 ─────────
describe("WorkspaceAgentsPanel pending principal recovery", () => {
    const STORAGE_KEY = "xihe-pending-agent-principals";
    const pendingKey = `99999999-9999-4999-8999-999999999999/${WORKSPACE_ID}`;
    const PENDING_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

    function pendingCard(wrapper: Awaited<ReturnType<typeof mountOpenedPanel>>) {
        return wrapper.find('[data-testid="unbound-agent-principal"]');
    }

    it("restores the pending principal after a remount and clears it only after a successful PUT", async () => {
        apiMock.createAgentPrincipal.mockResolvedValue({
            principalId: PENDING_ID,
            templateId: null,
            templateName: null,
            createdAt: "2026-11-05T00:00:00Z",
        });
        apiMock.updateWorkspaceAgentCap.mockResolvedValue({});

        const first = await mountOpenedPanel();
        await first.find('[data-testid="agent-principal-name"]').setValue("PendingAgent");
        await first.find('[data-testid="agent-principal-create-form"]').trigger("submit");
        await flushPromises();

        expect(pendingCard(first).text()).toContain(PENDING_ID);
        expect(pendingCard(first).text()).toContain(
            i18n.global.t("workspace.agentPendingRecoveryNote"),
        );
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<
            string,
            string
        >;
        expect(saved[pendingKey]).toBe(PENDING_ID);
        first.unmount();

        // Close/reopen simulation: the pending card must come back from local storage.
        apiMock.getWorkspaceAgents.mockResolvedValue([]);
        const restored = await mountOpenedPanel();
        expect(pendingCard(restored).text()).toContain(PENDING_ID);
        expect(pendingCard(restored).text()).toContain(
            i18n.global.t("workspace.agentPendingRecoveryNote"),
        );

        await restored.find('[data-testid="agent-principal-bind"]').trigger("click");
        await flushPromises();

        // task-433（47A / D-1109）：创建后绑定与行级绑定**同一口径** —— 用户没在创建面勾权限时
        // 必须省略第三参（继承角色基线）。旧断言写死 `[]`，那是被 47A 取代的口径：wire 上是
        // **显式零权限**，真栈 A/B 实测会把新建智能体冻成「无工具权限」（证据 cap-source-ab.json）。
        expect(apiMock.updateWorkspaceAgentCap).toHaveBeenCalledWith(
            WORKSPACE_ID,
            PENDING_ID,
            undefined,
        );
        expect(pendingCard(restored).exists()).toBe(false);
        expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).not.toHaveProperty(
            pendingKey,
        );
        restored.unmount();
    });

    it("keeps the pending card and surfaces the CP detail when PUT returns 409", async () => {
        apiMock.createAgentPrincipal.mockResolvedValue({
            principalId: PENDING_ID,
            templateId: null,
            templateName: null,
            createdAt: "2026-11-05T00:00:00Z",
        });
        apiMock.updateWorkspaceAgentCap.mockRejectedValue(
            new ApiError("ROLE_BINDING_EXCEEDS_CAP", "role atoms exceed cap: workspace.write"),
        );

        const wrapper = await mountOpenedPanel();
        await wrapper.find('[data-testid="agent-principal-name"]').setValue("PendingAgent");
        await wrapper.find('[data-testid="agent-principal-create-form"]').trigger("submit");
        await flushPromises();
        await wrapper.find('[data-testid="agent-principal-bind"]').trigger("click");
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-error"]').text()).toContain(
            "role atoms exceed cap: workspace.write",
        );
        expect(pendingCard(wrapper).exists()).toBe(true);
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<
            string,
            string
        >;
        expect(saved[pendingKey]).toBe(PENDING_ID);
        wrapper.unmount();
    });

    // CP `77120b87`：带 workspaceId 的列表现在会以 `bound=false` 返回本人 owner 的未绑定主体。
    // 因此重挂载后（本地 key 仍在）列表里同一 principalId 会以「未绑定」行出现 —— 待绑定卡与
    // 行级入口并存，绑定走任一路径都收敛（成功的 PUT 清 key/卡）。
    it("shows the row-level unbound entry next to the pending card after a remount (CP list recovery)", async () => {
        const ownerUnboundRow = {
            principalId: PENDING_ID,
            name: "Recovered owner agent",
            templateId: null,
            templateName: null,
            createdAt: "2026-11-05T00:00:00Z",
            permissionsSnapshot: [],
            bound: false,
            disabled: false,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ [pendingKey]: PENDING_ID }));
        apiMock.getWorkspaceAgents.mockResolvedValue([ownerUnboundRow]);

        const wrapper = await mountOpenedPanel();

        // CP 列表恢复：未绑定 owner 行带显式徽标与行级绑定入口（不再依赖本地 key 才有入口）。
        const row = wrapper.get(`[data-testid="workspace-agent-${PENDING_ID}"]`);
        expect(row.find(`[data-testid="agent-unbound-badge-${PENDING_ID}"]`).exists()).toBe(true);
        const bindRow = row.find(`[data-testid="agent-bind-row-${PENDING_ID}"]`);
        expect(bindRow.exists(), "the recovered row must offer a row-level bind").toBe(true);
        expect(bindRow.attributes("disabled")).toBeUndefined();
        // 本地恢复卡仍在（同一主体在两个恢复面里收敛，绑定成功任一路径都会清 key/卡）。
        expect(pendingCard(wrapper).text()).toContain(PENDING_ID);

        apiMock.updateWorkspaceAgentCap.mockResolvedValue({});
        await bindRow.trigger("click");
        await flushPromises();

        // 47A（D-1109）：行级绑定 = 默认继承基线 ⇒ 省略 permissions（不是 `[]`，那是显式零权限）。
        expect(apiMock.updateWorkspaceAgentCap).toHaveBeenCalledWith(
            WORKSPACE_ID,
            PENDING_ID,
            undefined,
        );
        expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).not.toHaveProperty(
            pendingKey,
        );
        wrapper.unmount();
    });
});

// ── 真栈 S2 bug（Lead 2026-11-02）：已存在的（未绑定）agent 在面板里没有绑定入口 ────────────────
// CP 的 GET /workspaces/{ws}/agents 现在会返回调用者自己的 PERSONAL/INSTANCE 主体（V4），
// 但它们**未绑定**时无法建会话（403 not bound）；而 UI 只在"刚创建"的区块里给 bind 按钮，
// 关掉重开后就没有入口了 —— 用户视角是死路。
describe("WorkspaceAgentsPanel bind an existing agent row", () => {
    const existing = {
        principalId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
        name: "Existing personal",
        templateId: null,
        templateName: null,
        createdAt: "2026-11-02T00:00:00Z",
        permissionsSnapshot: [],
        bound: true,
        disabled: false,
    };

    it("offers a row-level bind that PUTs the workspace cap and refreshes the list", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([existing]);
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        apiMock.updateWorkspaceAgentCap.mockResolvedValue({});
        const wrapper = await mountOpenedPanel();

        const bindRow = wrapper.find(`[data-testid="agent-bind-row-${existing.principalId}"]`);
        expect(
            bindRow.exists(),
            "an existing agent row must offer a way to bind it to this workspace",
        ).toBe(true);

        await bindRow.trigger("click");
        await flushPromises();

        // 47A（D-1109）：**绑定 = 默认继承角色基线** ⇒ 第三个参数必须是 `undefined`（省略该字段），
        // 不能退化成 `[]` —— 后者在 wire 上是**显式零权限**，一绑定就把上限冻成 0。
        const [wsArg, principalArg, permissionsArg] =
            apiMock.updateWorkspaceAgentCap.mock.calls[0] ?? [];
        expect(wsArg).toBe(WORKSPACE_ID);
        expect(principalArg).toBe(existing.principalId);
        expect(
            permissionsArg,
            "绑定只继承基线；显式零权限只能由用户在「编辑工作区角色」里主动选",
        ).toBeUndefined();
        // 绑定后必须重新读取列表（与创建后的刷新同一口径）。
        expect(apiMock.getWorkspaceAgents).toHaveBeenCalledTimes(2);
        wrapper.unmount();
    });

    /**
     * task-433 正例：用户在创建面**显式勾了**权限，绑定就必须原样发 explicit（不能被「默认继承」
     * 一刀切吞掉）。与上一条（未勾 ⇒ undefined）成对，钉住「默认继承 ≠ 禁止显式」。
     */
    it("create-then-bind keeps explicitly checked permissions (no baseline override)", async () => {
        const newId = "cccccccc-3333-4333-8333-cccccccccccc";
        // 创建面的权限勾选框由投影里的工作区动作原子派生 ⇒ 必须给与兄弟用例同一份投影。
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        apiMock.createAgentPrincipal.mockResolvedValue({
            principalId: newId,
            templateId: null,
            templateName: null,
            createdAt: "2026-11-14T00:00:00Z",
        });
        apiMock.updateWorkspaceAgentCap.mockResolvedValue({});
        const wrapper = await mountOpenedPanel();
        await wrapper.find('[data-testid="agent-principal-name"]').setValue("ExplicitAgent");
        await wrapper.find('[data-testid="agent-principal-create-form"]').trigger("submit");
        await flushPromises();
        // 权限勾选框在「刚创建未绑定」卡片里（v-if createdPrincipalId），不在创建表单内。
        const box = wrapper.find('[data-testid^="agent-cap-"]');
        expect(box.exists(), "未绑定卡片必须能显式勾权限").toBe(true);
        const actionClass = (box.attributes("data-testid") ?? "").replace("agent-cap-", "");
        await box.setValue(true);
        await wrapper.find('[data-testid="agent-principal-bind"]').trigger("click");
        await flushPromises();

        const [wsArg, principalArg, permissionsArg] =
            apiMock.updateWorkspaceAgentCap.mock.calls[0] ?? [];
        expect(wsArg).toBe(WORKSPACE_ID);
        expect(principalArg).toBe(newId);
        expect(Array.isArray(permissionsArg)).toBe(true);
        expect(permissionsArg).toEqual(
            expect.arrayContaining([expect.objectContaining({ actionClass })]),
        );
        wrapper.unmount();
    });

    it("keeps the row-level bind disabled without MANAGE_WORKSPACE_AGENTS (fail-closed)", async () => {
        admin.value = false;
        apiMock.getWorkspaceAgents.mockResolvedValue([existing]);
        apiMock.getSelfPermissions.mockResolvedValue(USER_TIER_ONLY);
        const wrapper = await mountOpenedPanel();
        const bindRow = wrapper.find(`[data-testid="agent-bind-row-${existing.principalId}"]`);
        expect(bindRow.attributes("disabled")).toBeDefined();
        wrapper.unmount();
    });
});

// ── D-160 ④/③ UI 差距收口：cap 编辑入口与错误呈现 ─────────────────────────────────────
describe("WorkspaceAgentsPanel cap editing (D-160 ④/③)", () => {
    const capAgent = {
        principalId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        name: "capped agent",
        templateId: null,
        templateName: null,
        createdAt: "2026-11-05T00:00:00Z",
        permissionsSnapshot: [],
        bound: true,
        disabled: false,
    };
    const editCap = () =>
        wrapper?.get(`[data-testid="workspace-agent-edit-cap-${capAgent.principalId}"]`);
    const saveCap = () =>
        wrapper?.get(`[data-testid="workspace-agent-save-cap-${capAgent.principalId}"]`);

    let wrapper: Awaited<ReturnType<typeof mountOpenedPanel>> | null = null;

    afterEach(() => {
        wrapper?.unmount();
        wrapper = null;
    });

    it("keeps the edit entry disabled without MANAGE_WORKSPACE_AGENTS and fires no request", async () => {
        admin.value = false;
        apiMock.getWorkspaceAgents.mockResolvedValue([capAgent]);
        apiMock.getSelfPermissions.mockResolvedValue(USER_TIER_ONLY);
        wrapper = await mountOpenedPanel();

        expect(editCap().attributes("disabled")).toBeDefined();
        // 早退保护：即使通过 DOM 绕过禁用态触发 handler，也不能发请求或进入编辑态。
        await editCap().trigger("click");
        expect(
            wrapper
                .find(`[data-testid="workspace-agent-save-cap-${capAgent.principalId}"]`)
                .exists(),
        ).toBe(false);
        expect(apiMock.updateWorkspaceAgentCap).not.toHaveBeenCalled();
    });

    it("继承态：保存时省略 permissions（CP 记 capSource=baseline），且原子不可逐个改", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([capAgent]);
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        apiMock.updateWorkspaceAgentCap.mockResolvedValue({});
        wrapper = await mountOpenedPanel();

        await editCap().trigger("click");
        // 继承态下**没有**逐原子勾选框（不可逐个改），只有一句说明。
        await wrapper
            .get(`[data-testid="workspace-agent-cap-mode-inherit-${capAgent.principalId}"]`)
            .setValue();
        expect(wrapper.find(`[data-testid="agent-cap-write"]`).exists()).toBe(false);
        expect(
            wrapper
                .get(`[data-testid="workspace-agent-cap-inherit-hint-${capAgent.principalId}"]`)
                .text(),
        ).toContain(i18n.global.t("workspace.agentCapInheritHint"));

        await saveCap().trigger("click");
        await flushPromises();

        // 省略 = baseline：与「传 []」不是一回事（后者是显式零权限）。
        expect(apiMock.updateWorkspaceAgentCap).toHaveBeenCalledWith(
            WORKSPACE_ID,
            capAgent.principalId,
            undefined,
        );
    });

    it("显式零权限：一个都不勾直接保存 ⇒ 传 []（不是省略）", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([capAgent]);
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        apiMock.updateWorkspaceAgentCap.mockResolvedValue({});
        wrapper = await mountOpenedPanel();

        await editCap().trigger("click");
        // 显式态下勾选框在 DOM 里，且可以全部不勾。
        expect(wrapper.find(`[data-testid="agent-cap-write"]`).exists()).toBe(true);
        await saveCap().trigger("click");
        await flushPromises();

        expect(apiMock.updateWorkspaceAgentCap).toHaveBeenCalledWith(
            WORKSPACE_ID,
            capAgent.principalId,
            [],
        );
    });

    it("回显以 CP 的 capSource 为准：baseline 的主体打开即继承态", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([{ ...capAgent, capSource: "baseline" }]);
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        apiMock.updateWorkspaceAgentCap.mockResolvedValue({});
        wrapper = await mountOpenedPanel();

        await editCap().trigger("click");
        const inherit = wrapper.get(
            `[data-testid="workspace-agent-cap-mode-inherit-${capAgent.principalId}"]`,
        );
        expect((inherit.element as HTMLInputElement).checked).toBe(true);
        expect(wrapper.find(`[data-testid="agent-cap-write"]`).exists()).toBe(false);

        // 切回显式态才出现逐原子勾选框 —— 两态在 UI 上必须能互相到达。
        await wrapper
            .get(`[data-testid="workspace-agent-cap-mode-explicit-${capAgent.principalId}"]`)
            .setValue();
        expect(wrapper.find(`[data-testid="agent-cap-write"]`).exists()).toBe(true);
    });

    it("saves an edited cap after the projection grants MANAGE_WORKSPACE_AGENTS", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([capAgent]);
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        apiMock.updateWorkspaceAgentCap.mockResolvedValue({});
        wrapper = await mountOpenedPanel();

        await editCap().trigger("click");
        expect(
            saveCap().attributes("disabled"),
            "the save button follows the same capability gate",
        ).toBeUndefined();

        await wrapper.get(`[data-testid="agent-cap-write"]`).setChecked(true);
        await wrapper.get(`[data-testid="agent-resource-write"]`).setValue("src/*");
        await saveCap().trigger("click");
        await flushPromises();

        expect(apiMock.updateWorkspaceAgentCap).toHaveBeenCalledWith(
            WORKSPACE_ID,
            capAgent.principalId,
            [{ actionClass: "write", resource: "src/*" }],
        );
        expect(wrapper.get('[role="status"]').text()).toContain(
            i18n.global.t("workspace.agentCapSaved"),
        );
    });

    it("keeps the D-160 ③ two-sided atom detail for 403 AGENT_PERMISSION_SCOPE_EXCEEDED", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([capAgent]);
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        apiMock.updateWorkspaceAgentCap.mockRejectedValue(
            new ApiError(
                "AGENT_PERMISSION_SCOPE_EXCEEDED",
                "Workspace cap exceeds held permissions: principal-exceeding=[write@*] actor-exceeding=[write@src/*]",
            ),
        );
        wrapper = await mountOpenedPanel();

        await editCap().trigger("click");
        await saveCap().trigger("click");
        await flushPromises();

        // D-160 ③ 的点名本身就是可操作文案（授权者要看原子清单），不走 FORBIDDEN 掩蔽。
        expect(wrapper.find('[data-testid="agent-error"]').text()).toContain(
            "principal-exceeding=[write@*] actor-exceeding=[write@src/*]",
        );
    });

    it("maps a plain FORBIDDEN to the localized actionable hint, never the raw detail", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([capAgent]);
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        const ErrorCtor = ApiError as unknown as new (code: string) => Error;
        apiMock.updateWorkspaceAgentCap.mockRejectedValue(new ErrorCtor("FORBIDDEN"));
        wrapper = await mountOpenedPanel();

        await editCap().trigger("click");
        await saveCap().trigger("click");
        await flushPromises();

        const text = wrapper.find('[data-testid="agent-error"]').text();
        expect(text).toContain(i18n.global.t("workspace.agentBindForbidden"));
        expect(text).not.toContain("CREATE_ACCOUNT permission is required");
    });

    it("keeps the CP atom naming detail when the refusal is another code (D-160 ③ display)", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([capAgent]);
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        apiMock.updateWorkspaceAgentCap.mockRejectedValue(
            new ApiError(
                "ROLE_BINDING_EXCEEDS_CAP",
                "principal-exceeding=[write@*] actor-exceeding=[]",
            ),
        );
        wrapper = await mountOpenedPanel();

        await editCap().trigger("click");
        await saveCap().trigger("click");
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-error"]').text()).toContain(
            "principal-exceeding=[write@*] actor-exceeding=[]",
        );
    });
});

// PLAN-0622 D26：未绑定的行要显式标「未绑定」，否则用户以为它已经能用。
describe("WorkspaceAgentsPanel unbound badge", () => {
    it("marks a row without a workspace binding", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([
            {
                principalId: "cccccccc-3333-4333-8333-cccccccccccc",
                name: "Not bound yet",
                templateId: null,
                templateName: null,
                createdAt: "2026-11-02T00:00:00Z",
                permissionsSnapshot: [],
                bound: false,
                disabled: false,
            },
            {
                principalId: "dddddddd-4444-4444-8444-dddddddddddd",
                name: "Bound already",
                templateId: null,
                templateName: null,
                createdAt: "2026-11-02T00:00:00Z",
                permissionsSnapshot: [],
                bound: true,
                disabled: false,
            },
        ]);
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        const wrapper = await mountOpenedPanel();

        const unboundBadge = wrapper.find(
            '[data-testid="agent-unbound-badge-cccccccc-3333-4333-8333-cccccccccccc"]',
        );
        expect(unboundBadge.exists(), "an unbound row must say so").toBe(true);
        expect(unboundBadge.text()).toMatch(/未绑定|Not bound/i);
        expect(
            wrapper
                .find('[data-testid="agent-unbound-badge-dddddddd-4444-4444-8444-dddddddddddd"]')
                .exists(),
            "a bound row must not carry the unbound badge",
        ).toBe(false);
        wrapper.unmount();
    });
});

// PLAN-0622 D27：`disabled` 现在有真实数据（CP 投影），确认「已禁用」徽标与禁用按钮同时生效。
describe("WorkspaceAgentsPanel disabled row", () => {
    it("shows the disabled badge and disables the disable button for a disabled agent", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([
            {
                principalId: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee",
                name: "Already disabled",
                templateId: null,
                templateName: null,
                createdAt: "2026-11-02T00:00:00Z",
                permissionsSnapshot: [],
                bound: true,
                disabled: true,
            },
        ]);
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_ONLY);
        const wrapper = await mountOpenedPanel();

        expect(
            wrapper
                .find('[data-testid="agent-disabled-badge-eeeeeeee-5555-4555-8555-eeeeeeeeeeee"]')
                .exists(),
            "a disabled agent must carry the disabled badge",
        ).toBe(true);
        expect(
            wrapper
                .find(
                    '[data-testid="workspace-agent-disable-eeeeeeee-5555-4555-8555-eeeeeeeeeeee"]',
                )
                .attributes("disabled"),
            "an already disabled agent must not offer the disable action again",
        ).toBeDefined();
        wrapper.unmount();
    });
});

describe("WorkspaceAgentsPanel hook subscriptions (PLAN-0625 M3, read-only)", () => {
    // The document below is the wire shape (`advisors[].on`), i.e. exactly what
    // `api.getWorkspaceAgents` hands the component — no second shape is invented here.
    const guardAgent = {
        principalId: "88888888-8888-4888-8888-888888888888",
        name: "guardian",
        templateId: null,
        templateName: null,
        createdAt: "2026-11-02T00:00:00Z",
        permissionsSnapshot: [],
        bound: true,
        disabled: false,
        hooks: { advisors: [{ kind: "guard", on: ["approval.ask"] }] },
    };

    it("renders the advisor kinds and the action classes from advisors[].on", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([guardAgent]);
        const wrapper = await mountOpenedPanel();

        const line = wrapper.get(
            '[data-testid="agent-hooks-88888888-8888-4888-8888-888888888888"]',
        );
        expect(line.text()).toContain("guard");
        expect(line.text()).toContain("approval.ask");
        // 只读：该行没有任何可编辑控件。
        expect(line.find("input, select, button").exists()).toBe(false);
    });

    it("merges the action classes of several advisors without repeating them", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([
            {
                ...guardAgent,
                hooks: {
                    advisors: [
                        { kind: "guard", on: ["approval.ask"] },
                        { kind: "lint", on: ["approval.ask"] },
                    ],
                },
            },
        ]);
        const wrapper = await mountOpenedPanel();

        const line = wrapper.get(
            '[data-testid="agent-hooks-88888888-8888-4888-8888-888888888888"]',
        );
        expect(line.text()).toContain("guard、lint");
        expect(line.text().match(/approval\.ask/g)?.length).toBe(1);
    });

    it("renders no hooks line when the principal carries null subscriptions", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([{ ...guardAgent, hooks: null }]);
        const wrapper = await mountOpenedPanel();

        expect(wrapper.find('[data-testid^="agent-hooks-"]').exists()).toBe(false);
    });

    it("renders no hooks line when the ancestors carry no advisors", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([{ ...guardAgent, hooks: { advisors: [] } }]);
        const wrapper = await mountOpenedPanel();

        expect(wrapper.find('[data-testid^="agent-hooks-"]').exists()).toBe(false);
    });
});

// ── PLAN-0629 M1-4 C：只读「记忆」区（四态 + 404 不当崩溃 + 无写入控件） ────────────────
describe("WorkspaceAgentsPanel PLAN-0629 read-only memory", () => {
    const PRINCIPAL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const agentWithMemory = {
        principalId: PRINCIPAL_ID,
        name: "memo agent",
        templateId: null,
        templateName: null,
        createdAt: "2026-11-02T00:00:00Z",
        permissionsSnapshot: [],
        bound: true,
        disabled: false,
    };
    const toggle = `[data-testid="agent-memory-toggle-${PRINCIPAL_ID}"]`;

    it("lists the rows the server returned (pinned / updatedAt / content; no type badge)", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([agentWithMemory]);
        apiMock.getWorkspaceAgentMemories.mockResolvedValue([
            {
                id: "memory-1",
                pinned: true,
                updatedAt: "2026-11-02T10:00:00Z",
                content: "偏好中文回答",
            },
            {
                id: "memory-2",
                pinned: false,
                updatedAt: "2026-11-02T11:00:00Z",
                content: "项目使用 Vue 3",
            },
        ]);
        const wrapper = await mountOpenedPanel();

        await wrapper.get(toggle).trigger("click");
        await flushPromises();

        expect(apiMock.getWorkspaceAgentMemories).toHaveBeenCalledWith(WORKSPACE_ID, PRINCIPAL_ID);
        const items = wrapper.findAll('[data-testid^="agent-memory-item-"]');
        expect(items).toHaveLength(2);
        // 用户裁定 v2：CP 删 type 列 ⇒ UI 不再有 profile/fact 徽标。
        expect(wrapper.find('[data-testid^="agent-memory-type-"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="agent-memory-pinned-memory-1"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-memory-pinned-memory-2"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="agent-memory-updated-memory-1"]').text()).toContain(
            "更新于",
        );
        expect(wrapper.get('[data-testid="agent-memory-content-memory-2"]').text()).toContain(
            "项目使用 Vue 3",
        );
        // 只读语义必须在 UI 上说清，否则会被当成"存不进去的 bug"。
        expect(wrapper.get('[data-testid="agent-memory-readonly-hint"]').text()).toContain(
            "记忆写入在后续版本开放",
        );
        // 只读：记忆区内没有任何写入/编辑控件，只有一个重试按钮的容身处也不该出现。
        const panel = wrapper.get(`[data-testid="agent-memory-panel-${PRINCIPAL_ID}"]`);
        expect(panel.find("input, textarea, select").exists()).toBe(false);
        expect(panel.find('[data-testid^="agent-memory-retry-"]').exists()).toBe(false);
    });

    it("shows the explicit empty-state copy instead of a blank area", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([agentWithMemory]);
        apiMock.getWorkspaceAgentMemories.mockResolvedValue([]);
        const wrapper = await mountOpenedPanel();

        await wrapper.get(toggle).trigger("click");
        await flushPromises();

        expect(wrapper.get('[data-testid="agent-memory-empty"]').text()).toBe(
            "该主体暂无记忆（记忆写入需 MEMORY_WRITE 授权）",
        );
        expect(wrapper.find('[data-testid="agent-memory-list"]').exists()).toBe(false);
    });

    it("shows the loading state while the request is in flight", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([agentWithMemory]);
        let resolve!: (rows: unknown[]) => void;
        apiMock.getWorkspaceAgentMemories.mockReturnValue(
            new Promise((done) => {
                resolve = done;
            }),
        );
        const wrapper = await mountOpenedPanel();

        await wrapper.get(toggle).trigger("click");
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-memory-loading"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-memory-empty"]').exists()).toBe(false);

        resolve([]);
        await flushPromises();
        expect(wrapper.find('[data-testid="agent-memory-loading"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="agent-memory-empty"]').exists()).toBe(true);
    });

    it("treats 404 as 'no permission or not found' and offers a retry", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([agentWithMemory]);
        apiMock.getWorkspaceAgentMemories.mockRejectedValueOnce(
            new ApiError("AGENT_PRINCIPAL_NOT_FOUND"),
        );
        const wrapper = await mountOpenedPanel();

        await wrapper.get(toggle).trigger("click");
        await flushPromises();

        const failed = wrapper.get('[data-testid="agent-memory-failed"]');
        expect(failed.text()).toContain("无权限查看该主体的记忆，或该主体不存在");
        expect(wrapper.find('[role="alert"]').text()).toContain("无权限");

        // 重试走同一路径，成功后回到列表态（失败不是死路）。
        apiMock.getWorkspaceAgentMemories.mockResolvedValueOnce([
            {
                id: "memory-3",
                type: "fact",
                pinned: false,
                updatedAt: "2026-11-02T12:00:00Z",
                content: "retry worked",
            },
        ]);
        await wrapper.get(`[data-testid="agent-memory-retry-${PRINCIPAL_ID}"]`).trigger("click");
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-memory-failed"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="agent-memory-item-memory-3"]').exists()).toBe(true);
    });

    it("closes the panel on the second click and drops stale rows", async () => {
        apiMock.getWorkspaceAgents.mockResolvedValue([agentWithMemory]);
        apiMock.getWorkspaceAgentMemories.mockResolvedValue([
            {
                id: "memory-1",
                type: "profile",
                pinned: false,
                updatedAt: "2026-11-02T10:00:00Z",
                content: "x",
            },
        ]);
        const wrapper = await mountOpenedPanel();

        await wrapper.get(toggle).trigger("click");
        await flushPromises();
        expect(wrapper.get(toggle).attributes("aria-expanded")).toBe("true");

        await wrapper.get(toggle).trigger("click");
        await flushPromises();

        expect(wrapper.get(toggle).attributes("aria-expanded")).toBe("false");
        expect(wrapper.find(`[data-testid="agent-memory-panel-${PRINCIPAL_ID}"]`).exists()).toBe(
            false,
        );
        expect(wrapper.find('[data-testid^="agent-memory-item-"]').exists()).toBe(false);
    });
});

// ── PLAN-0626 M3：生命周期 + 单一宿主（dock 标签 / 移动端弹窗） ────────────────────────
describe("WorkspaceAgentsPanel PLAN-0626 M3 lifecycle", () => {
    it("loads the list and the capability projection once per mount", async () => {
        // 迁移后没有 `open` prop：挂载即打开，加载必须在 onMounted 发生（否则标签打开后是空壳）。
        await mountOpenedPanel();

        expect(apiMock.getWorkspaceAgents).toHaveBeenCalledTimes(1);
        expect(apiMock.getSelfPermissions).toHaveBeenCalledTimes(1);
    });
});

describe("WorkspaceAgentManagementDialog mobile shell (PLAN-0626 M3)", () => {
    function mountShell(open: boolean) {
        return mount(WorkspaceAgentManagementDialog, {
            attachTo: document.body,
            props: { open, workspaceId: WORKSPACE_ID },
            global: {
                plugins: [i18n],
                stubs: { RouterLink: { props: ["to"], template: '<a :href="to"><slot /></a>' } },
            },
        });
    }

    it("renders the same panel body exactly once inside the modal", async () => {
        const wrapper = mountShell(true);
        await flushPromises();

        expect(
            document.querySelectorAll('[data-testid="workspace-agent-management-dialog"]'),
        ).toHaveLength(1);
        expect(wrapper.find('[data-testid="modal-backdrop"]').exists()).toBe(true);
        wrapper.unmount();
    });

    it("mounts no panel while closed — a closed shell is not a hidden copy", async () => {
        // 2026-11-03 的教训：`v-show` 式"存在但隐藏"的副本会让同一 testid 命中两次。
        const wrapper = mountShell(false);
        await flushPromises();

        expect(
            document.querySelectorAll('[data-testid="workspace-agent-management-dialog"]'),
        ).toHaveLength(0);
        expect(apiMock.getWorkspaceAgents).not.toHaveBeenCalled();
        wrapper.unmount();
    });
});

// ── PLAN-0629 M1-5：记忆写入面（v2 裁定）──────────────────────────────────────────
describe("WorkspaceAgentsPanel memory write surface", () => {
    const PRINCIPAL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const MEMORY_WRITE_GRANTED = {
        userId: "99999999-9999-4999-8999-999999999999",
        instanceCapabilities: [],
        instancePermissions: [],
        workspaces: [
            {
                workspaceId: WORKSPACE_ID,
                workspaceAdmin: false,
                permissions: [{ actionClass: "MEMORY_WRITE", resource: WORKSPACE_ID }],
            },
        ],
    };
    const agentWithWritableMemory = {
        principalId: PRINCIPAL_ID,
        name: "writable agent",
        templateId: null,
        templateName: null,
        createdAt: "2026-11-02T00:00:00Z",
        permissionsSnapshot: [],
        bound: true,
        disabled: false,
        // 「启用记忆」开关必须与现值合并且不丢其它 key。
        contextPolicy: { window: 5, memory: { policyVersion: 1 } },
    };
    const toggle = `[data-testid="agent-memory-toggle-${PRINCIPAL_ID}"]`;

    async function mountWithMemory() {
        apiMock.getSelfPermissions.mockResolvedValue(MEMORY_WRITE_GRANTED);
        // BL-359：给每次挂载**独立的深拷贝**。组件在「启用记忆」开关里会就地改
        // `agent.contextPolicy`（`toggleMemoryEnabled` 里 `agent.contextPolicy = merged`），
        // 若直接把模块级 fixture 交给 mock，上一条用例把 `memory.enabled` 改成 `false` 后会
        // 永久污染后续用例 ⇒ 「新建记忆」按钮 `:disabled`、点击无效、表单永不渲染。
        apiMock.getWorkspaceAgents.mockResolvedValue([structuredClone(agentWithWritableMemory)]);
        apiMock.getWorkspaceAgentMemories.mockResolvedValue([
            {
                id: "memory-1",
                pinned: false,
                updatedAt: "2026-11-03T10:00:00Z",
                content: "偏好中文回答",
                origin: "manual",
            },
            {
                id: "memory-2",
                pinned: true,
                updatedAt: "2026-11-03T11:00:00Z",
                content: "项目使用 Vue 3",
            },
        ]);
        const wrapper = await mountOpenedPanel();
        await wrapper.get(toggle).trigger("click");
        await flushPromises();
        return wrapper;
    }

    it("creates a memory without a type field and re-reads the list", async () => {
        const wrapper = await mountWithMemory();
        apiMock.createAgentMemory.mockResolvedValue(undefined);

        await wrapper
            .get(`[data-testid="agent-memory-create-open-${PRINCIPAL_ID}"]`)
            .trigger("click");
        // BL-359：对话框是 `v-if`，点击后还需一次 flush 才挂载；原先靠"上一条用例已经等过"才碰巧可用，
        // 顺序一变就取不到元素。改为本用例自己等它出现。
        await flushPromises();
        await wrapper
            .get(`[data-testid="agent-memory-create-content-${PRINCIPAL_ID}"]`)
            .setValue("本仓库使用 pnpm");
        await wrapper
            .get(`[data-testid="agent-memory-create-save-${PRINCIPAL_ID}"]`)
            .trigger("click");
        await flushPromises();

        expect(apiMock.createAgentMemory).toHaveBeenCalledWith(WORKSPACE_ID, PRINCIPAL_ID, {
            content: "本仓库使用 pnpm",
            pinned: false,
        });
        expect(apiMock.getWorkspaceAgentMemories).toHaveBeenCalledTimes(2);
    });

    it("archives through the confirmation and re-reads the list", async () => {
        const wrapper = await mountWithMemory();
        apiMock.deleteAgentMemory.mockResolvedValue(undefined);

        await wrapper.get('[data-testid="agent-memory-archive-memory-1"]').trigger("click");
        // BL-359：确认卡片是条件渲染，点开后需 flush 再断言；不依赖兄弟用例留下的渲染时机。
        await flushPromises();
        expect(
            wrapper.get('[data-testid="agent-memory-archive-confirm-memory-1"]').text(),
        ).toContain("显示已归档");
        await wrapper
            .get('[data-testid="agent-memory-archive-confirm-button-memory-1"]')
            .trigger("click");
        await flushPromises();

        expect(apiMock.deleteAgentMemory).toHaveBeenCalledWith(
            WORKSPACE_ID,
            PRINCIPAL_ID,
            "memory-1",
        );
        expect(apiMock.getWorkspaceAgentMemories).toHaveBeenCalledTimes(2);
    });

    it("surfaces a write failure instead of pretending success", async () => {
        const wrapper = await mountWithMemory();
        apiMock.createAgentMemory.mockRejectedValue(new Error("boom"));

        await wrapper
            .get(`[data-testid="agent-memory-create-open-${PRINCIPAL_ID}"]`)
            .trigger("click");
        // BL-359：同上——自等对话框挂载，不依赖兄弟用例的 flush。
        await flushPromises();
        await wrapper
            .get(`[data-testid="agent-memory-create-content-${PRINCIPAL_ID}"]`)
            .setValue("会失败的写入");
        await wrapper
            .get(`[data-testid="agent-memory-create-save-${PRINCIPAL_ID}"]`)
            .trigger("click");
        await flushPromises();

        expect(wrapper.get('[data-testid="agent-memory-action-error"]').exists()).toBe(true);
    });

    it("toggles memory off through the shared Switch and merges the existing contextPolicy", async () => {
        const wrapper = await mountWithMemory();
        apiMock.updateAgentPrincipalContextPolicy.mockResolvedValue(undefined);

        await wrapper.get(`[data-testid="agent-memory-enabled-${PRINCIPAL_ID}"]`).trigger("click");
        await flushPromises();

        expect(apiMock.updateAgentPrincipalContextPolicy).toHaveBeenCalledWith(PRINCIPAL_ID, {
            window: 5,
            memory: { policyVersion: 1, enabled: false },
        });
    });

    it("requests the archived view when 显示已归档 is on, and renders origin only when present", async () => {
        const wrapper = await mountWithMemory();

        // origin chip：有 origin 的行渲染，缺字段的行不渲染（不上默认值）。
        expect(wrapper.get('[data-testid="agent-memory-origin-memory-1"]').text()).toContain(
            "手动",
        );
        expect(wrapper.find('[data-testid="agent-memory-origin-memory-2"]').exists()).toBe(false);

        await wrapper
            .get(`[data-testid="agent-memory-show-archived-${PRINCIPAL_ID}"]`)
            .trigger("click");
        await flushPromises();

        expect(apiMock.getWorkspaceAgentMemories).toHaveBeenLastCalledWith(
            WORKSPACE_ID,
            PRINCIPAL_ID,
            "all",
        );
    });
});

// ── PLAN-0667 M3：角色 / 技能区块（列表 + 绑定/解绑 + 409 三类码 + 无硬编码中文） ──────────
describe("WorkspaceAgentsPanel PLAN-0667 roles & skills", () => {
    const PRINCIPAL_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const rbacAgent = {
        principalId: PRINCIPAL_ID,
        name: "rbac agent",
        templateId: null,
        templateName: null,
        createdAt: "2026-11-02T00:00:00Z",
        permissionsSnapshot: [],
        bound: true,
        disabled: false,
    };
    const WORKSPACE_MANAGE = {
        userId: "99999999-9999-4999-8999-999999999999",
        instanceCapabilities: [],
        instancePermissions: [],
        workspaces: [
            {
                workspaceId: WORKSPACE_ID,
                workspaceAdmin: true,
                permissions: [{ actionClass: "MANAGE_WORKSPACE_AGENTS", resource: WORKSPACE_ID }],
            },
        ],
    };
    const rolesToggle = `[data-testid="agent-roles-toggle-${PRINCIPAL_ID}"]`;

    beforeEach(() => {
        apiMock.getWorkspaceAgents.mockResolvedValue([rbacAgent]);
        apiMock.getSelfPermissions.mockResolvedValue(WORKSPACE_MANAGE);
        apiMock.getAgentRoles.mockResolvedValue([
            {
                bindingId: "binding-system",
                roleId: "role-seed",
                name: "AGENT_SPAWNER",
                displayName: null,
                scopeType: "instance",
                scopeId: null,
                scopeName: null,
                isSystem: true,
                grantedBy: "99999999-9999-4999-8999-999999999999",
                atomSummary: ["读取", "执行"],
                atomCount: 2,
                atomsTruncated: false,
            },
            {
                bindingId: "binding-editor",
                roleId: "role-editor",
                name: "WS_EDITOR",
                displayName: null,
                scopeType: "workspace",
                scopeId: WORKSPACE_ID,
                scopeName: null,
                isSystem: false,
                atomSummary: ["读取", "写入", "执行"],
                atomCount: 6,
                atomsTruncated: true,
            },
        ]);
        apiMock.getAgentSkills.mockResolvedValue([
            {
                bindingId: "skill-binding-1",
                skillId: "skill-1",
                name: "contract-review",
                sourceType: "workspace",
                sourceName: "工作区技能库",
                scopeType: "workspace",
                scopeId: WORKSPACE_ID,
                scopeName: "Workspace one",
                tokenEstimate: 1200,
            },
            {
                bindingId: "skill-binding-instance",
                skillId: "skill-instance",
                name: "instance-review",
                sourceType: "instance",
                sourceName: null,
                scopeType: "instance",
                scopeId: null,
                scopeName: null,
                tokenEstimate: null,
            },
        ]);
        apiMock.listRoles.mockResolvedValue([
            { id: "role-editor", name: "WS_EDITOR", displayName: "Workspace editor" },
        ]);
        apiMock.getSkills.mockResolvedValue([
            {
                skillId: "skill-2",
                name: "test-case-writing",
                definitionScope: { type: "instance", workspaceId: null },
            },
        ]);
        apiMock.getWorkspaceSkills.mockResolvedValue([]);
    });

    it("lists name / scope / system badge / derived-atom summary and never unbinds a system binding", async () => {
        const wrapper = await mountOpenedPanel();
        await wrapper.get(rolesToggle).trigger("click");
        await flushPromises();

        const system = wrapper.get('[data-testid="agent-role-item-binding-system"]');
        expect(system.text()).toContain("AGENT_SPAWNER");
        expect(system.text()).toContain(
            i18n.global.t("workspace.agentRoleGrantedBy", { id: "99999999" }),
        );
        expect(system.text()).toContain("instance");
        expect(system.text()).toContain(i18n.global.t("workspace.agentRoleSystemBadge"));
        // D5(b)：只渲染摘要（前 3 个）+ 总数，不展开全集。
        expect(system.text()).toContain(
            i18n.global.t("workspace.agentRoleAtomsSummary", { atoms: "读取 · 执行", count: 2 }),
        );
        expect(wrapper.find('[data-testid="agent-role-unbind-binding-system"]').exists()).toBe(
            false,
        );

        const editor = wrapper.get('[data-testid="agent-role-item-binding-editor"]');
        expect(editor.text()).toContain("WS_EDITOR");
        await wrapper.get('[data-testid="agent-role-unbind-binding-editor"]').trigger("click");
        await flushPromises();
        expect(apiMock.unbindAgentRole).toHaveBeenCalledWith(
            WORKSPACE_ID,
            PRINCIPAL_ID,
            "binding-editor",
        );
    });

    it("binds the selected role and maps 409 AGENT_PRINCIPAL_FORBIDDEN_ATOMS to localized copy", async () => {
        apiMock.bindAgentRole.mockRejectedValue(
            new ApiError(
                "AGENT_PRINCIPAL_FORBIDDEN_ATOMS",
                "role carries atoms an agent principal may never hold: INSTANCE_ADMIN",
            ),
        );
        const wrapper = await mountOpenedPanel();
        await wrapper.get(rolesToggle).trigger("click");
        await flushPromises();

        await setSelectValue(
            wrapper,
            `[data-testid="agent-role-select-${PRINCIPAL_ID}"]`,
            "role-editor",
        );
        await wrapper.get(`[data-testid="agent-role-bind-${PRINCIPAL_ID}"]`).trigger("click");
        await flushPromises();

        expect(apiMock.bindAgentRole).toHaveBeenCalledWith(
            WORKSPACE_ID,
            PRINCIPAL_ID,
            "role-editor",
        );
        const text = wrapper.get('[data-testid="agent-rbac-action-error"]').text();
        expect(text).toBe(i18n.global.t("workspace.agentRoleForbiddenAtoms"));
        expect(text).not.toContain("INSTANCE_ADMIN");
    });

    it("maps 409 ROLE_BINDING_EXCEEDS_CAP to localized copy and shows the cap hint", async () => {
        apiMock.bindAgentRole.mockRejectedValue(
            new ApiError(
                "ROLE_BINDING_EXCEEDS_CAP",
                "role atoms exceed the agent's workspace cap: CREATE_ACCOUNT,MANAGE_WORKSPACE_AGENTS",
            ),
        );
        const wrapper = await mountOpenedPanel();
        await wrapper.get(rolesToggle).trigger("click");
        await flushPromises();

        expect(wrapper.get(`[data-testid="agent-role-cap-hint-${PRINCIPAL_ID}"]`).text()).toBe(
            i18n.global.t("workspace.agentRoleCapHint"),
        );
        await setSelectValue(
            wrapper,
            `[data-testid="agent-role-select-${PRINCIPAL_ID}"]`,
            "role-editor",
        );
        await wrapper.get(`[data-testid="agent-role-bind-${PRINCIPAL_ID}"]`).trigger("click");
        await flushPromises();

        expect(wrapper.get('[data-testid="agent-rbac-action-error"]').text()).toContain(
            "CREATE_ACCOUNT,MANAGE_WORKSPACE_AGENTS",
        );
    });

    it("falls back to localized copy when the role binding Problem has no detail", async () => {
        apiMock.bindAgentRole.mockRejectedValue(new ApiError("ROLE_BINDING_EXCEEDS_CAP", ""));
        const wrapper = await mountOpenedPanel();
        await wrapper.get(rolesToggle).trigger("click");
        await flushPromises();
        await setSelectValue(
            wrapper,
            `[data-testid="agent-role-select-${PRINCIPAL_ID}"]`,
            "role-editor",
        );
        await wrapper.get(`[data-testid="agent-role-bind-${PRINCIPAL_ID}"]`).trigger("click");
        await flushPromises();
        expect(wrapper.get('[data-testid="agent-rbac-action-error"]').text()).toBe(
            i18n.global.t("workspace.agentRoleExceedsCap"),
        );
    });

    it("lists skills and unbinds one through the skill endpoint", async () => {
        const wrapper = await mountOpenedPanel();
        await wrapper.get(rolesToggle).trigger("click");
        await flushPromises();

        expect(wrapper.get('[data-testid="agent-skills-list"]').text()).toContain(
            "contract-review",
        );
        // 三列：来源类型 / 来源名 / token 估算（M2 契约字段）。
        expect(wrapper.get('[data-testid="agent-skill-source-skill-binding-1"]').text()).toBe(
            i18n.global.t("workspace.agentSkillSourceWorkspace"),
        );
        // 2026-11-12（task-234）：实例库定义的来源 chip 曾经显示成「个人技能」（同名异义），
        // 值域改 workspace|instance 后必须显示「实例技能」——这条断言就是防"契约改了、UI 没改"。
        expect(
            wrapper.get('[data-testid="agent-skill-source-skill-binding-instance"]').text(),
        ).toBe(i18n.global.t("workspace.agentSkillSourceInstance"));
        // PLAN-0680 M2: binding scope is a separate axis from the definition source.
        expect(
            wrapper
                .get(
                    '[data-testid="agent-skill-item-skill-binding-1"] [data-testid="agent-skill-scope-workspace"]',
                )
                .text(),
        ).toBe(i18n.global.t("workspace.agentSkillScopeWorkspace"));
        expect(
            wrapper
                .get(
                    '[data-testid="agent-skill-item-skill-binding-instance"] [data-testid="agent-skill-scope-instance"]',
                )
                .text(),
        ).toBe(i18n.global.t("workspace.agentSkillScopeInstance"));
        expect(wrapper.get('[data-testid="agent-skill-item-skill-binding-1"]').text()).toContain(
            "工作区技能库",
        );
        expect(wrapper.get('[data-testid="agent-skill-item-skill-binding-1"]').text()).toContain(
            i18n.global.t("workspace.agentSkillTokens", { tokens: 1200 }),
        );
        await wrapper.get('[data-testid="agent-skill-unbind-skill-binding-1"]').trigger("click");
        await flushPromises();
        expect(apiMock.unbindAgentSkill).toHaveBeenCalledWith(
            WORKSPACE_ID,
            PRINCIPAL_ID,
            "skill-binding-1",
        );
    });

    it("offers instance and current-workspace definitions once, then binds on the workspace axis", async () => {
        apiMock.getSkills.mockResolvedValue([
            {
                skillId: "skill-instance",
                name: "instance-skill",
                definitionScope: { type: "instance", workspaceId: null },
            },
            {
                skillId: "skill-dupe",
                name: "deduped-skill",
                definitionScope: { type: "instance", workspaceId: null },
            },
            {
                skillId: "skill-dupe",
                name: "deduped-skill",
                definitionScope: { type: "instance", workspaceId: null },
            },
        ]);
        apiMock.getWorkspaceSkills.mockResolvedValue([
            {
                skillId: "skill-workspace",
                name: "workspace-skill",
                definitionScope: { type: "workspace", workspaceId: WORKSPACE_ID },
            },
            {
                skillId: "skill-foreign",
                name: "foreign-workspace-skill",
                definitionScope: {
                    type: "workspace",
                    workspaceId: "77777777-7777-4777-8777-777777777777",
                },
            },
        ]);

        const wrapper = await mountOpenedPanel();
        await wrapper.get(rolesToggle).trigger("click");
        await flushPromises();

        expect(apiMock.getWorkspaceSkills).toHaveBeenCalledWith(WORKSPACE_ID);
        await openSelect(wrapper, `[data-testid="agent-skill-select-${PRINCIPAL_ID}"]`);
        expect(
            selectItemValuesFor(wrapper, `[data-testid="agent-skill-select-${PRINCIPAL_ID}"]`),
        ).toEqual(["skill-instance", "skill-dupe", "skill-workspace"]);

        await setSelectValue(
            wrapper,
            `[data-testid="agent-skill-select-${PRINCIPAL_ID}"]`,
            "skill-workspace",
        );
        await wrapper.get(`[data-testid="agent-skill-bind-${PRINCIPAL_ID}"]`).trigger("click");
        await flushPromises();

        // Binding scope is server-derived from this context; the client only sends the skill id.
        expect(apiMock.bindAgentSkill).toHaveBeenCalledWith(
            WORKSPACE_ID,
            PRINCIPAL_ID,
            "skill-workspace",
        );
    });

    it("keeps the section read-only (with explanation) when the projection lacks MANAGE_WORKSPACE_AGENTS", async () => {
        apiMock.getSelfPermissions.mockResolvedValue(CREATE_ACCOUNT_MISSING);
        const wrapper = await mountOpenedPanel();
        await wrapper.get(rolesToggle).trigger("click");
        await flushPromises();

        expect(wrapper.find(`[data-testid="agent-role-bind-${PRINCIPAL_ID}"]`).exists()).toBe(
            false,
        );
        expect(wrapper.find('[data-testid="agent-rbac-readonly-hint"]').exists()).toBe(true);
    });

    it("has no hardcoded CJK copy outside comments (i18n is the single source)", () => {
        const source = readFileSync(
            resolve(process.cwd(), "src/features/workspace/components/WorkspaceAgentsPanel.vue"),
            "utf8",
        );
        const stripped = source
            .replace(/<!--[\s\S]*?-->/g, "")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/[^\n]*/g, "");
        const cjk = stripped.match(/[\u4e00-\u9fff]/g);
        expect(cjk, `hardcoded CJK: ${cjk?.slice(0, 6).join("") ?? ""}`).toBeNull();
    });
});

// ── task-417 P1-6（408 盘点 §4）：permissionsSnapshot 不是权限真源 ─────────────────────
// 事实依据：公开读面只给 permissionsSnapshot + capSource（CP WorkspaceAgentController:294-297），
// 真源 resolveCapFor 是 CP 内部求值、无公开读面 ⇒ UI 只能**标注来源**，不得声称「这就是当前权限」。
// 空数组的语义由 CP 自己的 capSource 决定（D-1109）：baseline = 跟随角色基线，不是「无工具权限」。
describe("WorkspaceAgentsPanel cap snapshot provenance (task-417 P1-6)", () => {
    const base = {
        principalId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        name: "snapshot agent",
        templateId: null,
        templateName: null,
        createdAt: "2026-11-05T00:00:00Z",
        bound: true,
        disabled: false,
    };
    const atoms = [
        { actionClass: "file_read", resource: "workspace" },
        { actionClass: "file_write", resource: "workspace" },
    ];
    const tt = (key: string) => i18n.global.t(key);
    async function mountWith(row: Record<string, unknown>) {
        apiMock.getWorkspaceAgents.mockResolvedValue([row]);
        return mountOpenedPanel();
    }
    const sourceBadge = (wrapper: VueWrapper) =>
        wrapper.find(`[data-testid="workspace-agent-cap-source-${base.principalId}"]`);

    it("labels the badges as a frozen snapshot and keeps every atom visible", async () => {
        const wrapper = await mountWith({
            ...base,
            permissionsSnapshot: atoms,
            capSource: "explicit",
        });
        expect(wrapper.get('[data-testid="workspace-agent-cap-label"]').text()).toBe(
            tt("workspace.agentCapSnapshotLabel"),
        );
        expect(wrapper.get('[data-testid="workspace-agent-cap-snapshot-hint"]').text()).toBe(
            tt("workspace.agentCapSnapshotHint"),
        );
        const cap = wrapper.get('[data-testid="workspace-agent-cap"]');
        // 标注不是把信息藏起来：两条原子徽标 + 一条来源徽标都还在。
        expect(cap.findAll("span.rounded.border")).toHaveLength(atoms.length + 1);
        expect(sourceBadge(wrapper).text()).toBe(tt("workspace.agentCapExplicit"));
    });

    it("baseline + empty snapshot reads as inherit, never as 'no tool permissions'", async () => {
        const wrapper = await mountWith({
            ...base,
            permissionsSnapshot: [],
            capSource: "baseline",
        });
        expect(sourceBadge(wrapper).text()).toBe(tt("workspace.agentCapInherit"));
        expect(wrapper.find('[data-testid="workspace-agent-cap-empty"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="workspace-agent-cap"]').text()).not.toContain(
            tt("workspace.noAgentCapabilities"),
        );
    });

    it("explicit + empty snapshot still reads as zero cap (no weakening)", async () => {
        const wrapper = await mountWith({
            ...base,
            permissionsSnapshot: [],
            capSource: "explicit",
        });
        expect(wrapper.get('[data-testid="workspace-agent-cap-empty"]').text()).toBe(
            tt("workspace.noAgentCapabilities"),
        );
        expect(sourceBadge(wrapper).text()).toBe(tt("workspace.agentCapExplicit"));
    });

    it("a response without capSource invents no provenance (pre-D-1109 rows unchanged)", async () => {
        const wrapper = await mountWith({ ...base, permissionsSnapshot: [] });
        expect(sourceBadge(wrapper).exists()).toBe(false);
        expect(wrapper.get('[data-testid="workspace-agent-cap-empty"]').text()).toBe(
            tt("workspace.noAgentCapabilities"),
        );
    });

    it("baseline with recorded atoms still shows them plus the inherit provenance", async () => {
        const wrapper = await mountWith({
            ...base,
            permissionsSnapshot: atoms,
            capSource: "baseline",
        });
        expect(sourceBadge(wrapper).text()).toBe(tt("workspace.agentCapInherit"));
        expect(
            wrapper.get('[data-testid="workspace-agent-cap"]').findAll("span.rounded.border"),
        ).toHaveLength(atoms.length + 1);
        expect(wrapper.find('[data-testid="workspace-agent-cap-empty"]').exists()).toBe(false);
    });
});
