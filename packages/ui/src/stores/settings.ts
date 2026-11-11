import { computed } from "vue";
import { defineStore } from "pinia";
import { useLocalStorage } from "@vueuse/core";
import type { Language } from "../types";
import { DEFAULT_LOCALE, applyLocale, normalizeLocale } from "../i18n/locale";

/**
 * 明暗（`task-65`）：`xihe-theme` 的**唯一**持久化面。
 *
 * <p>为什么把它从 `useTheme` 里提出来成模块级单例：此前同一个键有**两个写者、两种序列化** ——
 * `useColorMode({storageKey})` 写裸字符串 `dark`，而另一个 `useLocalStorage` 写 JSON `"dark"`，
 * `index.html` 的预涂脚本按 JSON 解析（遇到裸值 `JSON.parse("dark")` 抛错 ⇒ 不加 `dark` 类），
 * 于是用户"点了深色、刷新回到浅色"。现在**只有这一处写 localStorage**，形态固定**裸值**，
 * `useColorMode` 降级为受控的应用层（见 `composables/useTheme.ts`），预涂脚本两种形态都读。</p>
 *
 * <p>`xihe-color-scheme`（配色方案）是**另一条轴**，本文件不读不写。</p>
 */
export const THEME_STORAGE_KEY = "xihe-theme";

export type ThemeMode = "light" | "dark" | "system";

const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "system"];

function isThemeMode(value: unknown): value is ThemeMode {
    return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value);
}

/**
 * 归一化磁盘上的原始值：**两种历史写法都要能读**。
 *
 * - 裸值（**规范形态**，与 `xihe-language` 等字符串型偏好键一致）：`dark` → `dark`
 * - JSON 引号形态（历史/手改/别的写者留下的）：`"dark"` → `dark`
 * - 其它/损坏：`null`（交给调用方决定"丢弃"）
 */
export function parseStoredTheme(raw: string | null): ThemeMode | null {
    if (raw === null) return null;
    if (isThemeMode(raw)) return raw;
    try {
        const parsed: unknown = JSON.parse(raw);
        return isThemeMode(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export interface ThemeMigrationResult {
    /** `absent` = 没有存过；`clean` = 已是规范 JSON；`migrated` = 从裸值改写；`dropped` = 无法识别已丢弃。 */
    status: "absent" | "clean" | "migrated" | "dropped";
    value: ThemeMode | null;
}

/**
 * 一次性迁移：把历史 **JSON 引号形态**改写成**裸值**（规范形态）。返回迁移结果（供单测断言）。
 *
 * <p>为什么规范形态是裸值而不是 JSON：VueUse 的 `useLocalStorage` 对**字符串默认值**用
 * string serializer（落盘就是裸值），本仓 `xihe-language` 同样如此，`src/i18n/locale.ts` 的注释
 * 明确把 JSON 引号形态列为"历史/手改"兼容项。选 JSON 当规范就得给每个读取点加反序列化，
 * 而裸值只需在读取点容忍引号形态 —— 与既有约定一致，代码更少。</p>
 *
 * <p>为什么要"就地回写"：迁移只需正确一次。若只在读时兼容、不回写，用户每次刷新都要走兼容分支，
 * 且下一次任何写者再写入时又会产生第三种形态。</p>
 */
export function migrateLegacyThemeValue(
    storage: Storage | null = globalThis.localStorage ?? null,
): ThemeMigrationResult {
    if (!storage) return { status: "absent", value: null };
    const raw = storage.getItem(THEME_STORAGE_KEY);
    if (raw === null) return { status: "absent", value: null };

    const value = parseStoredTheme(raw);
    if (value === null) {
        storage.removeItem(THEME_STORAGE_KEY);
        return { status: "dropped", value: null };
    }

    if (raw !== value) {
        storage.setItem(THEME_STORAGE_KEY, value);
        return { status: "migrated", value };
    }
    return { status: "clean", value };
}

/** 模块加载即迁移一次：`main.ts` 只 import 本 store 就足够，无需额外 boot hook。 */
const BOOT_MIGRATION = migrateLegacyThemeValue();

/**
 * 明暗 SSOT（模块级 ref，不依赖 Pinia 实例，composable 与 store 共用同一份）。
 * 落盘形态固定为**裸值**（`dark` / `light` / `system`）—— 这是 `task-65` 的**负断言**基准：
 * 任何动作后磁盘上只允许这一种形态，不允许再出现 `"dark"` 这类 JSON 引号形态。
 */
export const themeStorage = useLocalStorage<ThemeMode>(THEME_STORAGE_KEY, "system");

// 迁移结果应用到 ref：`useLocalStorage` 在迁移**之前**就读过一次旧裸值（会回落到默认 "system"），
// 这里用迁移结果纠正，避免"迁移写回了 JSON，但内存里还是旧默认"。
if (BOOT_MIGRATION.value && themeStorage.value !== BOOT_MIGRATION.value) {
    themeStorage.value = BOOT_MIGRATION.value;
}

export const useSettingsStore = defineStore("settings", () => {
    const theme = themeStorage,
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
