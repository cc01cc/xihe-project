import { describe, expect, it } from "vitest";
import {
    defaultLayerPath,
    domainRouteExists,
    domainsForLayer,
    instanceOpsGroups,
    instanceResourceGroup,
    knowledgeRedirectTarget,
    userResourceGroup,
    isInstanceOnlyForUser,
    layersForDomain,
    resolveLayerRoute,
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
// PLAN-0752 T4.4（task-91）：知识库旧路径不能落在「用户层知识库页」上。
describe("knowledgeRedirectTarget", () => {
    it("sends the legacy /settings/knowledge bookmark to the workspace knowledge tab", () => {
        expect(knowledgeRedirectTarget("ws-1")).toEqual({
            name: "workspace-settings",
            params: { workspaceId: "ws-1" },
            query: { tab: "knowledge" },
        });
    });

    it("falls back to the workspace picker when there is no workspace context", () => {
        expect(knowledgeRedirectTarget(null)).toEqual({ name: "workspace-home" });
        expect(knowledgeRedirectTarget("   ")).toEqual({ name: "workspace-home" });
    });
});

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
describe("settings IA resource groups (PLAN-0752 T4.0/T4.1)", () => {
    it("instance layer keeps 4 gap slots and exactly one real entry (skills, task-83)", () => {
        const items = instanceResourceGroup();
        expect(items.map((item) => item.id)).toEqual([
            "agents",
            "mcp",
            "credentials",
            "skills",
            "knowledge",
        ]);
        // D7：留位标缺口，不隐藏 —— 4 条缺口都没有 path（没有后端承载就没有可跳的页面）
        const gapped = items.filter((item) => (item.gaps ?? []).length > 0);
        expect(gapped.map((item) => item.id)).toEqual([
            "agents",
            "mcp",
            "credentials",
            "knowledge",
        ]);
        expect(gapped.every((item) => item.path === undefined)).toBe(true);
        expect(gapped.flatMap((item) => item.gaps ?? [])).toEqual(["G4", "G1", "G2", "G3"]);
        expect(gapped.every((item) => !!item.gapNoteKey)).toBe(true);
        // task-83：技能是这一组里唯一后端已就绪的（`GET /skills` 默认 instance scope）⇒
        // 真入口，且**不带**缺口标记（与用户层 agent-principals「转真就摘缺口」一致）。
        const real = items.filter((item) => item.path);
        expect(real.map((item) => item.id)).toEqual(["skills"]);
        expect(real.map((item) => item.path)).toEqual(["/settings/skills"]);
        expect(real[0]?.gaps).toBeUndefined();
        expect(real[0]?.gapNoteKey).toBeUndefined();
    });

    it("user layer has two real resource entries and one gapped one (PLAN-0750 M3)", () => {
        const items = userResourceGroup();
        expect(items.map((item) => item.id)).toEqual([
            "agent-principals",
            "my-credentials",
            "knowledge-mcp",
        ]);
        // PLAN-0750 M3（矩阵 U3）：用户级创建入口落地后，「智能体主体」从缺口转真入口。
        const real = items.filter((item) => item.path);
        expect(real.map((item) => item.id)).toEqual(["agent-principals", "my-credentials"]);
        expect(real.map((item) => item.path)).toEqual([
            "/settings/agent-principals",
            "/settings/credentials",
        ]);
        // 缺口机制本身必须留着：knowledge-mcp 仍按 D7 留位（G1/G3）。
        const gaps = items.filter((item) => !item.path);
        expect(gaps.map((item) => item.id)).toEqual(["knowledge-mcp"]);
        expect(gaps.map((item) => item.gaps)).toEqual([["G1", "G3"]]);
        // 「智能体主体」不再是缺口：既没有 gaps，也没有缺口说明文案键。
        const agentPrincipals = items.find((item) => item.id === "agent-principals");
        expect(agentPrincipals?.gaps).toBeUndefined();
        expect(agentPrincipals?.gapNoteKey).toBeUndefined();
    });
});
