import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { i18n } from "../../i18n";
import SettingsLayout from "../../layouts/SettingsLayout.vue";
import router from "../../router";
import {
    defaultLayerPath,
    defaultResourcePath,
    domainRouteExists,
    domainsForLayer,
    instanceOpsGroups,
    isInstanceOnlyForUser,
    layersForDomain,
    layersForResource,
    navItemsForLayer,
    resolveLayerRoute,
    resolveResourceLayer,
    RESOURCE_DEFS,
    resourceGroups,
    resourceLayerPath,
    resourcePath,
    SETTINGS_LAYERS,
    SETTINGS_LAYERS_LOW_TO_HIGH,
    settingsDomainPath,
    settingsLayerForPath,
    settingsPageTitleKey,
    type ConfigDomain,
    type SettingsLayer,
} from "../settingsIa";
// task-485：需要区分「域宇宙」与「设置矩阵」——前者不减，后者减了两格。
import { INSTANCE_DOMAINS } from "../../stores/config";

/**
 * PLAN-0752 M1 / V3：层×域矩阵是路由注册、左栏与 404 判定的**同一份**来源。
 * 这些用例锁死 12 / 9 与「用户层没有 logging」两个事实，防止下次再靠推理改数
 * （task-63 的教训：能从 CP 源码读到的，不要从别处反推）。
 *
 * task-253（用户 2026-11-10 裁定）：UI 侧只保留实例/用户两层 —— 工作区层从矩阵、路由与
 * 左栏一起移除（契约侧由 task-250 只标 deprecated）。凡带 workspace 的断言都已删除。
 */
// PLAN-0772 M2：知识库旧路径 `/settings/knowledge` 已随搬家**直接删除**（决策 10：不留 redirect），
// 所以旧的 `knowledgeRedirectTarget` 用例整段退场 —— 缺口落点改由 `/resources/knowledge` 承担。

