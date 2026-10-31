<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { SUPPORTED_LOCALES } from "../../i18n/locale";
import { useSettingsStore } from "../../stores/settings";
import type { Language } from "../../types";

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
                    ? 'border-primary bg-primary/10 font-medium'
                    : 'border-transparent hover:bg-accent'
            "
            @click="settings.setLanguage(locale)"
        >
            {{ t(LABELS[locale]) }}
        </button>
        <span class="text-muted-foreground">{{ t("settings.languageHint") }}</span>
    </div>
</template>
