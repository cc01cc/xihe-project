import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { ApiError, api } from "../../composables/api";
import type * as apiModule from "../../composables/api";
import { usePolicyAdminStore } from "../policyAdmin";
import type { PolicyRuleView, PolicyToolFaceView } from "../../types";

const RULE_ID = "77777777-7777-4777-8777-777777777777",
    FACE_ID = "88888888-8888-4888-8888-888888888888",
    WORKSPACE_ID = "workspace-1";

vi.mock("../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listPolicyDomains: vi.fn<typeof apiModule.api.listPolicyDomains>(),
            listPolicyRules: vi.fn<typeof apiModule.api.listPolicyRules>(),
            listPolicyRuleConflicts: vi.fn<typeof apiModule.api.listPolicyRuleConflicts>(),
            createPolicyRule: vi.fn<typeof apiModule.api.createPolicyRule>(),
            deletePolicyRule: vi.fn<typeof apiModule.api.deletePolicyRule>(),
            listPolicyToolFaces: vi.fn<typeof apiModule.api.listPolicyToolFaces>(),
            upsertPolicyToolFace: vi.fn<typeof apiModule.api.upsertPolicyToolFace>(),
        },
    };
});

const rule: PolicyRuleView = {
    id: RULE_ID,
    layer: "workspace",
    ownerId: WORKSPACE_ID,
    actionClass: "exec",
    resource: "pnpm *",
    effect: "allow",
    priority: 0,
    locked: false,
    effective: true,
    conflict: null,
};

const face: PolicyToolFaceView = {
    id: null,
    scope: "builtin",
    ownerId: null,
    tool: "read_file",
    actionClass: "read",
    shape: "structured",
};

function forbidden(detail: string): ApiError {
    return new ApiError({ status: 403, code: "FORBIDDEN", detail, requestId: "test" });
}

beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(api.listPolicyDomains).mockResolvedValue([]);
    vi.mocked(api.listPolicyRules).mockResolvedValue([]);
    vi.mocked(api.listPolicyRuleConflicts).mockResolvedValue([]);
    vi.mocked(api.listPolicyToolFaces).mockResolvedValue([]);
});

