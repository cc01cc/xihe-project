import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { ref } from "vue";

/**
 * PLAN-0752 M1 的域页三分支（verify.md「入口分层」）与 V26 拦截：
 *
 * - 矩阵里没有的组合（user + logging）⇒ 404 视图，且**不挂载**面板；
 * - 层存在但无 cap:instance:admin ⇒ 403 视图，且**不发**配置请求（V4）；
 * - 实例独占域给「切到用户层」入口，点击只出提示、不跳转（V26）。
 */
const state = {
    capability: true,
    /** PLAN-0766 T3.3：workspace-default 的写权限门（能力原子，不是角色名）。 */
    atom: true,
    /** task-112/121：pending 的经济判据是「该层是否已有载荷」，故 layerConfig 必须可变。 */
    layerConfig: ref<Record<string, Record<string, Record<string, string>>>>({
        instance: { logging: { level: "INFO" } },
        user: { rag: { k: "v" } },
    }),
    /** 全局瞬时标志：task-121 起 pending **不得**跟随它（否则面板挂载/卸载循环）。 */
    layerLoading: ref(false),
    loadLayerDomains: vi.fn<(layer: string) => Promise<void>>(() => Promise.resolve()),
    routeQuery: {} as Record<string, string | undefined>,
    replace: vi.fn<(arg: { query: Record<string, unknown> }) => Promise<void>>(() =>
        Promise.resolve(),
    ),
};

// 域页要读 ?tab=（approval-policy 的域内页签，T3.3）⇒ 组件测试需要 router 的两个入口。
vi.mock("vue-router", () => ({
    useRoute: () => ({ query: state.routeQuery }),
    useRouter: () => ({ replace: state.replace }),
}));

vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({
        get hasInstanceAdminCapability() {
            return state.capability;
        },
        hasInstanceAtom: () => state.atom,
        ensureSelfPermissions: () => Promise.resolve(true),
    }),
}));

vi.mock("../../../stores/config", async () => {
    const actual =
        await vi.importActual<typeof import("../../../stores/config")>("../../../stores/config");
    return {
        ...actual,
        useConfigStore: () => ({
            get layerConfig() {
                return state.layerConfig.value;
            },
            loadLayerDomains: state.loadLayerDomains,
            get layerLoading() {
                return state.layerLoading.value;
            },
        }),
    };
});

import SettingsDomainView from "../SettingsDomainView.vue";

const messages = {
    "zh-CN": {
        settings: {
            domainLogging: "日志",
            domainRag: "检索增强（RAG）",
            // D-1122 / T2.4：workspace-default 层的承载域改为 agent-runtime（模型域已退出该层）。
            domainAgentRuntime: "智能体运行时",
            domainAgentRuntimeHint: "控制智能体运行时的轮次/预算",
            domainApprovalPolicy: "审批策略",
            saveFailed: "保存失败",
            ia: {
                domainKeysCount: "本域 {count} 个配置键",
                domainEditableCount: "可编辑 {count} 项",
                switchToUserLayer: "切到用户层",
                layerOnlyInstance: "该域仅在实例层可配置",
                layerOnlyInstanceDetail: "{domain} 不在用户层的可写域清单里",
                dismiss: "知道了",
                approvalTabPolicy: "审批策略",
                navToolFaces: "工具分类",
                forbiddenTitle: "这一层需要实例管理员能力",
                layerInstance: "实例配置",
                layerWorkspaceDefault: "工作区默认",
                layerUser: "用户配置",
                wsDefaultReadonlyTitle: "只读",
                wsDefaultReadonlyDetail: "缺少 MANAGE_WORKSPACE_DEFAULT_CONFIG",
                fourLayerOrderLabel: "生效顺序",
                fourLayerLowToHigh: "（低 → 高）",
                fourLayerWorkspace: "工作区",
                fourLayerWorkspaceDefault: "工作区默认",
                fourLayerUser: "个人",
                fourLayerInstance: "实例",
                fourLayerDetail: "工作区 → 工作区默认 → 个人 → 实例",
                forbiddenBody: "不加载配置",
                backToUserLayer: "去用户层",
                // task-509（E-03）：取数失败必须有独立文案 + 重试，不许借用 saveFailed。
                domainLoadFailed: "配置加载失败",
                notFoundTitle: "这个页面不存在",
                notFoundBody: "该层没有这个配置域",
                backToDefault: "回到默认页",
            },
            errorSurface: { retry: "重试" },
        },
        common: { loading: "加载中…" },
    },
};

