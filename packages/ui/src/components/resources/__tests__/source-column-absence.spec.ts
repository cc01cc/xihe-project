import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type * as apiModule from "../../../composables/api";
import type * as resourcesModule from "../../../services/instanceResources";

/**
 * task-296（PLAN-0772 `T1.3` 冻结态）：**来源列现在一列都不许画** —— 本文件是「假门自白」的负断言。
 *
 * <p><b>为什么现在不许画</b>（证据：`internal/A03-xihe/evidence/2026-11-12-t13-source-column-datagap/README.md`）：
 * 列是数据契约的投影（`D-1056` ②）——</p>
 * <ul>
 *   <li><b>MCP 三值全无数据面</b>：实例注册表 `GET /api/v1/instance/mcp` 仍是
 *       `RouteContractParityTest.java:216-217` 里的 `PLANNED_APIS`（`PLAN-0771 M3`，「契约先落、实现待建」）；
 *       工作区 `GET .../mcp-config` 只回本区已存行（`ConfigController.java:919-947`，不合并实例注册表）
 *       ⇒ `继承自实例` / `覆盖实例同名` / 连 `自建` 都无法判定。</li>
 *   <li><b>智能体两值也无逐行判据</b>：`AgentPrincipalView`（`openapi.yaml:6593`）没有 creator/层字段；
 *       个人视图对持管理原子者返回 `findAll()`（`AgentPrincipalService.java:668-670`）、
 *       实例视图 `findAll()` 不筛（`:696-698`，`#40` 待裁）⇒ 两个 tab 行集重叠，
 *       硬贴「个人 / 平台」是**给别人的行贴错标签**，比没标签更糟。</li>
 *   <li><b>spec 自己就只要求这两处</b>：`resource-layer-matrix.md:50-54` 只给 MCP 与智能体主体画来源列；
 *       凭据/技能不画（技能侧已有同族负断言 `WorkspaceSkillsPanel.spec.ts:60`）。</li>
 * </ul>
 *
 * <p><b>本文件是绊线，不是永久禁令</b>：解冻条件 = ①MCP 等 `PLAN-0771 M3` 的实例注册表实现落地
 * （并把 `instanceResources.ts:301-313` 的 `servers[]` 归一化改成契约的 `{mcpServers:{<name>:entry}}`）；
 * ②agents 等 `#40` 裁定（40B/40C 给出行级归属字段）或视图补 `origin`（`resource-layer-matrix.md:52`）。
 * <b>解冻后本文件应当改成列值断言</b>（`spec §4:54` 要求断列值，不是断列存在）——
 * 如果未来有人为了让这里变绿而删断言，请先读证据 README 的「解冻条件」一节。</p>
 */
import { i18n } from "../../../i18n";
import AgentPrincipalsPanel from "../../settings/AgentPrincipalsPanel.vue";
import InstanceAgentsPanel from "../../settings/InstanceAgentsPanel.vue";
import InstanceMcpPanel from "../../settings/InstanceMcpPanel.vue";
import WorkspaceMcpPanel from "../../../features/workspace/components/WorkspaceMcpPanel.vue";

