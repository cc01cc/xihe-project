import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyLocale, DEFAULT_LOCALE, normalizeLocale, SUPPORTED_LOCALES } from "../locale";
import { i18n } from "../index";

beforeEach(() => {
    applyLocale(DEFAULT_LOCALE);
});

afterEach(() => {
    applyLocale(DEFAULT_LOCALE);
});

describe("i18n locale resolution (PLAN-0602)", () => {
    it("ships exactly the two supported locales", () => {
        expect([...SUPPORTED_LOCALES]).toEqual(["zh-CN", "en-US"]);
        expect(i18n.global.availableLocales).toEqual(expect.arrayContaining(["zh-CN", "en-US"]));
    });

    it("normalizes supported spellings and falls back for unknown input", () => {
        expect(normalizeLocale("zh-CN")).toBe("zh-CN");
        expect(normalizeLocale("zh_Hans")).toBe("zh-CN");
        expect(normalizeLocale("zh")).toBe("zh-CN");
        expect(normalizeLocale("en-US")).toBe("en-US");
        expect(normalizeLocale("EN_us")).toBe("en-US");
        expect(normalizeLocale("en")).toBe("en-US");
        expect(normalizeLocale("fr-FR")).toBe("zh-CN");
        expect(normalizeLocale("")).toBe("zh-CN");
        expect(normalizeLocale(null)).toBe("zh-CN");
        expect(normalizeLocale(undefined)).toBe("zh-CN");
        expect(normalizeLocale({ locale: "en-US" })).toBe("zh-CN");
        // Legacy/hand-written JSON-quoted form is still resolved (store rewrites it to raw).
        expect(normalizeLocale(JSON.stringify("en-US"))).toBe("en-US");
        expect(normalizeLocale(JSON.stringify("zh-CN"))).toBe("zh-CN");
    });

    it("applies the locale to vue-i18n and <html lang> together", () => {
        expect(applyLocale("en-US")).toBe("en-US");
        expect(i18n.global.locale.value).toBe("en-US");
        expect(document.documentElement.lang).toBe("en-US");
        expect(i18n.global.t("settings.languageLabel")).toBe("Interface language");

        expect(applyLocale("zh-CN")).toBe("zh-CN");
        expect(i18n.global.locale.value).toBe("zh-CN");
        expect(document.documentElement.lang).toBe("zh-CN");
        expect(i18n.global.t("settings.languageLabel")).toBe("界面语言");
    });

    it("cleans an invalid value back to the default in every sink", () => {
        expect(applyLocale("klingon")).toBe("zh-CN");
        expect(i18n.global.locale.value).toBe("zh-CN");
        expect(document.documentElement.lang).toBe("zh-CN");
    });
});
