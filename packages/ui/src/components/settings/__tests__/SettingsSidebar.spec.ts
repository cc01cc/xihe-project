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
                resourceAgents: "智能体",
                resourceMcp: "MCP 服务器",
                resourceCredentials: "凭据",
                resourceKnowledge: "知识库",
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
        expect(links[0]!.classes().join(" ")).toContain("bg-muted");

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
        // 实例层「实例资源」4 条全缺口；用户层「我的资源」1 缺口 + 2 真入口（PLAN-0750 M3）
        const groups = wrapper.findAll('[data-testid="settings-nav-resource-group"]');
        expect(groups).toHaveLength(2);
        expect(groups[0]!.text()).toContain("实例资源");
        expect(groups[1]!.text()).toContain("我的资源");
        const gaps = wrapper.findAll('[data-testid^="settings-nav-resource-gap-"]');
        // PLAN-0750 M3：agents 从缺口转真入口 ⇒ 缺口槽从 6 降到 5（机制保留，见下一条断言）。
        expect(gaps).toHaveLength(5);
        expect(gaps.map((gap) => gap.attributes("data-gap-codes"))).toEqual([
            "G4",
            "G1",
            "G2",
            "G3",
            "G1,G3",
        ]);
        // 有后端承载的资源项：「智能体主体」→ /settings/agent-principals，「我的凭据」→ /settings/credentials
        // 只留真入口：排除分组容器本身（它也叫 settings-nav-resource-group）与缺口按钮
        const real = wrapper.findAll('[data-testid^="settings-nav-resource-"]').filter((node) => {
            const id = node.attributes("data-testid") ?? "";
            return (
                id !== "settings-nav-resource-group" && !id.startsWith("settings-nav-resource-gap-")
            );
        });
        expect(real.map((node) => node.attributes("data-testid"))).toEqual([
            "settings-nav-resource-agent-principals",
            "settings-nav-resource-my-credentials",
        ]);
        expect(real.map((node) => node.text())).toEqual(["智能体主体", "我的凭据"]);
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
        // 选中态走 vendor 的 data-active 约定（同时保留条目自身的 2px 指示条 class）
        const active = wrapper.find('[data-active="true"]');
        expect(active.exists()).toBe(true);
        expect(active.classes().join(" ")).toContain("bg-muted");

        // (A) 的两条外部可观测证据：没有 provider 的 16rem wrapper、没有 cookie 写入
        expect(wrapper.html()).not.toContain("16rem");
        expect(document.cookie).toBe(before);
        expect(document.cookie).not.toContain("sidebar_state");
    });
});

function clearCookies() {
    for (const part of document.cookie.split(";")) {
        const name = part.split("=")[0]?.trim();
        if (name) document.cookie = `${name}=; path=/; max-age=0`;
    }
}
