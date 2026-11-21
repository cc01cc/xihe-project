import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as apiModule from "../../../composables/api";
import { ApiError, api } from "../../../composables/api";
import { i18n } from "../../../i18n";
import AgentWorkspaceBindingsPanel from "../AgentWorkspaceBindingsPanel.vue";

/**
 * task-153 S1：主体「工作区绑定」面板的呈现判据。
 *
 * <p>三条都是卡面/裁定里的硬口径，任何一条被"顺手简化"就会假绿：</p>
 * <ol>
 *   <li>**读面失败 ≠ 未绑定**（`bound === null` 保持 null）：该行必须禁用并标「读面失败」，
 *       不能落成「未绑定」的灰态；</li>
 *   <li>**能力投影读失败 ≠ 没权限**（`canManage === null`）：整块只说"读不到"，不得出现
 *       「你没有权限」的文案 —— 两种禁用原因必须能分辨；</li>
 *   <li>**写后重取读面**：勾选两个工作区提交 ⇒ 各一次 PUT，随后重新 GET，绝不本地置 bound。</li>
 * </ol>
 */

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            getSelfPermissions: vi.fn<typeof apiModule.api.getSelfPermissions>(),
            listWorkspaces: vi.fn<typeof apiModule.api.listWorkspaces>(),
            getWorkspaceAgents: vi.fn<typeof apiModule.api.getWorkspaceAgents>(),
            updateWorkspaceAgentCap: vi.fn<typeof apiModule.api.updateWorkspaceAgentCap>(),
            deleteWorkspaceAgent: vi.fn<typeof apiModule.api.deleteWorkspaceAgent>(),
            getAgentRoles: vi.fn<typeof apiModule.api.getAgentRoles>(),
            setWorkspaceAgentDefault: vi.fn<typeof apiModule.api.setWorkspaceAgentDefault>(),
            clearWorkspaceAgentDefault: vi.fn<typeof apiModule.api.clearWorkspaceAgentDefault>(),
        },
    };
});

const mockedApi = vi.mocked(api, true);

const MANAGE = "MANAGE_WORKSPACE_AGENTS";

const WORKSPACES: apiModule.ApiWorkspace[] = [
    { id: "w-1", name: "研发工作区" } as apiModule.ApiWorkspace,
    { id: "w-2", name: "运维工作区" } as apiModule.ApiWorkspace,
];

function binding(
    bound: boolean,
    extra: Partial<apiModule.WorkspaceAgentBinding> = {},
): apiModule.WorkspaceAgentBinding {
    return {
        principalId: "p-1",
        name: "Coder",
        templateId: null,
        templateName: null,
        createdAt: "2026-11-21T00:00:00Z",
        permissionsSnapshot: [],
        bound,
        disabled: false,
        isDefault: false,
        ...extra,
    };
}

function permissions(instanceAtoms: string[]): apiModule.SelfPermissionsView {
    return {
        userId: "u-1",
        instanceCapabilities: [],
        instancePermissions: instanceAtoms.map((actionClass) => ({
            actionClass,
            resource: "agent",
        })),
        workspaces: [],
    };
}