function mountView(
    layer: "instance" | "workspace-default" | "user",
    domain: string,
    stubs: { panels?: unknown } = {},
    // task-510：键盘/焦点类判据要求节点真的在 document 里（不在就不会被聚焦），
    // 只有这类用例才 attachTo —— 其余用例保持不挂到 body，避免相互污染。
    options: { attach?: boolean } = {},
) {
    const i18n = createI18n({ legacy: false, locale: "zh-CN", messages });
    return mount(SettingsDomainView, {
        ...(options.attach ? { attachTo: document.body } : {}),
        props: { layer, domain },
        global: {
            plugins: [i18n],
            stubs: {
                ConfigLayerPanels: stubs.panels ?? {
                    name: "ConfigLayerPanels",
                    emits: ["editable-count"],
                    template: '<div data-testid="panels-stub" />',
                },
                ToolFacesView: { template: '<div data-testid="tool-faces-stub" />' },
                RouterLink: { template: "<a><slot /></a>" },
            },
        },
    });
}

describe("SettingsDomainView", () => {
    beforeEach(() => {
        state.capability = true;
        state.routeQuery = {};
        state.layerLoading.value = false;
        state.layerConfig.value = {
            instance: { logging: { level: "INFO" } },
            user: { rag: { k: "v" } },
        };
        state.loadLayerDomains.mockClear();
        state.loadLayerDomains.mockImplementation(() => Promise.resolve());
        state.replace.mockClear();
    });

    // ---- T3.3：工具分类并入 approval-policy 域页签（design 决策 #7 / D2） ----
    it("offers the domain-internal tabs only on instance/approval-policy", async () => {
        const plain = mountView("instance", "rag");
        await flushPromises();
        expect(plain.find('[data-testid="settings-domain-tabs"]').exists()).toBe(false);

        const approval = mountView("instance", "approval-policy");
        await flushPromises();
        expect(approval.find('[data-testid="settings-domain-tabs"]').exists()).toBe(true);
        expect(approval.find('[data-testid="settings-domain-tab-policy"]').exists()).toBe(true);
        expect(approval.find('[data-testid="settings-domain-tab-tool-faces"]').exists()).toBe(true);
        // 默认落在策略页签：面板在、工具分类面不在
        expect(approval.find('[data-testid="panels-stub"]').exists()).toBe(true);
        expect(approval.find('[data-testid="tool-faces-stub"]').exists()).toBe(false);
    });

    it("switches to the tool-faces view and mirrors it into ?tab=", async () => {
        const wrapper = mountView("instance", "approval-policy");
        await flushPromises();
        // task-510：换 vendor `ui/tabs` 后激活发生在 **mousedown**（reka TabsTrigger 的
        // `onMousedown`，见 node_modules/reka-ui/dist/Tabs/TabsTrigger.js 的 `changeModelValue`）；
        // 真实浏览器里 mousedown → click 连着来，这里按真实序列发，不是把判据放宽。
        const trigger = wrapper.find('[data-testid="settings-domain-tab-tool-faces"]');
        await trigger.trigger("mousedown");
        await trigger.trigger("click");
        expect(wrapper.find('[data-testid="tool-faces-stub"]').exists()).toBe(true);
        // task-121：面板常挂（v-show），切到工具分类只是隐藏。
        expect(wrapper.find('[data-testid="panels-stub"]').isVisible()).toBe(false);
        expect(state.replace).toHaveBeenCalledWith({ query: { tab: "tool-faces" } });
    });

    it("opens the tool-faces tab directly when the URL carries ?tab=tool-faces (old bookmark)", async () => {
        state.routeQuery = { tab: "tool-faces" };
        const wrapper = mountView("instance", "approval-policy");
        await flushPromises();
        expect(wrapper.find('[data-testid="tool-faces-stub"]').exists()).toBe(true);
    });

    it("renders the domain panel for a valid combination", async () => {
        const wrapper = mountView("user", "rag");
        await flushPromises();
        expect(wrapper.find('[data-testid="settings-domain-view"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-domain-title"]').text()).toBe(
            "检索增强（RAG）",
        );
        expect(wrapper.find('[data-testid="panels-stub"]').exists()).toBe(true);
        expect(state.loadLayerDomains).toHaveBeenCalledWith("user");
    });

    it("renders 404 for a combination the matrix does not have (user + logging)", async () => {
        const wrapper = mountView("user", "logging");
        await flushPromises();
        expect(wrapper.find('[data-testid="settings-not-found"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="panels-stub"]').exists()).toBe(false);
        expect(state.loadLayerDomains).not.toHaveBeenCalled();
    });

    it("renders 403 and loads nothing without the instance-admin capability (V4)", async () => {
        state.capability = false;
        const wrapper = mountView("instance", "logging");
        await flushPromises();
        expect(wrapper.find('[data-testid="settings-forbidden"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="panels-stub"]').exists()).toBe(false);
        expect(state.loadLayerDomains).not.toHaveBeenCalled();
    });

    it("blocks the cross-layer switch instead of navigating (V26)", async () => {
        const wrapper = mountView("instance", "logging");
        await flushPromises();
        const button = wrapper.find('[data-testid="settings-switch-layer"]');
        expect(button.exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-layer-block-notice"]').exists()).toBe(false);
        await button.trigger("click");
        const notice = wrapper.find('[data-testid="settings-layer-block-notice"]');
        expect(notice.exists()).toBe(true);
        expect(notice.text()).toContain("该域仅在实例层可配置");
    });

    it("offers no cross-layer switch for a domain the user layer can write", async () => {
        const wrapper = mountView("instance", "rag");
        await flushPromises();
        expect(wrapper.find('[data-testid="settings-switch-layer"]').exists()).toBe(false);
    });
});

/**
 * task-112 / task-121：pending（还没回来）**不是**空（本域 0 项），但判据必须**单调**：
 * 首次加载期间显示 loading 面；该层一旦落定，**后续 reload 不得退回卸载态** —— 否则
 * `ProviderHub.load()`（旧 `:763`）在 mount 时也调 `loadLayerDomains` ⇒「面板挂载 → 全局
 * `layerLoading` 置真 → pending 真 → 面板卸载 → 取数结束 → 重挂」自持循环（dev-3 实测 63 轮/秒、
 * 5.357 s 内 672 次 `/provider-catalog`）。四条用例：
 * ① 首次待载 ⇒ loading 面、无「0 项配置」、无面板；
 * ② 落定 ⇒ summary + 面板；
 * ③ 落定后再发生 reload（全局 `layerLoading` 翻转）⇒ 面板**保持挂载**、loading 面**不出现**（循环回归）；
 * ④ 面板桩在 mount 时回写 `loadLayerDomains`（复刻旧 ProviderHub 行为）⇒ 挂载次数与取数次数有界。
 */
describe("SettingsDomainView pending state (task-112/121)", () => {
    beforeEach(() => {
        state.capability = true;
        state.routeQuery = {};
        state.layerLoading.value = false;
        state.layerConfig.value = { instance: {}, user: {} };
        state.loadLayerDomains.mockClear();
        state.loadLayerDomains.mockImplementation(() => Promise.resolve());
    });

    it("shows the loading surface instead of 「0 项配置」 before the layer has any payload", async () => {
        state.layerLoading.value = true;
        const wrapper = mountView("instance", "logging");
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-domain-loading"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-domain-summary"]').exists()).toBe(false);
        // task-121：面板**不卸载**（v-show 隐藏），只在视觉上让位给加载面 —— 卸载会诱发 mount 循环。
        expect(wrapper.find('[data-testid="panels-stub"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="panels-stub"]').isVisible()).toBe(false);
        expect(wrapper.text()).not.toContain("本域 0 个配置键");
    });

    it("renders the summary and the panel once the layer resolves", async () => {
        const wrapper = mountView("instance", "logging");
        await flushPromises();
        expect(wrapper.find('[data-testid="settings-domain-loading"]').exists()).toBe(true);

        state.layerConfig.value = { instance: { logging: { level: "INFO" } }, user: {} };
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-domain-loading"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="settings-domain-summary"]').text()).toContain(
            "本域 1 个配置键",
        );
        expect(wrapper.find('[data-testid="panels-stub"]').isVisible()).toBe(true);
    });

    // 循环回归：旧实现 `pending = layerLoading` 会让这里重新出现 loading 面并卸载面板。
    it("承接面板上报的可编辑字段数（M>0 只出标题右侧徽标，主文案是键数）", async () => {
        state.layerConfig.value = {
            instance: { logging: { level: "INFO", levelAgent: "INFO" } },
            user: {},
        };
        const wrapper = mountView("instance", "logging");
        await flushPromises();

        // 默认桩不上报 ⇒ 只显示主文案（键数 2），徽标不出现。
        expect(wrapper.find('[data-testid="settings-domain-summary"]').text()).toContain(
            "本域 2 个配置键",
        );
        expect(wrapper.find('[data-testid="settings-domain-editable-count"]').exists()).toBe(false);

        // 面板上报 2 个可编辑字段 ⇒ 标题右侧徽标出现（task-78：整句降级为极小数徽标）。
        wrapper.findComponent({ name: "ConfigLayerPanels" }).vm.$emit("editable-count", 2);
        await wrapper.vm.$nextTick();
        const editable = wrapper.find('[data-testid="settings-domain-editable-count"]');
        expect(editable.exists()).toBe(true);
        expect(editable.text()).toBe("可编辑 2 项");
        // 量纲判据（task-78）：不再是整句，也不再和「键数」混成一句话。
        expect(editable.text()).not.toContain("当前页");
        // 位置判据：徽标紧跟在域标题之后（标题右侧），不在右侧工具组里。
        expect(
            wrapper.find('[data-testid="settings-domain-title"]').element.nextElementSibling,
        ).toBe(editable.element);
        wrapper.unmount();
    });

    it("keeps the panel tree mounted when a reload flips the global loading flag", async () => {
        state.layerConfig.value = { instance: { logging: { level: "INFO" } }, user: {} };
        const wrapper = mountView("instance", "logging");
        await flushPromises();
        expect(wrapper.find('[data-testid="panels-stub"]').exists()).toBe(true);

        state.layerLoading.value = true;
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-domain-loading"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="panels-stub"]').isVisible()).toBe(true);
        expect(wrapper.find('[data-testid="settings-domain-summary"]').text()).toContain(
            "本域 1 个配置键",
        );
    });
    // 循环回归（dev-3 trace）：子组件在挂载/重载时回写全局 `layerLoading`。判据是**面板子树不被重建** ——
    // 卸载/重挂正是「挂载 ⇒ 取数 ⇒ pending ⇒ 卸载 ⇒ 重挂」自持循环的载体。
    it("keeps the same panel subtree identity across reloads (no unmount ⇒ no re-mount loop)", async () => {
        state.layerConfig.value = { instance: { logging: { level: "INFO" } }, user: {} };
        const wrapper = mountView("instance", "logging");
        await flushPromises();

        const stub = wrapper.find('[data-testid="panels-stub"]');
        expect(stub.exists()).toBe(true);
        expect(stub.isVisible()).toBe(true);
        const node = stub.element;

        // 复刻 6 次「子组件回写 `layerLoading`」的 reload：面板必须原地不动（同一 DOM 节点）。
        for (let round = 0; round < 6; round++) {
            state.layerLoading.value = true;
            await flushPromises();
            expect(wrapper.find('[data-testid="settings-domain-loading"]').exists()).toBe(false);
            state.layerLoading.value = false;
            await flushPromises();
        }

        expect(wrapper.find('[data-testid="panels-stub"]').element).toBe(node);
        // 页面自身只取一次数；子组件不得因重挂而重复取数。
        expect(state.loadLayerDomains).toHaveBeenCalledTimes(1);
    });
});

