import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { ref } from "vue";
import ColorSchemePanel from "../ColorSchemePanel.vue";
import { RadioGroup } from "../../ui/radio-group";
import {
    COLOR_SCHEMES,
    COLOR_SCHEME_ATTRIBUTE,
    COLOR_SCHEME_STORAGE_KEY,
    DEFAULT_COLOR_SCHEME,
} from "../../../lib/colorScheme";
import { __resetColorSchemeSingletonForTests } from "../../../composables/useColorScheme";

/**
 * task-48 M2：设置区 · 外观 · 配色方案面板。
 *
 * 断言的是**契约**而不是外观：
 * 1. 5 个官方 base color + 明暗 3 档都在（少一个选项 = 用户看不到某个方案）；
 * 2. 选中即落库 + 立刻投影到 `<html data-xh-color>`（持久化反转的核心）；
 * 3. 默认方案的 DEFAULT 角标只在默认项上出现（用户圈定默认后角标跟着走）。
 *
 * 用 `RadioGroup` 的 `update:model-value` 触发选择，而不是去点 reka 的 radio 按钮：
 * 组件与库的接缝就是这条事件，点按路径属于 reka-ui 自己的测试范畴（本仓对 vendor 组件的
 * 交互一律用 Playwright 验，见 DEV-010）。
 */
const setColorMode = vi.fn<(mode: "light" | "dark" | "system") => void>();

vi.mock("../../../composables/useTheme", () => ({
    useTheme: () => ({ colorMode: ref("light"), setColorMode }),
}));

const messages = {
    "zh-CN": {
        settings: {
            colorScheme: {
                title: "配色方案",
                hint: "提示",
                previewLabel: "当前方案实样",
                modeLabel: "明暗",
                modeLight: "浅色",
                modeDark: "深色",
                modeSystem: "跟随系统",
                options: {
                    neutral: "中性 Neutral",
                    gray: "灰 Gray",
                    slate: "石板 Slate",
                    stone: "暖石 Stone",
                    zinc: "锌 Zinc",
                },
            },
        },
    },
};

const i18n = createI18n({ legacy: false, locale: "zh-CN", messages });

function mountPanel() {
    return mount(ColorSchemePanel, { global: { plugins: [i18n] } });
}

beforeEach(() => {
    setColorMode.mockClear();
    localStorage.clear();
    document.documentElement.removeAttribute(COLOR_SCHEME_ATTRIBUTE);
    __resetColorSchemeSingletonForTests();
});

afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute(COLOR_SCHEME_ATTRIBUTE);
});

describe("ColorSchemePanel", () => {
    it("渲染 5 个官方 base color 选项", () => {
        const wrapper = mountPanel();
        for (const scheme of COLOR_SCHEMES) {
            expect(
                wrapper.find(`[data-testid="settings-color-scheme-${scheme}"]`).exists(),
                `${scheme} 选项缺失`,
            ).toBe(true);
        }
        expect(
            wrapper.findAll('[data-testid^="settings-color-scheme-"] input, [role="radio"]').length,
        ).toBeGreaterThanOrEqual(COLOR_SCHEMES.length);
    });

    it("渲染明暗三档（light/dark/system）", () => {
        const wrapper = mountPanel();
        for (const mode of ["light", "dark", "system"]) {
            expect(
                wrapper.find(`[data-testid="settings-color-mode-${mode}"]`).exists(),
                `${mode} 档缺失`,
            ).toBe(true);
        }
    });

    it("选中方案 ⇒ 写 localStorage 并投影到 <html data-xh-color>", async () => {
        const wrapper = mountPanel();
        const groups = wrapper.findAllComponents(RadioGroup);
        // 第一个 RadioGroup = 配色方案；第二个 = 明暗
        await groups[0].vm.$emit("update:model-value", "slate");

        expect(localStorage.getItem(COLOR_SCHEME_STORAGE_KEY)).toBe("slate");
        expect(document.documentElement.getAttribute(COLOR_SCHEME_ATTRIBUTE)).toBe("slate");
    });

    it("切明暗走 useTheme.setColorMode（不自己写 localStorage）", async () => {
        const wrapper = mountPanel();
        const groups = wrapper.findAllComponents(RadioGroup);
        await groups[1].vm.$emit("update:model-value", "dark");

        expect(setColorMode).toHaveBeenCalledWith("dark");
        expect(localStorage.getItem("xihe-theme")).toBeNull();
    });

    it("DEFAULT 角标只在默认方案项上出现", () => {
        const wrapper = mountPanel();
        const marker = '[data-testid="settings-color-scheme-neutral"]';
        expect(wrapper.find(marker).text()).toContain("DEFAULT");
        expect(
            wrapper.find('[data-testid="settings-color-scheme-slate"]').text(),
            "非默认项不该带 DEFAULT 角标",
        ).not.toContain("DEFAULT");
        expect(DEFAULT_COLOR_SCHEME).toBe("neutral");
    });
});