function mountPanel() {
    return mount(AgentWorkspaceBindingsPanel, {
        props: { principalId: "p-1" },
        global: { plugins: [i18n] },
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getSelfPermissions.mockResolvedValue(permissions([MANAGE]));
    mockedApi.listWorkspaces.mockResolvedValue(WORKSPACES);
    mockedApi.getWorkspaceAgents.mockResolvedValue([]);
    mockedApi.updateWorkspaceAgentCap.mockResolvedValue({
        principalId: "p-1",
        workspaceId: "w-1",
        permissions: [],
        capSource: "explicit",
    });
    mockedApi.deleteWorkspaceAgent.mockResolvedValue(undefined);
    mockedApi.getAgentRoles.mockResolvedValue([]);
    mockedApi.setWorkspaceAgentDefault.mockResolvedValue(undefined);
    mockedApi.clearWorkspaceAgentDefault.mockResolvedValue(undefined);
});

describe("AgentWorkspaceBindingsPanel（task-153 S1）", () => {
    it("单工作区读面 403 ⇒ 该行禁用并标「读面失败」，绝不显示成「未绑定」", async () => {
        mockedApi.getWorkspaceAgents.mockImplementation(async (workspaceId: string) => {
            if (workspaceId === "w-2") {
                throw new ApiError({
                    status: 403,
                    code: "WORKSPACE_FORBIDDEN",
                    detail: "forbidden",
                    requestId: "req-w2",
                });
            }
            return [binding(true, { isDefault: true, capSource: "baseline" })];
        });

        const wrapper = mountPanel();
        await flushPromises();

        const unreadable = wrapper.find('[data-testid="agent-bindings-check-w-2"]');
        expect(unreadable.attributes("disabled")).toBeDefined();
        const stateText = wrapper.find('[data-testid="agent-bindings-state-w-2"]').text();
        expect(stateText).toContain("读面失败");
        // 不能退化成「未绑定」这个状态结论（文案里"不能当作未绑定处理"是解释，允许多一句）。
        expect(stateText.startsWith("读面失败")).toBe(true);
        expect(stateText).not.toBe("未绑定");

        // 可读行仍可操作：只禁读不到的那一行，不把整块变灰。
        expect(
            wrapper.find('[data-testid="agent-bindings-check-w-1"]').attributes("disabled"),
        ).toBeUndefined();
        expect(wrapper.find('[data-testid="agent-bindings-state-w-1"]').text()).toContain("已绑定");
    });

    it("能力投影读失败 ⇒ 只说「读不到」，不出现「没有权限」，也不列工作区", async () => {
        mockedApi.getSelfPermissions.mockRejectedValue(
            new ApiError({ status: 500, code: "INTERNAL", detail: "boom", requestId: "req-cap" }),
        );

        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-bindings-read-failed"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-bindings-no-permission"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="agent-bindings-list"]').exists()).toBe(false);
        // 读失败时不得把"未知"写成"没权限"。
        expect(wrapper.text()).not.toContain("没有可管理的工作区智能体权限");
    });

    it("勾选两个工作区提交 ⇒ 各一次 PUT（显式零 cap）且写后重取读面", async () => {
        const wrapper = mountPanel();
        await flushPromises();

        await wrapper.find('[data-testid="agent-bindings-check-w-1"]').trigger("click");
        await wrapper.find('[data-testid="agent-bindings-check-w-2"]').trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="agent-bindings-pending"]').text()).toContain("2");

        const getsBefore = mockedApi.getWorkspaceAgents.mock.calls.length;
        await wrapper.find('[data-testid="agent-bindings-save"]').trigger("click");
        await flushPromises();

        expect(mockedApi.updateWorkspaceAgentCap.mock.calls).toEqual([
            ["w-1", "p-1", []],
            ["w-2", "p-1", []],
        ]);
        // 写后重取：每次写成功都重取整份读面（两个工作区各一次 ⇒ 两次写共 4 次 GET），
        // 不是本地把 bound 改成 true。
        expect(mockedApi.getWorkspaceAgents.mock.calls.length).toBe(getsBefore + 4);
        expect(wrapper.find('[data-testid="agent-bindings-saved"]').exists()).toBe(true);
    });

    it("写失败 ⇒ 原文交给 presentCauseError：显示 copy + code，且不把已勾选项清掉", async () => {
        mockedApi.updateWorkspaceAgentCap.mockRejectedValue(
            new ApiError({
                status: 403,
                code: "AGENT_PERMISSION_SCOPE_EXCEEDED",
                detail: "permissions exceed scope",
                requestId: "req-put",
            }),
        );

        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.find('[data-testid="agent-bindings-check-w-1"]').trigger("click");
        await flushPromises();
        await wrapper.find('[data-testid="agent-bindings-save"]').trigger("click");
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-bindings-error"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-bindings-error-code"]').text()).toContain(
            "AGENT_PERMISSION_SCOPE_EXCEEDED",
        );
        // 失败后可重试：勾选态不能被清空。
        expect(wrapper.find('[data-testid="agent-bindings-pending"]').exists()).toBe(true);
    });

    it("没有 MANAGE_WORKSPACE_AGENTS 原子 ⇒ 候选为空、零读面请求、提交不可点（卡面 S1 反）", async () => {
        mockedApi.getSelfPermissions.mockResolvedValue(permissions(["VIEW_WORKSPACE"]));

        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-bindings-no-permission"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-bindings-list"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="agent-bindings-empty"]').exists()).toBe(false);
        // 提交入口在但不可点（不是靠隐藏按钮"避免误操作"——用户要能看见为什么不能点）。
        expect(
            wrapper.find('[data-testid="agent-bindings-save"]').attributes("disabled"),
        ).toBeDefined();
        // 没有可管工作区 ⇒ 不必逐个工作区去读绑定（省掉 N 次注定 403 的请求）。
        expect(mockedApi.getWorkspaceAgents).not.toHaveBeenCalled();
        expect(mockedApi.updateWorkspaceAgentCap).not.toHaveBeenCalled();
        expect(mockedApi.deleteWorkspaceAgent).not.toHaveBeenCalled();
    });
});

