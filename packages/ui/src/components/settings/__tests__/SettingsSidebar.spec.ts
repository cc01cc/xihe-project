import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
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
                resourceMyAgents: "我的智能体",
                resourceMyCredentials: "我的凭据",
                resourceKnowledgeMcp: "知识库 · MCP",
                backendGapBadge: "后端缺口 {code}",
                backendGapBadgeGeneric: "后端缺口",
                gapDialogTitle: "{item}：暂无后端承载",
                gapDialogDismiss: "知道了",
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
    it("shows both layers for an instance admin with 12 + 9 domain entries", () => {
        state.capability = true;
        state.canManageRoles = true;
        const wrapper = mountSidebar("instance", "rag");
        const links = wrapper.findAll('[data-testid="settings-nav-domain"]');
        expect(links).toHaveLength(21);
        expect(wrapper.findAll('[data-testid="settings-nav-group-primary"]')).toHaveLength(2);
        // 未挂 router 插件时 router-link 是未解析元素，to 以原生属性渲染（组件产出的值仍可断言）
        expect(links[0]!.attributes("to")).toBe("/settings/instance/llm-provider");
        expect(links[12]!.attributes("to")).toBe("/settings/user/llm-provider");
        expect(links[0]!.classes().join(" ")).toContain("bg-muted");

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

    it("hides the whole instance block without the capability (fail-closed)", () => {
        state.capability = false;
        const wrapper = mountSidebar("user", "rag");
        expect(wrapper.findAll('[data-testid="settings-nav-group-primary"]')).toHaveLength(1);
        expect(wrapper.findAll('[data-testid="settings-nav-domain"]')).toHaveLength(9);
        expect(wrapper.text()).not.toContain("配置锁定");
        // 实例块整体不渲染 ⇒ 运维/安全项也一个都不在（不是靠文案判断）。
        expect(wrapper.findAll('[data-testid^="settings-nav-ops-"]')).toHaveLength(0);
    });

    it("T4.0: lands the resource group in both layers and keeps every gap slot visible", () => {
        state.capability = true;
        state.canManageRoles = true;
        const wrapper = mountSidebar("instance", "rag");
        // 实例层「实例资源」4 条全缺口；用户层「我的资源」2 缺口 + 1 真入口
        const groups = wrapper.findAll('[data-testid="settings-nav-resource-group"]');
        expect(groups).toHaveLength(2);
        expect(groups[0]!.text()).toContain("实例资源");
        expect(groups[1]!.text()).toContain("我的资源");
        const gaps = wrapper.findAll('[data-testid^="settings-nav-resource-gap-"]');
        expect(gaps).toHaveLength(6);
        expect(gaps.map((gap) => gap.attributes("data-gap-codes"))).toEqual([
            "G4",
            "G1",
            "G2",
            "G3",
            "G4",
            "G1,G3",
        ]);
        // 唯一有后端承载的资源项是「我的凭据」→ 已实现的凭据页
        // 只留真入口：排除分组容器本身（它也叫 settings-nav-resource-group）与缺口按钮
        const real = wrapper.findAll('[data-testid^="settings-nav-resource-"]').filter((node) => {
            const id = node.attributes("data-testid") ?? "";
            return (
                id !== "settings-nav-resource-group" && !id.startsWith("settings-nav-resource-gap-")
            );
        });
        expect(real).toHaveLength(1);
        expect(real[0]!.attributes("data-testid")).toBe("settings-nav-resource-my-credentials");
        expect(real[0]!.text()).toBe("我的凭据");
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
});
