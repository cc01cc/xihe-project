<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Label } from "../ui/label";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import { useColorScheme } from "../../composables/useColorScheme";
import { useTheme } from "../../composables/useTheme";
import { COLOR_SCHEMES, DEFAULT_COLOR_SCHEME, type ColorScheme } from "../../lib/colorScheme";

/**
 * 设置区 · 外观 · 配色方案（task-48 M2，用户 2026-11-11 裁定：统一用 shadcn-vue 官方 5 个 base color）。
 *
 * 为什么是 RadioGroup 而不是自研按钮组：单选项语义 = `<input type="radio">`，键盘方向键、
 * 焦点环、`aria-checked` 全由 reka-ui 的 `RadioGroup` 提供（本仓已 vendor，见 `components/ui/radio-group`）。
 * 备选 `ToggleGroup` 也可用，但它语义是"切换开关组"，对 5 选 1 需要自己补 `aria-checked` 语义；
 * `Select` 会把 5 个选项藏进弹层，切方案想"挨个看一眼"就得多点两下。故取 RadioGroup。
 *
 * 为什么选项里没有色块缩略图：色值只在 `styles/themes/color-shadcn-*.css` 里存在一份（官方原值），
 * 在 TS 里再复制一套 RGB/oklch 就会漂移（改了 CSS 忘了 TS，缩略图开始说谎）。所以这里只给名字，
 * 直观预览靠下方"当前方案实样"——它直接吃当前生效 token，切方案即变。
 *
 * 明暗开关同一张卡：`useTheme` 的 `xihe-theme`（light/dark/system）本来就是唯一明暗入口，
 * 只是此前没有 UI 入口；5 方案 × 明暗要能并排看，缺了它这张卡就只能看一半。
 */
const { t } = useI18n();
const { colorScheme, setColorScheme } = useColorScheme();
const { colorMode, setColorMode } = useTheme();

const SCHEME_LABEL_KEYS: Record<ColorScheme, string> = {
    neutral: "settings.colorScheme.options.neutral",
    gray: "settings.colorScheme.options.gray",
    slate: "settings.colorScheme.options.slate",
    stone: "settings.colorScheme.options.stone",
    zinc: "settings.colorScheme.options.zinc",
};

const MODE_LABEL_KEYS = {
    light: "settings.colorScheme.modeLight",
    dark: "settings.colorScheme.modeDark",
    system: "settings.colorScheme.modeSystem",
} as const;
type ColorMode = keyof typeof MODE_LABEL_KEYS;
const MODES: ColorMode[] = ["light", "dark", "system"];

const options = computed(() =>
    COLOR_SCHEMES.map((value) => ({ value, label: t(SCHEME_LABEL_KEYS[value]) })),
);
const modeOptions = computed(() =>
    MODES.map((value) => ({ value, label: t(MODE_LABEL_KEYS[value]) })),
);
const isDefault = computed(() => colorScheme.value === DEFAULT_COLOR_SCHEME);
</script>

<template>
    <section
        data-testid="settings-color-scheme"
        class="mt-4 rounded-lg border border-border bg-card p-4"
        aria-labelledby="settings-color-scheme-title"
    >
        <h3 id="settings-color-scheme-title" class="text-sm font-medium text-card-foreground">
            {{ t("settings.colorScheme.title") }}
        </h3>
        <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
            {{ t("settings.colorScheme.hint") }}
        </p>

        <RadioGroup
            :model-value="colorScheme"
            class="mt-3 grid gap-2 sm:grid-cols-3"
            data-testid="settings-color-scheme-options"
            @update:model-value="(value) => setColorScheme(value as ColorScheme)"
        >
            <div
                v-for="option in options"
                :key="option.value"
                class="flex items-center gap-2 rounded-md border border-border px-2.5 py-2"
                :class="colorScheme === option.value ? 'bg-muted' : ''"
                :data-testid="'settings-color-scheme-' + option.value"
            >
                <RadioGroupItem :id="'color-scheme-' + option.value" :value="option.value" />
                <Label
                    :for="'color-scheme-' + option.value"
                    class="cursor-pointer text-sm font-normal"
                >
                    {{ option.label }}
                </Label>
                <span
                    v-if="colorScheme === option.value && isDefault"
                    class="ml-auto text-[11px] text-muted-foreground"
                >
                    DEFAULT
                </span>
            </div>
        </RadioGroup>

        <div class="mt-3 flex items-center gap-3" data-testid="settings-color-scheme-preview">
            <span class="text-xs text-muted-foreground">
                {{ t("settings.colorScheme.previewLabel") }}
            </span>
            <span
                class="h-6 w-6 rounded-md border border-border bg-background"
                aria-hidden="true"
            />
            <span class="h-6 w-6 rounded-md border border-border bg-muted" aria-hidden="true" />
            <span class="h-6 w-6 rounded-md border border-border bg-card" aria-hidden="true" />
            <span class="h-6 w-6 rounded-md bg-primary" aria-hidden="true" />
            <span class="h-6 w-6 rounded-md bg-secondary" aria-hidden="true" />
        </div>

        <div class="mt-4 border-t border-border pt-3">
            <p class="text-xs font-medium text-card-foreground">
                {{ t("settings.colorScheme.modeLabel") }}
            </p>
            <RadioGroup
                :model-value="colorMode"
                class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2"
                data-testid="settings-color-scheme-modes"
                @update:model-value="(value) => setColorMode(value as ColorMode)"
            >
                <div
                    v-for="option in modeOptions"
                    :key="option.value"
                    class="flex items-center gap-2"
                    :data-testid="'settings-color-mode-' + option.value"
                >
                    <RadioGroupItem :id="'color-mode-' + option.value" :value="option.value" />
                    <Label
                        :for="'color-mode-' + option.value"
                        class="cursor-pointer text-sm font-normal"
                    >
                        {{ option.label }}
                    </Label>
                </div>
            </RadioGroup>
        </div>
    </section>
</template>
