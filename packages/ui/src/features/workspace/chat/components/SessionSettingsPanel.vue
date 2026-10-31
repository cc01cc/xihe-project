<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, CircleAlert } from "@lucide/vue";
import { toast } from "vue-sonner";
import { logger } from "../../../../lib/logger";
import { usePolicyStore } from "../../../../stores/policy";
import { useSessionStore } from "../../../../stores/session";
import type { SessionPolicyMode } from "../../../../types";
import ContextSourcesU1 from "./ContextSourcesU1.vue";
import SessionContextTemplate from "./SessionContextTemplate.vue";
import SessionPolicyControls from "./SessionPolicyControls.vue";

export interface SettingsBranchOption {
    branchId: string;
    label: string;
}

interface TemplateSummary {
    label: string | null;
    loading: boolean;
    failed: boolean;
}

const props = defineProps<{
    sessionId: string;
    branchOptions: SettingsBranchOption[];
    selectedBranchId: string;
    mainBranchId: string | null;
    branchDisabled: boolean;
}>();

const emit = defineEmits<{
    "select-branch": [branchId: string];
}>();

const { t } = useI18n();
const policyStore = usePolicyStore();
const sessionStore = useSessionStore();

const open = ref(false),
    closingAuto = ref(false);
const templateSummary = ref<TemplateSummary>({ label: null, loading: true, failed: false });

const panelId = computed(() => `session-settings-panel-${props.sessionId}`);
const policyState = computed(() => policyStore.getState(props.sessionId)),
    mode = computed<SessionPolicyMode | null>(() => policyState.value?.mode ?? null);
const modeLabel = computed(() => {
    if (!mode.value) return t("chat.approvalModeUnavailable");
    return mode.value === "manual" ? t("chat.approvalModeManual") : t("chat.approvalModeAuto");
});
const autoApproval = computed(() => mode.value === "auto");

const session = computed(
    () => sessionStore.sessions.find((item) => item.id === props.sessionId) ?? null,
);
const templateValue = computed(() => {
    if (templateSummary.value.label) return templateSummary.value.label;
    const bound = session.value;
    if (bound?.contextTemplateId && bound.contextTemplateVersion != null) {
        return `${bound.contextTemplateId} v${bound.contextTemplateVersion}`;
    }
    return null;
});
// A risk badge must never be derived from a still-loading (or failed) projection:
// that would flash "not bound" on every session switch.
const templateUnbound = computed(
    () =>
        !templateSummary.value.loading &&
        !templateSummary.value.failed &&
        templateValue.value === null,
);
const branchLabel = computed(
    () =>
        props.branchOptions.find((branch) => branch.branchId === props.selectedBranchId)?.label ??
        t("chat.branchMainPath"),
);
const branchDetached = computed(
    () =>
        Boolean(props.selectedBranchId) &&
        Boolean(props.mainBranchId) &&
        props.selectedBranchId !== props.mainBranchId,
);

const summaryText = computed(() =>
    [
        `${t("chat.approvalModeLabel")} ${modeLabel.value}`,
        `${t("chat.contextTemplateLabel")} ${
            templateValue.value ?? t("sessionSettings.templateUnbound")
        }`,
        `${t("chat.branchSelectorLabel")} ${branchLabel.value}`,
    ].join(" · "),
);

watch(
    () => props.sessionId,
    () => {
        templateSummary.value = { label: null, loading: true, failed: false };
    },
);

function handleTemplateSummary(summary: TemplateSummary) {
    templateSummary.value = summary;
}

async function closeAutoApproval() {
    const sessionId = props.sessionId;
    if (!sessionId || closingAuto.value) return;
    closingAuto.value = true;
    try {
        await policyStore.change(sessionId, "manual");
        if (props.sessionId === sessionId) {
            toast.success(`${t("chat.approvalModeChanged")}: ${t("chat.approvalModeManual")}`);
        }
    } catch (cause) {
        logger.warn("Failed to close auto approval mode", cause);
    } finally {
        closingAuto.value = false;
    }
}
</script>