const h = vi.hoisted(() => {
    /**
     * 假 auth store：**必须覆盖组件真正读到的成员**，且用 Proxy 兜住漏项（task-154）。
     *
     * <p>为什么需要 `isAuthenticated`：`964d740bc` 把 `InstanceAgentsPanel` 的**读面**判据从
     * `isAdmin` 换成 `isAuthenticated`（对齐 CP 的 `@PreAuthorize("isAuthenticated()")`），同批只更新了
     * 同目录的 `InstanceAgentsPanel.spec.ts`，漏了本文件这条**跨目录**负断言 ⇒ 这里的假 store 没有该字段
     * ⇒ `load()` 不触发 ⇒ 表格不渲染 ⇒ `:311` 必红（develop 确定性红，非 flake）。**门控怎么改，这个表就怎么补。**</p>
     *
     * <p>为什么用 Proxy 而不是普通对象：下次再改读面判据时，「少一个字段」的表现是**静默地少渲染一块**，
     * 而断言只剩一句「元素不存在」，读起来像产品问题。Proxy 让缺项当场抛错并点名字段，把排查成本从
     * 「重新推导 964d740bc 那类改动」降到一眼。</p>
     */
    const authBase: Record<string, unknown> = {
        isAuthenticated: true,
        isAdmin: true,
        hasInstanceAdminCapability: true,
        hasInstanceAtom: () => true,
        canWriteWorkspace: true,
        // task-401：实例智能体面板现在自取 `/me/permissions` 投影（资源区路由上没有别人拉它）。
        ensureSelfPermissions: async () => true,
        // task-420（D-1254）：写门三态化后 `useInstanceWriteGate` 读投影的**读取状态**，
        // 不再只看原子集合。假 store 同批补这一项（Proxy 当场点名了它，正是 task-154 的设计目的）。
        selfPermissionsStatus: "ready",
    };
    const auth = new Proxy(authBase, {
        get(target, prop) {
            // 符号、已在表内的成员、以及 Vue 自身的探针（`__v_isRef` 等，模板里 `unref()` 会读）正常返回；
            // 其余一律抛错 —— 只把「组件真的问了 store 一个没有的成员」这一种情况变成硬错。
            if (typeof prop === "symbol" || prop in target || prop.startsWith("__v_")) {
                return target[prop];
            }
            throw new Error(
                `[source-column-absence] 假 auth store 缺少成员 "${String(prop)}" —— 组件新读了 useAuthStore 的字段，请补进 authBase（task-154）`,
            );
        },
    });
    return {
        auth,
        // services/instanceResources
        listInstanceMcpServers: vi.fn<typeof resourcesModule.listInstanceMcpServers>(),
        createInstanceMcpServer: vi.fn<typeof resourcesModule.createInstanceMcpServer>(),
        deleteInstanceMcpServer: vi.fn<typeof resourcesModule.deleteInstanceMcpServer>(),
        listInstanceCredentials: vi.fn<typeof resourcesModule.listInstanceCredentials>(),
        listInstanceAgents: vi.fn<typeof resourcesModule.listInstanceAgents>(),
        createInstanceAgent: vi.fn<typeof resourcesModule.createInstanceAgent>(),
        deleteInstanceAgent: vi.fn<typeof resourcesModule.deleteInstanceAgent>(),
        // composables/api
        listMyAgentPrincipals: vi.fn<typeof apiModule.api.listMyAgentPrincipals>(),
        getSelfPermissions: vi.fn<typeof apiModule.api.getSelfPermissions>(),
        listWorkspaces: vi.fn<typeof apiModule.api.listWorkspaces>(),
        getWorkspaceAgents: vi.fn<typeof apiModule.api.getWorkspaceAgents>(),
        updateWorkspaceAgentCap: vi.fn<typeof apiModule.api.updateWorkspaceAgentCap>(),
        createOwnAgentPrincipal: vi.fn<typeof apiModule.api.createOwnAgentPrincipal>(),
        getMcpConfig: vi.fn<typeof apiModule.api.getMcpConfig>(),
        saveMcpConfig: vi.fn<typeof apiModule.api.saveMcpConfig>(),
        startOAuthSession: vi.fn<typeof apiModule.api.startOAuthSession>(),
        completeOAuthSession: vi.fn<typeof apiModule.api.completeOAuthSession>(),
    };
});

vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => h.auth,
}));

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string) => void>(),
        warn: vi.fn<(message: string) => void>(),
    },
}));

/**
 * 静音产品 logger：`WorkspaceMcpPanel` 首帧解析空 `mcpJson` 会 `logger.warn` 一条
 * `Unexpected end of JSON input`（产品侧已 catch，属既有噪声）。本文件断言的是「有没有来源列」，
 * 不能让这条噪声把真正的失败淹没在 stderr 里。
 */
vi.mock("../../../lib/logger", () => ({
    logger: {
        debug: vi.fn<() => void>(),
        info: vi.fn<() => void>(),
        warn: vi.fn<() => void>(),
        error: vi.fn<() => void>(),
    },
}));

