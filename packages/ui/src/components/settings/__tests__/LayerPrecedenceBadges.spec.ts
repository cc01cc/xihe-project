import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import LayerPrecedenceBadges from "../LayerPrecedenceBadges.vue";
import { i18n } from "../../../i18n";

/**
 * PLAN-0766 T3.2：四层徽标必须同时画「工作区 / 工作区默认 / 个人 / 实例」并标注当前层，
 * 且给出覆盖顺序说明 —— 只画当前层等于让用户看不出「这条默认值会被谁覆盖」。
 */
describe("LayerPrecedenceBadges", () => {
    it("renders all four layers in low-to-high order and marks the active one", () => {
        const wrapper = mount(LayerPrecedenceBadges, {
            props: { layer: "workspace-default" },
            global: { plugins: [i18n] },
        });
        const ids = ["workspace", "workspace-default", "user", "instance"].map((id) =>
            wrapper.get(`[data-testid="layer-badge-${id}"]`),
        );
        expect(ids.map((badge) => badge.text())).toEqual(["工作区", "工作区默认", "个人", "实例"]);
        expect(ids[1].attributes("data-active")).toBe("true");
        for (const badge of [ids[0], ids[2], ids[3]]) {
            expect(badge.attributes("data-active")).toBeUndefined();
        }
    });

    it("marks a different layer without moving the order", () => {
        const wrapper = mount(LayerPrecedenceBadges, {
            props: { layer: "user" },
            global: { plugins: [i18n] },
        });
        expect(wrapper.get('[data-testid="layer-badge-user"]').attributes("data-active")).toBe(
            "true",
        );
        expect(
            wrapper.get('[data-testid="layer-badge-workspace-default"]').attributes("data-active"),
        ).toBeUndefined();
    });

    it("explains precedence and immediate effect for existing workspaces", () => {
        const wrapper = mount(LayerPrecedenceBadges, {
            props: { layer: "workspace-default" },
            global: { plugins: [i18n] },
        });
        const text = wrapper.text();
        expect(text).toContain("生效顺序");
        expect(text).toContain("环境变量与管理员锁定");
        expect(text).toContain("立即生效");
    });
});
