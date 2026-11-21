import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import type * as apiModule from "../../../composables/api";
import { api } from "../../../composables/api";
import { i18n } from "../../../i18n";
import AgentPrincipalsPanel from "../AgentPrincipalsPanel.vue";

/**
 * PLAN-0750 M3（T3.1 / T3.2 / T3.3）：用户层「智能体」面板。
 *
 * <p>锁四件事，全部对应冻结矩阵的判据：</p>
 * <ol>
 *   <li><b>U1</b>——创建表单**没有工作区选择器**，且创建走 `createOwnAgentPrincipal`
 *       （无 ws 上下文）；`createAgentPrincipal`（工作区门）一次都不许被调到。</li>
 *   <li><b>R3</b>——列表只读 `listMyAgentPrincipals`（个人视图）。</li>
 *   <li><b>U2</b>——本面板不碰 `WorkspaceAgentPrincipalsPanel` 的单门；绑定只是工作区能力。</li>
 *   <li><b>task-153 S4</b>——行内绑定小窗与「没有可管理工作区」提示已删；本页只留创建 / 配置 / 停用，
 *       唯一的绑定入口是行内指向整页的链接（删前那套 T3.2 判据整段落到了整页与 useAgentBindings）。</li>
 * </ol>
 */

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listMyAgentPrincipals: vi.fn<typeof apiModule.api.listMyAgentPrincipals>(),
            createOwnAgentPrincipal: vi.fn<typeof apiModule.api.createOwnAgentPrincipal>(),
            createAgentPrincipal: vi.fn<typeof apiModule.api.createAgentPrincipal>(),
            getSelfPermissions: vi.fn<typeof apiModule.api.getSelfPermissions>(),
            // task-153 S4：本页不再拉工作区清单 / 工作区智能体，也不写工作区绑定
            // ⇒ 只保留 getWorkspaceAgents 作为「个人视图不读工作区面」的负向钉子。
            getWorkspaceAgents: vi.fn<typeof apiModule.api.getWorkspaceAgents>(),
        },
    };
});

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string) => void>(),
        warn: vi.fn<(message: string) => void>(),
    },
}));

const mockedApi = vi.mocked(api, true);

function agentRow(principalId: string, name: string): apiModule.AgentPrincipalSummary {
    return {
        principalId,
        name,
        templateId: null,
        templateName: null,
        createdAt: "2026-11-10T00:00:00Z",
        disabled: false,
        defaultModelProvider: null,
        defaultModelName: null,
    };
}

/** 默认：普通 USER —— 有 CREATE_OWN_AGENT，但只在 ws-1 持 MANAGE_WORKSPACE_AGENTS。 */
function selfPermissions(options: {
    instanceAtoms?: string[];
    workspaces?: apiModule.SelfPermissionsView["workspaces"];
}): apiModule.SelfPermissionsView {
    return {
        userId: "user-1",
        instanceCapabilities: [],
        instancePermissions: (options.instanceAtoms ?? ["CREATE_OWN_AGENT"]).map((actionClass) => ({
            actionClass,
            resource: "*",
        })),
        workspaces: options.workspaces ?? [
            {
                workspaceId: "ws-1",
                workspaceRole: "OWNER",
                workspaceAdmin: true,
                permissions: [{ actionClass: "MANAGE_WORKSPACE_AGENTS", resource: "ws-1" }],
            },
        ],
    };
}

/**
 * task-153 S1：行内多了指向「绑定整页」的 `RouterLink` ⇒ 面板 spec 必须给一个真 router。
 *
 * <p>刻意**不 stub RouterLink**：stub 掉就只剩"调了这个组件"，链接目标写成什么都不会红；
 * 这里要的是**解析后的 href**（拼错名字/漏 params 立刻红）。路由只放本卡那一条，不用整份
 * `router/index.ts` —— 那份带守卫与懒加载，面板 spec 不需要为它承担噪声。</p>
 */
function makeRouter(): Router {
    return createRouter({
        history: createMemoryHistory(),
        routes: [
            {
                path: "/settings/instance/agent-principals/:id/bindings",
                name: "settings-agent-principal-bindings",
                component: { template: "<div />" },
            },
        ],
    });
}

