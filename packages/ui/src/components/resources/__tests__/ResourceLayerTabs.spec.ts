import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import { i18n } from "../../../i18n";
import ResourceLayerTabs from "../ResourceLayerTabs.vue";
import {
    layersForResource,
    visibleLayersForResource,
    type ResourceLayer,
} from "../../../lib/settingsIa";

/**
 * `T2b.3` · 技能三层 tab 的**行为**（不是"有没有渲染"）。
 *
 * <p>三条口径：</p>
 * <ol>
 *   <li><b>三层都在、文案点名所属主体</b>：我的技能 / 本工作区技能 / 全平台技能
 *       （Q4 裁定：tab 文案不得只写"用户层/工作区层/实例层"）。</li>
 *   <li><b>切换 = 发 `select` 事件</b>，层值由页面写回 `?layer=`（深链口径，`ResourcesLayout.selectLayer`）。</li>
 *   <li><b>个人层不因 `MANAGE_PERSONAL_SKILLS` 置灰</b>（Lead 2026-11-12 裁定 A）：
 *       读面不挂原子（P-189-3），所以真实页面里 skills/USER 的 `disabledReason` 恒为空 ⇒
 *       三个 tab 都**可点**。组件仍支持"置灰不隐藏"（那是给真的进不去的层用的），
 *       这里用显式 `disabledReason` 断言该能力没被删掉。</li>
 * </ol>
 */
function mountTabs(disabledReason?: Record<string, string>) {
    return mount(ResourceLayerTabs, {
        props: {
            resourceId: "skills" as const,
            layers: layersForResource("skills"),
            active: "WORKSPACE" as const,
            ...(disabledReason ? { disabledReason } : {}),
        },
        global: { plugins: [i18n] },
    });
}

describe("技能三层 tab（T2b.3）", () => {
    it("三层都在，且文案写清「我的 / 本工作区 / 全平台」", () => {
        const wrapper = mountTabs();
        const tabs = wrapper.findAll("[role='tab']");
        expect(tabs.map((tab) => tab.text())).toEqual(["我的技能", "本工作区技能", "全平台技能"]);
    });

    it("点「我的技能」与「全平台技能」各发一次 select（层值随事件走）", async () => {
        const wrapper = mountTabs();
        const tabs = wrapper.findAll("[role='tab']");

        // reka `TabsTrigger` 的自动激活模式在 **mousedown** 上选层（Radix 同款语义），
        // 所以这里触发 mousedown 而不是 click —— 断言的是真实交互路径，不是测试口味。
        await tabs[0]!.trigger("mousedown");
        await tabs[2]!.trigger("mousedown");

        expect(wrapper.emitted("select")).toEqual([["USER"], ["INSTANCE"]]);
    });

    it("个人层在真实配置下没有 disabledReason ⇒ 三个 tab 都可点（不因原子置灰）", () => {
        const wrapper = mountTabs();
        const tabs = wrapper.findAll("[role='tab']");
        expect(tabs.map((tab) => tab.attributes("disabled"))).toEqual([
            undefined,
            undefined,
            undefined,
        ]);
        // 理由列表也不该渲染（没有理由就别说"原因见下"）。
        expect(wrapper.find("[data-testid='resource-layer-disabled-reasons']").exists()).toBe(
            false,
        );
    });

    it("禁用层挂对比度修复类（task-124：浅深不同案；死代码 opacity-60 已移除）", () => {
        const wrapper = mountTabs({ USER: "需要某个原子" });
        const tabs = wrapper.findAll("[role='tab']");
        // light 撤文字 alpha 层、dark 换亮一档（详见组件模板注释）；两个类都必须在场。
        expect(tabs[0]!.classes()).toContain("disabled:text-foreground");
        expect(tabs[0]!.classes()).toContain("dark:disabled:text-foreground");
        // 死代码：vendor disabled:opacity-50（0,2,0）特异性压过裸 opacity-60（0,1,0），删掉对比度不变。
        expect(tabs[0]!.classes()).not.toContain("opacity-60");
    });

    it("真进不去的层：tab 仍留在 DOM、`disabled` 且理由可见（不隐藏）", () => {
        const wrapper = mountTabs({ USER: "需要某个原子" });
        const tabs = wrapper.findAll("[role='tab']");
        expect(tabs).toHaveLength(3);
        expect(tabs[0]!.attributes("disabled")).toBeDefined();
        expect(tabs[0]!.attributes("title")).toBe("需要某个原子");
        expect(wrapper.find("[data-testid='resource-layer-disabled-reasons']").text()).toContain(
            "需要某个原子",
        );
    });
});

/**
 * task-162（页签条退化收口）：判据是**DOM 里有没有页签条**，不是「文字看起来重复不重复」。
 *
 * <p>背景：`/resources/mcp` 在 task-145（DSD-1511）之后可见层只剩 INSTANCE，当时唯一的渲染
 * 条件写成 `layers.length`（0 层不渲染），1 层照样渲染 ⇒ 真机上出现一条只有一个页签的页签栏
 * （1920×1080 实测：`resource-layer-tabs` 1 个、`resource-layer-tab-*` 1 个、header 88.19px）。
 * 规则收进组件自己的 root，布局侧不再写第二处条件。</p>
 *
 * <p>承重点（变异）：把 `v-if="layers.length > 1"` 退回 `layers.length` ⇒ 第 1 条红；
 * v-if 整条删掉 ⇒ 第 1 条红；判据写反（`< 1`）⇒ 第 2 条红。第 3 条钉的是**数据事实**
 * （mcp 现在确实只剩一层）：将来 mcp 若真拿回工作区层，页签条长回来是正确行为，届时这条
 * 数据锁先红并把矛头指回 settingsIa，而不是让人以为收口失效。</p>
 */
describe("ResourceLayerTabs · 单层不渲染页签条（task-162）", () => {
    function mountLayers(layers: ResourceLayer[], active: ResourceLayer) {
        return mount(ResourceLayerTabs, {
            props: { resourceId: "mcp" as const, layers, active },
            global: { plugins: [i18n] },
        });
    }

    it("可见层 = 1 ⇒ 页签条节点数 0、没有 role=tab、也不留下带 mt-3 的空壳", () => {
        const wrapper = mountLayers(["INSTANCE"], "INSTANCE");
        expect(wrapper.find("[data-testid='resource-layer-tabs']").exists()).toBe(false);
        expect(wrapper.findAll("[role='tab']")).toHaveLength(0);
        // mt-3 原先挂在布局的包装层上：根节点不渲染时那层空 div 仍占 12px，故一并收进组件 root
        // ⇒ 单层时连这个空壳都不该存在（用选择器而不是 html() 字符串，注释文本本身含 mt-3）。
        expect(wrapper.find(".mt-3").exists()).toBe(false);
    });

    it("可见层 = 2 ⇒ 两个页签照常渲染（收口不是把页签条藏起来）", () => {
        const wrapper = mountLayers(["USER", "INSTANCE"], "USER");
        expect(wrapper.find("[data-testid='resource-layer-tabs']").exists()).toBe(true);
        expect(wrapper.findAll("[role='tab']")).toHaveLength(2);
    });

    it("真实口径：mcp 的可见层只剩 INSTANCE ⇒ 按 SSOT 走就是没有页签条", () => {
        const layers = visibleLayersForResource("mcp");
        expect(layers).toEqual(["INSTANCE"]);
        const wrapper = mountLayers(layers, "INSTANCE");
        expect(wrapper.find("[data-testid='resource-layer-tabs']").exists()).toBe(false);
        expect(wrapper.findAll("[role='tab']")).toHaveLength(0);
    });
});
