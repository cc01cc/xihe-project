<script setup lang="ts">
import { GripVertical } from "@lucide/vue";

/**
 * Column separator handle — a real component, not a background image.
 *
 * Mirrors the contract the shipping `useWorkspaceLayout` separators already declare: `role="separator"`
 * + `aria-valuenow/min/max`. The three-dot ⋮ and the highlight line only appear in the `hover` /
 * `active` state, which is what the sheet needs to show.
 */
defineProps<{ value: number; min: number; max: number; state?: "idle" | "hover" | "active" }>();
</script>

<template>
    <div
        role="separator"
        aria-orientation="vertical"
        :aria-valuenow="value"
        :aria-valuemin="min"
        :aria-valuemax="max"
        tabindex="0"
        class="group/sash relative z-10 -mx-px w-2 shrink-0 cursor-col-resize select-none"
    >
        <div
            class="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors"
            :class="state === 'idle' ? '' : 'bg-foreground/40 '"
        />
        <div
            class="absolute left-1/2 top-1/2 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background shadow-sm transition-opacity"
            :class="state === 'idle' ? 'opacity-0' : 'opacity-100'"
        >
            <GripVertical class="size-3.5 text-muted-foreground" aria-hidden="true" />
        </div>
        <span
            v-if="state === 'active'"
            class="absolute left-1/2 top-1/2 mt-6 -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 font-mono text-[10px] text-background"
            >{{ value }}px</span
        >
    </div>
</template>
