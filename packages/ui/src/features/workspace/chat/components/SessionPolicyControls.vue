<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { usePolicyStore } from "../../../../stores/policy";
import { logger } from "../../../../lib/logger";
import type { SessionPolicyMode } from "../../../../types";

const props = defineProps<{
    sessionId: string;
}>();

const { t } = useI18n();
const policyStore = usePolicyStore();

const modeLabelKeys: Record<SessionPolicyMode, string> = {
    manual: "chat.approvalModeManual",
    auto: "chat.approvalModeAuto",
};
const policyModes = Object.keys(modeLabelKeys) as SessionPolicyMode[];

function isPolicyMode(value: string): value is SessionPolicyMode {
    return policyModes.includes(value as SessionPolicyMode);
}

const state = computed(() => policyStore.getState(props.sessionId)),
    mode = computed(() => state.value?.mode ?? null);
const modeLabel = computed(() =>
    mode.value ? t(modeLabelKeys[mode.value]) : t("chat.approvalModeUnavailable"),
);
const busy = computed(() => Boolean(state.value?.loading || state.value?.changing));
const lastRequestedMode = ref<SessionPolicyMode | null>(null);

// PLAN-0582 S4 / P0-4: never surface the raw `CODE: english detail` string from
// the API layer; the store keeps the diagnostic for logs and the UI shows an
// actionable, localized inline hint instead.
const errorMessage = computed(() => {
    if (!state.value?.error) return null;
    return state.value.loaded
        ? t("chat.approvalModeChangeFailed")
        : t("chat.approvalModeLoadFailed");
});

watch(
    () => props.sessionId,
    (sessionId) => {
        lastRequestedMode.value = null;
        if (sessionId) void policyStore.load(sessionId);
    },
    { immediate: true },
);

async function changeMode(nextMode: SessionPolicyMode) {
    const sessionId = props.sessionId;
    if (!sessionId || busy.value) return;
    lastRequestedMode.value = nextMode;
    try {
        const result = await policyStore.change(sessionId, nextMode);
        if (props.sessionId === sessionId) {
            toast.success(`${t("chat.approvalModeChanged")}: ${t(modeLabelKeys[result.mode])}`);
        }
    } catch (cause) {
        logger.warn("Session policy mode change failed", cause);
    }
}

function handleModeChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    if (isPolicyMode(value)) void changeMode(value);
}

function retry() {
    const sessionId = props.sessionId;
    if (!sessionId) return;
    if (!state.value?.loaded) {
        void policyStore.load(sessionId);
        return;
    }
    if (lastRequestedMode.value) void changeMode(lastRequestedMode.value);
}
</script>

<template>
    <div class="min-w-0">
        <select
            :id="`session-policy-mode-${sessionId}`"
            data-testid="session-policy-mode"
            class="w-full min-w-0 truncate rounded-md border bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
            :value="mode ?? ''"
            :disabled="!mode || busy"
            :aria-label="t('chat.approvalModeLabel')"
            :title="modeLabel"
            @change="handleModeChange"
        >
            <option value="" disabled>{{ t("chat.approvalModeUnavailable") }}</option>
            <option v-for="policyMode in policyModes" :key="policyMode" :value="policyMode">
                {{ t(modeLabelKeys[policyMode]) }}
            </option>
        </select>
        <p
            v-if="errorMessage"
            data-testid="session-policy-mode-error"
            class="mt-1 flex items-center gap-2 text-xs text-destructive"
            role="alert"
        >
            <span class="line-clamp-2 min-w-0 flex-1">{{ errorMessage }}</span>
            <button
                type="button"
                data-testid="session-policy-mode-retry"
                class="shrink-0 rounded border border-destructive/40 px-1.5 py-0.5 text-[11px] font-medium transition hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                @click="retry"
            >
                {{ t("common.retry") }}
            </button>
        </p>
    </div>
</template>
