import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * task-165：实例层「平台智能体」面板。判据同凭据面板 —— 真列表 / 403 卡片 / 空态出口。
 */
/**
 * task-69：面板的鉴权面现在是**三件**——能力位（读/写双门的前半段）、动作原子（写侧后半段）、
 * 已登录（读面的 CP 判据本来就是 `isAuthenticated()`）。桩按 CP 守卫的形状给，不按组件内部变量名给。
 */
const authState = vi.hoisted(() => ({
    isAdmin: true,
    isAuthenticated: true,
    atoms: new Set<string>(["MANAGE_AGENT_PRINCIPALS"]),
}));

vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({
        isAuthenticated: authState.isAuthenticated,
        hasInstanceAdminCapability: authState.isAdmin,
        hasInstanceAtom: (atom: string) => authState.atoms.has(atom),
    }),
}));

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string) => void>(),
    },
}));

vi.mock("../../../services/instanceResources", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../services/instanceResources")>();
    return {
        ...actual,
        listInstanceAgents: vi.fn<typeof actual.listInstanceAgents>(),
        createInstanceAgent: vi.fn<typeof actual.createInstanceAgent>(),
        deleteInstanceAgent: vi.fn<typeof actual.deleteInstanceAgent>(),
    };
});

import { listInstanceAgents, type InstanceAgent } from "../../../services/instanceResources";
import { i18n } from "../../../i18n";
import SettingsLayerHeader from "../SettingsLayerHeader.vue";
import InstanceAgentsPanel from "../InstanceAgentsPanel.vue";

const mockedList = vi.mocked(listInstanceAgents);

function agent(id: string, name: string): InstanceAgent {
    return {
        id,
        name,
        description: null,
        templateName: null,
        modelProvider: "anthropic",
        modelName: "claude-sonnet-4.5",
        createdAt: "2026-10-21T03:22:00Z",
        disabled: false,
    };
}

function mountPanel() {
    return mount(InstanceAgentsPanel, {
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    authState.isAdmin = true;
    authState.isAuthenticated = true;
    authState.atoms = new Set(["MANAGE_AGENT_PRINCIPALS"]);
    mockedList.mockResolvedValue({ agents: [], count: 0 });
});

describe("InstanceAgentsPanel", () => {
    it("管理员：列出平台智能体（行 + 模型列）", async () => {
        mockedList.mockResolvedValue({ agents: [agent("agent-1", "代码评审助手")], count: 1 });
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="instance-agents-table"]').exists()).toBe(true);
        const row = wrapper.find('[data-testid="instance-agent-row-agent-1"]');
        expect(row.exists()).toBe(true);
        expect(row.text()).toContain("代码评审助手");
        expect(row.text()).toContain("anthropic / claude-sonnet-4.5");
        expect(wrapper.text()).toContain("1 个智能体");
        expect(wrapper.find('[data-testid="settings-atom-denied"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="instance-agents-write-disabled"]').exists()).toBe(false);

        wrapper.unmount();
    });

    it("空列表：空态有出口（可点创建）", async () => {
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="instance-agents-empty"]').exists()).toBe(true);
        await wrapper.find('[data-testid="instance-agents-empty-create"]').trigger("click");
        expect(wrapper.find('[data-testid="instance-agents-create-dialog"]').exists()).toBe(true);

        wrapper.unmount();
    });

    /**
     * task-69 行 2 的**行为反转**：CP 读面是 `@PreAuthorize("isAuthenticated()")`
     * （`InstanceAgentPrincipalController.java:74-75`）⇒ 非实例管理员**本来就能看**这张表。
     * 旧断言（403 卡片 + 不发请求）钉的是「UI 比 CP 严」—— 那条正是本卡要修的东西，
     * 所以它不是被放宽，是被**纠正**：现在断言「列表照常取数、写侧禁用」。
     */
    it("非实例管理员：列表照常可见（CP 读面只要 isAuthenticated），写按钮 disabled 不隐藏", async () => {
        authState.isAdmin = false;
        mockedList.mockResolvedValue({ agents: [agent("agent-1", "代码评审助手")], count: 1 });
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-atom-denied"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="instance-agents-table"]').exists()).toBe(true);
        expect(mockedList).toHaveBeenCalledTimes(1);
        expect(wrapper.find('[data-testid="instance-agents-write-disabled"]').exists()).toBe(true);
        const create = wrapper.find('[data-testid="instance-agents-create"]');
        expect(create.attributes("disabled")).toBeDefined();
        expect(create.isVisible()).toBe(true);

        wrapper.unmount();
    });

    /**
     * 负例（Lead 指定口径：「无 atom ⇒ disabled 不隐藏」，先例 `ResourceLayerTabs.vue:74`）——
     * 有 `cap:instance:admin` 但**缺** `MANAGE_AGENT_PRINCIPALS` 时：按钮在、点不动、且给出原子名。
     * 反向断言（隐藏而不是禁用）会红，因为隐藏等于告诉用户「产品没这个能力」。
     */
    it("有 cap 无动作原子：写按钮 disabled 不隐藏，理由点名原子", async () => {
        authState.atoms = new Set<string>();
        const wrapper = mountPanel();
        await flushPromises();

        const create = wrapper.find('[data-testid="instance-agents-create"]');
        expect(create.exists()).toBe(true);
        expect(create.isVisible()).toBe(true);
        expect(create.attributes("disabled")).toBeDefined();
        const notice = wrapper.find('[data-testid="instance-agents-write-disabled"]');
        expect(notice.exists()).toBe(true);
        expect(notice.text()).toContain("MANAGE_AGENT_PRINCIPALS");

        wrapper.unmount();
    });
    /**
     * task-176：**标题层级不跳级**。资源页不走域页的 `SettingsDomainView`（域页才渲染 `h2`），
     * 所以面板分节标题曾经是 `h3` ⇒ 屏幕/读屏读出来是 `h1（实例配置）→ h3（平台智能体）`，**跳过 h2**。
     * 判据用**整页序列**（层标题 h1 + 面板分节标题），不是"标题只有一个"：
     * 期望 `["H1", "H2"]`；改前是 `["H1", "H3"]` ⇒ 必红。
     */
    it("标题层级不跳级：页面标题序列是 h1 → h2", async () => {
        const Host = defineComponent({
            components: { SettingsLayerHeader, InstanceAgentsPanel },
            template: `<div>
                <SettingsLayerHeader layer="instance" domain="平台智能体" />
                <InstanceAgentsPanel />
            </div>`,
        });
        const wrapper = mount(Host, {
            global: { plugins: [i18n], stubs: { RouterLink: true } },
            attachTo: document.body,
        });
        await flushPromises();
        const tags = Array.from(wrapper.element.querySelectorAll("h1,h2,h3,h4")).map(
            (node) => node.tagName,
        );
        expect(tags).toEqual(["H1", "H2"]);
        wrapper.unmount();
    });
});
