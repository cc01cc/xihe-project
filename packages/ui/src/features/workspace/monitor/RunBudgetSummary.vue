<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Info } from "@lucide/vue";
import { api } from "../../../composables/api";
import { logger } from "../../../lib/logger";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * task-112（旧 task-101 / B-2 的 UI 交付面）：回合的**用量与预算**读数。
 *
 * <p>两个数必须同屏且不同口径（D-1869 ①，CP `ChatRunReadService.putBudgetFace` 原样投影）：</p>
 * <ul>
 *   <li>`tokenCount` —— provider 报的**真实累计**，语义与控制面无关；</li>
 *   <li>`budgetConsumed` —— 按 `budgetAccounting` 口径**记账**的量。落库列可空（V174），
 *       `null` = 「未记录」（历史回合），`0` = **真实的 0**。两者在屏上必须一眼可分辨，
 *       所以 null 走虚线 outline 徽标写「未记录」，0 走正常等宽数字 + 「真实 0」徽标。</li>
 * </ul>
 *
 * <p>限制面同理不能说半句：`runMaxTokens` 与 `runMaxTokensCeiling` 是**读时生效值**
 * （回合行不存配置快照），`0` 是真实值 = 该维度停用/不限制（不是「未知」）。真正生效的上限是
 * `min(runMaxTokens, ceiling>0 ? ceiling : ∞)`，本块把「谁在钳制」直接写出来，而不是让读者自己算。</p>
 *
 * <p>只读、尽力而为：取不到就给一行重试提示，绝不用 0 填补（那会把「未记录」变成假的「没花钱」）。</p>
 */
type RunStatusFetcher = typeof api.getChatRunStatus;

const props = withDefaults(
    defineProps<{
        runId: string | null;
        /**
         * Fetch seam: production always uses `api.getChatRunStatus`; the dev-only UI preview injects a
         * mock fetcher so the block renders with fixture data and issues no `/api/v1/**` request.
         */
        fetcher?: RunStatusFetcher;
    }>(),
    { fetcher: undefined },
);
const { t } = useI18n();

const data = ref<Awaited<ReturnType<RunStatusFetcher>> | null>(null);
const loading = ref(false);
const loadFailed = ref(false);
let generation = 0;

function nonNegative(value: number | null | undefined): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const tokenCount = computed(() => nonNegative(data.value?.tokenCount));
const budgetConsumed = computed(() => nonNegative(data.value?.budgetConsumed));
/** `null` inside the wire is the only "未记录" signal — never derived from tokenCount. */
const budgetRecorded = computed(() => budgetConsumed.value !== null);
const accountingMode = computed(() => data.value?.budgetAccounting ?? null);
const runMaxTokens = computed(() => nonNegative(data.value?.runMaxTokens));
const ceiling = computed(() => nonNegative(data.value?.runMaxTokensCeiling));

/** `0` (and null) means "this dimension does not clamp" — the spec's disabled dimension. */
function limitOf(value: number | null): number | null {
    return value !== null && value > 0 ? value : null;
}

interface EffectiveLimit {
    value: number | null;
    /** Which knob produced `value`; `null` when nothing clamps. */
    clampedBy: "runMaxTokens" | "ceiling" | null;
}

const effective = computed<EffectiveLimit>(() => {
    const run = limitOf(runMaxTokens.value),
        top = limitOf(ceiling.value);
    if (run === null && top === null) return { value: null, clampedBy: null };
    if (run === null) return { value: top, clampedBy: "ceiling" };
    if (top === null) return { value: run, clampedBy: "runMaxTokens" };
    return run <= top
        ? { value: run, clampedBy: "runMaxTokens" }
        : { value: top, clampedBy: "ceiling" };
});

/** Only draw the bar when both numbers exist; a missing budget must not read as "spent 0%". */
const usagePercent = computed<number | null>(() => {
    const limit = effective.value.value,
        spent = budgetConsumed.value;
    if (limit === null || spent === null) return null;
    return Math.min(100, Math.round((spent / limit) * 100));
});

function limitText(value: number | null): string {
    return value === null ? t("monitor.budget.unlimited") : String(value);
}

async function fetchStatus(runId: string | null): Promise<void> {
    const currentGeneration = ++generation;
    loadFailed.value = false;
    if (runId === null) {
        data.value = null;
        loading.value = false;
        return;
    }
    loading.value = true;
    try {
        const response = await (props.fetcher ?? api.getChatRunStatus)(runId);
        if (currentGeneration !== generation) return;
        data.value = response;
    } catch (fetchError) {
        if (currentGeneration !== generation) return;
        // Keep the previous reading visible; the row offers a retry instead.
        logger.warn("run budget fetch failed", fetchError);
        loadFailed.value = true;
    } finally {
        if (currentGeneration === generation) loading.value = false;
    }
}

watch(
    () => props.runId,
    (runId) => void fetchStatus(runId),
    { immediate: true },
);

onBeforeUnmount(() => {
    generation += 1;
});
</script>

