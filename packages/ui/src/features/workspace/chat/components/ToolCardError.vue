<script setup lang="ts">
/**
 * PLAN-0688 T1.3: shared error block for the dedicated cards. Only the test id
 * differs; the visual treatment is identical by spec.
 */
defineProps<{ error: string; testid: string }>();
</script>

<template>
    <div class="font-mono" :data-testid="testid">
        <div class="mb-1 font-medium text-destructive">Error</div>
        <pre class="rounded bg-destructive/10 p-2 whitespace-pre-wrap break-all text-destructive">{{
            error
        }}</pre>
    </div>
</template>
