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