describe("settings IA matrix", () => {
    it("keeps the layer counts 11 / 8 plus the 3-domain shared workspace-default layer", () => {
        // task-485 / task-226（用户 2026-11-14）：`agent-profile`（智能体个人）迁出设置区
        // ⇒ 实例层 12 → 11、用户层 9 → 8（**域宇宙仍是 12**，减的是矩阵格，不是域类）。
        expect(domainsForLayer("instance")).toHaveLength(11);
        expect(domainsForLayer("user")).toHaveLength(8);
        // D-1122 49A / PLAN-0766 T2.4（2026-11-13）：模型 4 域退出工作区层 ⇒ CP 的
        // WORKSPACE_WRITABLE_DOMAINS 变 5 域（4 个行为域 + service-only 的 context-templates），
        // 与 UI_DOMAINS（12）求交 = 4 域（ConfigService.java:115-118）。
        // task-485（2026-11-14，用户②「工作区没有智能体模板与角色」）：`agent-templates` 也撤下
        // ⇒ **3 域**。逐域钉死（不是只钉个数）：谁把模型域或模板域加回来，下面的 toEqual 立刻红。
        expect(domainsForLayer("workspace-default")).toEqual([
            "agent-runtime",
            "approval-policy",
            "job-policy",
        ]);
        // task-77：断言**语义顺序**，不再断言字面量（旧写法 `["instance","workspace-default","user"]`
        // 因 reverse 后恰好相等而长期假绿）。判据：低 → 高为 instance < personal < workspace-default
        // （与取值优先级 `workspace > workspace-default > personal > instance` 同义）。
        expect(SETTINGS_LAYERS_LOW_TO_HIGH).toEqual(["instance", "user", "workspace-default"]);
        expect(SETTINGS_LAYERS).toEqual([...SETTINGS_LAYERS_LOW_TO_HIGH]);
        expect(SETTINGS_LAYERS_LOW_TO_HIGH.indexOf("instance")).toBeLessThan(
            SETTINGS_LAYERS_LOW_TO_HIGH.indexOf("user"),
        );
        expect(SETTINGS_LAYERS_LOW_TO_HIGH.indexOf("user")).toBeLessThan(
            SETTINGS_LAYERS_LOW_TO_HIGH.indexOf("workspace-default"),
        );
        // 左栏自上而下 = 升序：instance 在最上、workspace-default 在最下。
        expect(SETTINGS_LAYERS[0]).toBe("instance");
        expect(SETTINGS_LAYERS.indexOf("user")).toBeLessThan(
            SETTINGS_LAYERS.indexOf("workspace-default"),
        );
    });

    it("treats logging/approval-policy/job-policy as instance-only once the workspace layer is gone", () => {
        expect(layersForDomain("logging")).toEqual(["instance"]);
        expect(layersForDomain("approval-policy")).toEqual(["instance", "workspace-default"]);
        expect(layersForDomain("job-policy")).toEqual(["instance", "workspace-default"]);
        // task-485：`agent-profile` 已迁出设置区 ⇒ 它在**设置矩阵里一格都没有**（空数组）。
        // 注意它仍是 CP 的合法域与 `ConfigDomain` 成员，成员页仍写它的 `userName` —— 这条断言
        // 锁的是「设置区不再有它的页」，不是「这个域不存在」（后者由紧随其后的域宇宙断言守）。
        expect(layersForDomain("agent-profile")).toEqual([]);
        expect(INSTANCE_DOMAINS).toContain("agent-profile");
        // D-1122 / T2.4：模型 4 域退出工作区层 ⇒ 它们**不再**出现在 workspace-default。
        // 这四条是与 CP WORKSPACE_WRITABLE_DOMAINS 逐域对齐的机器判据（矩阵被改回即红）。
        expect(layersForDomain("rag")).toEqual(["instance", "user"]);
        expect(layersForDomain("llm-provider")).toEqual(["instance", "user"]);
        expect(layersForDomain("context-policy")).toEqual(["instance", "user"]);
        expect(layersForDomain("embedding")).toEqual(["instance", "user"]);
    });

    it("routes only the four writable domains on the workspace-default layer", () => {
        // PLAN-0766 T3.1/T3.3：路由注册与左栏共用同一矩阵 ⇒ 这里锁死「哪些域有页」。
        expect(resolveLayerRoute("workspace-default", "agent-runtime")).toEqual({
            ok: true,
            layer: "workspace-default",
            domain: "agent-runtime",
        });
        // D-1122 / T2.4：模型域退出该层 ⇒ 它们的路径**不再注册**（不是"注册了再 400"）。
        expect(resolveLayerRoute("workspace-default", "llm-provider")).toEqual({
            ok: false,
            reason: "domain-not-in-layer",
        });
        expect(resolveLayerRoute("workspace-default", "embedding")).toEqual({
            ok: false,
            reason: "domain-not-in-layer",
        });
        // 不可写域 = 矩阵里没有 ⇒ 路由不注册 ⇒ 同一条路径落到 404 兜底。
        expect(resolveLayerRoute("workspace-default", "agent-profile")).toEqual({
            ok: false,
            reason: "domain-not-in-layer",
        });
        expect(resolveLayerRoute("workspace-default", "logging")).toEqual({
            ok: false,
            reason: "domain-not-in-layer",
        });
    });

    it("derives the workspace-default layer from the URL and lands on its first domain", () => {
        expect(settingsLayerForPath("/settings/workspace-default/rag")).toBe("workspace-default");
        expect(settingsLayerForPath("/settings/user/rag")).toBe("user");
        expect(settingsLayerForPath("/settings/anything-else")).toBe("instance");
        expect(settingsDomainPath("workspace-default", "rag")).toBe(
            "/settings/workspace-default/rag",
        );
        // 默认页 = 矩阵第一项。T2.4 后第一项是 agent-runtime（模型域已退出该层），
        // 所以这条断言同时钉住「默认页跟着矩阵走」与「模型域不再作首域」两件事。
        expect(defaultLayerPath("workspace-default")).toBe(
            "/settings/workspace-default/agent-runtime",
        );
    });
    it("marks exactly the three user-layer gaps as instance-only for the user layer", () => {
        const instanceOnly = domainsForLayer("instance").filter((domain) =>
            isInstanceOnlyForUser(domain),
        );
        expect(instanceOnly).toEqual(["logging", "approval-policy", "job-policy"]);
    });
});

