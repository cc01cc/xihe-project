import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { defineComponent, h } from "vue";

import { findRawI18nKeys, knownI18nKeys } from "../i18nKeys";
import { i18n } from "../../i18n";

/**
 * task-105 · 裸 i18n 键护栏的自测（正负例）。
 *
 * 护栏有两半：
 *  ① `findRawI18nKeys(html)` —— 判据本体（只认逐字等于真实 locale 键的 token）；
 *  ② **接线**：`.spec.ts` 里的 `@vue/test-utils` 被 vite 插件改指向 `../vueTestUtils.ts`，
 *     `mount()` 返回前自动跑断言 —— 所以这里的"负例"就是**调 mount 应该抛**，
 *     这是"helper 真的生效"的唯一硬证据（不是靠人记得加一行）。
 */
function viewOf(plugin: ReturnType<typeof createI18n>, key: string) {
    return defineComponent({
        setup() {
            return () => h("p", { "data-testid": "t" }, String(plugin.global.t(key)));
        },
    });
}

describe("i18nKeys 裸键护栏（task-105）", () => {
    it("知道本仓的真实键集合（非空，且含已知键）", () => {
        const keys = knownI18nKeys();
        expect(keys.size).toBeGreaterThan(2000);
        expect(keys.has("settings.skills.title")).toBe(true);
    });

    it("负例：夹具缺键 ⇒ 挂载即抛，且点名缺的是哪个键", () => {
        // 复刻 task-87 的事故形态：夹具只给了别处的键，组件要的键不在里面。
        const partial = createI18n({
            legacy: false,
            locale: "zh-CN",
            messages: { "zh-CN": { common: { ok: "好" } }, "en-US": { common: { ok: "OK" } } },
        });
        const View = viewOf(partial, "settings.skills.title");

        expect(() => mount(View, { global: { plugins: [partial] } })).toThrowError(
            /settings\.skills\.title/,
        );
    });

    it("正例：用真 locale 渲染 ⇒ 挂载成功、断言干净", () => {
        const View = viewOf(i18n, "settings.skills.title");
        const wrapper = mount(View, { global: { plugins: [i18n] } });
        expect(wrapper.text()).not.toBe("settings.skills.title");
        expect(wrapper.text().trim().length).toBeGreaterThan(0);
        expect(findRawI18nKeys(wrapper.html())).toEqual([]);
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
        // 对照：逐字命中必须报
        expect(findRawI18nKeys("<i>settings.skills.title</i>")).toEqual(["settings.skills.title"]);
    });
});
