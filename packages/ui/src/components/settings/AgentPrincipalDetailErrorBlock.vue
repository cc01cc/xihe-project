<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import type { ErrorPresentation } from "../../lib/errorMessages";

/**
 * task-191：task-45 **诊断面**错误块 —— 可读文案 + 错误码（可复制）+ 折叠技术详情
 * （默认折叠、为空不渲染空壳），与 ToolFacesView 的既有模式逐条同形。
 */
defineProps<{
    presentation: ErrorPresentation;
    testid: string;
}>();
const { t } = useI18n();
</script>

<template>
    <div
        class="rounded-md border border-destructive/30 bg-background p-3 text-sm text-destructive"
        :data-testid="testid"
        role="alert"
    >
        <p>{{ presentation.copy }}</p>
        <p v-if="presentation.code" class="mt-1 text-xs text-muted-foreground">
            <span>{{ t("errors.errorCodeLabel") }}</span>
            <code
                class="select-all rounded border bg-muted/40 px-1 py-0.5 font-mono text-[11px] text-foreground"
                :data-testid="testid + '-code'"
                >{{ presentation.code }}</code
            >
        </p>
        <Collapsible v-if="presentation.technicalDetail">
            <CollapsibleTrigger as-child>
                <button
                    type="button"
                    class="mt-1 text-xs text-muted-foreground underline underline-offset-2"
                    :data-testid="testid + '-detail-toggle'"
                >
                    {{ t("errors.technicalDetail") }}
                </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
                <pre
                    class="mt-1 max-h-40 overflow-auto rounded border bg-muted/40 p-2 font-mono text-[11px] whitespace-pre-wrap break-all text-muted-foreground"
                    :data-testid="testid + '-detail-body'"
                    >{{ presentation.technicalDetail }}</pre>
            </CollapsibleContent>
        </Collapsible>
    </div>
</template>