describe("resolveLayerRoute", () => {
    it("resolves combinations the matrix does have", () => {
        expect(resolveLayerRoute("instance", "rag")).toEqual({
            ok: true,
            layer: "instance",
            domain: "rag",
        });
        // task-485：`agent-profile` 在两层都不再解析成域路由（旧 URL 由 router 的 302 兜住，
        // 不走矩阵）；改用仍在两层矩阵里的 `agent-templates` 作为"合法组合"的正例。
        expect(resolveLayerRoute("user", "agent-templates")).toEqual({
            ok: true,
            layer: "user",
            domain: "agent-templates",
        });
    });

    it("rejects user-layer logging (V3: route must not exist)", () => {
        expect(resolveLayerRoute("user", "logging")).toEqual({
            ok: false,
            reason: "domain-not-in-layer",
        });
        expect(domainRouteExists("user", "logging")).toBe(false);
    });

    it("rejects unknown layers and domains", () => {
        expect(resolveLayerRoute("global", "rag")).toEqual({ ok: false, reason: "unknown-layer" });
        expect(resolveLayerRoute("instance", "nope")).toEqual({
            ok: false,
            reason: "unknown-domain",
        });
        expect(domainRouteExists("workspace", "agent-profile")).toBe(false);
    });
});

describe("settingsLayerForPath (404 兜底路由的层推导)", () => {
    it("reads the layer out of the URL instead of trusting a hardcoded meta", () => {
        expect(settingsLayerForPath("/settings/user/logging")).toBe("user");
        expect(settingsLayerForPath("/settings/instance/rag")).toBe("instance");
        expect(settingsLayerForPath("/settings/user/rag")).toBe("user");
        expect(settingsLayerForPath("/settings/nope")).toBe("instance");
    });
});

describe("path helpers", () => {
    it("puts the layer in the URL", () => {
        expect(settingsDomainPath("instance", "rag")).toBe("/settings/instance/rag");
        expect(settingsDomainPath("user", "rag")).toBe("/settings/user/rag");
    });

    it("defaults to the first domain of the layer", () => {
        expect(defaultLayerPath("instance")).toBe("/settings/instance/llm-provider");
        expect(defaultLayerPath("user")).toBe("/settings/user/llm-provider");
    });
});

describe("instance ops groups", () => {
    it("keeps the design's two groups with seven entries", () => {
        const groups = instanceOpsGroups();
        expect(groups.map((group) => group.id)).toEqual(["ops", "security"]);
        // task-74 T3.3 后 tool-faces 已并入 approval-policy 域页签，运维分组回到 2 项（不再有过渡项）。
        //
        // 这条钉的是「实例层运维与安全两组的**精确成员表**」，不是「有几条」——所以新增条目
        // 必须显式列进这里（task-8 加 `authorization-overview`），不许改成「等于当前实际有什么」。
        expect(groups.flatMap((group) => group.items.map((item) => item.id))).toEqual([
            "monitoring",
            "data",
            "config-locks",
            "roles",
            // task-91：平台智能体的落点（资源区摘除后它的新家）。
            "agent-principals",
            "audit",
            // task-8：授权总览（安全组末尾；已登录者视角，人人可见）。
            "authorization-overview",
        ]);
        const domains = domainsForLayer("instance") as readonly ConfigDomain[];
        expect(domains).toContain("logging");
    });
});
/**
 * task-74（**只加守卫测试**，不改产品行为）：面包屑末段「没有第三条路」。
 *
 * <p>缺陷面（task-73 盘点 R1）：末段只有三个来源 —— L1 组（`meta.settingsGroup` →
 * `group.labelKey`，`SettingsLayout.vue:85-88`）、L2 域（`meta.settingsDomain` →
 * `DOMAIN_LABEL_KEY[domain]`，`:89-90`）、L3 页标题键（`settingsPageTitleKey(path)`，
 * `:93-94`）。三路都不命中就落 L4（`undefined`），`SettingsLayerHeader.vue:129-136` 会把
 * **层段**标成当前页 —— 面包屑读作「设置 › 实例层」，用户看不到自己在哪一页。</p>
 *
 * <p>新建一个既不是域也不是组的设置页、又忘登记 `pageTitleKey` 时，这个退化是**静默**的：
 * 改动前没有任何用例会红。本文件让「没有第四条路」变成必须红的一条断言 —— 而且断言的是
 * **布局真实渲染出的末段**（挂 `SettingsLayout`、只看它传给 `SettingsLayerHeader` 的
 * `domain`），不是把回落链在测试里抄一遍：抄一遍的写法在有人删掉 L3 分支时依然全绿。</p>
 *
 * <p>分支不按路径字符串猜：路由 `meta` 用 `router.resolve(path)` 取真路由表那一份
 * （设置路由的 meta 由 `router/index.ts` 从 `LAYER_DOMAINS` / `SETTINGS_GROUPS` 派生）。</p>
 */
