import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import { i18n } from "../../../i18n";
import InstanceAgentsView from "../InstanceAgentsView.vue";

/**
 * task-91：平台智能体的**新家**是宿主页 `views/settings/InstanceAgentsView.vue`。
 *
 * <p>本文件只钉「宿主真的挂了那个面板，且标题不是裸键」；面板自己的取数/写门判据在
 * `components/settings/__tests__/InstanceAgentsPanel.spec.ts`。分工与
 * `components/resources/__tests__/source-column-absence.spec.ts` 同形 —— 不重复钉面板内部。</p>
 */
describe("InstanceAgentsView（平台智能体落点，task-91）", () => {
    it("挂载既有面板，标题是实文案而不是裸 i18n 键", () => {
        const wrapper = mount(InstanceAgentsView, {
            global: { plugins: [i18n], stubs: { InstanceAgentsPanel: true } },
        });
        expect(wrapper.get('[data-testid="settings-instance-agents-title"]').text()).toBe(
            "平台智能体",
        );
        expect(wrapper.findComponent({ name: "InstanceAgentsPanel" }).exists()).toBe(true);
        wrapper.unmount();
    });
});
