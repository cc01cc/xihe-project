import { describe, expect, it } from "vitest";
import { i18n } from "../../i18n";
import router from "../../router";
import {
    GLOBAL_MODULES,
    globalModule,
    isModulePathMatch,
    moduleForPath,
    ORG_MEMBERS_PATH,
    SCHEDULED_TASKS_PATH,
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
 * task-934（R4）：**全局模块的每个路径都必须是「活路由」**。
 *
 * <p>为什么原来测不出来：本文件此前只断言「模块的 path 等于 `SCHEDULED_TASKS_PATH`」——
 * 即**常量自洽**。常量与模块表当然永远一致（都是同一个人写的），于是路由表里根本没有
 * `/scheduled-tasks` 这条记录时，测试照样全绿；真实效果是点全局导航「自动化任务」
 * URL 逐字不变（落到 `/:pathMatch(.*)* → /workbench`，再被 tab 上下文守卫恢复回原会话页，
 * 全程无报错）。判据必须是**路由表**，不是常量：把 path 交给 `router.resolve()`，
 * 命中的必须是一条**已注册的命名路由**，而不是兜底/redirect 记录。</p>
 *
 * <p>「命中兜底也算绿」是这类断言最常见的假绿形态：`/:pathMatch(.*)*` 对任意路径都会
 * `matched.length > 0`，只有断言 `name` 与 `matched` 的记录形态才能分辨。这里同时判三件：
 * ① `resolved.name` 非空；② 命中的末条记录带同名 `name`（兜底记录没有 name）；
 * ③ `resolved.path` 等于请求路径（redirect 记录会把 path 换成目标）。
 * 同一判据另有一道独立的普查门 `packages/ui/scripts/check-route-registry.mjs`
 * （不依赖 vitest，可直接接 lint 聚合），两者读的是同一个 `GLOBAL_MODULES`。</p>
 */

/**
 * task-189 / D-896：二级菜单内容**必须由 SSOT 派生**（手写清单 = 缺陷）。
 *
 * <p>这组用例就是「派生」这件事的机器判据：把模块菜单逐项与 `settingsIa.ts` 的矩阵
 * **对撞**，任何一侧手写了一份新清单（改动了域/资源但没改投影、或反过来），这里会红。</p>
 */
describe("globalModules：菜单内容由 SSOT 派生", () => {
    it("五个模块，顺序与 id 固定", () => {
        // task-240（PLAN-0773 M3，Lead 裁 (a) 全局模块落点）：组织成员是实例级面，进全局 rail
        // 第 2 位（工作台之后）——入口按作用域归位：实例级面进全局模块，工作区作用域面进容器页。
        // task-11（D-1220 ③ 回退）：自动化任务从「工作区面板项」回退成实例级模块，落**末位**
        // （卡面 r6 裁定 ③「位次 = settings 之后」）—— 与「实例级面进全局模块」同一条归位判据，
        // 不再随工作区上下文出现/消失。
        expect(GLOBAL_MODULES.map((module) => module.id)).toEqual([
            "workbench",
            "org-members",
            "resources",
            "settings",
            "scheduled-tasks",
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

    it("自动化任务模块：单一路由 + 单一项 + 指向 SCHEDULED_TASKS_PATH（task-11）", () => {
        const scheduledTasks = globalModule("scheduled-tasks");
        expect(scheduledTasks.path).toBe(SCHEDULED_TASKS_PATH);
        expect(scheduledTasks.basePath).toBe(SCHEDULED_TASKS_PATH);
        // 单一项 = 「回到本页」；与工作台/组织成员同构（不做二级菜单，避免同一面两种入口形态）。
        expect(scheduledTasks.items).toHaveLength(1);
        expect(scheduledTasks.items[0].path).toBe(SCHEDULED_TASKS_PATH);
        // 标签**复用**既有工作区页的键（DSD-1490 只冻结值、不禁复用）：不为一个 labelKey 新增 i18n 键。
        expect(scheduledTasks.labelKey).toBe("workspaceNav.scheduledTasks");
    });

    it("工作台模块子项只有一项且指向 /workbench（task-34 模块入口改名）", () => {
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

describe("globalModules：每个可点击路径都在路由表里（task-934 / R4）", () => {
    /** 全局导航真正会 `router.push()` 的路径：模块落地页 + 每个二级项。 */
    function clickablePaths(): readonly { module: string; path: string }[] {
        return GLOBAL_MODULES.flatMap((module) => [
            { module: module.id, path: module.path },
            ...module.items.map((item) => ({ module: module.id, path: item.path })),
        ]);
    }

    /**
     * 判「死链」的三条：① 没有 name；② 命中的末条记录不是命名记录（兜底 `/:pathMatch(.*)*`
     * 就是这种）；③ 打开会 redirect 到别处（`resolved.path` 被换成目标）。
     * 三者任一成立即视为「不在路由表」，与 `scripts/check-route-registry.mjs` 同口径。
     */
    function isDeadLink(requestPath: string): boolean {
        const resolved = router.resolve(requestPath);
        const last = resolved.matched.at(-1);
        return (
            !resolved.name ||
            last?.name !== resolved.name ||
            last?.redirect !== undefined ||
            resolved.path !== requestPath
        );
    }

    it("逐项 resolve 到已注册的命名路由（不是兜底/redirect 记录）", () => {
        const dead = clickablePaths()
            .filter((entry) => isDeadLink(entry.path))
            .map((entry) => `${entry.module}: ${entry.path}`);
        expect(dead).toEqual([]);
    });

    it("反向自检：未注册的路径必须被判死（否则上一条判据可能恒真）", () => {
        expect(isDeadLink("/__task-934-unregistered-probe__")).toBe(true);
        // 正向对照：同一判据对真实存在的项必须判活。
        expect(isDeadLink(WORKBENCH_PATH)).toBe(false);
        expect(isDeadLink(ORG_MEMBERS_PATH)).toBe(false);
        expect(isDeadLink(SCHEDULED_TASKS_PATH)).toBe(false);
    });
});

describe("globalModules：模块路径判定", () => {
    it("basePath 前缀判定不吞掉同前缀的另一条路由", () => {
        expect(isModulePathMatch("/workbench", "/workbench")).toBe(true);
        expect(isModulePathMatch("/workbench", "/workbench/ws-1")).toBe(true);
        expect(isModulePathMatch("/workbench", "/workbenches")).toBe(false);
        expect(isModulePathMatch("/settings", "/settings/user/llm-provider")).toBe(true);
    });

    it("moduleForPath 按 basePath 归属模块（设置的用户层也归「设置」）", () => {
        expect(moduleForPath("/settings/user/llm-provider")?.id).toBe("settings");
        // task-34：模块入口 /workbench 与容器页 /workspace/:id/** 都归「工作台」。
        expect(moduleForPath("/workbench")?.id).toBe("workbench");
        expect(moduleForPath("/workspace/ws-1")?.id).toBe("workbench");
        expect(moduleForPath("/resources/credentials")?.id).toBe("resources");
        // task-11：实例级自动化任务总览归自己的模块，**不**被 /workspace 容器前缀吞成工作台。
        expect(moduleForPath("/scheduled-tasks")?.id).toBe("scheduled-tasks");
        // 容器内的同名子页仍归工作台 —— 两个面不互相挂载（判据写在 SCHEDULED_TASKS_PATH 注释里）。
        expect(moduleForPath("/workspace/ws-1/scheduled-tasks")?.id).toBe("workbench");
        expect(moduleForPath("/chat/abc")?.id).toBeUndefined();
    });

    /**
     * task-259（回退 `83b4fd213` 的悬停通道）的**存在性反向断言**：常量必须消失。
     * 组件级「指针停住不出现」由 `components/__tests__/GlobalRail.spec.ts` 与 e2e
     * `global-rail-dual-state.spec.ts` 各自钉住；本条只保证没有人把这条通道的**脚手架**留在
     * lib 层（留常量 = 下一个人重新接线只差两行）。
     */
    it("lib 里不再有「悬停打开延迟」常量（BL-578 缓做，D-899）", async () => {
        // task-261（A1）：原为 import * as globalModuleExports（值命名空间，被 check-value-namespace 拦）。
        // 断言对象不变 —— 动态 import 取到的是同一个模块命名空间对象，键集完全相同；
        // 改成具名导入会**摧毁**这条反向存在性断言（无法枚举导出面），故用动态导入而非削弱断言。
        const globalModuleExports = await import("../globalModules");
        expect(Object.keys(globalModuleExports)).not.toContain("RAIL_HOVER_OPEN_DELAY_MS");
    });
});
