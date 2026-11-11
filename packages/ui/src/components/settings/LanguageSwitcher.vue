<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { SUPPORTED_LOCALES } from "../../i18n/locale";
import { useSettingsStore } from "../../stores/settings";
import type { Language } from "../../types";

/**
 * 界面语言切换 —— **全仓唯一实现**（PLAN-0602）。
 *
 * task-125 / D-899：compact 变体（NavRail / 移动抽屉，task-36 ③）已删除 ——
 * 用户裁定「语言切换放到设置里吧」，Lead 裁定不分 rail/抽屉。唯一入口 = 本组件（bar）
 * 与 user-preference 面板的 language 键（ConfigLayerPanels，方案 B 薄皮肤，同一 setLanguage 状态机）。
 * testid 保持 `settings-language-*`；原 `app-language-*` 前缀随变体消失
 * （e2e 迁移见 plan-0602-i18n.spec.ts 的 switchLanguageViaSettings）。
 *
 * <p>只调 `settings.setLanguage()`：它内部先落持久化键再 `applyLocale()`
 * （写 `i18n.global.locale` 与 `<html lang>`），因此不存在第二套 locale 状态。</p>
 */
const { t } = useI18n(),
    settings = useSettingsStore(),
    LABELS: Record<Language, string> = {
        "zh-CN": "settings.languageZh",
        "en-US": "settings.languageEn",
    };
</script>

<template>
    <div
        class="mb-3 flex flex-wrap items-center gap-2 rounded border bg-muted/40 px-3 py-2 text-xs"
        data-testid="settings-language-switcher"
    >
        <span class="text-muted-foreground">{{ t("settings.languageLabel") }}</span>
        <button
            v-for="locale in SUPPORTED_LOCALES"
            :key="locale"
            type="button"
            :data-testid="`settings-language-${locale}`"
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
</template>