function role(bindingId: string, name: string, displayName: string | null = null) {
    return {
        bindingId,
        roleId: "r-" + bindingId,
        name,
        displayName,
        scopeType: "workspace",
        scopeId: "w-1",
        scopeName: "研发工作区",
        isSystem: false,
        grantedBy: null,
        atomSummary: [],
        atomCount: 0,
        atomsTruncated: false,
    } as apiModule.AgentRoleBinding;
}

describe("AgentWorkspaceBindingsPanel（task-153 S2 角色读面 + 默认开关）", () => {
    it("已绑行显示角色名；未绑行不渲染角色区，也没有默认按钮", async () => {
        mockedApi.getWorkspaceAgents.mockImplementation(async (workspaceId: string) =>
            workspaceId === "w-1" ? [binding(true, { isDefault: true })] : [],
        );
        mockedApi.getAgentRoles.mockResolvedValue([
            role("b-1", "OrgAdmin", "组织管理员"),
            role("b-2", "Auditor"),
        ]);

        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-bindings-role-w-1-b-1"]').text()).toBe(
            "组织管理员",
        );
        // 没有 displayName 的行回落 name（不编造、不留空）。
        expect(wrapper.find('[data-testid="agent-bindings-role-w-1-b-2"]').text()).toBe("Auditor");
        // 只给已绑行读角色（未绑行连请求都不发）。
        expect(mockedApi.getAgentRoles.mock.calls).toEqual([["w-1", "p-1"]]);

        // 未绑行：没有角色区、没有默认按钮。
        expect(wrapper.find('[data-testid="agent-bindings-roles-w-2"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="agent-bindings-default-toggle-w-2"]').exists()).toBe(
            false,
        );
        // 已绑 + 已是默认 ⇒ 按钮文案是"取消"，而不是隐藏（用户要能看见当前状态）。
        const toggle = wrapper.find('[data-testid="agent-bindings-default-toggle-w-1"]');
        expect(toggle.text()).toBe("取消工作区默认");
        expect(toggle.attributes("disabled")).toBeUndefined();
    });

    // 锚点（Lead 2026-11-21 10:55，与 task-219 同口径）：404 ≠ 空数组，code 必须透出。
    it("角色 404 ⇒ 单独的「读不到」态并透出 code，绝不写成「没有角色」", async () => {
        mockedApi.getWorkspaceAgents.mockResolvedValue([binding(true)]);
        mockedApi.getAgentRoles.mockRejectedValue(
            new ApiError({
                status: 404,
                code: "AGENT_PRINCIPAL_NOT_FOUND",
                detail: "not visible in this workspace",
                requestId: "req-roles",
            }),
        );

        const wrapper = mountPanel();
        await flushPromises();

        const notFound = wrapper.find('[data-testid="agent-bindings-roles-not-found-w-1"]');
        expect(notFound.exists()).toBe(true);
        expect(notFound.text()).toContain("读不到");
        expect(notFound.text()).toContain("AGENT_PRINCIPAL_NOT_FOUND");
        // 三种空态互斥：404 不能同时出现"没有角色"的结论。
        expect(wrapper.find('[data-testid="agent-bindings-roles-empty-w-1"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="agent-bindings-roles-failed-w-1"]').exists()).toBe(
            false,
        );
        expect(notFound.text()).not.toContain("还没有绑定任何角色");
    });

    it("角色读到空数组 ⇒ 才是「没有角色」；5xx ⇒ 单独的网络/服务端失败态", async () => {
        mockedApi.getWorkspaceAgents.mockImplementation(async (workspaceId: string) =>
            workspaceId === "w-1" ? [binding(true)] : workspaceId === "w-2" ? [binding(true)] : [],
        );

        const wrapper = mountPanel();
        await flushPromises();
        expect(wrapper.find('[data-testid="agent-bindings-roles-empty-w-1"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-bindings-roles-not-found-w-1"]').exists()).toBe(
            false,
        );

        mockedApi.getWorkspaceAgents.mockResolvedValue([binding(true)]);
        mockedApi.getAgentRoles.mockRejectedValue(
            new ApiError({ status: 500, code: "INTERNAL", detail: "boom", requestId: "req-500" }),
        );
        const failing = mountPanel();
        await flushPromises();
        expect(failing.find('[data-testid="agent-bindings-roles-failed-w-1"]').exists()).toBe(true);
        expect(failing.find('[data-testid="agent-bindings-roles-not-found-w-1"]').exists()).toBe(
            false,
        );
    });

    it("设为默认 ⇒ 一次 PUT .../default，并按工作区数重取读面（正交断言，不看文案）", async () => {
        mockedApi.getWorkspaceAgents.mockResolvedValue([binding(true, { isDefault: false })]);
        mockedApi.getAgentRoles.mockResolvedValue([]);

        const wrapper = mountPanel();
        await flushPromises();
        const readsBefore = mockedApi.getWorkspaceAgents.mock.calls.length;

        await wrapper.find('[data-testid="agent-bindings-default-toggle-w-1"]').trigger("click");
        await flushPromises();

        expect(mockedApi.setWorkspaceAgentDefault.mock.calls).toEqual([["w-1", "p-1"]]);
        expect(mockedApi.clearWorkspaceAgentDefault).not.toHaveBeenCalled();
        // 正交：写 1 次，读面按可管理工作区数重取（w-1 + w-2 ⇒ 2 次），标记只认 CP 回包。
        expect(mockedApi.getWorkspaceAgents.mock.calls.length).toBe(
            readsBefore + WORKSPACES.length,
        );
        expect(
            wrapper
                .find('[data-testid="agent-bindings-default-toggle-w-1"]')
                .attributes("disabled"),
        ).toBeUndefined();
    });

    it("默认开关失败 ⇒ 行内显示原文与 code，且不谎报成功", async () => {
        mockedApi.getWorkspaceAgents.mockResolvedValue([binding(true, { isDefault: false })]);
        mockedApi.setWorkspaceAgentDefault.mockRejectedValue(
            new ApiError({
                status: 404,
                code: "AGENT_PRINCIPAL_NOT_FOUND",
                detail: "default endpoint not found",
                requestId: "req-default",
            }),
        );

        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.find('[data-testid="agent-bindings-default-toggle-w-1"]').trigger("click");
        await flushPromises();

        const rowError = wrapper.find('[data-testid="agent-bindings-default-error-w-1"]');
        expect(rowError.exists()).toBe(true);
        expect(rowError.text()).toContain("AGENT_PRINCIPAL_NOT_FOUND");
        expect(wrapper.find('[data-testid="agent-bindings-error"]').exists()).toBe(false);
    });
});

