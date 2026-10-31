import { computed } from "vue";
import { defineStore } from "pinia";
import { useLocalStorage } from "@vueuse/core";
import type { Language } from "../types";
import { DEFAULT_LOCALE, applyLocale, normalizeLocale } from "../i18n/locale";

export const useSettingsStore = defineStore("settings", () => {
    const theme = useLocalStorage<"dark" | "light" | "system">("xihe-theme", "system"),
        // PLAN-0602: VueUse persists this key as JSON, so both read and write stay JSON-shaped.
        storedLanguage = useLocalStorage<Language>("xihe-language", DEFAULT_LOCALE),
        // Always a supported locale: legacy/hand-edited values are normalized on read.
        language = computed<Language>(() => normalizeLocale(storedLanguage.value));

    /** Applies a language choice to vue-i18n, `<html lang>` and the persisted key. */
    function setLanguage(next: unknown): Language {
        const resolved = normalizeLocale(next);
        storedLanguage.value = resolved;
        return applyLocale(resolved);
    }

    /** Boot hook: apply (and clean) the persisted value before the first paint. */
    function initLanguage(): Language {
        const resolved = normalizeLocale(storedLanguage.value);
        if (storedLanguage.value !== resolved) storedLanguage.value = resolved;
        return applyLocale(resolved);
    }

    return {
        theme,
        language,
        setLanguage,
        initLanguage,
    };
});