// ---- PLAN-0766（task-160）：共享 workspace-default 层的页面行为 ----
describe("SettingsDomainView workspace-default layer", () => {
    beforeEach(() => {
        state.capability = true;
        state.atom = true;
        state.routeQuery = {};
        state.layerLoading.value = false;
        state.layerConfig.value = {
            instance: { rag: { chunkSize: "512" } },
            "workspace-default": { "agent-runtime": { instructions: "x" } },
            user: {},
        };
        state.loadLayerDomains.mockClear();
        state.loadLayerDomains.mockImplementation(() => Promise.resolve());
    });

    it("renders the workspace-default domain page with four-layer precedence badges", async () => {
        // D-1122 / T2.4：rag 已退出该层（矩阵里没有 ⇒ 路由不注册）⇒ 这里改用仍在矩阵里的
        // agent-runtime 作为承载页；「rag 在该层 404」由 settingsIa.spec 的 route 断言负责。
        const wrapper = mountView("workspace-default", "agent-runtime");
        await flushPromises();
        expect(wrapper.find('[data-testid="settings-domain-view"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-domain-title"]').text()).toContain(
            "智能体运行时",
        );
        const badges = wrapper.findAll('[data-testid^="layer-badge-"]');
        expect(badges.map((badge) => badge.text())).toEqual([
            "工作区",
            "工作区默认",
            "个人",
            "实例",
        ]);
        expect(
            wrapper.get('[data-testid="layer-badge-workspace-default"]').attributes("data-active"),
        ).toBe("true");
        // task-31：只读信息条已改名，不再复用小写的 no-atom 锚点（两者语义相反）。
        expect(wrapper.find('[data-testid="settings-ws-default-readonly-notice"]').exists()).toBe(
            false,
        );
        // 旧 id 属 `SettingsPermissionGate` 的「本页没有权限原子」语义，本视图任何时候都不该出现。
        expect(wrapper.find('[data-testid="settings-no-atom-notice"]').exists()).toBe(false);
        expect(state.loadLayerDomains).toHaveBeenCalledWith("workspace-default");
    });

    it("fails open to read-only (not 403) when the atom is missing", async () => {
        state.atom = false;
        const wrapper = mountView("workspace-default", "agent-runtime");
        await flushPromises();
        // 页面照常取数（CP 允许任何已认证用户读该层），只是控件只读 + 信息条说明。
        expect(wrapper.find('[data-testid="settings-domain-view"]').exists()).toBe(true);
        const notice = wrapper.get('[data-testid="settings-ws-default-readonly-notice"]');
        expect(notice.text()).toContain("MANAGE_WORKSPACE_DEFAULT_CONFIG");
        // 语义相反（原子存在、只是未持有）⇒ 不得命中 Gate 的 no-atom 锚点。
        expect(wrapper.find('[data-testid="settings-no-atom-notice"]').exists()).toBe(false);
        // 无 prop 声明的 stub 把 attrs 透传到根元素；布尔属性存在即为 ""（不是 "true"）。
        expect(wrapper.find('[data-testid="panels-stub"]').attributes("readonly")).toBeDefined();
        expect(state.loadLayerDomains).toHaveBeenCalledWith("workspace-default");
    });
});