/**
 * task-41（Lead 2026-11-21 裁定 A/B）：读态语义 —— 「判据没齐」不许画成「没权限」。
 *
 * <p>原理由：`useAgentBindings` 曾先置 `capabilityState = "ready"` 再 `await listWorkspaces()`，
 * 于是清单往返的那几百毫秒里 `canManage` 算出 `false`（而不是 `null`），面板直接落
 * 「你没有可管理的工作区智能体权限」。三例分别钉：未回 ⇒ null、回了 ⇒ true + 行数、失败 ⇒ 错误态 + 重试。</p>
 */
describe("AgentWorkspaceBindingsPanel（task-41 读态语义）", () => {
    it("清单延迟未回 ⇒ 停在加载态，不出现「没有权限」也不出现空态；回来后才列行", async () => {
        let release: (rows: apiModule.ApiWorkspace[]) => void = () => {};
        mockedApi.listWorkspaces.mockImplementation(
            () =>
                new Promise<apiModule.ApiWorkspace[]>((resolve) => {
                    release = resolve;
                }),
        );

        const wrapper = mountPanel();
        await flushPromises();

        // 能力投影已回、清单未回：判据不齐 ⇒ 只能说"还在读"。
        expect(wrapper.find('[data-testid="agent-bindings-loading"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-bindings-no-permission"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="agent-bindings-empty"]').exists()).toBe(false);
        expect(wrapper.text()).not.toContain("没有可管理的工作区智能体权限");
        // 判据没齐时提交不可点（能看见为什么不能点）。
        expect(
            wrapper.find('[data-testid="agent-bindings-save"]').attributes("disabled"),
        ).toBeDefined();

        release(WORKSPACES);
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-bindings-loading"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="agent-bindings-no-permission"]').exists()).toBe(false);
        // 行数 = 清单返回值，不是 0。
        expect(wrapper.findAll('[data-testid^="agent-bindings-row-"]').length).toBe(
            WORKSPACES.length,
        );
        // 清单回来后也确实去读了每个工作区的绑定（判据齐了才发这 N 个 GET）。
        expect(mockedApi.getWorkspaceAgents.mock.calls.length).toBe(WORKSPACES.length);
    });

    it("清单读失败 ⇒ 可区分的错误态 + 重试入口，不渲染「没有权限」也不渲染空态", async () => {
        mockedApi.listWorkspaces.mockRejectedValue(
            new ApiError({ status: 500, code: "INTERNAL", detail: "boom", requestId: "req-ws" }),
        );

        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-bindings-read-failed"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-bindings-read-failed-copy"]').text()).toContain(
            "读不到工作区清单",
        );
        expect(wrapper.find('[data-testid="agent-bindings-retry"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-bindings-no-permission"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="agent-bindings-empty"]').exists()).toBe(false);
        expect(wrapper.text()).not.toContain("没有可管理的工作区智能体权限");
        // 清单都没读到，就不该逐个工作区去读绑定（省掉注定 403 的请求）。
        expect(mockedApi.getWorkspaceAgents).not.toHaveBeenCalled();

        // 重试：修好后点一下就回到列表 —— 失败态不是死路。
        mockedApi.listWorkspaces.mockResolvedValue(WORKSPACES);
        await wrapper.find('[data-testid="agent-bindings-retry"]').trigger("click");
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-bindings-read-failed"]').exists()).toBe(false);
        expect(wrapper.findAll('[data-testid^="agent-bindings-row-"]').length).toBe(
            WORKSPACES.length,
        );
    });

    it("能力投影真没权限 vs 清单读失败：两种输入渲染不同（这张卡的核心判据）", async () => {
        mockedApi.getSelfPermissions.mockResolvedValue(permissions(["VIEW_WORKSPACE"]));
        const denied = mountPanel();
        await flushPromises();
        const deniedCopy = denied.find('[data-testid="agent-bindings-no-permission"]').text();

        mockedApi.getSelfPermissions.mockResolvedValue(permissions([MANAGE]));
        mockedApi.listWorkspaces.mockRejectedValue(
            new ApiError({ status: 500, code: "INTERNAL", detail: "boom", requestId: "req-ws" }),
        );
        const unreadable = mountPanel();
        await flushPromises();
        const failedCopy = unreadable
            .find('[data-testid="agent-bindings-read-failed-copy"]')
            .text();

        expect(deniedCopy).not.toBe(failedCopy);
        expect(deniedCopy).toContain("没有可管理的工作区智能体权限");
        expect(failedCopy).not.toContain("没有可管理的工作区智能体权限");
        expect(unreadable.find('[data-testid="agent-bindings-retry"]').exists()).toBe(true);
        // 真没权限时不给重试（重试不会变出权限，只会给用户一个假的出口）。
        expect(denied.find('[data-testid="agent-bindings-retry"]').exists()).toBe(false);
    });
});

