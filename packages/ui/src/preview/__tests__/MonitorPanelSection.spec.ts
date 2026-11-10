import { describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { i18n } from "../../i18n";
import MonitorPanelSection from "../sections/MonitorPanelSection.vue";

/**
 * task-83 第三腿：这块预览的**唯一职责**是把真实 `SessionMonitorPanel` 挂进三档 dock 宽，
 * 供量测算每行文本的视觉行数。所以断言分两类：
 *   ① 结构：三档宽度 + 每档一个真实面板；
 *   ② 内容：等宽文本真的渲染出来了 —— 否则量测会得到「无顶行」，而那是「页面是空的」冒充的。
 * 失败态断言存在的理由：fixture 走 fetch seam，若哪天 seam 失效、面板去打网络，
 * jsdom 里会落到 loadFailed 分支，这会先在这里红，而不是在量测里变成一个假结论。
 */
describe("MonitorPanelSection", () => {
    it("三档宽度各挂一个真实监控面板，并渲染出等宽文本", async () => {
        const wrapper = mount(MonitorPanelSection, { global: { plugins: [i18n] } });
        await flushPromises();

        const probes = wrapper.findAll("[data-mono-probe]");
        expect(probes.map((probe) => probe.attributes("data-mono-probe"))).toEqual([
            "monitor-320",
            "monitor-400",
            "monitor-480",
        ]);

        expect(wrapper.findAll('[data-testid="session-monitor-panel"]')).toHaveLength(3);

        const mono = wrapper.findAll('[class*="font-mono"]');
        expect(mono.length).toBeGreaterThan(20);

        expect(wrapper.find('[data-testid="monitor-loading"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="monitor-error"]').exists()).toBe(false);
    });
});
