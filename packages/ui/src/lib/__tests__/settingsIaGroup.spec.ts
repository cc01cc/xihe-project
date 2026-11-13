import { describe, expect, it } from "vitest";
import { INSTANCE_DOMAINS, LAYER_DOMAINS } from "../../stores/config";
import {
    MODEL_CONFIG_DOMAINS,
    MODEL_CONFIG_GROUP_ID,
    modelConfigDomainsForLayer,
    navItemsForLayer,
    resolveLayerRoute,
    settingsGroupPath,
} from "../settingsIa";

/**
 * task-227「合页，不合域」的派生层判据（纯逻辑，无 DOM）。
 *
 * <p>判据分两半：①**组 id 不是域 id**（这是"不合域"的机器证据 —— 谁把 `model-config` 塞进
 * `INSTANCE_DOMAINS` 或 `LAYER_DOMAINS`，下面第一条就红）；②每层实际几段由**矩阵求交集**得出，
 * 组件/路由/左栏三处都用这一个函数，所以不存在"页面画三段而左栏折两段"的漂移。</p>
 */
describe("settingsIa · 模型配置组（task-227）", () => {
    it("组 id 不是域 id：不进矩阵、不解析成域路由", () => {
        expect(MODEL_CONFIG_GROUP_ID).toBe("model-config");
        expect((INSTANCE_DOMAINS as readonly string[]).includes(MODEL_CONFIG_GROUP_ID)).toBe(false);
        for (const layer of ["instance", "user", "workspace-default"] as const) {
            expect(
                (LAYER_DOMAINS[layer] as readonly string[]).includes(MODEL_CONFIG_GROUP_ID),
            ).toBe(false);
        }
        // 「不合域」的可执行判据：它解析不出域路由（否则 CP 会收到 /config/model-config/meta 必 400）。
        expect(resolveLayerRoute("instance", MODEL_CONFIG_GROUP_ID)).toEqual({
            ok: false,
            reason: "unknown-domain",
        });
    });

    it("每层几段 = 矩阵交集（instance 3 / user 3 / workspace-default 2）", () => {
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
        // workspace-default 的矩阵里没有 api-request-templates ⇒ 只有两段（派生，不是写死两段）。
        expect(modelConfigDomainsForLayer("workspace-default")).toEqual([
            "llm-provider",
            "context-policy",
        ]);
        // 三个成员域在实例层都真实存在（否则组会把不存在的段画出来）。
        for (const domain of MODEL_CONFIG_DOMAINS) {
            expect(LAYER_DOMAINS.instance).toContain(domain);
        }
    });

    it("左栏：三个成员域折成一个组条目，位置 = 首个成员原来所在处", () => {
        const instance = navItemsForLayer("instance"),
            user = navItemsForLayer("user"),
            // D-1122 验收行（Lead 2026-11-13 加码）：工作区层 nav 里**不含**组 id —— 「不注册路由」只保证
            // 不 404，不保证菜单不出现死链，两者必须分开断。矩阵里的两个域仍以普通叶子出现（那是
            // D-1122 还没改的存量，组政策在 MODEL_CONFIG_LAYERS，不跟矩阵走）。
            wsDefault = navItemsForLayer("workspace-default");
        expect(instance).toHaveLength(LAYER_DOMAINS.instance.length - 2);
        expect(instance[0]).toEqual({
            id: "model-config",
            labelKey: "settings.groupModelConfig",
            path: "/settings/instance/model-config",
        });
        expect(instance.map((item) => item.id)).not.toContain("llm-provider");
        expect(instance.map((item) => item.id)).not.toContain("context-policy");
        expect(instance.map((item) => item.id)).not.toContain("api-request-templates");
        expect(user).toHaveLength(LAYER_DOMAINS.user.length - 2);
        expect(user[0]!.path).toBe("/settings/user/model-config");
        expect(settingsGroupPath("workspace-default")).toBe(
            "/settings/workspace-default/model-config",
        );
        expect(wsDefault.map((item) => item.id)).not.toContain("model-config");
        expect(wsDefault.map((item) => item.id)).toContain("llm-provider");
        expect(wsDefault.map((item) => item.id)).toContain("context-policy");
    });
});
