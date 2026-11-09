<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import Dialog from "../../../../components/ui/dialog/Dialog.vue";
import DialogContent from "../../../../components/ui/dialog/DialogContent.vue";
import DialogDescription from "../../../../components/ui/dialog/DialogDescription.vue";
import DialogFooter from "../../../../components/ui/dialog/DialogFooter.vue";
import DialogHeader from "../../../../components/ui/dialog/DialogHeader.vue";
import DialogTitle from "../../../../components/ui/dialog/DialogTitle.vue";
import { Button } from "../../../../components/ui/button";
import { Textarea } from "../../../../components/ui/textarea";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";

/** One delegable (bound, enabled) workspace agent principal. */
export interface DelegationPrincipal {
    principalId: string;
    name: string;
}

/** Read-only budget view (`GET /api/v1/sessions/{id}/delegation-usage`). */
export interface DelegationBudgetView {
    usedSessions: number;
    maxCount: number;
    currentDepth: number;
    maxDepth: number;
    /** `maxCount = 0` — the principal's delegationPolicy disables delegation (ruling A1). */
    disabled: boolean;
}

const props = defineProps<{
        open: boolean;
        sessionId: string;
        principals: DelegationPrincipal[];
        budget: DelegationBudgetView | null;
        submitting: boolean;
        /** A pending approval for this attempt is tracked (CP answered 202). */
        approvalPending?: boolean;
    }>(),
    emit = defineEmits<{
        "update:open": [value: boolean];
        close: [];
        submit: [payload: { principalId: string; task: string }];
        principalChange: [principalId: string];
    }>();

const { t } = useI18n();

const selectedPrincipalId = ref("");
const task = ref("");

const visiblePrincipals = computed(() =>
    props.principals.filter((principal) => principal.principalId && principal.name),
);
const budgetDisabled = computed(() => props.budget?.disabled === true);
const canSubmit = computed(
    () =>
        Boolean(selectedPrincipalId.value) &&
        Boolean(task.value.trim()) &&
        task.value.length <= 4000 &&
        !budgetDisabled.value &&
        !props.submitting &&
        !props.approvalPending,
);

watch(
    () => props.open,
    (open) => {
        if (open) {
            selectedPrincipalId.value = visiblePrincipals.value[0]?.principalId ?? "";
            task.value = "";
            if (selectedPrincipalId.value) {
                emit("principalChange", selectedPrincipalId.value);
            }
        }
    },
);

function onPrincipalChange() {
    if (selectedPrincipalId.value) {
        emit("principalChange", selectedPrincipalId.value);
    }
}

function submit() {
    if (!canSubmit.value) return;
    emit("submit", { principalId: selectedPrincipalId.value, task: task.value.trim() });
}
</script>

<template>
    <Dialog :open="open" @update:open="(value: boolean) => emit('update:open', value)">
        <DialogContent class="sm:max-w-md" data-testid="delegation-dialog">
            <DialogHeader>
                <DialogTitle>{{ t("chat.delegation.title") }}</DialogTitle>
                <DialogDescription>{{ t("chat.delegation.description") }}</DialogDescription>
            </DialogHeader>

            <div class="grid gap-4 py-2">
                <div class="grid gap-1.5">
                    <label for="delegation-principal" class="text-sm font-medium">
                        {{ t("chat.delegation.principalLabel") }}
                    </label>
                    <Select
                        :model-value="selectedPrincipalId"
                        @update:model-value="
                            (value) => {
                                selectedPrincipalId = String(value ?? '');
                                onPrincipalChange();
                            }
                        "
                    >
                        <SelectTrigger
                            id="delegation-principal"
                            data-testid="delegation-principal-select"
                            class="h-8 rounded-lg border border-input bg-action px-2.5 text-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                        >
                            <SelectValue :placeholder="t('chat.delegation.principalPlaceholder')" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem
                                v-for="principal in visiblePrincipals"
                                :key="principal.principalId"
                                :value="principal.principalId"
                            >
                                {{ principal.name }}
                            </SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <div class="grid gap-1.5">
                    <label for="delegation-task" class="text-sm font-medium">
                        {{ t("chat.delegation.taskLabel") }}
                    </label>
                    <Textarea
                        id="delegation-task"
                        v-model="task"
                        data-testid="delegation-task-input"
                        :placeholder="t('chat.delegation.taskPlaceholder')"
                        :maxlength="4000"
                        rows="4"
                    />
                </div>

                <div class="grid gap-1.5">
                    <span class="text-sm font-medium">{{ t("chat.delegation.budgetLabel") }}</span>
                    <p class="text-xs text-muted-foreground" data-testid="delegation-budget">
                        <template v-if="budget">
                            {{ t("chat.delegation.budgetUsage") }} {{ budget.usedSessions }}/{{
                                budget.maxCount
                            }}
                            ｜ {{ t("chat.delegation.budgetDepth") }} {{ budget.currentDepth }}/{{
                                budget.maxDepth
                            }}
                        </template>
                        <template v-else>—</template>
                    </p>
                    <p class="text-xs text-muted-foreground">
                        {{
                            budgetDisabled
                                ? t("chat.delegation.budgetDisabled")
                                : t("chat.delegation.budgetHint")
                        }}
                    </p>
                    <p
                        v-if="approvalPending"
                        class="text-xs text-brand"
                        data-testid="delegation-approval-pending"
                    >
                        {{ t("chat.delegation.approvalPendingHint") }}
                    </p>
                </div>
            </div>

            <DialogFooter>
                <Button
                    variant="outline"
                    data-testid="delegation-cancel"
                    @click="emit('update:open', false)"
                >
                    {{ t("chat.delegation.cancel") }}
                </Button>
                <Button
                    data-testid="delegation-submit"
                    :disabled="!canSubmit"
                    :title="budgetDisabled ? t('chat.delegation.budgetDisabled') : undefined"
                    @click="submit"
                >
                    {{ t("chat.delegation.submit") }}
                </Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>
