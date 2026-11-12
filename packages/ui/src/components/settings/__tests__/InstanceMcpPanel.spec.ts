import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * task-165：实例层「MCP 注册表」面板。判据同凭据面板 —— 真列表 / 403 卡片 / 空态出口。
 *
 * <p>多锁一条：凭据下拉**只列实例凭据**（D-1006 B5「只可引用实例凭据」）——
 * 它取的是 `listInstanceCredentials()`，不是个人凭据端点。</p>
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
        listInstanceMcpServers: vi.fn<typeof actual.listInstanceMcpServers>(),
        createInstanceMcpServer: vi.fn<typeof actual.createInstanceMcpServer>(),
        deleteInstanceMcpServer: vi.fn<typeof actual.deleteInstanceMcpServer>(),
        listInstanceCredentials: vi.fn<typeof actual.listInstanceCredentials>(),
    };
});

import {
    listInstanceCredentials,
    listInstanceMcpServers,
    type InstanceMcpServer,
} from "../../../services/instanceResources";
import { i18n } from "../../../i18n";
import SettingsLayerHeader from "../SettingsLayerHeader.vue";
import InstanceMcpPanel from "../InstanceMcpPanel.vue";

const mockedList = vi.mocked(listInstanceMcpServers);
const mockedCredentials = vi.mocked(listInstanceCredentials);

function server(id: string, name: string): InstanceMcpServer {
    return {
        id,
        name,
        transport: "http",
        url: "https://mcp.internal.example.com/docs",
        enabled: true,
        credentialId: null,
        createdAt: "2026-10-30T01:10:00Z",
    };
}

function mountPanel() {
    return mount(InstanceMcpPanel, {
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    authState.isAdmin = true;
    mockedList.mockResolvedValue({ servers: [], count: 0 });
    mockedCredentials.mockResolvedValue({ credentials: [], count: 0 });
});

describe("InstanceMcpPanel", () => {
    it("管理员：列出实例级 MCP 服务（名称/传输/地址）", async () => {
        mockedList.mockResolvedValue({ servers: [server("mcp-1", "internal-docs")], count: 1 });
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="instance-mcp-table"]').exists()).toBe(true);
        const row = wrapper.find('[data-testid="instance-mcp-row-mcp-1"]');
        expect(row.exists()).toBe(true);
        expect(row.text()).toContain("internal-docs");
        // task-165 五维自审 P2：传输方式按语义显示（wire 的 "http" → 展示 "HTTP"），不再直出小写字面量。
        expect(row.text()).toContain("HTTP");
        expect(wrapper.text()).toContain("1 个服务");
        // 表单的凭据候选来自**实例**凭据端点。
        expect(mockedCredentials).toHaveBeenCalledTimes(1);

        wrapper.unmount();
    });

    it("空列表：空态有出口（可点注册）", async () => {
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="instance-mcp-empty"]').exists()).toBe(true);
        await wrapper.find('[data-testid="instance-mcp-empty-create"]').trigger("click");
        expect(wrapper.find('[data-testid="instance-mcp-create-dialog"]').exists()).toBe(true);

        wrapper.unmount();
    });

    it("非实例管理员：403 卡片，且不发任何请求", async () => {
        authState.isAdmin = false;
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-atom-denied"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-no-atom-notice"]').exists()).toBe(false);
        expect(mockedList).not.toHaveBeenCalled();
        expect(mockedCredentials).not.toHaveBeenCalled();

        wrapper.unmount();
    });
    /**
     * task-176：**标题层级不跳级**。资源页不走域页的 `SettingsDomainView`（域页才渲染 `h2`），
     * 所以面板分节标题曾经是 `h3` ⇒ 屏幕/读屏读出来是 `h1（实例配置）→ h3（MCP 服务器）`，**跳过 h2**。
     * 判据用**整页序列**（层标题 h1 + 面板分节标题），不是"标题只有一个"：
     * 期望 `["H1", "H2"]`；改前是 `["H1", "H3"]` ⇒ 必红。
     */
    it("标题层级不跳级：页面标题序列是 h1 → h2", async () => {
        const Host = defineComponent({
            components: { SettingsLayerHeader, InstanceMcpPanel },
            template: `<div>
                <SettingsLayerHeader layer="instance" domain="MCP 服务器" />
                <InstanceMcpPanel />
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
