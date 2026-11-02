<script setup lang="ts">
import { useI18n } from "vue-i18n";
import SessionPolicyControls from "../chat/components/SessionPolicyControls.vue";
import SessionContextTemplate from "../chat/components/SessionContextTemplate.vue";
import ContextSourcesU1 from "../chat/components/ContextSourcesU1.vue";
import { useSessionBranches } from "../chat/composables/useSessionBranches";

/**
 * PLAN-0626 M2: the dock's `context` panel — the session-level settings that used to be
 * a chat-column expansion (BL-121). Living in the dock is what makes "边看会话边改配置"
 * possible; the chat column keeps a read-only summary row as the entry.
 *
 * The testids are the pre-existing ones on purpose: the five e2e specs that drive these
 * controls only need an "open the panel" step, not new selectors (D26-09 testid 稳定纪律).
 *
 * `data-testid="session-settings-expanded"` stays on this body: it *is* the expanded
 * settings surface, just relocated.
 */
const props = defineProps<{ sessionId: string | null }>();

const { t } = useI18n();
const { branchOptions, selectedBranchId, branchSelectionDisabled, selectBranch } =
    useSessionBranches(() => props.sessionId ?? "");
</script>

<template>
    <section
        data-testid="session-context-panel"
        :aria-label="t('sessionSettings.title')"
        class="flex min-h-0 flex-1 flex-col overflow-y-auto text-xs"
    >
        <p
            v-if="!sessionId"
            data-testid="session-context-panel-empty"
            class="p-4 text-muted-foreground"
        >
            {{ t("workspace.noSession") }}
        </p>

        <div
            v-else
            :id="`session-settings-panel-${sessionId}`"
            data-testid="session-settings-expanded"
            class="divide-y divide-border"
        >
            <div
                class="flex min-w-0 items-center gap-2 px-3 py-2"
                data-testid="session-settings-section-approval"
            >
                <span class="w-16 shrink-0 truncate text-muted-foreground">{{
                    t("chat.approvalModeLabel")
                }}</span>
                <div class="min-w-0 flex-1">
                    <SessionPolicyControls :session-id="sessionId" />
                </div>
            </div>

            <div
                class="flex min-w-0 items-center gap-2 px-3 py-2"
                data-testid="session-settings-section-template"
            >
                <span class="w-16 shrink-0 truncate text-muted-foreground">{{
                    t("chat.contextTemplateLabel")
                }}</span>
                <div class="min-w-0 flex-1">
                    <SessionContextTemplate :session-id="sessionId" />
                </div>
            </div>

            <div class="min-w-0 px-3 py-2" data-testid="session-settings-section-context">
                <ContextSourcesU1 :session-id="sessionId" />
            </div>

            <div
                class="flex min-w-0 items-center gap-2 px-3 py-2"
                data-testid="session-settings-section-branch"
            >
                <span class="w-16 shrink-0 truncate text-muted-foreground">{{
                    t("chat.branchSelectorLabel")
                }}</span>
                <select
                    :id="`session-branch-${sessionId}`"
                    data-testid="session-branch-select"
                    class="w-full min-w-0 truncate rounded-md border bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                    :value="selectedBranchId"
                    :disabled="branchSelectionDisabled"
                    :aria-label="t('chat.branchSelectorLabel')"
                    :title="
                        branchOptions.find((branch) => branch.branchId === selectedBranchId)?.label
                    "
                    @change="selectBranch(($event.target as HTMLSelectElement).value)"
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
