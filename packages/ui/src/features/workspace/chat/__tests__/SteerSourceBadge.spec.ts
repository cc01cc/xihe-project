import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { i18n } from "../../../../i18n";
import SteerSourceBadge from "../components/SteerSourceBadge.vue";

/**
 * task-188 S3 L0-S4：SteerSourceBadge。
 * cp-1 W0 对齐 ②：follow-ups items[] 加 sourceKind/fromSessionId，**null 不渲染徽标**。
 */

function mountBadge(props: { sourceKind?: string | null; fromName?: string | null }) {
    return mount(SteerSourceBadge, {
        props: {
            sourceKind: props.sourceKind ?? null,
            fromName: props.fromName ?? null,
        },
        global: { plugins: [i18n] },
    });
}

describe("SteerSourceBadge", () => {
    it("renders the badge for agent_steer items, with a named source", () => {
        const wrapper = mountBadge({ sourceKind: "agent_steer", fromName: "lead-会话" });
        expect(wrapper.find('[data-testid="steer-source-badge"]').exists()).toBe(true);
        expect(wrapper.get('[data-testid="steer-source-label"]').text()).toContain("lead-会话");
    });

    it("falls back to the generic label when no name is provided", () => {
        const wrapper = mountBadge({ sourceKind: "agent_steer" });
        expect(wrapper.get('[data-testid="steer-source-label"]').text()).toContain(
            i18n.global.t("steer.fromLead"),
        );
    });

    it("emits navigate from the jump button", async () => {
        const wrapper = mountBadge({ sourceKind: "agent_steer", fromName: "lead" });
        await wrapper.get('[data-testid="steer-source-jump"]').trigger("click");
        expect(wrapper.emitted("navigate")).toHaveLength(1);
    });

    it("renders nothing for human / null / unknown sourceKind (S4 反假绿)", () => {
        for (const sourceKind of ["human", null, "something_else", ""]) {
            const wrapper = mountBadge({ sourceKind });
            expect(wrapper.find('[data-testid="steer-source-badge"]').exists()).toBe(false);
            expect(wrapper.text()).toBe("");
        }
    });
});
