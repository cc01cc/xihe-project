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
    it("keeps the CP layer counts 12 / 9 for the two UI layers", () => {
        expect(domainsForLayer("instance")).toHaveLength(12);
        expect(domainsForLayer("user")).toHaveLength(9);
        // task-253：工作区层不是设置层，`SETTINGS_LAYERS` 里只能有这两项。
        expect(SETTINGS_LAYERS).toEqual(["instance", "user"]);
    });

    it("treats logging/approval-policy/job-policy as instance-only once the workspace layer is gone", () => {
        expect(layersForDomain("logging")).toEqual(["instance"]);
        expect(layersForDomain("approval-policy")).toEqual(["instance"]);
        expect(layersForDomain("job-policy")).toEqual(["instance"]);
        expect(layersForDomain("agent-profile")).toEqual(["instance", "user"]);
        expect(layersForDomain("rag")).toEqual(["instance", "user"]);
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
    it("instance layer keeps 4 resource slots, all marked with an audit gap code", () => {
        const items = instanceResourceGroup();
        expect(items.map((item) => item.id)).toEqual(["agents", "mcp", "credentials", "knowledge"]);
        // D7：留位标缺口，不隐藏 —— 4 条都没有 path（没有后端承载就没有可跳的页面）
        expect(items.every((item) => item.path === undefined)).toBe(true);
        expect(items.flatMap((item) => item.gaps ?? [])).toEqual(["G4", "G1", "G2", "G3"]);
        expect(items.every((item) => !!item.gapNoteKey)).toBe(true);
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
