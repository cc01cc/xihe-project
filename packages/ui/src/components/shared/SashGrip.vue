<script setup lang="ts">
import { GripVertical } from "@lucide/vue";

/**
 * PLAN-0762 M4 (T4.1) — the ⋮ grip shown on hover/drag by a column separator.
 *
 * The three separators (`sidebar-resizer` / `tree-resizer` / `dock-resizer`) share this
 * one definition so the affordance cannot drift per pane; the visual mirrors
 * `src/preview/mock/SashHandle.vue` (pill + lucide `GripVertical`, no hand-drawn SVG).
 *
 * The parent must be the separator element itself and carry `group/sash` plus a
 * `data-state` attribute (`inactive | hover | drag`): the two reka handles get it from
 * `SplitterResizeHandle`, the hand-rolled dock handle mirrors it.
 *
 * `pointer-events-none` is load-bearing, not cosmetic: the pill is centred on a 4px
 * hairline and is wider than it, so a hit-testable pill would extend the drag hot zone
 * (or swallow the mousedown of whatever it covers). The hot zone must stay exactly as
 * wide as the separator declares.
 */
defineProps<{ testid: string }>();
</script>

<template>
    <span
        :data-testid="testid"
        aria-hidden="true"
        class="pointer-events-none absolute left-1/2 top-1/2 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background shadow-sm opacity-0 transition-opacity group-hover/sash:opacity-100 group-focus-visible/sash:opacity-100 group-data-[state=hover]/sash:opacity-100 group-data-[state=drag]/sash:opacity-100"
    >
        <GripVertical class="size-3.5 text-muted-foreground" aria-hidden="true" />
    </span>
</template>