const routeState = vi.hoisted(() => ({
    path: "/settings/instance/rag",
    meta: {} as Record<string, unknown>,
}));

// 只替换 useRoute / useRouter：router/index.ts 仍要真的 createRouter / createWebHistory 与
// resolve（meta 必须来自产品路由表）。骨架同 `layouts/__tests__/SettingsLayout.backToChat.spec.ts:52-70`。
vi.mock("vue-router", async (importOriginal) => {
    const actual = await importOriginal<typeof import("vue-router")>();
    return {
        ...actual,
        useRoute: () => ({
            meta: routeState.meta,
            path: routeState.path,
            fullPath: routeState.path,
            query: {},
        }),
        useRouter: () => ({
            push: vi.fn<() => Promise<void>>(),
            replace: vi.fn<() => Promise<void>>(),
        }),
    };
});

type RegisteredEntry = { layer: SettingsLayer; id: string; labelKey: string; path: string };

const REGISTERED_ENTRIES: RegisteredEntry[] = (() => {
    const entries: RegisteredEntry[] = [];
    for (const layer of SETTINGS_LAYERS) {
        for (const item of navItemsForLayer(layer)) {
            entries.push({ layer, id: item.id, labelKey: item.labelKey, path: item.path });
        }
    }
    for (const group of instanceOpsGroups()) {
        for (const item of group.items) {
            entries.push({
                layer: "instance",
                id: item.id,
                labelKey: item.labelKey,
                path: item.path,
            });
        }
    }
    return entries;
})();

/**
 * 跑一次真实布局，返回面包屑末段（= 布局传给 `SettingsLayerHeader` 的 `domain`）。
 * 空串 = 落 L4。只 stub 重子组件，布局自己的回落链一行不 stub。
 */
function tailRenderedFor(path: string): string {
    routeState.path = path;
    routeState.meta = router.resolve(path).meta as Record<string, unknown>;
    const wrapper = mount(SettingsLayout, {
        global: {
            plugins: [i18n, createPinia()],
            stubs: {
                SettingsSidebar: { template: '<div data-testid="settings-sidebar-stub" />' },
                SettingsLayerHeader: {
                    props: { layer: String, domain: String, trail: Array },
                    template:
                        '<div data-testid="settings-breadcrumb-tail">{{ domain ?? "" }}</div>',
                },
                BackToChatButton: { template: "<button />" },
                RouterView: { template: '<div data-testid="router-view-stub" />' },
            },
        },
    });
    const tail = wrapper.find('[data-testid="settings-breadcrumb-tail"]').text();
    wrapper.unmount();
    return tail;
}

describe("面包屑末段标题来源守卫（task-74）", () => {
    it("全部已登记 path 的末段标题 = 页标题键，或该条目自己的 labelKey（没有第三条路）", () => {
        // task-73 盘点读数：23 条（instance 15 = 8 域/组 + 7 运维安全 / user 5 / workspace-default 3）
        // ⇒ 新增或删除条目时这条必须显式跟着改，不许改成「等于当前实际有什么」。
        expect(REGISTERED_ENTRIES).toHaveLength(23);

        // 左栏条目必须真有条：新增条目却忘了注册路由 ⇒ 点进去 404，先在这里红。
        const unrouted = REGISTERED_ENTRIES.filter(
            (entry) => router.resolve(entry.path).name === "settings-not-found",
        ).map((entry) => `${entry.layer}/${entry.id} → ${entry.path}`);
        expect(unrouted).toEqual([]);

        // L3 命中的**精确成员表**（task-73 读数：7 条，占 23 条的 30%，全在 instance 运维/安全组）。
        const keyed = REGISTERED_ENTRIES.filter(
            (entry) => settingsPageTitleKey(entry.path) !== undefined,
        );
        expect(keyed.map((entry) => entry.id)).toEqual([
            "monitoring",
            "data",
            "config-locks",
            "roles",
            "agent-principals",
            "audit",
            "authorization-overview",
        ]);
        expect(REGISTERED_ENTRIES.length - keyed.length).toBe(16);

        // 没有第三条路：L3 未命中的每一条都必须靠 L1/L2 拿到**该条目自己的** labelKey
        // （= 目的页标题键，域页 h2 与组页 h2 读同一个键）。宽判据（不抛错 / 命中任一）不算。
        const mismatched = REGISTERED_ENTRIES.flatMap((entry) => {
            const expected = i18n.global.t(settingsPageTitleKey(entry.path) ?? entry.labelKey);
            const actual = tailRenderedFor(entry.path);
            return actual === expected
                ? []
                : [
                      `${entry.layer}/${entry.id}: ${entry.path} 期望「${expected}」实渲染「${actual}」`,
                  ];
        });
        expect(mismatched).toEqual([]);
    });

    it("未登记的 path 落 L4：末段不渲染（显式可测，不是无声退化）", () => {
        const path = "/settings/instance/__unknown";
        const resolved = router.resolve(path);
        expect(resolved.name).toBe("settings-not-found");
        expect(resolved.meta.settingsGroup).toBeUndefined();
        expect(resolved.meta.settingsDomain).toBeUndefined();
        expect(settingsPageTitleKey(path)).toBeUndefined();
        // 布局把末段留空 ⇒ SettingsLayerHeader.vue:129-136 把层段标成当前页；那条可见行为由
        // components/settings/__tests__/SettingsLayerHeader.spec.ts:53-68 锁，这里锁它的输入侧。
        expect(tailRenderedFor(path)).toBe("");
    });
});