vi.mock("../../../services/instanceResources", async (importOriginal) => {
    const actual = await importOriginal<typeof resourcesModule>();
    return {
        ...actual,
        listInstanceMcpServers: h.listInstanceMcpServers,
        createInstanceMcpServer: h.createInstanceMcpServer,
        deleteInstanceMcpServer: h.deleteInstanceMcpServer,
        listInstanceCredentials: h.listInstanceCredentials,
        listInstanceAgents: h.listInstanceAgents,
        createInstanceAgent: h.createInstanceAgent,
        deleteInstanceAgent: h.deleteInstanceAgent,
    };
});

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listMyAgentPrincipals: h.listMyAgentPrincipals,
            getSelfPermissions: h.getSelfPermissions,
            listWorkspaces: h.listWorkspaces,
            getWorkspaceAgents: h.getWorkspaceAgents,
            updateWorkspaceAgentCap: h.updateWorkspaceAgentCap,
            createOwnAgentPrincipal: h.createOwnAgentPrincipal,
            getMcpConfig: h.getMcpConfig,
            saveMcpConfig: h.saveMcpConfig,
            startOAuthSession: h.startOAuthSession,
            completeOAuthSession: h.completeOAuthSession,
        },
    };
});

/** spec §4 里 MCP 与智能体主体的来源列取值（`resource-layer-matrix.md:50-51`）。 */
const SPEC_SOURCE_VALUES = new Set(["继承自实例", "覆盖实例同名", "自建", "平台", "个人"]),
    SOURCE_ID_PATTERN = /source[-_]?column|column[-_]?source/i;

/** 来源列的三路可观测信号：列头文案 / 取值单元格 / 结构化 testid。 */
interface SourceSignals {
    sourceHeaders: string[];
    sourceCells: string[];
    sourceIds: string[];
}

/**
 * 一次扫描同时看三路，**缺一路就说明绊线有盲区**（所以自检用例会把三路都验一遍）：
 * 1. `<th>` 文案含「来源」—— 列头这条路最直观，但改写文案（「来源层」）也不会漏（用的是包含匹配）；
 * 2. 叶子节点文本**恰好等于** spec 的某个取值 —— 这条抓「列头被改名、但值还是那五个词」；
 * 3. `data-testid` 命中 `source-column` / `column-source` —— 结构化钩子，抓无表格的列表型面板（如主体面板）。
 */
function scanSourceColumn(wrapper: VueWrapper): SourceSignals {
    const sourceHeaders = wrapper
        .findAll("th")
        .map((el) => el.text().trim())
        .filter((text) => text.includes("来源"));
    const leaves = wrapper
        .findAll("*")
        .filter((el) => el.element.children.length === 0)
        .map((el) => el.text().trim());
    const sourceCells = [...new Set(leaves.filter((text) => SPEC_SOURCE_VALUES.has(text)))];
    const sourceIds = wrapper
        .findAll("[data-testid]")
        .map((el) => el.attributes("data-testid") ?? "")
        .filter((id) => SOURCE_ID_PATTERN.test(id));
    return { sourceHeaders, sourceCells, sourceIds };
}

/**
 * 断言「这一层现在没有来源列」。
 *
 * <p>失败时三路信号一起打印：只喊一句「不该有列」无法区分**真有人画了列**与**检测器失效**，
 * 而后者会让这条用例变成永远绿的装饰（`task-296` 的教训：门要能解释自己为什么红）。</p>
 */
function expectNoSourceColumn(wrapper: VueWrapper, panel: string): void {
    const signals = scanSourceColumn(wrapper);
    expect({ panel, ...signals }).toEqual({
        panel,
        sourceHeaders: [],
        sourceCells: [],
        sourceIds: [],
    });
}

/** 自检用的最小假面板：三层信号各给一处，证明扫描器不是空转。 */
const SourceColumnStub = defineComponent({
    template: `<div>
        <table>
            <thead><tr><th>名称</th><th>来源</th></tr></thead>
            <tbody><tr><td>github</td><td>自建</td></tr></tbody>
        </table>
        <span data-testid="demo-source-column">继承自实例</span>
    </div>`,
});

