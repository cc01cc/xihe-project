import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import { i18n } from "../../../i18n";
import ResourceLayerTabs from "../ResourceLayerTabs.vue";
import { layersForResource } from "../../../lib/settingsIa";

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
