import { describe, expect, it } from "vitest";
import {
    defaultLayerPath,
    domainRouteExists,
    domainsForLayer,
    instanceOpsGroups,
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
    it("keeps the design's two groups; tool-faces sits in ops until 批 C folds it into the domain", () => {
        const groups = instanceOpsGroups();
        expect(groups.map((group) => group.id)).toEqual(["ops", "security"]);
        // task-74：tool-faces 不是配置域（CP 12 域里没有它），先按独立页挂「实例运维」；
        // 批 C（tasks.md T3.3）把它并入 approval-policy 域页签时，这一项要同步删掉。
        expect(groups.flatMap((group) => group.items.map((item) => item.id))).toEqual([
            "monitoring",
            "data",
            "tool-faces",
            "config-locks",
            "roles",
            "audit",
        ]);
        const domains = domainsForLayer("instance") as readonly ConfigDomain[];
        expect(domains).toContain("logging");
    });
});
