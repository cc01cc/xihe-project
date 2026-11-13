import { describe, expect, it } from "vitest";
import { i18n } from "../../i18n";
import {
    GLOBAL_MODULES,
    globalModule,
    isModulePathMatch,
    moduleForPath,
    ORG_MEMBERS_PATH,
    RAIL_HOVER_OPEN_DELAY_MS,
    WORKBENCH_PATH,
} from "../globalModules";
import {
    defaultLayerPath,
    DOMAIN_LABEL_KEY,
    domainsForLayer,
    RESOURCE_DEFS,
    resourcePath,
    settingsDomainPath,
} from "../settingsIa";

/**
 * task-189 / D-896：二级菜单内容**必须由 SSOT 派生**（手写清单 = 缺陷）。
 *
 * <p>这组用例就是「派生」这件事的机器判据：把模块菜单逐项与 `settingsIa.ts` 的矩阵
 * **对撞**，任何一侧手写了一份新清单（改动了域/资源但没改投影、或反过来），这里会红。</p>
 */
describe("globalModules：菜单内容由 SSOT 派生", () => {
    it("四个模块，顺序与 id 固定", () => {
        // task-240（PLAN-0773 M3，Lead 裁 (a) 全局模块落点）：组织成员是实例级面，进全局 rail
        // 第 2 位（工作台之后）——入口按作用域归位：实例级面进全局模块，工作区作用域面进容器页。
        expect(GLOBAL_MODULES.map((module) => module.id)).toEqual([
            "workbench",
            "org-members",
            "resources",
            "settings",
        ]);
    });

    it("组织成员模块：单一路由 + 单一项 + 指向 ORG_MEMBERS_PATH（与工作台同构）", () => {
        const orgMembers = globalModule("org-members");
        expect(orgMembers.path).toBe(ORG_MEMBERS_PATH);
        expect(orgMembers.basePath).toBe(ORG_MEMBERS_PATH);
        expect(orgMembers.items).toEqual([
            { id: "org-members", labelKey: "sidebar.orgMembers", path: ORG_MEMBERS_PATH },
        ]);
    });

    it("资源模块的子项 == RESOURCE_DEFS（个数 / id / 路径 / 标签 key 全等）", () => {
        const resources = globalModule("resources");
        const expected = RESOURCE_DEFS.map((def) => ({
            id: def.id,
            labelKey: def.labelKey,
            path: resourcePath(def.id),
        }));
        expect(resources.items).toEqual(expected);
    });

    it("设置模块的子项 == 实例层域清单（路径由 settingsDomainPath 生成）", () => {
        const settings = globalModule("settings");
        const expected = domainsForLayer("instance").map((domain) => ({
            id: domain,
            labelKey: DOMAIN_LABEL_KEY[domain],
            path: settingsDomainPath("instance", domain),
        }));
        expect(settings.items).toEqual(expected);
    });

    it("设置模块落地页 == defaultLayerPath(instance)（与一级跳转同源）", () => {
        expect(globalModule("settings").path).toBe(defaultLayerPath("instance"));
    });

    it("工作台模块子项只有一项且指向 /workspace", () => {
        expect(globalModule("workbench").items).toHaveLength(1);
        expect(globalModule("workbench").items[0].path).toBe(WORKBENCH_PATH);
    });

    it("每个标签 key 在 zh-CN 与 en-US 两侧都能解析（不出现裸 key）", () => {
        const keys = GLOBAL_MODULES.flatMap((module) => [
            module.labelKey,
            ...module.items.map((item) => item.labelKey),
        ]);
        for (const key of keys) {
            for (const locale of ["zh-CN", "en-US"]) {
                const translated = i18n.global.t(key, {}, { locale });
                expect(translated, `${locale} 缺 ${key}`).not.toBe(key);
            }
        }
    });
});

describe("globalModules：模块路径判定", () => {
    it("basePath 前缀判定不吞掉同前缀的另一条路由", () => {
        expect(isModulePathMatch("/workspace", "/workspace")).toBe(true);
        expect(isModulePathMatch("/workspace", "/workspace/ws-1")).toBe(true);
        expect(isModulePathMatch("/workspace", "/workspaces")).toBe(false);
        expect(isModulePathMatch("/settings", "/settings/user/llm-provider")).toBe(true);
    });

    it("moduleForPath 按 basePath 归属模块（设置的用户层也归「设置」）", () => {
        expect(moduleForPath("/settings/user/llm-provider")?.id).toBe("settings");
        expect(moduleForPath("/resources/credentials")?.id).toBe("resources");
        expect(moduleForPath("/chat/abc")?.id).toBeUndefined();
    });

    it("悬停开菜单的延迟是同一个常量（不在两处各写一个数字）", () => {
        expect(RAIL_HOVER_OPEN_DELAY_MS).toBe(160);
    });
});
