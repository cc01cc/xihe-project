import { i18n } from "./index";
import type { Language } from "../types";

/**
 * PLAN-0602: single place that resolves and applies the runtime locale.
 *
 * VueUse's `useLocalStorage` persists a string default as a RAW string (`xihe-language` = `en-US`),
 * but hand-edited or JSON-written files may hold the quoted form (`"en-US"`). Callers pass the
 * deserialized value here; `normalizeLocale` accepts either shape plus legacy aliases.
 */
export const DEFAULT_LOCALE: Language = "zh-CN",
    SUPPORTED_LOCALES: readonly Language[] = ["zh-CN", "en-US"];

/** Accepts the legacy JSON-quoted form (`"en-US"`) that hand-edited values use. */
function stripJsonQuotes(value: string): string {
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        try {
            const parsed: unknown = JSON.parse(value);
            if (typeof parsed === "string") return parsed;
        } catch {
            // fall through: keep the raw value and let the alias switch decide
        }
    }
    return value;
}

/** Resolves any persisted/legacy value to a supported locale; unknown input falls back to zh-CN. */
export function normalizeLocale(raw: unknown): Language {
    if (typeof raw !== "string") return DEFAULT_LOCALE;
    switch (stripJsonQuotes(raw).trim().toLowerCase().replace(/_/g, "-")) {
        case "zh":
        case "zh-cn":
        case "zh-hans":
        case "zh-hans-cn":
        case "zh-chs":
            return "zh-CN";
        case "en":
        case "en-us":
        case "en-gb":
        case "en-lang":
            return "en-US";
        default:
            return DEFAULT_LOCALE;
    }
}

/** Applies the locale to vue-i18n and to `<html lang>`; returns the resolved locale. */
export function applyLocale(raw: unknown): Language {
    const resolved = normalizeLocale(raw);
    i18n.global.locale.value = resolved;
    if (typeof document !== "undefined") {
        document.documentElement.lang = resolved;
    }
    return resolved;
}
