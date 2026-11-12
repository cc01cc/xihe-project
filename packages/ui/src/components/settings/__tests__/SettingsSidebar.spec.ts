import { describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import type { RouteLocationNormalizedLoaded } from "vue-router";

/**
 * PLAN-0752 T1.6 / V15：左栏 = 层内二级。
 *
 * 这三条用例锁的是**权限面**与**矩阵**：实例块是否出现只看 cap:instance:admin 能力位，
 * roles 项只看 MANAGE_ROLES 原子；域条目数必须是 12 / 9。这些数一旦被"顺手改一下"，
 * 用户报过的「域比层高 / 两层不对称」就会复发。
 */
const state = {
    capability: true,
    canManageRoles: true,
    layer: "instance" as string,
    domain: "" as string,
};

vi.mock("vue-router", () => ({
    createRouter: () => ({
        push: vi.fn<(location: unknown) => Promise<void>>(),
        replace: vi.fn<(location: unknown) => Promise<void>>(),
        beforeEach: vi.fn<() => void>(),
        afterEach: vi.fn<() => void>(),
        isReady: () => Promise.resolve(),
        currentRoute: { value: {} },
    }),
    createWebHistory: () => ({}),
    useRoute: () =>
        ({
            name: "settings-instance-domain-rag",
            path: "/settings/instance/rag",
            params: {},
            query: {},
            hash: "",
            fullPath: "/settings/instance/rag",
            matched: [],
            meta: { settingsLayer: state.layer, settingsDomain: state.domain },
        }) as unknown as RouteLocationNormalizedLoaded,
    RouterLink: {
        props: { to: { type: [String, Object], required: false, default: "" } },
        template: "<a :data-to='String(to)'><slot /></a>",
    },
}));

vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({
        get hasInstanceAdminCapability() {
            return state.capability;
        },
        get canManageRoles() {
            return state.canManageRoles;
        },
        ensureSelfPermissions: () => Promise.resolve(true),
    }),
}));

import SettingsSidebar from "../SettingsSidebar.vue";

const messages = {
    "zh-CN": {
        settings: {
            domainLlmProvider: "模型与连接",
            domainContextPolicy: "上下文策略",
            domainEmbedding: "向量与索引",
            domainRag: "检索增强（RAG）",
            domainAgentRuntime: "智能体运行时",
            domainAgentProfile: "智能体画像",
            domainUserPreference: "用户偏好",
            domainLogging: "日志",
            domainApprovalPolicy: "审批策略",
            domainAgentTemplates: "智能体模板",
            domainContextTemplates: "API 请求模板",
            domainJobPolicy: "任务策略",
            ia: {
                layerInstance: "实例配置",
                layerUser: "用户配置",
                groupDomains: "域",
                groupOps: "实例运维",
                groupSecurity: "安全与权限",
                navMonitoring: "监控",
                navData: "数据",
                navToolFaces: "工具分类",
                navConfigLocks: "配置锁定",
                navRoles: "角色与授权",
                navAudit: "审计日志",
                groupInstanceResources: "实例资源",
                groupMyResources: "我的资源",
                resourceAgents: "平台智能体",
                resourceMcp: "MCP 服务器",
                resourceCredentials: "凭据",
                resourceKnowledge: "知识库",
                resourceSkills: "技能",
                resourceAgentPrincipals: "智能体主体",
                resourceMyCredentials: "我的凭据",
                resourceKnowledgeMcp: "知识库 · MCP",
                backendGapBadge: "后端缺口 {code}",
                backendGapBadgeGeneric: "后端缺口",
                backendGapHint: "灰显条目为后端缺口，暂不可用；悬停可查看说明。",
            },
        },
    },
};

function mountSidebar(layer: string, domain = "") {
    state.layer = layer;
    state.domain = domain;
    const i18n = createI18n({ legacy: false, locale: "zh-CN", messages });
    return mount(SettingsSidebar, { global: { plugins: [i18n] } });
}