/**
 * task-509（E-03）：**取数失败 ≠ 保存失败**。
 *
 * <p>修前这一处复用 `settings.saveFailed`（「保存失败，请重试」）：用户打开页面、读配置失败，
 * 屏幕上说的是「保存失败」 ⇒ 用户会以为**自己的修改丢了**，于是重复保存、或报「数据被覆盖」，
 * 而实际连一个 PUT 都没发生。两种失败指向**不同的用户动作**（重试读取 / 检查我的编辑），
 * 文案不许互相借用 —— 这是判据本身，不是措辞偏好。</p>
 */
describe("SettingsDomainView 取数失败态（task-509 E-03）", () => {
    beforeEach(() => {
        state.capability = true;
        state.routeQuery = {};
        state.layerConfig.value = {};
        state.layerLoading.value = false;
        state.replace.mockClear();
    });

    it("给「加载失败」文案 + 可点重试，而不是「保存失败」", async () => {
        state.loadLayerDomains.mockImplementation(() => Promise.reject(new Error("500")));
        const wrapper = mountView("instance", "rag");
        await flushPromises();

        // 反向判据：不得出现"保存失败"——它把读取失败误报成用户的编辑没保存。
        expect(wrapper.text()).not.toContain("保存失败");
        // 正向判据：说清是读取失败。
        expect(wrapper.text()).toContain("加载失败");

        const retry = wrapper.find('[data-testid="settings-domain-load-retry"]');
        expect(retry.exists()).toBe(true);
        expect(retry.text()).toContain("重试");
    });

    it("点重试会重新发起取数（不是装饰按钮）", async () => {
        state.loadLayerDomains.mockImplementation(() => Promise.reject(new Error("500")));
        const wrapper = mountView("instance", "rag");
        await flushPromises();

        state.loadLayerDomains.mockClear();
        state.loadLayerDomains.mockImplementation(() => Promise.resolve());
        await wrapper.get('[data-testid="settings-domain-load-retry"]').trigger("click");
        await flushPromises();

        expect(state.loadLayerDomains).toHaveBeenCalledWith("instance");
        // 成功后失败态消失（重试不是只有一次机会）。
        expect(wrapper.find('[data-testid="settings-domain-load-retry"]').exists()).toBe(false);
    });
});

