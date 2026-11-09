<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { SUPPORTED_LOCALES } from "../../i18n/locale";
import { useSettingsStore } from "../../stores/settings";
import type { Language } from "../../types";

/**
 * 界面语言切换 —— **全仓唯一实现**（PLAN-0602）。
 *
 * <p>两个变体，行为完全相同，只有外形与 testid 不同：</p>
 * <ul>
 *   <li>`bar`（默认）：设置页那条带解释文字的完整提示条。testid 保持 `settings-language-*`，
 *       `e2e/real/plan-0602-i18n.spec.ts` 与 `LanguageSwitcher.spec.ts` 依赖它。</li>
 *   <li>`compact`：导航栏 / 移动侧栏底部那种 1 行小控件（task-36 ③）。它用**独立 testid 前缀**
 *       `app-language-*`：设置页上两个变体会同时存在，共用 testid 会让 `getByTestId` 命中 2 个元素
 *       （Playwright strict mode 直接报错）。</li>
 * </ul>
 *
 * <p>两个变体都只调 `settings.setLanguage()`：它内部先落持久化键再 `applyLocale()`
 * （写 `i18n.global.locale` 与 `<html lang>`），因此不存在第二套 locale 状态。</p>
 */
const props = withDefaults(defineProps<{ variant?: "bar" | "compact" }>(), { variant: "bar" });

const { t } = useI18n(),
    settings = useSettingsStore(),
    LABELS: Record<Language, string> = {
        "zh-CN": "settings.languageZh",
        "en-US": "settings.languageEn",
    },
    /** 58px 导航栏里放不下语种全名，只显示能一眼认出的短标记。 */
    SHORT: Record<Language, string> = {
        "zh-CN": "中",
        "en-US": "EN",
    };

const isCompact = computed(() => props.variant === "compact");
const rootTestId = computed(() =>
    isCompact.value ? "app-language-switcher" : "settings-language-switcher",
);
function itemTestId(locale: Language): string {
    return isCompact.value ? `app-language-${locale}` : `settings-language-${locale}`;
}
</script>

<template>
    <div
        v-if="!isCompact"
        class="mb-3 flex flex-wrap items-center gap-2 rounded border bg-muted/40 px-3 py-2 text-xs"
        :data-testid="rootTestId"
    >
        <span class="text-muted-foreground">{{ t("settings.languageLabel") }}</span>
        <button
            v-for="locale in SUPPORTED_LOCALES"
            :key="locale"
            type="button"
            :data-testid="itemTestId(locale)"
            :aria-pressed="settings.language === locale"
            class="rounded border px-2 py-1 transition-colors"
            :class="
                settings.language === locale
                    ? 'border-brand bg-brand/10 font-medium'
                    : 'border-transparent hover:bg-accent'
            "
            @click="settings.setLanguage(locale)"
        >
            {{ t(LABELS[locale]) }}
        </button>
        <span class="text-muted-foreground">{{ t("settings.languageHint") }}</span>
    </div>

    <div
        v-else
        class="flex items-center gap-1"
        role="group"
        :aria-label="t('settings.languageLabel')"
        :data-testid="rootTestId"
    >
        <button
            v-for="locale in SUPPORTED_LOCALES"
            :key="locale"
            type="button"
            :data-testid="itemTestId(locale)"
            :aria-pressed="settings.language === locale"
            :aria-label="t(LABELS[locale])"
            :title="t(LABELS[locale])"
            class="rounded border px-1.5 py-0.5 text-[11px] leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :class="
                settings.language === locale
                    ? 'border-brand bg-brand/10 font-medium text-brand'
                    : 'border-transparent text-sidebar-foreground hover:bg-sidebar-accent'
            "
            @click="settings.setLanguage(locale)"
        >
            {{ SHORT[locale] }}
        </button>
    </div>
</template>