describe("资源×层矩阵（PLAN-0772 M2）", () => {
    it("四个资源 + 各自的真实层（缺的层不许自己补）", () => {
        // task-96（用户裁定「智能体是组织成员，不是资源」）：智能体撤出资源面 ⇒ 5 → 4。
        // 三层落点仍各有页面，但**不在资源区**（个人 → `/members`、平台 → 实例层设置页、工作区不变），
        // 旧 URL 由 `router/index.ts` 302 承接；判据在 `router/__tests__/agentLandingRoutes.spec.ts`。
        expect(RESOURCE_DEFS.map((def) => def.id)).toEqual([
            "credentials",
            "mcp",
            "skills",
            "knowledge",
        ]);
        // 凭据三层都是真实体（`owner_type = USER / WORKSPACE / INSTANCE`，D-1007）。
        expect(layersForResource("credentials")).toEqual(["USER", "WORKSPACE", "INSTANCE"]);
        // MCP 没有个人层：`mcp_remote_servers.workspace_id NOT NULL`（audit §F G1）。
        expect(layersForResource("mcp")).toEqual(["WORKSPACE", "INSTANCE"]);
        // 技能三层都是真实体（`T2b.2` 交付个人层后）；个人层**不带 `requires`** ——
        // 读面不挂原子（P-189-3：撤销 `MANAGE_PERSONAL_SKILLS` 后读仍开放），原子只门写面。
        expect(layersForResource("skills")).toEqual(["USER", "WORKSPACE", "INSTANCE"]);
        expect(
            RESOURCE_DEFS.find((def) => def.id === "skills")!.layerRules.find(
                (rule) => rule.layer === "USER",
            ),
        ).toEqual({ layer: "USER" });
        // 知识库是后端缺口（G3），一层都没有。
        expect(layersForResource("knowledge")).toEqual([]);
    });

    it("resourceGroups() = 4 条目，且只有 knowledge 是缺口（无 path）", () => {
        const items = resourceGroups();
        expect(items.map((item) => item.id)).toEqual(["credentials", "mcp", "skills", "knowledge"]);
        // 硬编码路径：搬家后一律 `/resources/<id>`（层在 ?layer，不进路径段）。
        expect(items.map((item) => item.path)).toEqual([
            "/resources/credentials",
            "/resources/mcp",
            "/resources/skills",
            undefined,
        ]);
        const gapped = items.filter((item) => (item.gaps ?? []).length > 0);
        expect(gapped.map((item) => item.id)).toEqual(["knowledge"]);
        expect(gapped.flatMap((item) => item.gaps ?? [])).toEqual(["G3"]);
        expect(gapped.every((item) => !!item.gapNoteKey)).toBe(true);
    });

    it("`?layer` 解析：大小写都收、非法回落默认层、不存在的层回落默认层", () => {
        expect(resolveResourceLayer("credentials", "WORKSPACE")).toBe("WORKSPACE");
        expect(resolveResourceLayer("credentials", "workspace")).toBe("WORKSPACE");
        expect(resolveResourceLayer("credentials", "USER")).toBe("USER");
        expect(resolveResourceLayer("credentials", "INSTANCE")).toBe("INSTANCE");
        expect(resolveResourceLayer("credentials", undefined)).toBe("USER");
        expect(resolveResourceLayer("credentials", "nope")).toBe("USER");
        // task-145 / DSD-1511：mcp 的 WORKSPACE 层已迁出 ⇒ 可见层只剩 INSTANCE，
        // 于是 `?layer=USER`（本来也没有个人层）落回 INSTANCE，不是 404、不是空页。
        expect(resolveResourceLayer("mcp", "USER")).toBe("INSTANCE");
        expect(resolveResourceLayer("mcp", "WORKSPACE")).toBe("INSTANCE");
        expect(resolveResourceLayer("mcp", undefined)).toBe("INSTANCE");
        // 技能个人层「存在但后端未实现」⇒ 解析仍认它（tab 要能选中并解释为什么不能用）。
        expect(resolveResourceLayer("skills", "user")).toBe("USER");
        // 技能的声明默认层是 WORKSPACE（已迁出）⇒ 缺省与已迁层都落可见层首项 USER。
        expect(resolveResourceLayer("skills", "WORKSPACE")).toBe("USER");
        expect(resolveResourceLayer("skills", undefined)).toBe("USER");
    });

    it("深链形态：`?layer=` 大写、层不进路径段", () => {
        expect(resourcePath("skills")).toBe("/resources/skills");
        expect(resourceLayerPath("skills", "WORKSPACE")).toBe("/resources/skills?layer=WORKSPACE");
        // 大小写都收：换 skills 继续钉同一解析器 —— 但 WORKSPACE 已迁出 ⇒ 落 USER。
        expect(resolveResourceLayer("skills", "workspace")).toBe("USER");
        // 默认层**不因新增层而改变**（仍是个人主体）：工作区层只在显式 `?layer=` 时进入。
        expect(defaultResourcePath()).toBe("/resources/credentials?layer=USER");
        expect(defaultResourcePath()).toBe("/resources/credentials?layer=USER");
    });

    it("层门槛只来自 CP 守卫原文（能力位或原子），不出现角色名特判", () => {
        const requires = RESOURCE_DEFS.flatMap((def) =>
            def.layerRules.map((rule) => rule.requires),
        ).filter((value): value is { capability: "instance:admin" } | { atom: string } => !!value);
        // task-447（D-1286）：**只剩凭据实例层**挂能力位 —— CP `InstanceCredentialController`
        // 的 list/detail/create/delete/reveal 全部 `@PreAuthorize(holdsCapabilityAtom('instance:admin'))`
        // （`:61/80/98/120/152`）⇒ 读面本身就是能力位守卫，tab 置灰是**照实**不是收窄。
        // MCP / 智能体 / 技能实例层的**读面**对任何已认证调用者开放，所以都不挂门槛：
        // - MCP：`openapi.yaml:5079`「Read face is open to every authenticated caller」，写面才是
        //   能力位（`:5102`）⇒ 由 `InstanceMcpPanel` 守；该端点 CP 尚未实现（PLANNED_APIS，
        //   `RouteContractParityTest:216-217`）⇒ 缺口由错误面照实显示，不用 403 卡片打扮。
        // - 智能体：CP `InstanceAgentPrincipalController:75` 是 `isAuthenticated()`，写面才是双门
        //   （`:61-62` 能力位 AND `MANAGE_AGENT_PRINCIPALS`）⇒ 由 `InstanceAgentsPanel.canWrite` 守。
        // 挂门槛会让非管理员**连读都读不到**（比看不到按钮严重得多，与 skills 个人层同一裁定）。
        expect(requires).toEqual([{ capability: "instance:admin" }]);
        // 逐条钉「读面开放」不是漏写：这两条实例层规则**必须**只有 layer 字段。
        for (const id of ["mcp", "skills"] as const) {
            expect(
                RESOURCE_DEFS.find((def) => def.id === id)!.layerRules.find(
                    (rule) => rule.layer === "INSTANCE",
                ),
                id,
            ).toEqual({ layer: "INSTANCE" });
        }
        // 凭据实例层仍挂能力位（不许顺手一起放开）。
        expect(
            RESOURCE_DEFS.find((def) => def.id === "credentials")!.layerRules.find(
                (rule) => rule.layer === "INSTANCE",
            ),
        ).toEqual({ layer: "INSTANCE", requires: { capability: "instance:admin" } });
        // 资源面不进配置矩阵（D-1006 B6）：资源 id 不得出现在任何层的域名单里。
        const domains = domainsForLayer("instance") as readonly string[];
        for (const def of RESOURCE_DEFS) expect(domains).not.toContain(def.id);
    });
});
