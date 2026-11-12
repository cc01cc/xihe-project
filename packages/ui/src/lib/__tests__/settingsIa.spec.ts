import { describe, expect, it } from "vitest";
import {
    defaultLayerPath,
    defaultResourcePath,
    domainRouteExists,
    domainsForLayer,
    instanceOpsGroups,
    isInstanceOnlyForUser,
    layersForDomain,
    layersForResource,
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
    type ConfigDomain,
} from "../settingsIa";

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
    it("keeps the CP layer counts 12 / 9 plus the 8-domain shared workspace-default layer", () => {
        expect(domainsForLayer("instance")).toHaveLength(12);
        expect(domainsForLayer("user")).toHaveLength(9);
        // PLAN-0766（task-160）：CP 的 WORKSPACE_WITABLE 是 9 域，但 context-templates 是
        // service-only 域（config API 只收 12 个 UI 域）⇒ UI 矩阵是 9 − 1 = 8，且不含
        // per-workspace 的旧 workspace 层（task-253 已退役）。
        expect(domainsForLayer("workspace-default")).toHaveLength(8);
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
        expect(layersForDomain("agent-profile")).toEqual(["instance", "user"]);
        // 顺序 = 显示顺序（低 → 高，取 SETTINGS_LAYERS 的过滤结果）：instance → user → workspace-default
        expect(layersForDomain("rag")).toEqual(["instance", "user", "workspace-default"]);
    });

    it("routes only the eight writable domains on the workspace-default layer", () => {
        // PLAN-0766 T3.1/T3.3：路由注册与左栏共用同一矩阵 ⇒ 这里锁死「哪些域有页」。
        expect(resolveLayerRoute("workspace-default", "llm-provider")).toEqual({
            ok: true,
            layer: "workspace-default",
            domain: "llm-provider",
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
        expect(defaultLayerPath("workspace-default")).toBe(
            "/settings/workspace-default/llm-provider",
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
        expect(resolveLayerRoute("user", "agent-profile")).toEqual({
            ok: true,
            layer: "user",
            domain: "agent-profile",
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
    it("keeps the design's two groups with five entries", () => {
        const groups = instanceOpsGroups();
        expect(groups.map((group) => group.id)).toEqual(["ops", "security"]);
        // task-74 T3.3 后 tool-faces 已并入 approval-policy 域页签，运维分组回到 2 项（不再有过渡项）。
        expect(groups.flatMap((group) => group.items.map((item) => item.id))).toEqual([
            "monitoring",
            "data",
            "config-locks",
            "roles",
            "audit",
        ]);
        const domains = domainsForLayer("instance") as readonly ConfigDomain[];
        expect(domains).toContain("logging");
    });
});
describe("资源×层矩阵（PLAN-0772 M2）", () => {
    it("五个资源 + 各自的真实层（缺的层不许自己补）", () => {
        expect(RESOURCE_DEFS.map((def) => def.id)).toEqual([
            "credentials",
            "mcp",
            "skills",
            "agents",
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
        // 智能体三层（task-203，用户 2026-11-12「成员入口的 agent principal 也别漏了」）：
        // 个人主体（`agent-principals`）+ **工作区成员/绑定面**（`WorkspaceAgentsPanel`，
        // 写面 CP 守工作区档原子 `MANAGE_WORKSPACE_AGENTS`）+ 平台智能体（能力位 `instance:admin`）。
        expect(layersForResource("agents")).toEqual(["USER", "WORKSPACE", "INSTANCE"]);
        // 知识库是后端缺口（G3），一层都没有。
        expect(layersForResource("knowledge")).toEqual([]);
    });

    it("resourceGroups() = 5 条目，且只有 knowledge 是缺口（无 path）", () => {
        const items = resourceGroups();
        expect(items.map((item) => item.id)).toEqual([
            "credentials",
            "mcp",
            "skills",
            "agents",
            "knowledge",
        ]);
        // 硬编码路径：搬家后一律 `/resources/<id>`（层在 ?layer，不进路径段）。
        expect(items.map((item) => item.path)).toEqual([
            "/resources/credentials",
            "/resources/mcp",
            "/resources/skills",
            "/resources/agents",
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
        // MCP 没有个人层 ⇒ `?layer=USER` 落回它的默认层（WORKSPACE），不是 404、不是空页。
        expect(resolveResourceLayer("mcp", "USER")).toBe("WORKSPACE");
        // 技能个人层「存在但后端未实现」⇒ 解析仍认它（tab 要能选中并解释为什么不能用）。
        expect(resolveResourceLayer("skills", "user")).toBe("USER");
    });

    it("深链形态：`?layer=` 大写、层不进路径段", () => {
        expect(resourcePath("skills")).toBe("/resources/skills");
        expect(resourceLayerPath("skills", "WORKSPACE")).toBe("/resources/skills?layer=WORKSPACE");
        // task-203：智能体工作区层是**可分享深链**（成员/绑定面），大小写与缺省都走同一解析器。
        expect(resourceLayerPath("agents", "WORKSPACE")).toBe("/resources/agents?layer=WORKSPACE");
        expect(resolveResourceLayer("agents", "workspace")).toBe("WORKSPACE");
        // 默认层**不因新增层而改变**（仍是个人主体）：工作区层只在显式 `?layer=` 时进入。
        expect(defaultResourcePath()).toBe("/resources/credentials?layer=USER");
        expect(defaultResourcePath()).toBe("/resources/credentials?layer=USER");
    });

    it("层门槛只来自 CP 守卫原文（能力位或原子），不出现角色名特判", () => {
        const requires = RESOURCE_DEFS.flatMap((def) =>
            def.layerRules.map((rule) => rule.requires),
        ).filter((value): value is { capability: "instance:admin" } | { atom: string } => !!value);
        // 三个实例层（凭据 / MCP / 智能体）用 CP 自己的 `instance:admin` 守卫；
        // 技能实例层的**读面**对任何已认证调用者开放（openapi 原文），所以没有门槛。
        expect(requires).toEqual([
            { capability: "instance:admin" },
            { capability: "instance:admin" },
            { capability: "instance:admin" },
        ]);
        // 资源面不进配置矩阵（D-1006 B6）：资源 id 不得出现在任何层的域名单里。
        const domains = domainsForLayer("instance") as readonly string[];
        for (const def of RESOURCE_DEFS) expect(domains).not.toContain(def.id);
    });
});
