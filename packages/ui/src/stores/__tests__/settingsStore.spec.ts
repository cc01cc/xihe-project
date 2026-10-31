import { describe, it, expect, beforeEach } from "vitest";
import { nextTick } from "vue";
import { setActivePinia, createPinia } from "pinia";
import { useSettingsStore } from "../settings";
import { DEFAULT_LOCALE, applyLocale } from "../../i18n/locale";
import { i18n } from "../../i18n";

// `useLocalStorage` with a string default persists a RAW string and flushes on the next tick.
const persisted = () => localStorage.getItem("xihe-language");

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    applyLocale(DEFAULT_LOCALE);
});

describe("useSettingsStore", () => {
    it("theme defaults to system", () => {
        const store = useSettingsStore();
        expect(store.theme).toBe("system");
    });

    it("language defaults to zh-CN", () => {
        const store = useSettingsStore();
        expect(store.language).toBe("zh-CN");
    });

    it("boots from the persisted raw language and applies it to i18n and <html lang>", () => {
        localStorage.setItem("xihe-language", "en-US");
        setActivePinia(createPinia());
        const store = useSettingsStore();
        expect(store.language).toBe("en-US");

        expect(store.initLanguage()).toBe("en-US");
        expect(i18n.global.locale.value).toBe("en-US");
        expect(document.documentElement.lang).toBe("en-US");
    });

    it("tolerates the legacy JSON-quoted form and rewrites it to the raw form", async () => {
        localStorage.setItem("xihe-language", JSON.stringify("en-US"));
        setActivePinia(createPinia());
        const store = useSettingsStore();
        expect(store.language).toBe("en-US");

        expect(store.initLanguage()).toBe("en-US");
        await nextTick();
        expect(persisted()).toBe("en-US");
    });

    it("switches i18n + <html lang> + localStorage in one call", async () => {
        const store = useSettingsStore();
        store.setLanguage("en-US");
        await nextTick();

        expect(store.language).toBe("en-US");
        expect(i18n.global.locale.value).toBe("en-US");
        expect(document.documentElement.lang).toBe("en-US");
        expect(persisted()).toBe("en-US");
    });

    it("accepts legacy spellings and persists the canonical locale", async () => {
        const store = useSettingsStore();
        expect(store.setLanguage("en")).toBe("en-US");
        await nextTick();
        expect(persisted()).toBe("en-US");

        expect(store.setLanguage("zh_Hans")).toBe("zh-CN");
        await nextTick();
        expect(persisted()).toBe("zh-CN");
    });

    it("keeps the choice across a simulated reload", async () => {
        useSettingsStore().setLanguage("en-US");
        await nextTick();
        // Reload: new pinia + new store instance read the same persisted key.
        setActivePinia(createPinia());
        const reloaded = useSettingsStore();
        expect(reloaded.language).toBe("en-US");
        expect(reloaded.initLanguage()).toBe("en-US");
        expect(i18n.global.locale.value).toBe("en-US");
        expect(document.documentElement.lang).toBe("en-US");
    });

    it("falls back and rewrites localStorage when the persisted value is invalid", async () => {
        localStorage.setItem("xihe-language", "fr-FR");
        setActivePinia(createPinia());
        const store = useSettingsStore();
        expect(store.language).toBe("zh-CN");
        expect(store.initLanguage()).toBe("zh-CN");
        await nextTick();
        expect(persisted()).toBe("zh-CN");
        expect(i18n.global.locale.value).toBe("zh-CN");
        expect(document.documentElement.lang).toBe("zh-CN");
    });
});
