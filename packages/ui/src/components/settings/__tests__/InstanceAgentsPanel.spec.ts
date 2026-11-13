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
    // task-420：写门三态的 SSOT 是投影**读取状态**，不是「原子集合是否为空」。
    // 默认 ready = 已读到（多数用例判已读态的 allowed/denied）。
    selfPermissionsStatus: "ready" as "idle" | "loading" | "ready" | "error",
    ensureSelfPermissions: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({
        ensureSelfPermissions: authState.ensureSelfPermissions,
        isAuthenticated: authState.isAuthenticated,
        hasInstanceAdminCapability: authState.isAdmin,
        selfPermissionsStatus: authState.selfPermissionsStatus,
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
        updateInstanceAgent: vi.fn<typeof actual.updateInstanceAgent>(),
    };
});

import {
    createInstanceAgent,
    listInstanceAgents,
    updateInstanceAgent,
    type InstanceAgent,
} from "../../../services/instanceResources";
/**
 * task-402：技能面是面板的子组件，它自己取数。这里只把两条读面接成空集 ——
 * 面板这组用例钉的是**入口 wiring**（按钮 / 写门三态 / 传参），技能面自己的判据在
 * `components/resources/__tests__/InstanceAgentSkillsDialog.spec.ts`，不在这儿重复钉。
 */
const skillReads = vi.hoisted(() => ({
    getAgentSkills: vi.fn<() => Promise<unknown[]>>(),
    getSkills: vi.fn<() => Promise<unknown[]>>(),
}));

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../composables/api")>();
    return { ...actual, api: { ...actual.api, ...skillReads } };
});