function mountPanel() {
    // task-138 起详情抽屉在 setup 读配置 store（选连接）⇒ 面板 spec 必须给 pinia，否则整文件红。
    return mount(AgentPrincipalsPanel, {
        global: { plugins: [i18n, createPinia(), makeRouter()] },
        attachTo: document.body,
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    mockedApi.listMyAgentPrincipals.mockResolvedValue([agentRow("p-1", "MyAgent")]);
    mockedApi.getSelfPermissions.mockResolvedValue(selfPermissions({}));
    mockedApi.getWorkspaceAgents.mockResolvedValue([]);
    mockedApi.createOwnAgentPrincipal.mockResolvedValue({
        principalId: "p-2",
        templateId: null,
        templateName: null,
        createdAt: "2026-11-10T00:00:00Z",
    });
});

describe("AgentPrincipalsPanel — 列表与个人视图 (R3)", () => {
    it("renders the personal view from listMyAgentPrincipals", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        expect(mockedApi.listMyAgentPrincipals).toHaveBeenCalledTimes(1);
        expect(wrapper.find('[data-testid="agent-principals-row-p-1"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-principals-row-name-p-1"]').text()).toBe(
            "MyAgent",
        );
        // 个人视图 = 没有 workspaceId 查询参数那个入口；这条锁住"没换成工作区列表"。
        expect(mockedApi.getWorkspaceAgents).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
        );
        wrapper.unmount();
    });

    it("shows the empty state when the caller has created nothing", async () => {
        mockedApi.listMyAgentPrincipals.mockResolvedValue([]);
        const wrapper = mountPanel();
        await flushPromises();
        expect(wrapper.find('[data-testid="agent-principals-empty"]').exists()).toBe(true);
        wrapper.unmount();
    });
});

describe("AgentPrincipalsPanel — 创建走用户级门 (U1)", () => {
    it("has no workspace selector in the create form", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.find('[data-testid="agent-principals-create-button"]').trigger("click");

        const form = wrapper.find('[data-testid="agent-principals-create-form"]');
        expect(form.exists()).toBe(true);
        // 矩阵 U1：一旦带工作区，CP 会按 MANAGE_WORKSPACE_AGENTS 判权 ⇒ 普通账号 403。
        expect(form.find('[data-testid="agent-principals-create-workspace"]').exists()).toBe(false);
        expect(form.html()).not.toContain("workspaceId");
        wrapper.unmount();
    });

    it("creates through createOwnAgentPrincipal with a name-only body", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.find('[data-testid="agent-principals-create-button"]').trigger("click");
        await wrapper.find('[data-testid="agent-principals-create-name"]').setValue("MyAgent");
        await wrapper.find('[data-testid="agent-principals-create-form"]').trigger("submit");
        await flushPromises();

        expect(mockedApi.createOwnAgentPrincipal).toHaveBeenCalledTimes(1);
        expect(mockedApi.createOwnAgentPrincipal).toHaveBeenCalledWith({ name: "MyAgent" });
        // 工作区门那条路一次都不能被调到（U1：两扇门不许串）。
        expect(mockedApi.createAgentPrincipal).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it("shows the atom-denied gate instead of the create button without CREATE_OWN_AGENT", async () => {
        mockedApi.getSelfPermissions.mockResolvedValue(selfPermissions({ instanceAtoms: [] }));
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-principals-create-denied"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-atom-denied"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-principals-create-button"]').exists()).toBe(false);
        wrapper.unmount();
    });
});

/**
 * task-153 S4：列表页只留创建 / 配置 / 停用，绑定整页是**唯一**的绑定入口。
 *
 * <p>删掉行内小窗后，本页不该再出现第二处绑定入口，也不该出现「你没有可管理的工作区智能体权限」
 * 这类按能力位隐藏的提示 —— 绑定权限的读态语义只在整页里表达（`useAgentBindings`，task-41）。</p>
 */
