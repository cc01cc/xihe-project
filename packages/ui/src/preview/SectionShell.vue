<script setup lang="ts">
/**
 * One anchored preview block. Every block is independently screenshot-able: the
 * `scroll-mt-24` offset keeps the anchor below the sticky index, and nothing in a block
 * relies on another block's state.
 */
defineProps<{
    id: string;
    index: string;
    title: string;
    description: string;
}>();
</script>

<template>
    <section :id="id" class="scroll-mt-24 border-t border-border/70 pt-10">
        <header class="mb-3 flex items-center gap-3">
            <span
                class="rounded-md border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                >{{ index }}</span
            >
            <h2 class="text-xl font-semibold tracking-tight text-foreground">{{ title }}</h2>
            <a
                :href="'#' + id"
                class="font-mono text-xs text-muted-foreground underline-offset-4 hover:underline"
                >#{{ id }}</a
            >
        </header>
        <p class="mb-6 max-w-4xl text-sm leading-relaxed text-muted-foreground">
            {{ description }}
        </p>
        <slot />
    </section>
</template>
