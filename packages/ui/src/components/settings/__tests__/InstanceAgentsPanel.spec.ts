import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * task-165：实例层「平台智能体」面板。判据同凭据面板 —— 真列表 / 403 卡片 / 空态出口。
 */
const authState = vi.hoisted(() => ({ isAdmin: true }));

vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => authState,
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

    it("非实例管理员：403 卡片，且不发列表请求", async () => {
        authState.isAdmin = false;
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-atom-denied"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-no-atom-notice"]').exists()).toBe(false);
        expect(mockedList).not.toHaveBeenCalled();

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