function mountPanel(component: unknown, props: Record<string, unknown> = {}) {
    return mount(component as never, {
        props,
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
}

beforeEach(() => {
    // task-401：实例智能体面板现在读 `useConfigStore()`（模型三段的连接与目录来源）⇒
    // 本文件必须有 active pinia，否则 mount 处直接抛「no active Pinia」。这里只给真 pinia，
    // 不桩 store：本文件的判据是「不渲染来源列」，与连接数据无关，空 store 就够。
    setActivePinia(createPinia());
    vi.clearAllMocks();
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/workspace/ws-1");
    h.auth.isAdmin = true;

    h.listInstanceMcpServers.mockResolvedValue({
        servers: [
            {
                id: "mcp-1",
                name: "github",
                transport: "http",
                url: "https://mcp.example.com/sse",
                enabled: true,
                credentialId: null,
                createdAt: "2026-11-12T00:00:00Z",
            },
        ],
        count: 1,
    });
    h.listInstanceCredentials.mockResolvedValue({ credentials: [], count: 0 });
    h.listInstanceAgents.mockResolvedValue({
        agents: [
            {
                id: "agent-1",
                name: "平台助手",
                description: null,
                templateName: null,
                modelProvider: "anthropic",
                modelName: "claude-sonnet-4.5",
                createdAt: "2026-11-12T00:00:00Z",
                disabled: false,
            },
        ],
        count: 1,
    });
    h.listMyAgentPrincipals.mockResolvedValue([
        {
            principalId: "p-1",
            name: "reviewer",
            templateId: null,
            templateName: null,
            createdAt: "2026-11-12T00:00:00Z",
            disabled: false,
            defaultModelProvider: null,
            defaultModelName: null,
        },
    ]);
    h.getSelfPermissions.mockResolvedValue({
        userId: "user-1",
        instanceCapabilities: [],
        instancePermissions: [{ actionClass: "CREATE_OWN_AGENT", resource: "*" }],
        workspaces: [],
    });
    h.listWorkspaces.mockResolvedValue([{ id: "ws-1", name: "Workspace One" }]);
    h.getWorkspaceAgents.mockResolvedValue([]);
    h.updateWorkspaceAgentCap.mockResolvedValue({ permissions: [] });
    h.getMcpConfig.mockResolvedValue({
        mcpServers: { "remote-demo": { url: "https://example.com/mcp", type: "http" } },
    });
});

describe("来源列负断言 · MCP 两层（task-296 / T1.3 冻结）", () => {
    /**
     * 实例层：注册表里的每一行都是实例自建，本来就没有「继承/覆盖」可画；
     * 而且实例注册表读面当前**未实现**（`PLANNED_APIS`），连「自建」这一列也只有常量值 ——
     * 常量列是噪声，不是信息。解冻后：实例 tab 依旧不该有来源列（值恒为自建），
     * 该变化只发生在**工作区 tab**（三值都由两文档 diff 得出）。
     */
    it("实例层 MCP 面板：不渲染来源列（列头/取值/testid 三路皆空）", async () => {
        const wrapper = mountPanel(InstanceMcpPanel);
        await flushPromises();
        expect(wrapper.find('[data-testid="instance-mcp-table"]').exists()).toBe(true);
        expect(wrapper.text()).toContain("github");

        expectNoSourceColumn(wrapper, "InstanceMcpPanel(instance)");

        wrapper.unmount();
    });

    /**
     * 工作区层：今天这页是 **JSON 编辑器 + remote 列表**，根本没有表格；
     * 来源列要先有列表才谈得上画。即使将来加表，三值也必须由
     * `GET .../mcp-config` 与 `GET /api/v1/instance/mcp` 两份文档 diff 得出
     * （契约明确认可这条路径，`openapi.yaml:5034`）—— 实例注册表没实现之前 diff 不出来。
     */
    it("工作区层 MCP 面板：不渲染来源列（当前无表；数据面缺实例注册表）", async () => {
        const wrapper = mountPanel(WorkspaceMcpPanel, { workspaceId: "ws-1" });
        await flushPromises();
        expect(wrapper.find('[data-testid="mcp-config-textarea"]').exists()).toBe(true);

        expectNoSourceColumn(wrapper, "WorkspaceMcpPanel(workspace)");

        wrapper.unmount();
    });
});

describe("来源列负断言 · 智能体主体两层（task-296 / T1.3 冻结）", () => {
    /**
     * 用户层：「我的主体」这条列表对**持管理原子者返回 `findAll()`**
     * （`AgentPrincipalService.java:668-670`）⇒ 行里混着别人创建的主体。
     * 逐行贴「个人」就是给别人的行贴错标签 —— 这正是 `task-292` 阶段 1 判死的方案，
     * 所以本层在 `#40` 给出判别字段之前不画列。
     */
    it("用户层主体面板：不渲染来源列（admin 视图含他人行 ⇒ 层身份也不诚实）", async () => {
        const wrapper = mountPanel(AgentPrincipalsPanel);
        await flushPromises();
        expect(wrapper.find('[data-testid="agent-principals-row-p-1"]').exists()).toBe(true);

        expectNoSourceColumn(wrapper, "AgentPrincipalsPanel(user)");

        wrapper.unmount();
    });

    /**
     * 实例层：`listInstancePrincipals()` = `findAll()` 不筛（`AgentPrincipalService.java:696-698`，
     * 「path 即归属」是 `#40` 的 40A 权宜）⇒ 这里同样混着用户/工作区主体。
     * 订正路径：`openapi.yaml:6593` 的 `AgentPrincipalView` 补行级归属字段（`#40` 40B/40C）。
     */
    it("实例层主体面板：不渲染来源列（列表无行级判别字段）", async () => {
        const wrapper = mountPanel(InstanceAgentsPanel);
        await flushPromises();
        expect(wrapper.find('[data-testid="instance-agents-table"]').exists()).toBe(true);
        expect(wrapper.text()).toContain("平台助手");

        expectNoSourceColumn(wrapper, "InstanceAgentsPanel(instance)");

        wrapper.unmount();
    });
});

describe("来源列扫描器自检（绊线必须能解释自己为什么红）", () => {
    /**
     * 这一条是**负例**：假面板三路信号各给一处 ⇒ 扫描器必须全部抓到。
     * 若有人把扫描器改成空转（例如把 `th` 选择器删掉），本用例立刻红 ——
     * 否则上面四条负断言会变成「永远绿」的装饰。
     */
    it("扫描器能抓到列头/取值/testid 三路信号（防止负断言空转）", () => {
        const wrapper = mount(SourceColumnStub, {
            global: { plugins: [i18n] },
            attachTo: document.body,
        });

        expect(scanSourceColumn(wrapper)).toEqual({
            sourceHeaders: ["来源"],
            sourceCells: ["自建", "继承自实例"],
            sourceIds: ["demo-source-column"],
        });

        wrapper.unmount();
    });

    /**
     * 第二条负例，打**真实面板的 DOM**：往已挂载的实例 MCP 表里注入一列「来源 / 自建」，
     * 扫描器必须报出来。它与上一条的区别是**不换组件** —— 证明前面那条负断言扫的确实是
     * 产品渲染出来的 DOM，而不是某个只在假面板上成立的选择器。
     *
     * <p>注入只发生在 `document` 里（测试自建节点），**不改产品源码**，用例结束即随
     * `attachTo` 的 wrapper 一起丢弃。</p>
     */
    it("往真实面板 DOM 注入来源列后必须报红（负断言对产品 DOM 有效）", async () => {
        const wrapper = mountPanel(InstanceMcpPanel);
        await flushPromises();
        const table = wrapper.find('[data-testid="instance-mcp-table"]');
        expect(table.exists()).toBe(true);

        const headRow = table.element.querySelector("thead tr");
        const bodyRow = table.element.querySelector("tbody tr");
        expect(headRow).not.toBeNull();
        expect(bodyRow).not.toBeNull();
        headRow?.insertAdjacentHTML("beforeend", "<th>来源</th>");
        bodyRow?.insertAdjacentHTML("beforeend", "<td>自建</td>");

        const signals = scanSourceColumn(wrapper);
        // 注入后三路信号里必须至少有列头与取值 —— 否则说明扫描器对真实产品 DOM 是瞎的。
        expect(signals.sourceHeaders).toEqual(["来源"]);
        expect(signals.sourceCells).toEqual(["自建"]);

        wrapper.unmount();
    });
});