describe("usePolicyAdminStore", () => {
    it("loads domains with their effective layers", async () => {
        vi.mocked(api.listPolicyDomains).mockResolvedValue([
            {
                actionClass: "exec",
                effectiveLayer: "workspace",
                configuredLayers: ["workspace"],
                ruleCounts: { workspace: 1 },
            },
        ]);
        const store = usePolicyAdminStore();

        await store.loadDomains();

        expect(store.domains).toHaveLength(1);
        expect(store.domains[0]?.effectiveLayer).toBe("workspace");
        expect(store.domainsError).toBeNull();
    });

    it("records a domain load failure without throwing at the caller", async () => {
        vi.mocked(api.listPolicyDomains).mockRejectedValue(new Error("backend down"));
        const store = usePolicyAdminStore();

        await store.loadDomains();

        // task-45：底层英文 message 不再直出（改前 `toContain("backend down")` 钉的是缺陷）
        expect(store.domainsError).not.toContain("backend down");
        expect(store.domainsError).toContain("请求失败");
    });

    it("marks a layer as forbidden when the server rejects the authenticated user", async () => {
        vi.mocked(api.listPolicyRules).mockRejectedValue(
            forbidden("workspace-layer rules require workspace OWNER or ADMIN"),
        );
        const store = usePolicyAdminStore();

        await store.loadRules("workspace");

        expect(store.rulesForbidden.workspace).toBe(true);
        // task-45：码与 CP 英文 detail 都不进用户文案
        expect(store.rulesError.workspace).not.toContain("FORBIDDEN");
        expect(store.rulesError.workspace).not.toContain("workspace-layer rules require");
    });

    it("creates a rule and refreshes the layer, conflicts and domains", async () => {
        vi.mocked(api.createPolicyRule).mockResolvedValue(rule);
        const store = usePolicyAdminStore();

        const created = await store.createRule({
            layer: "workspace",
            actionClass: "exec",
            resource: "pnpm *",
            effect: "allow",
            priority: 0,
            locked: false,
        });

        expect(created).toEqual(rule);
        expect(api.createPolicyRule).toHaveBeenCalledWith({
            layer: "workspace",
            actionClass: "exec",
            resource: "pnpm *",
            effect: "allow",
            priority: 0,
            locked: false,
        });
        expect(api.listPolicyRules).toHaveBeenCalledWith("workspace");
        expect(api.listPolicyRuleConflicts).toHaveBeenCalledWith("workspace");
        expect(api.listPolicyDomains).toHaveBeenCalledTimes(1);
        expect(store.rulesError.workspace).toBeNull();
    });

    it("surfaces a create failure through the thrown error and keeps the forbidden flag for 403", async () => {
        vi.mocked(api.createPolicyRule).mockRejectedValue(forbidden("locked rules require ADMIN"));
        const store = usePolicyAdminStore();

        await expect(
            store.createRule({
                layer: "instance",
                actionClass: "exec",
                resource: "*",
                effect: "ask",
                priority: 0,
                locked: true,
            }),
        ).rejects.toThrow("locked rules require ADMIN");

        expect(store.rulesForbidden.instance).toBe(true);
        expect(store.rulesError.instance).toBeNull();
    });

    it("deletes a rule and refreshes its layer", async () => {
        vi.mocked(api.deletePolicyRule).mockResolvedValue(undefined);
        const store = usePolicyAdminStore();

        await store.deleteRule(RULE_ID, "workspace");

        expect(api.deletePolicyRule).toHaveBeenCalledWith(RULE_ID, "workspace");
        expect(api.listPolicyRules).toHaveBeenCalledWith("workspace");
        expect(store.deletingRuleId).toBeNull();
    });

    it("classifies a tool and reloads the effective catalog for the scope", async () => {
        vi.mocked(api.upsertPolicyToolFace).mockResolvedValue({
            ...face,
            id: FACE_ID,
            scope: "workspace",
            ownerId: WORKSPACE_ID,
            actionClass: "exec",
            shape: "interpreter",
        });
        const store = usePolicyAdminStore();

        const result = await store.classifyTool({
            scope: "workspace",
            tool: "mcp_tool",
            actionClass: "exec",
            shape: "interpreter",
        });

        expect(result.actionClass).toBe("exec");
        expect(api.upsertPolicyToolFace).toHaveBeenCalledWith({
            scope: "workspace",
            tool: "mcp_tool",
            actionClass: "exec",
            shape: "interpreter",
        });
        expect(api.listPolicyToolFaces).toHaveBeenCalledWith("workspace");
        expect(store.toolFacesScope).toBe("workspace");
    });

    it("records a forbidden classification without retrying silently", async () => {
        vi.mocked(api.upsertPolicyToolFace).mockRejectedValue(
            forbidden("built-in face cannot be overridden"),
        );
        const store = usePolicyAdminStore();

        await expect(
            store.classifyTool({
                scope: "workspace",
                tool: "execute_command",
                actionClass: "read",
                shape: "structured",
            }),
        ).rejects.toThrow("built-in face cannot be overridden");

        expect(store.toolFacesForbidden).toBe(true);
        // task-78：工具面页是**诊断面** ⇒ store 存整份 presentation。三个字段各判一次：
        // 文案里不带码/原文（code 与 technicalDetail 走独立字段，页面左上角屏幕上的码）；
        // 码**必须留着** —— 页面要靠它「可见可复制」，丢了就又是「文案要求用户出示错误码」。
        expect(store.toolFacesError?.code).toBe("FORBIDDEN");
        expect(store.toolFacesError?.copy).not.toContain("FORBIDDEN");
        expect(store.toolFacesError?.technicalDetail).toContain(
            "built-in face cannot be overridden",
        );
    });

    it("marks the conflict summary unavailable instead of reporting none", async () => {
        vi.mocked(api.listPolicyRuleConflicts).mockRejectedValue(
            new Error("conflict endpoint down"),
        );
        const store = usePolicyAdminStore();

        await store.loadConflicts("workspace");

        expect(store.conflictsByLayer.workspace).toEqual([]);
        expect(store.conflictsError.workspace).not.toContain("conflict endpoint down");
        expect(store.conflictsError.workspace).toContain("请求失败");
    });

    it("resets catalog state between identity switches", async () => {
        vi.mocked(api.listPolicyToolFaces).mockResolvedValue([face]);
        const store = usePolicyAdminStore();
        await store.loadToolFaces("instance");
        expect(store.toolFaces).toHaveLength(1);

        store.reset();

        expect(store.toolFaces).toHaveLength(0);
        expect(store.domains).toHaveLength(0);
        // 空态必须是 null（不是 {}）—— 模板用 `v-if="toolFacesError"` 判空，空壳会让
        // 「无码时不渲染空壳」那条判据失效。
        expect(store.toolFacesError).toBeNull();
    });
});
