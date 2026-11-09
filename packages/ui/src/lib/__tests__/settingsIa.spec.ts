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
    settingsDomainPath,
    settingsLayerForPath,
    workspaceSettingsDomainPath,
    type ConfigDomain,
} from "../settingsIa";

/**
 * PLAN-0752 M1 / V3：层×域矩阵是路由注册、左栏与 404 判定的**同一份**来源。
 * 这些用例锁死 12 / 9 / 9 与「用户层没有 logging」两个事实，防止下次再靠推理改数
 * （task-63 的教训：能从 CP 源码读到的，不要从别处反推）。
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
    it("keeps the CP layer counts 12 / 9 / 9", () => {
        expect(domainsForLayer("instance")).toHaveLength(12);
        expect(domainsForLayer("user")).toHaveLength(9);
        expect(domainsForLayer("workspace")).toHaveLength(9);
    });

    it("treats logging as instance-only and approval-policy as instance+workspace", () => {
        expect(layersForDomain("logging")).toEqual(["instance"]);
        expect(layersForDomain("approval-policy")).toEqual(["instance", "workspace"]);
        expect(layersForDomain("job-policy")).toEqual(["instance", "workspace"]);
        expect(layersForDomain("agent-profile")).toEqual(["instance", "user"]);
        expect(layersForDomain("rag")).toEqual(["instance", "user", "workspace"]);
    });

    it("B4: workspace layer keeps its 9 writable domains (approval-policy/job-policy in, logging/agent-profile out)", () => {
        // PLAN-0752 M2 B4：工作区层从「tab 内嵌整层」升级为「按域段渲染单域」时，白名单必须原样保留。
        const workspace = domainsForLayer("workspace");
        expect(workspace).toHaveLength(9);
        expect(workspace).toContain("approval-policy");
        expect(workspace).toContain("job-policy");
        expect(workspace).not.toContain("logging");
        expect(workspace).not.toContain("agent-profile");
        expect(workspace).not.toContain("user-preference");
        expect(workspaceSettingsDomainPath("ws-1", "approval-policy")).toBe(
            "/workspace/ws-1/settings/approval-policy",
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
        expect(settingsLayerForPath("/workspace/ws-1/settings/rag")).toBe("workspace");
    });
});

describe("path helpers", () => {
    it("puts the layer in the URL", () => {
        expect(settingsDomainPath("instance", "rag")).toBe("/settings/instance/rag");
        expect(settingsDomainPath("user", "rag")).toBe("/settings/user/rag");
        expect(workspaceSettingsDomainPath("ws-1", "rag")).toBe("/workspace/ws-1/settings/rag");
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

    it("user layer has exactly one real resource entry and two gapped ones", () => {
        const items = userResourceGroup();
        expect(items.map((item) => item.id)).toEqual([
            "my-agents",
            "my-credentials",
            "knowledge-mcp",
        ]);
        const real = items.filter((item) => item.path);
        expect(real).toHaveLength(1);
        expect(real[0]?.id).toBe("my-credentials");
        // 已有后端承载的项指向已实现页面
        expect(real[0]?.path).toBe("/settings/credentials");
        expect(items.filter((item) => !item.path).map((item) => item.gaps)).toEqual([
            ["G4"],
            ["G1", "G3"],
        ]);
    });
});
