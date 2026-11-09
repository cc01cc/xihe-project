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

const expanded = ref(false);

/**
 * PLAN-0752 T3.5 域级摘要行：「本域 N 项由上层设定」。
 *
 * 取数只认 CP meta（PLAN-0554 的 source/locked/writable/overridable 同一套），**UI 不自己算**：
 * 不比对本地 entries、不推测默认值。计入的是「值由更上层决定、本层改不了」的键：
 * - `locked`：部署环境变量覆盖（env 在优先级链最上层，DEV-003）；
 * - `adminLocked`：管理员把值钉在该键所在层（PLAN-0556）。实例层的 adminLocked 是**本层**行为，
 *   不算「上层」，故实例层只统计 `locked`。
 * 措辞用「由…设定」而不是「被覆盖」——后者读起来像故障（design §5.1 / lead 2026-11-10）。
 */
const inherited = computed(() => {
    const rows = Object.values(props.meta ?? {});
    return rows
        .filter((item) => item.locked || (props.layer !== "instance" && item.adminLocked === true))
        .sort((a, b) => a.key.localeCompare(b.key));
});

/** 摘要与列表用人话层名（「实例层」），不用 meta 里的机器值（`instance`）。 */
function sourceLabel(item: ConfigKeyMeta): string {
    if (item.locked) return t("settings.configSourceEnvShort");
    switch (item.source) {
        case "env":
            return t("settings.configSourceEnvShort");
        case "workspace":
            return t("settings.ia.layerWorkspaceShort");
        case "user":
            return t("settings.ia.layerUserShort");
        case "instance":
            return t("settings.ia.layerInstanceShort");
        default:
            return t("settings.configSourceUpper");
    }
}

/** 同一层来源时直接点名（「3 项由实例层设定」），混合来源时只说「上层」。 */
const summaryText = computed(() => {
    const rows = inherited.value;
    if (rows.length === 0) return "";
    const layers = new Set(rows.map((item) => sourceLabel(item)));
    if (layers.size === 1) {
        return t("settings.configSummaryInheritedLayer", {
            count: rows.length,
            source: rows[0] ? sourceLabel(rows[0]) : "",
        });
    }
    return t("settings.configSummaryInheritedMany", { count: rows.length });
});
</script>

<template>
    <div
        v-if="inherited.length"
        :data-testid="`config-domain-summary-${domain}`"
        class="border-b bg-muted/30 px-4 py-1.5 text-[11px] text-muted-foreground"
    >
        <div class="flex min-w-0 items-center gap-2">
            <span
                :data-testid="`config-domain-summary-text-${domain}`"
                class="min-w-0 truncate"
                :aria-label="summaryText"
                >{{ summaryText }}</span
            >
            <button
                type="button"
                :data-testid="`config-domain-summary-toggle-${domain}`"
                class="shrink-0 underline underline-offset-2 hover:text-foreground"
                :aria-expanded="expanded"
                @click="expanded = !expanded"
            >
                {{ expanded ? t("settings.configSummaryHide") : t("settings.configSummaryShow") }}
            </button>
        </div>
        <ul v-if="expanded" class="mt-1 space-y-0.5">
            <li
                v-for="item in inherited"
                :key="item.key"
                :data-testid="`config-domain-summary-row-${domain}-${item.key}`"
                class="flex min-w-0 items-center gap-2"
            >
                <code class="min-w-0 flex-1 truncate font-mono text-[10px]"
                    >{{ domain }}.{{ item.key }}</code
                >
                <span class="shrink-0 rounded border border-border px-1 py-0.5 text-[10px]">
                    {{ sourceLabel(item) }}
                </span>
            </li>
        </ul>
    </div>
</template>