describe("AgentPrincipalsPanel — 绑定入口唯一（task-153 S4）", () => {
    it("没有可管理工作区时，列表行仍只有一处绑定入口且指向整页（不再渲染任何权限提示）", async () => {
        mockedApi.getSelfPermissions.mockResolvedValue(
            selfPermissions({ instanceAtoms: ["CREATE_OWN_AGENT"], workspaces: [] }),
        );

        const wrapper = mountPanel();
        await flushPromises();

        const entry = wrapper.find('[data-testid="agent-principals-bindings-p-1"]');
        expect(entry.exists()).toBe(true);
        expect(entry.attributes("href")).toBe("/settings/instance/agent-principals/p-1/bindings");
        // S4 删除面：旧的行内绑定按钮不在本页，本页也不再替整页猜权限。
        expect(wrapper.find('[data-testid="agent-principals-bind-p-1"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("列表行绑定入口唯一：唯一匹配 agent-principals-bind 前缀的就是整页入口", async () => {
        const wrapper = mountPanel();
        await flushPromises();

        const entries = wrapper.findAll('[data-testid^="agent-principals-bind"]');
        expect(entries).toHaveLength(1);
        expect(entries[0]!.attributes("data-testid")).toBe("agent-principals-bindings-p-1");
        wrapper.unmount();
    });
});

/**
 * task-135 J4：用户截图报障「智能体主体」标题在 /members 上出现**两次** —— 一次是页面 h2，
 * 一次是本面板的 eyebrow + h1。面板因此加 embedded：嵌入时不渲染自己的标题，改由宿主插槽给；
 * 默认 false ⇒ 独立挂载（设置域历史形态）一个字节都不变，这两例成对钉住。
 */
describe("AgentPrincipalsPanel — 嵌入模式（task-135 J4 标题去重）", () => {
    it("embedded：不自渲染 eyebrow + h1，标题走 #heading 插槽，动作入口仍在", async () => {
        const wrapper = mount(AgentPrincipalsPanel, {
            props: { embedded: true },
            slots: { heading: '<h2 data-testid="host-heading">宿主标题</h2>' },
            global: { plugins: [i18n, createPinia(), makeRouter()] },
            attachTo: document.body,
        });
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-principals-heading"]').exists()).toBe(false);
        expect(wrapper.text()).not.toContain(i18n.global.t("settings.eyebrow.agentPrincipals"));
        expect(wrapper.find('[data-testid="host-heading"]').text()).toBe("宿主标题");
        // 去重不是砍入口：刷新/创建仍可发现（面板右侧动作区不随标题一起去掉）。
        expect(wrapper.find('[data-testid="agent-principals-refresh"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="agent-principals-create-button"]').exists()).toBe(true);
        wrapper.unmount();
    });

    it("默认（独立挂载）仍渲染自己的 eyebrow + h1 —— 既有调用点行为不变", async () => {
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="agent-principals-heading"]').exists()).toBe(true);
        expect(wrapper.text()).toContain(i18n.global.t("settings.eyebrow.agentPrincipals"));
        wrapper.unmount();
    });
});

/**
 * task-153 S1：列表页跳「绑定整页」的入口。
 *
 * <p>两件必须咬住：① 链接**按 id 拼路由名**解析（不是手拼字符串，也不是靠主体名）；
 * ② 入口**不按能力位隐藏**（S4 起这是本页唯一的绑定入口）—— 没有 MANAGE_WORKSPACE_AGENTS 的人
 * 进去也要能看到页面上的「你没有可管理的工作区智能体权限」，而不是按钮消失、连"为什么"都看不到
 * （reader ≠ writer）。</p>
 */
describe("AgentPrincipalsPanel — 绑定整页入口（task-153 S1）", () => {
    it("行内入口解析成 /settings/instance/agent-principals/{id}/bindings（只靠 id，不等 task-195 的名称读面）", async () => {
        const wrapper = mountPanel();
        await flushPromises();

        const link = wrapper.find('[data-testid="agent-principals-bindings-p-1"]');
        expect(link.exists()).toBe(true);
        expect(link.attributes("href")).toBe("/settings/instance/agent-principals/p-1/bindings");
        expect(link.text()).toContain(i18n.global.t("agentBindings.openPage"));
        // 名字缺失也照样能进：href 里不含主体名，只含 id。
        expect(link.attributes("href")).not.toContain("MyAgent");
        wrapper.unmount();
    });

    it("没有 MANAGE_WORKSPACE_AGENTS 原子时入口仍在（读面入口不等于写面按钮）", async () => {
        mockedApi.getSelfPermissions.mockResolvedValue(
            selfPermissions({ instanceAtoms: ["CREATE_OWN_AGENT"], workspaces: [] }),
        );

        const wrapper = mountPanel();
        await flushPromises();

        // 整页入口照旧在（S4 删掉行内小窗后它是唯一入口）：进去能看到
        // 「你没有可管理的工作区智能体权限」这句实话。
        expect(wrapper.find('[data-testid="agent-principals-bindings-p-1"]').exists()).toBe(true);
        wrapper.unmount();
    });
});