import { ApiError } from "../../../composables/api";
import { listProviderCatalog } from "../../../services/providerConnectionService";
import { Select } from "../../ui/select";
import { Checkbox } from "../../ui/checkbox";
import { i18n } from "../../../i18n";
import SettingsLayerHeader from "../SettingsLayerHeader.vue";
import InstanceAgentsPanel from "../InstanceAgentsPanel.vue";
import InstanceAgentSkillsDialog from "../../resources/InstanceAgentSkillsDialog.vue";

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
    authState.selfPermissionsStatus = "ready";
    authState.ensureSelfPermissions.mockResolvedValue(true);
    mockedList.mockResolvedValue({ agents: [], count: 0 });
    skillReads.getAgentSkills.mockResolvedValue([]);
    skillReads.getSkills.mockResolvedValue([]);
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
    vi.mocked(updateInstanceAgent).mockResolvedValue({
        principalId: "agent-1",
        defaultModelProvider: "anthropic",
        defaultModelName: "claude-sonnet-4-5",
        allowedModels: null,
    });
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
        expect(notice.attributes("data-gate-state")).toBe("denied");

        wrapper.unmount();
    });

    /**
     * task-420（D-1254）三态回归：投影**未判定**（加载中 / 读取失败）不得渲染成「缺原子」。
     * 真栈因果探针（delay / abort）证实二态实现会让真管理员看到确定性拒绝，失败态还永久禁用。
     * 这三条与上面那条 denied 一起，钉住「禁用+报原子」只是**四态之一**，不是唯一正常态。
     */
    it("投影加载中：禁用但说「正在读取权限」，不点名原子", async () => {
        authState.selfPermissionsStatus = "loading";
        const wrapper = mountPanel();
        await flushPromises();

        const create = wrapper.find('[data-testid="instance-agents-create"]');
        expect(create.attributes("disabled")).toBeDefined();
        const notice = wrapper.find('[data-testid="instance-agents-write-disabled"]');
        expect(notice.exists()).toBe(true);
        expect(notice.attributes("data-gate-state")).toBe("loading");
        expect(notice.text()).not.toContain("MANAGE_AGENT_PRINCIPALS");
        expect(notice.text()).toContain("正在读取权限");
        expect(wrapper.find('[data-testid="instance-agents-write-gate-retry"]').exists()).toBe(
            false,
        );

        wrapper.unmount();
    });

    it("投影读取失败：禁用 + 说读取失败 + 给重试出口，点重试真的再取一次", async () => {
        authState.selfPermissionsStatus = "error";
        const wrapper = mountPanel();
        await flushPromises();

        const notice = wrapper.find('[data-testid="instance-agents-write-disabled"]');
        expect(notice.attributes("data-gate-state")).toBe("error");
        expect(notice.text()).not.toContain("MANAGE_AGENT_PRINCIPALS");
        expect(notice.text()).toContain("权限读取失败");
        const before = authState.ensureSelfPermissions.mock.calls.length;
        const retry = wrapper.find('[data-testid="instance-agents-write-gate-retry"]');
        expect(retry.exists()).toBe(true);
        await retry.trigger("click");
        await flushPromises();
        expect(authState.ensureSelfPermissions.mock.calls.length).toBe(before + 1);

        wrapper.unmount();
    });

    it("投影已读且含原子：可写，且不再渲染任何禁用理由", async () => {
        const wrapper = mountPanel();
        await flushPromises();

        expect(
            wrapper.find('[data-testid="instance-agents-create"]').attributes("disabled"),
        ).toBeUndefined();
        expect(wrapper.find('[data-testid="instance-agents-write-disabled"]').exists()).toBe(false);

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

describe("InstanceAgentsPanel · task-401 模型意图（编辑半，cp-1 task-413 契约）", () => {
    type PanelWrapper = ReturnType<typeof mountPanel>;

    /** 存量意图恰好落在可见 chat 连接的目录里 ⇒ 三段可预填。 */
    function storedAgent(): InstanceAgent {
        return {
            ...agent("agent-1", "代码评审助手"),
            modelProvider: "anthropic",
            modelName: "claude-sonnet-4-5",
        };
    }

    async function openEdit(wrapper: PanelWrapper): Promise<void> {
        await wrapper.get('[data-testid="instance-agent-edit-agent-1"]').trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="instance-agents-edit-dialog"]').exists()).toBe(true);
        expect(wrapper.findAllComponents(Select)).toHaveLength(3);
    }

    async function pickEdit(wrapper: PanelWrapper, index: number, value: string): Promise<void> {
        wrapper.findAllComponents(Select)[index]!.vm.$emit("update:modelValue", value);
        await flushPromises();
    }

    function patchPayload(): Record<string, unknown> {
        const call = vi.mocked(updateInstanceAgent).mock.calls[0];
        expect(call).toBeDefined();
        return call![1] as unknown as Record<string, unknown>;
    }

    it("行有编辑入口，点开显示存量意图；预填后原样保存视为无改动（不白写一次）", async () => {
        mockedList.mockResolvedValue({ agents: [storedAgent()], count: 1 });
        const wrapper = mountPanel();
        await flushPromises();
        await openEdit(wrapper);

        expect(wrapper.get('[data-testid="instance-agents-edit-current"]').text()).toBe(
            "anthropic / claude-sonnet-4-5",
        );
        // 预填真的发生了：连接段拿到了存量模型所属的那条连接。
        const connection = wrapper.findAllComponents(Select)[1]!;
        expect(connection.props("modelValue")).toBe("conn-chat");
        expect(wrapper.find('[data-testid="instance-agents-edit-nochange"]').exists()).toBe(true);
        expect(
            wrapper.get('[data-testid="instance-agents-edit-submit"]').attributes("disabled"),
        ).toBeDefined();
        expect(updateInstanceAgent).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it("换模型：PATCH 只带模型三键（名称/说明不在这个写面上），未勾白名单 ⇒ 显式 null 清旧白名单", async () => {
        mockedList.mockResolvedValue({ agents: [storedAgent()], count: 1 });
        const wrapper = mountPanel();
        await flushPromises();
        await openEdit(wrapper);
        await pickEdit(wrapper, 2, "claude-haiku-4-5");
        await wrapper.get('[data-testid="instance-agents-edit-submit"]').trigger("click");
        await flushPromises();

        expect(vi.mocked(updateInstanceAgent).mock.calls[0]![0]).toBe("agent-1");
        expect(patchPayload()).toEqual({
            defaultModelProvider: "anthropic",
            defaultModelName: "claude-haiku-4-5",
            allowedModels: null,
        });
        wrapper.unmount();
    });

    it("勾「只允许这个模型」：白名单写成新模型；模型没变也算改动（存量白名单不在列表投影里）", async () => {
        mockedList.mockResolvedValue({ agents: [storedAgent()], count: 1 });
        const wrapper = mountPanel();
        await flushPromises();
        await openEdit(wrapper);
        // 编辑弹窗里有两个 Checkbox：三段里的「只允许这个模型」在前，面板的「清除」在后。
        // （vendored Checkbox 的 attrs 不落在组件 wrapper 的 attributes() 上 ⇒ 按 testid 认领会落空，
        //   这里按渲染顺序取，并由下面的载荷断言兜住「取错了」这种情况。）
        const boxes = wrapper.findAllComponents(Checkbox);
        expect(boxes).toHaveLength(2);
        boxes[0]!.vm.$emit("update:modelValue", true);
        await flushPromises();
        await wrapper.get('[data-testid="instance-agents-edit-submit"]').trigger("click");
        await flushPromises();

        expect(patchPayload()).toEqual({
            defaultModelProvider: "anthropic",
            defaultModelName: "claude-sonnet-4-5",
            allowedModels: [{ provider: "anthropic", model: "claude-sonnet-4-5" }],
        });
        wrapper.unmount();
    });

    it("勾清除：三键全 null（契约 both-or-neither），三段随之禁用", async () => {
        mockedList.mockResolvedValue({ agents: [storedAgent()], count: 1 });
        const wrapper = mountPanel();
        await flushPromises();
        await openEdit(wrapper);
        await wrapper.get('[data-testid="instance-agents-edit-clear"]').trigger("click");
        await flushPromises();

        expect(wrapper.findAllComponents(Select)[0]!.props("disabled")).toBe(true);
        await wrapper.get('[data-testid="instance-agents-edit-submit"]').trigger("click");
        await flushPromises();

        expect(patchPayload()).toEqual({
            defaultModelProvider: null,
            defaultModelName: null,
            allowedModels: null,
        });
        wrapper.unmount();
    });

    it("存量意图映射不到可见连接：不猜一条连接塞给用户（当前意图照显示，可重选或清除）", async () => {
        mockedList.mockResolvedValue({
            agents: [{ ...storedAgent(), modelProvider: "mistral", modelName: "mistral-large" }],
            count: 1,
        });
        const wrapper = mountPanel();
        await flushPromises();
        await openEdit(wrapper);

        expect(wrapper.get('[data-testid="instance-agents-edit-current"]').text()).toBe(
            "mistral / mistral-large",
        );
        expect(wrapper.findAllComponents(Select)[0]!.props("modelValue")).toBe("");
        expect(wrapper.findAllComponents(Select)[1]!.props("modelValue")).toBe("");
        expect(wrapper.find('[data-testid="instance-agents-edit-nochange"]').exists()).toBe(true);
        expect(updateInstanceAgent).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it("系统预置 403 GUARD_MODEL_INTENT_IMMUTABLE：本地化点名，不直显 CP 英文 detail，弹窗保窗", async () => {
        mockedList.mockResolvedValue({ agents: [storedAgent()], count: 1 });
        vi.mocked(updateInstanceAgent).mockRejectedValue(
            new ApiError({
                code: "GUARD_MODEL_INTENT_IMMUTABLE",
                detail: "system preset model intent is immutable",
                status: 403,
            }),
        );
        const wrapper = mountPanel();
        await flushPromises();
        await openEdit(wrapper);
        await pickEdit(wrapper, 2, "claude-haiku-4-5");
        await wrapper.get('[data-testid="instance-agents-edit-submit"]').trigger("click");
        await flushPromises();

        const shown = wrapper.get('[data-testid="instance-agents-edit-error"]').text();
        expect(shown).toBe("系统预置智能体的模型意图不可修改。");
        expect(shown).not.toContain("immutable");
        // 保窗：用户能看到失败原因并改选，而不是弹窗关掉只剩一个 toast。
        expect(wrapper.find('[data-testid="instance-agents-edit-dialog"]').exists()).toBe(true);
        wrapper.unmount();
    });

    it("缺动作原子：编辑入口 disabled 不隐藏（与删除同口径，D-1136 不给死路）", async () => {
        authState.atoms = new Set<string>();
        mockedList.mockResolvedValue({ agents: [storedAgent()], count: 1 });
        const wrapper = mountPanel();
        await flushPromises();

        const edit = wrapper.get('[data-testid="instance-agent-edit-agent-1"]');
        expect(edit.attributes("disabled")).toBeDefined();
        expect(edit.attributes("title")).toContain("MANAGE_AGENT_PRINCIPALS");
        wrapper.unmount();
    });
});

describe("InstanceAgentsPanel · task-402 技能面入口（D-1243 G2）", () => {
    it("行有技能入口，点开把**那一行**的 principal 交给技能面", async () => {
        mockedList.mockResolvedValue({
            agents: [agent("agent-1", "代码评审助手"), agent("agent-2", "发布助手")],
            count: 2,
        });
        const wrapper = mountPanel();
        await flushPromises();

        const dialog = wrapper.findComponent(InstanceAgentSkillsDialog);
        expect(dialog.exists()).toBe(true);
        expect(dialog.props("open")).toBe(false);
        expect(dialog.props("principal")).toBeNull();

        await wrapper.get('[data-testid="instance-agent-skills-agent-2"]').trigger("click");
        await flushPromises();
        expect(dialog.props("open")).toBe(true);
        expect(dialog.props("principal")).toEqual({ id: "agent-2", name: "发布助手" });
        wrapper.unmount();
    });

    it("缺动作原子：技能入口 disabled 不隐藏，理由点名原子（与删除同口径，D-1136）", async () => {
        authState.atoms = new Set();
        mockedList.mockResolvedValue({ agents: [agent("agent-1", "代码评审助手")], count: 1 });
        const wrapper = mountPanel();
        await flushPromises();
        const button = wrapper.get('[data-testid="instance-agent-skills-agent-1"]');
        expect(button.attributes("disabled")).toBeDefined();
        expect(button.attributes("title")).toContain("MANAGE_AGENT_PRINCIPALS");
        wrapper.unmount();
    });

    it("投影加载中：技能入口说「正在读取权限」，不冒充缺原子（D-1254 三态，不另写二态）", async () => {
        authState.selfPermissionsStatus = "loading";
        mockedList.mockResolvedValue({ agents: [agent("agent-1", "代码评审助手")], count: 1 });
        const wrapper = mountPanel();
        await flushPromises();
        const button = wrapper.get('[data-testid="instance-agent-skills-agent-1"]');
        expect(button.attributes("disabled")).toBeDefined();
        expect(button.attributes("title")).toContain("正在读取权限");
        expect(button.attributes("title")).not.toContain("MANAGE_AGENT_PRINCIPALS");
        wrapper.unmount();
    });

    it("关闭技能面 ⇒ 目标清空（下次打开不会带着上一行的 principal）", async () => {
        mockedList.mockResolvedValue({ agents: [agent("agent-1", "代码评审助手")], count: 1 });
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.get('[data-testid="instance-agent-skills-agent-1"]').trigger("click");
        await flushPromises();
        const dialog = wrapper.findComponent(InstanceAgentSkillsDialog);
        dialog.vm.$emit("update:open", false);
        await flushPromises();
        expect(dialog.props("open")).toBe(false);
        expect(dialog.props("principal")).toBeNull();
        wrapper.unmount();
    });
});

/**
 * task-430：创建面**照契约收紧**（真 HTTP 照出的两笔，stack-1 2026-11-14 02:35）。
 * ① 契约 `AgentPrincipalCreateRequest` 没有 description ⇒ 撤框 + 载荷不带该键；
 * ② 名字格式 `^[A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff]*$` ⇒ 常驻提示 + 就地拦 +
 *    服务端 `INVALID_NAME_FORMAT` 本地化（不直显通用「操作失败」）。
 */
describe("InstanceAgentsPanel · task-430 创建面契约收紧", () => {
    async function openCreate(wrapper: ReturnType<typeof mountPanel>): Promise<void> {
        await wrapper.get('[data-testid="instance-agents-create"]').trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="instance-agents-create-dialog"]').exists()).toBe(true);
    }

    it("不再有「说明」框，载荷一个 description 键都不带（多带即真栈 400）", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await openCreate(wrapper);
        expect(wrapper.find('[data-testid="instance-agents-form-description"]').exists()).toBe(
            false,
        );
        await wrapper.get('[data-testid="instance-agents-form-name"]').setValue("评审助手");
        await wrapper.get('[data-testid="instance-agents-create-submit"]').trigger("click");
        await flushPromises();
        const call = vi.mocked(createInstanceAgent).mock.calls[0];
        expect(call).toBeDefined();
        expect(Object.keys(call![0] as unknown as Record<string, unknown>)).toEqual(["name"]);
        wrapper.unmount();
    });

    it("名字不合契约（连字符 / 空格 / 数字开头）：提交禁用 + 提示就地变红点名格式", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await openCreate(wrapper);
        const hint = wrapper.get('[data-testid="instance-agents-form-name-hint"]');
        expect(hint.classes()).toContain("text-muted-foreground");

        for (const bad of ["task-402-probe", "评审 助手", "1号助手"]) {
            await wrapper.get('[data-testid="instance-agents-form-name"]').setValue(bad);
            await flushPromises();
            expect(
                wrapper.get('[data-testid="instance-agents-create-submit"]').attributes("disabled"),
                bad,
            ).toBeDefined();
            expect(
                wrapper.get('[data-testid="instance-agents-form-name-hint"]').classes(),
                bad,
            ).toContain("text-destructive");
            expect(
                wrapper.get('[data-testid="instance-agents-form-name-hint"]').text(),
                bad,
            ).toContain("不能以数字开头");
        }
        expect(vi.mocked(createInstanceAgent)).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it("合法名字（汉字 / 字母数字）：提示保持中性，提交可用且真发得出去", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await openCreate(wrapper);
        for (const good of ["评审助手", "Reviewer2"]) {
            await wrapper.get('[data-testid="instance-agents-form-name"]').setValue(good);
            await flushPromises();
            expect(
                wrapper.get('[data-testid="instance-agents-create-submit"]').attributes("disabled"),
                good,
            ).toBeUndefined();
            expect(
                wrapper.get('[data-testid="instance-agents-form-name-hint"]').classes(),
                good,
            ).toContain("text-muted-foreground");
        }
        await wrapper.get('[data-testid="instance-agents-create-submit"]').trigger("click");
        await flushPromises();
        expect(vi.mocked(createInstanceAgent)).toHaveBeenCalledTimes(1);
        wrapper.unmount();
    });

    it("空名字只算必填不算格式错（两条判据不互相冒充）", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await openCreate(wrapper);
        expect(
            wrapper.get('[data-testid="instance-agents-create-submit"]').attributes("disabled"),
        ).toBeDefined();
        expect(wrapper.get('[data-testid="instance-agents-form-name-hint"]').classes()).toContain(
            "text-muted-foreground",
        );
        wrapper.unmount();
    });

    it("服务端 400 INVALID_NAME_FORMAT：本地化点名格式，不直显通用失败，弹窗保窗", async () => {
        vi.mocked(createInstanceAgent).mockRejectedValue(
            new ApiError({ code: "INVALID_NAME_FORMAT", detail: "name format", status: 400 }),
        );
        const wrapper = mountPanel();
        await flushPromises();
        await openCreate(wrapper);
        await wrapper.get('[data-testid="instance-agents-form-name"]').setValue("评审助手");
        await wrapper.get('[data-testid="instance-agents-create-submit"]').trigger("click");
        await flushPromises();
        const error = wrapper.get('[data-testid="instance-agents-action-error"]');
        expect(error.text()).toContain("名字格式不合契约");
        expect(error.text()).not.toContain("name format");
        expect(wrapper.find('[data-testid="instance-agents-create-dialog"]').exists()).toBe(true);
        wrapper.unmount();
    });
});
