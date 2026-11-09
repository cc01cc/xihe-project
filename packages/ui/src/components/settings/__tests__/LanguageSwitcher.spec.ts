import { describe, it, expect, beforeEach } from "vitest";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { mount } from "@vue/test-utils";
import LanguageSwitcher from "../LanguageSwitcher.vue";
import { i18n } from "../../../i18n";
import { applyLocale, DEFAULT_LOCALE } from "../../../i18n/locale";
import { useSettingsStore } from "../../../stores/settings";

function mountSwitcher() {
    return mount(LanguageSwitcher, { global: { plugins: [i18n, createPinia()] } });
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    applyLocale(DEFAULT_LOCALE);
});

describe("LanguageSwitcher (PLAN-0602)", () => {
    it("renders both locales and marks the active one", async () => {
        const wrapper = mountSwitcher();
        expect(
            wrapper.get('[data-testid="settings-language-zh-CN"]').attributes("aria-pressed"),
        ).toBe("true");
        expect(
            wrapper.get('[data-testid="settings-language-en-US"]').attributes("aria-pressed"),
        ).toBe("false");
        expect(wrapper.text()).toContain("界面语言");

        await wrapper.get('[data-testid="settings-language-en-US"]').trigger("click");

        expect(
            wrapper.get('[data-testid="settings-language-en-US"]').attributes("aria-pressed"),
        ).toBe("true");
        expect(wrapper.text()).toContain("Interface language");
    });

    it("syncs i18n, <html lang> and localStorage through the settings store", async () => {
        const wrapper = mountSwitcher(),
            settings = useSettingsStore();

        await wrapper.get('[data-testid="settings-language-en-US"]').trigger("click");
        await nextTick();

        expect(settings.language).toBe("en-US");
        expect(i18n.global.locale.value).toBe("en-US");
        expect(document.documentElement.lang).toBe("en-US");
        expect(localStorage.getItem("xihe-language")).toBe("en-US");

        await wrapper.get('[data-testid="settings-language-zh-CN"]').trigger("click");
        await nextTick();

        expect(settings.language).toBe("zh-CN");
        expect(i18n.global.locale.value).toBe("zh-CN");
        expect(document.documentElement.lang).toBe("zh-CN");
        expect(localStorage.getItem("xihe-language")).toBe("zh-CN");
    });
});

/**
 * task-36 ③：紧凑变体（导航栏 / 移动侧栏底部）与设置页提示条**同时存在**，所以两套 testid 必须互斥：
 * 共用会导致 Playwright getByTestId 命中 2 个元素（strict mode 直接失败）。
 */
describe("LanguageSwitcher compact variant (task-36 ③)", () => {
    function mountCompact() {
        return mount(LanguageSwitcher, {
            props: { variant: "compact" },
            global: { plugins: [i18n, createPinia()] },
        });
    }

    it("uses its own test ids so it never collides with the settings bar", () => {
        const wrapper = mountCompact();

        expect(wrapper.find('[data-testid="app-language-switcher"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="app-language-zh-CN"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="app-language-en-US"]').exists()).toBe(true);
        // 提示条那套 id 一个都不能出现（它们在设置页由另一个实例负责）。
        expect(wrapper.find('[data-testid="settings-language-switcher"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="settings-language-zh-CN"]').exists()).toBe(false);
        // 紧凑变体不放解释文字，但每个按钮仍要能被读屏/悬浮识别。
        expect(wrapper.get('[data-testid="app-language-en-US"]').attributes("aria-label")).toBe(
            "English (en)",
        );
    });

    it("goes through the same store path (i18n + <html lang> + persistence)", async () => {
        const wrapper = mountCompact(),
            settings = useSettingsStore();

        await wrapper.get('[data-testid="app-language-en-US"]').trigger("click");
        await nextTick();

        expect(settings.language).toBe("en-US");
        expect(i18n.global.locale.value).toBe("en-US");
        expect(document.documentElement.lang).toBe("en-US");
        expect(localStorage.getItem("xihe-language")).toBe("en-US");
        expect(wrapper.get('[data-testid="app-language-en-US"]').attributes("aria-pressed")).toBe(
            "true",
        );
    });

    it("keeps the settings bar on its original default variant", () => {
        const wrapper = mountSwitcher();

        expect(wrapper.find('[data-testid="settings-language-switcher"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="app-language-switcher"]').exists()).toBe(false);
    });
});