/**
 * task-92 缺口二（面板段）：勾选攒批的草稿必须能被页面守卫看见。
 *
 * <p>钉三件事：① 载入完成即广播 false（页面守卫的初始态，不广播就是 undefined ⇒ 页面判成「不确定」）；
 * ② 勾一行 ⇒ true；**勾回原值 ⇒ false**（不需要「还原」按钮，脏态由 `pending` 派生）；
 * ③ 保存成功后复位 false。</p>
 */
describe("AgentWorkspaceBindingsPanel · 勾选草稿广播（task-92）", () => {
    function lastDirty(wrapper: ReturnType<typeof mountPanel>): boolean | undefined {
        const events = wrapper.emitted("dirty") ?? [];
        return events.length ? (events[events.length - 1]?.[0] as boolean) : undefined;
    }

    it("载入完成即广播 false，勾选一行广播 true", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        expect(lastDirty(wrapper), "载入后草稿为空，页面守卫必须收到确定的 false").toBe(false);

        await wrapper.find('[data-testid="agent-bindings-check-w-1"]').trigger("click");
        await flushPromises();
        expect(lastDirty(wrapper), "勾选一行 = 有未保存的绑定改动").toBe(true);
    });

    it("勾回原值 ⇒ 草稿消失、广播 false（取消不是新草稿）", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        const check = wrapper.find('[data-testid="agent-bindings-check-w-1"]');
        await check.trigger("click");
        await flushPromises();
        expect(lastDirty(wrapper)).toBe(true);

        await check.trigger("click");
        await flushPromises();
        expect(lastDirty(wrapper), "勾回原值后 pending 归零，不该继续拦导航").toBe(false);
        expect(
            wrapper.find('[data-testid="agent-bindings-pending"]').exists(),
            "pending 归零后待提交计数整块不渲染",
        ).toBe(false);
    });

    it("保存成功后广播 false（草稿随 picked 清空，不靠手动复位）", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.find('[data-testid="agent-bindings-check-w-1"]').trigger("click");
        await flushPromises();
        expect(lastDirty(wrapper)).toBe(true);

        await wrapper.find('[data-testid="agent-bindings-save"]').trigger("click");
        await flushPromises();
        expect(lastDirty(wrapper), "保存成功后不再有草稿").toBe(false);
    });
});