/**
 * task-510（H-06/C-05 加载态 + H-03 页签键盘）：这两处都**不许手搓** —— 判据钉的是行为，
 * 不钉 `import`：将来换成别的原语，只要行为还在，这两条仍应通过。
 *
 * <p>修前读数（未改工作树上跑）：① loading 面只有一行 11px 灰字，[`data-slot="skeleton"`]
 * 一个都没有；② 页签是手搓 `<button role="tab">` 列表，**没有 roving focus** ⇒ ArrowRight
 * 无反应（焦点与 `aria-selected` 都不动），键盘用户只能在第一个页签上停住。</p>
 */
describe("SettingsDomainView 加载态与页签键盘（task-510）", () => {
    beforeEach(() => {
        state.capability = true;
        state.routeQuery = {};
        state.layerLoading.value = false;
        state.layerConfig.value = { instance: {}, user: {} };
        state.loadLayerDomains.mockClear();
        state.loadLayerDomains.mockImplementation(() => Promise.resolve());
        state.replace.mockClear();
    });

    it("pending 时渲染 Skeleton（不是一行 11px 灰字）", async () => {
        state.layerLoading.value = true;
        const wrapper = mountView("instance", "logging");
        await flushPromises();

        const loading = wrapper.get('[data-testid="settings-domain-loading"]');
        const skeletons = loading.findAll('[data-slot="skeleton"]');
        // 单行骨架 = 「还是那行字换了个样子」，所以要有块状骨架（≥2）
        expect(skeletons.length).toBeGreaterThan(1);
        // 无障碍：加载态仍要有可读文本（sr-only），不能只剩会动的方块
        expect(loading.text()).toContain("加载中");
    });

    it("页签键盘：ArrowRight 把焦点与 aria-selected 移到下一个页签", async () => {
        const wrapper = mountView("instance", "approval-policy", {}, { attach: true });
        await flushPromises();

        const policy = wrapper.get('[data-testid="settings-domain-tab-policy"]');
        (policy.element as HTMLElement).focus();
        await policy.trigger("keydown", { key: "ArrowRight" });
        await flushPromises();

        const toolFaces = wrapper.get('[data-testid="settings-domain-tab-tool-faces"]');
        expect(document.activeElement).toBe(toolFaces.element);
        expect(toolFaces.attributes("aria-selected")).toBe("true");
    });
});
