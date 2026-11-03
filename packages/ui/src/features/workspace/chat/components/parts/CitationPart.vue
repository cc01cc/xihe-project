<script setup lang="ts">
defineProps<{
    index: number;
}>();
</script>

<template>
    <sup class="ml-0.5 text-xs text-link cursor-pointer hover:underline"> [{{ index }}] </sup>
</template>
