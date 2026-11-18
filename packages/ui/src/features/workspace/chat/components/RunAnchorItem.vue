<script setup lang="ts">
/**
 * task-1 / D-1846：**派生态 anchor 消息**（子会话状态卡）。
 *
 * 它是对话流里的一行，锚在该子 run 的 `startedAt`（契约 A2：位置不可变，状态就地重绘）。
 * 三条硬规矩：
 *  1. 状态文案/tier 一律走 `runStateView.ts`（N10 单语义单解析器）—— **本组件不写任何
 *     `status === "…"` 的状态判定**，只按 tier 上色（`failed/cancelled` 染红，沿用 run 头口径）；
 *  2. 主体显示名优先，名称不可得时退化为 run 短码；**UUID 永不上屏**（DEV-032）；
 *  3. 整张卡是一个 `<button>`（键盘可达、有 aria-label），点击 = 进入子会话（契约 A5）。
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowUpRight, CircleAlert, CircleSlash, LoaderCircle, ShieldAlert } from "@lucide/vue";
import type { DerivedRunAnchor } from "../derivedAnchors";
import {
    runStateIsFailure,
    runStateLabelKey,
    runStateTier,
    type RunStateTier,
} from "../runStateView";
import { formatRunDuration, runShortCode } from "../runView";

const props = defineProps<{ anchor: DerivedRunAnchor }>();
const emit = defineEmits<{ open: [sessionId: string] }>();
const { t } = useI18n();

const shortCode = computed(() => runShortCode(props.anchor.runId ?? props.anchor.sessionId));
/** 展示名优先级：主体名 → 任务名 → 短码；都没有才是「子会话」（不猜、不拼 UUID）。 */
const label = computed(() => {
    const anchor = props.anchor;
    return (
        anchor.agentPrincipalName ??
        anchor.subject ??
        (shortCode.value ? `run-${shortCode.value}` : t("chat.derivedStateUnnamedChild"))
    );
});
/** 主标签已占用主体名时，任务名降为次标签（避免同一行重复同一段文字）。 */
const secondary = computed(() => {
    const anchor = props.anchor;
    if (!anchor.subject) return "";
    return anchor.agentPrincipalName && anchor.agentPrincipalName !== anchor.subject
        ? anchor.subject
        : "";
});
const statusLabelKey = computed(() => runStateLabelKey(props.anchor.status));
const statusLabel = computed(() => (statusLabelKey.value ? t(statusLabelKey.value) : ""));
const tier = computed<RunStateTier | null>(() => runStateTier(props.anchor.status));
/** 失败/取消要显式（契约 A4；与 `RunGroupHeader` 的 `data-failed` 同一口径）。 */
const failed = computed(() => runStateIsFailure(props.anchor.status));
const duration = computed(() => formatRunDuration(props.anchor.startedAt, props.anchor.terminalAt));
const openLabel = computed(() => t("chat.anchor.open", { name: label.value }));

function open(): void {
    emit("open", props.anchor.sessionId);
}
</script>

<template>
    <div
        data-testid="run-anchor"
        :data-anchor-run-id="anchor.runId ?? undefined"
        :data-anchor-session-id="anchor.sessionId"
        :data-anchor-status="anchor.status ?? undefined"
        :data-anchor-tier="tier ?? undefined"
        :data-anchor-started-at="anchor.startedAt"
    >
        <button
            type="button"
            class="mx-4 my-1 flex w-[calc(100%-2rem)] min-w-0 items-center gap-2 rounded-md border border-border/70 bg-muted/20 px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :aria-label="openLabel"
            :title="openLabel"
            data-testid="run-anchor-open"
            @click="open"
        >
            <LoaderCircle
                v-if="tier === 'active'"
                class="size-3.5 shrink-0 animate-spin"
                aria-hidden="true"
            />
            <CircleAlert
                v-else-if="tier === 'needs-human'"
                class="size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
            />
            <CircleSlash
                v-else-if="tier === 'stopping'"
                class="size-3.5 shrink-0"
                aria-hidden="true"
            />
            <ShieldAlert
                v-else-if="failed"
                class="size-3.5 shrink-0 text-destructive"
                aria-hidden="true"
            />
            <span
                v-else
                class="size-1.5 shrink-0 rounded-full bg-muted-foreground/60"
                aria-hidden="true"
            />
            <span class="min-w-0 truncate text-foreground" data-testid="run-anchor-label">{{
                label
            }}</span>
            <span v-if="secondary" class="min-w-0 truncate" data-testid="run-anchor-subject">{{
                secondary
            }}</span>
            <span class="ml-auto flex shrink-0 items-center gap-2">
                <span v-if="duration" class="tabular-nums" data-testid="run-anchor-duration">{{
                    duration
                }}</span>
                <span
                    v-if="statusLabel"
                    class="shrink-0"
                    :class="failed ? 'text-destructive' : ''"
                    data-testid="run-anchor-status"
                    >{{ statusLabel }}</span
                >
                <ArrowUpRight class="size-3 shrink-0" aria-hidden="true" />
            </span>
        </button>
    </div>
</template>
