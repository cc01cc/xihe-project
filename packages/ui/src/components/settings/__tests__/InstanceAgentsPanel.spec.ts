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
    ensureSelfPermissions: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({
        ensureSelfPermissions: authState.ensureSelfPermissions,
        isAuthenticated: authState.isAuthenticated,
        hasInstanceAdminCapability: authState.isAdmin,
        hasInstanceAtom: (atom: string) => authState.atoms.has(atom),
    }),
}));

/**
 * task-401：模型三段的数据源是**既有 config store**（连接 + `/models` 目录），不新建状态。
 * 这里按 store 的返回形状给替身（两个 loader 自吞错误，所以替身也只做 no-op）；
 * `chatModelNamesOf` **保持真实现**（下面 partial mock 只换 listProviderCatalog）——
 * 目录优先/manual 回退的策略必须被真跑到，否则这组用例测的是替身。
 */
const configState = vi.hoisted(() => ({
    providerConnections: [] as Array<Record<string, unknown>>,
    providerConnectionsError: false,
    modelError: null as string | null,
    modelCache: { providers: {} as Record<string, unknown> },
    loadProviderConnections: vi.fn<() => Promise<void>>(),
    fetchModels: vi.fn<() => Promise<void>>(),
}));

vi.mock("../../../stores/config", () => ({
    useConfigStore: () => configState,
}));

vi.mock("../../../services/providerConnectionService", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("../../../services/providerConnectionService")>();
    return {
        ...actual,
        listProviderCatalog: vi.fn<typeof actual.listProviderCatalog>(),
    };
});

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

import {
    createInstanceAgent,
    listInstanceAgents,
    type InstanceAgent,
} from "../../../services/instanceResources";
import { listProviderCatalog } from "../../../services/providerConnectionService";
import { Select } from "../../ui/select";
import { Checkbox } from "../../ui/checkbox";
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
    authState.ensureSelfPermissions.mockResolvedValue(true);
    mockedList.mockResolvedValue({ agents: [], count: 0 });
    configState.providerConnections = [
        {
            id: "conn-chat",
            providerId: "anthropic",
            connectionKey: "conn-chat",
            operation: "chat",
            label: "Claude 主连接",
            enabled: true,
            modelDiscovery: "curated",
            manualModels: [],
        },
        {
            id: "conn-embed",
            providerId: "openai",
            connectionKey: "conn-embed",
            operation: "embedding",
            label: "嵌入连接",
            enabled: true,
            modelDiscovery: "curated",
            manualModels: [],
        },
        {
            id: "conn-openai-chat",
            providerId: "openai",
            connectionKey: "conn-openai-chat",
            operation: "chat",
            label: "GPT 主连接",
            enabled: true,
            modelDiscovery: "curated",
            manualModels: [],
        },
        {
            id: "conn-off",
            providerId: "anthropic",
            connectionKey: "conn-off",
            operation: "chat",
            label: "停用连接",
            enabled: false,
            modelDiscovery: "manual",
            manualModels: ["should-not-appear"],
        },
    ];
    configState.providerConnectionsError = false;
    configState.modelError = null;
    configState.modelCache = {
        providers: {
            "conn-openai-chat": {
                providerId: "openai",
                connectionId: "conn-openai-chat",
                status: "ready",
                models: [{ name: "gpt-5.1", capabilities: { chat: true } }],
            },
            "conn-chat": {
                providerId: "anthropic",
                connectionId: "conn-chat",
                status: "ready",
                models: [
                    { name: "claude-sonnet-4-5", capabilities: { chat: true } },
                    { name: "claude-haiku-4-5", capabilities: { chat: true } },
                    { name: "voyage-3", capabilities: { chat: false } },
                ],
            },
        },
    };
    configState.loadProviderConnections.mockResolvedValue(undefined);
    configState.fetchModels.mockResolvedValue(undefined);
    vi.mocked(listProviderCatalog).mockResolvedValue({
        catalogRevision: "r1",
        providers: [{ id: "anthropic", displayName: "Anthropic" }],
    } as Awaited<ReturnType<typeof listProviderCatalog>>);
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

