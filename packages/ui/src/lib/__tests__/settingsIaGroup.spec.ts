import { describe, expect, it } from "vitest";
import { INSTANCE_DOMAINS, LAYER_DOMAINS } from "../../stores/config";
import {
    AGENT_CONFIG_DOMAINS,
    AGENT_CONFIG_GROUP_ID,
    agentConfigDomainsForLayer,
    groupDefFor,
    isAgentConfigGroup,
    isModelConfigGroup,
    isSettingsGroup,
    MODEL_CONFIG_DOMAINS,
    MODEL_CONFIG_GROUP_ID,
    modelConfigDomainsForLayer,
    navItemsForLayer,
    resolveLayerRoute,
    SETTINGS_GROUPS,
    settingsGroupPath,
} from "../settingsIa";

/**
 * 组页（「合页，不合域」）的派生层判据（纯逻辑，无 DOM）。
 *
 * <p>判据分两半：①**组 id 不是域 id**（这是"不合域"的机器证据 —— 谁把组 id 塞进
 * `INSTANCE_DOMAINS` 或 `LAYER_DOMAINS`，下面第一条就红）；②每层实际几段由**矩阵求交集**得出，
 * 组件/路由/左栏三处都用这一个函数，所以不存在"页面画三段而左栏折两段"的漂移。</p>
 *
 * <p>task-485（2026-11-14）：组从"一个组的特例"泛化成注册表 —— 现有两组
 * `model-config`（task-227）与 `agent-config`（用户 2026-11-14 ③「智能体模板与角色应该放到
 * 智能体配置里」）。所以本文件对**两组**都跑同一批判据：组 id 不是域、段数 = 交集、左栏折叠位置。</p>
 */
describe("settingsIa · 组注册表（task-485 泛化）", () => {
    it("两个组都在注册表里，组 id 都不是域 id、也都不进矩阵", () => {
        expect(SETTINGS_GROUPS.map((group) => group.id)).toEqual([
            MODEL_CONFIG_GROUP_ID,
            AGENT_CONFIG_GROUP_ID,
        ]);
        expect(MODEL_CONFIG_GROUP_ID).toBe("model-config");
        expect(AGENT_CONFIG_GROUP_ID).toBe("agent-config");
        for (const group of SETTINGS_GROUPS) {
            expect((INSTANCE_DOMAINS as readonly string[]).includes(group.id)).toBe(false);
            for (const layer of ["instance", "user", "workspace-default", "workspace"] as const) {
                expect((LAYER_DOMAINS[layer] as readonly string[]).includes(group.id)).toBe(false);
            }
            // 「不合域」的可执行判据：组 id 解析不出域路由（否则 CP 会收到 /config/<组id>/meta 必 400）。
            expect(resolveLayerRoute("instance", group.id)).toEqual({
                ok: false,
                reason: "unknown-domain",
            });
            expect(isSettingsGroup(group.id)).toBe(true);
            expect(groupDefFor(group.id)?.domains).toEqual([...group.domains]);
        }
        expect(isSettingsGroup("nope")).toBe(false);
        expect(isModelConfigGroup("agent-config")).toBe(false);
        expect(isAgentConfigGroup("agent-config")).toBe(true);
    });
});

describe("settingsIa · 模型配置组（task-227）", () => {
    it("每层几段 = 矩阵交集（instance 3 / user 3 / workspace-default 0）", () => {
        expect(modelConfigDomainsForLayer("instance")).toEqual([
            "llm-provider",
            "context-policy",
            "api-request-templates",
        ]);
        expect(modelConfigDomainsForLayer("user")).toEqual([
            "llm-provider",
            "context-policy",
            "api-request-templates",
        ]);
        // D-1122 / T2.4（2026-11-13）：矩阵里的模型 4 域已退出工作区层 ⇒ 交集是**空**。
        // 这条从"matrix 里还剩两段"翻成"0 段"，正是 T2.4 落在 UI 侧的可执行判据；
        // 组页/组路由/左栏组条目同时消失（政策 MODEL_CONFIG_LAYERS 不用改）。
        expect(modelConfigDomainsForLayer("workspace-default")).toEqual([]);
        // 三个成员域在实例层都真实存在（否则组会把不存在的段画出来）。
        for (const domain of MODEL_CONFIG_DOMAINS) {
            expect(LAYER_DOMAINS.instance).toContain(domain);
        }
    });
});

