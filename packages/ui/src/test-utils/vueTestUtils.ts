import {
    mount as baseMount,
    shallowMount as baseShallowMount,
    type VueWrapper,
} from "@vue/test-utils";

import { expectNoRawI18nKey } from "./i18nKeys";

/**
 * task-105 · **测试挂载的统一接线点**：`@vue/test-utils` 的 `mount` / `shallowMount` 在
 * **`.spec.ts` 里**会被 `vite.config.ts` 的 `xihe-checked-mount` 插件改指向本文件，于是
 * 每次挂载后自动跑一次 `expectNoRawI18nKey(wrapper.html())`。
 *
 * <p>为什么这么做（而不是 33 个 spec 各写一行 import）：</p>
 * <ul>
 *   <li>组件 spec 都会造一份**局部 messages 夹具**（全仓 230 个 spec 里 33 个自建），夹具缺键时
 *       `t(labelKey)` 原样返回键名，页面出现 `settings.ia.resourceSkills`，而测试照样绿 ——
 *       task-87 的事故就是这么出的；</li>
 *   <li>断言性质与 `flushPromises` 同级，属于**测试基础设施**：一处接线，**新增 spec 自动受保护**，
 *       不靠人记得加一行；</li>
 *   <li>2026-11-12 实测过反面：32 个 spec 各加一行相对导入，**32 个路径全错一级**（批量解析失败），
 *       所以"每处一写"本身就是脆弱点。</li>
 * </ul>
 *
 * <p>**覆盖边界（如实）**：只覆盖**经过 `mount`/`shallowMount` 且立即渲染**的路径 ——
 * ① 挂载后才异步加载、渲染出裸键的场景抓不到（断言在 mount 返回那一刻跑）；
 * ② 直接 `createApp(...).mount()` 或自建 render 的 spec 不走本文件；
 * ③ 非 `.spec.ts`（如 `e2e/`）不在接线范围。</p>
 *
 * <p>**已知陷阱（`task-92`）：模板注释里写字面 i18n 键会被判成裸键。** 扫的是
 * `wrapper.html()`，而它含 `<template>` 里那类 `<!-- … -->` 注释（Vue 开发态保留模板注释）；
 * 注释里出现一个**真实存在的键名**，钩子当场红、整个 spec 一个用例都过不去。
 * ⇒ **模板注释里描述意图，不要写字面键名**（写「标题复用既有键」而不是把那个键敲上来）。
 * 判定**是刻意的**、不是误报：裸键出现在渲染产物里就是缺陷，「注释也是产物的一部分」；
 * **不要为了让测试变绿去放宽 `expectNoRawI18nKey` 或加豁免**（放宽就是削弱一条真判据，
 * 而且下次真出裸键时这条护栏已经哑了）。踩到时正确动作是改注释，不是改钩子。
 *
 * <p>与之相邻的另一条（同一份注释约定）：`i18n-scan` 是**静态**门、看源码字面量，所以
 * 在注释里留一个键名等于告诉它「这个键还活着」—— 这也是「注释不写真键名」的第二个理由
 * （实例：`tools/xh-ledger` 的沿革注释曾把状态词写死，读到的人 `grep` 找不到实例）。</p>
 */

type MountResult = VueWrapper<unknown>;

export function mount(...args: Parameters<typeof baseMount>): MountResult {
    const wrapper = baseMount(...args) as MountResult;
    expectNoRawI18nKey(wrapper.html());
    return wrapper;
}

export function shallowMount(...args: Parameters<typeof baseShallowMount>): MountResult {
    const wrapper = baseShallowMount(...args) as MountResult;
    expectNoRawI18nKey(wrapper.html());
    return wrapper;
}

export * from "@vue/test-utils";