/**
 * task-401 / `D-1248`：创建面的**模型意图**（provider＞连接＞模型）。
 *
 * <p>判据落在**真发出去的载荷**与**阻塞态**上，不落在下拉选项的 DOM 上 —— reka `SelectContent`
 * 只在打开时渲染，jsdom 里程序化选项不可靠（`packages/ui/AGENTS.md`：MenuItem/选项交互归 Playwright）。
 * 所以这里用 v-model 契约（`update:modelValue`）驱动级联，真指针链路由
 * `e2e/mock/task401-instance-agent-model.spec.ts` 承担。目录策略本身由
 * `services/__tests__/providerConnectionService.chatModels.spec.ts` 纯函数钉住。</p>
 */
describe("InstanceAgentsPanel · task-401 模型意图（创建半）", () => {
    type PanelWrapper = ReturnType<typeof mountPanel>;

    async function openCreate(wrapper: PanelWrapper): Promise<void> {
        await wrapper.get('[data-testid="instance-agents-create"]').trigger("click");
        await flushPromises();
        // 结构判据先行：弹窗与三段真的挂上了，再谈业务（否则红会落在业务断言上、把人引错文件）。
        expect(wrapper.find('[data-testid="instance-agents-create-dialog"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="instance-agents-form-model"]').exists()).toBe(true);
        expect(wrapper.findAllComponents(Select)).toHaveLength(3);
    }

    async function pick(wrapper: PanelWrapper, index: number, value: string): Promise<void> {
        wrapper.findAllComponents(Select)[index]!.vm.$emit("update:modelValue", value);
        await flushPromises();
    }

    async function submit(wrapper: PanelWrapper): Promise<void> {
        await wrapper.get('[data-testid="instance-agents-form-name"]').setValue("评审助手");
        await wrapper.get('[data-testid="instance-agents-create-submit"]').trigger("click");
        await flushPromises();
    }

    function payload(): Record<string, unknown> {
        const call = vi.mocked(createInstanceAgent).mock.calls[0];
        expect(call).toBeDefined();
        return call![0] as unknown as Record<string, unknown>;
    }

    it("自取权限投影：资源区路由没有别人拉 /me/permissions，不自取就永远缺原子", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        // 判据是「面板自己问了投影」，不是「按钮看起来能点」—— 后者在替身给全原子时恒真。
        expect(authState.ensureSelfPermissions).toHaveBeenCalledTimes(1);
        wrapper.unmount();
    });

    it("选满三段：载荷带 defaultModelProvider/Name，连接不上 wire，未勾选就不带 allowedModels", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await openCreate(wrapper);
        await pick(wrapper, 0, "anthropic");
        await pick(wrapper, 1, "conn-chat");
        await submit(wrapper);

        expect(payload()).toEqual({
            name: "评审助手",
            defaultModelProvider: "anthropic",
            // 目录首个 **chat** 模型（voyage-3 非 chat，不会被自动选上）。
            defaultModelName: "claude-sonnet-4-5",
        });
        wrapper.unmount();
    });

    it("勾「只允许这个模型」：allowedModels 才是白名单（省略 = 不限制）", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await openCreate(wrapper);
        await pick(wrapper, 0, "anthropic");
        await pick(wrapper, 1, "conn-chat");
        wrapper.findComponent(Checkbox).vm.$emit("update:modelValue", true);
        await flushPromises();
        await submit(wrapper);

        expect(payload().allowedModels).toEqual([
            { provider: "anthropic", model: "claude-sonnet-4-5" },
        ]);
        wrapper.unmount();
    });

    it("三段留空：载荷一个模型键都不带（沿用平台默认，不假装选了）", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await openCreate(wrapper);
        await submit(wrapper);

        expect(payload()).toEqual({ name: "评审助手" });
        wrapper.unmount();
    });

    it("半组选择不是合法载荷：提交禁用 + 点名判据；补全后放行", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await openCreate(wrapper);
        await wrapper.get('[data-testid="instance-agents-form-name"]').setValue("评审助手");
        await pick(wrapper, 0, "anthropic");

        const submitButton = wrapper.get('[data-testid="instance-agents-create-submit"]');
        expect(submitButton.attributes("disabled")).toBeDefined();
        expect(wrapper.find('[data-testid="instance-agents-model-incomplete"]').exists()).toBe(
            true,
        );
        expect(vi.mocked(createInstanceAgent)).not.toHaveBeenCalled();

        await pick(wrapper, 1, "conn-chat");
        expect(
            wrapper.get('[data-testid="instance-agents-create-submit"]').attributes("disabled"),
        ).toBeUndefined();
        expect(wrapper.find('[data-testid="instance-agents-model-incomplete"]').exists()).toBe(
            false,
        );
        wrapper.unmount();
    });

    it("级联重置：换提供方丢连接与模型，新提供方只发它自己的模型", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await openCreate(wrapper);
        await pick(wrapper, 0, "anthropic");
        await pick(wrapper, 1, "conn-chat");
        await pick(wrapper, 0, "openai");

        // 换提供方后连接与模型必须清空 ⇒ 此刻是「半组」，提交禁用（不是带着旧模型放行）。
        expect(wrapper.find('[data-testid="instance-agents-model-incomplete"]').exists()).toBe(
            true,
        );
        expect(
            wrapper.get('[data-testid="instance-agents-create-submit"]').attributes("disabled"),
        ).toBeDefined();
        expect(vi.mocked(createInstanceAgent)).not.toHaveBeenCalled();

        await pick(wrapper, 1, "conn-openai-chat");
        await submit(wrapper);
        expect(payload()).toEqual({
            name: "评审助手",
            defaultModelProvider: "openai",
            defaultModelName: "gpt-5.1",
        });
        wrapper.unmount();
    });

    it("模型段在选连接前 disabled，选了才可用（不给出能点却空的下拉）", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await openCreate(wrapper);

        expect(
            wrapper.get('[data-testid="instance-agents-form-model-name"]').attributes("disabled"),
        ).toBeDefined();
        await pick(wrapper, 0, "anthropic");
        await pick(wrapper, 1, "conn-chat");
        expect(
            wrapper.get('[data-testid="instance-agents-form-model-name"]').attributes("disabled"),
        ).toBeUndefined();
        wrapper.unmount();
    });

    it("没有可用 chat 连接：说清出路，且不阻塞「只填名字」的创建", async () => {
        configState.providerConnections = configState.providerConnections.filter(
            (item) => item.operation !== "chat",
        );
        const wrapper = mountPanel();
        await flushPromises();
        await openCreate(wrapper);

        expect(wrapper.find('[data-testid="instance-agents-model-no-connections"]').exists()).toBe(
            true,
        );
        expect(
            wrapper.get('[data-testid="instance-agents-create-submit"]').attributes("disabled"),
        ).toBeDefined();
        await wrapper.get('[data-testid="instance-agents-form-name"]').setValue("评审助手");
        expect(
            wrapper.get('[data-testid="instance-agents-create-submit"]').attributes("disabled"),
        ).toBeUndefined();
        await submit(wrapper);
        expect(payload()).toEqual({ name: "评审助手" });
        wrapper.unmount();
    });

    it("目录/连接加载失败：给提示但不把创建堵死（模型可留空）", async () => {
        configState.modelError = "Failed to fetch models";
        const wrapper = mountPanel();
        await flushPromises();
        await openCreate(wrapper);

        expect(wrapper.find('[data-testid="instance-agents-model-load-failed"]').exists()).toBe(
            true,
        );
        await submit(wrapper);
        expect(payload()).toEqual({ name: "评审助手" });
        wrapper.unmount();
    });
});
