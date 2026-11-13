import type { Component } from "vue";
import { Boxes, Briefcase, Network, Settings } from "@lucide/vue";
import {
    defaultLayerPath,
    DOMAIN_LABEL_KEY,
    domainsForLayer,
    RESOURCE_DEFS,
    resourcePath,
    settingsDomainPath,
} from "./settingsIa";

/**
 * GlobalRail 的模块表 + 每模块的二级菜单项（`task-189` / `D-896` / `BL-578` / `BL-584`）。
 *
 * <p><b>为什么要有这一份</b>：`D-896` 把二级菜单定为折叠态的**可读性必需品**（折起来只剩 56px
 * 图标，悬浮菜单是唯一能知道「这个图标是什么」的通道），并且要求**内容由 SSOT 派生**——
 * 「手写清单 = 缺陷」。所以本文件的职责只有一处：**把已有的 SSOT 投影成菜单项**，不新增任何
 * 页面清单、不复制任何路由字面量：
 * - 模块「资源」的子项 = `RESOURCE_DEFS`（`settingsIa.ts:204-281`，PLAN-0772 M2 的唯一一份资源×层矩阵）；
 * - 模块「设置」的子项 = `domainsForLayer("instance")` + `DOMAIN_LABEL_KEY`（`settingsIa.ts:57-91`），
 *   路径由 `settingsDomainPath()` 生成（`:131`）；
 * - 模块「工作台」的子项由它自己的落地路由派生（工作台模块内部的对象不是全局导航的条目）。
 *
 * <p>判据（可复算）：本文件**不得出现** `/resources/`、`/settings/instance/` 这类路径字面量，
 * 也不得出现域/资源的名字字符串 —— 一旦出现就说明有人把清单手写回来了。
 */
export type GlobalModuleId = "workbench" | "org-members" | "resources" | "settings";

export interface GlobalMenuItem {
    /** 稳定 id：资源 id / 配置域 id / 工作台自身。 */
    id: string;
    /** i18n 标签 key（资源与域都直接复用 SSOT 里的那个 key）。 */
    labelKey: string;
    /** 目标路由（由 SSOT 的路径函数生成，不写死）。 */
    path: string;
}

export interface GlobalModuleDef {
    id: GlobalModuleId;
    labelKey: string;
    icon: Component;
    /** 模块的路径前缀（激活态判定用；不是落地页 —— 落地页是 `path`）。 */
    basePath: string;
    /** 点一级项时去哪（模块落地页）。 */
    path: string;
    /** 二级菜单项（悬浮/点击/键盘打开）。 */
    items: readonly GlobalMenuItem[];
}

/**
 * 工作台模块只有一条全局路由（工作台内部的对象由页签承担，不是全局导航条目），
 * 因此它的二级菜单**只有一项**：回到工作台本身。**这一项也不是手写的路径字面量**，
 * 而是与 `GlobalRail` 的落地跳转同源（见 `WORKBENCH_PATH`）。
 */
export const WORKBENCH_PATH = "/workspace";

/**
 * 组织成员模块的落地路径（PLAN-0773 M3 / task-240，Lead 裁 (a)：实例级面进全局模块）。
 * 与工作台同构：模块只有一条全局路由，二级菜单只有「回到本页」一项，也不是手写路径字面量
 * —— 路由表里的 `/members` 与本常量同源（判据同 WORKBENCH_PATH 注释）。
 */
export const ORG_MEMBERS_PATH = "/members";

function resourceItems(): GlobalMenuItem[] {
    return RESOURCE_DEFS.map((def) => ({
        id: def.id,
        labelKey: def.labelKey,
        path: resourcePath(def.id),
    }));
}

function settingsItems(): GlobalMenuItem[] {
    return domainsForLayer("instance").map((domain) => ({
        id: domain,
        labelKey: DOMAIN_LABEL_KEY[domain],
        path: settingsDomainPath("instance", domain),
    }));
}

function workbenchItems(): GlobalMenuItem[] {
    return [{ id: "workbench", labelKey: "sidebar.workbench", path: WORKBENCH_PATH }];
}

export const GLOBAL_MODULES: readonly GlobalModuleDef[] = [
    {
        id: "workbench",
        labelKey: "sidebar.workbench",
        icon: Briefcase,
        basePath: WORKBENCH_PATH,
        path: WORKBENCH_PATH,
        items: workbenchItems(),
    },
    {
        id: "org-members",
        labelKey: "sidebar.orgMembers",
        // Lead 2026-11-13 裁：图标 Network（与成员页已用的 Users 区分，两个 Users 并列会点错）。
        icon: Network,
        basePath: ORG_MEMBERS_PATH,
        path: ORG_MEMBERS_PATH,
        items: [{ id: "org-members", labelKey: "sidebar.orgMembers", path: ORG_MEMBERS_PATH }],
    },
    {
        id: "resources",
        labelKey: "sidebar.resources",
        icon: Boxes,
        basePath: "/resources",
        path: resourcePath(RESOURCE_DEFS[0].id),
        items: resourceItems(),
    },
    {
        id: "settings",
        labelKey: "sidebar.settings",
        icon: Settings,
        basePath: "/settings",
        // 落地页与 `GlobalRail` 的「设置」跳转同一个派生函数（`settingsIa.ts:136`）。
        path: defaultLayerPath("instance"),
        items: settingsItems(),
    },
];

export function globalModule(id: GlobalModuleId): GlobalModuleDef {
    const def = GLOBAL_MODULES.find((candidate) => candidate.id === id);
    if (!def) throw new Error(`unknown global module: ${id}`);
    return def;
}

/**
 * 「当前路由是否落在该模块」。传给 `isActive`；也用于二级菜单项的选中态。
 * 前缀判定用 `/` 边界，避免 `/workspaces` 之类同前缀路径被误命中。
 */
export function isModulePathMatch(modulePath: string, routePath: string): boolean {
    if (routePath === modulePath) return true;
    return routePath.startsWith(`${modulePath}/`);
}

export function moduleForPath(routePath: string): GlobalModuleDef | undefined {
    return GLOBAL_MODULES.find((def) => isModulePathMatch(def.basePath, routePath));
}
