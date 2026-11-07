<script setup lang="ts">
/**
 * PLAN-0688 T1.3: shared raw Arguments/Result block for the dedicated cards.
 *
 * Expansion and the 2000-character result preview live here, so each card passes
 * only the raw strings. The generic ToolCallCard keeps its diagnostics-coupled
 * raw block because its visibility rule is different.
 */
import { computed, ref } from "vue";
import { ChevronDown } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { useCharPreview } from "./toolCardPreview";

const props = defineProps<{
    argumentsText: string;
    resultText: string | null;
    showResult: boolean;
}>();

const rawExpanded = ref(false);
const { t } = useI18n();
const rawResultText = computed(() => props.resultText ?? "");
const { preview: rawResultPreview, truncated: rawResultTruncated } = useCharPreview(rawResultText);
</script>

<template>
    <div class="border-t border-border/60 pt-1.5">
        <button
            type="button"
            class="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            :aria-expanded="rawExpanded"
            data-testid="raw-output-toggle"
            @click="rawExpanded = !rawExpanded"
        >
            <ChevronDown
                class="size-3 transition-transform"
                :class="rawExpanded ? 'rotate-180' : ''"
                aria-hidden="true"
            />
            {{ t("chat.toolRawOutput") }}
        </button>
        <div v-if="rawExpanded" class="mt-1.5 space-y-2 font-mono text-muted-foreground">
            <div>
                <div class="mb-1 font-medium text-foreground">Arguments</div>
                <pre
                    class="rounded bg-muted/30 p-2 whitespace-pre-wrap break-all"
                    data-testid="raw-arguments"
                    >{{ argumentsText }}</pre>
            </div>
            <div v-if="showResult">
                <div class="mb-1 font-medium text-foreground">Result</div>
                <pre
                    class="rounded bg-muted/30 p-2 whitespace-pre-wrap break-all"
                    data-testid="raw-result"
                    >{{ rawResultPreview }}</pre>
                <p v-if="rawResultTruncated" class="mt-1 text-muted-foreground">
                    {{ t("chat.toolCard.truncated") }}
                </p>
            </div>
        </div>
    </div>
</template>