describe("settingsIa · 智能体配置组（task-485 / 用户 2026-11-14 ③）", () => {
    it("两段：模板与角色 + 运行阈值（域不合并）", () => {
        expect(AGENT_CONFIG_DOMAINS).toEqual(["agent-templates", "agent-runtime"]);
        expect(agentConfigDomainsForLayer("instance")).toEqual([
            "agent-templates",
            "agent-runtime",
        ]);
        expect(agentConfigDomainsForLayer("user")).toEqual(["agent-templates", "agent-runtime"]);
    });

    it("工作区层撤掉 agent-templates 后只剩 1 段 ⇒ 不成组（也不注册组页路由）", () => {
        // 用户②「工作区没有智能体模板与角色，工作区（能）有的是能用的智能体」
        // ⇒ `agent-templates` 不在工作区两层矩阵里（task-485 第一项）。
        expect(LAYER_DOMAINS["workspace-default"]).not.toContain("agent-templates");
        expect(LAYER_DOMAINS.workspace).not.toContain("agent-templates");
        // 只剩 `agent-runtime` 一段 ⇒ 交集长度 1 < 2 ⇒ 不成组（路由与左栏都不出现组条目），
        // 但**叶子还在**（运行阈值仍是工作区可写的治理项）。
        expect(agentConfigDomainsForLayer("workspace-default")).toEqual(["agent-runtime"]);
        expect(navItemsForLayer("workspace-default").map((item) => item.id)).toEqual([
            "agent-runtime",
            "approval-policy",
            "job-policy",
        ]);
    });
});

describe("settingsIa · 左栏折叠（两组共用一套规则）", () => {
    it("实例层：两组各自折成一条，位置 = 首个成员原来所在处", () => {
        const instance = navItemsForLayer("instance");
        // 11 域 − (模型组 3 → 1：-2) − (智能体组 2 → 1：-1) = 8 条
        expect(instance).toHaveLength(LAYER_DOMAINS.instance.length - 3);
        expect(instance[0]).toEqual({
            id: "model-config",
            labelKey: "settings.groupModelConfig",
            path: "/settings/instance/model-config",
        });
        expect(instance.map((item) => item.id)).toEqual([
            "model-config",
            "embedding",
            "rag",
            "agent-config",
            "user-preference",
            "logging",
            "approval-policy",
            "job-policy",
        ]);
        // 组内成员不再作为叶子单独出现（否则左栏会同时有"组入口"和"段入口"两个入口）。
        for (const domain of [...MODEL_CONFIG_DOMAINS, ...AGENT_CONFIG_DOMAINS]) {
            expect(instance.map((item) => item.id)).not.toContain(domain);
        }
    });

    it("用户层：两组各自折成一条（8 域 − 3 = 5 条）", () => {
        const user = navItemsForLayer("user");
        expect(user).toHaveLength(LAYER_DOMAINS.user.length - 3);
        expect(user.map((item) => item.id)).toEqual([
            "model-config",
            "embedding",
            "rag",
            "agent-config",
            "user-preference",
        ]);
        expect(user[0]!.path).toBe("/settings/user/model-config");
        expect(user[3]!.path).toBe("/settings/user/agent-config");
    });

    it("组页路径与矩阵同构（层进路径、组 id 当段）", () => {
        expect(settingsGroupPath("workspace-default")).toBe(
            "/settings/workspace-default/model-config",
        );
        expect(settingsGroupPath("user", AGENT_CONFIG_GROUP_ID)).toBe(
            "/settings/user/agent-config",
        );
    });
});
