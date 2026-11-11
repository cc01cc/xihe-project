<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ChatRunGuidanceItem } from "../../../../composables/api";
import { useGuidance } from "../composables/useGuidance.ts";

const MAX_GUIDANCE_LENGTH = 8000;

const props = defineProps<{
    runId: string | undefined;
    runStatus: string;
}>();

const emit = defineEmits<{
    refreshNeeded: [];
}>();

const { t } = useI18n();
const input = ref("");

const guidance = useGuidance({
    runId: () => props.runId,
    runStatus: () => props.runStatus,
});

const { items, submitting, error, bannerError, isActiveRun, refetch, submit } = guidance;

const canSubmit = computed(() => {
    return (
        isActiveRun.value &&
        !submitting.value &&
        input.value.trim().length > 0 &&
        input.value.length <= MAX_GUIDANCE_LENGTH
    );
});

const showInput = computed(() => isActiveRun.value);

function itemStatusLabel(item: ChatRunGuidanceItem): string {
    if (item.status === "pending") return t("chat.guidanceStatusPending");
    if (item.status === "consumed") return t("chat.guidanceStatusConsumed");
    if (item.status === "terminal_expired") return t("chat.guidanceStatusExpired");
    return item.status;
}

function itemStatusClass(item: ChatRunGuidanceItem): string {
    if (item.status === "pending") return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
    if (item.status === "consumed")
        return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    if (item.status === "terminal_expired") return "bg-muted text-muted-foreground";
    return "bg-muted text-muted-foreground";
}

function formatTime(iso: string): string {
    if (!iso) return "";
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return iso;
    }
}

async function handleSubmit() {
    if (!canSubmit.value) return;
    const outcome = await submit(input.value);
    if (outcome === "ok" || outcome === "clear") {
        input.value = "";
    }
    emit("refreshNeeded");
}

function handleRefetch() {
    void refetch();
}

onMounted(() => {
    void refetch();
});

defineExpose({ refetch: handleRefetch });
</script>

<template>
    <div
        class="border-t border-border px-4 py-3 space-y-3 max-sm:px-3 max-sm:py-2"
        data-testid="guidance-panel"
    >
        <div class="flex items-center justify-between gap-2 flex-wrap">
            <h3 class="text-sm font-medium">{{ t("chat.guidancePanelTitle") }}</h3>
            <span class="text-xs text-muted-foreground">{{ t("chat.guidancePanelHint") }}</span>
        </div>

        <div
            v-if="bannerError"
            class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
            data-testid="guidance-banner-error"
        >
            {{ bannerError }}
        </div>

        <div v-if="error" class="text-xs text-muted-foreground" role="status">
            {{ error }}
        </div>

        <ul v-if="items.length > 0" class="space-y-2" data-testid="guidance-list">
            <li
                v-for="item in items"
                :key="item.id"
                class="rounded-md border border-border px-3 py-2"
                :data-status="item.status"
                :data-sequence="item.sequence"
            >
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-xs font-mono text-muted-foreground">
                        {{ t("chat.guidanceSequencePrefix", { sequence: item.sequence }) }}
                    </span>
                    <span
                        class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                        :class="itemStatusClass(item)"
                    >
                        {{ itemStatusLabel(item) }}
                    </span>
                    <span class="text-xs text-muted-foreground">
                        {{ t("chat.guidanceSourceUser") }}
                    </span>
                    <span class="text-xs text-muted-foreground ml-auto">
                        {{ formatTime(item.createdAt) }}
                    </span>
                </div>
                <p class="mt-1 text-sm whitespace-pre-wrap break-words">{{ item.content }}</p>
                <div class="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                    <span>{{
                        t("chat.guidanceAuthorSuffix", { id: item.authorPrincipalId.slice(0, 8) })
                    }}</span>
                    <span v-if="item.consumedAt">
                        {{ t("chat.guidanceConsumedAt", { time: formatTime(item.consumedAt) }) }}
                    </span>
                    <span v-if="item.terminalExpiredAt">
                        {{
                            t("chat.guidanceExpiredAt", {
                                time: formatTime(item.terminalExpiredAt),
                            })
                        }}
                    </span>
                </div>
            </li>
        </ul>
        <p v-else class="text-xs text-muted-foreground" data-testid="guidance-empty">
            {{ t("chat.guidanceEmpty") }}
        </p>

        <div
            v-if="showInput"
            class="flex items-end gap-2 max-sm:flex-col max-sm:items-stretch"
            data-testid="guidance-input-row"
        >
            <textarea
                v-model="input"
                :placeholder="t('chat.guidancePlaceholder')"
                :maxlength="MAX_GUIDANCE_LENGTH"
                class="flex-1 min-h-[2.5rem] max-h-32 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-[2.25rem]"
                data-testid="guidance-input"
                rows="2"
                @keydown.enter.exact.prevent="handleSubmit"
            />
            <button
                type="button"
                :disabled="!canSubmit"
                class="shrink-0 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed max-sm:w-full"
                data-testid="guidance-submit"
                @click="handleSubmit"
            >
                {{ submitting ? t("chat.guidanceSubmitting") : t("chat.guidanceSubmit") }}
            </button>
        </div>
    </div>
</template>
