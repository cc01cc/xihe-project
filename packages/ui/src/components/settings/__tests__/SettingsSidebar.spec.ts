import { describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import { LAYER_DOMAINS } from "../../../stores/config";
import { navItemsForLayer } from "../../../lib/settingsIa";

/**
 * PLAN-0752 T1.6 / V15：左栏 = 层内二级。
 *
 * 这三条用例锁的是**权限面**与**矩阵**：实例块是否出现只看 cap:instance:admin 能力位，
 * roles 项只看 MANAGE_ROLES 原子；矩阵必须是 12 / 9 个域。这些数一旦被"顺手改一下"，
 * 用户报过的「域比层高 / 两层不对称」就会复发。
 *
 * task-227（合页不合域）之后，**条目数 ≠ 域数**：三个模型域在左栏折成一个组条目
 * （12 → 10、9 → 7）。所以这里的判据拆成两句 —— 矩阵数（防合并域）+ 派生条目数
 * （防把组折叠去掉），两个都从 settingsIa / stores 求值，不写死"10 / 7"。
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
                layerWorkspaceDefault: "默认配置",
                entryCount: "{count} 个入口",
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
        // task-227「合页不合域」：**矩阵没变**（实例 12 域 / 用户 9 域，下面两条断言钉住），
        // 变的是左栏条目 —— 三个模型域（llm-provider / context-policy / api-request-templates）
        // 折成**一个**组条目 ⇒ 条目数 12 − 3 + 1 = 10、9 − 3 + 1 = 7。
        // 判据写成「矩阵数 + 派生数」两句：谁把域合并了，矩阵断言立刻红；
        // 谁把组折叠去掉了，条目数断言立刻红。
        expect(LAYER_DOMAINS.instance).toHaveLength(12);
        expect(LAYER_DOMAINS.user).toHaveLength(9);
        expect(navItemsForLayer("instance")).toHaveLength(10);
        expect(navItemsForLayer("user")).toHaveLength(7);
        // task-253：左栏改成两个可折叠层分组 —— 当前层默认展开、另一层默认收起。
        expect(wrapper.findAll('[data-testid^="settings-nav-domain-"]')).toHaveLength(10);
        await wrapper.find("#settings-nav-user").trigger("click");
        await flushPromises();
        const links = wrapper.findAll('[data-testid^="settings-nav-domain-"]');
        expect(links).toHaveLength(17);
        expect(wrapper.findAll('[data-testid="settings-nav-group-primary"]')).toHaveLength(2);
        // 未挂 router 插件时 router-link 是未解析元素，to 以原生属性渲染（组件产出的值仍可断言）
        // 首条是组条目（组占 llm-provider 原来的位置）——"反序"不是随意的：组把它所代表的
        // 三个域收在自己名下，位置必须保持在三段原来所在处，否则用户会以为模型配置被挪走了。
        expect(links[0]!.attributes("to")).toBe("/settings/instance/model-config");
        // 实例层 10 条之后是用户层：**第一条是组条目**（组在左栏占 llm-provider 原来的位置）。
        expect(links[10]!.attributes("to")).toBe("/settings/user/model-config");
        // task-50 A 案：选中底色走 `--sidebar-accent` 组，且不再有 2px 左竖条（「半截括号」）。
        expect(links[0]!.classes().join(" ")).toContain("bg-sidebar-accent");
        expect(links[0]!.classes().join(" ")).toContain("text-sidebar-accent-foreground");
        expect(links[0]!.classes().join(" ")).not.toContain("border-l-2");
        // task-278 G1：条目由任意值 13px 收敛到 `text-sm`（14px，--text-sm: 0.875rem）。
        // 为什么不是 text-xs：13px → 12px 会与 14px 层组标题差 2px 反而不成阶，
        // 且用户 2026-11-13 要的是「收敛到既有 token」而不是「全部压到最小档」。
        expect(links[0]!.classes().join(" ")).toContain("text-sm");
        expect(links[0]!.classes().join(" ")).not.toContain("text-[13px]");

        // task-172：per-domain id 必须带层 —— 12 实例域与 9 用户域有 9 个同名（llm-provider /
        // embedding / rag …），不带层会撞 id（getByTestId 在 strict mode 直接抛）。
        expect(links[0]!.attributes("data-testid")).toBe(
            "settings-nav-domain-instance-model-config",
        );
        // 组条目复用同一个 testid 前缀（"domain" 在此表示"配置区条目"）；组 id 不是域 id，
        // 这也正是它能在 strict-mode 下与域条目共存、又不与任何 `/config/model-config` 请求混淆的原因。
        expect(links[10]!.attributes("data-testid")).toBe("settings-nav-domain-user-model-config");
        expect(new Set(links.map((link) => link.attributes("data-testid"))).size).toBe(17);

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
        // task-227：用户层 9 域里同样有 3 个模型域折成 1 个组条目 ⇒ 9 − 3 + 1 = 7。
        expect(LAYER_DOMAINS.user).toHaveLength(9);
        expect(wrapper.findAll('[data-testid^="settings-nav-domain-"]')).toHaveLength(7);
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
        // PLAN-0772 M2：设置区**不再有资源组** —— 资源整段搬到 `/resources`（第三个顶层入口），
        // 所以「atom-only 用户看不到实例资源」这条现在退化成「谁都看不到」。
        expect(wrapper.findAll('[data-testid="settings-nav-resource-group"]')).toHaveLength(0);
        // 但 ops/安全组里的 roles 项必须渲染（PLAN-0651 ruling ①）。
        expect(wrapper.find('[data-testid="settings-nav-ops-roles"]').exists()).toBe(true);
        // config-locks 走能力位（BL-392），atom-only 下必须隐藏 —— 证明两组门没有互相污染。
        expect(wrapper.find('[data-testid="settings-nav-ops-config-locks"]').exists()).toBe(false);
    });

    it("T4.0 → M2：资源组已整体搬出设置区（两层都不再渲染任何资源条目）", async () => {
        state.capability = true;
        state.canManageRoles = true;
        const wrapper = mountSidebar("instance", "rag");
        // 实例层当前展开；展开用户层后才能一次看到两层。
        await wrapper.find("#settings-nav-user").trigger("click");
        await flushPromises();
        // 判据是**负数**：搬家后设置区左栏一个资源条目都不该有（残留就是双入口）。
        expect(wrapper.findAll('[data-testid="settings-nav-resource-group"]')).toHaveLength(0);
        expect(wrapper.findAll('[data-testid^="settings-nav-resource-"]')).toHaveLength(0);
        expect(wrapper.findAll('[data-testid^="settings-nav-resource-gap-"]')).toHaveLength(0);
        // 配置域与 ops/安全两组仍在（搬家只动资源面，D-1006 B6 的矩阵不受影响）。
        expect(wrapper.find('[data-testid="settings-nav-domain-instance-rag"]').exists()).toBe(
            true,
        );
        expect(wrapper.find('[data-testid="settings-nav-ops-audit"]').exists()).toBe(true);
        // 入口计数 = 条目数（不是域数）：实例层 = 10 条目 + 2 运维 + 3 安全 = **15**，
        // 用户层 = 7 条目（task-227 把三个模型域折成一个组条目）。
        const instanceCount = navItemsForLayer("instance").length + 5;
        expect(wrapper.find('[data-testid="settings-nav-count-instance"]').text()).toContain(
            String(instanceCount),
        );
        expect(wrapper.find('[data-testid="settings-nav-count-user"]').text()).toContain(
            String(navItemsForLayer("user").length),
        );
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
        // 条目总数同样是派生的（实例层 10 条目 + 5 运维/安全 = 15；task-227 之前是 17）。
        expect(wrapper.findAll('[data-slot="sidebar-menu-button"]').length).toBeGreaterThanOrEqual(
            navItemsForLayer("instance").length + 5,
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