<template>
    <section
        data-testid="session-settings"
        class="shrink-0 border-b bg-background/80"
        :aria-label="t('sessionSettings.title')"
    >
        <button
            type="button"
            data-testid="session-settings-summary"
            class="flex h-9 w-full min-w-0 items-center gap-2 px-3 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            :aria-expanded="open"
            :aria-controls="panelId"
            :title="summaryText"
            @click="open = !open"
        >
            <ChevronDown
                class="size-3.5 shrink-0 transition-transform"
                :class="open ? 'rotate-180' : ''"
                aria-hidden="true"
            />
            <span class="sr-only">{{
                open ? t("sessionSettings.collapse") : t("sessionSettings.expand")
            }}</span>
            <span class="flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap">
                <span class="shrink-0" data-testid="session-settings-summary-approval">
                    {{ t("chat.approvalModeLabel") }}
                    <span class="font-medium text-foreground">{{ modeLabel }}</span>
                </span>
                <span class="shrink-0 text-muted-foreground/50">·</span>
                <span
                    class="min-w-0 truncate"
                    data-testid="session-context-template-current"
                    :title="templateValue ?? t('sessionSettings.templateUnbound')"
                >
                    {{ t("chat.contextTemplateLabel") }}
                    <span
                        class="font-medium"
                        :class="templateUnbound ? 'text-muted-foreground' : 'text-foreground'"
                    >
                        {{ templateValue ?? "—" }}
                    </span>
                </span>
                <span class="shrink-0 text-muted-foreground/50">·</span>
                <span class="shrink-0" data-testid="session-settings-summary-branch">
                    {{ t("chat.branchSelectorLabel") }}
                    <span class="font-medium text-foreground">{{ branchLabel }}</span>
                </span>
            </span>
            <span
                v-if="templateUnbound"
                data-testid="session-settings-risk-template"
                class="inline-flex max-w-36 shrink-0 items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700"
                :title="t('sessionSettings.templateUnbound')"
            >
                <CircleAlert class="size-3 shrink-0" aria-hidden="true" />
                <span class="truncate">{{ t("sessionSettings.templateUnbound") }}</span>
            </span>
            <span
                v-if="branchDetached"
                data-testid="session-settings-risk-branch"
                class="inline-flex max-w-36 shrink-0 items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700"
                :title="t('sessionSettings.branchDetached')"
            >
                <CircleAlert class="size-3 shrink-0" aria-hidden="true" />
                <span class="truncate">{{ t("sessionSettings.branchDetached") }}</span>
            </span>
        </button>

        <!-- Safety warning: auto approval must stay visible while the panel is collapsed. -->
        <div
            v-if="autoApproval"
            data-testid="session-policy-auto-banner"
            role="alert"
            class="flex items-center justify-between gap-2 border-t border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700"
        >
            <span class="flex min-w-0 items-center gap-1.5">
                <CircleAlert class="size-3.5 shrink-0" aria-hidden="true" />
                <span class="line-clamp-2 min-w-0">{{ t("chat.approvalAutoWarning") }}</span>
            </span>
            <button
                type="button"
                data-testid="session-policy-auto-close"
                class="shrink-0 rounded-md border border-amber-500/40 px-2 py-0.5 text-[11px] font-medium transition hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                :disabled="closingAuto || Boolean(policyState?.changing)"
                @click="closeAutoApproval"
            >
                {{ t("chat.approvalAutoClose") }}
            </button>
        </div>

        <div
            v-show="open"
            :id="panelId"
            :inert="!open"
            data-testid="session-settings-expanded"
            class="divide-y divide-border border-t"
        >
            <div
                class="flex min-w-0 items-center gap-2 px-3 py-1.5"
                data-testid="session-settings-section-approval"
            >
                <span class="w-16 shrink-0 truncate text-xs text-muted-foreground">{{
                    t("chat.approvalModeLabel")
                }}</span>
                <div class="min-w-0 flex-1">
                    <SessionPolicyControls :session-id="sessionId" />
                </div>
            </div>
            <div
                class="flex min-w-0 items-center gap-2 px-3 py-1.5"
                data-testid="session-settings-section-template"
            >
                <span class="w-16 shrink-0 truncate text-xs text-muted-foreground">{{
                    t("chat.contextTemplateLabel")
                }}</span>
                <div class="min-w-0 flex-1">
                    <SessionContextTemplate
                        :session-id="sessionId"
                        @update:summary="handleTemplateSummary"
                    />
                </div>
            </div>
            <div class="min-w-0 px-3 py-1.5" data-testid="session-settings-section-context">
                <ContextSourcesU1 :session-id="sessionId" />
            </div>
            <div
                class="flex min-w-0 items-center gap-2 px-3 py-1.5"
                data-testid="session-settings-section-branch"
            >
                <span class="w-16 shrink-0 truncate text-xs text-muted-foreground">{{
                    t("chat.branchSelectorLabel")
                }}</span>
                <select
                    :id="`session-branch-${sessionId}`"
                    data-testid="session-branch-select"
                    class="w-full min-w-0 truncate rounded-md border bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                    :value="selectedBranchId"
                    :disabled="branchDisabled || branchOptions.length === 0"
                    :aria-label="t('chat.branchSelectorLabel')"
                    :title="branchLabel"
                    @change="emit('select-branch', ($event.target as HTMLSelectElement).value)"
                >
                    <option
                        v-for="branch in branchOptions"
                        :key="branch.branchId"
                        :value="branch.branchId"
                    >
                        {{ branch.label }}
                    </option>
                </select>
            </div>
        </div>
    </section>
</template>