<template>
    <section class="rounded border" data-testid="monitor-run-budget">
        <header
            class="flex items-center justify-between border-b px-2 py-1 text-xs text-muted-foreground"
        >
            <span class="font-medium">{{ t("monitor.budget.title") }}</span>
            <span class="flex items-center gap-1" data-testid="monitor-run-budget-accounting">
                <span>{{ t("monitor.budget.accountingLabel") }}</span>
                <Badge v-if="accountingMode" variant="outline" class="font-mono text-xs">
                    {{ t(`monitor.budget.accounting.${accountingMode}`) }}
                </Badge>
                <span v-else class="text-xs">{{ t("monitor.budget.unknown") }}</span>
                <TooltipProvider v-if="accountingMode">
                    <Tooltip>
                        <TooltipTrigger as-child>
                            <span
                                class="inline-flex"
                                data-testid="monitor-run-budget-accounting-help"
                            >
                                <Info class="size-3" aria-hidden="true" />
                                <span class="sr-only">{{
                                    t("monitor.budget.accountingHelp")
                                }}</span>
                            </span>
                        </TooltipTrigger>
                        <TooltipContent class="max-w-64 text-xs">
                            {{ t(`monitor.budget.accountingHint.${accountingMode}`) }}
                        </TooltipContent>
                    </Tooltip>
                </TooltipProvider>
            </span>
        </header>

        <div class="space-y-2 px-2 py-1.5 text-xs">
            <p
                v-if="loading && data === null"
                class="text-center text-muted-foreground"
                data-testid="monitor-run-budget-loading"
            >
                {{ t("monitor.budget.loading") }}
            </p>
            <p
                v-else-if="loadFailed && data === null"
                class="flex items-center justify-center gap-2 text-muted-foreground"
                data-testid="monitor-run-budget-failed"
            >
                {{ t("monitor.budget.failed") }}
                <button
                    type="button"
                    class="underline underline-offset-2"
                    data-testid="monitor-run-budget-retry"
                    @click="fetchStatus(runId)"
                >
                    {{ t("monitor.budget.retry") }}
                </button>
            </p>
            <p
                v-else-if="runId === null"
                class="text-center text-muted-foreground"
                data-testid="monitor-run-budget-empty"
            >
                {{ t("monitor.budget.empty") }}
            </p>

            <template v-else>
                <dl class="grid grid-cols-2 gap-1.5">
                    <div
                        class="min-w-0 rounded bg-muted px-1.5 py-1"
                        data-testid="monitor-budget-token"
                    >
                        <dt class="truncate text-muted-foreground">
                            {{ t("monitor.budget.tokenCount") }}
                        </dt>
                        <dd
                            class="mt-0.5 font-mono tabular-nums"
                            data-testid="monitor-budget-token-value"
                        >
                            <template v-if="tokenCount !== null">{{ tokenCount }}</template>
                            <span v-else class="text-muted-foreground">
                                {{ t("monitor.budget.unknown") }}
                            </span>
                        </dd>
                    </div>
                    <div
                        class="min-w-0 rounded bg-muted px-1.5 py-1"
                        data-testid="monitor-budget-consumed"
                        :data-budget-recorded="budgetRecorded ? 'true' : 'false'"
                    >
                        <dt class="flex items-center gap-1 truncate text-muted-foreground">
                            <span>{{ t("monitor.budget.consumed") }}</span>
                            <!-- null 与 0 必须在屏上可分辨：null 走虚线徽标，0 走实心「真实 0」徽标。 -->
                            <Badge
                                v-if="budgetRecorded && budgetConsumed === 0"
                                variant="secondary"
                                class="text-xs"
                                data-testid="monitor-budget-consumed-zero"
                            >
                                {{ t("monitor.budget.zeroTag") }}
                            </Badge>
                        </dt>
                        <dd
                            class="mt-0.5 font-mono tabular-nums"
                            data-testid="monitor-budget-consumed-value"
                        >
                            <Badge
                                v-if="!budgetRecorded"
                                variant="outline"
                                class="border-dashed text-xs"
                                data-testid="monitor-budget-consumed-unrecorded"
                            >
                                {{ t("monitor.budget.unrecorded") }}
                            </Badge>
                            <template v-else>{{ budgetConsumed }}</template>
                        </dd>
                    </div>
                </dl>

                <div class="space-y-1" data-testid="monitor-budget-limits">
                    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <span class="text-muted-foreground">
                            {{ t("monitor.budget.runMaxTokens") }}
                            <!-- `0` 是真实值（该维度停用）⇒ 显示「不限制」，不是「0」，也不是「未知」。 -->
                            <b class="font-mono">{{ limitText(limitOf(runMaxTokens)) }}</b>
                        </span>
                        <span class="text-muted-foreground">
                            {{ t("monitor.budget.ceiling") }}
                            <b class="font-mono">{{ limitText(limitOf(ceiling)) }}</b>
                        </span>
                    </div>
                    <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span class="text-muted-foreground">
                            {{ t("monitor.budget.effective") }}
                            <b class="font-mono" data-testid="monitor-budget-effective-value">{{
                                limitText(effective.value)
                            }}</b>
                        </span>
                        <Badge
                            v-if="effective.clampedBy"
                            variant="outline"
                            class="text-xs"
                            data-testid="monitor-budget-clamped-by"
                            :data-clamped-by="effective.clampedBy"
                        >
                            {{
                                t(`monitor.budget.clampedBy.${effective.clampedBy}`, {
                                    value: effective.value,
                                })
                            }}
                        </Badge>
                        <span
                            v-else
                            class="text-muted-foreground"
                            data-testid="monitor-budget-not-clamped"
                        >
                            {{ t("monitor.budget.notClamped") }}
                        </span>
                    </div>
                    <div
                        v-if="usagePercent !== null"
                        class="flex items-center gap-2"
                        data-testid="monitor-budget-usage"
                    >
                        <Progress :model-value="usagePercent" class="h-1" />
                        <span class="shrink-0 font-mono tabular-nums text-muted-foreground">
                            {{ t("monitor.budget.usageOf", { percent: usagePercent }) }}
                        </span>
                    </div>
                </div>
            </template>
        </div>
    </section>
</template>