describe("SettingsSidebar", () => {
    it("shows both layers for an instance admin with 12 + 9 domain entries", async () => {
        state.capability = true;
        state.canManageRoles = true;
        const wrapper = mountSidebar("instance", "rag");
        // task-253：左栏改成两个可折叠层分组 —— 当前层默认展开、另一层默认收起。
        expect(wrapper.findAll('[data-testid^="settings-nav-domain-"]')).toHaveLength(12);
        await wrapper.find("#settings-nav-user").trigger("click");
        await flushPromises();
        const links = wrapper.findAll('[data-testid^="settings-nav-domain-"]');
        expect(links).toHaveLength(21);
        expect(wrapper.findAll('[data-testid="settings-nav-group-primary"]')).toHaveLength(2);
        // 未挂 router 插件时 router-link 是未解析元素，to 以原生属性渲染（组件产出的值仍可断言）
        expect(links[0]!.attributes("to")).toBe("/settings/instance/llm-provider");
        expect(links[12]!.attributes("to")).toBe("/settings/user/llm-provider");
        // task-50 A 案：选中底色走 `--sidebar-accent` 组，且不再有 2px 左竖条（「半截括号」）。
        expect(links[0]!.classes().join(" ")).toContain("bg-sidebar-accent");
        expect(links[0]!.classes().join(" ")).toContain("text-sidebar-accent-foreground");
        expect(links[0]!.classes().join(" ")).not.toContain("border-l-2");
        // task-50 C1：条目 13px，与 14px 层组标题拉开一档
        expect(links[0]!.classes().join(" ")).toContain("text-[13px]");

        // task-172：per-domain id 必须带层 —— 12 实例域与 9 用户域有 9 个同名（llm-provider /
        // embedding / rag …），不带层会撞 id（getByTestId 在 strict mode 直接抛）。
        expect(links[0]!.attributes("data-testid")).toBe(
            "settings-nav-domain-instance-llm-provider",
        );
        expect(links[12]!.attributes("data-testid")).toBe("settings-nav-domain-user-llm-provider");
        expect(new Set(links.map((link) => link.attributes("data-testid"))).size).toBe(21);

        // task-171：运维/安全项有 per-item testid（语义定位），顺序 = ops(monitoring,data) +
        // security(config-locks,roles,audit)。
        const ops = wrapper.findAll('[data-testid^="settings-nav-ops-"]');
        expect(ops.map((item) => item.attributes("data-testid"))).toEqual([
            "settings-nav-ops-monitoring",
            "settings-nav-ops-data",
            "settings-nav-ops-config-locks",
            "settings-nav-ops-roles",
            "settings-nav-ops-audit",
        ]);
        expect(ops.map((item) => item.attributes("to"))).toEqual([
            "/settings/monitoring",
            "/settings/data",
            "/settings/config-locks",
            "/settings/roles",
            "/settings/audit",
        ]);
    });

    it("hides instance domains/resources without the capability and no atom (fail-closed)", () => {
        state.capability = false;
        state.canManageRoles = false;
        const wrapper = mountSidebar("user", "rag");
        expect(wrapper.findAll('[data-testid="settings-nav-group-primary"]')).toHaveLength(1);
        expect(wrapper.findAll('[data-testid^="settings-nav-domain-"]')).toHaveLength(9);
        expect(wrapper.text()).not.toContain("配置锁定");
        // 域 + 实例资源整段不渲染 ⇒ ops/安全项也一个都不在（不是靠文案判断）。
        expect(wrapper.findAll('[data-testid^="settings-nav-ops-"]')).toHaveLength(0);
    });

    // BL-552 / PLAN-0651 T4.2 case 3：atom-only（有 MANAGE_ROLES、无 cap:instance:admin）
    // 必须仍看到 roles 入口 —— 修复前实例层整段被能力位遮住，该用例即当时真栈失败面。
    it("BL-552: keeps the roles entry visible for an atom-only user (no capability)", async () => {
        state.capability = false;
        state.canManageRoles = true;
        const wrapper = mountSidebar("user", "rag");
        // 域与实例资源仍按能力位隐藏。
        expect(wrapper.findAll('[data-testid^="settings-nav-domain-instance-"]')).toHaveLength(0);
        // 当前层是用户层 ⇒ 实例组默认收起；ops/安全组的可见性要在展开之后判。
        await wrapper.find("#settings-nav-instance").trigger("click");
        await flushPromises();
        expect(wrapper.findAll('[data-testid="settings-nav-resource-group"]')).toHaveLength(1);
        // 但 ops/安全组里的 roles 项必须渲染（PLAN-0651 ruling ①）。
        expect(wrapper.find('[data-testid="settings-nav-ops-roles"]').exists()).toBe(true);
        // config-locks 走能力位（BL-392），atom-only 下必须隐藏 —— 证明两组门没有互相污染。
        expect(wrapper.find('[data-testid="settings-nav-ops-config-locks"]').exists()).toBe(false);
    });

    it("T4.0: lands the resource group in both layers and keeps every gap slot visible", async () => {
        state.capability = true;
        state.canManageRoles = true;
        const wrapper = mountSidebar("instance", "rag");
        // 实例层当前展开；展开用户层后才能一次看到两层的资源组。
        await wrapper.find("#settings-nav-user").trigger("click");
        await flushPromises();
        // task-165：实例层「实例资源」= 4 条真入口（agents/mcp/credentials/skills）+ 1 缺口（knowledge/G3）；
        // 用户层「我的资源」= 2 真入口（PLAN-0750 M3）+ 1 缺口（knowledge-mcp/G1,G3）
        const groups = wrapper.findAll('[data-testid="settings-nav-resource-group"]');
        expect(groups).toHaveLength(2);
        expect(groups[0]!.text()).toContain("实例资源");
        expect(groups[1]!.text()).toContain("我的资源");
        const gaps = wrapper.findAll('[data-testid^="settings-nav-resource-gap-"]');
        // task-165（D-1006/D-1008/D-1009）：实例层 G4/G1/G2 三条从缺口转真入口（与 task-83 的
        // 「转真就摘缺口」同手法）⇒ 缺口槽从 5 降到 **2**（只余 knowledge 与用户层 knowledge-mcp）。
        // 「机制保留」仍被这条断言钉住：只剩 2 个缺口不代表缺口外形可以退化。
        expect(gaps).toHaveLength(2);
        expect(gaps.map((gap) => gap.attributes("data-gap-codes"))).toEqual(["G3", "G1,G3"]);
        // 有后端承载的资源项：「智能体主体」→ /settings/agent-principals，「我的凭据」→ /settings/credentials
        // 只留真入口：排除分组容器本身（它也叫 settings-nav-resource-group）与缺口按钮
        const real = wrapper.findAll('[data-testid^="settings-nav-resource-"]').filter((node) => {
            const id = node.attributes("data-testid") ?? "";
            return (
                id !== "settings-nav-resource-group" && !id.startsWith("settings-nav-resource-gap-")
            );
        });
        // task-87：ui-2 的 task-83（31d4544a）在实例层新增「技能」真入口 ⇒ 这里从 2 条变 3 条。
        // 本用例测的是「资源组落在两层 + 缺口槽可见 + 只留真入口」的**清单语义**，
        // 不是锚点叫什么名字；testid 收口（task-87）没有改变清单，失败来自上游数据变多。
        // task-165：实例层新增 3 条真入口（agents/mcp/credentials），排在 skills 之前
        // （分组清单次序 = agents → mcp → credentials → skills → knowledge）。
        expect(real.map((node) => node.attributes("data-testid"))).toEqual([
            "settings-nav-resource-agents",
            "settings-nav-resource-mcp",
            "settings-nav-resource-credentials",
            "settings-nav-resource-skills",
            "settings-nav-resource-agent-principals",
            "settings-nav-resource-my-credentials",
        ]);
        expect(real.map((node) => node.text())).toEqual([
            "平台智能体",
            "MCP 服务器",
            "凭据",
            "技能",
            "智能体主体",
            "我的凭据",
        ]);
    });

    it("gates roles on the MANAGE_ROLES atom while keeping audit visible", () => {
        state.capability = true;
        state.canManageRoles = false;
        const wrapper = mountSidebar("instance", "");
        expect(wrapper.text()).toContain("审计日志");
        expect(wrapper.text()).not.toContain("角色与授权");
        // 语义 testid：权限门断言「这一项有没有渲染」，不靠文案/URL 消歧。
        expect(wrapper.find('[data-testid="settings-nav-ops-roles"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="settings-nav-ops-audit"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-nav-ops-config-locks"]').exists()).toBe(true);
        state.canManageRoles = true;
        const withRoles = mountSidebar("instance", "");
        expect(withRoles.text()).toContain("角色与授权");
        expect(withRoles.find('[data-testid="settings-nav-ops-roles"]').exists()).toBe(true);
    });

    /**
     * PLAN-0762 T3.1 / (A)：**真用** `Sidebar` 组件族，但**不挂第二个 `SidebarProvider`**。
     * 这一条只看「产品有没有退化成手写 DOM / 有没有把 provider 带回来」两件事——
     * 机制级旁路（⌘B、cookie、宽度、tooltip）由 `settings-sidebar-context.spec.ts` 钉。
     * `16rem` 是 `SidebarProvider.vue:84` 的写死宽度，出现即说明有人把 provider 包回来了。
     */
    it("T3.1: renders the vendored Sidebar family without mounting a SidebarProvider", () => {
        state.capability = true;
        state.canManageRoles = true;
        clearCookies();
        const before = document.cookie;

        const wrapper = mountSidebar("instance", "rag");

        expect(wrapper.find('[data-testid="settings-sidebar"]').exists()).toBe(true);
        expect(wrapper.find('[data-slot="sidebar"]').exists()).toBe(true);
        expect(wrapper.findAll('[data-slot="sidebar-menu"]').length).toBeGreaterThan(0);
        // 每个条目都必须**保住 vendor 标记**：`as-child` + tooltip 会让 TooltipTrigger 的
        // `data-slot` 顶掉 `sidebar-menu-button`（浏览器实测 17 条丢 13 条）⇒ 这里逐条钉住，
        // 将来谁给条目加回 `tooltip` 会立刻红。
        for (const link of wrapper.findAll('[data-testid^="settings-nav-domain-"]')) {
            expect(link.attributes("data-slot")).toBe("sidebar-menu-button");
        }
        expect(wrapper.findAll('[data-slot="sidebar-menu-button"]').length).toBeGreaterThanOrEqual(
            17,
        );
        // 选中态走 vendor 的 `data-active` 语义（`bg-sidebar-accent` / `text-sidebar-accent-foreground`）；
        // task-50 A 案去掉了条目自带的 2px 左竖条（用户看到的「半截括号」）。
        const active = wrapper.find('[data-active="true"]');
        expect(active.exists()).toBe(true);
        expect(active.classes().join(" ")).toContain("bg-sidebar-accent");
        expect(active.classes().join(" ")).toContain("text-sidebar-accent-foreground");
        expect(active.classes().join(" ")).not.toContain("border-l-primary");

        // (A) 的两条外部可观测证据：没有 provider 的 16rem wrapper、没有 cookie 写入
        expect(wrapper.html()).not.toContain("16rem");
        expect(document.cookie).toBe(before);
        expect(document.cookie).not.toContain("sidebar_state");
    });

    it("层组次序 = 高 → 低（instance → user → workspace-default）", async () => {
        // 锚在语义 id（settings-nav-*）上，不锚 class/testid 组名：
        // `settings-nav-group-primary` 被实例组与个人组复用，拿它排序会得到错误次序。
        // 顺序真相 = lib/settingsIa.ts#SETTINGS_LAYERS（= SETTINGS_LAYERS_LOW_TO_HIGH 的反序）。
        state.capability = true;
        const wrapper = mountSidebar("instance");
        await flushPromises();
        const ids = wrapper.findAll('[id^="settings-nav-"]').map((el) => el.attributes("id"));
        expect(ids.slice(0, 3)).toEqual([
            "settings-nav-instance",
            "settings-nav-user",
            "settings-nav-workspace-default",
        ]);
        wrapper.unmount();
    });

    it("分组标题 testid：作用域化锚点在同一渲染树里唯一，层无关锚点按层计次", async () => {
        // 判据是**机器计数**，不是注释：左栏曾把同一个常量 testid 挂在 5 处
        // （4 处本组标题 + ResourceNav 被渲染 2 次），任何 getByTestId 都可能命中错的那个。
        // 定性结论：这些标题**语义相同**（层内二级组标签），故作用域化而不是拆成语义名。
        //
        // task-87 修正判据（cp-1 第一版把两类锚点混在一起判唯一，必然假红）：
        //   · 层无关锚点（primary / items / ops-* / group*Resources）每渲染一层就各有一份，跨层重复是设计意图
        //     —— 同一事实在本文件 123 行「primary 期望 2 个」里早已断言；要求它们全局唯一等于逼着把层信息塞进 id，
        //     而分层靠的是 #settings-nav-<layer> 容器。
        //   · 作用域化锚点（domains-* 这类标识"某层里的某个组"的）必须树内唯一。
        state.capability = true;
        state.canManageRoles = true;
        const wrapper = mountSidebar("instance", "rag");
        // 两层都展开：只有跨层同时在场，唯一性判据才真的覆盖到"ResourceNav 被渲染 2 次"这个原始缺陷。
        await wrapper.find("#settings-nav-user").trigger("click");
        await flushPromises();
        expect(wrapper.findAll('[data-testid="settings-nav-group-secondary"]').length).toBe(0);
        const ids = wrapper
            .findAll('[data-testid^="settings-nav-group-"]')
            .map((el) => el.attributes("data-testid") ?? "");
        const LAYER_AGNOSTIC =
            /^settings-nav-group-(primary|items|ops-.*|groupInstanceResources|groupMyResources)$/;
        const scoped = ids.filter((id) => !LAYER_AGNOSTIC.test(id));
        expect(scoped.length).toBeGreaterThan(0);
        // ① 作用域化锚点：树内唯一（原缺陷的机器判据，保留）
        expect(new Set(scoped).size).toBe(scoped.length);
        // ② 层无关锚点：允许重复，但重复次数必须等于渲染出来的层数（2），不是随便重复
        expect(ids.filter((id) => id === "settings-nav-group-primary")).toHaveLength(2);
        wrapper.unmount();
    });
});

function clearCookies() {
    for (const part of document.cookie.split(";")) {
        const name = part.split("=")[0]?.trim();
        if (name) document.cookie = `${name}=; path=/; max-age=0`;
    }
}
