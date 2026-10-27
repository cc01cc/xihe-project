<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ConfigKeyMeta, ConfigLayer } from "../../stores/config";

const { t } = useI18n();

const props = defineProps<{
    domain: string;
    layer: ConfigLayer;
    meta?: Record<string, ConfigKeyMeta>;
}>();

const rows = computed(() =>
    Object.values(props.meta ?? {}).sort((a, b) => a.key.localeCompare(b.key)),
);

function sourceText(item: ConfigKeyMeta): string {
    switch (item.source) {
        case "env":
            return t("settings.configSourceEnv");
        case "workspace":
            return t("settings.configSourceWorkspace");
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
        <p class="mb-1 font-medium">
            {{ t("settings.configSourceTitle") }}
        </p>
        <div v-for="item in rows" :key="item.key" class="flex min-w-0 items-center gap-2 py-0.5">
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
</template>
