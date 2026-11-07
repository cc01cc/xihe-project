<script setup lang="ts">
/**
 * PLAN-0688: the single approve/reject pair shared by the generic tool card and
 * the dedicated command/patch/read cards. The caller owns the pending gate, so
 * this component stays a pure action surface.
 */
import { useI18n } from "vue-i18n";

defineProps<{ toolCallId: string }>();
const emit = defineEmits<{ approve: [id: string]; reject: [id: string] }>();
const { t } = useI18n();
</script>

<template>
    <div class="flex gap-2 pt-1">
        <button
            type="button"
            class="rounded bg-action px-3 py-1 text-xs text-action-foreground hover:opacity-90"
            data-testid="tool-approve"
            @click="emit('approve', toolCallId)"
        >
            {{ t("chat.approve") }}
        </button>
        <button
            type="button"
            class="rounded border px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
            data-testid="tool-reject"
            @click="emit('reject', toolCallId)"
        >
            {{ t("chat.reject") }}
        </button>
    </div>
</template>
