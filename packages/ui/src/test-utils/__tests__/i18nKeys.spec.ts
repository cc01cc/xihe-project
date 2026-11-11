import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { defineComponent, h } from "vue";

import { expectNoRawI18nKey, findRawI18nKeys, knownI18nKeys } from "../i18nKeys";
import { i18n } from "../../i18n";

/**
 * task-93 · 兜底断言的自测（正负例）。
 *
 * 这条断言的**唯一价值**是"夹具缺键时必须红"；所以负例（partial fixture）比正例重要。
 * 另配一条假阳性守卫：页面正文里出现 `skills/…/SKILL.md` 这类路径、或 `mcpServers` 这类字段名时，
 * 不许被当成裸键 —— 一条会误报的断言会被当成噪音关掉。
 */
function mountRendering(plugin: ReturnType<typeof createI18n>, key: string) {
    const View = defineComponent({
        setup() {
            return () => h("p", { "data-testid": "t" }, String(plugin.global.t(key)));
        },
    });
    return mount(View, { global: { plugins: [plugin] } });
}

describe("i18nKeys 兜底断言（task-93）", () => {
    it("知道本仓的真实键集合（非空，且含已知键）", () => {
        const keys = knownI18nKeys();
        expect(keys.length).toBeGreaterThan(2000);
        expect(keys).toContain("settings.skills.title");
    });

    it("负例：夹具缺键 ⇒ 组件渲染出裸键 ⇒ 断言必须红且点名缺的是哪个键", () => {
        // 只给一个**别处**的键，刻意漏掉 settings.skills.title —— 复刻 task-87 的事故形态。
        const partial = createI18n({
            legacy: false,
            locale: "zh-CN",
            messages: { "zh-CN": { common: { ok: "好" } }, "en-US": { common: { ok: "OK" } } },
        });
        const wrapper = mountRendering(partial, "settings.skills.title");

        expect(wrapper.text()).toBe("settings.skills.title"); // 裸键真的出现在 DOM 里
        expect(() => expectNoRawI18nKey(wrapper.html())).toThrowError(/settings\.skills\.title/);
        expect(findRawI18nKeys(wrapper.html())).toContain("settings.skills.title");
    });

    it("正例：用真 locale 渲染 ⇒ 出译文、断言干净", () => {
        const wrapper = mountRendering(i18n, "settings.skills.title");
        expect(wrapper.text()).not.toBe("settings.skills.title");
        expect(wrapper.text().trim().length).toBeGreaterThan(0);
        expect(findRawI18nKeys(wrapper.html())).toEqual([]);
        expectNoRawI18nKey(wrapper.html());
    });

    it("假阳性守卫：路径与字段名不是键", () => {
        const html = [
            "<li>skills/commit-msg-review/SKILL.md</li>",
            "<code>mcpServers</code>",
            "<span>workspace.id</span>",
            "<span>settings.skillsXtitle</span>",
        ].join("");
        expect(findRawI18nKeys(html)).toEqual([]);
        // 边界判据：真键 + 标识符字符相邻时不算命中
        expect(findRawI18nKeys("<i>settings.skills.titleExtra</i>")).toEqual([]);
    });
});
