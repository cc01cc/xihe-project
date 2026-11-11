<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ConfigKeyMeta, ConfigLayer } from "../../stores/config";

const { t } = useI18n();

const props = defineProps<{
    domain: string;
    layer: ConfigLayer;
    meta?: Record<string, ConfigKeyMeta>;
}>();

/**
 * task-170 / F-07：这里列出的是 CP meta 的**审计明细**（`domain.key` 技术标识 +
 * source 机器值）。它有用，但默认铺在正文里就是把 wire 词表端给用户看，所以
 * 默认收起、展开才见明细（判据原话：审计信息收进可折叠的「高级」区）。
 *
 * 顶层只保留一句人话结论，由 `summaryText` 生成；行内 source 词已 i18n 化
 * （`instance` ⇒ 实例层），技术标识仍在展开区，属于「消音」而非丢弃。
 */
const expanded = ref(false);

const rows = computed(() =>
    Object.values(props.meta ?? {}).sort((a, b) => a.key.localeCompare(b.key)),
);

const summaryText = computed(() => {
    if (rows.value.length === 0) return "";
    const inherited = rows.value.filter((item) => !item.locked && item.source !== props.layer);
    const readonly = rows.value.filter((item) => item.writable === false);
    const parts = [t("settings.configSourceTitle")];
    if (inherited.length > 0) {
        parts.push(t("settings.configSummaryInheritedMany", { count: inherited.length }));
    }
    if (readonly.length > 0) parts.push(t("settings.configSourceReadonly"));
    return parts.join(" · ");
});

function sourceText(item: ConfigKeyMeta): string {
    switch (item.source) {
        case "env":
            return t("settings.configSourceEnv");
        case "workspace":
            return t("settings.configSourceWorkspace");
        case "workspace-default":
            return t("settings.configSourceWorkspaceDefault");
        case "user":
            return t("settings.configSourceUser");
        case "instance":
            return t("settings.configSourceInstance");
        case "code":
            return t("settings.configSourceCode");
        default:
            return t("settings.configSourceNone");
    }
}

function hint(item: ConfigKeyMeta): string {
    if (item.locked) return t("settings.configSourceEnv");
    if (item.source === "none") return t("settings.configSourceNone");
    if (item.source !== props.layer) {
        return t("settings.configSourceInherited", { source: sourceText(item) });
    }
    if (!item.writable) return t("settings.configSourceReadonly");
    return "";
}
</script>

<template>
    <div
        v-if="rows.length"
        :data-testid="`config-source-summary-${domain}`"
        class="mt-2 rounded border px-3 py-2 text-xs"
    >
        <div class="flex min-w-0 items-center gap-2">
            <p class="min-w-0 truncate font-medium">{{ summaryText }}</p>
            <button
                type="button"
                :data-testid="`config-source-summary-toggle-${domain}`"
                class="ml-auto shrink-0 underline underline-offset-2 hover:text-foreground"
                :aria-expanded="expanded"
                @click="expanded = !expanded"
            >
                {{ expanded ? t("settings.configSummaryHide") : t("settings.configSummaryShow") }}
            </button>
        </div>
        <div v-if="expanded" class="mt-1 space-y-0.5">
            <div
                v-for="item in rows"
                :key="item.key"
                :data-testid="`config-source-row-${domain}-${item.key}`"
                class="flex min-w-0 items-center gap-2 py-0.5"
            >
                <code class="min-w-0 flex-1 truncate font-mono text-[11px]">
                    {{ domain }}.{{ item.key }}
                </code>
                <span class="shrink-0 rounded border border-border px-1 py-0.5 text-[10px]">
                    {{ sourceText(item) }}
                </span>
                <span v-if="hint(item)" class="min-w-0 truncate text-[10px] text-muted-foreground">
                    {{ hint(item) }}
                </span>
            </div>
        </div>
    </div>
</template>
