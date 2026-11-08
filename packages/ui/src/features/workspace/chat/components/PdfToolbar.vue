<script setup lang="ts">
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
defineProps<{
    pageNum: number;
    totalPages: number;
    scale: number;
}>();

const emit = defineEmits<{
    prev: [];
    next: [];
    "update:scale": [value: number];
}>();
</script>

<template>
    <div class="flex items-center gap-3 text-sm">
        <button
            class="px-2 py-1 rounded hover:bg-muted disabled:opacity-30"
            :disabled="pageNum <= 1"
            @click="emit('prev')"
        >
            ◀
        </button>
        <span>{{ pageNum }} / {{ totalPages }}</span>
        <button
            class="px-2 py-1 rounded hover:bg-muted disabled:opacity-30"
            :disabled="pageNum >= totalPages"
            @click="emit('next')"
        >
            ▶
        </button>
        <Select
            :model-value="String(scale)"
            @update:model-value="(value) => emit('update:scale', Number(value))"
        >
            <SelectTrigger class="text-xs border rounded px-1 py-0.5">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value="0.5">50%</SelectItem>
                <SelectItem value="0.75">75%</SelectItem>
                <SelectItem value="1">100%</SelectItem>
                <SelectItem value="1.5">150%</SelectItem>
                <SelectItem value="2">200%</SelectItem>
            </SelectContent>
        </Select>
    </div>
</template>
