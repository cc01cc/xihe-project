<script setup lang="ts">
import { computed } from "vue";
import { Lock, Terminal } from "@lucide/vue";
import { usePreviewCopy } from "./copy";

/**
 * Layer badge for one config key. Four shapes, deliberately distinguishable **without** new
 * colour steps (attention budget: DEV-011 §10 — colour is reserved for "would misoperate"):
 *
 * - workspace (inherit-clickable): filled brand dot + solid chip + hover underline; the only
 *   interactive badge — clicking jumps to that layer row.
 * - user: filled foreground dot + dashed chip — "set by me, one layer down".
 * - instance: hollow ring + lock icon, muted — read-only source, not an error.
 * - env: mono env text + terminal icon + dotted chip — deployment-time lock, a *different*
 *   lock from the instance one (PLAN-0556: the two must not share a badge).
 */
const props = defineProps<{
    kind: "workspace" | "user" | "instance" | "env" | "locked-instance";
    /** 可选的覆盖链摘要（如 实例 64k / 用户 96k） */
    detail?: string;
    clickable?: boolean;
}>();

const copy = usePreviewCopy();

const label = computed(() => {
    switch (props.kind) {
        case "workspace":
            return copy.value.domain.layerWorkspace;
        case "user":
            return copy.value.domain.layerUser;
        case "instance":
            return copy.value.domain.layerInstance;
        case "env":
            return copy.value.domain.lockedByEnv;
        default:
            return copy.value.domain.lockedByInstance;
    }
});

const chipClass = computed(() => {
    switch (props.kind) {
        case "workspace":
            return "border-border bg-background text-foreground";
        case "user":
            return "border-dashed border-border bg-background text-foreground";
        case "env":
            return "border-dotted border-border bg-muted/40 font-mono text-[10px] text-muted-foreground";
        default:
            return "border-transparent bg-muted text-muted-foreground";
    }
});
</script>

<template>
    <component
        :is="clickable ? 'button' : 'span'"
        :type="clickable ? 'button' : undefined"
        class="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors"
        :class="[
            chipClass,
            clickable
                ? 'cursor-pointer underline-offset-4 hover:bg-muted hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                : '',
        ]"
        :data-layer="kind"
    >
        <Terminal v-if="kind === 'env'" class="size-3" aria-hidden="true" />
        <Lock v-else-if="kind === 'instance' || kind === 'locked-instance'" class="size-3" />
        <span
            v-else
            class="size-1.5 rounded-full"
            :class="kind === 'workspace' ? 'bg-brand' : 'bg-foreground/60'"
            aria-hidden="true"
        />
        <span>{{ label }}</span>
        <span v-if="detail" class="font-normal text-muted-foreground">{{ detail }}</span>
    </component>
</template>
